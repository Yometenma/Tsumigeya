import Darwin
import Foundation
import Testing
@testable import TsumigeyaApp
@testable import TsumigeyaCore

@Suite("入库与定位实际持久化", .serialized)
@MainActor
struct LibraryIntakeStoreTests {
    private func fixture() throws -> URL {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("intake-store-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return root
    }
    private func game(_ root: URL, _ name: String) throws -> LibraryIntake.Candidate {
        let dir = root.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data().write(to: dir.appendingPathComponent("data.xp3"))
        return try #require(try LibraryIntake.inspectFolder(dir.path))
    }

    @Test("失败批次不部分写入，成功后界面和磁盘同时更新")
    func batchAtomic() async throws {
        let root = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let a = try game(root, "a"); var b = try game(root, "b")
        let store = AppStore(); await store.load(dataDirectory: root.path)
        b.title = a.title
        #expect(!store.addBatch([a, b])); #expect(store.games.isEmpty)
        let url = root.appendingPathComponent("games.json")
        #expect(!FileManager.default.fileExists(atPath: url.path))
        b.title = "b"
        #expect(store.addBatch([a, b])); #expect(store.games.count == 2)
        #expect(JSONStore.load(GameMap.self, from: url).value?.ordered == store.games)
        let original = try Data(contentsOf: url)
        #expect(!store.addBatch([a])); #expect(try Data(contentsOf: url) == original)
        #expect(!store.addGame(title: "换名字", folder: a.folder, engine: a.engine))
        #expect(try Data(contentsOf: url) == original)
    }

    @Test("损坏原件和备份失败都不覆盖；内存仍保留原记录")
    func corruptAndBackup() async throws {
        let root = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let a = try game(root, "a"); let b = try game(root, "b")
        let store = AppStore(); await store.load(dataDirectory: root.path)
        #expect(store.addBatch([a]))
        let url = root.appendingPathComponent("games.json")
        let original = try Data(contentsOf: url)
        try FileManager.default.createDirectory(at: url.appendingPathExtension("bak"), withIntermediateDirectories: true)
        #expect(!store.addBatch([b])); #expect(store.games.count == 1)
        #expect(try Data(contentsOf: url) == original)
        let corrupt = Data("{broken".utf8); try corrupt.write(to: url)
        #expect(!store.addBatch([b])); #expect(try Data(contentsOf: url) == corrupt)
        #expect(!store.relocateGame(try #require(store.games.first), folder: b.folder))
        #expect(try Data(contentsOf: url) == corrupt)
    }

    @Test("重新定位保留分类、元数据、游玩记录，旁挂文件逐字节不变")
    func preservesSidecars() async throws {
        let root = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let old = try game(root, "old"); let new = try game(root, "new")
        let store = AppStore(); await store.load(dataDirectory: root.path)
        #expect(store.addBatch([old]))
        let record = try #require(store.games.first)
        #expect(store.createCategory(name: "收藏"))
        let category = try #require(store.categories.keys.first)
        store.setCategoryMembership(gameId: record.id, categoryId: category, member: true)
        #expect(store.updateMeta(gameId: record.id, meta: GameDlsiteMeta(work: DlsiteWork(rj: "RJ123456", title: "作品", fetchedAt: "2026-11-16"))))
        let stats = root.appendingPathComponent("play-stats.json")
        #expect(JSONStore.save([record.id: JSONValue.object(["seconds": .int(99)]), "future": .bool(true)], to: stats) == nil)
        let sidecars = ["library-meta.json", "play-stats.json"]
        let before = try sidecars.map { try Data(contentsOf: root.appendingPathComponent($0)) }
        #expect(store.relocateGame(record, folder: new.folder))
        #expect(store.games.first?.id == record.id)
        #expect(store.games.first?.gameTitle == record.gameTitle)
        #expect(store.games.first?.gamePath == (new.folder as NSString).appendingPathComponent("Game.exe"))
        #expect(store.assignments[record.id]?.contains(category) == true)
        #expect(store.meta(for: record.id)?.work.title == "作品")
        #expect(try sidecars.map { try Data(contentsOf: root.appendingPathComponent($0)) } == before)
        #expect(JSONStore.load(GameMap.self, from: root.appendingPathComponent("games.json")).value?.ordered == store.games)
    }

    @Test("外部更改或标题隐私状态不能被定位和批量操作覆盖")
    func staleAndPrivacy() async throws {
        let root = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let a = try game(root, "a"); let b = try game(root, "b")
        let store = AppStore(); await store.load(dataDirectory: root.path)
        #expect(store.addBatch([a]))
        let old = try #require(store.games.first)
        let url = root.appendingPathComponent("games.json")
        var map = try #require(JSONStore.load(GameMap.self, from: url).value)
        map.games[old.id]?.gameTitle = "外部修改"
        #expect(JSONStore.save(map, to: url) == nil)
        let bytes = try Data(contentsOf: url)
        #expect(!store.relocateGame(old, folder: b.folder)); #expect(try Data(contentsOf: url) == bytes)
        store.setSetting(.privacyMode, .bool(true)); store.setSetting(.privacyHideTitles, .bool(true))
        #expect(!store.addBatch([b])); #expect(!store.relocateGame(old, folder: b.folder))
        #expect(try Data(contentsOf: url) == bytes)
    }

    @Test("实际启动本地进程后禁止重新定位")
    func runningGame() async throws {
        let root = try fixture(); defer { try? FileManager.default.removeItem(at: root) }
        let a = try game(root, "a"); let b = try game(root, "b")
        let store = AppStore(); await store.load(dataDirectory: root.path)
        #expect(store.addBatch([a]))
        let record = try #require(store.games.first)
        let binary = URL(fileURLWithPath: BinaryPaths.depsDir(root.path, "kirikiri", "krkrsdl2"))
        try FileManager.default.createDirectory(at: binary.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "#!/bin/sh\nexec /bin/sleep 30\n".write(to: binary, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: binary.path)
        try Data().write(to: URL(fileURLWithPath: record.gamePath))
        store.launch(game: record)
        let pid = try #require(store.runningGames[record.id], "本地测试进程必须启动成功")
        defer { store.stopRunningPoll(); kill(pid, SIGTERM) }
        let url = root.appendingPathComponent("games.json"); let bytes = try Data(contentsOf: url)
        #expect(!store.relocateGame(record, folder: b.folder))
        #expect(store.lastAddGameError == "游戏运行中，不能更改路径。")
        #expect(try Data(contentsOf: url) == bytes)
    }
}
