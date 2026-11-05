// App 的全局状态。
//
// 对应 Electron 版：`src/renderer/src/stores/library.ts` 等 Pinia store
//
// ===== 为什么没有 IPC 了 =====
//
// Electron 版是「UI 进程 → IPC → 主进程」，所以 store 里要写 `invoke(...)`，
// 还要 `toPlain()` 去掉响应式 Proxy（D44，踩了两次跨边界克隆失败）。
//
// Swift 版**同一个进程**：store 直接持有 `TsumigeyaCore` 的类型，
// 没有序列化边界、没有 Proxy、没有队列。这一层是**净减少**。
//
// ===== 但有一条必须保留：所有写操作走 store，不直连核心 =====
//
// 即使是同一个进程，UI 也不该直接 `JSONStore.save(...)` ——
// 那样「改一处数据要在五个地方刷新内存」的 bug会立刻回来。
// store 是**唯一**的数据入口，UI 只读它、只通过它改。
import Foundation
import SwiftUI
import TsumigeyaCore

@MainActor
final class AppStore: ObservableObject {

    // MARK: - 已发布状态

    @Published private(set) var games: [GameRecord] = []
    @Published private(set) var dataDir: String = ""
    @Published private(set) var isLoading = true
    /// 加载失败的原因（有值 = 界面该显示错误，而不是空白）。
    @Published private(set) var loadError: String?
    /// 数据目录降级警告（有值 = 该提示用户 —— 静默降级是错的）。
    @Published private(set) var dataDirWarning: DataDirResolution.DataDirWarning?

    @Published var searchText: String = ""

    /// 正在运行的游戏（id → pid）。
    ///
    /// ⚠️ **只在内存**（D50）：落盘会产生「显示在跑其实早没了」。
    @Published private(set) var runningGames: [String: Int32] = [:]

    /// 上次启动失败的原因（id → 中文说明）。
    ///
    /// ⚠️ 失败必须**明确显示**（D36 的精神：返回结构化结果，不抛错）。
    ///    静默失败会让用户以为「点了没反应」。
    @Published private(set) var lastLaunchFailure: [String: String] = [:]

    /// 分类数据（P4：从 library-meta.json 读）。
    @Published private(set) var categories: CategoryDefs = [:]
    @Published private(set) var assignments: CategoryAssignments = [:]

    // MARK: - 派生

    /// 一个分组（分类名 + 该组游戏）。
    struct Group: Identifiable {
        let id: String
        let title: String
        let games: [GameRecord]
    }

    /// 按分类分组的游戏列表。
    ///
    /// ⚠️ 三条必须守住的语义：
    ///  ① **多归属**：一个游戏可以出现在**多个**分组里（与标签一致）
    ///  ② **未归类放最后**，且**不能藏起来**（藏了用户以为游戏丢了）
    ///  ③ 搜索/筛选后为空的组**不显示**（否则一堆空标题）
    var groups: [Group] {
        let filtered = filteredGames

        // 分类顺序（按 order，相同 order 按 id —— 保证稳定）
        let ordered = Categories.ordered(categories)

        var result: [Group] = []
        var claimed: Set<String> = []

        for (catId, def) in ordered {
            let inCat = filtered.filter { game in
                (assignments[game.id] ?? []).contains(catId)
            }
            if inCat.isEmpty { continue }
            claimed.formUnion(inCat.map(\.id))
            result.append(Group(id: catId, title: def.name, games: inCat))
        }

        // 未归类的：**没在任何分类里**的游戏
        //
        // ⚠️ 判据是「没有归属记录」而不是「不在任何已显示的分组里」——
        //    否则「被搜索过滤掉的归类游戏」会被误算进未分类。
        let unassigned = filtered.filter { game in
            let ids = assignments[game.id] ?? []
            // 完全没归属，或归属的分类都不存在（悬空引用）
            return ids.isEmpty || ids.allSatisfy { categories[$0] == nil }
        }
        if !unassigned.isEmpty {
            result.append(Group(id: "__unassigned", title: "未分类", games: unassigned))
        }

        // 如果既没分类也没未归类（比如全都归到已过滤掉的分类里）→ 兜底显示全部
        if result.isEmpty && !filtered.isEmpty {
            result.append(Group(id: "__all", title: "全部", games: filtered))
        }
        return result
    }

    /// 库页要显示的游戏（过滤后）。
    ///
    /// ⚠️ 判据**不要**写在 View 里（Electron 版踩过：画错不报错，只能靠单测钉）。
    var filteredGames: [GameRecord] {
        LibraryFilter.apply(
            games: games,
            searchText: searchText,
            onlyUnbound: false,
            hasBinding: { !($0.gameArgs?.isEmpty ?? true) }
        )
    }

