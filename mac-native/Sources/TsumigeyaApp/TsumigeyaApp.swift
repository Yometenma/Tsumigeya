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

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                // 窗口最小尺寸：库页两列卡片至少要这么宽才不挤
                .frame(minWidth: 760, minHeight: 520)
        }
        // 单窗口（mac 惯例：启动器是一个工具，不需要多窗口）
        .windowResizability(.contentMinSize)
        .commands {
            // ⚠️ mac 惯例：⌘, 打开设置。
            //    SwiftUI 的 Settings scene 是标准做法（系统会把它放到「偏好设置」菜单）
            //    但我们的设置页是**应用内页面**（与 Electron 版一致），
            //    所以这里只加一个「前往设置」的菜单项，不另开窗口。
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
