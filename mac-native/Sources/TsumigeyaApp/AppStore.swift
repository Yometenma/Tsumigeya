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
// 那样「改一处数据要在五个地方刷新内存」的 bug 会立刻回来。
// store 是**唯一**的数据入口，UI 只读它、只通过它改。
import Foundation
import SwiftUI
import TsumigeyaCore

@MainActor
final class AppStore: ObservableObject {

    // MARK: - 已发布状态

    /// 游戏列表（按 id 数值排序 —— 与 Electron 版的库页顺序一致）。
    @Published private(set) var games: [GameRecord] = []
    /// 数据目录（第一次加载时确定）。
    @Published private(set) var dataDir: String = ""
    /// 加载中（库页显示骨架）。
    @Published private(set) var isLoading = true
    /// 加载失败的原因（有值 = 库页该显示错误，而不是空白）。
    @Published private(set) var loadError: String?
    /// 数据目录降级警告（有值 = 该提示用户 —— 静默降级是错的）。
    @Published private(set) var dataDirWarning: DataDirResolution.DataDirWarning?

    /// 搜索关键词。
    @Published var searchText: String = ""
    /// 是否只看未绑定引擎的游戏（对应 Electron 版的「只看未绑定」）。
    @Published var onlyUnbound: Bool = false
    /// 列表视图（false = 卡片网格，true = 列表）。
    @Published var listView: Bool = false

    /// 正在运行的游戏（id → pid）。
    ///
    /// ⚠️ **只在内存**（D50）：落盘会产生「显示在跑其实早没了」。
    ///    这与 Electron 版一致，不是偷懒。
    @Published private(set) var runningGames: [String: Int32] = [:]

    // MARK: - 派生状态

    /// 库页要显示的游戏（过滤后）。
    ///
    /// ⚠️ 判据**不要**写在 View 里（Electron 版踩过：画错不报错，只能靠单测钉）。
    ///    这里调 `LibraryFilter` 的纯函数，它有自己的测试。
    var filteredGames: [GameRecord] {
        LibraryFilter.apply(
            games: games,
            searchText: searchText,
            onlyUnbound: onlyUnbound,
            // 「未绑定」= gameArgs 里没有引擎特定的选择（与 Electron 版判据一致）
            hasBinding: { !($0.gameArgs?.isEmpty ?? true) }
        )
    }

    // MARK: - 加载

    func load() async {
        isLoading = true
        loadError = nil

        let resolution = DataDir.resolve()
        dataDir = resolution.path
        dataDirWarning = resolution.warning

        let url = URL(fileURLWithPath: resolution.path).appendingPathComponent("games.json")
        switch JSONStore.load(GameMap.self, from: url) {
        case .missing:
            // **正常状态**：首次运行还没有 games.json（不是错误）
            games = []
        case .corrupt(let failure):
            // **故障**：文件存在但读不出。必须告诉用户（他怎么也想不到是格式坏了）
            loadError = "游戏库文件损坏：\(failure.reason)"
                + (failure.backupPath.map { "\n原件已改名保留：\($0)" } ?? "")
            games = []
        case .loaded(let map):
            games = map.ordered
        }

        isLoading = false
    }

    /// 重新扫描正在运行的进程（把内存表与真实进程对上）。
    ///
    /// ⚠️ 为什么需要：启动器可能被强杀、游戏可能自己崩。
    ///    内存表不刷新就会出现「显示在跑，其实早没了」——那正是 D50 要防的事。
    func refreshRunning() {
        let engineRunner = RunningProcesses()
        var alive: [String: Int32] = [:]
        for (id, pid) in runningGames where engineRunner.isAlive(pid: pid) {
            alive[id] = pid
        }
        if alive != runningGames {
            runningGames = alive
        }
    }
}
