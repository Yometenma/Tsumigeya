import Foundation

/// 授权只匹配当前完整地址；不改变网页和图片的公网限制，也不跟随重定向。
public enum MetadataEndpoint {
    public static func url(_ endpoint: String, authorizedLANEndpoint: String = "") -> URL? {
        let address = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: address), let host = url.host?.lowercased(), !host.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { return nil }
        if url.scheme == "https" { return url }
        guard url.scheme == "http" else { return nil }
        if ["localhost", "127.0.0.1", "::1", "[::1]"].contains(host) { return url }
        guard authorizedLANEndpoint == address else { return nil }
        let octets = host.split(separator: ".").compactMap { Int($0) }
        let privateIP = octets.count == 4 && octets.allSatisfy { (0...255).contains($0) }
            && (octets[0] == 10 || (octets[0] == 172 && (16...31).contains(octets[1])) || (octets[0] == 192 && octets[1] == 168))
        let ipv6 = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
        let localName = !host.contains(":") && !host.hasSuffix(".") && (!host.contains(".") || host.hasSuffix(".local"))
            && host.contains(where: { $0.isLetter })
        let privateIPv6 = (ipv6.hasPrefix("fc") || ipv6.hasPrefix("fd")) && ipv6.contains(":")
        guard privateIP || privateIPv6 || localName else { return nil }
        return url
    }
}

public struct MetadataSearchSettings: Sendable, Equatable {
    public enum Provider: String, CaseIterable, Sendable { case disabled, native, tavily, searxng, custom }
    public var provider: Provider = .native
    public var endpoint = ""
    public var authorizedLANEndpoint = ""
    public var limit = 5
    public var method = "GET"
    public var queryKey = "q"
    public var resultsPath = "results"
    public var titlePath = "title"
    public var urlPath = "url"
    public var summaryPath = "content"
    /// 仅非敏感参数；认证使用独立钥匙串，不能把密钥放进 URL。
    public var parameters = "{}"
    public init() {}
    public var effectiveEndpoint: String {
        provider == .tavily && endpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "https://api.tavily.com/search" : endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
    }
    public var url: URL? { MetadataEndpoint.url(effectiveEndpoint, authorizedLANEndpoint: authorizedLANEndpoint) }
}

