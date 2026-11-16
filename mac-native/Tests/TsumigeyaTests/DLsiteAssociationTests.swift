import AppKit
import SwiftUI
import Vision
import Foundation
import Testing
@testable import TsumigeyaCore
@testable import TsumigeyaApp

@MainActor
private final class ScrapingFixture {
    let directory: URL
    let game = GameRecord(id: "1", gameTitle: "本地中文名", gamePath: "/fixture/Game.exe", gameEngine: "nwjs")
    let store: AppStore

    init(transport: any DLsiteTransport) throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("scraping-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        store = AppStore(dlsiteService: DLsiteService(dataDir: directory.path, transport: transport, minIntervalMs: 0))
        try #require(JSONStore.save(GameMap(games: [game.id: game]), to: directory.appendingPathComponent("games.json")) == nil)
    }
    func load() async { await store.load(dataDirectory: directory.path) }
    func cleanup() { store.cancelLookup(gameId: game.id); try? FileManager.default.removeItem(at: directory) }
    func waitUntil(_ predicate: () -> Bool) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while !predicate() && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        try #require(predicate(), "异步操作未在期限内完成")
    }
    func setOld(rj: String = "RJ123456") throws {
        let meta = GameDlsiteMeta(work: DlsiteWork(rj: rj, title: "原作品", description: "手动简介", fetchedAt: "old"),
                                  editedFields: ["description"])
        try #require(store.updateMeta(gameId: game.id, meta: meta))
    }
}

private actor HeldScrapingTransport: DLsiteTransport {
    private var continuation: CheckedContinuation<(status: Int, body: String), Never>?
    private(set) var started = false
    func fetch(url: String, timeout: TimeInterval) async throws -> (status: Int, body: String) {
        started = true
        return await withCheckedContinuation { continuation = $0 }
    }
    func release(_ body: String) {
        continuation?.resume(returning: (200, body))
        continuation = nil
    }
}

@Suite("作品关联：预览、换绑与旧请求隔离", .serialized)
@MainActor
struct DLsiteAssociationTests {
    private func page(_ rj: String = "RJ123456") -> String {
        """
        <script type="application/ld+json">{"@type":"Product","sku":"\(rj)","name":"网络作品","description":"网络简介","image":"https://img.dlsite.jp/cover.jpg"}</script>
        """
    }

    @Test("精确获取先预览，取消不写库；确认后保存且不改本地名称")
    func previewBeforeSave() async throws {
        let fixture = try ScrapingFixture(transport: FakeTransport(body: page()))
        defer { fixture.cleanup() }
        await fixture.load()
        fixture.store.fetchMeta(gameId: "1", rj: "RJ123456", preview: true)
        try await fixture.waitUntil { !fixture.store.fetchingMeta.contains("1") }
        #expect(fixture.store.metaPreviews["1"]?.title == "网络作品")
        #expect(GameMetaStore.load(dataDir: fixture.directory.path, gameId: "1") == nil)
        fixture.store.beginManualRJ(gameId: "1")
        fixture.store.closeManualRJ()
        #expect(fixture.store.metaPreviews["1"] == nil)
        #expect(fixture.store.meta(for: "1") == nil)
        fixture.store.fetchMeta(gameId: "1", rj: "RJ123456", preview: true)
        try await fixture.waitUntil { !fixture.store.fetchingMeta.contains("1") }
        #expect(fixture.store.applyMetaPreview(gameId: "1"))
        #expect(GameMetaStore.load(dataDir: fixture.directory.path, gameId: "1")?.work.title == "网络作品")
        fixture.store.searchText = "网络作品"
        #expect(fixture.store.filteredGames.map(\.id) == ["1"])
        fixture.store.searchText = "没有该作品"
        #expect(fixture.store.filteredGames.isEmpty)
        #expect(fixture.store.game(id: "1")?.gameTitle == "本地中文名")
    }

