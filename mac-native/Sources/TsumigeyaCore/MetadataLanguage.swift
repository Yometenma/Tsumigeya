import Foundation

public enum MetadataLanguage: String, CaseIterable, Sendable, Codable {
    case simplifiedChinese = "zh_CN", traditionalChinese = "zh_TW", japanese = "ja_JP", english = "en_US", korean = "ko_KR"
    public var name: String {
        switch self {
        case .simplifiedChinese: "简体中文"
        case .traditionalChinese: "繁体中文"
        case .japanese: "日文"
        case .english: "英文"
        case .korean: "韩文"
        }
    }
    public var httpLanguage: String { rawValue.replacingOccurrences(of: "_", with: "-") }
    public static func detect(_ html: String) -> MetadataLanguage? {
        guard let re = try? NSRegularExpression(pattern: #"(?i)<html\b[^>]*\blang\s*=\s*["']([^"']+)["']"#),
              let m = re.firstMatch(in: html, range: NSRange(html.startIndex..., in: html)),
              let r = Range(m.range(at: 1), in: html) else { return nil }
        let code = html[r].lowercased().replacingOccurrences(of: "_", with: "-")
        return allCases.first { $0.httpLanguage.lowercased() == code }
            ?? ["ja": .japanese, "en": .english, "ko": .korean, "zh-hans": .simplifiedChinese, "zh-hant": .traditionalChinese][code]
    }
}

public struct MetadataLanguagePreference: Sendable, Equatable {
    public var preferred: MetadataLanguage
    public var fallback: MetadataLanguage?
    public init(preferred: MetadataLanguage = .simplifiedChinese, fallback: MetadataLanguage? = .japanese) {
        self.preferred = preferred; self.fallback = fallback
    }
}
