// 应用组装、界面入口及跨功能协调；功能对象分别拥有自己的状态和任务。
// 写入仍经状态层进入 Core，不能让 View 自行修改文件后再手动拼接刷新。
import Foundation
import SwiftUI
import Combine
import TsumigeyaCore

@MainActor
final class AppStore: ObservableObject {
    var assistanceSessions: [String: AssistanceSession] = [:]
    /// 只能改文件的引擎（NScripter、RPG Maker 2000/2003）用它，与注入会话分开。
    var offlineSessions: [String: OfflineSession] = [:]
    var translateAssistanceText: @Sendable (TranslationService, String) async throws -> String = { service, source in
        try await service.translate(source)
    }
    /// 批量通道；nil 表示退回逐条。整批不可用时驱动层仍会逐条重试，不会少翻。
    var translateAssistanceBatch: (@Sendable (TranslationService, [String]) async throws -> [String])? = { service, sources in
        try await service.translateBatch(sources)
    }
    let library = GameLibraryState()
    let metadata: LibraryMetadataStore
    let batchMetadata: BatchMetadataCoordinator
    private var featureSubscriptions = Set<AnyCancellable>()
    private var saveSessions: [String: SaveSession] = [:]

    init(dlsiteService: DLsiteService? = nil) {
        metadata = LibraryMetadataStore(service: dlsiteService)
        batchMetadata = BatchMetadataCoordinator(metadata: metadata)
        metadata.languagePreference = { [weak self] in
            guard let self else { return nil }
            return MetadataLanguagePreference(
                preferred: MetadataLanguage(rawValue: self.settingString(.metadataPreferredLanguage)) ?? .simplifiedChinese,
                fallback: MetadataLanguage(rawValue: self.settingString(.metadataFallbackLanguage)))
        }
        metadata.aiService = { [weak self] in
            guard let self else { throw MetadataFailure(L("游戏库已关闭。")) }
            return MetadataAIService(settings: self.metadataAPISettings,
                                     key: try MetadataCredential.read(endpoint: self.metadataAPISettings.endpoint))
        }
        metadata.searchProvider = { [weak self] in self?.metadataSearchSettings.provider ?? .disabled }
        metadata.searchService = { [weak self] in
            guard let self else { throw MetadataFailure(L("游戏库已关闭。")) }
            let settings = self.metadataSearchSettings
            return MetadataSearchService(settings: settings, key: try MetadataCredential.read(endpoint: settings.effectiveEndpoint, search: true))
        }
        metadata.currentGame = { [weak self] id in self?.game(id: id) }
        metadata.readMeta = { [weak self] id in self?.library.metadata(for: id) }
        metadata.didSave = { [weak self] id, meta, raw in self?.library.metadataDidSave(gameId: id, meta: meta, raw: raw) }
        library.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &featureSubscriptions)
        // ObservableObject 不会自动转发子对象变化，界面仍需收到更新。
        metadata.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &featureSubscriptions)
        batchMetadata.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
            .store(in: &featureSubscriptions)
    }

    @Published var manualRJFor: String?
    @Published var isBatchMetaPresented = false

    func reportMetadataSaveFailure(_ message: String?) { lastAddGameError = message }

    func saveSession(for game: GameRecord) -> SaveSession {
        // 尚未销毁的旧视图不能用过期记录替换或使当前会话失效。
        guard self.game(id: game.id) == game else {
            let stale = SaveSession(game: game, store: self)
            stale.invalidate()
            return stale
        }
        if let session = saveSessions[game.id], session.game == game { return session }
        saveSessions.removeValue(forKey: game.id)?.invalidate()
        let session = SaveSession(game: game, store: self)
        saveSessions[game.id] = session
        return session
    }

    // MARK: - 已发布状态

    var games: [GameRecord] { library.games }
    @Published private(set) var dataDir: String = ""
    @Published private(set) var isLoading = true
    /// 加载失败的原因（有值 = 界面该显示错误，而不是空白）。
    var loadError: String? { library.loadError }
    /// 数据目录降级警告（有值 = 该提示用户 —— 静默降级是错的）。
    @Published private(set) var dataDirWarning: DataDirResolution.DataDirWarning?

    var searchText: String {
        get { library.searchText }
        set { library.searchText = newValue }
    }

    /// 正在运行的游戏（id → pid）。
    ///
    /// ⚠️ **只在内存**（D50）：落盘会产生「显示在跑其实早没了」。
    @Published private(set) var runningGames: [String: Int32] = [:]

    /// 上次启动失败的原因（id → 中文说明）。
    ///
    /// ⚠️ 失败必须**明确显示**（D36 的精神：返回结构化结果，不抛错）。
    ///    静默失败会让用户以为「点了没反应」。
    @Published private(set) var lastLaunchFailure: [String: String] = [:]

    /// 「要不要换个 NW.js 版本试试」的建议（id → 建议）。
    ///
    /// ⚠️ 只是**建议**，不自动重启：判据、为什么不自动降级，见 `NwjsVersionAdvisor`。
    @Published private(set) var nwjsSwitchSuggestions: [String: NwjsVersionAdvisor.Suggestion] = [:]

    /// 最近一次启动尝试（id → 启动时用的版本与时刻），用来判「刚起来就没了」。
    ///
    /// 只在内存：进程没了、游戏被删、启动器重启，这些记录都该跟着失效。
    private var launchAttempts: [String: (version: String?, startedAt: Date)] = [:]

    /// 分类数据（P4：从 library-meta.json 读）。
    var categories: CategoryDefs { library.categories }
    var assignments: CategoryAssignments { library.assignments }

    @Published var operationError: String?
    @Published var engineErrors: [String: String] = [:]
    @Published var stoppingGames: Set<String> = []
    var installTokens: [String: UUID] = [:]

    // MARK: - 派生

    typealias Group = GameLibraryState.Group
    var groups: [Group] { library.groups }
    var filteredGames: [GameRecord] { library.filteredGames }

    /// 按 id 查一个游戏。
    func game(id: String) -> GameRecord? {
        library.game(id: id)
    }

    // MARK: - 加载

    func load(dataDirectory: String? = nil) async {
        cancelBatchMeta()
        saveSessions.values.forEach { $0.invalidate() }
        saveSessions.removeAll()
        assistanceSessions.values.forEach { $0.invalidate() }
        assistanceSessions.removeAll()
        offlineSessions.values.forEach { $0.invalidate() }
        offlineSessions.removeAll()
        isLoading = true

        let resolution = DataDir.resolve()
        dataDir = dataDirectory ?? resolution.path
        dataDirWarning = dataDirectory == nil ? resolution.warning : nil
        operationError = library.load(dataDirectory: dataDir)
        metadata.reset(dataDirectory: dataDir)

        // 启动时读取设置并应用外观，不能等到打开设置页才生效。
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
        refreshRunning()
        guard runningGames[game.id] == nil, !stoppingGames.contains(game.id) else { return }
        lastLaunchFailure.removeValue(forKey: game.id)
        if game.gameEngine == "wine", installTasks["wine"] != nil {
            lastLaunchFailure[game.id] = L("Wine 正在安装，请等待安装结束后再启动。")
            return
        }

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
            arch: Arch.current().rawValue, gameID: game.wineEnvironmentIdentity
        )

        switch LaunchPlanner.plan(engine: game.gameEngine, context: ctx) {
        case .failure(let failure):
            lastLaunchFailure[game.id] = failure.message
        case .success(let plan):
            let outcome = Launcher.launch(plan)
            if outcome.ok, let pid = outcome.pid {
                runningGames[game.id] = pid
                // 记下「这次用哪个版本、什么时候起的」：进程若很快消失，
                // refreshRunning 据此给出换版本建议（见 NwjsVersionAdvisor）
                if game.gameEngine == "nwjs" || game.gameEngine == "tyrano" {
                    launchAttempts[game.id] = (
                        version: args["version"]?.stringValue, startedAt: Date())
                } else {
                    launchAttempts.removeValue(forKey: game.id)
                }
                nwjsSwitchSuggestions.removeValue(forKey: game.id)
                // ⚠️ **启动成功后开始轮询**（否则游戏关了界面还显示"运行中"）
                startRunningPoll()
            } else {
                lastLaunchFailure[game.id] = outcome.detail
            }
        }
    }

    /// 换一个 NW.js 版本并立刻重启这个游戏。
    ///
    /// 写回 `gameArgs.version` 再启动：用户选过的版本要留下来，下次直接用它
    /// （`NwjsVersion.resolve` 优先用磁盘上存在的那一个），而不是每次重新踩一遍。
    func relaunchWithNwjsVersion(gameID: String, version: String) {
        guard let game = game(id: gameID) else { return }
        guard runningGames[gameID] == nil else { return }
        var args = game.gameArgs ?? [:]
        args["version"] = .string(version)
        guard updateGame(
            id: game.id, title: game.gameTitle, engine: game.gameEngine, gameArgs: args)
        else { return }
        nwjsSwitchSuggestions.removeValue(forKey: gameID)
        if let updated = self.game(id: gameID) { launch(game: updated) }
    }

    func configureWine(game: GameRecord) {        guard game.gameEngine == "wine", runningGames[game.id] == nil, self.game(id: game.id) == game else { return }
        if installTasks["wine"] != nil {
            lastLaunchFailure[game.id] = L("Wine 正在安装，请等待安装结束后再打开环境设置。")
            return
        }
        lastLaunchFailure.removeValue(forKey: game.id)
        let binary = WineRuntime.binary(dataDir)
        let prefix = WineRuntime.prefix(dataDir: dataDir, folder: DetectPath.gameDirForFiles(game.gamePath), gameID: game.wineEnvironmentIdentity)
        let locale = game.gameArgs?["locale"]?.stringValue ?? "zh_CN.UTF-8"
        let plan = LaunchPlan(binary: binary, args: ["winecfg"], cwd: DetectPath.gameDirForFiles(game.gamePath), engine: "wine",
                              environment: ["WINEPREFIX": prefix, "WINEDEBUG": "-all", "LANG": locale, "LC_ALL": locale, "WINEDLLOVERRIDES": "winemenubuilder.exe=d"])
        let outcome = Launcher.launch(plan)
        if outcome.ok, let pid = outcome.pid { runningGames[game.id] = pid; startRunningPoll() }
        else { lastLaunchFailure[game.id] = outcome.detail }
    }

    /// 只读检查游戏、引擎运行时和启动计划，不执行 mkxp-z 的准备写入。
    func diagnoseLaunch(game: GameRecord) -> LaunchDiagnosis {
        LaunchDiagnostics.inspect(
            game: game,
            dataDir: dataDir,
            arch: Arch.current().rawValue,
            runningPID: runningGames[game.id]
        )
    }

    /// 等待进程退出会耗时数秒，不能占住界面线程。
    func stop(game: GameRecord) {
        guard let pid = runningGames[game.id], !stoppingGames.contains(game.id) else { return }
        stoppingGames.insert(game.id)
        Task {
            let stopped = await Task.detached {
                RunningProcesses().terminate(pid: pid)
            }.value
            stoppingGames.remove(game.id)
            guard runningGames[game.id] == pid else { return }
            if stopped {
                runningGames.removeValue(forKey: game.id)
            } else {
                lastLaunchFailure[game.id] = String(format: L("停止失败：进程 %@ 没退出"), "\(pid)")
            }
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
            for id in runningGames.keys where alive[id] == nil {
                // 「刚起来就没了」= 这个运行时压根没跑起来，可以建议换版本。
                // ⚠️ 用启动时刻算存活时长，不是用「现在」——玩了几小时再关不算失败。
                if let attempt = launchAttempts.removeValue(forKey: id) {
                    let elapsed = Date().timeIntervalSince(attempt.startedAt)
                    let installed = NwjsVersion.availableVersions(dataDir: dataDir)
                    if let game = game(id: id),
                       let suggestion = NwjsVersionAdvisor.suggestion(
                           engine: game.gameEngine, installed: installed,
                           current: attempt.version, exitedAfter: elapsed) {
                        nwjsSwitchSuggestions[id] = suggestion
                    } else {
                        nwjsSwitchSuggestions.removeValue(forKey: id)
                    }
                }
                if let game = game(id: id), game.gameEngine == "wine",
                   let code = WineRuntime.lastExit(dataDir: dataDir, folder: DetectPath.gameDirForFiles(game.gamePath), gameID: game.wineEnvironmentIdentity),
                   code != 0 && code != 143 {
                    lastLaunchFailure[id] = String(format: L("Windows 程序已退出（退出码 %@）。请检查启动文件、语言环境及游戏所需依赖。"), "\(code)")
                }
            }
            runningGames = alive
        }
    }

    /// 运行状态轮询任务。
    ///
    /// ⚠️ **实测到的 bug 就出在这里**：
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
    @Published var installedEngines: Set<String> = []

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

    /// 持久化由游戏库负责；AppStore 只协调请求、会话和界面反馈。
    func addGame(title: String, folder: String, engine: String, entryPath: String? = nil) -> Bool {
        saveLibraryChange { try library.add(title: title, folder: folder, engine: engine, entryPath: entryPath) }
    }

    func deleteGame(id: String) {
        operationError = nil
        refreshRunning()
        guard runningGames[id] == nil else {
            operationError = L("游戏仍在运行，请先停止游戏再移除。")
            return
        }
        guard let expected = game(id: id) else { return }
        // 先撤销旧请求和会话；即使之后只完成部分清理，也不能让旧任务把数据写回来。
        invalidateGameFeatures(id: id)
        let report = library.remove(expected)
        operationError = report.message
        if report.map != nil { lastLaunchFailure.removeValue(forKey: id) }
    }

    private func invalidateGameFeatures(id: String) {
        batchMetadata.invalidateGame(gameId: id)
        metadata.forget(gameId: id)
        saveSessions.removeValue(forKey: id)?.invalidate()
        assistanceSessions.removeValue(forKey: id)?.invalidate()
        offlineSessions.removeValue(forKey: id)?.invalidate()
    }

    private func saveLibraryChange(_ operation: () throws -> Void) -> Bool {
        lastAddGameError = nil
        do { try operation(); return true }
        catch { lastAddGameError = "\(error)"; return false }
    }

    // MARK: - 引擎管理（P5 引擎页）

    /// 引擎状态表（引擎页读它）。
    @Published var engineEntries: [EngineStatus.Entry] = []

    /// 安装进度（folder → 进度）。没有键 = 没在装。
    @Published var engineProgress: [String: EngineProgress] = [:]

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
    var installTasks: [String: Task<Void, Never>] = [:]

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
        if case .loaded(let map) = JSONStore.load([String: JSONValue].self, from: settingsURL, quarantineCorrupt: false) {
            settings = map
        } else {
            // 没有 / 损坏 → 空字典（所有项回落到默认值）
            settings = [:]
        }
        applyInterfaceLanguage(InterfaceLanguage.fromSetting(SettingsDefaults.string(.language, from: settings)))
    }

    /// 当前界面语言（`system` 表示跟随系统）。
    @Published private(set) var interfaceLanguage: InterfaceLanguage = .system

    /// 这个 store 是否接管**全局**界面语言。
    ///
    /// ⚠️ 快照验收和预览会临时建好几个 `AppStore`（各指向一份数据副本）。
    ///    那些临时 store 的设置是空的 → 语言会被算成「跟随系统」；
    ///    如果它们也写全局状态，就会把主窗口刚设好的语言改回去（踩过：
    ///    设置页的快照明明选了 English，分组标题却是中文）。
    var ownsInterfaceLanguage = true

    /// 给 SwiftUI 用的 locale：切换语言后视图重算，`Text` 才会去新语言的表里取文案。
    var interfaceLocale: Locale { interfaceLanguage.locale }

    /// 切换界面语言并把结果同步给 Core（诊断、错误、引擎说明都从那里取表）。
    func setInterfaceLanguage(_ language: InterfaceLanguage) {
        setSetting(.language, .string(language.settingValue))
        applyInterfaceLanguage(language)
    }

    private func applyInterfaceLanguage(_ language: InterfaceLanguage) {
        interfaceLanguage = language
        if ownsInterfaceLanguage { InterfaceLanguageStore.shared.language = language }
        // Core 里缓存过语言相关文案的类型由视图重建，这里不额外广播。
    }

    /// 读一个布尔设置。
    func settingBool(_ key: SettingsGroups.Key) -> Bool {
        SettingsDefaults.boolean(key, from: settings)
    }

    /// 读一个字符串设置。
    func settingString(_ key: SettingsGroups.Key) -> String {
        SettingsDefaults.string(key, from: settings)
    }

    func displayTitle(for game: GameRecord) -> String { game.gameTitle }

    /// 返回作品图片。列表和卡片使用主封面；详情 Hero 优先使用刮削到的首张展示图。
    func artworkURL(for game: GameRecord, preferPreview: Bool = false) -> URL? {
        let work = meta(for: game.id)?.work
        let address: String?
        if preferPreview {
            address = work?.sampleImageURLs.first ?? work?.coverUrl
        } else {
            address = work?.coverUrl ?? work?.sampleImageURLs.first
        }
        // 作品没有真实图片时返回空值，由界面处理缺图状态。
        guard let address else { return nil }
        guard let normalized = work?.isExternal == true ? MetadataNetwork.publicURL(address)?.absoluteString : DLsiteParser.normalizeCoverUrl(address) else { return nil }
        return URL(string: normalized)
    }

    /// 写一个设置（**立刻落盘**）。
    ///
    /// ⚠️ 立刻落盘而不是「点保存才写」：设置项是**离散的开关**，
    ///    用户改完就期望它生效。攒着等一个保存按钮反而是 mac 上少见的做法
    ///    （系统偏好设置也是改完立刻生效）。
    func setSetting(_ key: SettingsGroups.Key, _ value: JSONValue) {
        if [.metadataEndpoint, .metadataSearchEndpoint].contains(key), let address = value.stringValue,
           address.contains("?") || address.contains("@") || address.contains("#") {
            operationError = L("接口地址不能包含账号、密码、查询参数或片段。密钥请填入专用密钥框，不会保存到设置文件。")
            return
        }
        if key == .metadataSearchParameters, let text = value.stringValue,
           let object = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)).objectValue,
           MetadataSearchService.containsSecret(object) {
            operationError = L("搜索附加参数不能包含密钥或令牌，请使用独立密钥框；未保存。"); return
        }
        var updated = settings
        if key == .metadataEndpoint, value != settings[key.rawValue] { updated.removeValue(forKey: SettingsGroups.Key.metadataLANEndpoint.rawValue) }
        if key == .metadataSearchEndpoint || key == .metadataSearchProvider, value != settings[key.rawValue] { updated.removeValue(forKey: SettingsGroups.Key.metadataSearchLANEndpoint.rawValue) }
        updated[key.rawValue] = value
        if let error = JSONStore.save(JSONValue.object(updated), to: settingsURL) {
            operationError = String(format: L("设置保存失败：%@"), "\(error)")
            return
        }
        settings = updated
        if [.metadataEndpoint, .metadataLANEndpoint, .metadataSearchEndpoint, .metadataSearchLANEndpoint, .metadataSearchProvider].contains(key) { metadata.cancelAll() }
        applySettingSideEffect(key, value)
    }

    /// 应用一个设置的**即时副作用**。
    ///
    /// ⚠️ 每个设置项的生效位置不同：
    ///    · `appearance` → 立刻改窗口外观（本函数负责）
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
    /// ⚠️⚠️ **`NSApp` 是隐式解包可选值，必须判空**（实测崩过一次）。
    ///
    ///    `AppKit` 里声明的是 `public let NSApp: NSApplication!` ——
    ///    它只在 `NSApplication.shared` 被访问过、且 app 已初始化后才非 nil。
    ///
    ///    **崩溃场景**：本文件的 `--snapshot` 模式在 `App.init()` 里就构造 `AppStore`
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

    /// 目录修改不移动文件；运行状态由应用层检查。
    func setSaveDirectoryOverride(gameId: String, path: String?) -> Bool {
        lastAddGameError = nil
        refreshRunning()
        guard runningGames[gameId] == nil else {
            lastAddGameError = L("游戏运行中，不能更改存档目录。"); return false
        }
        return saveLibraryChange { try library.setSaveDirectory(gameID: gameId, path: path) }
    }

    func updateGame(id: String, title: String, engine: String, gameArgs: [String: JSONValue]) -> Bool {
        guard saveLibraryChange({ try library.update(id: id, title: title, engine: engine, gameArgs: gameArgs) }) else { return false }
        invalidateGameFeatures(id: id)
        manifestCache.removeAll()
        return true
    }

    func setCategoryMembership(gameId: String, categoryId: String, member: Bool) {
        guard game(id: gameId) != nil else { operationError = L("游戏已移除。"); return }
        _ = changeClassification(.membership(gameID: gameId, categoryID: categoryId, member: member))
    }

    func restoreAutomaticClassification(gameId: String) {
        guard game(id: gameId) != nil else { operationError = L("游戏已移除。"); return }
        _ = changeClassification(.restoreAutomatic(gameID: gameId))
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

    // MARK: - 批量入库与路径重新定位

    @Published var isBatchAdding = false

    func scanGames(folder: String) async throws -> LibraryIntake.Scan {
        let worker = Task.detached(priority: .userInitiated) {
            try LibraryIntake.scan(root: folder, cancelled: { Task.isCancelled })
        }
        return try await withTaskCancellationHandler {
            try await worker.value
        } onCancel: { worker.cancel() }
    }

    func intakeConflict(_ candidate: LibraryIntake.Candidate) -> String? {
        if let id = LibraryIntake.duplicateFolder(candidate.folder, in: GameMap(games: Dictionary(
            uniqueKeysWithValues: games.map { ($0.id, $0) }))) {
            return String(format: L("此目录已入库（游戏 %@）"), "\(id)")
        }
        return nil
    }

    func inspectGameFolder(_ folder: String) throws -> LibraryIntake.Candidate {
        guard let result = try LibraryIntake.inspectFolder(folder) else {
            throw LibraryIntake.Failure(L("未识别出游戏引擎，请选择包含游戏资源的目录。"))
        }
        return result
    }

    func gameFolderExists(_ game: GameRecord) -> Bool {
        var isDirectory: ObjCBool = false
        return FileManager.default.fileExists(atPath: DetectPath.gameDirForFiles(game.gamePath),
                                              isDirectory: &isDirectory) && isDirectory.boolValue
    }

    func addBatch(_ candidates: [LibraryIntake.Candidate]) -> Bool {
        lastAddGameError = nil
        return saveLibraryChange { try library.addBatch(candidates) }
    }

    func relocateGame(_ expected: GameRecord, folder: String) -> Bool {
        lastAddGameError = nil
        refreshRunning()
        guard runningGames[expected.id] == nil else {
            lastAddGameError = L("游戏运行中，不能更改路径。"); return false
        }
        guard saveLibraryChange({ try library.relocate(expected, folder: folder) }) else { return false }
        invalidateGameFeatures(id: expected.id)
        lastLaunchFailure.removeValue(forKey: expected.id)
        return true
    }

    // MARK: - 分类操作

    /// 当前筛选的分类（`nil` = 全部）。
    var activeCategory: String? {
        get { library.activeCategory }
        set { library.activeCategory = newValue }
    }

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
        if categories[pair.id] == nil && activeCategory == pair.id { activeCategory = nil }
    }

    private func changeClassification(_ change: LibraryClassification.Change) -> Bool {
        operationError = nil
        do { try library.changeClassification(change); return true }
        catch { operationError = "\(error)"; return false }
    }

    func createCategory(name: String) -> Bool {
        changeClassification(.create(name: name, gameIDs: games.map(\.id)))
    }

    func renameCategory(id: String, newName: String) -> Bool {
        changeClassification(.rename(id: id, name: newName))
    }

    func deleteCategory(id: String) {
        _ = changeClassification(.delete(id: id))
    }

}
