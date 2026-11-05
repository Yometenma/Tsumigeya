// 引擎参数内置选项表测试。
//
// 守的是：下拉选项本身容易写错，而**错了不会崩** ——
// 只是用户看到一个错的选项，或者默认选中了一个错的值。
import Foundation
import Testing

@testable import TsumigeyaCore

@Suite("引擎参数内置选项")
struct EngineArgsOptionsTests {

    /// `rgssVersion` 必须有 4 个选项（自动 + XP/VX/VX Ace）。
    @Test("rgssVersion 四个选项")
    func rgssVersionOptions() throws {
        let opts = try #require(EngineArgsOptions.options(engine: "mkxpz", key: "rgssVersion"))
        #expect(opts.count == 4)
        #expect(opts.map(\.value) == ["0", "1", "2", "3"])
    }

    /// ⚠️⚠️ **「自动」必须是第一项**。
    ///
    /// 守的是：manifest 的 `default` 是 `"0"`（= 自动）。
    /// 下拉的**默认选中**取的是 `opts.first`，
    /// 所以第一项不是「自动」的话，一进编辑页就变成「XP」——
    /// 用户不改就等于**替所有游戏强制选了 XP**（对 VX Ace 游戏是错的，
    /// 会直接启动失败）。
    @Test("自动是第一个选项")
    func autoIsFirst() throws {
        let opts = try #require(EngineArgsOptions.options(engine: "mkxpz", key: "rgssVersion"))
        #expect(opts.first?.value == "0", "第一项必须是「自动」")
        #expect(opts.first?.label.contains("自动") == true)
    }

    /// ⚠️ **选项值与 `MkxpzConfig.resolveRtp` 的判据必须一致**。
    ///
    /// 那边只认 `1 / 2 / 3`（其余全是自动）。所以选项里
    /// **不能出现 4、5 这种它不认的值**（用户选了等于选自动，但他以为是别的）。
    @Test("选项值与引擎判据一致")
    func valuesMatchEngineLogic() throws {
        let opts = try #require(EngineArgsOptions.options(engine: "mkxpz", key: "rgssVersion"))
        // ⚠️ 拆开写：链式 `map{}.compactMap{}.filter{}` 会让 Swift 的类型检查器超时
        //    （实测报 "unable to type-check this expression in reasonable time"）。
        var accepted: [Int] = []
        for opt in opts {
            if let n = Int(opt.value), n == 1 || n == 2 || n == 3 {
                accepted.append(n)
            }
        }
        #expect(accepted.count == 3, "1/2/3 三个真实版本")

        // 0 = 自动（引擎那边 explicit=nil）
        #expect(opts.contains { $0.value == "0" })
    }

    /// 标签要说人话（含 RPG Maker 与版本号）。
    @Test("标签说人话")
    func labelsAreReadable() throws {
        let opts = try #require(EngineArgsOptions.options(engine: "mkxpz", key: "rgssVersion"))
        #expect(opts[1].label.contains("XP"))
        #expect(opts[2].label.contains("VX"))
        #expect(opts[3].label.contains("VX Ace"), "VX Ace 与 VX 要能区分开")
    }

    /// `rgssVersion` 用下拉而不是文本框（**这是用户 2026-11-06 明确要的**）。
    @Test("rgssVersion 是下拉")
    func rgssVersionIsDropdown() {
        let def = GameArgDef(type: "dropdown", label: "RGSS Version", defaultValue: .string("0"))
        let ctrl = EngineArgs.control(for: def, engine: "mkxpz", key: "rgssVersion")
        guard case .dropdown(let values) = ctrl else {
            Issue.record("应该是下拉，实际是 \(ctrl)"); return
        }
        #expect(values == ["0", "1", "2", "3"])
    }

