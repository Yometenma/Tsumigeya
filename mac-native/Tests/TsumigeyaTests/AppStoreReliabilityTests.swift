import Foundation
import AppKit
import Testing
@testable import TsumigeyaApp
@testable import TsumigeyaCore

@Suite("应用状态与持久化", .serialized)
@MainActor
struct AppStoreReliabilityTests {
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    @Test("快照检查拒绝纯色和单点噪声，能识别中央稀疏内容")
    func blankSnapshotControls() throws {
        let bitmap = try #require(NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: 640, pixelsHigh: 400,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
            isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
        let white = NSColor(deviceRed: 1, green: 1, blue: 1, alpha: 1)
        let black = NSColor(deviceRed: 0, green: 0, blue: 0, alpha: 1)
        for y in 0..<400 {
            for x in 0..<640 { bitmap.setColor(white, atX: x, y: y) }
        }
        #expect(UISnapshot.checkBlank(bitmap))
        bitmap.setColor(black, atX: 320, y: 198)
        #expect(UISnapshot.checkBlank(bitmap))
        for y in 196..<212 {
            for x in 280..<360 { bitmap.setColor(black, atX: x, y: y) }
        }
        #expect(!UISnapshot.checkBlank(bitmap))
    }

    @Test("损坏游戏库不能被添加操作覆盖，重试仍报告错误")
    func corruptLibraryIsNotAnEmptyLibrary() async throws {
        let dir = try directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("games.json")
        let original = Data("{broken".utf8)
        try original.write(to: url)
        let store = AppStore()
        await store.load(dataDirectory: dir.path)
        #expect(store.loadError != nil)
        #expect(!store.addGame(title: "新游戏", folder: dir.path, engine: "nwjs"))
        #expect(try Data(contentsOf: url) == original)
        await store.load(dataDirectory: dir.path)
        #expect(store.loadError != nil)
    }

    @Test("移除游戏同时清理关联记录，复用编号不串元数据")
    func deleteClearsAssociatedData() async throws {
        let dir = try directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = AppStore()
        await store.load(dataDirectory: dir.path)
        #expect(store.addGame(title: "旧游戏", folder: dir.path, engine: "nwjs"))
        let game = try #require(store.games.first)
        let meta = GameDlsiteMeta(work: DlsiteWork(rj: "RJ123456", title: "旧作品", fetchedAt: "2026-11-16"))
        #expect(store.updateMeta(gameId: game.id, meta: meta))
        #expect(store.createCategory(name: "收藏"))
        let category = try #require(store.categories.keys.first)
        store.setCategoryMembership(gameId: game.id, categoryId: category, member: true)
        let stats = dir.appendingPathComponent("play-stats.json")
        #expect(JSONStore.save([game.id: JSONValue.object(["seconds": .int(30)]), "future": .bool(true)], to: stats) == nil)
        store.deleteGame(id: game.id)
        #expect(store.games.isEmpty)
        #expect(store.meta(for: game.id) == nil)
        #expect(store.assignments[game.id] == nil)
        #expect(store.categories[category] != nil)
        let savedStats = try #require(JSONStore.load([String: JSONValue].self, from: stats).value)
        #expect(savedStats[game.id] == nil)
        #expect(savedStats["future"] == .bool(true))
        #expect(store.addGame(title: "新游戏", folder: dir.path, engine: "nwjs"))
        #expect(store.games.first?.id == game.id)
        #expect(store.meta(for: game.id) == nil)
    }

    @Test("元数据写失败不更新缓存，并给出可呈现错误")
    func failedMetaWriteDoesNotPublishSuccess() async throws {
        let dir = try directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = AppStore()
        await store.load(dataDirectory: dir.path)
        let url = dir.appendingPathComponent("library-meta.json")
        let original = Data("{broken".utf8)
        try original.write(to: url)
        let meta = GameDlsiteMeta(work: DlsiteWork(rj: "RJ123456", fetchedAt: "2026-11-16"))
        #expect(!store.updateMeta(gameId: "1", meta: meta))
        #expect(store.gameMeta["1"] == nil)
        #expect(store.lastAddGameError != nil)
        #expect(try Data(contentsOf: url) == original)
    }

    @Test("启动直接应用持久化的列表设置，写入失败不发布临时值")
    func settingsLoadAndFailure() async throws {
        let dir = try directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("global-settings.json")
        #expect(JSONStore.save(["listView": JSONValue.bool(false)], to: url) == nil)
        let store = AppStore()
        await store.load(dataDirectory: dir.path)
        #expect(!store.settingBool(.listView))
        try FileManager.default.createDirectory(at: url.appendingPathExtension("bak"), withIntermediateDirectories: true)
        store.setSetting(.listView, .bool(true))
        #expect(!store.settingBool(.listView))
        #expect(store.operationError != nil)
        #expect(JSONStore.load([String: JSONValue].self, from: url).value?["listView"] == .bool(false))
    }

    @Test("残留安装目录可重试，取消后等待原任务释放槽位")
    func incompleteEngineCanRetry() async throws {
        let dir = try directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let root = URL(fileURLWithPath: BinaryPaths.moduleDir(dir.path, "nwjs"))
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let store = AppStore()
        await store.load(dataDirectory: dir.path)
        store.installEngine("nwjs", force: false)
        let token = try #require(store.installTokens["nwjs"])
        let task = try #require(store.installTasks["nwjs"])
        #expect(store.engineErrors["nwjs"] == nil)
        store.cancelEngineInstall("nwjs")
        #expect(store.installTasks["nwjs"] != nil)
        store.installEngine("nwjs", force: false)
        #expect(store.installTokens["nwjs"] == token)
        await task.value
        #expect(store.installTasks["nwjs"] == nil)
        #expect(store.engineProgress["nwjs"] == nil)
        #expect(store.engineErrors["nwjs"] == nil)
    }
}
