import Foundation
import Testing
@testable import TsumigeyaCore
@testable import TsumigeyaApp

private actor MetadataRequests {
    var requests: [URLRequest] = []
    func add(_ request: URLRequest) { requests.append(request) }
}
private actor LocaleTransport: DLsiteTransport {
    var urls: [String] = []
    let unavailable: Bool
    init(unavailable: Bool = false) { self.unavailable = unavailable }
    func fetch(url: String, timeout: TimeInterval) async throws -> (status: Int, body: String) {
        urls.append(url)
        let chinese = url.contains("zh_CN")
        if unavailable && chinese { return (404, "") }
        let language = chinese ? "zh-CN" : "en-US"
        let title = chinese ? "中文标题" : "English Title"
        return (200, """
        <html lang="\(language)"><script type="application/ld+json">{"@type":"Product","sku":"RJ123456","name":"\(title)","description":"\(title) introduction","offers":{"url":"https://www.dlsite.com/home/work/=/product_id/RJ123456.html"}}</script></html>
        """)
    }
}

@Suite("作品资料语言与外部 AI 补全")
struct MetadataEnrichmentTests {
    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    private func page() -> MetadataPage {
        MetadataPage(url: URL(string: "https://store.example/game")!, html: """
        <meta property="og:image" content="https://cdn.example/cover.jpg"><script>secret instructions</script>
        <h1>Example Adventure</h1><p>Developed by Example Studio. Released 2024-05-06. Windows and Linux.</p><p>A gentle adventure through the forest.</p>
        """)
    }
    private var fields: String { #"{"title":{"value":"示例冒险","evidence":"Example Adventure"},"circle":{"value":"Example Studio","evidence":"Developed by Example Studio"},"description":{"value":"一段森林冒险。","evidence":"A gentle adventure through the forest."},"releaseDate":{"value":"2099-01-01","evidence":"no such date"},"languages":[{"value":"简体中文","evidence":"not in page"}],"coverUrl":"https://invented.example/bad.jpg"}"# }
    private func service(recorder: MetadataRequests = MetadataRequests(), mode: MetadataAPISettings.Mode = .chat, response: String? = nil) -> MetadataAIService {
        var config = MetadataAPISettings(); config.endpoint = "https://ai.example/v1/chat/completions"; config.model = "test-model"; config.mode = mode
        let content = response ?? fields
        return MetadataAIService(settings: config, key: "fixture-key") { request in
            await recorder.add(request)
            let data = try JSONEncoder().encode(JSONValue.object(["choices": .array([.object(["message": .object(["content": .string(content)])])])]))
            return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
    }
    @Test("同一 RJ 的语言缓存独立，不会返回上一次语言")
    func localeCache() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let transport = LocaleTransport(); let service = DLsiteService(dataDir: dir.path, transport: transport, minIntervalMs: 0)
        let zh = try await service.fetchWork(rj: "RJ123456", language: .simplifiedChinese).get()
        let en = try await service.fetchWork(rj: "RJ123456", language: .english).get()
        #expect(zh.title == "中文标题"); #expect(en.title == "English Title")
        #expect(zh.metadataLanguage == "zh_CN"); #expect(en.metadataLanguage == "en_US")
        _ = await service.fetchWork(rj: "RJ123456", language: .simplifiedChinese)
        #expect(await transport.urls.count == 2)
        #expect(await service.readCache(rj: "RJ123456") == nil)
        #expect(service.cachePath(rj: "RJ123456", language: .english).contains("en_US/RJ123456.json"))
    }
    @Test("优先页面不可用时回退，但不换 RJ")
    func fallback() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let transport = LocaleTransport(unavailable: true); let service = DLsiteService(dataDir: dir.path, transport: transport, minIntervalMs: 0)
        let work = try await service.fetchResolved(rj: "RJ123456", category: "home", preference: .init(preferred: .simplifiedChinese, fallback: .english)).get()
        #expect(work.title == "English Title"); #expect(work.rj == "RJ123456")
        #expect(await transport.urls.count == 2)
        #expect(await transport.urls.allSatisfy { $0.contains("RJ123456") })
    }
    @Test("关闭回退只请求指定语言")
    func noFallback() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let transport = LocaleTransport(unavailable: true); let service = DLsiteService(dataDir: dir.path, transport: transport, minIntervalMs: 0)
        guard case .failure = await service.fetchResolved(rj: "RJ123456", category: "home", preference: .init(fallback: nil)) else { Issue.record("不应获取成功"); return }
        #expect(await transport.urls.count == 1)
    }
    @Test("多语言搜索页判据与地址保留关键词编码")
    func localizedSearch() throws {
        for name in ["搜索结果", "搜尋結果", "Search Results", "検索結果", "검색 결과"] { #expect(DLsiteSearch.isResultPage("<title>\(name)</title>")) }
        let url = try #require(DLsiteSearch.searchURL(keyword: "A/B 游戏", language: .traditionalChinese))
        #expect(url.hasSuffix("?locale=zh_TW"))
        #expect(url.contains("A%2FB"))
        let special = try #require(DLsiteSearch.searchURL(keyword: "A/B?#%", language: .english))
        #expect(special.contains("A%2FB%3F%23%25"))
        #expect(MetadataLanguage.detect("<html lang='ja'>") == .japanese)
        #expect(MetadataLanguage.detect("<html lang='zh-Hant'>") == .traditionalChinese)
    }
    @Test("同一真实作品的中英文商品页分别取得本地化标题和正文")
    func realLocalizedPages() throws {
        var works: [String: DlsiteWork] = [:]
        for locale in ["zh", "en"] {
            let url = try #require(Bundle.module.url(forResource: "dlsite-localized-RJ331590-" + locale, withExtension: "html"))
            let html = try String(contentsOf: url, encoding: .utf8)
            let work: DlsiteWork = try #require(DLsiteParser.parseWork(from: html, rj: "RJ331590", fetchedAt: "fixture"))
            works[locale] = work
        }
        #expect(works["zh"]?.title?.contains("卡琳监狱") == true)
        #expect(works["en"]?.title == "Karryn's Prison")
        #expect(works["zh"]?.description?.contains("卡琳") == true)
        #expect(works["en"]?.description?.contains("Chief Warden") == true)
        #expect(works["zh"]?.description != works["en"]?.description)
        #expect(works["zh"]?.rj == works["en"]?.rj)
    }
    @Test("Responses 页面整理读取 output_text 内容")
    func responsesExtraction() async throws {
        var config = MetadataAPISettings(); config.endpoint = "https://ai.example/responses"; config.model = "test"; config.mode = .responses
        let content = fields
        let service = MetadataAIService(settings: config, key: "") { request in
            let json = JSONValue.object(["output": .array([.object(["type": .string("message"), "content": .array([.object(["type": .string("output_text"), "text": .string(content)])])])])])
            return (try JSONEncoder().encode(json), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        #expect(try await service.extract(page: page(), language: .english).title == "示例冒险")
    }
    @Test("模型只能提供有引文的资料，不能编造图片、语言或日期")
    func evidence() throws {
        let work = try MetadataAIService.parse(text: fields, page: page(), language: .simplifiedChinese)
        #expect(work.title == "示例冒险"); #expect(work.circle == "Example Studio")
        #expect(work.releaseDate == nil); #expect(work.languages.isEmpty)
        #expect(work.coverUrl == "https://cdn.example/cover.jpg")
        #expect(work.rj.isEmpty); #expect(work.isExternal); #expect(work.sourceURLs == ["https://store.example/game"])
        #expect(work.fieldEvidence["title"] == "Example Adventure")
    }
    @Test("损坏 JSON 和无出处标题不能成为成功草稿")
    func invalidOutput() {
        for text in ["not json", #"{"title":{"value":"捏造标题","evidence":"not in page"}}"#, "[]"] {
            #expect(throws: MetadataFailure.self) { try MetadataAIService.parse(text: text, page: page(), language: .english) }
        }
    }
    @Test("空白引文无效，真实日期引文不能为另一个日期背书")
    func misleadingEvidence() throws {
        let whitespace = #"{"title":{"value":"捏造标题","evidence":"   \n  "}}"#
        #expect(throws: MetadataFailure.self) { try MetadataAIService.parse(text: whitespace, page: page(), language: .english) }
        let json = #"{"title":{"value":"Example Adventure","evidence":"Example Adventure"},"releaseDate":{"value":"2099-01-01","evidence":"Released 2024-05-06"}}"#
        let work = try MetadataAIService.parse(text: json, page: page(), language: .english)
        #expect(work.releaseDate == nil)
        #expect(work.fieldEvidence["releaseDate"] == nil)
        let valid = json.replacingOccurrences(of: "2099-01-01", with: "2024-05-06")
        #expect(try MetadataAIService.parse(text: valid, page: page(), language: .english).releaseDate == "2024-05-06")
    }
    @Test("页面片段不改变来源身份")
    func fragments() {
        #expect(MetadataNetwork.publicURL("https://example.com/game#screenshots")?.absoluteString == "https://example.com/game")
    }
    @Test("页面去掉脚本并限制长度，只接受网页自带封面")
    func pageSafety() {
        #expect(!page().text.contains("secret instructions"))
        let long = MetadataPage(url: URL(string: "https://example.com/game")!, html: "<p>" + String(repeating: "A", count: 80_000) + "</p>")
        #expect(long.text.count == 45_000)
        let bad = MetadataPage(url: URL(string: "https://example.com")!, html: "<meta property='og:image' content='http://localhost/private'>")
        #expect(bad.cover == nil)
    }
    @Test("页面整理请求只发送必要正文，不包含游戏记录或本机路径")
    func requestContract() async throws {
        let recorder = MetadataRequests(); let service = service(recorder: recorder)
        let work = try await service.extract(page: page(), language: .english)
        #expect(work.title == "示例冒险")
        let request = try #require(await recorder.requests.first)
        let body = try JSONDecoder().decode(JSONValue.self, from: request.httpBody!)
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-key")
        #expect(body.objectValue?["model"]?.stringValue == "test-model")
        #expect(body.objectValue?["tools"] == nil)
        #expect(String(decoding: request.httpBody!, as: UTF8.self).contains("Example Adventure"))
        #expect(!String(decoding: request.httpBody!, as: UTF8.self).contains("gamePath"))
    }
    @Test("普通聊天接口不能假装联网")
    func chatCannotSearch() async throws {
        let recorder = MetadataRequests()
        await #expect(throws: MetadataFailure.self) { try await service(recorder: recorder).search(name: "Example", language: .english) }
        #expect(await recorder.requests.isEmpty)
    }
    @Test("联网候选只采纳搜索引用来源，拒绝模型正文里的假链接及本机地址")
    func webSearch() async throws {
        var config = MetadataAPISettings(); config.endpoint = "https://ai.example/v1/responses"; config.model = "search-model"; config.mode = .responses
        let recorder = MetadataRequests()
        let service = MetadataAIService(settings: config, key: "") { request in
            await recorder.add(request)
            let data = Data(#"{"output":[{"type":"message","content":[{"type":"output_text","text":"https://invented.example","annotations":[{"type":"url_citation","url":"https://store.example/game","title":"Example"},{"type":"url_citation","url":"https://127.0.0.1/private","title":"bad"},{"type":"url_citation","url":"https://store.example/game","title":"duplicate"}]}]}]}"#.utf8)
            return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        let candidates = try await service.search(name: "Example Studio 2024", language: .english)
        #expect(candidates.count == 1); #expect(candidates.first?.url == "https://store.example/game")
        let request = try #require(await recorder.requests.first)
        let body = try JSONDecoder().decode(JSONValue.self, from: request.httpBody!)
        #expect(body.objectValue?["tools"]?.arrayValue?.first?.objectValue?["type"]?.stringValue == "web_search")
    }
    @Test("接口无引用和拒绝请求给出错误，不假装成功")
    func webErrors() async throws {
        var config = MetadataAPISettings(); config.endpoint = "https://ai.example/responses"; config.model = "test"; config.mode = .responses
        for status in [200, 401, 429, 500] {
            let service = MetadataAIService(settings: config, key: "secret") { req in
                (Data(#"{"output":[]}"#.utf8), HTTPURLResponse(url: req.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
            }
            await #expect(throws: MetadataFailure.self) { try await service.search(name: "Example", language: .english) }
        }
    }
    @Test("外部资料与旧 DLsite 资料分别存储，切换和删除不丢分类及未知键")
    func storage() throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let raw: [String: JSONValue] = ["categories": .object([:]), "future": .string("keep"), "1": .object(["extension": .bool(true)])]
        #expect(GameMetaStore.writeRaw(raw, dataDir: dir.path) == nil)
        let legacy = GameDlsiteMeta(work: DlsiteWork(rj: "RJ123456", title: "DLsite", fetchedAt: "old"))
        #expect(GameMetaStore.save(dataDir: dir.path, gameId: "1", meta: legacy) == nil)
        let external = try MetadataAIService.parse(text: fields, page: page(), language: .simplifiedChinese)
        #expect(GameMetaStore.save(dataDir: dir.path, gameId: "1", meta: .init(work: external)) == nil)
        #expect(GameMetaStore.load(dataDir: dir.path, gameId: "1")?.work == external)
        #expect(GameMetaStore.loadAll(dataDir: dir.path)["1"]?.work == external)
        let saved = GameMetaStore.readRaw(dataDir: dir.path)
        #expect(saved["future"] == .string("keep")); #expect(saved["1"]?.objectValue?["extension"] == .bool(true))
        #expect(saved["1"]?.objectValue?["dlsite"]?.objectValue?["rj"] == .string("RJ123456"))
        #expect(saved["1"]?.objectValue?["workInfo"]?.objectValue?["rj"] == .string(""))
        #expect(GameMetaStore.save(dataDir: dir.path, gameId: "1", meta: legacy) == nil)
        #expect(GameMetaStore.load(dataDir: dir.path, gameId: "1")?.work.title == "DLsite")
        #expect(GameMetaStore.removeGameData(dataDir: dir.path, gameId: "1") == nil)
        #expect(GameMetaStore.loadAll(dataDir: dir.path).isEmpty)
        #expect(GameMetaStore.readRaw(dataDir: dir.path)["future"] == .string("keep"))
    }
    @Test("外部刷新保留手改字段，不同来源绝不混入旧资料")
    func mergeAndSelect() throws {
        let incoming = try MetadataAIService.parse(text: fields, page: page(), language: .simplifiedChinese)
        var old = incoming; old.title = "手改标题"; old.description = "旧介绍"
        #expect(EditedFields.merge(old: old, incoming: incoming, edited: ["title"]).title == "手改标题")
        var other = incoming; other.sourceURLs = ["https://other.example/game"]
        #expect(EditedFields.merge(old: old, incoming: other, edited: ["title"]).title == incoming.title)
        let selected = MetadataFields.selecting(incoming, existing: old, fields: ["title"])
        #expect(selected.description == "旧介绍")
        let newSelection = MetadataFields.selecting(other, existing: old, fields: ["title"])
        #expect(newSelection.description == nil); #expect(newSelection.coverUrl == nil)
        var manual = incoming; manual.source = "manual"; manual.externalID = UUID().uuidString; manual.sourceURLs = []
        #expect(manual.identity != incoming.identity)
    }
    @Test("来源 URL 和解析地址拒绝本机内网、凭据、非 HTTPS 及非常用端口", arguments: ["http://example.com", "file:///tmp/game", "https://localhost/x", "https://127.0.0.1/x", "https://2130706433/x", "https://[::1]/", "https://a.local/x", "https://a.internal/x", "https://user:pass@example.com", "https://example.com:444/x", "https://example.com./x"])
    func unsafeURLs(_ url: String) { #expect(MetadataNetwork.publicURL(url) == nil) }
    @Test("DNS 结果拒绝私有地址和映射 IPv6", arguments: ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "198.18.0.1", "::1", "::ffff:127.0.0.1", "fd12::1", "fe80::1"])
    func unsafeDNS(_ address: String) { #expect(!MetadataNetwork.globalAddress(address)) }
    @Test("模型接口允许明确配置的本机服务，远程只允许 HTTPS")
    func endpoint() {
        var config = MetadataAPISettings()
        for value in ["http://localhost:8000/v1/chat/completions", "https://ai.example/v1/responses"] { config.endpoint = value; #expect(config.url != nil) }
        for value in ["http://192.168.1.2/api", "https://u:p@ai.example/api", "https://ai.example/api?key=secret"] { config.endpoint = value; #expect(config.url == nil) }
    }
}

@Suite("外部资料：实际状态层确认与失效保护", .serialized)
@MainActor
struct ExternalMetadataStateTests {
    private func fixture() async throws -> (URL, AppStore) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let game = GameRecord(id: "1", gameTitle: "本地标题", gamePath: "/fixture/Game.exe", gameEngine: "nwjs")
        try #require(JSONStore.save(GameMap(games: ["1": game]), to: dir.appendingPathComponent("games.json")) == nil)
        let store = AppStore(); await store.load(dataDirectory: dir.path)
        return (dir, store)
    }
    private func installService(_ store: AppStore, delay: Bool = false) {
        var settings = MetadataAPISettings(); settings.endpoint = "https://ai.example/chat"; settings.model = "fixture"
        store.metadata.aiService = {
            MetadataAIService(settings: settings, key: "") { request in
                if delay { try? await Task.sleep(for: .milliseconds(100)) }
                let content = #"{"title":{"value":"外部标题","evidence":"Example Game"},"description":{"value":"外部介绍","evidence":"An adventure in the forest"}}"#
                let data = try JSONEncoder().encode(JSONValue.object(["choices": .array([.object(["message": .object(["content": .string(content)])])])]))
                return (data, HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
            }
        }
        store.metadata.externalPage = { url in MetadataPage(url: url, html: "<h1>Example Game</h1><p>An adventure in the forest.</p>") }
    }
    @Test("AI 获取只生成预览，确认才落盘并可本地搜索")
    func previewAndConfirm() async throws {
        let (dir, store) = try await fixture(); defer { try? FileManager.default.removeItem(at: dir) }
        installService(store)
        store.extractExternal(gameId: "1", address: "https://store.example/game")
        await store.metadata.waitForFetch(gameId: "1")
        let preview = try #require(store.metaPreviews["1"])
        #expect(store.meta(for: "1") == nil); #expect(GameMetaStore.load(dataDir: dir.path, gameId: "1") == nil)
        #expect(store.applyExternalPreview(gameId: "1", work: preview, edited: []))
        #expect(store.meta(for: "1")?.work.isExternal == true)
        #expect(GameMetaStore.load(dataDir: dir.path, gameId: "1")?.work.title == "外部标题")
        store.searchText = "外部标题"; #expect(store.filteredGames.count == 1)
        #expect(store.game(id: "1")?.gameTitle == "本地标题")
    }
    @Test("草稿手改能保存且刷新不会覆盖")
    func draftEdit() async throws {
        let (dir, store) = try await fixture(); defer { try? FileManager.default.removeItem(at: dir) }
        installService(store)
        store.extractExternal(gameId: "1", address: "https://store.example/game"); await store.metadata.waitForFetch(gameId: "1")
        var preview = try #require(store.metaPreviews["1"]); preview.title = "我改的标题"
        #expect(store.applyExternalPreview(gameId: "1", work: preview, edited: ["title"]))
        store.extractExternal(gameId: "1", address: "https://store.example/game"); await store.metadata.waitForFetch(gameId: "1")
        #expect(store.applyMetaPreview(gameId: "1"))
        #expect(store.meta(for: "1")?.work.title == "我改的标题")
        #expect(store.meta(for: "1")?.editedFields.contains("title") == true)
        #expect(store.meta(for: "1")?.work.fieldEvidence["title"] == nil)
        #expect(GameMetaStore.load(dataDir: dir.path, gameId: "1")?.work.fieldEvidence["title"] == nil)
        #expect(store.meta(for: "1")?.work.fieldEvidence["description"] != nil)
    }
    @Test("关闭查找使迟到结果失效，不写入或恢复预览")
    func cancelled() async throws {
        let (dir, store) = try await fixture(); defer { try? FileManager.default.removeItem(at: dir) }
        installService(store, delay: true)
        store.beginManualRJ(gameId: "1"); store.extractExternal(gameId: "1", address: "https://store.example/game")
        await Task.yield(); store.closeManualRJ()
        try await Task.sleep(for: .milliseconds(150))
        #expect(store.metaPreviews["1"] == nil); #expect(store.meta(for: "1") == nil)
    }
    @Test("游戏删除和编号复用后，AI 旧请求与预览均不能回写")
    func reusedID() async throws {
        let (dir, store) = try await fixture(); defer { try? FileManager.default.removeItem(at: dir) }
        installService(store, delay: true)
        store.extractExternal(gameId: "1", address: "https://store.example/game")
        await Task.yield(); store.deleteGame(id: "1")
        let replacement = GameRecord(id: "1", gameTitle: "新游戏", gamePath: "/other/Game.exe", gameEngine: "nwjs")
        #expect(JSONStore.save(GameMap(games: ["1": replacement]), to: dir.appendingPathComponent("games.json")) == nil)
        await store.load(dataDirectory: dir.path)
        try await Task.sleep(for: .milliseconds(150))
        #expect(store.metaPreviews["1"] == nil); #expect(store.meta(for: "1") == nil)
        #expect(GameMetaStore.load(dataDir: dir.path, gameId: "1") == nil)
    }
    @Test("手动填写无需 AI 配置，关闭不保存，确认后可编辑")
    func manual() async throws {
        let (dir, store) = try await fixture(); defer { try? FileManager.default.removeItem(at: dir) }
        store.prepareManualExternal(gameId: "1")
        #expect(store.meta(for: "1") == nil)
        store.discardMetaPreview(gameId: "1"); #expect(store.meta(for: "1") == nil)
        store.prepareManualExternal(gameId: "1")
        var draft = try #require(store.metaPreviews["1"]); draft.description = "手动简介"
        #expect(store.applyExternalPreview(gameId: "1", work: draft, edited: ["description"]))
        #expect(store.meta(for: "1")?.work.source == "manual")
        #expect(store.meta(for: "1")?.work.rj.isEmpty == true)
    }
    @Test("批量补全跳过外部资料，绝不自动调用付费接口")
    func batchDoesNotSpend() async throws {
        let (dir, store) = try await fixture(); defer { try? FileManager.default.removeItem(at: dir) }
        store.prepareManualExternal(gameId: "1"); #expect(store.applyMetaPreview(gameId: "1"))
        store.metadata.aiService = { Issue.record("批量不应调用 AI"); throw MetadataFailure("禁止") }
        store.prepareBatchMeta(refreshAssociated: true); store.startBatchMeta()
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while store.batchMetaRunning && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        #expect(store.batchMetaItems.first?.state == .skipped)
        #expect(store.meta(for: "1")?.work.source == "manual")
    }
    @Test("实际设置语言传入单部获取与批量服务")
    func settingsWiring() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let game = GameRecord(id: "1", gameTitle: "Example", gamePath: "/fixture/RJ123456/Game.exe", gameEngine: "nwjs")
        #expect(JSONStore.save(GameMap(games: ["1": game]), to: dir.appendingPathComponent("games.json")) == nil)
        let transport = LocaleTransport()
        let store = AppStore(dlsiteService: DLsiteService(dataDir: dir.path, transport: transport, minIntervalMs: 0))
        await store.load(dataDirectory: dir.path)
        store.setSetting(.metadataPreferredLanguage, .string("en_US")); store.setSetting(.metadataFallbackLanguage, .string("none"))
        store.prepareBatchMeta(refreshAssociated: false); store.startBatchMeta()
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while store.batchMetaRunning && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(10)) }
        #expect(store.meta(for: "1")?.work.title == "English Title")
        #expect(await transport.urls.first?.contains("locale=en_US") == true)
        store.setSetting(.metadataPreferredLanguage, .string("zh_CN"))
        store.fetchMeta(gameId: "1", rj: "RJ123456", refresh: true); await store.metadata.waitForFetch(gameId: "1")
        #expect(store.meta(for: "1")?.work.title == "中文标题")
    }
}
