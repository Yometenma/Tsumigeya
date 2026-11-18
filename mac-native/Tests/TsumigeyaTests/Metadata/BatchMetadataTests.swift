import AppKit
import SwiftUI
import Vision
import Foundation
import Testing
@testable import TsumigeyaCore
@testable import TsumigeyaApp

private actor BatchTransport: DLsiteTransport {
    var requests: [String] = []
    var failures: Set<String> = []
    var held = false
    var waiting: CheckedContinuation<Void, Never>?

    func fail(_ rj: String, enabled: Bool) {
        if enabled { failures.insert(rj) } else { failures.remove(rj) }
    }
    func hold() { held = true }
    func release() { held = false; waiting?.resume(); waiting = nil }
    func fetch(url: String, timeout: TimeInterval) async throws -> (status: Int, body: String) {
        requests.append(url)
        if held { await withCheckedContinuation { waiting = $0 } }
        if url.contains("/fsr/") {
            return (200, #"<title>検索結果</title><div data-list_item_product_id="RJ123456"><dd class="work_name"><a title="候选作品">候选作品</a></dd></div>"#)
        }
        let rj = RJNumber.candidates(in: url).first ?? "RJ123456"
        if failures.contains(rj) { return (503, "") }
        return (200, """
        <script type="application/ld+json">{"@type":"Product","sku":"\(rj)","name":"网络作品","description":"网络介绍"}</script>
        """)
    }
}

@MainActor
private final class BatchFixture {
    let dir: URL
    let store: AppStore
    let transport: BatchTransport
    init(_ games: [GameRecord], transport: BatchTransport = BatchTransport()) throws {
        self.transport = transport
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("batch-meta-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try #require(JSONStore.save(GameMap(games: Dictionary(uniqueKeysWithValues: games.map { ($0.id, $0) })), to: dir.appendingPathComponent("games.json")) == nil)
        store = AppStore(dlsiteService: DLsiteService(dataDir: dir.path, transport: transport, minIntervalMs: 0))
    }
    func load() async { await store.load(dataDirectory: dir.path) }
    func cleanup() { store.cancelBatchMeta(); try? FileManager.default.removeItem(at: dir) }
    func wait(_ condition: () -> Bool) async throws {
        let end = ContinuousClock.now.advanced(by: .seconds(4))
        while !condition(), ContinuousClock.now < end { try await Task.sleep(for: .milliseconds(10)) }
        try #require(condition(), "批量操作未在期限内完成")
    }
}

@Suite("批量刮削：范围、确认、失败重试及取消", .serialized)
@MainActor
struct BatchMetadataTests {
    func game(_ id: String, _ path: String, title: String = "本地游戏") -> GameRecord {
        GameRecord(id: id, gameTitle: title, gamePath: path, gameEngine: "nwjs")
    }

    @Test("唯一编号自动补全，名称搜索即使只有一条也不自动关联")
    func exactAndSearch() async throws {
        let f = try BatchFixture([game("1", "/fixture/RJ123456/Game.exe"), game("2", "/fixture/Unknown/Game.exe")])
        defer { f.cleanup() }
        await f.load()
        f.store.prepareBatchMeta(refreshAssociated: false)
        f.store.startBatchMeta()
        try await f.wait { !f.store.batchMetaRunning }
        #expect(f.store.batchMetaItems.map(\.state) == [.saved, .needsConfirmation])
        #expect(f.store.meta(for: "1")?.work.rj == "RJ123456")
        #expect(f.store.meta(for: "2") == nil)
        #expect(f.store.searchHits["2"]?.count == 1)
        #expect(f.store.game(id: "1")?.gameTitle == "本地游戏")
        f.store.selectSearchHit(gameId: "2", rj: "RJ123456")
        try await f.wait { !f.store.fetchingMeta.contains("2") }
        #expect(f.store.applyMetaPreview(gameId: "2"))
        #expect(f.store.batchMetaItems.last?.state == .saved)
    }

    @Test("刷新保留手改，默认跳过已关联，使用当前筛选范围")
    func scopeAndEdits() async throws {
        let f = try BatchFixture([game("1", "/fixture/RJ123456/Game.exe", title: "保留"), game("2", "/fixture/RJ654321/Game.exe", title: "排除")])
        defer { f.cleanup() }
        await f.load()
        #expect(f.store.updateMeta(gameId: "1", meta: GameDlsiteMeta(work: DlsiteWork(rj: "RJ123456", description: "手写内容", fetchedAt: "old"), editedFields: ["description"])))
        f.store.prepareBatchMeta(refreshAssociated: false)
        #expect(f.store.batchMetaItems.map(\.id) == ["2"])
        f.store.searchText = "保留"
        f.store.prepareBatchMeta(refreshAssociated: true)
        #expect(f.store.batchMetaItems.map(\.id) == ["1"])
        f.store.startBatchMeta()
        try await f.wait { !f.store.batchMetaRunning }
        #expect(f.store.meta(for: "1")?.work.description == "手写内容")
        #expect(f.store.meta(for: "1")?.work.title == "网络作品")
        #expect(f.store.meta(for: "2") == nil)
    }

    @Test("多个编号不能随意选第一个")
    func ambiguousNumbers() async throws {
        let f = try BatchFixture([game("1", "/fixture/RJ123456-RJ654321/Game.exe")])
        defer { f.cleanup() }
        await f.load()
        f.store.prepareBatchMeta(refreshAssociated: false)
        f.store.startBatchMeta()
        try await f.wait { !f.store.batchMetaRunning }
        #expect(f.store.batchMetaItems.first?.state == .needsConfirmation)
        #expect(f.store.meta(for: "1") == nil)
        #expect(await f.transport.requests.isEmpty)
    }

    @Test("单项失败不阻断队列，重试不重复已保存项")
    func failureAndRetry() async throws {
        let f = try BatchFixture([game("1", "/fixture/RJ123456/Game.exe"), game("2", "/fixture/RJ654321/Game.exe")])
        defer { f.cleanup() }
        await f.load()
        await f.transport.fail("RJ123456", enabled: true)
        f.store.prepareBatchMeta(refreshAssociated: false)
        f.store.startBatchMeta()
        try await f.wait { !f.store.batchMetaRunning }
        #expect(f.store.batchMetaItems.map(\.state) == [.failed, .saved])
        let before = await f.transport.requests.count
        await f.transport.fail("RJ123456", enabled: false)
        f.store.startBatchMeta(retryFailures: true)
        try await f.wait { !f.store.batchMetaRunning }
        #expect(f.store.batchMetaItems.allSatisfy { $0.state == .saved })
        #expect(await f.transport.requests.count == before + 1)
    }

    @Test("重试失败项不启动尚未开始的项目")
    func retryOnlyFailures() async throws {
        let f = try BatchFixture([game("1", "/fixture/RJ123456/Game.exe"), game("2", "/fixture/RJ654321/Game.exe")])
        defer { f.cleanup() }
        await f.load()
        f.store.prepareBatchMeta(refreshAssociated: false)
        f.store.startBatchMeta(retryFailures: true)
        #expect(!f.store.batchMetaRunning)
        #expect(f.store.batchMetaItems.allSatisfy { $0.state == .pending })
        #expect(await f.transport.requests.isEmpty)
    }

    @Test("关闭后晚到结果不能落盘，重新打开可继续")
    func cancelLateResult() async throws {
        let f = try BatchFixture([game("1", "/fixture/RJ123456/Game.exe"), game("2", "/fixture/RJ654321/Game.exe")])
        defer { f.cleanup() }
        await f.load()
        await f.transport.hold()
        f.store.prepareBatchMeta(refreshAssociated: false)
        f.store.startBatchMeta()
        let end = ContinuousClock.now.advanced(by: .seconds(3))
        while await f.transport.requests.isEmpty, ContinuousClock.now < end { try await Task.sleep(for: .milliseconds(10)) }
        try #require(await !f.transport.requests.isEmpty)
        f.store.closeBatchMeta()
        await f.transport.release()
        try await Task.sleep(for: .milliseconds(50))
        #expect(f.store.meta(for: "1") == nil)
        #expect(f.store.meta(for: "2") == nil)
        #expect(f.store.batchMetaItems.allSatisfy { $0.state == .pending })
        f.store.startBatchMeta()
        try await f.wait { !f.store.batchMetaRunning }
        #expect(f.store.batchMetaItems.allSatisfy { $0.state == .saved })
    }

    @Test("列表准备后删除并复用编号，旧快照不得处理新游戏")
    func replacedID() async throws {
        let f = try BatchFixture([game("1", "/fixture/RJ123456/Game.exe")])
        defer { f.cleanup() }
        await f.load()
        f.store.prepareBatchMeta(refreshAssociated: false)
        f.store.deleteGame(id: "1")
        let new = game("1", "/fixture/RJ654321/Game.exe")
        try #require(JSONStore.save(GameMap(games: ["1": new]), to: f.dir.appendingPathComponent("games.json")) == nil)
        await f.load()
        f.store.startBatchMeta()
        try await f.wait { !f.store.batchMetaRunning }
        #expect(f.store.batchMetaItems.first?.state == .skipped)
        #expect(f.store.meta(for: "1") == nil)
        #expect(await f.transport.requests.isEmpty)
    }

    @Test("磁盘保存失败明确标失败，不冒充已保存")
    func storageFailure() async throws {
        let f = try BatchFixture([game("1", "/fixture/RJ123456/Game.exe")])
        defer { f.cleanup() }
        await f.load()
        try Data("{broken".utf8).write(to: f.dir.appendingPathComponent("library-meta.json"))
        f.store.prepareBatchMeta(refreshAssociated: false)
        f.store.startBatchMeta()
        try await f.wait { !f.store.batchMetaRunning }
        #expect(f.store.batchMetaItems.first?.state == .failed)
        #expect(f.store.meta(for: "1") == nil)
        #expect(try String(contentsOf: f.dir.appendingPathComponent("library-meta.json"), encoding: .utf8) == "{broken")
    }
    @Test("关闭后恢复上次准备范围和处理方式")
    func rememberedMode() async throws {
        let f = try BatchFixture([game("1", "/fixture/RJ123456/Game.exe")])
        defer { f.cleanup() }
        await f.load()
        f.store.prepareBatchMeta(refreshAssociated: true)
        f.store.closeBatchMeta()
        #expect(f.store.batchMetaRefreshAssociated)
        #expect(f.store.batchMetaItems.map(\.id) == ["1"])
        #expect(f.store.batchMetaItems.first?.state == .pending)
    }

    @Test("主动暂停批量请求，晚到响应不落盘")
    func pauseCancels() async throws {
        let f = try BatchFixture([game("1", "/fixture/RJ123456/Game.exe")])
        defer { f.cleanup() }
        await f.load()
        await f.transport.hold()
        f.store.prepareBatchMeta(refreshAssociated: false)
        f.store.startBatchMeta()
        let end = ContinuousClock.now.advanced(by: .seconds(3))
        while await f.transport.requests.isEmpty, ContinuousClock.now < end {
            try await Task.sleep(for: .milliseconds(10))
        }
        try #require(await !f.transport.requests.isEmpty)
        f.store.cancelBatchMeta()
        #expect(!f.store.batchMetaRunning)
        await f.transport.release()
        try await Task.sleep(for: .milliseconds(50))
        #expect(f.store.meta(for: "1") == nil)
        #expect(f.store.batchMetaItems.first?.state == .pending)
    }

    @Test("真实网络：全年龄批量保存和名称候选不自动关联",
          .enabled(if: ProcessInfo.processInfo.environment["TSUMIGEYA_LIVE_SCRAPING"] == "1"))
    func liveBatch() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("batch-live-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let records = [game("1", "/fixture/RJ118525/Game.exe"), game("2", "/fixture/Unknown/Game.exe", title: "東方の迷宮")]
        try #require(JSONStore.save(GameMap(games: Dictionary(uniqueKeysWithValues: records.map { ($0.id, $0) })), to: directory.appendingPathComponent("games.json")) == nil)
        let store = AppStore()
        defer { store.cancelBatchMeta(); try? FileManager.default.removeItem(at: directory) }
        await store.load(dataDirectory: directory.path)
        store.prepareBatchMeta(refreshAssociated: false)
        store.startBatchMeta()
        let end = ContinuousClock.now.advanced(by: .seconds(120))
        while store.batchMetaRunning, ContinuousClock.now < end { try await Task.sleep(for: .milliseconds(100)) }
        try #require(!store.batchMetaRunning, "真实网络批量任务超时")
        #expect(store.batchMetaItems.map(\.state) == [.saved, .needsConfirmation])
        let work = try #require(GameMetaStore.load(dataDir: directory.path, gameId: "1")?.work)
        #expect(work.rj == "RJ118525")
        #expect(work.category == "home")
        #expect((work.description?.count ?? 0) > 300)
        #expect(work.sampleImageURLs.count == 3)
        #expect(!(store.searchHits["2"] ?? []).isEmpty)
        #expect(GameMetaStore.load(dataDir: directory.path, gameId: "2") == nil)
    }

    @Test("批量生产界面的状态、确认和失败重试按钮未被裁切", .enabled(if: ProcessInfo.processInfo.environment["TSUMIGEYA_UI_TESTS"] == "1"))
    func layout() async throws {
        let f = try BatchFixture([game("1", "/fixture/RJ123456/Game.exe", title: "保存项目"),
                                  game("2", "/fixture/Unknown/Game.exe", title: "待核对项目"),
                                  game("3", "/fixture/RJ654321/Game.exe", title: "失败项目")])
        defer { f.cleanup() }
        await f.load()
        await f.transport.fail("RJ654321", enabled: true)
        f.store.prepareBatchMeta(refreshAssociated: false)
        f.store.startBatchMeta()
        try await f.wait { !f.store.batchMetaRunning }
        try #require(f.store.batchMetaItems.map(\.state) == [.saved, .needsConfirmation, .failed])
        _ = NSApplication.shared
        let hosting = NSHostingView(rootView: BatchMetadataView().environmentObject(f.store)
            .environment(\.colorScheme, .dark).background(Color(nsColor: .windowBackgroundColor)))
        let window = NSWindow(contentRect: NSRect(x: -6000, y: -6000, width: 800, height: 650),
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
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: #require(bitmap.cgImage)).perform([request])
        let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
        for label in ["批量补全作品信息", "查找并确认", "重试失败项", "保存项目", "待核对项目", "失败项目"] {
            #expect(text.contains(label), "界面缺少可读的控件或状态：\(label)；\(text)")
        }
        if let directory = ProcessInfo.processInfo.environment["TSUMIGEYA_SCRAPING_UI_DIR"] {
            try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            try #require(bitmap.representation(using: .png, properties: [:])).write(to:
                URL(fileURLWithPath: directory).appendingPathComponent("scraping-批量补全.png"))
        }
    }

}
