import Foundation

/// 界面语言：跟随系统 / 简体中文 / English / 日本語。
///
/// 存进 `global-settings.json` 的 `language` 字段（历史默认值是 `zh-CN`，仍然认）。
/// **简体中文是源语言**：`en` / `ja` 的文案放在各自 `.lproj` 里，中文直接返回 key 本身。
public enum InterfaceLanguage: String, CaseIterable, Sendable {
    case system
    case simplifiedChinese
    case english
    case japanese

    /// 写入设置文件的值。
    public var settingValue: String {
        switch self {
        case .system: return "system"
        case .simplifiedChinese: return "zh-CN"
        case .english: return "en"
        case .japanese: return "ja"
        }
    }

    /// 读设置：认不出的值（含历史 `zh-CN`）按“跟随系统”处理，不悄悄改成别的语言。
    public static func fromSetting(_ raw: String?) -> InterfaceLanguage {
        switch raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "system", "", nil: return .system
        case "zh", "zh-cn", "zh-hans", "zh-hans-cn": return .simplifiedChinese
        case "en", "en-us", "en-gb": return .english
        case "ja", "ja-jp", "jp": return .japanese
        default: return .system
        }
    }

    /// 实际生效的语言。`system` 时按系统偏好列表顺序取第一个能对应的，都不匹配回落英文。
    ///
    /// 用 `Locale.preferredLanguages` 而不是 `Locale.current`：前者保留了用户的语言优先级
    /// （例如「法语优先、日语次选」的访客应该看到日文，而不是英文）。
    public var resolved: InterfaceLanguage {
        guard self == .system else { return self }
        for tag in Locale.preferredLanguages {
            let low = tag.lowercased()
            if low.hasPrefix("zh") { return .simplifiedChinese }
            if low.hasPrefix("ja") { return .japanese }
            if low.hasPrefix("en") { return .english }
        }
        return .english
    }

    /// 需要读的语言表；`nil` 表示中文（源语言，直接用 key）。
    public var localizationCode: String? {
        switch resolved {
        case .system, .simplifiedChinese: return nil
        case .english: return "en"
        case .japanese: return "ja"
        }
    }

    /// 给 SwiftUI `.environment(\.locale, …)` 用的 locale：数字、日期和 `Text` 的取表都靠它。
    public var locale: Locale {
        switch resolved {
        case .system: return .autoupdatingCurrent
        case .simplifiedChinese: return Locale(identifier: "zh-Hans")
        case .english: return Locale(identifier: "en")
        case .japanese: return Locale(identifier: "ja")
        }
    }
}

/// 当前界面语言的共享状态。
///
/// ⚠️ Core 里的文案可能在后台线程生成（诊断、安装、翻译任务），所以这里用锁而不是
///    `@MainActor`：读表只是查字典，不需要上主线程。
public final class InterfaceLanguageStore: @unchecked Sendable {
    public static let shared = InterfaceLanguageStore()

    private let lock = NSLock()
    private var stored: InterfaceLanguage = .system

    public init() {}

    public var language: InterfaceLanguage {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }

    /// 实际生效的语言（已解析过 system）。
    public var resolved: InterfaceLanguage { language.resolved }
}

public enum L10n {
    /// 在指定语言下取一条文案；中文是源语言，直接返回 key。
    public static func string(_ key: String, language: InterfaceLanguage, bundle: Bundle) -> String {
        guard let code = language.localizationCode,
              let path = bundle.path(forResource: code, ofType: "lproj"),
              let table = Bundle(path: path)
        else { return key }
        return table.localizedString(forKey: key, value: key, table: nil)
    }

    /// 用当前界面语言取 Core 自己的文案。
    public static func string(_ key: String) -> String {
        string(key, language: InterfaceLanguageStore.shared.language, bundle: .module)
    }

    /// 指定语言取 Core 文案（测试和 CLI 用；`.module` 在这里才是 Core 的资源包）。
    public static func coreString(_ key: String, language: InterfaceLanguage) -> String {
        string(key, language: language, bundle: .module)
    }

    /// 占位符版本：`%@` 给对象，`%lld` 给整数。中文是源，英文/日文按表替换。
    public static func format(_ key: String, _ args: any CVarArg...) -> String {
        let template = string(key)
        return String(format: template, locale: InterfaceLanguageStore.shared.resolved.locale, arguments: args)
    }
}
