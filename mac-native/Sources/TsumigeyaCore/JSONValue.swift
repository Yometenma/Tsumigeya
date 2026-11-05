// 任意 JSON 值。
//
// 对应 Electron 版：`Record<string, unknown>` + `src/shared/plain.ts`（toPlain）
//
// ===== 为什么需要它 =====
//
// 三处必须能装「形状不定的 JSON」：
//   ① gameArgs —— 形状由各引擎 manifest 决定（bool / string / number / 多版本名）
//   ② 未知字段 —— 磁盘上有、本版本不认识的键（丢不得，见 GameRecord 文件头）
//   ③ library-meta / play-stats 的旁挂数据（D18 / D51）
//
// Swift 的 `Codable` 要求静态类型，装不下这三种。所以自己写一个枚举。
//
// ⚠️ **数字必须区分 Int 与 Double**：JSON 里 `3` 和 `3.0` 是同义的，
//    但 Swift 侧 `3` 的 Int 和 `3.0` 的 Double 不等。
//    `gameArgs` 里有整型字段（比如 `integerScalingActive`），
//    全部当 Double 会在写回时变成 `3.0` —— 数据看起来没变，但用户的 diff 会变。
//    所以 decode 时**先试 Int，失败才试 Double**。
import Foundation

public enum JSONValue: Sendable, Equatable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])
}

extension JSONValue: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()

        if container.decodeNil() {
            self = .null
            return
        }
        // 顺序有讲究：先 Bool（它的 JSON 表示与数字不重叠），
        // 再 Int（**必须在 Double 之前**，见文件头），最后 Double。
        if let b = try? container.decode(Bool.self) {
            self = .bool(b); return
        }
        if let i = try? container.decode(Int.self) {
            self = .int(i); return
        }
        if let d = try? container.decode(Double.self) {
            self = .double(d); return
        }
        if let s = try? container.decode(String.self) {
            self = .string(s); return
        }
        if let a = try? container.decode([JSONValue].self) {
            self = .array(a); return
        }
        if let o = try? container.decode([String: JSONValue].self) {
            self = .object(o); return
        }
        throw DecodingError.dataCorruptedError(
            in: container, debugDescription: "Unsupported JSON value")
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let b): try container.encode(b)
        case .int(let i): try container.encode(i)
        case .double(let d): try container.encode(d)
        case .string(let s): try container.encode(s)
        case .array(let a): try container.encode(a)
        case .object(let o): try container.encode(o)
        }
    }
}

// MARK: - 便捷读取

extension JSONValue {
    public var boolValue: Bool? {
        if case .bool(let b) = self { return b }
        return nil
    }

    /// 取整数。`3.0` 这种也接受（JSON 里没区别），**但会精确截断**。
    public var intValue: Int? {
        switch self {
        case .int(let i): return i
        case .double(let d): return d == d.rounded() ? Int(d) : nil
        default: return nil
        }
    }

    public var doubleValue: Double? {
        switch self {
        case .double(let d): return d
        case .int(let i): return Double(i)
        default: return nil
        }
    }

    public var stringValue: String? {
        if case .string(let s) = self { return s }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case .array(let a) = self { return a }
        return nil
    }

    public var objectValue: [String: JSONValue]? {
        if case .object(let o) = self { return o }
        return nil
    }

    /// 布尔缺省（**只认显式的 false**）。
    ///
    /// ⚠️ 这是 Electron 版踩出来的取向：`saved.x === false ? false : true`
    /// （`DEFAULT_SETTINGS` 不是全部默认值的来源）。语义是：
    /// 「只有用户明确关掉才算关，没有值 / 读不出来都当开」。
    /// 用在 `languageSwitchPrompt` / `diagnoseBeforeLaunch` 这类开关上。
    public var boolOrDefaultTrue: Bool {
        if case .bool(let b) = self { return b }
        return true
    }
}
