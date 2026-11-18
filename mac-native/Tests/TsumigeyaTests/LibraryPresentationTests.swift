import AppKit
import Foundation
import SwiftUI
import Testing
import Vision
@testable import TsumigeyaCore
@testable import TsumigeyaApp

@Suite("旧设置兼容与文字资料内存缓存", .serialized)
@MainActor
struct LibraryPresentationTests {
    private func fixture() throws -> URL {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("library-cache-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let game = GameRecord(id: "1", gameTitle: "VISIBLE GAME TITLE", gamePath: "/示例/Game.exe", gameEngine: "nwjs")
        try #require(JSONStore.save(GameMap(games: ["1": game]), to: directory.appendingPathComponent("games.json")) == nil)
        return directory
    }

    private func meta(_ title: String = "作品标题") -> GameDlsiteMeta {
        GameDlsiteMeta(work: DlsiteWork(rj: "RJ123456", title: title, coverUrl: "https://img.dlsite.jp/cover.jpg",
                                      fetchedAt: "test", sampleImageURLs: ["https://img.dlsite.jp/preview.jpg"]))
    }

    @Test("旧隐私设置不隐藏标题或图片，不阻止存档操作；保存其他设置仍保留未知字段")
    func legacySettingsAreInert() async throws {
        let directory = try fixture()
        defer { try? FileManager.default.removeItem(at: directory) }
        let settingsURL = directory.appendingPathComponent("global-settings.json")
        let legacy: [String: JSONValue] = ["privacyMode": .bool(true), "privacyHideTitles": .bool(true),
            "showAdultCovers": .bool(false), "future": .object(["keep": .int(7)])]
        try #require(JSONStore.save(legacy, to: settingsURL) == nil)
        try #require(GameMetaStore.save(dataDir: directory.path, gameId: "1", meta: meta()) == nil)
        let gamesURL = directory.appendingPathComponent("games.json")
        let gamesBefore = try Data(contentsOf: gamesURL)
        let metaURL = directory.appendingPathComponent("library-meta.json")
        let metaBefore = GameMetaStore.load(dataDir: directory.path, gameId: "1")
        let store = AppStore()
        await store.load(dataDirectory: directory.path)
        let game = try #require(store.games.first)
        #expect(store.displayTitle(for: game) == game.gameTitle)
        #expect(store.artworkURL(for: game)?.absoluteString == "https://img.dlsite.jp/cover.jpg")
        #expect(store.artworkURL(for: game, preferPreview: true)?.absoluteString == "https://img.dlsite.jp/preview.jpg")
        #expect(!SettingsGroups.settingsKeys.contains { ["privacyMode", "privacyHideTitles"].contains($0.rawValue) })
        store.setSetting(.listView, .bool(false))
        let saved = try #require(JSONStore.load([String: JSONValue].self, from: settingsURL).value)
        for (key, value) in legacy { #expect(saved[key] == value) }
        #expect(try Data(contentsOf: gamesURL) == gamesBefore)
        #expect(GameMetaStore.load(dataDir: directory.path, gameId: "1") == metaBefore)
        let saves = directory.appendingPathComponent("saves")
        try FileManager.default.createDirectory(at: saves, withIntermediateDirectories: true)
        let session = store.saveSession(for: game)
        session.setDirectory(saves.path)
        #expect(session.message?.isError == false)
        #expect(store.game(id: "1")?.saveDirectoryOverride == saves.path)
    }

    @Test("界面重复查询已知与缺失资料都不重读文件，显式重载后才更新快照")
    func metadataReadsStayInMemory() async throws {
        let directory = try fixture()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = AppStore()
        try #require(GameMetaStore.save(dataDir: directory.path, gameId: "1", meta: meta("原资料")) == nil)
        await store.load(dataDirectory: directory.path)
        try #require(GameMetaStore.save(dataDir: directory.path, gameId: "1", meta: meta("外部新资料")) == nil)
        try #require(GameMetaStore.save(dataDir: directory.path, gameId: "2", meta: meta("外部新增")) == nil)
        for _ in 0..<100 {
            #expect(store.meta(for: "1")?.work.title == "原资料")
            #expect(store.meta(for: "2") == nil)
        }
        await store.load(dataDirectory: directory.path)
        #expect(store.meta(for: "1")?.work.title == "外部新资料")
        #expect(store.meta(for: "2")?.work.title == "外部新增")
    }

    @Test("失败写入不污染内存；更新记录不会丢资料；删除后编号复用不继承旧资料")
    func metadataMutationBoundaries() async throws {
        let directory = try fixture()
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = AppStore()
        await store.load(dataDirectory: directory.path)
        #expect(store.updateMeta(gameId: "1", meta: meta("已保存")))
        #expect(store.updateGame(id: "1", title: "新名称", engine: "nwjs", gameArgs: [:]))
        #expect(store.meta(for: "1")?.work.title == "已保存")
        let file = directory.appendingPathComponent("library-meta.json")
        let before = try Data(contentsOf: file)
        try Data("broken".utf8).write(to: file)
        #expect(!store.updateMeta(gameId: "1", meta: meta("不应进入内存")))
        #expect(store.meta(for: "1")?.work.title == "已保存")
        try before.write(to: file)
        store.deleteGame(id: "1")
        #expect(store.meta(for: "1") == nil)
        #expect(store.addGame(title: "替换游戏", folder: directory.path, engine: "nwjs"))
        #expect(store.games.first?.id == "1")
        #expect(store.meta(for: "1") == nil)
    }

    @Test("旧隐私设置开启时真实视图仍显示原始标题", arguments: ["列表", "卡片", "编辑", "搜索结果"])
    func legacySettingsDoNotHideViews(surface: String) async throws {
        let directory = try fixture()
        defer { try? FileManager.default.removeItem(at: directory) }
        try #require(JSONStore.save(["privacyMode": JSONValue.bool(true), "privacyHideTitles": .bool(true)],
            to: directory.appendingPathComponent("global-settings.json")) == nil)
        try #require(GameMetaStore.save(dataDir: directory.path, gameId: "1", meta: meta("VISIBLE GAME TITLE")) == nil)
        let store = AppStore()
        await store.load(dataDirectory: directory.path)
        let game = try #require(store.games.first)
        let view: AnyView
        switch surface {
        case "列表": view = AnyView(GameListRow(game: game, isRunning: false))
        case "卡片": view = AnyView(GameCardTile(game: game, isRunning: false, isSelected: false, onSelect: {}))
        case "编辑": view = AnyView(GameEditView(game: game))
        case "搜索结果": view = AnyView(DLsiteSearchResults(hits: [.init(rj: "RJ123456", title: game.gameTitle,
            circle: nil, coverUrl: nil, order: 0)], onSelect: { _ in }, onCancel: {}))
        default: view = AnyView(GameDetailView(game: game))
        }
        _ = NSApplication.shared
        let hosting = NSHostingView(rootView: view.environmentObject(store).background(Color(nsColor: .windowBackgroundColor)))
        let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 1180, height: 760),
            styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        window.orderFrontRegardless()
        defer { window.close() }
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        var found = false
        while !found && ContinuousClock.now < deadline {
            hosting.layoutSubtreeIfNeeded()
            let bitmap = try #require(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
            hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
            let image = try #require(bitmap.cgImage)
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["en-US"]
            try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
            let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
            found = text.uppercased().contains(game.gameTitle)
            if !found { try await Task.sleep(for: .milliseconds(30)) }
        }
        #expect(found, "\(surface) 应显示原始游戏标题")
    }
}