    @Test("同作品刷新保留手改，换作品不混入旧字段", arguments: ["RJ123456", "RJ654321"])
    func mergePolicy(target: String) async throws {
        let fixture = try ScrapingFixture(transport: FakeTransport(body: page(target)))
        defer { fixture.cleanup() }
        await fixture.load()
        try fixture.setOld()
        fixture.store.fetchMeta(gameId: "1", rj: target, preview: true)
        try await fixture.waitUntil { !fixture.store.fetchingMeta.contains("1") }
        #expect(fixture.store.meta(for: "1")?.work.description == "手动简介")
        #expect(fixture.store.applyMetaPreview(gameId: "1"))
        let meta = try #require(fixture.store.meta(for: "1"))
        #expect(meta.work.rj == target)
        #expect(meta.work.description == (target == "RJ123456" ? "手动简介" : "网络简介"))
        #expect(meta.editedFields == (target == "RJ123456" ? ["description"] : []))
    }

    @Test("候选获取失败不清空搜索结果，不替换旧信息")
    func failureRetainsResults() async throws {
        let hit = """
        <title>検索結果</title><div data-list_item_product_id="RJ654321"><dd class="work_name"><span>候选<a title="候选">查看</a></span></dd></div>
        """
        let fixture = try ScrapingFixture(transport: DLsiteSequenceTransport([(200, hit), (503, "")]))
        defer { fixture.cleanup() }
        await fixture.load()
        try fixture.setOld()
        fixture.store.searchMeta(gameId: "1", keyword: "候选", category: "maniax")
        try await fixture.waitUntil { !fixture.store.searchingGameIDs.contains("1") }
        #expect(fixture.store.searchHits["1"]?.count == 1)
        fixture.store.selectSearchHit(gameId: "1", rj: "RJ654321")
        try await fixture.waitUntil { !fixture.store.fetchingMeta.contains("1") }
        #expect(fixture.store.metaError["1"] != nil)
        #expect(fixture.store.searchHits["1"]?.count == 1)
        #expect(fixture.store.lastKeyword["1"] == "候选")
        #expect(fixture.store.meta(for: "1")?.work.rj == "RJ123456")
    }

    @Test("取消后晚到的网络结果不能出现预览或回写")
    func lateResultAfterCancel() async throws {
        let transport = HeldScrapingTransport()
        let fixture = try ScrapingFixture(transport: transport)
        defer { fixture.cleanup() }
        await fixture.load()
        fixture.store.fetchMeta(gameId: "1", rj: "RJ123456", preview: true)
        while !(await transport.started) { try await Task.sleep(for: .milliseconds(10)) }
        fixture.store.cancelLookup(gameId: "1")
        await transport.release(page())
        try await Task.sleep(for: .milliseconds(60))
        #expect(fixture.store.metaPreviews["1"] == nil)
        #expect(fixture.store.meta(for: "1") == nil)
        #expect(fixture.store.metaError["1"] == nil)
    }

    @Test("删除游戏并复用编号后，旧请求不能继承到新游戏")
    func reusedID() async throws {
        let transport = HeldScrapingTransport()
        let fixture = try ScrapingFixture(transport: transport)
        defer { fixture.cleanup() }
        await fixture.load()
        fixture.store.fetchMeta(gameId: "1", rj: "RJ123456")
        while !(await transport.started) { try await Task.sleep(for: .milliseconds(10)) }
        fixture.store.deleteGame(id: "1")
        try #require(fixture.store.game(id: "1") == nil)
        let newGame = GameRecord(id: "1", gameTitle: "新游戏", gamePath: "/new/Game.exe", gameEngine: "nwjs")
        try #require(JSONStore.save(GameMap(games: ["1": newGame]), to: fixture.directory.appendingPathComponent("games.json")) == nil)
        await fixture.store.load(dataDirectory: fixture.directory.path)
        await transport.release(page())
        try await Task.sleep(for: .milliseconds(60))
        #expect(fixture.store.game(id: "1")?.gameTitle == "新游戏")
        #expect(GameMetaStore.load(dataDir: fixture.directory.path, gameId: "1") == nil)
    }
}

