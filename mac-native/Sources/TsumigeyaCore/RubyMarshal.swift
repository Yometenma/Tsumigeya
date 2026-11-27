// Ruby Marshal（`.rvdata2` / `.rxdata`）：RPG Maker XP / VX / VX Ace 的存档格式。
//
// ===== 为什么是「扫描定位 + 原位替换」而不是「解析成树再写回」 =====
//
// Ruby Marshal 用**对象表**表达共享引用：同一个 Actor 对象在存档里只出现一次，
// 后面都是 `@n` 引用。如果解析成树再重新序列化，要么把共享对象展开成多份
// （读档后同一个角色变成两个，数据不一致），要么得实现一套身份追踪。
//
// 所以这里只做两件事：
//   1. `scan` 走一遍字节流，记下每个标量值**在文件里的字节区间**和它的路径
//   2. `patch` 只替换命中的那几个区间，其余字节（含所有 `@n` 引用）一位不动
//
// 这样改存档不会碰坏结构，代价是只能改标量（数字、布尔、字符串），不能插删对象。
//
// ⚠️ **未在真实作品上验收**：这台机器上没有 XP/VX/Ace 的作品样本，
//    只能保证「按规范生成的字节扫描正确、替换后其余字节不变」。真机验收需要真实的
//    `Save01.rvdata2`。
import Foundation

public indirect enum MarshalValue: Equatable, Sendable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(text: String, raw: Data)
    case symbol(String)
    case array([MarshalValue])
    case hash([MarshalEntry])
    case object(className: String, ivars: [MarshalEntry])
    case userDefined(className: String, data: Data)
    case classRef(String)
    case moduleRef(String)
    case userMarshal(className: String, value: MarshalValue)
}

public struct MarshalEntry: Equatable, Sendable {
    public let key: MarshalValue
    public let value: MarshalValue
    public init(_ key: MarshalValue, _ value: MarshalValue) {
        self.key = key; self.value = value
    }
}

/// 存档里一处可改的标量：路径 + 它在原始字节里的区间（含类型标记）。
public struct MarshalField: Sendable, Equatable {
    public let path: [String]
    public let value: MarshalValue
    /// 值编码（类型标记 + 内容）在文件中的位置。
    public let range: Range<Int>
    public var displayPath: String { path.joined(separator: ".") }
}

public enum MarshalError: LocalizedError, Sendable {
    case invalid(String)
    public var errorDescription: String? { if case .invalid(let message) = self { return message }; return nil }
}

public enum RubyMarshal {
    static let header: [UInt8] = [0x04, 0x08]

    // MARK: - 扫描

    public static func scan(_ data: Data) throws -> (root: MarshalValue, fields: [MarshalField]) {
        var reader = Reader(bytes: Array(data))
        guard reader.readBytes(2) == header else {
            throw MarshalError.invalid(L10n.string("不是 Ruby Marshal 4.8 存档。"))
        }
        let root = try reader.readValue(path: [])
        return (root, reader.fields)
    }

    public static func parse(_ data: Data) throws -> MarshalValue {
        try scan(data).root
    }

    struct Reader {
        let bytes: [UInt8]
        var offset = 0
        var objects: [MarshalValue] = []
        var symbols: [String] = []
        var fields: [MarshalField] = []

        init(bytes: [UInt8]) { self.bytes = bytes }

        mutating func readByte() throws -> UInt8 {
            guard offset < bytes.count else { throw MarshalError.invalid(L10n.string("存档在某处提前结束。")) }
            defer { offset += 1 }
            return bytes[offset]
        }
        mutating func readBytes(_ count: Int) -> [UInt8] {
            guard count >= 0, offset + count <= bytes.count else { return [] }
            defer { offset += count }
            return Array(bytes[offset..<(offset + count)])
        }
        mutating func readLong() throws -> Int {
            let raw = Int8(bitPattern: try readByte())
            if raw == 0 { return 0 }
            if raw > 4 { return Int(raw) - 5 }
            if raw < -4 { return Int(raw) + 5 }
            let count = abs(Int(raw))
            var value = 0
            for index in 0..<count { value |= Int(try readByte()) << (8 * index) }
            if raw < 0 {
                let shift = 64 - 8 * count
                value = (value << shift) >> shift
            }
            return value
        }
        mutating func readSymbolName() throws -> String {
            let length = try readLong()
            guard length >= 0, length <= bytes.count else { throw MarshalError.invalid(L10n.string("符号长度非法。")) }
            return decode(readBytes(length))
        }
        /// 读一个「以标记开头的符号」：类名、ivar 名、扩展名都走这里。
        /// ⚠️ 不能直接调 `readSymbolName` —— 那条路径假定 `:` 已经被消费掉了。
        mutating func readSymbolEntry() throws -> String {
            let tag = try readByte()
            if tag == 0x3B {
                let index = try readLong()
                guard index >= 0, index < symbols.count else { throw MarshalError.invalid(L10n.string("符号引用越界。")) }
                return symbols[index]
            }
            guard tag == 0x3A else {
                throw MarshalError.invalid(String(format: L10n.string("期望符号标记，实际是 0x%02X。"), Int(tag)))
            }
            let name = try readSymbolName()
            symbols.append(name)
            return name
        }
        func decode(_ raw: [UInt8]) -> String {
            let data = Data(raw)
            if let text = String(data: data, encoding: .utf8) { return text }
            if let text = String(data: data, encoding: .shiftJIS) { return text }
            return String(decoding: raw, as: UTF8.self)
        }
        mutating func record(_ value: MarshalValue, path: [String], start: Int) {
            guard !path.isEmpty else { return }
            fields.append(.init(path: path, value: value, range: start..<offset))
        }

