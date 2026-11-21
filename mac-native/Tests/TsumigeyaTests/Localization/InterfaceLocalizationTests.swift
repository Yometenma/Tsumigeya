// 界面语言与取表判据。
//
// 这一组守的是「改了语言却还是中文」这类**不报错**的失败：
// 表和解析任何一环错位，界面只会安静地停在中文原文上。
import Foundation
import Testing
@testable import TsumigeyaCore

@Suite("界面语言")
struct InterfaceLocalizationTests {

    @Test("设置值解析：认不出的值回落跟随系统")
    func parseSetting() {
        #expect(InterfaceLanguage.fromSetting(nil) == .system)
        #expect(InterfaceLanguage.fromSetting("") == .system)
        #expect(InterfaceLanguage.fromSetting("system") == .system)
        #expect(InterfaceLanguage.fromSetting("zh-CN") == .simplifiedChinese)
        #expect(InterfaceLanguage.fromSetting("en") == .english)
        #expect(InterfaceLanguage.fromSetting("ja") == .japanese)
        #expect(InterfaceLanguage.fromSetting("fr") == .system)
    }

    @Test("设置值往返不丢信息")
    func settingRoundTrip() {
        for language in InterfaceLanguage.allCases {
            #expect(InterfaceLanguage.fromSetting(language.settingValue) == language)
        }
    }

    @Test("固定语言不再看系统 locale")
    func fixedLanguageIgnoresSystem() {
        #expect(InterfaceLanguage.english.resolved == .english)
        #expect(InterfaceLanguage.japanese.resolved == .japanese)
        #expect(InterfaceLanguage.simplifiedChinese.resolved == .simplifiedChinese)
    }

    @Test("中文是源语言：不需要表，取到的就是 key 本身")
    func chineseFallsBackToKey() {
        let key = "游戏库"
        #expect(L10n.coreString(key, language: .simplifiedChinese) == key)
        #expect(InterfaceLanguage.simplifiedChinese.localizationCode == nil)
    }

    @Test("英文与日文表能取到词条，且不等于中文原文")
    func translatedTablesResolve() {
        let key = "游戏库"
        let en = L10n.coreString(key, language: .english)
        let ja = L10n.coreString(key, language: .japanese)
        #expect(en != key)
        #expect(ja != key)
        #expect(en == "Game Library")
        #expect(ja == "ゲームライブラリ")
    }

    @Test("表里没有的词条回落原文，而不是空串")
    func missingKeyFallsBack() {
        let missing = "这条文案不存在于任何表里"
        #expect(L10n.coreString(missing, language: .english) == missing)
    }

    @Test("共享状态切换后，Core 取表跟着变")
    func sharedStoreDrivesLookup() {
        let store = InterfaceLanguageStore.shared
        let original = store.language
        defer { store.language = original }

        store.language = .english
        #expect(L10n.string("游戏库") == "Game Library")
        store.language = .japanese
        #expect(L10n.string("游戏库") == "ゲームライブラリ")
        store.language = .simplifiedChinese
        #expect(L10n.string("游戏库") == "游戏库")
    }

    @Test("占位符版本不吞掉参数")
    func formatKeepsArguments() {
        let store = InterfaceLanguageStore.shared
        let original = store.language
        defer { store.language = original }

        // 表里没有这条时回落中文原文，占位符仍要正确替换。
        store.language = .english
        #expect(L10n.format("共 %lld 项", 3) == "共 3 项")
    }
}
