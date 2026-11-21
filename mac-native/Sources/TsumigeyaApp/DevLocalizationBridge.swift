import Foundation

/// 开发运行时的语言表桥接（**只在 Debug 生效**）。
///
/// 为什么需要它：SwiftUI 的 `Text("中文")` 只查 `Bundle.main` 的 `<lang>.lproj`。
/// 打包成 `.app` 时，`scripts/package-macos.sh` 会把 App 资源 bundle 里的语言表
/// 平铺到 `Contents/Resources/`，`Bundle.main` 自然能找到；
/// 但 `swift run` / 快照验收走的是 SwiftPM 的产物目录，`Bundle.main` 那里没有 `.lproj`，
/// 于是开发运行时界面永远是中文——**和打包版行为不一致**，也让人没法在开发时验译文。
///
/// 做法：把 App 资源 bundle（`Bundle.module`）里的 `en.lproj`、`ja.lproj`
/// 复制到 `Bundle.main.resourcePath` 一次。打包版进到这里时目标已存在，直接跳过。
/// Release 构建不包含这段代码：正式分发不靠运行时复制资源。
enum DevLocalizationBridge {
    static func installIfNeeded() {
        #if DEBUG
        let fm = FileManager.default
        guard let resourcePath = Bundle.main.resourcePath else { return }
        for code in ["en", "ja"] {
            let destination = URL(fileURLWithPath: resourcePath).appendingPathComponent("\(code).lproj")
            if fm.fileExists(atPath: destination.path) { continue }
            guard let source = Bundle.module.url(forResource: code, withExtension: "lproj") else { continue }
            try? fm.copyItem(at: source, to: destination)
        }
        #endif
    }
}
