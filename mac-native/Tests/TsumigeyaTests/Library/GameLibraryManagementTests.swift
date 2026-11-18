import Foundation
import SwiftUI
import AppKit
import Vision
import Combine
import Testing
@testable import TsumigeyaCore
@testable import TsumigeyaApp

private func managementDirectory() throws -> URL {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("management-" + UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    return root
}

private func classificationMeta(_ type: String? = "RPG") -> GameDlsiteMeta {
    GameDlsiteMeta(work: DlsiteWork(rj: "RJ123456", title: "资料名称", workType: type,
                                    fetchedAt: "2026-11-17", tags: ["不应成为主分类"]))
}

@Suite("游戏库自动分类与手动覆盖")
struct LibraryClassificationTests {
    @Test("只接管游戏类型，题材和站点分区不建主分类", arguments: ["RPG", "ADV", "SLN", "ACT", "ACN", "PZL", "SOU", "UNKNOWN", ""])
    func typeMapping(_ type: String) throws {
        let root = try managementDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        #expect(GameMetaStore.save(dataDir: root.path, gameId: "1", meta: classificationMeta(type)) == nil)
        let loaded = LibraryMetaStore.load(dataDir: root.path).meta
        if let normalized = GameWorkType.code(type) {
            #expect(loaded.categories.count == 1)
            #expect(loaded.categories.values.first?.sourceWorkType == normalized)
            #expect(loaded.assignments["1"]?.count == 1)
        } else { #expect(loaded.categories.isEmpty); #expect(loaded.assignments.isEmpty) }
        #expect(!loaded.categories.values.contains { $0.name == "不应成为主分类" })
    }

    @Test("旧库接管保留人工归属，改类型只替换自动部分，恢复后只留自动类型")
    func legacyAndOverrides() throws {
        let root = try managementDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        let original: [String: JSONValue] = ["categories": .object(["favorite": .object(["name": .string("收藏"), "order": .int(1), "future": .bool(true)])]),
            "assignments": .object(["1": .array([.string("favorite")])]), "future": .object(["keep": .bool(true)]),
            "1": .object(["extension": .string("保留"), "dlsite": .object(["future": .int(42)])])]
        try #require(JSONStore.save(original, to: root.appendingPathComponent("library-meta.json")) == nil)
        try #require(GameMetaStore.save(dataDir: root.path, gameId: "1", meta: classificationMeta()) == nil)
        var loaded = LibraryMetaStore.load(dataDir: root.path)
        let rpg = try #require(loaded.meta.categories.first { $0.value.sourceWorkType == "RPG" }?.key)
        #expect(Set(loaded.meta.assignments["1"] ?? []) == ["favorite", rpg])
        _ = try LibraryClassification.change(.membership(gameID: "1", categoryID: rpg, member: false), dataDir: root.path)
        #expect(GameMetaStore.save(dataDir: root.path, gameId: "1", meta: classificationMeta()) == nil)
        #expect(LibraryMetaStore.load(dataDir: root.path).meta.assignments["1"] == ["favorite"])
        #expect(GameMetaStore.save(dataDir: root.path, gameId: "1", meta: classificationMeta("ADV")) == nil)
        loaded = LibraryMetaStore.load(dataDir: root.path)
        let adv = try #require(loaded.meta.categories.first { $0.value.sourceWorkType == "ADV" }?.key)
        #expect(Set(loaded.meta.assignments["1"] ?? []) == ["favorite", adv])
        _ = try LibraryClassification.change(.restoreAutomatic(gameID: "1"), dataDir: root.path)
        loaded = LibraryMetaStore.load(dataDir: root.path)
        #expect(loaded.meta.assignments["1"] == [adv])
        #expect(loaded.raw["future"] == original["future"])
        #expect(loaded.raw["1"]?.objectValue?["extension"] == .string("保留"))
        #expect(loaded.raw["1"]?.objectValue?["dlsite"]?.objectValue?["future"] == .int(42))
        #expect(loaded.raw["categories"]?.objectValue?["favorite"]?.objectValue?["future"] == .bool(true))
    }

    @Test("类型分类重命名保持来源与编号，删除后刷新不复活，明确重建可重新启用")
    func renameAndDelete() throws {
        let root = try managementDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        try #require(GameMetaStore.save(dataDir: root.path, gameId: "1", meta: classificationMeta()) == nil)
        let id = try #require(LibraryMetaStore.load(dataDir: root.path).meta.categories.keys.first)
        _ = try LibraryClassification.change(.rename(id: id, name: "我的角色扮演"), dataDir: root.path)
        #expect(GameMetaStore.save(dataDir: root.path, gameId: "1", meta: classificationMeta()) == nil)
        var loaded = LibraryMetaStore.load(dataDir: root.path).meta
        #expect(loaded.categories.count == 1)
        #expect(loaded.categories[id]?.name == "我的角色扮演")
        _ = try LibraryClassification.change(.delete(id: id), dataDir: root.path)
        #expect(GameMetaStore.save(dataDir: root.path, gameId: "1", meta: classificationMeta()) == nil)
        _ = try LibraryClassification.change(.restoreAutomatic(gameID: "1"), dataDir: root.path)
        #expect(LibraryMetaStore.load(dataDir: root.path).meta.categories.isEmpty)
        loaded = try LibraryClassification.change(.create(name: "角色扮演", gameIDs: ["1"]), dataDir: root.path)
        #expect(loaded.categories.count == 1)
        #expect(loaded.assignments["1"]?.count == 1)
    }

    @Test("人工添加同名类型分类复用，手动勾选在类型变更后仍然保留")
    func explicitPin() throws {
        let root = try managementDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        let created = try LibraryClassification.change(.create(name: "角色扮演", gameIDs: []), dataDir: root.path)
        let id = try #require(created.categories.keys.first)
        _ = try LibraryClassification.change(.membership(gameID: "1", categoryID: id, member: true), dataDir: root.path)
        #expect(GameMetaStore.save(dataDir: root.path, gameId: "1", meta: classificationMeta()) == nil)
        #expect(LibraryMetaStore.load(dataDir: root.path).meta.categories.count == 1)
        #expect(GameMetaStore.save(dataDir: root.path, gameId: "1", meta: classificationMeta("PZL")) == nil)
        #expect(LibraryMetaStore.load(dataDir: root.path).meta.assignments["1"]?.contains(id) == true)
    }

    @Test("资料及自动分类一次提交，备份失败不部分保存，损坏原件不覆盖")
    func writeSafety() throws {
        let root = try managementDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("library-meta.json")
        try #require(GameMetaStore.save(dataDir: root.path, gameId: "1", meta: classificationMeta()) == nil)
        let before = try Data(contentsOf: url)
        try FileManager.default.createDirectory(at: url.appendingPathExtension("bak"), withIntermediateDirectories: true)
        #expect(GameMetaStore.save(dataDir: root.path, gameId: "1", meta: classificationMeta("ADV")) != nil)
        #expect(try Data(contentsOf: url) == before)
        let broken = Data("{broken".utf8); try broken.write(to: url)
        #expect(throws: (any Error).self) { try LibraryClassification.change(.reconcile(gameIDs: ["1"]), dataDir: root.path) }
        #expect(try Data(contentsOf: url) == broken)
    }

    @Test("重载接管幂等，不改写无变化的旁挂文件")
    func idempotent() throws {
        let root = try managementDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        #expect(GameMetaStore.save(dataDir: root.path, gameId: "1", meta: classificationMeta()) == nil)
        let url = root.appendingPathComponent("library-meta.json")
        let before = try Data(contentsOf: url)
        _ = try LibraryClassification.change(.reconcile(gameIDs: ["1"]), dataDir: root.path)
        #expect(try Data(contentsOf: url) == before)
        #expect(!FileManager.default.fileExists(atPath: url.appendingPathExtension("bak").path))
    }
}

private actor ClassificationTransport: DLsiteTransport {
    private var waiting: CheckedContinuation<Void, Never>?
    private var held: Bool
    private(set) var started = false
    private(set) var requests = 0
    init(hold: Bool = false) { held = hold }
    func fetch(url: String, timeout: TimeInterval) async throws -> (status: Int, body: String) {
        started = true
        requests += 1
        if held { await withCheckedContinuation { waiting = $0 } }
        return (200, "<script>var contents = {\"detail\":[{\"id\":\"RJ123456\",\"name\":\"网络分类作品\",\"work_type\":\"RPG\"}]};</script>")
    }
    func release() { held = false; waiting?.resume(); waiting = nil }
}

@Suite("游戏管理统一入口、状态与删除协调", .serialized)
@MainActor
struct GameLibraryManagementTests {
    private func prepare(_ root: URL, transport: (any DLsiteTransport)? = nil) async throws -> AppStore {
        let folder = root.appendingPathComponent("old")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data().write(to: folder.appendingPathComponent("data.xp3"))
        let store = AppStore(dlsiteService: transport.map { DLsiteService(dataDir: root.path, transport: $0, minIntervalMs: 0) })
        await store.load(dataDirectory: root.path)
        try #require(store.addGame(title: "本地游戏", folder: folder.path, engine: "kirikiri"))
        return store
    }
    private func stop(_ store: AppStore) { store.metadata.cancelAll(); store.cancelBatchMeta(); store.stopRunningPoll() }

    @Test("所有修改入口都拒绝坏原件和备份失败，失败不发布新状态", arguments: ["add", "update", "batch", "relocate", "saveDirectory"])
    func sharedWriteSafety(_ operation: String) async throws {
        let root = try managementDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        let store = try await prepare(root); defer { stop(store) }
        let old = try #require(store.games.first)
        let other = root.appendingPathComponent("other")
        try FileManager.default.createDirectory(at: other, withIntermediateDirectories: true)
        try Data().write(to: other.appendingPathComponent("data.xp3"))
        let url = root.appendingPathComponent("games.json")
        let original = try Data(contentsOf: url)
        let candidate = LibraryIntake.Candidate(folder: other.path, title: "另一个", engine: "kirikiri")
        func run() -> Bool {
            switch operation {
            case "add": return store.addGame(title: "另一个", folder: other.path, engine: "kirikiri")
            case "update": return store.updateGame(id: "1", title: "已修改", engine: "kirikiri", gameArgs: [:])
            case "batch": return store.addBatch([candidate])
            case "relocate": return store.relocateGame(old, folder: other.path)
            default: return store.setSaveDirectoryOverride(gameId: "1", path: root.path)
            }
        }
        try FileManager.default.createDirectory(at: url.appendingPathExtension("bak"), withIntermediateDirectories: true)
        #expect(!run()); #expect(store.games == [old]); #expect(try Data(contentsOf: url) == original)
        let broken = Data("{broken".utf8); try broken.write(to: url)
        #expect(!run()); #expect(store.games == [old]); #expect(try Data(contentsOf: url) == broken)
        #expect(FileManager.default.fileExists(atPath: url.path))
    }

    @Test("修改前重新读取磁盘，不覆盖外部新增和扩展字段")
    func freshDiskRead() async throws {
        let root = try managementDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        let store = try await prepare(root); defer { stop(store) }
        let file = GameLibraryFile(dataDir: root.path)
        var map = try file.read()
        map.games["1"]?.unknownFields["future"] = .bool(true)
        map.games["2"] = GameRecord(id: "2", gameTitle: "外部添加", gamePath: "/external/Game.exe", gameEngine: "nwjs")
        try #require(JSONStore.save(map, to: root.appendingPathComponent("games.json")) == nil)
        #expect(store.updateGame(id: "1", title: "新名称", engine: "kirikiri", gameArgs: [:]))
        #expect(store.games.count == 2)
        #expect(store.game(id: "1")?.unknownFields["future"] == .bool(true))
    }

    @Test("删除预检坏游玩记录时不先清理资料")
    func deletePreflight() async throws {
        let root = try managementDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        let store = try await prepare(root); defer { stop(store) }
        #expect(store.updateMeta(gameId: "1", meta: classificationMeta()))
        let metaURL = root.appendingPathComponent("library-meta.json")
        let original = try Data(contentsOf: metaURL)
        try Data("{broken".utf8).write(to: root.appendingPathComponent("play-stats.json"))
        store.deleteGame(id: "1")
        #expect(store.games.count == 1)
        #expect(store.operationError?.contains("尚未保存任何删除步骤") == true)
        #expect(try Data(contentsOf: metaURL) == original)
    }

    @Test("删除各阶段失败明确已保存范围，保留编号并能重试", arguments: ["library-meta.json", "play-stats.json", "games.json"])
    func deletePartialAndRetry(_ blocked: String) async throws {
        let root = try managementDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        let store = try await prepare(root); defer { stop(store) }
        #expect(store.updateMeta(gameId: "1", meta: classificationMeta()))
        let stats = root.appendingPathComponent("play-stats.json")
        #expect(JSONStore.save(["1": JSONValue.int(10), "future": .bool(true)], to: stats) == nil)
        let backup = root.appendingPathComponent(blocked).appendingPathExtension("bak")
        if FileManager.default.fileExists(atPath: backup.path) { try FileManager.default.removeItem(at: backup) }
        try FileManager.default.createDirectory(at: backup, withIntermediateDirectories: true)
        store.deleteGame(id: "1")
        #expect(store.games.count == 1)
        #expect(store.operationError?.contains("重试") == true)
        if blocked == "library-meta.json" {
            #expect(store.operationError?.contains("尚未保存任何删除步骤") == true)
            #expect(store.meta(for: "1") != nil)
        } else {
            #expect(store.operationError?.contains("已保存：作品资料和分类归属") == true)
            #expect(store.meta(for: "1") == nil)
            #expect(store.assignments["1"] == nil)
        }
        if blocked == "games.json" { #expect(store.operationError?.contains("、游玩记录") == true) }
        try FileManager.default.removeItem(at: backup)
        store.deleteGame(id: "1")
        #expect(store.operationError == nil); #expect(store.games.isEmpty)
        #expect(store.addGame(title: "替换游戏", folder: root.path, engine: "nwjs"))
        #expect(store.games.first?.id == "1")
        #expect(store.meta(for: "1") == nil); #expect(store.assignments["1"] == nil)
        #expect(JSONStore.load([String: JSONValue].self, from: stats).value == ["future": .bool(true)])
        let entry = LibraryMetaStore.load(dataDir: root.path).raw["1"]
        #expect(entry == nil)
    }

    @Test("删除拒绝外部已经替换的同编号记录，旁挂数据不动")
    func staleDelete() async throws {
        let root = try managementDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        let store = try await prepare(root); defer { stop(store) }
        #expect(store.updateMeta(gameId: "1", meta: classificationMeta()))
        let before = try Data(contentsOf: root.appendingPathComponent("library-meta.json"))
        let file = GameLibraryFile(dataDir: root.path)
        _ = try file.update(id: "1", title: "外部替换", engine: "kirikiri", gameArgs: [:])
        store.deleteGame(id: "1")
        #expect(store.operationError?.contains("记录发生变化") == true)
        #expect(try Data(contentsOf: root.appendingPathComponent("library-meta.json")) == before)
    }

    @Test("预览不归类，确认和直接抓取更新分类与筛选；刷新保留手动移除")
    func metadataEntryPoints() async throws {
        let root = try managementDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        let transport = ClassificationTransport()
        let store = try await prepare(root, transport: transport); defer { stop(store) }
        store.fetchMeta(gameId: "1", rj: "RJ123456", preview: true)
        await store.metadata.waitForFetch(gameId: "1")
        #expect(store.categories.isEmpty)
        #expect(store.applyMetaPreview(gameId: "1"))
        let id = try #require(store.categories.first { $0.value.sourceWorkType == "RPG" }?.key)
        store.activeCategory = id
        #expect(store.filteredGames.map(\.id) == ["1"])
        #expect(store.groups.first?.id == id)
        store.setCategoryMembership(gameId: "1", categoryId: id, member: false)
        store.fetchMeta(gameId: "1", rj: "RJ123456", refresh: true)
        await store.metadata.waitForFetch(gameId: "1")
        #expect(store.assignments["1"] == nil)
        store.restoreAutomaticClassification(gameId: "1")
        #expect(store.assignments["1"] == [id])
        store.deleteCategory(id: id)
        #expect(store.activeCategory == nil)
        store.searchText = "网络分类作品"
        #expect(store.filteredGames.count == 1)
        await store.load(dataDirectory: root.path)
        #expect(store.categories.isEmpty)
    }

    @Test("删除部分失败后旧抓取也不能重新创建资料和分类归属")
    func lateResultAfterPartialDelete() async throws {
        let root = try managementDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        let transport = ClassificationTransport(hold: true)
        let store = try await prepare(root, transport: transport); defer { stop(store) }
        #expect(store.updateMeta(gameId: "1", meta: classificationMeta()))
        store.fetchMeta(gameId: "1", rj: "RJ123456", refresh: true)
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while !(await transport.started), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
        try #require(await transport.started)
        var waiterStarted = false
        let task = Task { waiterStarted = true; await store.metadata.waitForFetch(gameId: "1") }
        while !waiterStarted { await Task.yield() }
        try FileManager.default.createDirectory(at: root.appendingPathComponent("games.json.bak"), withIntermediateDirectories: true)
        store.deleteGame(id: "1")
        await transport.release(); await task.value
        #expect(store.games.count == 1)
        #expect(GameMetaStore.load(dataDir: root.path, gameId: "1") == nil)
        #expect(store.assignments["1"] == nil)
    }

    @Test("删除部分失败会撤销尚未开始的批量项，不影响其他游戏")
    func queuedResultAfterPartialDelete() async throws {
        let root = try managementDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        let transport = ClassificationTransport(hold: true)
        let store = try await prepare(root, transport: transport); defer { stop(store) }
        let other = root.appendingPathComponent("other")
        try FileManager.default.createDirectory(at: other, withIntermediateDirectories: true)
        try #require(store.addGame(title: "第二项", folder: other.path, engine: "kirikiri"))
        for id in ["1", "2"] { try #require(store.updateMeta(gameId: id, meta: classificationMeta())) }
        store.prepareBatchMeta(refreshAssociated: true); store.startBatchMeta()
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        while !(await transport.started), ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
        try #require(await transport.started)
        let backup = root.appendingPathComponent("games.json.bak")
        try FileManager.default.removeItem(at: backup)
        try FileManager.default.createDirectory(at: backup, withIntermediateDirectories: true)
        store.deleteGame(id: "2")
        try #require(store.operationError != nil)
        await transport.release()
        let finish = ContinuousClock.now.advanced(by: .seconds(3))
        while store.batchMetaRunning, ContinuousClock.now < finish { try await Task.sleep(for: .milliseconds(5)) }
        #expect(!store.batchMetaRunning)
        #expect(await transport.requests == 1)
        #expect(store.batchMetaItems.first { $0.id == "1" }?.state == .saved)
        #expect(store.batchMetaItems.first { $0.id == "2" }?.state == .skipped)
        #expect(GameMetaStore.load(dataDir: root.path, gameId: "2") == nil)
        #expect(store.assignments["2"] == nil)
    }

    @Test("资料分类接管旧库且重启保留人工覆盖，子状态通知转发到应用")
    func migrationAndNotifications() async throws {
        let root = try managementDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        let store = try await prepare(root); defer { stop(store) }
        let raw: [String: JSONValue] = ["categories": .object(["manual": .object(["name": .string("我的收藏"), "order": .int(1)])]),
            "assignments": .object(["1": .array([.string("manual")])]),
            "1": .object(["dlsite": .object(["rj": .string("RJ123456"), "workType": .string("RPG"), "fetchedAt": .string("old")])])]
        try #require(JSONStore.save(raw, to: root.appendingPathComponent("library-meta.json")) == nil)
        await store.load(dataDirectory: root.path)
        let id = try #require(store.categories.first { $0.value.sourceWorkType == "RPG" }?.key)
        #expect(Set(store.assignments["1"] ?? []) == ["manual", id])
        var notifications = 0
        let subscription = store.objectWillChange.sink { notifications += 1 }
        defer { subscription.cancel() }
        store.searchText = "本地"
        #expect(notifications > 0)
        notifications = 0
        store.setCategoryMembership(gameId: "1", categoryId: id, member: false)
        #expect(notifications > 0)
        #expect(store.library.manualClassificationGameIDs.contains("1"))
        await store.load(dataDirectory: root.path)
        #expect(store.assignments["1"] == ["manual"])
        #expect(store.updateMeta(gameId: "1", meta: classificationMeta()))
        #expect(store.assignments["1"] == ["manual"])
        store.restoreAutomaticClassification(gameId: "1")
        #expect(!store.library.manualClassificationGameIDs.contains("1"))
        #expect(store.assignments["1"] == [id])
    }

    @Test("生产分类编辑控件可渲染且按钮和类型文案完整", arguments: ["empty", "auto", "manual"])
    func classificationPresentation(state: String) async throws {
        let hasMetadata = state != "empty"
        let root = try managementDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        let store = try await prepare(root); defer { stop(store) }
        if hasMetadata {
            #expect(store.updateMeta(gameId: "1", meta: classificationMeta()))
            #expect(store.createCategory(name: "我的收藏"))
            if state == "manual", let id = store.categories.first(where: { $0.value.sourceWorkType == nil })?.key {
                store.setCategoryMembership(gameId: "1", categoryId: id, member: true)
            }
        }
        _ = NSApplication.shared
        let hosting = NSHostingView(rootView: VStack(alignment: .leading, spacing: 18) {
            Text("游戏分类").font(.title2)
            GameClassificationEditor(gameID: "1")
            Spacer()
        }.padding(24).environmentObject(store).environment(\.colorScheme, .dark)
            .frame(width: 640, height: 480).background(Color(nsColor: .windowBackgroundColor)))
        let window = NSWindow(contentRect: NSRect(x: -6000, y: -6000, width: 640, height: 480),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false; window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = hosting; window.orderFrontRegardless()
        defer { window.close() }
        try await Task.sleep(for: .milliseconds(200))
        hosting.layoutSubtreeIfNeeded()
        let bitmap = try #require(hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
        hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
        #expect(!UISnapshot.checkBlank(bitmap))
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate; request.recognitionLanguages = ["zh-Hans", "en-US"]
        try VNImageRequestHandler(cgImage: #require(bitmap.cgImage)).perform([request])
        let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
        #expect(text.contains("恢复自动分类"), "恢复入口未显示：\(text)")
        #expect(text.contains(hasMetadata ? "角色扮演" : "暂无分类"), "分类内容未显示：\(text)")
        if let output = ProcessInfo.processInfo.environment["TSUMIGEYA_CLASSIFICATION_UI_DIR"] {
            try FileManager.default.createDirectory(atPath: output, withIntermediateDirectories: true)
            let png = try #require(bitmap.representation(using: .png, properties: [:]))
            try png.write(to: URL(fileURLWithPath: output).appendingPathComponent("classification-\(state).png"))
        }
    }

    @Test("Wine 添加、编辑与重新定位保留所选入口和环境身份")
    func wineUsesUnifiedFlow() async throws {
        let root = try managementDirectory(); defer { try? FileManager.default.removeItem(at: root) }
        let first = root.appendingPathComponent("first"), second = root.appendingPathComponent("second")
        for folder in [first, second] {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try wineTestPE().write(to: folder.appendingPathComponent("实际入口.exe"))
            try wineTestPE().write(to: folder.appendingPathComponent("配置.exe"))
        }
        let store = AppStore(); defer { stop(store) }; await store.load(dataDirectory: root.path)
        #expect(store.addGame(title: "Windows 游戏", folder: first.path, engine: "wine", entryPath: first.appendingPathComponent("实际入口.exe").path))
        let original = try #require(store.games.first)
        #expect(store.updateGame(id: original.id, title: "改名", engine: "wine", gameArgs: ["locale": .string("zh_CN.UTF-8")]))
        let edited = try #require(store.games.first)
        #expect(store.relocateGame(edited, folder: second.path))
        #expect(store.games.first?.gamePath == second.appendingPathComponent("实际入口.exe").path)
        #expect(store.games.first?.wineEnvironmentIdentity == original.wineEnvironmentIdentity)
        #expect(store.games.first?.gameArgs?["locale"] == .string("zh_CN.UTF-8"))
    }
}
