import Foundation
import Testing
@testable import TsumigeyaCore

private struct AssistFixture {
    let root: URL
    let project: RPGMakerProject
    init(mz: Bool = false) throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("assist-\(UUID().uuidString)")
        let content = mz ? root : root.appendingPathComponent("www")
        try FileManager.default.createDirectory(at: content.appendingPathComponent("js"), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: content.appendingPathComponent("data"), withIntermediateDirectories: true)
        try Data("{\"main\":\"\(mz ? "" : "www/")index.html\",\"unknown\":true}".utf8).write(to: root.appendingPathComponent("package.json"))
        try Data("<!doctype html><html><head></head><body><script src=\"js/main.js\"></script></body></html>".utf8).write(to: content.appendingPathComponent("index.html"))
        try Data("// core".utf8).write(to: content.appendingPathComponent("js/\(mz ? "rmmz" : "rpg")_core.js"))
        try Data(#"{"gameTitle":"冒険","variables":["","好感度"],"switches":["","扉"],"terms":{"messages":{"x":"%1 の勝利！"}}}"#.utf8).write(to: content.appendingPathComponent("data/System.json"))
        project = try RPGMakerProject.detect(folder: root.path)
    }
    func clean() { try? FileManager.default.removeItem(at: root) }
}

@Suite("翻译与作弊：接入和数据安全")
struct AssistanceTests {
    @Test("译文目录和条目保留未知字段，重复条目拒绝覆盖")
    func preserveCatalogFields() throws {
        let f = try AssistFixture(); defer { f.clean() }
        let data = Data(("{\"identity\":\"" + f.project.identity + "\",\"entries\":[{\"source\":\"冒険\",\"target\":\"冒险\",\"contexts\":[],\"futureEntry\":{\"value\":42}}],\"futureCatalog\":[true,null]}").utf8)
        var catalog = try JSONDecoder().decode(TranslationCatalog.self, from: data)
        catalog.entries[0].target = "修订冒险"
        try TranslationFiles.save(catalog, project: f.project, dataDir: f.root.path)
        let saved = try TranslationFiles.load(project: f.project, dataDir: f.root.path)
        #expect(saved.unknownFields["futureCatalog"] == .array([.bool(true), .null]))
        #expect(saved.entries[0].unknownFields["futureEntry"] == .object(["value": .int(42)]))
        catalog.entries.append(catalog.entries[0])
        #expect(throws: (any Error).self) { try TranslationFiles.save(catalog, project: f.project, dataDir: f.root.path) }
        #expect(try TranslationFiles.load(project: f.project, dataDir: f.root.path) == saved)
    }
    @Test("只更新接入开关时保留已有译文")
    func preserveInstalledDictionary() throws {
        let f = try AssistFixture(); defer { f.clean() }
        try AssistanceInstaller.configure(f.project, options: .init(translation: true, cheats: false), translations: ["冒険": "手改冒险"], running: false)
        try AssistanceInstaller.configure(f.project, options: .init(translation: true, cheats: true), running: false)
        let url = AssistanceInstaller.location(f.project).appendingPathComponent("translations.json")
        let saved = try JSONDecoder().decode([String: String].self, from: Data(contentsOf: url))
        #expect(saved == ["冒険": "手改冒险"])
    }
    @Test("MV 与 MZ 的真实入口定位，安装可精确恢复")
    func roundtrip() throws {
        for mz in [false, true] {
            let f = try AssistFixture(mz: mz); defer { f.clean() }
            #expect(f.project.edition == (mz ? "MZ" : "MV"))
            let before = try Data(contentsOf: f.project.page)
            try AssistanceInstaller.configure(f.project, options: .init(translation: true, cheats: false), translations: ["冒険": "冒险"], running: false)
            #expect(try AssistanceInstaller.options(f.project) == .init(translation: true, cheats: false))
            let installed = try String(contentsOf: f.project.page, encoding: .utf8)
            #expect(installed.contains("data-tsumigeya-assist"))
            #expect(installed.contains("js/main.js"))
            let dir = AssistanceInstaller.location(f.project)
            #expect(FileManager.default.fileExists(atPath: dir.appendingPathComponent("cheats.js").path))
            try AssistanceInstaller.configure(f.project, options: .init(translation: false, cheats: true), translations: [:], running: false)
            #expect(try AssistanceInstaller.options(f.project) == .init(translation: false, cheats: true))
            try AssistanceInstaller.restore(f.project, running: false)
            #expect(try Data(contentsOf: f.project.page) == before)
            #expect(!FileManager.default.fileExists(atPath: dir.path))
        }
    }
    @Test("运行中拒绝安装与恢复，修改过的入口不能被恢复覆盖")
    func refuseUnsafe() throws {
        let f = try AssistFixture(); defer { f.clean() }
        #expect(throws: (any Error).self) { try AssistanceInstaller.configure(f.project, options: .init(), translations: [:], running: true) }
        try AssistanceInstaller.configure(f.project, options: .init(cheats: true), translations: [:], running: false)
        #expect(throws: (any Error).self) { try AssistanceInstaller.restore(f.project, running: true) }
        let changed = Data("user changed".utf8); try changed.write(to: f.project.page)
        #expect(throws: (any Error).self) { try AssistanceInstaller.restore(f.project, running: false) }
        #expect(try Data(contentsOf: f.project.page) == changed)
    }
    @Test("损坏备份与辅助目录符号链接都不能写入")
    func backups() throws {
        let f = try AssistFixture(); defer { f.clean() }
        try AssistanceInstaller.configure(f.project, options: .init(), translations: [:], running: false)
        try Data("bad".utf8).write(to: AssistanceInstaller.location(f.project).appendingPathComponent("original.html"))
        #expect(throws: (any Error).self) { try AssistanceInstaller.configure(f.project, options: .init(), translations: [:], running: false) }
        let other = try AssistFixture(); defer { other.clean() }
        try FileManager.default.createSymbolicLink(at: AssistanceInstaller.location(other.project), withDestinationURL: f.root)
        #expect(throws: (any Error).self) { try AssistanceInstaller.configure(other.project, options: .init(), translations: [:], running: false) }
    }
    @Test("不把普通 NW.js 或越界页面认作 MV/MZ")
    func strictDetection() throws {
        let f = try AssistFixture(); defer { f.clean() }
        try Data(#"{"main":"../outside.html"}"#.utf8).write(to: f.root.appendingPathComponent("package.json"))
        #expect(throws: (any Error).self) { try RPGMakerProject.detect(folder: f.root.path) }
    }
    @Test("提取仅处理文字字段，忽略脚本、资源名和插件命令")
    func extraction() throws {
        let f = try AssistFixture(); defer { f.clean() }
        let map = #"{"displayName":"森","events":[null,{"id":1,"name":"内部事件名","pages":[{"list":[{"code":401,"parameters":["こんにちは\\V[1]"]},{"code":102,"parameters":[["はい","いいえ"],0]},{"code":355,"parameters":["doNotTranslate()"]},{"code":356,"parameters":["Plugin arg"]}]}]}]}"#
        try Data(map.utf8).write(to: f.project.content.appendingPathComponent("data/Map001.json"))
        let entries = try RPGTextExtractor.extract(f.project), sources = Set(entries.map(\.source))
        #expect(sources.contains("森")); #expect(sources.contains("はい")); #expect(sources.contains("こんにちは\\V[1]"))
        #expect(!sources.contains("doNotTranslate()")); #expect(!sources.contains("内部事件名")); #expect(!sources.contains("Plugin arg"))
        #expect(sources.contains("%1 の勝利！"))
    }
    @Test("控制符完整往返，错误和重复占位符拒收")
    func tokens() throws {
        let source = #"\C[2]こんにちは\V[1] %1 <b>名前</b>"#
        let (protected, tokens) = TranslationTokens.protect(source)
        #expect(!protected.contains("\\C[2]"))
        let restored = try TranslationTokens.restore(protected.replacingOccurrences(of: "こんにちは", with: "你好"), tokens: tokens)
        try TranslationTokens.validate(source: source, target: restored)
        #expect(throws: (any Error).self) { try TranslationTokens.validate(source: source, target: "你好") }
        #expect(throws: (any Error).self) { try TranslationTokens.restore(protected + "⟦TSMG_0⟧", tokens: tokens) }
    }
    @Test("导入校验全部通过才合并，修订保留，损坏原件不覆盖")
    func catalog() throws {
        let f = try AssistFixture(); defer { f.clean() }
        let dataDir = f.root.appendingPathComponent("launcher").path
        #expect(throws: (any Error).self) { try TranslationFiles.imported(Data(#"{"a":{"x":"b"}}"#.utf8)) }
        #expect(throws: (any Error).self) { try TranslationFiles.imported(Data(#"{"\\V[1]":"坏译文"}"#.utf8)) }
        var catalog = TranslationCatalog(identity: f.project.identity)
        catalog.merge(try TranslationFiles.imported(Data(#"{"冒険":"手动修订"}"#.utf8)))
        catalog.merge(try RPGTextExtractor.extract(f.project))
        #expect(catalog.dictionary["冒険"] == "手动修订")
        try TranslationFiles.save(catalog, project: f.project, dataDir: dataDir)
        #expect(try TranslationFiles.load(project: f.project, dataDir: dataDir) == catalog)
        let url = TranslationFiles.url(project: f.project, dataDir: dataDir)
        try Data("broken".utf8).write(to: url)
        #expect(throws: (any Error).self) { try TranslationFiles.save(catalog, project: f.project, dataDir: dataDir) }
        #expect(try String(contentsOf: url, encoding: .utf8) == "broken")
    }
    @Test("备份失败停止全部更新，未知配置字段不丢失")
    func updateBackups() throws {
        let f = try AssistFixture(); defer { f.clean() }
        try AssistanceInstaller.configure(f.project, options: .init(cheats: true), translations: [:], running: false)
        let dir = AssistanceInstaller.location(f.project), config = dir.appendingPathComponent("config.json")
        var fields = try JSONDecoder().decode([String: JSONValue].self, from: Data(contentsOf: config)); fields["future"] = .string("keep")
        try JSONEncoder().encode(fields).write(to: config)
        let before = try Data(contentsOf: dir.appendingPathComponent("translations.json"))
        try FileManager.default.createDirectory(at: Backup.path(for: config), withIntermediateDirectories: false)
        #expect(throws: (any Error).self) { try AssistanceInstaller.configure(f.project, options: .init(translation: true), translations: ["a": "b"], running: false) }
        #expect(try Data(contentsOf: dir.appendingPathComponent("translations.json")) == before)
        try FileManager.default.removeItem(at: Backup.path(for: config))
        try AssistanceInstaller.configure(f.project, options: .init(translation: true), translations: ["a": "b"], running: false)
        let saved = try JSONDecoder().decode([String: JSONValue].self, from: Data(contentsOf: config))
        #expect(saved["future"] == .string("keep")); #expect(saved["translation"] == .bool(true))
    }
    @Test("运行时补译更新和捕获文件路径校验")
    func liveFiles() throws {
        let f = try AssistFixture(); defer { f.clean() }
        try AssistanceInstaller.configure(f.project, options: .init(translation: true), translations: [:], running: false)
        let dir = AssistanceInstaller.location(f.project), captured = dir.appendingPathComponent("missing.json")
        try JSONEncoder().encode(["新しい文字"]).write(to: captured)
        #expect(try AssistanceInstaller.capturedText(f.project).first?.source == "新しい文字")
        try AssistanceInstaller.updateTranslations(f.project, translations: ["新しい文字": "新文字"])
        #expect(try JSONDecoder().decode([String: String].self, from: Data(contentsOf: dir.appendingPathComponent("translations.json")))["新しい文字"] == "新文字")
        try FileManager.default.removeItem(at: captured)
        try FileManager.default.createSymbolicLink(at: captured, withDestinationURL: f.project.page)
        #expect(throws: (any Error).self) { try AssistanceInstaller.capturedText(f.project) }
    }
    @Test("翻译服务地址限制与密钥 URL 注入防护")
    func endpoints() {
        var s = TranslationServiceSettings()
        for bad in ["http://example.com/v1/chat/completions", "file:///tmp/a", "https://user:pass@example.com/x", "https://example.com/?key=abc"] { s.endpoint = bad; #expect(s.url == nil) }
        s.endpoint = "http://127.0.0.1:8000/v1/chat/completions"; #expect(s.url != nil)
        s.endpoint = "https://example.com/v1/chat/completions"; #expect(s.url != nil)
    }
}

@Suite("翻译接口行为")
struct TranslationServiceTests {
    @Test("真实请求结构、凭据和占位符还原")
    func request() async throws {
        var settings = TranslationServiceSettings(); settings.endpoint = "https://example.com/v1/chat/completions"; settings.model = "test-model"
        let service = TranslationService(settings: settings, key: "test-secret", transport: { request in
            #expect(request.httpMethod == "POST")
            #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer test-secret")
            let body = try JSONDecoder().decode(JSONValue.self, from: request.httpBody!)
            #expect(body.objectValue?["model"]?.stringValue == "test-model")
            let text = body.objectValue?["messages"]?.arrayValue?.last?.objectValue?["content"]?.stringValue
            #expect(text == "こんにちは⟦TSMG_0⟧")
            let data = Data(#"{"choices":[{"message":{"content":"你好⟦TSMG_0⟧"}}]}"#.utf8)
            return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        })
        #expect(try await service.translate("こんにちは\\V[1]") == "你好\\V[1]")
    }
    @Test("HTTP 错误、空内容和错误控制符不成为成功译文")
    func failures() async throws {
        var settings = TranslationServiceSettings(); settings.endpoint = "https://example.com/x"; settings.model = "test"
        for (status, response) in [(401, "secret response must not appear"), (200, #"{"choices":[{"message":{"content":""}}]}"#), (200, #"{"choices":[{"message":{"content":"遗漏占位符"}}]}"#)] {
            let service = TranslationService(settings: settings, key: "", transport: { request in
                (Data(response.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
            })
            await #expect(throws: (any Error).self) { try await service.translate("名前\\V[1]") }
        }
    }

    @Test("批量请求用 JSON 数组传输，占位符按行号隔离后还原")
    func batchRequest() async throws {
        var settings = TranslationServiceSettings(); settings.endpoint = "https://example.com/v1/chat/completions"; settings.model = "m"
        let service = TranslationService(settings: settings, key: "", transport: { request in
            let body = try JSONDecoder().decode(JSONValue.self, from: request.httpBody!)
            let content = body.objectValue?["messages"]?.arrayValue?.last?.objectValue?["content"]?.stringValue ?? ""
            let input = try JSONDecoder().decode([String].self, from: Data(content.utf8))
            #expect(input == ["名前⟦TSMG_0_0⟧", "場所⟦TSMG_1_0⟧"])
            let translated = try JSONEncoder().encode(["名字⟦TSMG_0_0⟧", "地点⟦TSMG_1_0⟧"])
            let payload: JSONValue = .object(["choices": .array([.object(["message": .object(["content": .string(String(decoding: translated, as: UTF8.self))])])])])
            return (try JSONEncoder().encode(payload), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        })
        let results = try await service.translateBatch(["名前%1", "場所%1"])
        #expect(results == ["名字%1", "地点%1"])
    }

    @Test("批量条数不符或占位符被改时整批失败，交给调用方回退逐条")
    func batchRejectsBadReplies() async throws {
        var settings = TranslationServiceSettings(); settings.endpoint = "https://example.com/x"; settings.model = "m"
        for reply in ["[\"只有一条\"]", "[\"甲\",\"乙\"]", "不是数组"] {
            let service = TranslationService(settings: settings, key: "", transport: { request in
                let payload: JSONValue = .object(["choices": .array([.object(["message": .object(["content": .string(reply)])])])])
                return (try JSONEncoder().encode(payload), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
            })
            await #expect(throws: (any Error).self) { try await service.translateBatch(["甲%1", "乙%2"]) }
        }
    }
}
@testable import TsumigeyaApp

@Suite("辅助功能实际调用与异步隔离", .serialized)
@MainActor
struct AssistanceStoreTests {
    private func store(_ fixture: AssistFixture) async throws -> (AppStore, GameRecord) {
        let data = fixture.root.appendingPathComponent("launcher")
        try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
        let record = GameRecord(id: "1", gameTitle: "样本", gamePath: fixture.root.appendingPathComponent("Game.exe").path, gameEngine: "nwjs")
        #expect(JSONStore.save(GameMap(games: ["1": record]), to: data.appendingPathComponent("games.json")) == nil)
        #expect(JSONStore.save(["endpoint": "https://example.com/translate", "model": "test", "targetLanguage": "简体中文"], to: data.appendingPathComponent("translation-service.json")) == nil)
        let store = AppStore(); await store.load(dataDirectory: data.path)
        // 这些用例验证逐条语义与停止条件；批量通道默认会发真实请求，在这里关掉。
        store.translateAssistanceBatch = nil
        return (store, record)
    }
    private func wait(_ session: AssistanceSession) async throws {
        for _ in 0..<150 { if !session.busy { return }; try await Task.sleep(for: .milliseconds(30)) }
        Issue.record("辅助任务没有结束")
    }
    @Test("提取、翻译、修订、安装和恢复通过生产调用完成")
    func workflow() async throws {
        let f = try AssistFixture(); defer { f.clean() }
        let (store, record) = try await store(f)
        let session = store.assistanceSession(for: record)
        session.extract(); try await wait(session)
        #expect((session.catalog?.entries.count ?? 0) > 0)
        session.catalog = TranslationCatalog(identity: f.project.identity, entries: [.init(source: "冒険")])
        store.translateAssistanceText = { _, source in source == "冒険" ? "冒险" : source }
        session.translate(); try await wait(session)
        #expect(session.catalog?.dictionary["冒険"] == "冒险")
        session.edit(source: "冒険", target: "手改冒险")
        #expect(try TranslationFiles.load(project: f.project, dataDir: store.dataDir).dictionary["冒険"] == "手改冒险")
        session.options = .init(translation: true, cheats: true); session.apply()
        #expect(session.error == nil); #expect(session.installed)
        #expect(try AssistanceInstaller.options(f.project) == session.options)
        session.restore(); #expect(session.error == nil); #expect(!session.installed)
    }
    @Test("暂停后忽略晚到结果，不把未保存条目冒充成功")
    func pauseLate() async throws {
        let f = try AssistFixture(); defer { f.clean() }
        let (store, record) = try await store(f); let session = store.assistanceSession(for: record)
        session.catalog = TranslationCatalog(identity: f.project.identity, entries: [.init(source: "原文")])
        store.translateAssistanceText = { _, _ in try? await Task.sleep(for: .milliseconds(200)); return "晚到结果" }
        session.translate(); await Task.yield(); session.pause(); try await wait(session)
        #expect(session.catalog?.dictionary.isEmpty == true)
        #expect(!FileManager.default.fileExists(atPath: TranslationFiles.url(project: f.project, dataDir: store.dataDir).path))
    }
    @Test("接口拒绝请求时立即停止，不对其余文本重复发送")
    func rejectedServiceStopsQueue() async throws {
        let f = try AssistFixture(); defer { f.clean() }
        let (store, record) = try await store(f); let session = store.assistanceSession(for: record)
        session.catalog = TranslationCatalog(identity: f.project.identity, entries: [.init(source: "一"), .init(source: "二")])
        store.translateAssistanceText = { _, _ in throw TranslationHTTPFailure(status: 401) }
        session.translate(); try await wait(session)
        #expect(session.error != nil)
        #expect(session.catalog?.entries.filter { $0.failure != nil }.count == 1)
        #expect(session.catalog?.completed == 0)
    }
    @Test("批量通道一次覆盖整批，逐条通道不再被调用")
    func batchChannelTranslatesWholeSlice() async throws {
        let f = try AssistFixture(); defer { f.clean() }
        let (store, record) = try await store(f); let session = store.assistanceSession(for: record)
        session.catalog = TranslationCatalog(identity: f.project.identity, entries: [.init(source: "一"), .init(source: "二")])
        store.translateAssistanceBatch = { _, sources in sources.map { "译:" + $0 } }
        store.translateAssistanceText = { _, _ in throw AssistanceError.invalid("不该走单条") }
        session.translate(); try await wait(session)
        #expect(session.catalog?.entries.allSatisfy { $0.failure == nil } == true)
        #expect(session.catalog?.dictionary == ["一": "译:一", "二": "译:二"])
    }
    @Test("移除游戏和复用编号后旧翻译不能回写")
    func deletion() async throws {
        let f = try AssistFixture(); defer { f.clean() }
        let (store, record) = try await store(f); let old = store.assistanceSession(for: record)
        old.catalog = TranslationCatalog(identity: f.project.identity, entries: [.init(source: "旧游戏")])
        store.translateAssistanceText = { _, _ in try? await Task.sleep(for: .milliseconds(150)); return "晚到结果" }
        old.translate(); await Task.yield(); store.deleteGame(id: record.id)
        #expect(!old.isCurrent)
        #expect(store.games.isEmpty)
        let replacement = try AssistFixture(mz: true); defer { replacement.clean() }
        #expect(store.addGame(title: "替换游戏", folder: replacement.root.path, engine: "nwjs"))
        let newRecord = try #require(store.games.first)
        #expect(newRecord.id == record.id)
        let newSession = store.assistanceSession(for: newRecord)
        #expect(newSession !== old); #expect(newSession.catalog?.dictionary.isEmpty == true)
        try await Task.sleep(for: .milliseconds(250))
        #expect(!FileManager.default.fileExists(atPath: TranslationFiles.url(project: f.project, dataDir: store.dataDir).path))
    }
    @Test("主动暂停停止网络翻译且损坏目录禁用接入")
    func pauseAndCorruption() async throws {
        let f = try AssistFixture(); defer { f.clean() }
        let (store, record) = try await store(f); let session = store.assistanceSession(for: record)
        session.catalog = TranslationCatalog(identity: f.project.identity, entries: [.init(source: "秘密")])
        store.translateAssistanceText = { _, _ in try? await Task.sleep(for: .milliseconds(150)); return "秘密译文" }
        session.translate(); await Task.yield()
        session.pause()
        try await wait(session); #expect(session.catalog?.dictionary.isEmpty == true)
        let url = TranslationFiles.url(project: f.project, dataDir: store.dataDir)
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("broken".utf8).write(to: url)
        session.reload(); #expect(session.project == nil); #expect(session.error != nil)
        session.apply(); #expect(!FileManager.default.fileExists(atPath: AssistanceInstaller.location(f.project).path))
    }
}

@Suite("翻译真实 HTTP 验收")
struct LiveTranslationHTTPTests {
    @Test("本机接口实际收发、JSON 解码与控制符还原", .enabled(if: ProcessInfo.processInfo.environment["TSUMIGEYA_TRANSLATION_TEST_ENDPOINT"] != nil))
    func http() async throws {
        var settings = TranslationServiceSettings()
        settings.endpoint = ProcessInfo.processInfo.environment["TSUMIGEYA_TRANSLATION_TEST_ENDPOINT"]!
        settings.model = "local-test"
        let result = try await TranslationService(settings: settings, key: "").translate("こんにちは\\V[1]")
        #expect(result == "你好\\V[1]")
    }
}
