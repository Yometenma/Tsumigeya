// 编辑页控件绑定的正确性判据。
//
// ===== 本文件守的是「写进去但读不出来」=====
//
// 用户 2026-11-06 报：「垂直同步和全屏启动这开关有问题，点一下之后**确实生效**，
// 但显示的还是未开启，而且**不能关掉**」。
//
// 根因：`Toggle` 的 `get` 写成了 `booleanValue(for: name, in: [:], schema: def)`
//      —— 传了个**空字典**，所以永远读不到用户改的值，只会返回 schema 默认值 false。
//
// 表现拆解（这个链条值得记，因为它解释了「为什么不能关掉」）：
//   1. 用户点 → `set(true)` → gameArgs 里真的写进 `true`（**生效了**）
//   2. 界面重绘 → `get` 读空字典 → 返回 false → **显示还是关的**
//   3. 用户再点（想关掉）→ 界面显示是关的，他以为点了会开 →
//      实际 `set(true)`（因为 Toggle 的语义是「切换当前显示状态」）→
//      **永远开不了也永远关不掉**
//
// ⚠️ 这条判据的**代码层面**无法被单测直接抓到（它藏在 View 里），
//    所以本文件用**源码扫描**：确保 GameEditView 的 boolean binding 不出现空字典。
import Foundation
import Testing

@testable import TsumigeyaCore

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

    /// ⚠️ **`easyrpg` 的 vsync 默认是 true**（真机 manifest 核对过）。
    /// 守的是：不能把所有引擎的布尔默认都当成 false。
    @Test("不同引擎的布尔默认不同")
    func perEngineDefaults() {
        // easyrpg 的 vsync 默认 true
        let def = GameArgDef(type: "boolean", label: "VSync", defaultValue: .bool(true))
        #expect(EngineArgs.booleanValue(for: "vsync", in: [:], schema: def) == true)
        // mkxpz 的 vsync 默认 false
        let def2 = GameArgDef(type: "boolean", label: "VSync", defaultValue: .bool(false))
        #expect(EngineArgs.booleanValue(for: "vsync", in: [:], schema: def2) == false)
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

// MARK: - 源码级判据

@Suite("编辑页绑定源码检查")
struct EditViewBindingSourceTests {

    /// 读 `GameEditView.swift` 的源码。
    ///
    /// ⚠️ 路径相对于**这个测试文件自己**（`#filePath`），不依赖 cwd ——
    ///    `swift test` 与 Xcode 两种运行方式的 cwd 不同，用相对路径会找不到。
    func editViewSource() -> String? {
        let thisFile = URL(fileURLWithPath: #filePath)
        let packageRoot = thisFile
            .deletingLastPathComponent()   // TsumigeyaNativeTests/
            .deletingLastPathComponent()   // Tests/
            .deletingLastPathComponent()   // mac-native/
        let target = packageRoot
            .appendingPathComponent("Sources/TsumigeyaApp/GameEditView.swift")
        return try? String(contentsOf: target, encoding: .utf8)
    }

    /// ⚠️⚠️ **源码里不许出现「传空字典读引擎参数值」**。
    ///
    /// 守的是用户 2026-11-06 报的那个 bug：
    /// `EngineArgs.booleanValue(for: name, in: [:], schema: def)` ——
    /// 传空字典 → `get` 永远读不到用户改的值 → 开关**点了不显示、且关不掉**。
    ///
    /// ⚠️ 为什么用源码扫描而不是单测：这个错误**在纯函数层是合法的**
    ///    （`booleanValue(in: [:])` 是个正常调用，只是调用方传错了数据），
    ///    所以只有扫源码才能抓到。
    @Test("不许传空字典读参数值")
    func noEmptyDictReads() throws {
        let source = try #require(editViewSource(), "读不到 GameEditView.swift")
        // ⚠️ **必须逐行扫，且跳过注释行** ——
        //    本鱼第一版扫全文，结果命中了**解释这个 bug 的注释本身**
        //    （注释里写了 `in: [:], schema: def` 这个错误写法）。
        //    判据要盯的是**可执行代码**，不是注释。
        let codeLines = source.split(separator: "\n").filter { line in
            let t = line.trimmingCharacters(in: .whitespaces)
            return !t.hasPrefix("//") && !t.hasPrefix("///") && !t.hasPrefix("*")
        }
        let offenders = codeLines.filter { $0.contains("in: [:], schema:") }
        #expect(offenders.isEmpty,
                "代码里出现了「传空字典读参数值」（会让控件显示与真实值脱节）")
    }

    /// ⚠️ **`EngineArgs.control` 必须传 engine 与 key**。
    ///
    /// 守的是：不传的话内置选项表（`rgssVersion` 的下拉）**不生效**，
    /// 会静默回落成文本框 —— 用户看到的是一个能手打数字的框。
    @Test("control 必须传 engine 与 key")
    func controlPassesEngineAndKey() throws {
        let source = try #require(editViewSource(), "读不到 GameEditView.swift")
        let ok = source.contains("engine: engine, key: name")
        #expect(ok, "EngineArgs.control 调用没有传 engine/key —— 内置选项表不会生效")
    }
}
