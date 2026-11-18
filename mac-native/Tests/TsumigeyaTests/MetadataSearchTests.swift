import Foundation
import Testing
@testable import TsumigeyaCore
@testable import TsumigeyaApp

private actor SearchRequestLog {
    var requests: [URLRequest] = []
    func add(_ request: URLRequest) { requests.append(request) }
}

@Suite("独立搜索与本地模型协议")
struct MetadataSearchTests {
    private let results = #"{"results":[{"title":"Example Game","url":"https://store.example/game#about","content":"Official game page"},{"title":"Duplicate","url":"https://store.example/game"},{"title":"Private","url":"http://192.168.1.1/game"},{"title":"Other","url":"https://dev.example/game"}]}"#
    private func service(_ settings: MetadataSearchSettings, log: SearchRequestLog, response: String? = nil, status: Int = 200) -> MetadataSearchService {
        let text = response ?? results
        return MetadataSearchService(settings: settings, key: "fixture-search-key") { request in
            await log.add(request)
            return (Data(text.utf8), HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!)
        }
    }
    @Test("Tavily 使用独立认证与有限候选，不调用模型，不接受私网结果或重复片段")
    func tavily() async throws {
        var settings = MetadataSearchSettings(); settings.provider = .tavily; settings.limit = 3
        let log = SearchRequestLog()
        let candidates = try await service(settings, log: log).search(name: "Example Game", language: .simplifiedChinese)
        #expect(candidates.count == 2); #expect(candidates.first?.url == "https://store.example/game")
        #expect(candidates.first?.summary == "Official game page")
        let request = try #require(await log.requests.first)
        #expect(request.url?.absoluteString == "https://api.tavily.com/search")
        #expect(request.httpMethod == "POST")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-search-key")
        let body = try JSONDecoder().decode(JSONValue.self, from: request.httpBody!).objectValue
        #expect(body?["query"] == .string("Example Game")); #expect(body?["max_results"] == .int(3))
        #expect(body?["language"] == .string("zh-cn")); #expect(body?["auto_parameters"] == .bool(false))
        #expect(body?["include_raw_content"] == .bool(false)); #expect(body?["include_answer"] == .bool(false))
        #expect(!String(decoding: request.httpBody!, as: UTF8.self).contains("fixture-search-key"))
    }
    @Test("SearXNG 保留名称特殊字符并明确请求 JSON 和语言")
    func searx() async throws {
        var settings = MetadataSearchSettings(); settings.provider = .searxng; settings.endpoint = "https://search.example/search"
        let log = SearchRequestLog(); _ = try await service(settings, log: log).search(name: "A+B&B?# 游戏", language: .english)
        let request = try #require(await log.requests.first)
        let components = try #require(URLComponents(url: request.url!, resolvingAgainstBaseURL: false))
        #expect(request.httpMethod == "GET")
        #expect(request.url?.absoluteString.contains("%2B") == true)
        #expect(components.queryItems?.first { $0.name == "q" }?.value == "A+B&B?# 游戏")
        #expect(components.queryItems?.first { $0.name == "format" }?.value == "json")
        #expect(components.queryItems?.first { $0.name == "language" }?.value == "en-US")
    }
    @Test("自定义 POST 支持嵌套字段映射和非敏感参数，数量由客户端限制")
    func customPost() async throws {
        var settings = MetadataSearchSettings(); settings.provider = .custom; settings.endpoint = "https://search.example/api"
        settings.method = "POST"; settings.queryKey = "keyword"; settings.parameters = #"{"count":10,"safe":true}"#
        settings.resultsPath = "data.items"; settings.titlePath = "meta.name"; settings.urlPath = "link"; settings.summaryPath = "snippet"; settings.limit = 1
        let response = #"{"data":{"items":[{"meta":{"name":"Game"},"link":"https://store.example/one","snippet":"Known page"},{"link":"https://store.example/two"}]}}"#
        let log = SearchRequestLog(); let candidates = try await service(settings, log: log, response: response).search(name: "Game", language: .japanese)
        #expect(candidates.count == 1); #expect(candidates.first?.title == "Game"); #expect(candidates.first?.summary == "Known page")
        let request = try #require(await log.requests.first)
        let body = try JSONDecoder().decode(JSONValue.self, from: request.httpBody!).objectValue
        #expect(body?["keyword"] == .string("Game")); #expect(body?["count"] == .int(10))
    }
    @Test("自定义根数组和 GET 参数可用，密钥不进入查询字符串")
    func customGet() async throws {
        var settings = MetadataSearchSettings(); settings.provider = .custom; settings.endpoint = "https://search.example/api"; settings.resultsPath = ""
        let log = SearchRequestLog()
        #expect(try await service(settings, log: log, response: #"[{"title":"Game","url":"https://store.example/game"}]"#).search(name: "Game", language: .english).count == 1)
        let request = try #require(await log.requests.first)
        #expect(request.url?.query?.contains("fixture-search-key") == false)
    }
    @Test("搜索失败不重试、不降级收费服务，服务原始响应不泄露")
    func failures() async throws {
        var settings = MetadataSearchSettings(); settings.provider = .tavily
        for (status, response) in [(401, "secret-server-response"), (200, "not json"), (200, #"{"results":[]}"#), (200, #"{"answer":"https://invented.example"}"#)] {
            let log = SearchRequestLog()
            do { _ = try await service(settings, log: log, response: response, status: status).search(name: "Game", language: .english); Issue.record("不应成功") }
            catch { #expect(!error.localizedDescription.contains("secret-server-response")) }
            #expect(await log.requests.count == 1)
        }
    }
    @Test("敏感附加参数、缺失密钥或未授权地址在网络调用前拒绝")
    func invalidSettings() async {
        var settings = MetadataSearchSettings(); settings.provider = .custom; settings.endpoint = "https://search.example/api"
        for parameters in [#"{"api_key":"private"}"#, #"{"nested":{"Authorization":"private"}}"#, "[]"] {
            settings.parameters = parameters; let log = SearchRequestLog()
            await #expect(throws: MetadataFailure.self) { try await service(settings, log: log).search(name: "Game", language: .english) }
            #expect(await log.requests.isEmpty)
        }
        settings.parameters = "{}"; settings.endpoint = "http://192.168.10.20:8085/search"
        let log = SearchRequestLog()
        await #expect(throws: MetadataFailure.self) { try await service(settings, log: log).search(name: "Game", language: .english) }
        #expect(await log.requests.isEmpty)
        settings.provider = .tavily; settings.endpoint = ""
        await #expect(throws: MetadataFailure.self) { try await MetadataSearchService(settings: settings).search(name: "Game", language: .english) }
    }
    @Test("局域网授权精确限定完整地址，不能授权公网明文或带凭据地址")
    func lan() {
        for endpoint in ["http://192.168.10.20:8085/v1/chat/completions", "http://10.0.0.5/api", "http://172.16.1.5/api", "http://model.local/api", "http://model/api", "http://[fd12::1]:8085/api"] {
            #expect(MetadataEndpoint.url(endpoint) == nil)
            #expect(MetadataEndpoint.url(endpoint, authorizedLANEndpoint: endpoint) != nil)
            #expect(MetadataEndpoint.url(endpoint + "/other", authorizedLANEndpoint: endpoint) == nil)
            #expect(MetadataNetwork.publicURL(endpoint) == nil)
        }
        for endpoint in ["http://example.com/api", "http://8.8.8.8/api", "http://192.168.10.20/api?key=secret", "http://u:p@192.168.10.20/api", "file:///tmp/model"] {
            #expect(MetadataEndpoint.url(endpoint, authorizedLANEndpoint: endpoint) == nil)
        }
    }
    @Test("本地模型选项实际进入请求，限制正文并剥离完整思考块")
    func modelOptions() async throws {
        var settings = MetadataAPISettings(); settings.endpoint = "http://192.168.10.20:8085/v1/chat/completions"; settings.authorizedLANEndpoint = settings.endpoint
        settings.model = "local-fixture"; settings.timeoutSeconds = 600; settings.inputCharacters = 2000; settings.jsonOutput = true; settings.disableThinking = true
        let log = SearchRequestLog()
        let content = #"{"title":{"value":"Example Game","evidence":"Example Game"}}"#
        let service = MetadataAIService(settings: settings, key: "") { request in
            await log.add(request)
            let json: JSONValue = .object(["choices": .array([.object(["message": .object(["reasoning_content": .string("do not parse this"), "content": .string("<think>reasoning</think>\n```json\n" + content + "\n```")])])])])
            return (try JSONEncoder().encode(json), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
        }
        let page = MetadataPage(url: URL(string: "https://store.example/game")!, html: "<h1>Example Game</h1><p>" + String(repeating: "A", count: 5000) + "</p><p>TAIL_SENTINEL</p>")
        #expect(try await service.extract(page: page, language: .simplifiedChinese).title == "Example Game")
        let request = try #require(await log.requests.first)
        #expect(request.timeoutInterval == 600)
        let body = try JSONDecoder().decode(JSONValue.self, from: request.httpBody!).objectValue
        #expect(body?["response_format"]?.objectValue?["type"] == .string("json_object"))
        #expect(body?["chat_template_kwargs"]?.objectValue?["enable_thinking"] == .bool(false))
        #expect(!String(decoding: request.httpBody!, as: UTF8.self).contains("TAIL_SENTINEL"))
    }
    @Test("不能根据农场玩法描述猜成动作类型，只接受明确类型引文")
    func typeEvidence() throws {
        let page = MetadataPage(url: URL(string: "https://example.com")!, html: "<h1>Example Game</h1><p>Create the farm of your dreams! A farming simulation game.</p>")
        let wrong = #"{"title":{"value":"Example Game","evidence":"Example Game"},"workType":{"value":"ACT","evidence":"Create the farm of your dreams!"}}"#
        let work = try MetadataAIService.parse(text: wrong, page: page, language: .english)
        #expect(work.workType == nil); #expect(work.fieldEvidence["workType"] == nil)
        let valid = wrong.replacingOccurrences(of: "ACT", with: "SLN").replacingOccurrences(of: "Create the farm of your dreams!", with: "A farming simulation game.")
        #expect(try MetadataAIService.parse(text: valid, page: page, language: .english).workType == "SLN")
    }
    @Test("未闭合思考或只有推理不能被误当成成功资料")
    func incompleteThinking() {
        let page = MetadataPage(url: URL(string: "https://example.com")!, html: "<h1>Example Game</h1>")
        for text in [#"<think>{"title":{"value":"Game","evidence":"Example Game"}}"#, "<think>reasoning</think>"] {
            #expect(throws: MetadataFailure.self) { try MetadataAIService.parse(text: text, page: page, language: .english) }
        }
    }
}

@Suite("独立搜索实际设置与候选状态", .serialized)
@MainActor
struct MetadataSearchStateTests {
    private func fixture() async throws -> (URL, AppStore) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let record = GameRecord(id: "1", gameTitle: "Local Game", gamePath: "/fixture/Game.exe", gameEngine: "nwjs")
        try #require(JSONStore.save(GameMap(games: ["1": record]), to: dir.appendingPathComponent("games.json")) == nil)
        let store = AppStore(); await store.load(dataDirectory: dir.path)
        return (dir, store)
    }
    @Test("授权随地址修改撤销，模型与搜索互不授权，未知设置保留")
    func grants() async throws {
        let (dir, store) = try await fixture(); defer { try? FileManager.default.removeItem(at: dir) }
        let endpoint = "http://192.168.10.20:8085/v1/chat/completions"
        store.setSetting(.metadataEndpoint, .string(endpoint)); #expect(store.metadataAPISettings.url == nil)
        store.setSetting(.metadataLANEndpoint, .string(endpoint)); #expect(store.metadataAPISettings.url != nil)
        store.setSetting(.metadataSearchProvider, .string("custom")); store.setSetting(.metadataSearchEndpoint, .string(endpoint))
        #expect(store.metadataSearchSettings.url == nil)
        store.setSetting(.metadataSearchLANEndpoint, .string(endpoint)); #expect(store.metadataSearchSettings.url != nil)
        store.setSetting(.metadataEndpoint, .string(endpoint + "/other")); #expect(store.metadataAPISettings.url == nil)
        #expect(store.settingString(.metadataLANEndpoint).isEmpty)
        #expect(store.metadataSearchSettings.url != nil)
        store.setSetting(.metadataSearchProvider, .string("tavily")); #expect(store.metadataSearchSettings.url == nil)
        store.setSetting(.metadataTimeout, .string("600")); store.setSetting(.metadataInputLimit, .string("8000")); store.setSetting(.metadataJSONOutput, .bool(true))
        #expect(store.metadataAPISettings.timeoutSeconds == 600); #expect(store.metadataAPISettings.inputCharacters == 8000); #expect(store.metadataAPISettings.jsonOutput)
        store.setSetting(.metadataSearchParameters, .string(#"{"api_key":"DO_NOT_SAVE"}"#))
        let saved = try String(contentsOf: dir.appendingPathComponent("global-settings.json"), encoding: .utf8)
        #expect(!saved.contains("DO_NOT_SAVE"))
    }
    @Test("关闭查找后独立搜索迟到结果不能恢复候选或写回")
    func cancelledSearch() async throws {
        let (dir, store) = try await fixture(); defer { try? FileManager.default.removeItem(at: dir) }
        store.setSetting(.metadataSearchProvider, .string("custom"))
        let log = SearchRequestLog()
        store.metadata.searchService = {
            var settings = MetadataSearchSettings(); settings.provider = .custom; settings.endpoint = "https://search.example/api"
            return MetadataSearchService(settings: settings) { request in
                await log.add(request)
                try? await Task.sleep(for: .milliseconds(100))
                return (Data(#"{"results":[{"title":"Game","url":"https://store.example/game"}]}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
            }
        }
        store.beginManualRJ(gameId: "1"); store.searchExternal(gameId: "1", name: "Game")
        let deadline = ContinuousClock.now.advanced(by: .seconds(2))
        while await log.requests.isEmpty && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
        #expect(await log.requests.count == 1)
        store.closeManualRJ()
        try await Task.sleep(for: .milliseconds(150))
        #expect(store.externalCandidates["1"] == nil); #expect(store.metaPreviews["1"] == nil)
        #expect(store.meta(for: "1") == nil)
    }
    @Test("独立搜索无需模型配置，不自动关联；选择后才请求模型")
    func independent() async throws {
        let (dir, store) = try await fixture(); defer { try? FileManager.default.removeItem(at: dir) }
        store.setSetting(.metadataSearchProvider, .string("tavily"))
        let log = SearchRequestLog()
        store.metadata.aiService = { Issue.record("独立搜索不应读取模型或密钥"); throw MetadataFailure("未配置模型") }
        store.metadata.searchService = {
            MetadataSearchService(settings: store.metadataSearchSettings, key: "fixture") { request in
                await log.add(request)
                return (Data(#"{"results":[{"title":"Example Game","url":"https://store.example/game","content":"Official"}]}"#.utf8), HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!)
            }
        }
        store.searchExternal(gameId: "1", name: "Example Game"); await store.metadata.waitForFetch(gameId: "1")
        #expect(store.externalCandidates["1"]?.count == 1)
        #expect(store.metaPreviews["1"] == nil); #expect(store.meta(for: "1") == nil)
        #expect(GameMetaStore.load(dataDir: dir.path, gameId: "1") == nil)
        #expect(await log.requests.count == 1)
        store.setSetting(.metadataSearchProvider, .string("disabled"))
        store.searchExternal(gameId: "1", name: "Game")
        #expect(store.metaError["1"]?.contains("关闭") == true)
        #expect(await log.requests.count == 1)
    }
}
