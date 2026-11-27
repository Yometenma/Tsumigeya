import Testing
import Foundation
@testable import TsumigeyaCore

/// 样本由 MV 自带 lz-string 压缩一段 MZ 风格内容生成（前面带 8 位 hash），
/// 用来验证「解压 → 改 → 重压」这条链在真实编码下成立。
@Suite("MZ 存档离线编辑")
struct RMStoreSaveTests {
    private static let sample = "IwQwTARgzAxgLAEwN4CIDOBPNAXApgWxQC5UB9AN1wCc0BLAewDsBJBY4MKAGhVLREoBhegFdG2dgF8eABxBVsGYmQDm9ADZsiHKHB6laefGmUpgxAKw8wxAAzTeAd1wgZTEyQel5+ejWWSDuTytCAQ6rgeqOZE9jwgMNh+UWampAAWMuy29oFAA"

    private func writeSample() throws -> (URL, URL) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("tsumigeya-mz-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("file1.rmmzsave")
        try Data(Self.sample.utf8).write(to: url)
        return (dir, url)
    }

    @Test("解压后能读到金钱、物品和变量")
    func readsContents() throws {
        let (dir, url) = try writeSample(); defer { try? FileManager.default.removeItem(at: dir) }
        let document = try RMStoreSave.read(url)
        #expect(document.hash == "1a2b3c4d")
        #expect(RMStoreSave.number(["party", "_gold"], in: document.contents) == 1234)
        #expect(RMStoreSave.number(["party", "_items", "1"], in: document.contents) == 5)
        #expect(RMStoreSave.number(["variables", "1"], in: document.contents) == 0)
        #expect(RMStoreSave.number(["party", "_missing"], in: document.contents) == nil)
    }

    @Test("改金钱再写回，重新读出来是新值，hash 前缀保留")
    func writesGold() throws {
        let (dir, url) = try writeSample(); defer { try? FileManager.default.removeItem(at: dir) }
        let document = try RMStoreSave.read(url)
        let updated = try #require(RMStoreSave.setting(.int(9999), at: ["party", "_gold"], in: document.contents))
        try RMStoreSave.write(updated, to: document)

        let again = try RMStoreSave.read(url)
        #expect(again.hash == "1a2b3c4d")
        #expect(RMStoreSave.number(["party", "_gold"], in: again.contents) == 9999)
        #expect(RMStoreSave.number(["party", "_items", "1"], in: again.contents) == 5)
        #expect(FileManager.default.fileExists(atPath: url.path + SaveArchive.backupSuffix))
    }

    @Test("不存在的路径和类型不符的替换都拒绝，不产生新键")
    func refusesUnsafeEdits() throws {
        let (dir, url) = try writeSample(); defer { try? FileManager.default.removeItem(at: dir) }
        let document = try RMStoreSave.read(url)
        #expect(RMStoreSave.setting(.int(1), at: ["party", "_nope"], in: document.contents) == nil)
        #expect(RMStoreSave.setting(.string("x"), at: ["party", "_gold"], in: document.contents) == nil)
        #expect(RMStoreSave.setting(.int(1), at: ["party"], in: document.contents) == nil)
    }

    @Test("非 rmmzsave 内容报错而不是写出垃圾")
    func rejectsGarbage() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("tsumigeya-mz-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("file1.rmmzsave")
        try Data("not-a-save".utf8).write(to: url)
        #expect(throws: (any Error).self) { try RMStoreSave.read(url) }
    }
}