public struct MetadataSearchService: Sendable {
    public let settings: MetadataSearchSettings
    public let key: String
    private let transport: MetadataAIService.Transport?
    public init(settings: MetadataSearchSettings, key: String = "", transport: MetadataAIService.Transport? = nil) {
        self.settings = settings; self.key = key; self.transport = transport
    }
    public func search(name: String, language: MetadataLanguage) async throws -> [MetadataCandidate] {
        let query = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty, query.count <= 500 else { throw MetadataFailure(L10n.string("请输入不超过 500 字的游戏名称及必要线索。")) }
        guard [.tavily, .searxng, .custom].contains(settings.provider), let endpoint = settings.url else {
            throw MetadataFailure(L10n.string("请配置独立搜索接口；局域网 HTTP 地址须单独授权。"))
        }
        let limit = min(12, max(1, settings.limit))
        var parameters: [String: JSONValue]
        var method: String
        switch settings.provider {
        case .tavily:
            guard !key.isEmpty else { throw MetadataFailure(L10n.string("请先保存独立搜索密钥。")) }
            method = "POST"
            let locale: String
            switch language {
            case .simplifiedChinese: locale = "zh-cn"
            case .traditionalChinese: locale = "zh-tw"
            case .japanese: locale = "ja"
            case .english: locale = "en"
            case .korean: locale = "ko"
            }
            parameters = ["query": .string(query), "max_results": .int(limit), "search_depth": .string("basic"), "include_answer": .bool(false), "include_raw_content": .bool(false), "auto_parameters": .bool(false), "language": .string(locale)]
        case .searxng:
            method = "GET"
            parameters = ["q": .string(query), "format": .string("json"), "language": .string(language.rawValue.replacingOccurrences(of: "_", with: "-"))]
        case .custom:
            method = settings.method.uppercased()
            guard ["GET", "POST"].contains(method), !settings.queryKey.isEmpty, settings.queryKey.count <= 100, !Self.containsSecret([settings.queryKey: .null]),
                  settings.parameters.utf8.count <= 8000,
                  let data = settings.parameters.data(using: .utf8),
                  let object = try? JSONDecoder().decode(JSONValue.self, from: data).objectValue,
                  !Self.containsSecret(object) else { throw MetadataFailure(L10n.string("自定义搜索参数须为不含密钥的 JSON 对象，请检查请求方式和关键词参数名。")) }
            parameters = object; parameters[settings.queryKey] = .string(query)
        default: throw MetadataFailure(L10n.string("未启用独立搜索。"))
        }
        var request = URLRequest(url: endpoint, timeoutInterval: 45)
        request.httpMethod = method
        if method == "POST" {
            request.httpBody = try JSONEncoder().encode(parameters)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        } else {
            var components = URLComponents(url: endpoint, resolvingAgainstBaseURL: false)
            components?.queryItems = try parameters.sorted { $0.key < $1.key }.map { key, value in
                let text: String
                if let string = value.stringValue { text = string }
                else { text = String(decoding: try JSONEncoder().encode(value), as: UTF8.self) }
                return URLQueryItem(name: key, value: text)
            }
            let encodedQuery = components?.percentEncodedQuery
            components?.percentEncodedQuery = encodedQuery?.replacingOccurrences(of: "+", with: "%2B")
            guard let url = components?.url else { throw MetadataFailure(L10n.string("搜索请求地址无效。")) }
            request.url = url
        }
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if !key.isEmpty { request.setValue("Bearer " + key, forHTTPHeaderField: "Authorization") }
        let data: Data; let response: URLResponse
        if let transport { (data, response) = try await transport(request) }
        else { (data, response) = try await MetadataNetwork.request(request, maxBytes: 2 * 1024 * 1024) }
        try Task.checkCancellation()
        if let http = response as? HTTPURLResponse, [401, 403].contains(http.statusCode) {
            throw MetadataFailure("搜索接口未授权（HTTP \(http.statusCode)），请检查或重新保存独立搜索密钥及接口权限；不会自动重试或切换收费服务。")
        }
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            throw MetadataFailure("搜索接口请求失败（HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)）。请检查配置、JSON 输出权限或余额；不会自动切换到其他收费服务。")
        }
        guard data.count <= 2 * 1024 * 1024, let json = try? JSONDecoder().decode(JSONValue.self, from: data) else { throw MetadataFailure(L10n.string("搜索接口未返回有效 JSON。")) }
        let custom = settings.provider == .custom
        guard let results = Self.at(json, path: custom ? settings.resultsPath : "results")?.arrayValue else {
            throw MetadataFailure(L10n.string("搜索结果数组不存在，请检查接口格式或自定义字段路径。"))
        }
        var seen: Set<String> = []; var candidates: [MetadataCandidate] = []
        for result in results.prefix(100) {
            guard let address = Self.at(result, path: custom ? settings.urlPath : "url")?.stringValue,
                  let url = MetadataNetwork.publicURL(address), seen.insert(url.absoluteString).inserted else { continue }
            let title = Self.at(result, path: custom ? settings.titlePath : "title")?.stringValue ?? url.host ?? L10n.string("作品页面")
            let summary = Self.at(result, path: custom ? settings.summaryPath : "content")?.stringValue ?? ""
            candidates.append(.init(title: String(title.prefix(250)), url: url.absoluteString, summary: String(summary.prefix(800))))
            if candidates.count >= limit { break }
        }
        guard !candidates.isEmpty else { throw MetadataFailure(L10n.string("搜索没有返回可用的公开 HTTPS 来源，请调整游戏名或手动指定页面。")) }
        return candidates
    }
    public static func containsSecret(_ object: [String: JSONValue]) -> Bool {
        object.contains { key, value in
            let name = key.lowercased().replacingOccurrences(of: "_", with: "").replacingOccurrences(of: "-", with: "")
            if name == "key" || name.contains("apikey") || name.contains("token") || name.contains("secret") || name.contains("password") || name == "authorization" { return true }
            if let nested = value.objectValue { return containsSecret(nested) }
            if let values = value.arrayValue { return values.contains { $0.objectValue.map(containsSecret) ?? false } }
            return false
        }
    }
    private static func at(_ value: JSONValue, path: String) -> JSONValue? {
        if path.isEmpty { return value }
        return path.split(separator: ".").reduce(Optional(value)) { current, key in
            if let array = current?.arrayValue, let index = Int(key), array.indices.contains(index) { return array[index] }
            return current?.objectValue?[String(key)]
        }
    }
}
