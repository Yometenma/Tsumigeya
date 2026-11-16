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