    /// ⚠️ **内置选项表优先于 manifest 的 type**。
    ///
    /// 守的是：即使 manifest 把 type 写成 `text`（或者上游改过），
    /// 有内置选项表也应该是下拉 —— 因为那是**我们知道该怎么做**的参数。
    @Test("内置表优先于 manifest type")
    func builtinOverridesManifestType() {
        let def = GameArgDef(type: "text", label: "RGSS Version")
        let ctrl = EngineArgs.control(for: def, engine: "mkxpz", key: "rgssVersion")
        guard case .dropdown = ctrl else {
            Issue.record("内置表应该压过 manifest 的 type=text"); return
        }
    }

    /// ⚠️ **自由整数不能被套上下拉**（如窗口宽度）。
    ///
    /// 守的是：给自由值套下拉会**限制用户**，比文本框更糟。
    @Test("自由整数仍是文本框/整数")
    func freeIntegersStayNumeric() {
        let def = GameArgDef(type: "int", label: "Window Width (0=auto)")
        let ctrl = EngineArgs.control(for: def, engine: "mkxpz", key: "defScreenW")
        guard case .integer = ctrl else {
            Issue.record("窗口宽度该是整数输入，实际是 \(ctrl)"); return
        }
    }

    /// 不认识的存值要显式显示，不能静默当成自动。
    @Test("未知值显式显示")
    func unknownValueShown() throws {
        let opts = try #require(EngineArgsOptions.options(engine: "mkxpz", key: "rgssVersion"))
        #expect(EngineArgsOptions.label(forValue: "3", options: opts) == opts[3].label)
        // 用户手改过 5（引擎那边当自动）→ 界面必须显示出来
        let unknown = EngineArgsOptions.label(forValue: "5", options: opts)
        #expect(unknown.contains("5"), "未知值要把原值显示出来")
        #expect(!unknown.contains("自动"), "不能静默当成自动")
    }

    /// 没有内置选项的参数返回 nil（调用方回落）。
    @Test("没有内置选项返回 nil")
    func noBuiltinReturnsNil() {
        #expect(EngineArgsOptions.options(engine: "mkxpz", key: "defScreenW") == nil)
        #expect(EngineArgsOptions.options(engine: "easyrpg", key: "rgssVersion") == nil)
        #expect(EngineArgsOptions.options(engine: "no-such-engine", key: "rgssVersion") == nil)
    }

    // MARK: - ⚠️ string ⇄ int 归一化（用户截图报的真 bug）

    /// ⚠️⚠️ **`normalizedValue` 必须同时认 string 与 int**。
    ///
    /// 守的是：真机数据里 `rgssVersion` 存的是**数字 `0`**（不是 `"0"`），
    /// 而 `JSONValue.int(0).stringValue` 是 **nil** →
    /// Picker 的 `get` 拿到 nil → 匹配不上任何 tag → **显示裸数字 `0`**
    /// （用户 2026-11-06 截图报过来的就是这个）。
    @Test("归一化同时认 string 与 int")
    func normalizationHandlesBothTypes() {
        // 数字（真机上的实际形态）
        #expect(EngineArgsOptions.normalizedValue(.int(0)) == "0")
        #expect(EngineArgsOptions.normalizedValue(.int(3)) == "3")
        // 字符串
        #expect(EngineArgsOptions.normalizedValue(.string("0")) == "0")
        #expect(EngineArgsOptions.normalizedValue(.string("3")) == "3")
        // 其他类型 → nil（调用方回落到默认项）
        #expect(EngineArgsOptions.normalizedValue(.bool(true)) == nil)
        #expect(EngineArgsOptions.normalizedValue(nil) == nil)
    }

    /// 两种形态都能被选项表认出来（否则下拉匹配不上）。
    @Test("两种形态都能匹配选项")
    func bothFormsMatchOptions() throws {
        let opts = try #require(EngineArgsOptions.options(engine: "mkxpz", key: "rgssVersion"))
        #expect(EngineArgsOptions.isKnown(
            EngineArgsOptions.normalizedValue(.int(0)), options: opts))
        #expect(EngineArgsOptions.isKnown(
            EngineArgsOptions.normalizedValue(.string("3")), options: opts))
    }
}