    /// 按 id 查一个游戏。
    func game(id: String) -> GameRecord? {
        games.first { $0.id == id }
    }

    // MARK: - 加载

    func load() async {
        isLoading = true
        loadError = nil

        let resolution = DataDir.resolve()
        dataDir = resolution.path
        dataDirWarning = resolution.warning

        // ---- games.json ----
        let url = URL(fileURLWithPath: resolution.path).appendingPathComponent("games.json")
        switch JSONStore.load(GameMap.self, from: url) {
        case .missing:
            // **正常状态**：首次运行还没有 games.json（不是错误）
            games = []
        case .corrupt(let failure):
            // **故障**：文件存在但读不出。必须告诉用户
            loadError = "游戏库文件损坏：\(failure.reason)"
                + (failure.backupPath.map { "\n原件已改名保留：\($0)" } ?? "")
            games = []
        case .loaded(let map):
            games = map.ordered
        }

        // ---- 分类（library-meta.json）----
        let meta = LibraryMetaStore.load(dataDir: resolution.path)
        categories = meta.meta.categories
        assignments = meta.meta.assignments

        isLoading = false
        refreshRunning()
    }

    // MARK: - 启动 / 停止

    /// 启动一个游戏。
    ///
    /// ⚠️ 流程必须与 Electron 版一致（P2 已经验过的那些判据）：
    ///   ① 读 manifest 补缺省值 + 展开 `<dataDir>` 占位符
    ///      **漏这一步 = mkxp-z 崩在 kernel32**（P2 踩过的真 bug）
    ///   ② 修正 nwjs 版本号（不带 v → 带 v）
    ///   ③ 构造启动计划 → spawn
    func launch(game: GameRecord) {
        lastLaunchFailure.removeValue(forKey: game.id)

        // ① 补缺省值 + 展开占位符（**顺序不能反**，见 GameArgs 的注释）
        var args = GameArgs.prepare(
            userArgs: game.gameArgs, dataDir: dataDir, engine: game.gameEngine)

        // ② 修正 nwjs 版本
        if game.gameEngine == "nwjs" || game.gameEngine == "tyrano" {
            if let resolved = NwjsVersion.resolve(
                dataDir: dataDir, current: args["version"]?.stringValue) {
                args["version"] = .string(resolved)
            }
        }

        // ③ 构造计划
        let ctx = LaunchContext(
            folder: DetectPath.gameDirForFiles(game.gamePath),
            gamePath: game.gamePath,
            gameArgs: args,
            gameTitle: game.gameTitle,
            dataDir: dataDir,
            arch: Arch.current().rawValue
        )

        switch LaunchPlanner.plan(engine: game.gameEngine, context: ctx) {
        case .failure(let failure):
            lastLaunchFailure[game.id] = failure.message
        case .success(let plan):
            let outcome = Launcher.launch(plan)
            if outcome.ok, let pid = outcome.pid {
                runningGames[game.id] = pid
            } else {
                lastLaunchFailure[game.id] = outcome.detail
            }
        }
    }

    /// 停止一个游戏。
    func stop(game: GameRecord) {
        guard let pid = runningGames[game.id] else { return }
        let processes = RunningProcesses()
        if processes.terminate(pid: pid) {
            runningGames.removeValue(forKey: game.id)
        } else {
            lastLaunchFailure[game.id] = "停止失败：进程 \(pid) 没退出"
        }
    }

    /// 把内存里的进程表与真实进程对上。
    ///
    /// ⚠️ 为什么需要：启动器可能被强杀、游戏可能自己崩。
    ///    内存表不刷新就会出现「显示在跑，其实早没了」——那正是 D50 要防的事。
    func refreshRunning() {
        let processes = RunningProcesses()
        var alive: [String: Int32] = [:]
        for (id, pid) in runningGames where processes.isAlive(pid: pid) {
            alive[id] = pid
        }
        if alive != runningGames {
            runningGames = alive
        }
    }

    // MARK: - 添加游戏（P5）

    /// 添加游戏向导是否打开。
    @Published var isAddingGame = false
    /// 上次添加失败的原因（向导里显示）。
    @Published private(set) var lastAddGameError: String?
    /// 引擎安装状态（folder → 已装）。懒加载 + 缓存。
    @Published private(set) var installedEngines: Set<String> = []

    /// 打开 / 关闭添加向导。
    func openAddGame() {
        lastAddGameError = nil
        isAddingGame = true
    }

    func closeAddGame() {
        isAddingGame = false
    }

