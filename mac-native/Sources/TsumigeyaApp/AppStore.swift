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
        var result = LibraryFilter.apply(
            games: games,
            searchText: searchText,
            onlyUnbound: false,
            hasBinding: { !($0.gameArgs?.isEmpty ?? true) }
        )
        // ⚠️ **分类筛选**（P5 补上）。
        //
        //    用户 2026-11-06 报「没有地方创建分类」—— 本鱼加了创建入口之后，
        //    还得让**筛选真的生效**，否则那个栏位仍然是个摆设。
        if let activeCategory {
            result = result.filter { game in
                (assignments[game.id] ?? []).contains(activeCategory)
            }
        }
        return result
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

        // ---- ⚠️ 设置（global-settings.json）**必须在启动时读** ----
        //
        // 本鱼 2026-11-06 踩到的 bug：用户设了「游戏库用列表视图」，
        // **重开 app 又是卡片，只有进一下设置页才正常**。
        //
        // 根因：`loadSettings()` 只在**设置页的 `.task`** 里被调用 ——
        //   启动时 `settings` 是空字典 → `settingBool(.listView)` 读到默认值
        //   `false` → 卡片视图。进了设置页才顺带读一次，那时才对。
        //
        // ⚠️ 这与「关掉游戏还显示运行中」是**同一类错误**：
        //   函数写对了，但**调用点漏了**。代码看起来完全正常。
        //
        // ⚠️ 所以这里**不能只补 loadSettings()** —— 还要 `applyAppearance()`：
        //   外观（深色/浅色）也只在 `setSetting` 时应用过一次，
        //   启动时从没应用过 → 用户选了深色，重开还是跟随系统。
        loadSettings()
        applyAppearance()

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
                // ⚠️ **启动成功后开始轮询**（否则游戏关了界面还显示"运行中"）
                startRunningPoll()
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

    /// 运行状态轮询任务。
    ///
    /// ⚠️ **用户 2026-11-06 报的 bug 就出在这里**：
    ///    「关掉游戏之后，为什么还是显示游戏运行中？」
    ///
    ///    根因：`refreshRunning()` **只被 `load()` 调用过一次**（启动时），
    ///    之后**没有任何定时刷新** —— 内存表永远停在你启动游戏那一刻。
    ///    游戏关了，表里那个 pid 还在，界面就一直显示「运行中」。
    ///
    ///    显式点「停止」时确实会清（`stop(game:)` 里有 `removeValue`），
    ///    但用户是**自己去窗口关游戏**的，那条路径不会经过我们。
    ///
    /// 做法：2 秒一次轮询。
    ///
    /// ⚠️ **为什么是 2 秒**：
    ///   · 1 秒：`kill(pid, 0)` 很便宜，但每秒重绘一次列表是浪费（尤其几十个游戏时）
    ///   · 3 秒以上：用户关了游戏会觉得「界面反应好慢」
    ///   · **而且只在有游戏运行时才轮询**（见下）—— 一个都没有时完全不跑
    ///
    /// ⚠️ **判据是 `kill(pid, 0)` 而不是「进程名匹配」**：
    ///    pid 会被系统复用，但 2 秒内复用到同一个 pid 的概率极低，
    ///    而且我们的 pid 是 `spawn` 直接拿到的（不是猜的）。
    private var runningPollTask: Task<Void, Never>?

    /// 开始轮询运行状态。
    ///
    /// ⚠️ **每次调用都先取消旧的再起新的**（而不是「已经在跑就 return」）。
    ///
    ///    本鱼第一版用的是 `guard runningPollTask == nil else { return }`，
    ///    但那有个 **race**：
    ///      ① 游戏全停 → 任务准备结束，但还没执行到 `runningPollTask = nil`
    ///      ② 用户这时启动新游戏 → `startRunningPoll()` 看到非 nil → **直接 return**
    ///      ③ 旧任务随后把它设为 nil 并退出
    ///      ④ **没有任何轮询在跑** → 新游戏关了界面照样显示"运行中"
    ///
    ///    「先取消再起」没有这个窗口：轮询本身是无状态的（每次都重新扫一遍），
    ///    重复启动的代价只是多一次 `kill(pid, 0)`。
    func startRunningPoll() {
        runningPollTask?.cancel()
        runningPollTask = nil

        runningPollTask = Task { [weak self] in
            while !Task.isCancelled {
                // 2 秒一次
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if Task.isCancelled { return }
                guard let self else { return }

                let stillRunning = await MainActor.run { () -> Bool in
                    self.refreshRunning()
                    return !self.runningGames.isEmpty
                }

                // 全停 → 结束轮询（下次启动游戏会重新起）
                if !stillRunning {
                    await MainActor.run { self.runningPollTask = nil }
                    return
                }
            }
        }
    }

    /// 停止轮询。
    func stopRunningPoll() {
        runningPollTask?.cancel()
        runningPollTask = nil
    }

    /// app 重新获得焦点时的刷新（切回启动器那一刻）。
    ///
    /// ⚠️ 为什么单独一个入口：**用户刚关掉游戏、刚切回启动器**时，
    ///    那一刻界面必须是对的 —— 不能让他等下一轮 2 秒轮询。
    ///
    /// 这是「关掉游戏后还显示运行中」那个 bug 的**第二条修复**：
    ///   ① 2 秒轮询（覆盖「游戏在后台被关」）
    ///   ② 切回应用时立刻刷（覆盖「用户就在眼前看到它没更新」）
    func refreshRunningFromAppActivation() {
        refreshRunning()
        // 还有游戏在跑 → 确保轮询在跑（可能被上一次的全停逻辑结束了）
        if !runningGames.isEmpty {
            startRunningPoll()
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
        // ⚠️ **改完立刻应用副作用**（这是 P5 补的）。
        //
        //    在此之前，设置只是被存下来但**没人消费** ——
        //    用户改了主题却看不出变化，会以为「这个应用坏了」。
        //    表现比「没有这个开关」更糟：没有开关他不会期待，有开关没反应会让他怀疑软件。
        applySettingSideEffect(key, value)
    }

    /// 应用一个设置的**即时副作用**。
    ///
    /// ⚠️ 每个设置项的生效位置不同：
    ///    · `appearance` → 立刻改窗口外观（本函数负责）
    ///    · `listView` → 库页下次渲染时读（`filteredGames` 那边用）
    ///    · 其余 → 由各自的消费方在用到时读（启动、诊断、存档…）
    private func applySettingSideEffect(_ key: SettingsGroups.Key, _ value: JSONValue) {
        switch key {
        case .appearance:
            let mode = value.stringValue ?? "system"
            // ⚠️ 用 `NSApplication.shared` 而不是 `NSApp`（`NSApp` 是隐式解包，
            //    在某些初始化时机是 nil —— 见 `applyAppearance` 的注释）
            let app = NSApplication.shared
            switch mode {
            case "light":
                app.appearance = NSAppearance(named: .aqua)
            case "dark":
                app.appearance = NSAppearance(named: .darkAqua)
            default:
                // 跟随系统：置 nil（系统会自己决定）
                app.appearance = nil
            }
        default:
            // 其余项由各自的消费方读（见上面的注释）
            break
        }
    }

    /// 把外观设置应用到 app（启动时调一次）。
    ///
    /// ⚠️ 启动时也要应用：用户上次选了「深色」，这次打开就该是深色 ——
    ///    不能等他进设置页才生效。
    ///
    /// ⚠️⚠️ **`NSApp` 是隐式解包可选值，必须判空**（本鱼实测崩过一次）。
    ///
    ///    `AppKit` 里声明的是 `public let NSApp: NSApplication!` ——
    ///    它只在 `NSApplication.shared` 被访问过、且 app 已初始化后才非 nil。
    ///
    ///    **崩溃场景**：本鱼的 `--snapshot` 模式在 `App.init()` 里就构造 `AppStore`
    ///    并调 `load()` → `applyAppearance()` → `NSApp.appearance = nil`
    ///    → **Fatal error: Unexpectedly found nil**。
    ///
    ///    用 `NSApplication.shared`（**不判空的懒加载属性**）比 `NSApp` 安全：
    ///    访问它会创建/返回共享实例，不会返回 nil。
    func applyAppearance() {
        let mode = settingString(.appearance)
        // ⚠️ 用 `NSApplication.shared` 而不是 `NSApp`（见上）
        let app = NSApplication.shared
        switch mode {
        case "light": app.appearance = NSAppearance(named: .aqua)
        case "dark": app.appearance = NSAppearance(named: .darkAqua)
        default: app.appearance = nil
        }
    }

    /// 落盘。
    ///
    /// ⚠️ **保留未知键**：写出的就是 `settings` 原始字典，
    ///    包括我们不认识的（可能是旧版本写的、或未来版本写的）。
    private func persistSettings() {
        _ = JSONStore.save(JSONValue.object(settings), to: settingsURL)
    }

    // MARK: - 编辑游戏（P5 编辑页）

    /// manifest 缓存（引擎 folder → manifest）。
    @Published private var manifestCache: [String: Manifest] = [:]

    /// 读某个引擎的 manifest（带缓存）。
    ///
    /// ⚠️ 缓存的意义：编辑页的参数表单**每次重绘都要 schema**，
    ///    每次都读盘会让打字输入变卡（用户每按一个键都触发一次文件读取）。
    func manifest(for engine: String) -> Manifest? {
        if let cached = manifestCache[engine] { return cached }
        guard let loaded = ManifestStore.load(dataDir: dataDir, engine: engine) else {
            return nil
        }
        manifestCache[engine] = loaded
        return loaded
    }

    /// `multi-version` 参数的可选值（从磁盘上真实存在的版本目录扫）。
    ///
    /// ⚠️ **只有 nwjs 的 `version` 是这种类型**（当前 9 个引擎里）。
    ///    其它引擎没有多版本运行时，传空数组即可
    ///    （`EngineArgs.control` 会回落成「不可选」并提示）。
    func availableVersions(for def: GameArgDef, engine: String) -> [String] {
        guard def.type == "multi-version", engine == "nwjs" else { return [] }
        return NwjsVersion.availableVersions(dataDir: dataDir)
    }

    /// 更新一个游戏（**全页一个保存**，U8 的核心）。
    ///
    /// - Returns: 是否成功。失败原因写在 `lastAddGameError`。
    ///
    /// ⚠️ **只改传进来的三个字段**：标题 / 引擎 / 参数。
    ///    路径不在其中 —— 改路径等于「这游戏搬走了」，该重新添加（见 GameEditView 的注释）。
    ///
    /// ⚠️ **未知字段必须原样保留**（D10）：`GameLibrary.save` 里有继承逻辑，
    ///    但这里要保证传进去的 draft 不把 `unknownFields` 清空
    ///    （否则用户从旧版带来的字段会消失）。
    func updateGame(
        id: String, title: String, engine: String, gameArgs: [String: JSONValue]
    ) -> Bool {
        lastAddGameError = nil

        let url = URL(fileURLWithPath: dataDir).appendingPathComponent("games.json")
        guard case .loaded(var map) = JSONStore.load(GameMap.self, from: url) else {
            lastAddGameError = "读不到 games.json"
            return false
        }
        guard let existing = map.games[id] else {
            lastAddGameError = "游戏 id \(id) 不存在"
            return false
        }

        // 组装新记录（保留不在表单里的字段）
        var draft = existing
        draft.gameTitle = title
        draft.gameEngine = engine
        draft.gameArgs = gameArgs
        // unknownFields 原样保留（不显式设，draft 是从 existing 拷的，已经带着）

        let result = GameLibrary.save(into: map, draft: draft, id: id)
        switch result {
        case .failure(let err):
            lastAddGameError = err.message
            return false
        case .success(let saved):
            if let writeError = JSONStore.save(saved.map, to: url) {
                lastAddGameError = "写 games.json 失败：\(writeError)"
                return false
            }
            map = saved.map
            games = map.ordered
            // ⚠️ manifest 缓存要清（引擎可能改了）
            manifestCache.removeAll()
            return true
        }
    }

    /// 设置分类归属（**立刻落盘**）。
    ///
    /// ⚠️ 不属于「这个游戏的记录」，它在 library-meta.json 的 assignments 里。
    ///    攒着等保存会让「取消编辑」时它已经被改了（见 GameEditView 的文件头）。
    func setCategoryMembership(gameId: String, categoryId: String, member: Bool) {
        assignments = Categories.setMembership(
            assignments, gameId: gameId, categoryId: categoryId, member: member)
        persistCategories()
    }

    // MARK: - 删除确认（P5 补齐）

    /// 待确认删除的游戏（`nil` = 没有待确认的）。
    ///
    /// ⚠️ **删除必须二次确认**（除非用户在设置里关掉了 `deletionConfirmation`）。
    ///    删游戏清的是四处旁挂数据，误点的代价是「游玩历史和分类归属全丢」，
    ///    而用户当时不会想到是自己点错。
    @Published var pendingDelete: GameRecord?

    /// 请求删除（先弹确认）。
    func confirmDelete(game: GameRecord) {
        // 设置里关掉了确认 → 直接删（那是用户明确要的）
        if !settingBool(.deletionConfirmation) {
            deleteGame(id: game.id)
            return
        }
        pendingDelete = game
    }

    /// 确认删除。
    func confirmPendingDelete() {
        guard let game = pendingDelete else { return }
        pendingDelete = nil
        deleteGame(id: game.id)
    }

    func cancelPendingDelete() {
        pendingDelete = nil
    }

    /// 在访达中显示游戏目录。
    ///
    /// ⚠️ 用游戏的**目录**而不是 gamePath（后者是 `…/Game.exe` 这种文件）——
    ///    用户想看到的是文件夹。
    func revealInFinder(game: GameRecord) {
        let dir = DetectPath.gameDirForFiles(game.gamePath)
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: dir)
    }

    // MARK: - 编辑请求（右键菜单用）

    /// 请求进入编辑（由 `GamePane` 消费）。
    ///
    /// ⚠️ 用「请求」而不是直接设 state：`GamePane` 的 `isEditing` 是它自己的
    ///    `@State`，store 拿不到。所以 store 记一个「要编辑这个 id」，
    ///    View 那边读它并清掉。
    @Published private(set) var editRequest: String?

    func requestEdit(gameId: String) {
        editRequest = gameId
    }

    func consumeEditRequest() -> String? {
        let id = editRequest
        editRequest = nil
        return id
    }

    // MARK: - DLsite 元数据（P7）

    /// 每个游戏的元数据（gameId → meta）。
    ///
    /// ⚠️ 懒加载：`load()` 时**不读**（一部游戏一个文件读取，几十个游戏会慢）。
    ///    进详情页时才按需读，读过的缓存在这里。
    @Published private(set) var gameMeta: [String: GameDlsiteMeta] = [:]

    /// 正在抓取元数据的游戏（防重复点击）。
    @Published private(set) var fetchingMeta: Set<String> = []

    /// 抓取失败的原因（gameId → 说明）。
    @Published private(set) var metaError: [String: String] = [:]

    /// DLsite 服务（懒加载，首次用到才建）。
    private var dlsiteService: DLsiteService?

    /// 取一个游戏的元数据（**没有就返回 nil，不猜**）。
    func meta(for gameId: String) -> GameDlsiteMeta? {
        if let cached = gameMeta[gameId] { return cached }
        let loaded = GameMetaStore.load(dataDir: dataDir, gameId: gameId)
        if let loaded {
            // ⚠️ 这里**不能直接改 @Published 字典**
            //    （在 View 的 body 里调这个方法会导致「修改状态时正在渲染」警告）
            //    所以只返回值，不写缓存。真要缓存请走 `loadMeta(for:)`。
            return loaded
        }
        return nil
    }

    /// 主动加载并缓存元数据（在 `.task` / 按钮里调）。
    func loadMeta(for gameId: String) {
        guard gameMeta[gameId] == nil else { return }
        if let loaded = GameMetaStore.load(dataDir: dataDir, gameId: gameId) {
            gameMeta[gameId] = loaded
        }
    }

    /// 从游戏路径自动检测 RJ（不联网）。
    func detectRJ(for game: GameRecord) -> [String] {
        RJNumber.detectFromPath(gamePath: game.gamePath)
    }

    /// 抓取 DLsite 元数据（**联网**）。
    ///
    /// - Parameters:
    ///   - gameId: 游戏 id
    ///   - rj: RJ 号
    ///   - refresh: 强制重抓（忽略缓存）
    ///
    /// ⚠️ **异步**：网络请求不能阻塞主线程。
    func fetchMeta(gameId: String, rj: String, refresh: Bool = false) {
        guard !fetchingMeta.contains(gameId) else { return }
        fetchingMeta.insert(gameId)
        metaError.removeValue(forKey: gameId)

        Task { @MainActor in
            defer { fetchingMeta.remove(gameId) }

            // 懒建服务
            if dlsiteService == nil {
                dlsiteService = DLsiteService(dataDir: dataDir)
            }
            guard let service = dlsiteService else { return }

            let result = await service.fetchWork(rj: rj, refresh: refresh)

            switch result {
            case .success(let work):
                // ⚠️ **合并时保护用户改过的字段**（D26）
                let existing = gameMeta[gameId]
                    ?? GameMetaStore.load(dataDir: dataDir, gameId: gameId)
                let edited = Set(existing?.editedFields ?? [])
                let merged = EditedFields.merge(
                    old: existing?.work, incoming: work, edited: edited)

                let meta = GameDlsiteMeta(
                    work: merged, editedFields: existing?.editedFields ?? [])
                if let err = GameMetaStore.save(
                    dataDir: dataDir, gameId: gameId, meta: meta) {
                    metaError[gameId] = "保存元数据失败：\(err)"
                    return
                }
                gameMeta[gameId] = meta
            case .failure(let error):
                // ⚠️ 结构化错误 → 直接显示它的 message（每种错误说不同的话）
                metaError[gameId] = error.message
            }
        }
    }

    /// 用户手动编辑一个元数据字段（**标记为已编辑，刷新时不覆盖**，D26）。
    func editMetaField(gameId: String, field: String, value: String?) {
        guard var meta = meta(for: gameId) else { return }

        var work = meta.work
        switch field {
        case "title": work.title = value
        case "titleSub": work.titleSub = value
        case "circle": work.circle = value
        case "description": work.description = value
        default: return
        }
        meta.work = work

        // ⚠️ **必须记进 editedFields**，否则下次刷新会被 DLsite 的值覆盖
        if !meta.editedFields.contains(field) {
            meta.editedFields.append(field)
        }
        _ = GameMetaStore.save(dataDir: dataDir, gameId: gameId, meta: meta)
        gameMeta[gameId] = meta
    }

    /// 正在手动输入 RJ 的游戏 id（nil = 没在输）。
    ///
    /// ⚠️ **为什么必须有这条路**（本鱼实测发现）：
    ///    用户的 5 个真实游戏**全部检测不到 RJ** ——
    ///    目录名不带 RJ、有的连 readme 都没有、有 readme 的里面也没有 RJ 号。
    ///
    ///    → 没有手动入口的话，P7 对这个用户**完全没用**。
    @Published var manualRJFor: String?

    func beginManualRJ(gameId: String) {
        manualRJFor = gameId
    }

    func closeManualRJ() {
        manualRJFor = nil
    }

    /// 清掉一个游戏的元数据（删游戏时调）。
    func removeMeta(gameId: String) {
        GameMetaStore.remove(dataDir: dataDir, gameId: gameId)
        gameMeta.removeValue(forKey: gameId)
        metaError.removeValue(forKey: gameId)
    }

    // MARK: - 分类操作

    /// 当前筛选的分类（`nil` = 全部）。
    @Published var activeCategory: String?

    /// 是否在新建分类。
    @Published var isCreatingCategory = false

    /// 待删除的分类（`nil` = 没有）。
    @Published var pendingDeleteCategory: (id: String, name: String)?

    func beginCreateCategory() {
        isCreatingCategory = true
    }

    func closeCreateCategory() {
        isCreatingCategory = false
    }

    func confirmDeleteCategory(id: String, name: String) {
        pendingDeleteCategory = (id, name)
    }

    func cancelDeleteCategory() {
        pendingDeleteCategory = nil
    }

    func confirmPendingDeleteCategory() {
        guard let pair = pendingDeleteCategory else { return }
        pendingDeleteCategory = nil
        deleteCategory(id: pair.id)
        // ⚠️ 如果删的正好是当前筛选的那个，要回到「全部」
        //    （否则列表会空 —— 用户会以为游戏丢了）
        if activeCategory == pair.id { activeCategory = nil }
    }

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
