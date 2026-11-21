import Foundation
import TsumigeyaCore

/// 代码里拼出来的界面文案。
///
/// `Text("中文")` 这种字面量由 SwiftUI 自己按环境 locale 取表（表在 App 的 `Resources/*.lproj`）。
/// 这个函数负责 SwiftUI 取不到的那些：状态栏提示、错误信息拼接、窗口标题、`alert` 的 `String` 参数等。
@inline(__always)
func L(_ key: String) -> String {
    L10n.string(key, language: InterfaceLanguageStore.shared.language, bundle: Bundle.module)
}
