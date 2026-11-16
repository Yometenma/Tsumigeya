import Foundation

/// 只改变呈现，不改写游戏名称、元数据或搜索条件。
public struct LibraryPrivacy: Equatable, Sendable {
    public let isEnabled: Bool
    public let hidesTitles: Bool

    public init(settings: [String: JSONValue]) {
        isEnabled = SettingsDefaults.boolean(.privacyMode, from: settings)
        hidesTitles = isEnabled && SettingsDefaults.boolean(.privacyHideTitles, from: settings)
    }

    public func title(for game: GameRecord) -> String {
        hidesTitles ? "游戏 \(game.id)" : game.gameTitle
    }

    public func text(_ value: String, replacement: String = "已隐藏") -> String {
        hidesTitles ? replacement : value
    }

    public func coverURL(_ value: String?) -> URL? {
        guard !isEnabled, let normalized = DLsiteParser.normalizeCoverUrl(value) else { return nil }
        return URL(string: normalized)
    }
}
