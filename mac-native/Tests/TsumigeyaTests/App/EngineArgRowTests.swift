import SwiftUI
import Testing
@testable import TsumigeyaApp
@testable import TsumigeyaCore

@Suite("编辑页参数控件")
@MainActor
struct EngineArgRowTests {
    private final class Draft {
        var value: JSONValue?
    }

    @Test("开关从草稿读取，写回后立即可读，清空才回落默认值")
    func booleanBindingRoundTrips() {
        for defaultValue in [false, true] {
            let draft = Draft()
            let row = EngineArgRow(
                name: "vsync",
                def: GameArgDef(type: "boolean", defaultValue: .bool(defaultValue)),
                engine: "mkxpz",
                value: Binding(get: { draft.value }, set: { draft.value = $0 }),
                availableVersions: [])
            #expect(row.control == .boolean)
            let binding = row.booleanBinding
            #expect(binding.wrappedValue == defaultValue)
            for selected in [!defaultValue, defaultValue] {
                binding.wrappedValue = selected
                #expect(draft.value == .bool(selected))
                #expect(binding.wrappedValue == selected)
            }
            // 外部更新也必须反映在现有控件绑定上。
            draft.value = .bool(!defaultValue)
            #expect(binding.wrappedValue == !defaultValue)
            draft.value = nil
            #expect(binding.wrappedValue == defaultValue)
        }
    }

    @Test("实际行控件使用引擎专用选项和可用版本，而非退回普通文本框")
    func controlsUseEngineAndVersionContext() {
        let row = EngineArgRow(
            name: "rgssVersion", def: GameArgDef(type: "text"), engine: "mkxpz",
            value: .constant(nil), availableVersions: [])
        #expect(row.control == .dropdown(["0", "1", "2", "3"]))
        let versions = ["v0.106.1", "v0.107.0"]
        let versionRow = EngineArgRow(
            name: "version", def: GameArgDef(type: "multi-version"), engine: "nwjs",
            value: .constant(nil), availableVersions: versions)
        #expect(versionRow.control == .multiVersion(versions))
    }
}