@Suite("作品查找界面布局", .serialized)
@MainActor
struct DLsiteScrapingPresentationTests {
    @Test("生产视图的查找、候选、预览与丰富详情均可渲染", arguments: ["查找", "候选", "预览", "详情"])
    func layouts(state: String) async throws {
        let page = """
        <script type="application/ld+json">{"@type":"Product","sku":"RJ123456","name":"SCRAPING SAMPLE","description":"用于验证作品预览的简介，不对应真实在售作品。"}</script>
        """
        let hit = """
        <title>検索結果</title><div data-list_item_product_id="RJ123456"><dd class="work_name"><a title="SCRAPING SAMPLE">作品</a></dd><dd class="maker_name"><a>示例社团</a></dd></div>
        """
        let fixture = try ScrapingFixture(transport: DLsiteSequenceTransport([(200, state == "候选" ? hit : page)]))
        defer { fixture.cleanup() }
        await fixture.load()
        fixture.store.beginManualRJ(gameId: "1")
        if state == "候选" {
            fixture.store.searchMeta(gameId: "1", keyword: "SCRAPING SAMPLE", category: "maniax")
            try await fixture.waitUntil { !fixture.store.searchingGameIDs.contains("1") }
            try #require(fixture.store.searchHits["1"]?.count == 1)
        } else if state == "预览" {
            fixture.store.fetchMeta(gameId: "1", rj: "RJ123456", preview: true)
            try await fixture.waitUntil { !fixture.store.fetchingMeta.contains("1") }
            try #require(fixture.store.metaPreviews["1"] != nil)
        }
        let view: AnyView
        if state == "详情" {
            let work = DlsiteWork(rj: "RJ123456", title: "SCRAPING SAMPLE", circle: "示例社团", workType: "RPG",
                                  description: String(repeating: "这是带有换行的完整作品介绍，用于检查正文的折叠与排版。\n", count: 30),
                                  fetchedAt: "2026-11-16T12:00:00Z", releaseDate: "2021-12-17", series: "示例系列",
                                  tags: ["冒险", "角色扮演"], languages: ["JPN", "ENG", "CHI_HANS"],
                                  creators: ["示例制作"], voiceActors: ["示例配音"], supportedSystems: "Windows 10 / Windows 11")
            try #require(fixture.store.updateMeta(gameId: "1", meta: GameDlsiteMeta(work: work)))
            view = AnyView(GameDetailView(game: fixture.game))
        } else { view = AnyView(ManualRJSheet(gameId: "1")) }
        _ = NSApplication.shared
        let size = state == "详情" ? NSSize(width: 980, height: 1000) : NSSize(width: 700, height: 640)
        let hosting = NSHostingView(rootView: view.environmentObject(fixture.store)
            .environment(\.colorScheme, .dark).background(Color(nsColor: .windowBackgroundColor)))
        let window = NSWindow(contentRect: NSRect(origin: NSPoint(x: -6000, y: -6000), size: size),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = hosting
        window.orderFrontRegardless()
        defer { window.close() }
        try await Task.sleep(for: .milliseconds(200))
        hosting.layoutSubtreeIfNeeded()
        let bitmap = try #require(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
        hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
        #expect(!UISnapshot.checkBlank(bitmap))
        if state != "查找" {
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["zh-Hans", "en-US"]
            request.usesLanguageCorrection = false
            try VNImageRequestHandler(cgImage: #require(bitmap.cgImage)).perform([request])
            let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
            #expect(text.uppercased().contains("SCRAPING SAMPLE"), "作品标题被裁切或未显示：\(text)")
            if state == "候选" { #expect(text.contains("预览"), "候选预览按钮被压缩或未显示：\(text)") }
        }
        if let directory = ProcessInfo.processInfo.environment["TSUMIGEYA_SCRAPING_UI_DIR"] {
            try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            let png = try #require(bitmap.representation(using: .png, properties: [:]))
            try png.write(to: URL(fileURLWithPath: directory).appendingPathComponent("scraping-\(state).png"))
        }
        if state == "预览" { #expect(fixture.store.meta(for: "1") == nil) }
    }
}
