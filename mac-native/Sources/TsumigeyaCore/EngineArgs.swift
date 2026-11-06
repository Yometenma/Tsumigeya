// 引擎参数的类型与渲染判据。
//
// 对应 Electron 版：`components/DynamicArgsForm.vue`（242 行）+ `engines/registry.ts` 的 gameArgs schema
// 契约：D61（参数表单精简）/ D80（全屏等能力只接引擎已有开关）
//
// ===== 参数有 7 种控件类型（Electron 版实测支持这几种）=====
//
//   `boolean`  开关
//   `text` / `string`  单行文本
//   `int`      整数
//   `float`    小数
//   `dropdown` 下拉（固定选项）
//   `select`   下拉（选项来自别处，如版本列表）
//   `multi-version`  多个版本可选（nwjs 专用）
//   `array`    字符串列表（RTP 路径、fontSub、preloadScript）
//
// ===== ⚠️ 为什么把「类型判定」抽成纯函数 =====
//
// 判据写错的表现**不是崩溃**，而是「某个参数在界面上消失了」或
// 「控件类型不对，改不了」—— 用户会以为「这个引擎没这个参数」。
// 只有单测能抓（与 settings-groups 的「搬家漏项」同一取向）。
//
// ⚠️ 而且**未知类型必须显式回落**（不是静默跳过）：
//    宁可画成一个「无法编辑」的只读行，也不要让它悄悄消失 ——
//    静默消失让用户以为参数不存在，只读行至少告诉他「有这个东西，只是这里改不了」。
import Foundation

public enum EngineArgs {

    /// 参数在界面上用什么控件。
    public enum Control: Sendable, Equatable {
        case boolean
        case text
        case integer
        case float
        /// 固定选项下拉（选项在 schema 的 `options` 里）。
        case dropdown([String])
        /// 多版本下拉（nwjs 专用，选项来自磁盘上真实存在的版本目录）。
        case multiVersion([String])
        /// 字符串列表（RTP 路径 / fontSub / preloadScript）。
        case array
        /// ⚠️ **未知类型**（schema 里写了个我们不认识的 type）。
        ///
        /// 显式画成只读行 —— **不静默跳过**（跳过会让用户以为参数不存在）。
        case unsupported(type: String?)
    }

    /// 根据 schema 定义一个参数的控件类型。
    ///
    /// - Parameters:
    ///   - def: manifest 里的参数定义
    ///   - engine: 引擎 folder（查内置选项表要用）
    ///   - key: 参数名（查内置选项表要用）
    ///   - availableVersions: `multi-version` 类型的可选值（从磁盘扫出来的）
    public static func control(
        for def: GameArgDef,
        engine: String = "",
        key: String = "",
        availableVersions: [String] = []
    ) -> Control {
        if let options = EngineArgsOptions.options(engine: engine, key: key) {
            return .dropdown(options.map(\.value))
        }

        switch def.type {
        case "boolean":
            return .boolean
        case "text", "string":
            return .text
        case "int":
            // ⚠️ `int` 类型的参数**如果没有内置选项表**就是自由整数
            //    （如 `defScreenW` 窗口宽度）—— 不能强行套下拉。
            return .integer
        case "float":
            return .float
        case "dropdown":
            // ⚠️ 选项从 `def.options` 取。schema 没给选项时回落成 text，
            //    否则会画一个「有下拉但是空的」控件（点了没东西可选，比不能改更糟）。
            let opts = def.options ?? []
            return opts.isEmpty ? .text : .dropdown(opts)
        case "select":
            // select 与 dropdown 的区别：选项来自外部（版本列表）
            return availableVersions.isEmpty
                ? .unsupported(type: "select（选项来源为空）")
                : .dropdown(availableVersions)
        case "multi-version":
            return .multiVersion(availableVersions)
        case "array":
            return .array
        default:
            // 未知类型 → 只读行（**不跳过**）
            return .unsupported(type: def.type)
        }
    }

    /// 参数当前的值（从游戏的 gameArgs 取，缺失时用 schema 默认值）。
    ///
    /// ⚠️ **不能只读 gameArgs**：用户没设过的参数在 gameArgs 里不存在，
    ///    直接读会得到 nil → 界面显示空 → 用户以为「这个参数没有值」。
    ///    正确做法是回落到 schema 的 default（那才是「不写就用它」的语义，D61）。
    public static func value(
        for key: String, in gameArgs: [String: JSONValue], schema: GameArgDef?
    ) -> JSONValue? {
        if let userValue = gameArgs[key] { return userValue }
        return schema?.defaultValue
    }

    /// 布尔参数的当前值（缺省当关）。
    ///
    /// ⚠️ **与 Settings 的「缺省当开」不同**：引擎参数缺省一律当关，
    ///    因为它们大多是「开启某个额外行为」（全屏、vsync…），
    ///    默认开会让游戏行为与用户预期不符。
    public static func booleanValue(
        for key: String, in gameArgs: [String: JSONValue], schema: GameArgDef?
    ) -> Bool {
        if let v = value(for: key, in: gameArgs, schema: schema)?.boolValue { return v }
        return false
    }

    /// 字符串列表参数的当前值。
    public static func arrayValue(
        for key: String, in gameArgs: [String: JSONValue], schema: GameArgDef?
    ) -> [String] {
        value(for: key, in: gameArgs, schema: schema)?.arrayValue?
            .compactMap { $0.stringValue } ?? []
    }

    /// 一组参数按**显示顺序**排好。
    ///
    /// ⚠️ 顺序判据：`manifest.gameArgs` 声明顺序（那是作者写的顺序，有意义）。
    ///    但 Swift 字典不保序 → 用 `Manifest.orderedGameArgs`（读 manifest 时保留的）。
    public static func orderedKeys(_ ordered: [String]) -> [String] {
        ordered
    }
}
