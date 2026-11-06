// 设置页分组判据测试。
//
// 对应 Electron 版：`test/settings-groups.test.ts`（24 条）
//
// ===== 本文件守的是「搬家的漏项」=====
//
// 某个设置项被漏掉时**不会报错** —— 页面正常渲染、类型检查通过、
// 用户只是「找不到那个开关了」，而且他不会意识到「本来应该有一个」。
// 所以只能靠这条判据：每个 Key 都**恰好**被某个分组列一次。
import Foundation
import Testing

@testable import TsumigeyaCore

// MARK: - 分组完整性

@Suite("设置分组完整性")
struct SettingsGroupsIntegrityTests {

    /// ⚠️ **本文件最重要的一条**：每个设置项都恰好被某个分组列一次。
    ///
    /// 守的是：搬家时漏一项 → 用户找不到那个开关，而且**没有任何东西会报错**。
    @Test("没有漏掉的设置项")
    func noMissing() {
        let missing = SettingsGroups.missingSettings()
        #expect(missing.isEmpty, "这些设置项没有被任何分组列：\(missing.map(\.rawValue))")
    }

    /// 也没有重复列出的（重复比漏掉更隐蔽）。
    @Test("没有重复的设置项")
    func noDuplicates() {
        let dup = SettingsGroups.duplicatedSettings()
        #expect(dup.isEmpty, "这些设置项被多个分组重复列：\(dup.map(\.rawValue))")
    }

    /// 分组数量与 id 都对（5 组）。
    @Test("5 个分组")
    func groupCount() {
        #expect(SettingsGroups.groups.count == 5)
        #expect(Set(SettingsGroups.groups.map(\.id)).count == 5, "id 不能重复")
    }

    /// 每个分组都有标题与说明（否则界面上是个没名字的盒子）。
    @Test("每个分组都有标题与说明")
    func groupsHaveTitles() {
        for group in SettingsGroups.groups {
            #expect(!group.id.title.isEmpty)
            #expect(!group.id.footnote.isEmpty)
        }
    }
}

// MARK: - 分组的语义归类

@Suite("分组归类")
struct SettingsGroupSemanticsTests {

    /// ⚠️ 三个语言偏好**必须在同一组**。
    /// 守的是：拆开会让用户在两处找同一件事的三个参数。
    @Test("语言偏好的三个参数同组")
    func languagePrefsTogether() {
        let keys = SettingsGroups.group(.language)?.keys ?? []
        #expect(keys.contains(.preferredLanguage))
        #expect(keys.contains(.fallbackLanguage))
        #expect(keys.contains(.languageSwitchPrompt))
        #expect(keys.contains(.language))
    }

    /// ⚠️ 两个「影响这次启动」的开关同组。
    @Test("启动相关开关同组")
    func launchKeysTogether() {
        let keys = SettingsGroups.group(.launch)?.keys ?? []
        #expect(keys.contains(.nonInstalledAutodetect))
        #expect(keys.contains(.diagnoseBeforeLaunch))
        #expect(keys.contains(.checkModuleUpdatesOnStartup))
    }

    /// ⚠️ **`data` 组没有设置项**（只放只读信息）。
    ///
    /// 这条是**刻意的空**，不是漏项 —— 它解释为什么 `missingSettings()` 里
    /// 不该出现 data 组的成员（它本来就没有）。
    @Test("data 组只放只读信息")
    func dataGroupIsInfoOnly() {
        #expect(SettingsGroups.group(.data)?.keys.isEmpty == true)
        // 但它必须存在（否则用户找不到数据目录在哪）
        #expect(SettingsGroups.group(.data) != nil)
    }

    /// 外观组里有主题与列表视图。
    @Test("外观组")
    func appearanceGroup() {
        let keys = SettingsGroups.group(.appearance)?.keys ?? []
        #expect(keys.contains(.appearance))
        #expect(keys.contains(.listView))
    }

    /// 游戏库组里有删确认 / R18 封面 / 存档同步。
    @Test("游戏库组")
    func libraryGroup() {
        let keys = SettingsGroups.group(.library)?.keys ?? []
        #expect(keys.contains(.deletionConfirmation))
        #expect(keys.contains(.showAdultCovers))
        #expect(keys.contains(.saveSyncMode))
    }
}

// MARK: - 默认值

@Suite("设置默认值")
struct SettingsDefaultsTests {

    /// ⚠️ **「缺省当开」的那两个开关不在 `booleans` 里**。
    ///
    /// 守的是：搞混会让「用户没设过」变成「用户关了」——
    /// 表现是「功能莫名其妙不工作了」，而用户会以为是自己弄的。
    @Test("缺省当开的开关不在 booleans 里")
    func defaultOnNotInBooleans() {
        for key in SettingsDefaults.defaultOn {
            #expect(SettingsDefaults.booleans[key] == nil,
                    "\(key.rawValue) 不该同时在 booleans 里")
        }
    }

    /// 缺省当开的：读不出来 → true；显式 false → false。
    @Test("缺省当开")
    func defaultOnSemantics() {
        let empty: [String: JSONValue] = [:]
        #expect(SettingsDefaults.boolean(.diagnoseBeforeLaunch, from: empty) == true)
        #expect(SettingsDefaults.boolean(.languageSwitchPrompt, from: empty) == true)

        let off: [String: JSONValue] = ["languageSwitchPrompt": .bool(false)]
        #expect(SettingsDefaults.boolean(.languageSwitchPrompt, from: off) == false)

        // ⚠️ **读不出类型时也当开**（不能当关）
        let garbage: [String: JSONValue] = ["languageSwitchPrompt": .string("x")]
        #expect(SettingsDefaults.boolean(.languageSwitchPrompt, from: garbage) == true)
    }

    /// 普通布尔项：缺省按 `booleans` 表。
    @Test("普通布尔项默认值")
    func regularBooleanDefaults() {
        let empty: [String: JSONValue] = [:]
        #expect(SettingsDefaults.boolean(.deletionConfirmation, from: empty) == true)
        // ⚠️ `listView` 的默认值在 P6 从 false 改成了 true
        //    （理由：卡片视图现在没封面，是半个空壳 —— 见 P5SettingsAtStartupTests）
        #expect(SettingsDefaults.boolean(.listView, from: empty) == true)
        #expect(SettingsDefaults.boolean(.nonInstalledAutodetect, from: empty) == true)

        // 显式设了就听用户的
        let off: [String: JSONValue] = ["listView": .bool(false)]
        #expect(SettingsDefaults.boolean(.listView, from: off) == false)
    }

    /// 字符串默认值。
    @Test("字符串默认值")
    func stringDefaults() {
        let empty: [String: JSONValue] = [:]
        #expect(SettingsDefaults.string(.appearance, from: empty) == "system")
        #expect(SettingsDefaults.string(.language, from: empty) == "zh-CN")
        #expect(SettingsDefaults.string(.preferredLanguage, from: empty) == "zh")
        #expect(SettingsDefaults.string(.fallbackLanguage, from: empty) == "ja")
        // ⚠️ 存档同步默认 none（**不接任何云**，D83）
        #expect(SettingsDefaults.string(.saveSyncMode, from: empty) == "none")
    }

    /// 空字符串**不能**当有效值（会回落到默认）。
    @Test("空字符串回落默认值")
    func emptyStringFallsBack() {
        let blank: [String: JSONValue] = ["appearance": .string("")]
        #expect(SettingsDefaults.string(.appearance, from: blank) == "system")
    }
}
