// 设置页的分组定义（**纯数据 + 纯判据**）。
//
// 对应 Electron 版：`src/shared/settings-groups.ts`（209 行 / 24 条单测）
// 契约：M5.0 S9（U9）
//
// ===== 这个文件要防的错误：某个设置项在搬家时被漏掉 =====
//
// 表现：用户**找不到那个开关了**。而且它**不会报错** ——
// 页面正常渲染、类型检查通过、单测（如果有）也全绿，
// 因为没有任何东西在核对「Settings 的每个键都出现在某个分组里」。
//
// 所以本文件把分组写成**数据**，再用一条判据核对
// 「`settingsKeys` 里的每一个都**恰好**被某个分组列一次」。
// 与 D68 是同一取向（删掉/搬走的东西必须有测试守着）。
import Foundation

public enum SettingsGroups {

    /// 一个设置项的身份（= `Settings` 的字段名）。
    public enum Key: String, CaseIterable, Sendable {
        case appearance
        case language
        case listView
        case deletionConfirmation
        case nonInstalledAutodetect
        case checkModuleUpdatesOnStartup
        case showAdultCovers
        case preferredLanguage
        case fallbackLanguage
        case languageSwitchPrompt
        case diagnoseBeforeLaunch
        case saveSyncMode
    }

    /// 全部设置项的唯一清单。
    ///
    /// ⚠️ 加新的设置字段时**必须**同时把它加进这里、并归到某个分组 ——
    ///    否则 `missingSettings()` 那条测试会红（刻意如此：
    ///    漏掉的表现是「用户找不到开关」，而不是编译错）。
    ///
    /// ⚠️ **不含**只读信息（`dataPath` / `appVersion` / `platform`）：
    ///    它们不是「开关」，搬不进「设置项」的语义，由 `infoKeys` 单独列。
    public static var settingsKeys: [Key] { Key.allCases }

    /// 只读信息项（不是开关，单独一组展示）。
    public enum InfoKey: String, CaseIterable, Sendable {
        case dataPath
        case appVersion
        case platform
    }

    public static var infoKeys: [InfoKey] { InfoKey.allCases }

    /// 分组 id。
    public enum GroupId: String, CaseIterable, Sendable {
        case appearance
        case library
        case language
        case launch
        case data

        /// 分组标题（**中文写在这里**）。
        ///
        /// ⚠️ Electron 版是 `settings.group.<id>` 从 locales 取（它有 i18n 层）。
        ///    Swift 版 P5 只做中文单语言，所以直接写。
        ///    将来加 i18n 时，这几条要搬进 locales —— 别留两份。
        public var title: String {
            switch self {
            case .appearance: return "外观"
            case .library: return "游戏库"
            case .language: return "语言"
            case .launch: return "启动与引擎"
            case .data: return "数据与版本"
            }
        }

        /// 分组说明（一句话讲「这一组管什么」）。
        public var footnote: String {
            switch self {
            case .appearance: return "界面看到的样子"
            case .library: return "游戏库里的日常行为"
            case .language: return "界面语言与多语言版本偏好"
            case .launch: return "与「游戏能不能起来」相关的开关"
            case .data: return "数据目录与版本信息"
            }
        }
    }

    /// 一个分组。
    public struct Group: Sendable {
        public let id: GroupId
        /// 这一组里有哪些设置项（**顺序 = 页面里的显示顺序**）。
        public let keys: [Key]
        /// 默认是否展开。
        ///
        /// ⚠️ 为什么不是全部展开：用户的抱怨是「一条条平铺」——
        ///    12 条全展开就等于没分组。所以只把最常改的展开，其余收起。
        public let defaultOpen: Bool

        public init(id: GroupId, keys: [Key], defaultOpen: Bool) {
            self.id = id
            self.keys = keys
            self.defaultOpen = defaultOpen
        }
    }

    /// 分组定义。
    ///
    /// ===== 分组依据（**用户视角，不是功能上线顺序**）=====
    ///
    /// 用户说「一条条平铺」不好，意味着他想要**按「我想改什么」来归类**：
    ///
    /// ⚠️ `preferredLanguage` / `fallbackLanguage` / `languageSwitchPrompt` 三个都在
    ///    `language` 组：它们是同一件事（多语言版本偏好）的三个参数，
    ///    拆开会让用户在两处找。
    ///
    /// ⚠️ 同理 `diagnoseBeforeLaunch` 与 `nonInstalledAutodetect` 都在 `launch` 组：
    ///    它们都影响「这次启动会不会被拦 / 能不能认出来」。
    public static let groups: [Group] = [
        Group(id: .appearance, keys: [.appearance, .listView], defaultOpen: true),
        Group(id: .library,
              keys: [.deletionConfirmation, .showAdultCovers, .saveSyncMode],
              defaultOpen: true),
        Group(id: .language,
              keys: [.language, .preferredLanguage, .fallbackLanguage, .languageSwitchPrompt],
              defaultOpen: false),
        Group(id: .launch,
              keys: [.nonInstalledAutodetect, .diagnoseBeforeLaunch,
                     .checkModuleUpdatesOnStartup],
              defaultOpen: false),
        // ⚠️ `data` 组**没有设置项** —— 它只放只读信息（数据目录/版本）。
        //    这解释了为什么它总是「空」：`isEmptyGroup` 会返回 true，
        //    但页面上**仍要显示**它（否则用户找不到数据目录在哪）。
        Group(id: .data, keys: [], defaultOpen: true),
    ]

