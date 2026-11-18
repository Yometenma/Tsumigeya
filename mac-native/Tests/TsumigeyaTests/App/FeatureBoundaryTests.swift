import Foundation
import Darwin
import Combine
import Testing
@testable import TsumigeyaApp
@testable import TsumigeyaCore

private actor BoundaryTransport: DLsiteTransport {
    private var held = true
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private(set) var requests = 0

    func fetch(url: String, timeout: TimeInterval) async throws -> (status: Int, body: String) {
        requests += 1
        if held { await withCheckedContinuation { waiting.append($0) } }
        return (200, """
        <script type="application/ld+json">{"@type":"Product","sku":"RJ123456","name":"迟到作品"}</script>
        """)
    }

    func release() {
        held = false
        let pending = waiting
        waiting.removeAll()
        pending.forEach { $0.resume() }
    }
}

@MainActor
private final class BoundaryFixture {
    let directory: URL
    let store: AppStore
    let game: GameRecord
    var saves: URL { directory.appendingPathComponent("game/save") }
    var slot: URL { saves.appendingPathComponent("file1.rpgsave") }

    init(engine: String = "nwjs", transport: (any DLsiteTransport)? = nil) throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("boundaries-" + UUID().uuidString)
        let folder = directory.appendingPathComponent("game")
        try FileManager.default.createDirectory(at: folder.appendingPathComponent("save"), withIntermediateDirectories: true)
        try #"{"main":"index.html"}"#.write(to: folder.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)
        game = GameRecord(id: "1", gameTitle: "边界测试", gamePath: folder.appendingPathComponent("Game.exe").path, gameEngine: engine)
        try Data().write(to: URL(fileURLWithPath: game.gamePath))
        let directory = self.directory
        let service = transport.map { DLsiteService(dataDir: directory.path, transport: $0, minIntervalMs: 0) }
        store = AppStore(dlsiteService: service)
        try #require(JSONStore.save(GameMap(games: [game.id: game]), to: directory.appendingPathComponent("games.json")) == nil)
    }

    func load() async { await store.load(dataDirectory: directory.path) }
    func cleanup() {
        store.cancelBatchMeta()
        store.metadata.cancelAll()
        store.stopRunningPoll()
        try? FileManager.default.removeItem(at: directory)
    }
}

@Suite("功能职责边界：存档、资料与应用协调", .serialized)
@MainActor
struct FeatureBoundaryTests {
    private func waitForRequest(_ transport: BoundaryTransport) async throws {
        let end = ContinuousClock.now.advanced(by: .seconds(3))
        while await transport.requests == 0, ContinuousClock.now < end {
            try await Task.sleep(for: .milliseconds(10))
        }
        try #require(await transport.requests > 0, "未发起测试请求")
    }

    @Test("存档会话通过真实归档完成导出导入，保留覆盖前备份")
    func saveRoundtrip() async throws {
        let f = try BoundaryFixture()
        defer { f.cleanup() }
        await f.load()
        try Data("导出前存档".utf8).write(to: f.slot)
        let session = f.store.saveSession(for: f.game)
        session.reload()
        #expect(session.canExport)
        #expect(session.listing?.items.map(\.name) == ["file1.rpgsave"])
        let output = f.directory.appendingPathComponent("exports")
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        session.exportArchive(outputDirectory: output.path)
        try #require(session.message?.isError == false, "\(String(describing: session.message))")
        #expect(!session.isWorking)
        let archive = try #require(FileManager.default.contentsOfDirectory(at: output, includingPropertiesForKeys: nil).first { $0.pathExtension == "zip" })
        try Data("导入前存档".utf8).write(to: f.slot)
        session.importArchive(at: archive)
        #expect(session.message?.isError == false)
        #expect(!session.isWorking)
        #expect(try Data(contentsOf: f.slot) == Data("导出前存档".utf8))
        #expect(try Data(contentsOf: f.slot.appendingPathExtension("tsumigeya-bak")) == Data("导入前存档".utf8))
    }

    @Test("未知位置与空目录保持区分，修改目录后仍复用当前会话")
    func directoryStates() async throws {
        let f = try BoundaryFixture(engine: "tyrano")
        defer { f.cleanup() }
        await f.load()
        let session = f.store.saveSession(for: f.game)
        session.reload()
        #expect(session.listing?.dir == nil)
        session.setDirectory(f.saves.path)
        #expect(session.listing?.dir == f.saves.path)
        #expect(session.listing?.items.isEmpty == true)
        #expect(!session.canExport)
        let updated = try #require(f.store.game(id: "1"))
        #expect(f.store.saveSession(for: updated) === session)
        session.setDirectory(nil)
        #expect(session.listing?.dir == nil)
        #expect(session.overridePath == nil)
    }

