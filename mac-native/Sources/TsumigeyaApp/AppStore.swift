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
