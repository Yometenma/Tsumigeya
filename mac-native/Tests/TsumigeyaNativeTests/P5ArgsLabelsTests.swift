// 引擎参数名翻译测试。
//
// 守的是：**参数名显示英文不会报错**，只是用户看不懂。
// 与 settings-groups 的「搬家漏项」同一取向 —— 只能靠单测。
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