    @Test("旧视图再次索取会话不能使当前存档会话失效")
    func stalePresentationDoesNotEvictCurrentSession() async throws {
        let f = try BoundaryFixture(engine: "tyrano")
        defer { f.cleanup() }
        await f.load()
        let current = f.store.saveSession(for: f.game)
        current.setDirectory(f.saves.path)
        let updated = try #require(f.store.game(id: "1"))
        #expect(f.store.saveSession(for: updated) === current)
        let stale = f.store.saveSession(for: f.game)
        #expect(stale !== current)
        #expect(f.store.saveSession(for: updated) === current)
        current.setDirectory(nil)
        #expect(current.message?.isError == false)
        #expect(f.store.game(id: "1")?.saveDirectoryOverride == nil)
        stale.setDirectory(f.saves.path)
        #expect(stale.message?.isError == true)
        #expect(f.store.game(id: "1")?.saveDirectoryOverride == nil)
    }

    @Test("运行检查位于会话边界，真实进程存活时拒绝导入导出和目录修改")
    func saveRunningGuard() async throws {
        let f = try BoundaryFixture(engine: "kirikiri")
        defer { f.cleanup() }
        await f.load()
        try Data("原存档".utf8).write(to: f.slot)
        let binary = URL(fileURLWithPath: BinaryPaths.depsDir(f.directory.path, "kirikiri", "krkrsdl2"))
        try FileManager.default.createDirectory(at: binary.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "#!/bin/sh\nexec /bin/sleep 30\n".write(to: binary, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: binary.path)
        f.store.launch(game: f.game)
        let pid = try #require(f.store.runningGames[f.game.id])
        defer { kill(pid, SIGKILL) }
        let session = f.store.saveSession(for: f.game)
        let output = f.directory.appendingPathComponent("blocked")
        session.exportArchive(outputDirectory: output.path)
        #expect(session.message?.isError == true)
        #expect(session.message?.text.contains("正在运行") == true)
        #expect(!FileManager.default.fileExists(atPath: output.path))
        session.importArchive(at: f.directory.appendingPathComponent("missing.zip"))
        #expect(session.message?.text.contains("正在运行") == true)
        session.setDirectory(f.saves.path)
        #expect(session.message?.text.contains("正在运行") == true)
        #expect(f.store.game(id: "1")?.saveDirectoryOverride == nil)
        #expect(try Data(contentsOf: f.slot) == Data("原存档".utf8))
    }

    @Test("无效归档保留原存档，失败后会话不残留工作状态")
    func invalidArchiveKeepsSaves() async throws {
        let f = try BoundaryFixture()
        defer { f.cleanup() }
        await f.load()
        try Data("原存档".utf8).write(to: f.slot)
        let archive = f.directory.appendingPathComponent("invalid.zip")
        try Data("不是存档包".utf8).write(to: archive)
        let session = f.store.saveSession(for: f.game)
        session.importArchive(at: archive)
        #expect(session.message?.isError == true)
        #expect(!session.isWorking)
        #expect(try Data(contentsOf: f.slot) == Data("原存档".utf8))
        #expect(!FileManager.default.fileExists(atPath: f.slot.appendingPathExtension("tsumigeya-bak").path))
    }

    @Test("会话失效后不能导出或修改目录")
    func invalidatedSaveGuard() async throws {
        let f = try BoundaryFixture()
        defer { f.cleanup() }
        await f.load()
        try Data("原存档".utf8).write(to: f.slot)
        let session = f.store.saveSession(for: f.game)
        session.invalidate()
        let output = f.directory.appendingPathComponent("blocked")
        session.exportArchive(outputDirectory: output.path)
        #expect(session.message?.isError == true)
        #expect(!FileManager.default.fileExists(atPath: output.path))
        session.setDirectory(f.directory.path)
        #expect(f.store.game(id: "1")?.saveDirectoryOverride == nil)
        #expect(try Data(contentsOf: f.slot) == Data("原存档".utf8))
    }

    @Test("删除后复用编号不能通过旧存档会话写入新记录")
    func staleSaveSession() async throws {
        let f = try BoundaryFixture()
        defer { f.cleanup() }
        await f.load()
        let old = f.store.saveSession(for: f.game)
        f.store.deleteGame(id: "1")
        #expect(f.store.addGame(title: "新游戏", folder: f.directory.path, engine: "nwjs"))
        let replacement = try #require(f.store.games.first)
        #expect(replacement.id == "1")
        old.setDirectory(f.saves.path)
        #expect(old.message?.isError == true)
        #expect(f.store.game(id: "1")?.saveDirectoryOverride == nil)
        #expect(f.store.saveSession(for: replacement) !== old)
    }

    @Test("重新加载使旧存档会话失效，即使记录内容相同")
    func reloadInvalidatesSaveSession() async throws {
        let f = try BoundaryFixture()
        defer { f.cleanup() }
        await f.load()
        let old = f.store.saveSession(for: f.game)
        await f.load()
        old.setDirectory(f.saves.path)
        #expect(old.message?.isError == true)
        #expect(f.store.game(id: "1")?.saveDirectoryOverride == nil)
        #expect(f.store.saveSession(for: f.game) !== old)
    }

    @Test("资料模块无需 AppStore 即可独立读写，拒绝不存在的游戏")
    func metadataHasIndependentBoundary() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let game = GameRecord(id: "1", gameTitle: "独立资料", gamePath: "/fixture/Game.exe", gameEngine: "nwjs")
        let metadata = LibraryMetadataStore()
        var cached: [String: GameDlsiteMeta] = [:]
        metadata.readMeta = { cached[$0] }
        metadata.didSave = { id, meta, _ in cached[id] = meta }
        metadata.currentGame = { $0 == game.id ? game : nil }
        metadata.reset(dataDirectory: directory.path)
        let value = GameDlsiteMeta(work: DlsiteWork(rj: "RJ123456", title: "独立保存", fetchedAt: "test"))
        #expect(metadata.updateMeta(gameId: "1", meta: value))
        #expect(GameMetaStore.load(dataDir: directory.path, gameId: "1")?.work.title == "独立保存")
        #expect(!metadata.updateMeta(gameId: "missing", meta: value))
        #expect(metadata.metaError["missing"] != nil)
        #expect(GameMetaStore.load(dataDir: directory.path, gameId: "missing") == nil)
    }

