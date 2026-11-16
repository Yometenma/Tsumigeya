import Testing
@testable import TsumigeyaApp
@testable import TsumigeyaCore

@Suite("设置界面可用性")
@MainActor
struct SettingsPresentationTests {
    @Test("常用设置可操作，未实现的选项不伪装成可用")
    func availableSettingsMatchWorkingFeatures() {
        let available = Set(SettingsGroups.Key.allCases.filter { SettingRow(key: $0).isAvailable })
        #expect(available == Set([.appearance, .listView, .deletionConfirmation, .saveSyncMode]))
    }

    @Test("分组后所有设置恰好保留一次，不因收起未实现项而漏项")
    func groupedOptionsRemainComplete() {
        let visible = SettingsGroups.groups.flatMap { group in
            group.keys.filter { SettingRow(key: $0).isAvailable }
        }
        let disclosed = SettingsGroups.groups.flatMap { group in
            group.keys.filter { !SettingRow(key: $0).isAvailable }
        }
        #expect(Set(visible).isDisjoint(with: Set(disclosed)))
        #expect(Set(visible + disclosed) == Set(SettingsGroups.Key.allCases))
        #expect(visible.count + disclosed.count == SettingsGroups.Key.allCases.count)
        #expect(!disclosed.isEmpty)
        #expect(!visible.isEmpty)
    }
}
