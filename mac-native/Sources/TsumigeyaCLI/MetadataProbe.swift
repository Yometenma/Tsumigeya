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
        let language = MetadataLanguage(rawValue: env["TSUMIGEYA_METADATA_LANGUAGE"] ?? "zh_CN") ?? .simplifiedChinese
        let service = MetadataAIService(settings: settings, key: env["TSUMIGEYA_METADATA_KEY"] ?? "")
        if command == "metadata-search" {
            for item in try await service.search(name: input, language: language) { print("\(item.title)\n\(item.url)\n") }
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
