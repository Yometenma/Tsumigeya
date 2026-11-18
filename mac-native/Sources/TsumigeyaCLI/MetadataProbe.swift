import Foundation
import TsumigeyaCore

/// 只输出预览，不写入游戏库。付费接口需显式通过环境变量配置。
func runExternalMetadata(command: String, input: String) async -> Int {
    do {
        let env = ProcessInfo.processInfo.environment
        var settings = MetadataAPISettings()
        settings.endpoint = env["TSUMIGEYA_METADATA_ENDPOINT"] ?? ""
        settings.model = env["TSUMIGEYA_METADATA_MODEL"] ?? ""
        settings.mode = MetadataAPISettings.Mode(rawValue: env["TSUMIGEYA_METADATA_MODE"] ?? "chat") ?? .chat
        if env["TSUMIGEYA_METADATA_ALLOW_LAN"] == "1" { settings.authorizedLANEndpoint = settings.endpoint }
        settings.timeoutSeconds = Double(env["TSUMIGEYA_METADATA_TIMEOUT"] ?? "180") ?? 180
        settings.inputCharacters = Int(env["TSUMIGEYA_METADATA_INPUT_LIMIT"] ?? "16000") ?? 16_000
        settings.jsonOutput = env["TSUMIGEYA_METADATA_JSON"] == "1"
        settings.disableThinking = env["TSUMIGEYA_METADATA_NO_THINKING"] == "1"
        let language = MetadataLanguage(rawValue: env["TSUMIGEYA_METADATA_LANGUAGE"] ?? "zh_CN") ?? .simplifiedChinese
        let service = MetadataAIService(settings: settings, key: env["TSUMIGEYA_METADATA_KEY"] ?? "")
        if command == "metadata-search" {
            let provider = MetadataSearchSettings.Provider(rawValue: env["TSUMIGEYA_SEARCH_PROVIDER"] ?? "native") ?? .disabled
            let candidates: [MetadataCandidate]
            if provider == .native { candidates = try await service.search(name: input, language: language) }
            else if provider == .disabled { throw MetadataFailure("联网搜索已关闭。") }
            else {
                var search = MetadataSearchSettings(); search.provider = provider
                search.endpoint = env["TSUMIGEYA_SEARCH_ENDPOINT"] ?? ""
                if env["TSUMIGEYA_SEARCH_ALLOW_LAN"] == "1" { search.authorizedLANEndpoint = search.effectiveEndpoint }
                search.limit = Int(env["TSUMIGEYA_SEARCH_LIMIT"] ?? "5") ?? 5
                search.method = env["TSUMIGEYA_SEARCH_METHOD"] ?? "GET"
                search.queryKey = env["TSUMIGEYA_SEARCH_QUERY_KEY"] ?? "q"
                search.resultsPath = env["TSUMIGEYA_SEARCH_RESULTS_PATH"] ?? "results"
                search.titlePath = env["TSUMIGEYA_SEARCH_TITLE_PATH"] ?? "title"
                search.urlPath = env["TSUMIGEYA_SEARCH_URL_PATH"] ?? "url"
                search.summaryPath = env["TSUMIGEYA_SEARCH_SUMMARY_PATH"] ?? "content"
                search.parameters = env["TSUMIGEYA_SEARCH_PARAMETERS"] ?? "{}"
                candidates = try await MetadataSearchService(settings: search, key: env["TSUMIGEYA_SEARCH_KEY"] ?? "").search(name: input, language: language)
            }
            for item in candidates { print("\(item.title)\n\(item.url)\n\(item.summary)\n") }
        } else {
            guard let url = MetadataNetwork.publicURL(input) else { throw MetadataFailure("请输入公开 HTTPS 页面。") }
            let (finalURL, html) = try await MetadataNetwork.page(url)
            let page = MetadataPage(url: finalURL, html: html)
            if command == "metadata-page" {
                print("可读正文字数：\(page.text.count)\n页面封面：\(page.cover == nil ? "无" : "有")")
            } else {
                let work = try await service.extract(page: page, language: language)
                let data = try JSONEncoder().encode(GameDlsiteMeta(work: work))
                print(String(decoding: data, as: UTF8.self))
            }
        }
        return 0
    } catch {
        print((error as? MetadataFailure)?.message ?? "请求未完成，请检查网络或接口配置；未写入游戏库。")
        return 1
    }
}
