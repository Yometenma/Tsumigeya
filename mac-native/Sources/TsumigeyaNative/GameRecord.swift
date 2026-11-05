// 游戏记录模型。
//
// 对应 Electron 版：src/main/games-store.ts 的 GameRecord / GameMap
// 契约：docs/M1-实施方案.md §3.2、D10（**与上游 schema 兼容**）
//
// ===== 关键约束：schema 必须与上游一致（D10）=====
//
// `games.json` 的磁盘形态是 `{ "<id>": { gameTitle, gamePath, gameEngine, ... } }`
// —— **id 是 map 的键，不在记录内部**。这个形状必须原样保留，因为：
//   · 用户的旧数据就是长这样，改了就读不出来
//   · Electron 版还在跑（fallback），两边要能互相读写
//
// ⚠️ **未知字段必须保留**：Electron 版统一用 `[key: string]: unknown` 兜住。
//    Swift 这边 decoder 默认忽略未知字段 = **会丢数据**。
//    所以这里用手写的 `decode` 把原始字典也存下来，写回时合并回去。
//    （Electron 版里这一条是关于 Settings 的，GameRecord 也一样要守）
import Foundation

/// 一条游戏记录。
///
/// ⚠️ 故意**不用 Codable 自动合成**：要保留未知字段（见文件头）。
public struct GameRecord: Sendable, Equatable {
    public var id: String
    public var gameTitle: String
    public var gamePath: String
    public var gameEngine: String
    public var iconPath: String?
    public var tags: [String]?
    /// 引擎参数。用 `JSONValue` 因为它的形状由各引擎的 manifest 决定，
    /// 不是固定结构（D61 精简后仍有 bool / string / number / 多版本选择）。
    public var gameArgs: [String: JSONValue]?

    /// 磁盘上出现过、但本版本不认识的字段。**写回时必须带回去。**
    public var unknownFields: [String: JSONValue]

    public init(
        id: String,
        gameTitle: String,
        gamePath: String,
        gameEngine: String,
        iconPath: String? = nil,
        tags: [String]? = nil,
        gameArgs: [String: JSONValue]? = nil,
        unknownFields: [String: JSONValue] = [:]
    ) {
        self.id = id
        self.gameTitle = gameTitle
        self.gamePath = gamePath
        self.gameEngine = gameEngine
        self.iconPath = iconPath
        self.tags = tags
        self.gameArgs = gameArgs
        self.unknownFields = unknownFields
    }
}

/// `games.json` 的磁盘形态：键是 id，值是不含 id 的记录（D10）。
public struct GameMap: Sendable, Equatable {
    public var games: [String: GameRecord]

    public init(games: [String: GameRecord] = [:]) {
        self.games = games
    }

    /// 按 id 数值排序后的列表（库页显示顺序）。
    ///
    /// ⚠️ 按**数值**排序而不是字符串：id 是 `"1"` `"2"` `"10"` 这种，
    /// 字符串排序会把 10 排在 2 前面 —— Electron 版 id 是数字递增的，这里必须一致。
    public var ordered: [GameRecord] {
        games.values.sorted { a, b in
            let na = Int(a.id) ?? Int.max
            let nb = Int(b.id) ?? Int.max
            if na != nb { return na < nb }
            return a.id < b.id
        }
    }
}

// MARK: - Codable（手写，带未知字段保留）

extension GameRecord: Codable {
    private enum KnownKeys: String, CaseIterable {
        case gameTitle, gamePath, gameEngine, iconPath, tags, gameArgs
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: AnyCodingKey.self)

        // 必填字段：缺失就是真的坏了（不是「未知字段」那种兼容问题）
        self.gameTitle = try container.decode(String.self, forKey: AnyCodingKey("gameTitle"))
        self.gamePath = try container.decode(String.self, forKey: AnyCodingKey("gamePath"))
        self.gameEngine = try container.decode(String.self, forKey: AnyCodingKey("gameEngine"))
        self.iconPath = try container.decodeIfPresent(String.self, forKey: AnyCodingKey("iconPath"))
        self.tags = try container.decodeIfPresent([String].self, forKey: AnyCodingKey("tags"))
        self.gameArgs = try container.decodeIfPresent(
            [String: JSONValue].self, forKey: AnyCodingKey("gameArgs"))

        // id 由外层 map 的键给出；单条解码时为空，由 GameMap 填。
        self.id = ""

        // 兜住未知字段
        var unknown: [String: JSONValue] = [:]
        let known = Set(KnownKeys.allCases.map(\.rawValue))
        for key in container.allKeys where !known.contains(key.stringValue) {
            if let value = try? container.decode(JSONValue.self, forKey: key) {
                unknown[key.stringValue] = value
            }
        }
        self.unknownFields = unknown
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: AnyCodingKey.self)
        try container.encode(gameTitle, forKey: AnyCodingKey("gameTitle"))
        try container.encode(gamePath, forKey: AnyCodingKey("gamePath"))
        try container.encode(gameEngine, forKey: AnyCodingKey("gameEngine"))
        try container.encodeIfPresent(iconPath, forKey: AnyCodingKey("iconPath"))
        try container.encodeIfPresent(tags, forKey: AnyCodingKey("tags"))
        try container.encodeIfPresent(gameArgs, forKey: AnyCodingKey("gameArgs"))

        // 未知字段原样写回（omit 掉已知键，防重复）
        let known = Set(KnownKeys.allCases.map(\.rawValue))
        for (key, value) in unknownFields where !known.contains(key) {
            try container.encode(value, forKey: AnyCodingKey(key))
        }
    }
}

extension GameMap: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: AnyCodingKey.self)
        var games: [String: GameRecord] = [:]
        for key in container.allKeys {
            var record = try container.decode(GameRecord.self, forKey: key)
            record.id = key.stringValue    // id 来自 map 的键（D10）
            games[key.stringValue] = record
        }
        self.games = games
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: AnyCodingKey.self)
        for (id, record) in games {
            try container.encode(record, forKey: AnyCodingKey(id))
        }
    }
}

// MARK: - 动态 CodingKey

/// 任意字符串键。Codable 的 keyed container 需要具体类型，这个是通用兜底。
public struct AnyCodingKey: CodingKey, Hashable, Sendable {
    public let stringValue: String
    public let intValue: Int?

    public init(_ string: String) {
        self.stringValue = string
        self.intValue = nil
    }

    public init?(stringValue: String) {
        self.init(stringValue)
    }

    public init?(intValue: Int) {
        self.stringValue = String(intValue)
        self.intValue = intValue
    }
}
