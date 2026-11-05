// Tsumigeya 原生版入口（SwiftUI）。
//
// ===== 为什么这个文件只有几十行 =====
//
// 一切逻辑在 `TsumigeyaCore`（纯库，可单测、可被 CLI 用）。
// 这里只做三件事：建 app、建窗口、把 store 注入进去。
//
// ⚠️ **`@main` 与 `main.swift` 互斥**：同一个 module 里不能既有 `@main struct`
//    又有 `main.swift` 的顶层语句。所以 CLI 是**另一个 executable target**
//    （`Sources/TsumigeyaCLI/main.swift`），两者共用 `TsumigeyaCore`。
//
// ⚠️ **不加 `@main` 的场景**：如果用 `main.swift`（小写）当入口，
//    Swift 会把里面的顶层代码当 main —— 那就不能同时有 `@main`。
//    这里两个文件都不叫 `main.swift`，靠 `@main` 声明。
import SwiftUI
import TsumigeyaCore

@main
struct TsumigeyaApp: App {
    /// 全局 store（一次创建，整个 app 生命周期共用）。
    ///
    /// ⚠️ 用 `@StateObject` 而不是每次 `init` 新建：
    ///    store 里持有游戏列表、正在运行的进程、设置等**有状态**的东西，
    ///    重复创建会让「窗口关了再开」时数据回到初始状态（用户会以为数据丢了）。
    @StateObject private var store = AppStore()

    init() {
        // ⚠️ **UI 快照模式**：本鱼在无用户会话的 SSH 环境里验 UI 的唯一办法。
        //
        //    `swift run Tsumigeya --snapshot <目录>` → 渲染几张界面成 PNG 然后退出。
        //    正常启动（不带参数）不受影响。
        //
        // ===== ⚠️ 这里踩过一个死锁（本鱼自己造成的）=====
        //
        //    最初用 `Task { @MainActor in ... }` + `DispatchSemaphore.wait()` 等它完成。
        //    **死锁**：`App.init()` 本身就跑在**主线程**上，`semaphore.wait()` 把主线程
        //    堵死 → 那个 `@MainActor` 任务永远上不了主 actor → 双方互等。
        //
        //    症状：进程挂住、零输出（而不是报错）。
        //
        //    正确的解法：**别在主线程上等**。把渲染挪到一个**后台线程**，
        //    它自己用 `DispatchQueue.main.sync` 回到主线程做渲染。
        //    或者更简单 —— 让渲染**全在后台**做完（ImageRenderer 其实不要求主线程，
        //    只要不碰 SwiftUI 的 UI 状态；但 AppStore 是 @MainActor 的……）。
        //
        //    实际采用：`DispatchQueue.global()` 跑一个同步等待的线程，
        //    里面用 `MainActor.assumeIsolated` **不成立**（那是主线程才行）。
        //
        //    所以最终方案：**先退到 RunLoop**，让主线程空闲下来处理那个 Task，
        //    再等结果 —— 见下面的实现。
        let args = CommandLine.arguments
        guard let idx = args.firstIndex(of: "--snapshot") else { return }
        let outDir = idx + 1 < args.count
            ? args[idx + 1]
            : FileManager.default.temporaryDirectory.path + "/tsmg-ui"

        let box = SnapshotResultBox()
        Task { @MainActor in
            box.value = await UISnapshot.render(to: outDir)
            box.done = true
            // 让主 RunLoop 退出等待（见下面的 run loop 轮询）
            CFRunLoopStop(CFRunLoopGetMain())
        }

        // ⚠️ **用 RunLoop 而不是信号量**：RunLoop.run 会让主线程**继续处理事件**
        //    （包括那个 @MainActor 任务），而不是把它堵死。
        //
        //    这是 mac 上「在主线程等待异步任务」的标准做法之一
        //    （另一个是 `withCheckedContinuation` + 明确的异步入口）。
        //
        //    加超时保护：万一渲染卡住，60 秒后强制退出（不能永远挂着）。
        let deadline = Date().addingTimeInterval(60)
        while !box.done && Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.05))
        }

        if !box.done {
            print("❌ 快照渲染超时（60 秒）")
            exit(1)
        }
        exit(box.value == 0 ? 0 : 1)
    }

    var body: some Scene {
        // ⚠️ **`WindowGroup` 必须带标题**（用户截图反馈：窗口标题显示的是应用名 "Tsumigeya"，
        //    而本鱼在侧边栏设的 `navigationTitle("游戏库")` **没生效**）。
        //
        //    原因：macOS 上 `NavigationSplitView` 的 sidebar 设 `navigationTitle`
        //    不一定影响**窗口标题**（那是 Scene 层的属性）；
        //    `WindowGroup` 不给标题时会回落成 Product name。
        //
        //    这里显式给「游戏库」—— 窗口标题表达「这个窗口在看什么」，
        //    应用身份由 Dock / 菜单栏 / 关于面板表达（mac 惯例）。
        WindowGroup("游戏库") {
            RootView()
                .environmentObject(store)
                // 窗口最小尺寸：两栏布局至少要这么宽才不挤
                .frame(minWidth: 900, minHeight: 600)
        }
        // 单窗口（mac 惯例：启动器是一个工具，不需要多窗口）
        .windowResizability(.contentMinSize)
        .commands {
            CommandGroup(replacing: .appInfo) {
                Button("关于 Tsumigeya") {
                    AboutPanel.show()
                }
            }
        }
    }
}

// MARK: - 关于面板

enum AboutPanel {
    /// 显示系统标准「关于」面板。
    ///
    /// ⚠️ 用 `orderFrontStandardAboutPanel` 而不是自建窗口：
    ///    它会自动读 Info.plist 里的版本号、应用名、图标 —— 与系统一致。
    static func show() {
        NSApp.orderFrontStandardAboutPanel(nil)
    }
}

// MARK: - 快照结果盒子

/// 跨并发域传快照结果。
///
/// ⚠️ `@unchecked Sendable` 的理由：内部只有两个简单值，且用锁保护 ——
///    与 `InstallEnvironment` 同一个取向（Foundation 的类型常缺 Sendable 标注）。
final class SnapshotResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _value = 1
    private var _done = false

    var value: Int {
        get { lock.lock(); defer { lock.unlock() }; return _value }
        set { lock.lock(); defer { lock.unlock() }; _value = newValue }
    }

    var done: Bool {
        get { lock.lock(); defer { lock.unlock() }; return _done }
        set { lock.lock(); defer { lock.unlock() }; _done = newValue }
    }
}
