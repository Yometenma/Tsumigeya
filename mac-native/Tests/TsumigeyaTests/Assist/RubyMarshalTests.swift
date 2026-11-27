import Testing
import Foundation
@testable import TsumigeyaCore

/// 样本由 Mac 上的 Ruby 用 `Marshal.dump` 生成（Hash + 自定义类 + 数组 + 日文字符串），
/// 不是照规范手搓的字节 —— 能验证解析器对真实 Marshal 输出的兼容性。
@Suite("Ruby Marshal 存档编辑")
struct RubyMarshalTests {
    private static let hex = """
    04087b0a3a0b73797374656d492208537973063a0645543a0a70617274796f3a\
    0f47616d655f5061727479083a0a40676f6c646902d2043a0b406974656d737b\
    076906690a690769003a0c406163746f72735b07690669073a0b6163746f7273\
    5b076f3a0f47616d655f4163746f72083a0e406163746f725f696469063a0a40\
    6e616d6549220be58b87e88085063b06543a0840687069696f3b0d083b0e6907\
    3b0f492211e9ad94e6b395e4bdbfe38184063b06543b1069553a0d7377697463\
    6865735b084654463a0e7661726961626c65735b086900690f6919
    """

    private static var sample: Data {
        let clean = hex.replacingOccurrences(of: "\n", with: "").replacingOccurrences(of: "\\", with: "")
        var bytes: [UInt8] = []
        var index = clean.startIndex
        while index < clean.endIndex {
            let next = clean.index(index, offsetBy: 2)
            if let byte = UInt8(clean[index..<next], radix: 16) { bytes.append(byte) }
            index = next
        }
        return Data(bytes)
    }

    @Test("扫描出 Hash、对象与数组里的标量，路径可读")
    func scansFields() throws {
        let (root, fields) = try RubyMarshal.scan(Self.sample)
        #expect(RubyMarshal.number(at: ["party", "@gold"], in: root) == 1234)
        #expect(RubyMarshal.number(at: ["variables", "[1]"], in: root) == 10)
        #expect(RubyMarshal.value(at: ["switches", "[1]"], in: root) == .bool(true))

        let byPath = Dictionary(uniqueKeysWithValues: fields.map { ($0.displayPath, $0.value) })
        #expect(byPath["party.@gold"] == .int(1234))
        #expect(byPath["actors.[0].@hp"] == .int(100))
        #expect(byPath["actors.[1].@hp"] == .int(80))
        #expect(byPath["party.@items.1"] == .int(5))
        #expect(byPath["switches.[0]"] == .bool(false))
    }

    @Test("日文字符串按 UTF-8 读出来，不是乱码")
    func decodesJapanese() throws {
        let (root, _) = try RubyMarshal.scan(Self.sample)
        guard case .string(let text, _)? = RubyMarshal.value(at: ["actors", "[0]", "@name"], in: root) else {
            Issue.record("没有读到 @name"); return
        }
        #expect(text == "勇者")
        guard case .string(let second, _)? = RubyMarshal.value(at: ["actors", "[1]", "@name"], in: root) else {
            Issue.record("没有读到第二个 @name"); return
        }
        #expect(second == "魔法使い")
    }

    @Test("替换金钱只改那几个字节，其余字段原样")
    func patchesGold() throws {
        let (_, fields) = try RubyMarshal.scan(Self.sample)
        let gold = try #require(fields.first { $0.displayPath == "party.@gold" })
        let patched = try RubyMarshal.patch([(gold, .int(9999))], in: Self.sample)

        let (root, after) = try RubyMarshal.scan(patched)
        #expect(RubyMarshal.number(at: ["party", "@gold"], in: root) == 9999)
        #expect(after.count == fields.count)
        let before = fields.map { $0.displayPath + "=" + String(describing: $0.value) }
        let now = after.map { $0.displayPath + "=" + String(describing: $0.value) }
        #expect(before.filter { $0 != "party.@gold=" + String(describing: gold.value) }
                == now.filter { !$0.hasPrefix("party.@gold=") })
    }

    @Test("同一次替换多处，靠后的一处不受前面长度变化影响")
    func patchesMultiple() throws {
        let (_, fields) = try RubyMarshal.scan(Self.sample)
        let gold = try #require(fields.first { $0.displayPath == "party.@gold" })
        let hp = try #require(fields.first { $0.displayPath == "actors.[1].@hp" })
        let flag = try #require(fields.first { $0.displayPath == "switches.[0]" })
        let patched = try RubyMarshal.patch([(gold, .int(123456789)), (hp, .int(1)), (flag, .bool(true))], in: Self.sample)

        let (root, _) = try RubyMarshal.scan(patched)
        #expect(RubyMarshal.number(at: ["party", "@gold"], in: root) == 123456789)
        #expect(RubyMarshal.number(at: ["actors", "[1]", "@hp"], in: root) == 1)
        #expect(RubyMarshal.value(at: ["switches", "[0]"], in: root) == .bool(true))
    }

    @Test("只允许标量替换，容器与非 4.8 头都拒绝")
    func refusesUnsafe() throws {
        let (_, fields) = try RubyMarshal.scan(Self.sample)
        let gold = try #require(fields.first { $0.displayPath == "party.@gold" })
        #expect(throws: (any Error).self) { try RubyMarshal.patch([(gold, .array([]))], in: Self.sample) }
        #expect(throws: (any Error).self) { try RubyMarshal.scan(Data([0x04, 0x09, 0x30])) }
        #expect(throws: (any Error).self) { try RubyMarshal.scan(Data([0x04, 0x08, 0x99])) }
    }
}
