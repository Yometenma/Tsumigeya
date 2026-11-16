import Foundation
import Testing
@testable import TsumigeyaCore

@Suite("共享元数据无损写入")
struct CoreDataSafetyTests {
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("core-data-safety-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func write(_ raw: [String: JSONValue], to directory: URL) throws {
        try JSONEncoder().encode(raw).write(
            to: directory.appendingPathComponent("library-meta.json"))
    }

    private var meta: GameDlsiteMeta {
        GameDlsiteMeta(work: DlsiteWork(rj: "RJ123456", title: "新标题", fetchedAt: "now"))
    }

    @Test("损坏、空文件及错误结构均拒绝保存和删除，原件逐字节保留",
          arguments: ["{ broken", "", "[]", "null"])
    func refusesDamagedFile(contents: String) throws {
        let dir = try directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("library-meta.json")
        let original = Data(contents.utf8)
        try original.write(to: url)
        #expect(GameMetaStore.save(dataDir: dir.path, gameId: "1", meta: meta) != nil)
        #expect(GameMetaStore.remove(dataDir: dir.path, gameId: "1") != nil)
        #expect(GameMetaStore.removeGameData(dataDir: dir.path, gameId: "1") != nil)
        #expect(LibraryMetaStore.saveCategories(
            LibraryMeta(), dataDir: dir.path, raw: [:]) != nil)
        #expect(try Data(contentsOf: url) == original)
        #expect(!FileManager.default.fileExists(atPath: url.appendingPathExtension("bak").path))
    }

    @Test("元数据更新保留嵌套未知字段并能清空已知可选字段")
    func preservesMetadataExtensions() throws {
        let dir = try directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let extensionValue = JSONValue.object(["nested": .array([.int(7), .null])])
        try write([
            "1": .object(["custom": extensionValue, "dlsite": .object([
                "future": extensionValue, "description": .string("待清空")])]),
            "plugin": extensionValue,
        ], to: dir)
        #expect(GameMetaStore.save(dataDir: dir.path, gameId: "1", meta: meta) == nil)
        let raw = GameMetaStore.readRaw(dataDir: dir.path)
        let entry = try #require(raw["1"]?.objectValue)
        let dlsite = try #require(entry["dlsite"]?.objectValue)
        #expect(entry["custom"] == extensionValue)
        #expect(raw["plugin"] == extensionValue)
        #expect(dlsite["future"] == extensionValue)
        #expect(dlsite["title"] == .string("新标题"))
        #expect(dlsite["description"] == nil)
    }

    @Test("旧分类快照保存不回退新元数据，分类未知字段保留")
    func categorySaveUsesLatestDiskData() throws {
        let dir = try directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        try write([
            "categories": .object(["rpg": .object([
                "name": .string("角色扮演"), "order": .int(1), "color": .string("blue")])]),
            "assignments": .object(["1": .array([.string("rpg")])]),
        ], to: dir)
        let snapshot = LibraryMetaStore.load(dataDir: dir.path)
        #expect(GameMetaStore.save(dataDir: dir.path, gameId: "1", meta: meta) == nil)
        var categories = snapshot.meta
        categories.categories["rpg"]?.name = "改名"
        #expect(LibraryMetaStore.saveCategories(
            categories, dataDir: dir.path, raw: snapshot.raw) == nil)
        #expect(GameMetaStore.load(dataDir: dir.path, gameId: "1")?.work.title == "新标题")
        let raw = GameMetaStore.readRaw(dataDir: dir.path)
        let category = raw["categories"]?.objectValue?["rpg"]?.objectValue
        #expect(category?["name"] == .string("改名"))
        #expect(category?["color"] == .string("blue"))
    }

    @Test("删游戏同时清元数据和归属，其他游戏与扩展不变")
    func removesOnlySelectedGame() throws {
        let dir = try directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let original: [String: JSONValue] = [
            "1": .object(["custom": .int(1)]),
            "2": .object(["custom": .int(2)]),
            "assignments": .object([
                "1": .array([.string("rpg")]), "2": .array([.string("rpg")])]),
            "categories": .object(["rpg": .object(["name": .string("RPG")])]),
            "future": .array([.bool(true)]),
        ]
        try write(original, to: dir)
        #expect(GameMetaStore.removeGameData(dataDir: dir.path, gameId: "1") == nil)
        var expected = original
        expected.removeValue(forKey: "1")
        expected["assignments"] = .object(["2": .array([.string("rpg")])])
        #expect(GameMetaStore.readRaw(dataDir: dir.path) == expected)
        #expect(GameMetaStore.removeGameData(dataDir: dir.path, gameId: "1") == nil)
        #expect(GameMetaStore.readRaw(dataDir: dir.path) == expected)
    }

    @Test("备份失败时整个游戏清理均不落盘")
    func failedBackupDoesNotDeleteData() throws {
        let dir = try directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("library-meta.json")
        try write(["1": .object([:]), "assignments": .object([
            "1": .array([.string("rpg")])])], to: dir)
        let original = try Data(contentsOf: url)
        // 用目录占住备份路径，稳定制造备份写入失败，不依赖运行者权限。
        try FileManager.default.createDirectory(
            at: url.appendingPathExtension("bak"), withIntermediateDirectories: false)
        #expect(GameMetaStore.removeGameData(dataDir: dir.path, gameId: "1") != nil)
        #expect(try Data(contentsOf: url) == original)
    }

    @Test("JSON 损坏原件不能覆盖已有可恢复备份")
    func corruptJSONDoesNotReplaceBackup() throws {
        let dir = try directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("games.json")
        let damaged = Data("{ damaged".utf8)
        let backup = Data("{\"recoverable\":true}".utf8)
        try damaged.write(to: url)
        try backup.write(to: url.appendingPathExtension("bak"))
        #expect(JSONStore.save(JSONValue.object([:]), to: url) != nil)
        #expect(try Data(contentsOf: url) == damaged)
        #expect(try Data(contentsOf: url.appendingPathExtension("bak")) == backup)
    }

    @Test("JSON 保存不能先删除正式文件，备份保留上一版本")
    func atomicSaveDoesNotRemoveDestination() throws {
        let dir = try directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("games.json")
        let original = Data("{\"old\":true}".utf8)
        try original.write(to: url)
        let manager = RefuseDestinationRemoval(destination: url)
        #expect(JSONStore.save(JSONValue.object(["new": .int(2)]),
                               to: url, fileManager: manager) == nil)
        #expect(try Data(contentsOf: url.appendingPathExtension("bak")) == original)
        #expect(JSONStore.load(JSONValue.self, from: url).value == .object(["new": .int(2)]))
    }
}

private final class RefuseDestinationRemoval: FileManager, @unchecked Sendable {
    let destination: URL
    init(destination: URL) { self.destination = destination; super.init() }
    override func removeItem(at URL: URL) throws {
        if URL == destination {
            throw NSError(domain: "CoreDataSafetyTests", code: 1)
        }
        try super.removeItem(at: URL)
    }
}