    /// 引擎运行时是否已装。
    ///
    /// ⚠️ 判据是「**二进制能找到**」而不是「目录存在」——
    ///    目录存在但二进制缺失（下载中断）的情况实际发生过。
    func isEngineInstalled(_ folder: String) -> Bool {
        installedEngines.contains(folder)
    }

    /// 重新扫描已装引擎（打开引擎页 / 添加向导时调）。
    func refreshInstalledEngines() {
        var set: Set<String> = []
        for engine in EngineRegistry.launchable {
            var version = ""
            if engine.folder == "nwjs" {
                version = NwjsVersion.resolve(dataDir: dataDir, current: nil) ?? ""
            }
            if BinaryPaths.binary(
                for: engine.folder, dataDir: dataDir,
                version: version, arch: Arch.current().rawValue) != nil {
                set.insert(engine.folder)
            }
        }
        installedEngines = set
    }

    /// 保存一个新游戏。
    ///
    /// - Returns: 是否成功。失败原因写在 `lastAddGameError`。
    ///
    /// ⚠️ **四处旁挂数据**（D18/D31 的取向）：
    ///    新增时不涉及删除，所以只需要写 `games.json`。
    ///    但**保存后要重新加载分类**（新游戏 id 可能影响归属视图）。
    func addGame(title: String, folder: String, engine: String) -> Bool {
        lastAddGameError = nil

        // 读当前 games.json（**不能用内存里的 games** —— 可能已被外部改动）
        let url = URL(fileURLWithPath: dataDir).appendingPathComponent("games.json")
        var map: GameMap
        if case .loaded(let loaded) = JSONStore.load(GameMap.self, from: url) {
            map = loaded
        } else {
            map = GameMap()
        }

        // 组装 draft
        //
        // ⚠️ `gamePath` 存的是**游戏目录下的入口占位**，不是目录本身 ——
        //    这与 Electron 版一致（它存的是 `…/Game.exe` 这种）。
        //    真正的启动路径由 `LaunchPlanner` 按引擎规则拼。
        let entry = (folder as NSString).appendingPathComponent("Game.exe")
        let draft = GameRecord(
            id: "", gameTitle: title, gamePath: entry, gameEngine: engine,
            gameArgs: [:]   // 空 = 用 manifest 的缺省值（补缺省值在启动时做）
        )

        let result = GameLibrary.save(into: map, draft: draft)
        switch result {
        case .failure(let err):
            lastAddGameError = err.message
            return false
        case .success(let saved):
            if let writeError = JSONStore.save(saved.map, to: url) {
                lastAddGameError = "写 games.json 失败：\(writeError)"
                return false
            }
            // 重新加载（拿到排序后的新列表）
            Task { await self.load() }
            return true
        }
    }

    /// 删游戏（**清四处旁挂数据**）。
    ///
    /// ⚠️ 这条是本文件最容易漏的地方（Electron 版踩过）：
    ///    `saveGame` 用 `max+1` 生成 id，**容易落回刚删的号** →
    ///    新游戏继承上一个游戏的游玩历史和分类归属。
    ///    所以删的时候必须清：games.json / library-meta（元数据）/
    ///    play-stats（游玩记录）/ **assignments（分类归属）**。
    ///
    ///    本鱼现在只实现前两项（元数据与分类）—— play-stats 要等 P6。
    ///    **但这里要留一个显式的 TODO 注释**，不能悄悄少做一件事。
    func deleteGame(id: String) {
        let url = URL(fileURLWithPath: dataDir).appendingPathComponent("games.json")
        guard case .loaded(let map) = JSONStore.load(GameMap.self, from: url) else { return }

        let updated = GameLibrary.remove(from: map, id: id)
        _ = JSONStore.save(updated, to: url)

        // ② 分类归属（必须清，否则 id 复用会把旧归属安到新游戏）
        var newAssignments = assignments
        newAssignments.removeValue(forKey: id)
        assignments = newAssignments

        // TODO(P6)：③ play-stats（游玩记录）与 ④ library-meta 里的 DLsite 元数据
        //           现在 P4/P5 还没有这两层的写入口，等实现时**必须**一起加上。
        persistCategories()

        games = updated.ordered
        runningGames.removeValue(forKey: id)
        lastLaunchFailure.removeValue(forKey: id)
    }

    // MARK: - 引擎管理（P5 引擎页）

    /// 引擎状态表（引擎页读它）。
    @Published private(set) var engineEntries: [EngineStatus.Entry] = []

    /// 安装进度（folder → 进度）。没有键 = 没在装。
    @Published private(set) var engineProgress: [String: EngineProgress] = [:]

