import Testing
@testable import TsumigeyaApp
@testable import TsumigeyaCore

@Suite("设置界面可用性")
@MainActor
struct SettingsPresentationTests {
    @Test("常用设置可操作，未实现的选项不伪装成可用")
    func availableSettingsMatchWorkingFeatures() {
        let available = Set(SettingsGroups.Key.allCases.filter { SettingRow(key: $0).isAvailable })
        #expect(available == Set([.appearance, .listView, .deletionConfirmation, .saveSyncMode, .privacyMode, .privacyHideTitles]))
    }
}