        mutating func readValue(path: [String]) throws -> MarshalValue {
            let start = offset
            let tag = try readByte()
            switch tag {
            case 0x30: return .null
            case 0x54: record(.bool(true), path: path, start: start); return .bool(true)
            case 0x46: record(.bool(false), path: path, start: start); return .bool(false)
            case 0x69:
                let number = try readLong()
                record(.int(number), path: path, start: start)
                return .int(number)
            case 0x3A:
                let name = try readSymbolName()
                symbols.append(name)
                return .symbol(name)
            case 0x3B:
                let index = try readLong()
                guard index >= 0, index < symbols.count else { throw MarshalError.invalid(L10n.string("符号引用越界。")) }
                return .symbol(symbols[index])
            case 0x40:
                let index = try readLong()
                guard index >= 0, index < objects.count else { throw MarshalError.invalid(L10n.string("对象引用越界。")) }
                return objects[index]
            case 0x22:
                let length = try readLong()
                guard length >= 0, length <= bytes.count else { throw MarshalError.invalid(L10n.string("字符串长度非法。")) }
                let raw = readBytes(length)
                let value = MarshalValue.string(text: decode(raw), raw: Data(raw))
                objects.append(value)
                record(value, path: path, start: start)
                return value
            case 0x5B:
                let count = try readLong()
                guard count >= 0, count < 5_000_000 else { throw MarshalError.invalid(L10n.string("数组长度非法。")) }
                objects.append(.array([]))
                let slot = objects.count - 1
                var items: [MarshalValue] = []
                items.reserveCapacity(min(count, 4096))
                for index in 0..<count { items.append(try readValue(path: path + ["[\(index)]"])) }
                objects[slot] = .array(items)
                return objects[slot]
            case 0x7B, 0x7D:
                let count = try readLong()
                guard count >= 0, count < 5_000_000 else { throw MarshalError.invalid(L10n.string("哈希长度非法。")) }
                if tag == 0x7D { _ = try readValue(path: []) }
                objects.append(.hash([]))
                let slot = objects.count - 1
                var entries: [MarshalEntry] = []
                entries.reserveCapacity(min(count, 4096))
                for _ in 0..<count {
                    let key = try readValue(path: [])
                    let name = RubyMarshal.keyName(key)
                    let value = try readValue(path: name.map { path + [$0] } ?? [])
                    entries.append(.init(key, value))
                }
                objects[slot] = .hash(entries)
                return objects[slot]
            case 0x6F:
                let className = try readSymbolEntry()
                let count = try readLong()
                guard count >= 0, count < 1_000_000 else { throw MarshalError.invalid(L10n.string("对象字段数非法。")) }
                objects.append(.object(className: className, ivars: []))
                let slot = objects.count - 1
                var entries: [MarshalEntry] = []
                for _ in 0..<count {
                    let name = try readSymbolEntry()
                    let value = try readValue(path: path + [name])
                    entries.append(.init(.symbol(name), value))
                }
                objects[slot] = .object(className: className, ivars: entries)
                return objects[slot]
            case 0x55:
                let className = try readSymbolEntry()
                let length = try readLong()
                guard length >= 0, length <= bytes.count else { throw MarshalError.invalid(L10n.string("自定义数据类型长度非法。")) }
                let value = MarshalValue.userDefined(className: className, data: Data(readBytes(length)))
                objects.append(value)
                return value
            case 0x75:
                let className = try readSymbolEntry()
                objects.append(.userMarshal(className: className, value: .null))
                let slot = objects.count - 1
                let value = try readValue(path: path)
                objects[slot] = .userMarshal(className: className, value: value)
                return objects[slot]
            case 0x6C:
                let sign = try readByte()
                let count = try readLong()
                guard count >= 0, count <= bytes.count else { throw MarshalError.invalid(L10n.string("大整数长度非法。")) }
                var number = 0
                for (index, byte) in readBytes(count).enumerated() { number |= Int(byte) << (8 * index) }
                if sign == 0x2D { number = -number }
                objects.append(.int(number))
                record(.int(number), path: path, start: start)
                return .int(number)
            case 0x66:
                let length = try readLong()
                guard length >= 0, length <= bytes.count else { throw MarshalError.invalid(L10n.string("浮点数长度非法。")) }
                let text = decode(readBytes(length))
                guard let number = Double(text) else { throw MarshalError.invalid(L10n.string("浮点数无法解析。")) }
                let value = MarshalValue.double(number)
                objects.append(value)
                record(value, path: path, start: start)
                return value
            case 0x63:
                return .classRef(try readSymbolEntry())
            case 0x6D:
                return .moduleRef(try readSymbolEntry())
            case 0x49:
                let wrapped = try readValue(path: path)
                let count = try readLong()
                guard case .object(let className, var ivars) = wrapped else {
                    for _ in 0..<max(count, 0) { _ = try readSymbolEntry(); _ = try readValue(path: []) }
                    return wrapped
                }
                for _ in 0..<count {
                    let name = try readSymbolEntry()
                    let value = try readValue(path: path + [name])
                    ivars.append(.init(.symbol(name), value))
                }
                return .object(className: className, ivars: ivars)
            case 0x65:
                _ = try readSymbolEntry()
                return try readValue(path: path)
            default:
                throw MarshalError.invalid(String(format: L10n.string("遇到未知的 Marshal 标记：0x%02X。"), Int(tag)))
            }
        }
    }