    /// 被分组**漏掉**的设置项（应当恒为空）。
    ///
    /// 这条判据是本文件的全部意义所在：搬家的漏项不会报错，只会让用户找不到开关。
    public static func missingSettings(from groups: [Group] = SettingsGroups.groups) -> [Key] {
        var covered: Set<Key> = []
        for group in groups { covered.formUnion(group.keys) }
        return settingsKeys.filter { !covered.contains($0) }
    }

    /// 被分组**重复列出**的设置项（应当恒为空）。
    ///
    /// ⚠️ 重复的后果比漏掉更隐蔽：同一个开关在两个组里出现两次，
    ///    用户改了一处、另一处看起来没变（其实是同一个值，
    ///    但界面给了他「有两个独立设置」的错觉）。
    public static func duplicatedSettings(from groups: [Group] = SettingsGroups.groups) -> [Key] {
        var counts: [Key: Int] = [:]
        for group in groups {
            for key in group.keys { counts[key, default: 0] += 1 }
        }
        return counts.filter { $0.value > 1 }.map(\.key)
    }

    /// 按 id 找分组。
    public static func group(_ id: GroupId) -> Group? {
        groups.first { $0.id == id }
    }
}

// MARK: - 设置的默认值

/// 设置值的存储形态。
///
/// 用 `[String: JSONValue]` 而不是强类型 struct：设置里有未知键要保留
/// （Electron 版用 `[key: string]: unknown` 兜住，D10 的取向）。
public enum SettingsDefaults {

    /// 布尔项的默认值。
    ///
    /// ⚠️ **主进程/UI 两侧必须一致**。Electron 版有测试逐项对齐
    ///    （`BOOL_DEFAULTS` 是主进程镜像）。
    ///
    /// ⚠️ 而且**不是所有布尔项都在这里**：
    ///    `languageSwitchPrompt` / `diagnoseBeforeLaunch` 用的是
    ///    「`saved.x == false ? false : true`」—— 即「**缺省当开**」，
    ///    因为它们**不在**这个常量里。搞混会让「用户没设过」变成「用户关了」。
    public static let booleans: [SettingsGroups.Key: Bool] = [
        // ⚠️ **默认用列表视图**（P6 改，原为 false = 卡片）。
        //
        // 依据：卡片视图现在**没有封面**（P7 才接 DLsite），是半个空壳；
        // 而列表信息密度更高、游戏名长短差很大时也更好读
        // （用户的游戏名是日文，「～馬蹄通りの小聖女～」那种在卡片里两行截断很难看）。
        //
        // ⚠️ 等 P7 有封面后**重新评估**这个默认值 —— 但改要有实测依据，
        //    不能凭感觉（否则就是又一次「把假设当事实」）。
        .listView: true,
        .deletionConfirmation: true,
        .nonInstalledAutodetect: true,
        .checkModuleUpdatesOnStartup: true,
        .showAdultCovers: true,
    ]

    /// 「缺省当开」的开关（**它们不在 `booleans` 里**）。
    ///
    /// 判据：只有用户**明确设成 false** 才算关。读不出来 / 没有值 → 当开。
    ///
    /// ⚠️ 为什么单独一类：这几个开关的语义是「**默认帮你做一件事**」，
    ///    静默关掉会让用户以为「功能坏了」（而不是「我关过」）。
    public static let defaultOn: [SettingsGroups.Key] = [
        .languageSwitchPrompt,
        .diagnoseBeforeLaunch,
    ]

    /// 读一个布尔设置。
    ///
    /// 判据：显式 false 才算关；其他情况按 `defaultOn` 或 `booleans` 的默认值。
    public static func boolean(
        _ key: SettingsGroups.Key, from settings: [String: JSONValue]
    ) -> Bool {
        if let value = settings[key.rawValue] {
            if case .bool(let b) = value { return b }
        }
        if defaultOn.contains(key) { return true }
        return booleans[key] ?? false
    }

    /// 字符串设置的默认值。
    public static let strings: [SettingsGroups.Key: String] = [
        // 外观：system = 跟随系统（默认）
        .appearance: "system",
        // 界面语言：zh-CN（这个项目是中文界面）
        .language: "zh-CN",
        // 多语言版本偏好：首选中文、次选日文（用户是中文用户、玩日系游戏）
        .preferredLanguage: "zh",
        .fallbackLanguage: "ja",
        // 存档同步：none（不接任何云，D83）
        .saveSyncMode: "none",
    ]

    /// 读一个字符串设置。
    public static func string(
        _ key: SettingsGroups.Key, from settings: [String: JSONValue]
    ) -> String {
        if let value = settings[key.rawValue]?.stringValue, !value.isEmpty {
            return value
        }
        return strings[key] ?? ""
    }
}