    /// 一次安装的进度状态。
    ///
    /// ⚠️ 与 core 的 `InstallProgress` 不是同一个类型：
    ///    core 的是「事件流」（step / download 两种 case），
    ///    这里的是「UI 要显示的当前状态」（已经归约成一句话 + 一个数值）。
    ///    直接绑 core 的事件会让 View 里写一堆 switch。
    enum EngineProgress: Sendable {
        /// 某阶段进行中（无法预知时长）→ 不确定进度条
        case step(label: String)
        /// 下载中（**total 可能为 nil** —— 服务器不给 content-length）
        case downloading(name: String, received: Int64, total: Int64?)
    }

    /// 正在跑的安装任务（取消用）。
    private var installTasks: [String: Task<Void, Never>] = [:]

    /// 刷新引擎状态表。
    func refreshEngineEntries() {
        engineEntries = EngineStatus.scan(dataDir: dataDir)
        installedEngines = Set(engineEntries.filter(\.installed).map(\.id))
    }

    /// 安装一个引擎。
    ///
    /// - Parameters:
    ///   - folder: 引擎 folder
    ///   - force: `true` = 已装也重装（覆盖）
    ///
    /// ⚠️ **拒绝覆盖已装的**（非 force），与 CLI 同一个保护：
    ///    用户机器上已有 1.1GB 运行时，误覆盖等于删掉他装好的东西。
    func installEngine(_ folder: String, force: Bool) {
        guard let definition = EngineRegistry.find(folder: folder) else { return }

        // 已经在装 → 忽略重复点击
        if installTasks[folder] != nil { return }

        // 已装且非 force → 拒绝
        let root = BinaryPaths.moduleDir(dataDir, folder)
        if !force && FileManager.default.fileExists(atPath: root) {
            lastAddGameError = "「\(definition.name)」已经装了。要重装请点「重装」。"
            return
        }

        let deps = EngineDependencies.dependencies(for: folder)
        engineProgress[folder] = .step(label: "准备中")

        let task = Task { [weak self] in
            guard let self else { return }
            await self.runInstall(folder: folder, root: root, deps: deps)
        }
        installTasks[folder] = task
    }

    /// 真正的安装执行。
    ///
    /// ⚠️ **整个流程在 `Task` 里跑**（不是阻塞主线程）：
    ///    RTP 有 244MB，阻塞主线程会把 UI 冻住 —— 用户会以为卡死然后强杀。
    private func runInstall(
        folder: String, root: String, deps: [(name: String, spec: DependencySpec)]
    ) async {
        let downloader = Downloader()
        let env = InstallEnvironment(
            download: { url, destination, progress in
                try await downloader.download(url, to: destination) { p in
                    progress?(p.receivedBytes, p.totalBytes)
                }
                let attrs = try? FileManager.default.attributesOfItem(atPath: destination)
                return (attrs?[.size] as? Int64) ?? 0
            },
            extract: { archive, destination in
                try Extract.extractArchive(archive: archive, to: destination)
            }
        )

        do {
            // 先写 manifest（D62：全新安装时本地还没有）
            try FileManager.default.createDirectory(
                atPath: root, withIntermediateDirectories: true)
            let manifestJSON = JSONValue.object(
                EngineDependencies.buildManifest(for: EngineRegistry.find(folder: folder)!))
            if let data = try? JSONStore.defaultEncoder.encode(manifestJSON) {
                let path = (root as NSString).appendingPathComponent("manifest.json")
                try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
            }

            _ = try await EngineInstaller.install(
                root: root,
                dependencies: deps,
                env: env,
                arch: Arch.current().rawValue,
                onProgress: { [weak self] event in
                    // ⚠️ 进度回调在**后台线程** → 必须切回 MainActor 才能改 @Published
                    Task { @MainActor in
                        guard let self else { return }
                        switch event {
                        case .step(let key, let label, _):
                            let human = Self.humanLabel(forKey: key, label: label)
                            self.engineProgress[folder] = .step(label: human)
                        case .download(let name, let received, let total):
                            self.engineProgress[folder] = .downloading(
                                name: name, received: received, total: total)
                        }
                    }
                })

            await MainActor.run {
                self.engineProgress.removeValue(forKey: folder)
                self.installTasks.removeValue(forKey: folder)
                self.refreshEngineEntries()
            }
        } catch {
            await MainActor.run {
                self.engineProgress.removeValue(forKey: folder)
                self.installTasks.removeValue(forKey: folder)
                let message = (error as? InstallError)?.message ?? error.localizedDescription
                self.lastAddGameError = "安装「\(folder)」失败：\(message)"
            }
        }
    }