    @Test("请求期间记录变化，即使没有显式取消也不能接受旧响应")
    func changedRecordRejectsResponse() async throws {
        let transport = BoundaryTransport()
        let f = try BoundaryFixture(transport: transport)
        defer { f.cleanup(); Task { await transport.release() } }
        await f.load()
        f.store.fetchMeta(gameId: "1", rj: "RJ123456")
        try await waitForRequest(transport)
        #expect(f.store.updateGame(id: "1", title: "修改后的记录", engine: "nwjs", gameArgs: [:]))
        await transport.release()
        await f.store.metadata.waitForFetch(gameId: "1")
        #expect(f.store.meta(for: "1") == nil)
        #expect(f.store.fetchingMeta.isEmpty)
    }

    @Test("作品资料和队列各自的状态变化都会通知应用观察者")
    func forwardsFeatureChanges() async throws {
        let f = try BoundaryFixture()
        defer { f.cleanup() }
        await f.load()
        var changes = 0
        let subscription = f.store.objectWillChange.sink { _ in changes += 1 }
        defer { subscription.cancel() }
        #expect(f.store.metadata.updateMeta(gameId: "1", meta: GameDlsiteMeta(work: DlsiteWork(rj: "RJ123456", title: "资料标题", fetchedAt: "test"))))
        #expect(changes > 0)
        #expect(f.store.gameMeta["1"]?.work.title == "资料标题")
        changes = 0
        f.store.batchMetadata.prepareBatchMeta(games: [f.game], refreshAssociated: true)
        #expect(changes > 0)
        #expect(f.store.batchMetaItems.map(\.id) == ["1"])
    }

    @Test("重载取消旧资料请求并重建内存快照，迟到响应不能重新写入")
    func reloadInvalidatesMetadata() async throws {
        let transport = BoundaryTransport()
        let f = try BoundaryFixture(transport: transport)
        defer { f.cleanup(); Task { await transport.release() } }
        await f.load()
        #expect(f.store.updateMeta(gameId: "1", meta: GameDlsiteMeta(work: DlsiteWork(rj: "RJ654321", title: "旧缓存", fetchedAt: "test"))))
        f.store.fetchMeta(gameId: "1", rj: "RJ123456", refresh: true)
        try await waitForRequest(transport)
        await f.load()
        #expect(f.store.gameMeta["1"]?.work.rj == "RJ654321")
        #expect(f.store.fetchingMeta.isEmpty)
        await transport.release()
        try await Task.sleep(for: .milliseconds(50))
        #expect(f.store.meta(for: "1")?.work.rj == "RJ654321")
        #expect(f.store.gameMeta["1"]?.work.rj == "RJ654321")
        #expect(f.store.metaPreviews.isEmpty)
    }

    @Test("主动取消单项资料请求后迟到响应不能保存")
    func cancellationInvalidatesSingleLookup() async throws {
        let transport = BoundaryTransport()
        let f = try BoundaryFixture(transport: transport)
        defer { f.cleanup(); Task { await transport.release() } }
        await f.load()
        f.store.fetchMeta(gameId: "1", rj: "RJ123456")
        try await waitForRequest(transport)
        f.store.cancelLookup(gameId: "1")
        #expect(f.store.fetchingMeta.isEmpty)
        await transport.release()
        try await Task.sleep(for: .milliseconds(50))
        #expect(f.store.meta(for: "1") == nil)
        #expect(f.store.metaNotice.isEmpty)
    }
}
