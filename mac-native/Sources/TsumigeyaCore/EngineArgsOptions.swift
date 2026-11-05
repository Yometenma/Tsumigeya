// 引擎参数的内置选项表。
//
// ===== 为什么需要这一层 =====
//
// manifest 里 `gameArgs` 的形状是 `{ type, label, default }` —— **没有 options**。
// 所以 `type: "dropdown"` 的参数在界面上会回落成文本框（本鱼原来的实现）。
//
// 但有些参数**语义是固定的枚举**（比如 `rgssVersion` 只能是 1/2/3 或自动），
// 让用户手打数字既容易错、又不知道 1/2/3 是什么意思。
//
// 所以：manifest 不带 options 时，**先查这张内置表**；查不到才回落成 text。
//
// ⚠️ 这张表**只放有确定语义的参数**，不放「理论上可以任填」的
//    （`windowTitle` 是任意字符串、`defScreenW` 是任意整数）。
//    给自由值套下拉会**限制用户**，比文本框更糟。
import Foundation

public enum EngineArgsOptions {

    /// 一个选项。
    public struct Option: Sendable, Equatable {
        /// 写进 gameArgs 的值。
        public let value: String
        /// 界面上显示的文字。
        public let label: String

        public init(value: String, label: String) {
            self.value = value
            self.label = label
        }
    }

    /// 内置选项表：引擎 folder → 参数名 → 选项。
    ///
    /// ## ⚠️ `rgssVersion` 的语义（本鱼实测核对过）
    ///
    /// `MkxpzConfig.resolveRtp` 的判据是：
    ///
    /// ```swift
    /// if let raw = ...intValue, raw == 1 || raw == 2 || raw == 3 {
    ///     explicit = raw        // ← 只有 1/2/3 被当成「用户指定」
    /// } else {
    ///     explicit = nil        // ← 其他一切（含 0、空、乱填）都是「自动」
    /// }
    /// ```
    ///
    /// 所以：
    ///   · `0` = **自动**（让 mkxp-z 自己按归档魔数判断 RGSS 版本）
    ///   · `1/2/3` = 用户强制指定 XP / VX / VX Ace
    ///
    /// manifest 的 `default` 就是 `"0"`（= 自动）——
    /// 所以「自动」必须是下拉的**默认选中项**，否则一进来就是「XP」，
    /// 用户不改的话等于**替所有游戏强制选了 XP**（对 VX Ace 游戏是错的）。
    public static let builtin: [String: [String: [Option]]] = [
        "mkxpz": [
            "rgssVersion": [
                Option(value: "0", label: "自动（按游戏文件判断）"),
                Option(value: "1", label: "RPG Maker XP（RGSS 1）"),
                Option(value: "2", label: "RPG Maker VX（RGSS 2）"),
                Option(value: "3", label: "RPG Maker VX Ace（RGSS 3）"),
            ],
        ],
    ]

    /// 把 gameArgs 里的值统一转成「选项值字符串」。
    ///
    /// ⚠️⚠️ **这是本鱼踩到的一个真 bug（用户截图报「还是显示 0」）**：
    ///
    /// `gameArgs["rgssVersion"]` 的**存储类型是 int**（manifest 的 `default` 是 `"0"`，
    /// 但用户真机上存的是数字 `0`，因为它原本就是从 ini 推断后写回去的整数）。
    ///
    /// 而 `JSONValue.int(0).stringValue` 是 **nil**（int 不是 string）。
    /// 于是 Picker 的 `get` 拿到 nil → 回落到 `rich.first.value` → 显示第一项……
    /// 但**如果 tag 是 `"0"` 而 get 返回 int 转出来的 nil**，Picker 匹配不上 →
    /// 显示裸数字或空白。
    ///
    /// 所以这里必须**同时认 string 和 int**。
    public static func normalizedValue(_ raw: JSONValue?) -> String? {
        guard let raw else { return nil }
        if let s = raw.stringValue { return s }
        if let n = raw.intValue { return String(n) }
        return nil
    }

    /// 查某个参数的内置选项。
    ///
    /// - Returns: 选项表；`nil` = 没有内置选项（调用方回落成文本框）
    public static func options(engine: String, key: String) -> [Option]? {
        builtin[engine]?[key]
    }

    /// 把一个已存的值转成下拉要显示的标签。
    ///
    /// ⚠️ **必须能处理"存了个不认识的数字"**：
    ///    用户可能手改过 `gameArgs`（或者从旧版本带过来一个 `rgssVersion: 5`）。
    ///    那时不能显示空白（用户会以为没设置），要显示「未知值（5）」
    ///    并让他能改掉。
    public static func label(
        forValue value: String?, options: [Option]
    ) -> String {
        guard let value, !value.isEmpty else {
            // 没有值 → 显示第一项（通常是「自动」）
            return options.first?.label ?? ""
        }
        if let match = options.first(where: { $0.value == value }) {
            return match.label
        }
        // 不认识的值 → 明确显示出来，不静默当成自动
        return "未知值（\(value)）"
    }

    /// 判断一个值是否被选项表认识。
    public static func isKnown(_ value: String?, options: [Option]) -> Bool {
        guard let value, !value.isEmpty else { return true }   // 空 = 用默认，算认识
        return options.contains { $0.value == value }
    }
}