    /// 把进度事件的 i18n key 翻成人话。
    ///
    /// ⚠️ core 里给的是 key（`progress.download`），因为 core 不该管文案
    ///    （规矩：文案一律进 locales）。这里做最后一步翻译。
    private static func humanLabel(forKey key: String, label: String) -> String {
        switch key {
        case "progress.prepare": return "准备 \(label)"
        case "progress.download": return "正在下载 \(label)"
        case "progress.extracting": return "正在解压 \(label)"
        case "progress.done": return "\(label) 完成"
        default: return label
        }
    }

    /// 取消安装。
    ///
    /// ⚠️ 语义是「丢弃这次任务」而不是「优雅回滚」——
    ///    已下载的部分会成为**半截目录**。好在 `EngineStatus.scan` 的判据是
    ///    「二进制能不能找到」而不是「目录存不存在」，所以半截目录会显示成「未装」，
    ///    用户可以重装覆盖。**不做自动清理**（删了可能删到用户别的文件）。
    func cancelEngineInstall(_ folder: String) {
        installTasks[folder]?.cancel()
        installTasks.removeValue(forKey: folder)
        engineProgress.removeValue(forKey: folder)
    }

    /// 卸载引擎（删掉整个模块目录）。
    func uninstallEngine(_ folder: String) {
        let root = BinaryPaths.moduleDir(dataDir, folder)
        EngineInstaller.uninstall(root: root)
        refreshEngineEntries()
    }

    // MARK: - 设置（P5 设置页）

    /// 当前设置（原样保存的 JSON，含未知键）。
    ///
    /// ⚠️ **必须是原始字典而不是强类型 struct**：
    ///    Electron 版用 `[key: string]: unknown` 兜住未知键（D10 的取向），
    ///    强类型 struct 会**静默丢掉**它不认识的键（用户从旧版带来的设置会消失）。
    @Published private(set) var settings: [String: JSONValue] = [:]

    /// 设置文件路径。
    private var settingsURL: URL {
        URL(fileURLWithPath: dataDir).appendingPathComponent("global-settings.json")
    }

    /// 读设置。
    func loadSettings() {
        if case .loaded(let map) = JSONStore.load([String: JSONValue].self, from: settingsURL) {
            settings = map
        } else {
            // 没有 / 损坏 → 空字典（所有项回落到默认值）
            settings = [:]
        }
    }

    /// 读一个布尔设置。
    func settingBool(_ key: SettingsGroups.Key) -> Bool {
        SettingsDefaults.boolean(key, from: settings)
    }

    /// 读一个字符串设置。
    func settingString(_ key: SettingsGroups.Key) -> String {
        SettingsDefaults.string(key, from: settings)
    }

    /// 写一个设置（**立刻落盘**）。
    ///
    /// ⚠️ 立刻落盘而不是「点保存才写」：设置项是**离散的开关**，
    ///    用户改完就期望它生效。攒着等一个保存按钮反而是 mac 上少见的做法
    ///    （系统偏好设置也是改完立刻生效）。
    func setSetting(_ key: SettingsGroups.Key, _ value: JSONValue) {
        settings[key.rawValue] = value
        persistSettings()
    }

    /// 落盘。
    ///
    /// ⚠️ **保留未知键**：写出的就是 `settings` 原始字典，
    ///    包括我们不认识的（可能是旧版本写的、或未来版本写的）。
    private func persistSettings() {
        _ = JSONStore.save(JSONValue.object(settings), to: settingsURL)
    }

    // MARK: - 分类操作

    /// 保存分类（**保留其他所有顶层键**，见 LibraryMetaStore 的注释）。
    private func persistCategories() {
        var raw: [String: JSONValue] = [:]
        // 先读一遍当前文件（拿 raw，避免抹掉元数据）
        let loaded = LibraryMetaStore.load(dataDir: dataDir)
        raw = loaded.raw

        _ = LibraryMetaStore.saveCategories(
            LibraryMeta(categories: categories, assignments: assignments),
            dataDir: dataDir,
            raw: raw
        )
    }

    /// 新建分类。
    func createCategory(name: String) -> Bool {
        guard let result = Categories.create(categories, name: name) else { return false }
        categories = result.defs
        persistCategories()
        return true
    }

    /// 重命名分类。
    func renameCategory(id: String, newName: String) -> Bool {
        guard let updated = Categories.rename(categories, id: id, newName: newName) else {
            return false
        }
        categories = updated
        persistCategories()
        return true
    }

    /// 删分类（**同时清掉所有归属**）。
    func deleteCategory(id: String) {
        let result = Categories.remove(categories, assignments: assignments, id: id)
        categories = result.defs
        assignments = result.assignments
        persistCategories()
    }
}
