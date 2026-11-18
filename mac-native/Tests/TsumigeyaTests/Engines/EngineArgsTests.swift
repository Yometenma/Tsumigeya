import Foundation
import Testing
@testable import TsumigeyaCore

@Suite("引擎参数名翻译")
struct EngineArgsLabelsTests {

    /// 常见参数都有中文。
    @Test("常见参数有中文")
    func commonArgsTranslated() {
        #expect(EngineArgsLabels.label(
            engine: "mkxpz", key: "fullscreen", manifestLabel: "Start in Fullscreen") == "全屏启动")
        #expect(EngineArgsLabels.label(
            engine: "mkxpz", key: "rgssVersion", manifestLabel: "RGSS Version") == "RGSS 版本")
        #expect(EngineArgsLabels.label(
            engine: "nwjs", key: "version", manifestLabel: nil) == "NW.js 版本")
    }

    /// ⚠️ **翻译优先于 manifest 的英文 label**。
    /// 守的是：顺序反了会让翻过的参数也显示英文。
    @Test("翻译优先于英文 label")
    func translationPrefersOverManifest() {
        let result = EngineArgsLabels.label(
            engine: "mkxpz", key: "vsync", manifestLabel: "VSync")
        #expect(result == "垂直同步")
        #expect(result != "VSync")
    }

    /// 没翻过的参数退回英文 label（不显示空白）。
    @Test("没翻过的退回英文")
    func fallsBackToManifest() {
        #expect(EngineArgsLabels.label(
            engine: "mkxpz", key: "someNewArg", manifestLabel: "Some New Arg")
            == "Some New Arg")
    }

    /// 连 label 都没有时退回键名（**绝不能显示空白**）。
    @Test("最后退回键名")
    func fallsBackToKey() {
        #expect(EngineArgsLabels.label(
            engine: "mkxpz", key: "unknown", manifestLabel: nil) == "unknown")
        // 空白 label 也当没有
        #expect(EngineArgsLabels.label(
            engine: "mkxpz", key: "unknown", manifestLabel: "   ") == "unknown")
    }

    /// ⚠️ **每个「可启动」引擎都有翻译表**。
    ///
    /// 守的是：少一个会让那个引擎的参数全显示英文。
    ///
    /// ⚠️ **只对 `launchable` 的引擎要求** —— 只识别引擎
    ///    （unity / rpgbakin / wolfrpg）**没有 gameArgs**（它们跑不起来，
    ///    所以没有「引擎参数」这个概念）。要求它们也有翻译表是**本鱼的测试写错了**
    ///    （第一次跑就是这 3 个红了）。
    @Test("每个可启动引擎都有翻译表")
    func launchableEnginesCovered() {
        for engine in EngineRegistry.launchable {
            #expect(EngineArgsLabels.table[engine.folder] != nil,
                    "可启动引擎 \(engine.folder) 没有翻译表")
        }
    }

    /// ⚠️ `fullscreen` 是**大多数**引擎都有的参数，翻成「全屏启动」要保持一致。
    ///
    /// ⚠️ **但不是所有引擎都有**：Ren'Py 的参数只有 `savedir` / `command`
    ///    （它的全屏由游戏自己管）。所以**判据是「翻译表里声明了才检查」**
    ///    —— 本鱼第一版假设 9 个引擎都有，Ren'Py 那条就红了。
    @Test("fullscreen 翻译一致")
    func fullscreenConsistent() {
        for engine in EngineRegistry.launchable {
            // 只在**翻译表里声明了 fullscreen** 的引擎上检查
            guard let translated = EngineArgsLabels.table[engine.folder]?["fullscreen"] else {
                continue
            }
            #expect(translated == "全屏启动",
                    "引擎 \(engine.folder) 的 fullscreen 翻成了「\(translated)」，不统一")
        }
    }

    /// 真实 manifest 里的每个参数都该有中文（用真实数据核对）。
    ///
    /// ⚠️ 这条是**最有用的一条**：它直接读用户机器上的真 manifest，
    ///    所以「加了新参数但忘了翻」会当场红 —— 而不是等用户看到英文才发现。
    @Test("真实 manifest 的参数都有中文")
    func realManifestArgsTranslated() throws {
        let dir = DataDir.resolve().path
        // 只核对已装的引擎（没装的读不到 manifest）
        for engine in EngineRegistry.launchable {
            guard let manifest = ManifestStore.load(dataDir: dir, engine: engine.folder) else {
                continue   // 没装 → 跳过
            }
            for (name, def) in manifest.orderedGameArgs {
                let label = EngineArgsLabels.label(
                    engine: engine.folder, key: name, manifestLabel: def.label)
                // 判据：结果是中文（含中日韩统一表意文字）而不是纯英文
                let hasCJK = label.unicodeScalars.contains { scalar in
                    (0x4E00...0x9FFF).contains(scalar.value)
                }
                #expect(hasCJK || label == name,
                        "引擎 \(engine.folder) 的参数 \(name) 显示成「\(label)」，没有中文")
            }
        }
    }
}

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

@Suite("引擎参数取值语义")
struct EngineArgsValueSemanticsTests {

    /// 布尔参数：显式 false 要读成 false（不能因为「缺省当关」就吞掉）。
    @Test("布尔参数显式 false")
    func explicitFalse() {
        let def = GameArgDef(type: "boolean", label: "VSync", defaultValue: .bool(false))
        #expect(EngineArgs.booleanValue(
            for: "vsync", in: ["vsync": .bool(true)], schema: def) == true)
        #expect(EngineArgs.booleanValue(
            for: "vsync", in: ["vsync": .bool(false)], schema: def) == false)
    }

    /// 没有值时用 schema 的 default。
    @Test("没有值时用 default")
    func fallsBackToSchema() {
        let def = GameArgDef(type: "boolean", label: "VSync", defaultValue: .bool(true))
        #expect(EngineArgs.booleanValue(for: "vsync", in: [:], schema: def) == true)

        let defFalse = GameArgDef(type: "boolean", label: "VSync", defaultValue: .bool(false))
        #expect(EngineArgs.booleanValue(for: "vsync", in: [:], schema: defFalse) == false)
    }

    /// 字符串参数读写往返。
    @Test("字符串往返")
    func stringRoundtrip() {
        let def = GameArgDef(type: "string", label: "Window Title", defaultValue: .string(""))
        #expect(EngineArgs.value(
            for: "windowTitle", in: ["windowTitle": .string("自定义")], schema: def)?
            .stringValue == "自定义")
    }

    /// 整数参数读 int 与 string 两种形态。
    @Test("整数读两种形态")
    func intBothForms() {
        let def = GameArgDef(type: "int", label: "W", defaultValue: .int(0))
        #expect(EngineArgs.value(
            for: "defScreenW", in: ["defScreenW": .int(1280)], schema: def)?.intValue == 1280)
        // ⚠️ 字符串形态也要能读（用户可能手改过 JSON）
        #expect(EngineArgs.value(
            for: "defScreenW", in: ["defScreenW": .string("1280")], schema: def)?
            .intValue == 1280)
    }
}