    // MARK: - 替换

    /// 按区间从后往前替换，避免前面的改动让后面的偏移失效。
    @discardableResult
    public static func patch(_ changes: [(field: MarshalField, value: MarshalValue)], in data: Data) throws -> Data {
        var bytes = Array(data)
        for change in changes.sorted(by: { $0.field.range.lowerBound > $1.field.range.lowerBound }) {
            guard change.field.range.upperBound <= bytes.count else {
                throw MarshalError.invalid(L10n.string("字段区间越界，存档可能已变化。"))
            }
            let encoded = try encode(change.value)
            bytes.replaceSubrange(change.field.range, with: encoded)
        }
        return Data(bytes)
    }

    /// 只编码标量；对象和容器不允许整段替换。
    static func encode(_ value: MarshalValue) throws -> [UInt8] {
        switch value {
        case .bool(let flag): return [flag ? 0x54 : 0x46]
        case .int(let number):
            var out: [UInt8] = [0x69]; out.append(contentsOf: longBytes(number)); return out
        case .double(let number):
            let text = Array(String(number).utf8)
            var out: [UInt8] = [0x66]; out.append(contentsOf: longBytes(text.count)); out.append(contentsOf: text); return out
        case .string(_, let raw):
            var out: [UInt8] = [0x22]; out.append(contentsOf: longBytes(raw.count)); out.append(contentsOf: raw); return out
        default:
            throw MarshalError.invalid(L10n.string("只能替换数字、布尔值和字符串。"))
        }
    }

    static func longBytes(_ value: Int) -> [UInt8] {
        if value == 0 { return [0] }
        if value > 0, value < 123 { return [UInt8(value + 5)] }
        if value < 0, value > -124 { return [UInt8(bitPattern: Int8(value - 5))] }
        var buffer: [UInt8] = []
        var remaining = value
        for _ in 0..<4 {
            buffer.append(UInt8(truncatingIfNeeded: remaining))
            remaining >>= 8
            if remaining == 0 || remaining == -1 { break }
        }
        return [UInt8(buffer.count)] + buffer
    }

    // MARK: - 查询

    /// 路径段：Hash/Object 用名字，数组用 `[n]`。
    public static func value(at path: [String], in root: MarshalValue) -> MarshalValue? {
        var node = root
        for segment in path {
            if segment.hasPrefix("["), segment.hasSuffix("]"), case .array(let items) = node,
               let index = Int(segment.dropFirst().dropLast()), index >= 0, index < items.count {
                node = items[index]; continue
            }
            switch node {
            case .hash(let entries):
                guard let found = entries.first(where: { keyName($0.key) == segment }) else { return nil }
                node = found.value
            case .object(_, let ivars):
                guard let found = ivars.first(where: { keyName($0.key) == segment }) else { return nil }
                node = found.value
            default:
                return nil
            }
        }
        return node
    }

    public static func number(at path: [String], in root: MarshalValue) -> Double? {
        switch value(at: path, in: root) {
        case .int(let number): return Double(number)
        case .double(let number): return number
        default: return nil
        }
    }

    static func keyName(_ value: MarshalValue) -> String? {
        switch value {
        case .symbol(let name), .string(let name, _): return name
        case .int(let number): return String(number)
        default: return nil
        }
    }
}
