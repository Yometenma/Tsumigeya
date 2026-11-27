import Testing
import Foundation
@testable import TsumigeyaCore

@Suite("LCF 与 RPG2000 数据库")
struct LCFTests {
    /// 最小合法 LDB：头部 + actors chunk（两个角色，每个以 ID 0 结束）。
    private static let minimal = Data([
        0x0b, 0x4c, 0x63, 0x66, 0x44, 0x61, 0x74, 0x61, 0x42, 0x61, 0x73, 0x65,
        0x0b, 0x15, 0x02,
        0x01, 0x01, 0x04, 0x41, 0x6c, 0x65, 0x78, 0x02, 0x03, 0x48, 0x45, 0x52, 0x00,
        0x02, 0x01, 0x03, 0x42, 0x6f, 0x62, 0x00
    ])

    @Test("大端 7 位变长整数")
    func compressedIntegers() throws {
        func read(_ bytes: [UInt8]) throws -> Int {
            var offset = 0
            return try LCF.readInt(bytes, &offset)
        }
        #expect(try read([0x00]) == 0)
        #expect(try read([0x7F]) == 127)
        #expect(try read([0x81, 0x00]) == 128)
        #expect(try read([0xAD, 0x71]) == 5873)
        #expect(try read([0xFF, 0x7F]) == 16383)
        #expect(throws: (any Error).self) { try read([0x81]) }
    }

    @Test("文件头不匹配时报错，不继续解析")
    func headerCheck() throws {
        _ = try LCF.open(Self.minimal, expecting: "LcfDataBase")
        #expect(throws: (any Error).self) { try LCF.open(Self.minimal, expecting: "LcfSaveData") }
        #expect(throws: (any Error).self) { try LCF.open(Data([0x0b, 0x41]), expecting: "LcfDataBase") }
    }

    @Test("解析最小 LDB 的角色名与称号")
    func parsesMinimalDatabase() throws {
        let rows = try RPG2000Database.texts(Self.minimal)
        guard rows.count == 2 else {
            Issue.record("期望 2 行，实际 \(rows.count)：\(rows.map(\.label))"); return
        }
        #expect(rows.map(\.section) == ["actors", "actors"])
        #expect(rows.map(\.id) == [1, 2])
        #expect(rows.map(\.name) == ["Alex", "Bob"])
        #expect(rows[0].description == "HER")
        #expect(rows[1].description.isEmpty)
    }

    @Test("非数据库文件和截断数据不崩溃")
    func survivesGarbage() throws {
        #expect(throws: (any Error).self) { try RPG2000Database.texts(Data([0x00, 0x01, 0x02])) }
        // 长度字段声称 200 字节但只有 3 字节：解析到一半停下，不抛越界。
        let broken = Data([0x0b] + Array("LcfDataBase".utf8) + [0x0b, 0xc8, 0x01, 0x02, 0x03])
        #expect((try? RPG2000Database.texts(broken))?.isEmpty ?? true)
    }
}
