import Foundation

public enum MetadataNetwork {
    /// 外部页面和图片只允许公开 HTTPS 地址；模型接口的本机地址另行显式配置。
    public static func publicURL(_ value: String) -> URL? {
        guard value.count < 4096, let url = URL(string: value), url.scheme?.lowercased() == "https",
              url.user == nil, url.password == nil,
              url.port == nil || url.port == 443, let host = url.host?.lowercased(),
              !host.hasSuffix("."), host.contains("."), !host.hasSuffix(".local"),
              !host.hasSuffix(".localhost"), !host.hasSuffix(".internal"),
              !host.contains(":"), !host.hasPrefix("["),
              !host.allSatisfy({ $0.isNumber || $0 == "." }) else { return nil }
        var components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        components?.fragment = nil
        return components?.url
    }
    static func globalAddress(_ address: String) -> Bool {
        if address.contains(":") {
            guard let first = address.first else { return false }
            return first == "2" || first == "3" // IPv6 全球单播；拒绝映射、链路和本地地址。
        }
        let n = address.split(separator: ".").compactMap { Int($0) }
        guard n.count == 4, n.allSatisfy({ (0...255).contains($0) }) else { return false }
        return n[0] != 0 && n[0] != 10 && n[0] != 127 && n[0] < 224
            && !(n[0] == 169 && n[1] == 254) && !(n[0] == 172 && (16...31).contains(n[1]))
            && !(n[0] == 192 && (n[1] == 168 || n[1] == 0))
            && !(n[0] == 198 && n[1] == 51 && n[2] == 100)
            && !(n[0] == 203 && n[1] == 0 && n[2] == 113)
            && !(n[0] == 100 && (64...127).contains(n[1])) && !(n[0] == 198 && (18...19).contains(n[1]))
    }
    public static func checkPublicHost(_ url: URL) async throws {
        guard publicURL(url.absoluteString) != nil, let host = url.host else {
            throw MetadataFailure(L10n.string("只允许公开的 HTTPS 页面，不读取本机、内网或文件地址。"))
        }
        let safe = await Task.detached(priority: .utility) {
            let addresses = Host(name: host).addresses
            return !addresses.isEmpty && addresses.allSatisfy(globalAddress)
        }.value
        try Task.checkCancellation()
        guard safe else { throw MetadataFailure(L10n.string("页面域名无法解析为公开网络地址，已停止读取。")) }
    }

    public static func request(_ request: URLRequest, maxBytes: Int) async throws -> (Data, HTTPURLResponse) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil; configuration.urlCache = nil
        configuration.timeoutIntervalForResource = min(900, max(30, request.timeoutInterval))
        let session = URLSession(configuration: configuration, delegate: MetadataNoRedirect(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        do {
            let (bytes, response) = try await session.bytes(for: request)
            guard let http = response as? HTTPURLResponse, http.expectedContentLength <= Int64(maxBytes) else {
                throw MetadataFailure(L10n.string("服务器返回内容过大或响应无效。"))
            }
            var data = Data()
            for try await byte in bytes {
                if data.count >= maxBytes { throw MetadataFailure(L10n.string("服务器返回内容超过大小限制。")) }
                data.append(byte)
            }
            try Task.checkCancellation()
            return (data, http)
        } catch let error as URLError {
            if error.code == .cancelled { throw CancellationError() }
            if error.code == .timedOut { throw MetadataFailure(L10n.string("请求超时；模型较慢时可在作品信息设置中延长等待上限。原有资料未修改。")) }
            throw MetadataFailure("网络连接未完成（错误码 \(error.code.rawValue)），请检查页面可达性、接口地址、代理或服务监听地址。原有资料未修改。")
        }
    }

    public static func page(_ url: URL, maxBytes: Int = 3 * 1024 * 1024) async throws -> (URL, String) {
        var current = url
        for _ in 0..<4 {
            try await checkPublicHost(current)
            var request = URLRequest(url: current, timeoutInterval: 30)
            request.setValue("Tsumigeya/1.0 (user-requested metadata)", forHTTPHeaderField: "User-Agent")
            let (data, response) = try await self.request(request, maxBytes: maxBytes)
            if (300...399).contains(response.statusCode), let location = response.value(forHTTPHeaderField: "Location"),
               let next = URL(string: location, relativeTo: current)?.absoluteURL, publicURL(next.absoluteString) != nil {
                current = next; continue
            }
            guard response.statusCode == 200 else { throw MetadataFailure("页面读取失败（HTTP \(response.statusCode)），未修改原信息。") }
            let mime = response.mimeType?.lowercased() ?? ""
            guard mime == "text/html" || mime == "application/xhtml+xml", let html = String(data: data, encoding: .utf8) else {
                throw MetadataFailure(L10n.string("目前只支持可直接读取的 UTF-8 网页；不读取下载文件或执行网页脚本。"))
            }
            return (current, html)
        }
        throw MetadataFailure(L10n.string("页面重定向次数过多，请粘贴最终商品页地址。"))
    }
}

public struct MetadataFailure: LocalizedError, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

private final class MetadataNoRedirect: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil) // API 凭据不跟随重定向；外部页面逐跳重新校验。
    }
}
