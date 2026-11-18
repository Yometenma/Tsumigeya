import AppKit
import CryptoKit
import Foundation
import ImageIO
import OSLog
import SwiftUI
import TsumigeyaCore

/// 图片是可重建缓存，与游戏资料分开保存；列表、Hero 和预览共用同一个请求。
actor ArtworkImageCache {
    struct FetchResponse: Sendable {
        let statusCode: Int
        let finalURL: URL
        let data: Data
        let expectedContentLength: Int64
        init(statusCode: Int, finalURL: URL, data: Data, expectedContentLength: Int64? = nil) {
            self.statusCode = statusCode
            self.finalURL = finalURL
            self.data = data
            self.expectedContentLength = expectedContentLength ?? Int64(data.count)
        }
    }
    typealias Fetcher = @Sendable (URL) async throws -> FetchResponse

    static let shared = ArtworkImageCache()
    static let external = ArtworkImageCache(allowsExternal: true, fetcher: fetchExternal)
    private let allowsExternal: Bool
    static let defaultMaxBytes = 32 * 1024 * 1024
    private static let logger = Logger(subsystem: "Tsumigeya", category: "图片缓存")

    private let directory: URL
    private let fetcher: Fetcher
    private let maxBytes: Int
    private let memory = NSCache<NSString, NSData>()
    private var inFlight: [String: (id: UUID, task: Task<Data, Error>)] = [:]

    init(directory: URL? = nil, allowsExternal: Bool = false, maxBytes: Int = ArtworkImageCache.defaultMaxBytes,
         fetcher: @escaping Fetcher = ArtworkImageCache.fetchRemote) {
        let requested = directory ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Tsumigeya/Artwork", isDirectory: true)
        self.allowsExternal = allowsExternal
        self.directory = URL(fileURLWithPath: requested.standardizedFileURL.path, isDirectory: true)
        self.fetcher = fetcher
        self.maxBytes = max(1, maxBytes)
        memory.countLimit = 160
        memory.totalCostLimit = 192 * 1024 * 1024
    }

    nonisolated static func normalizedURL(_ address: String?) -> URL? {
        guard let normalized = DLsiteParser.normalizeCoverUrl(address), let url = URL(string: normalized),
              url.user == nil, url.password == nil, url.port == nil || url.port == 443 else { return nil }
        return url
    }

    nonisolated static func allowsRedirect(to url: URL) -> Bool {
        url.scheme?.lowercased() == "https" && normalizedURL(url.absoluteString) != nil
    }

    func imageData(for source: URL, refreshing: Bool = false) async throws -> Data {
        guard let url = allowsExternal ? MetadataNetwork.publicURL(source.absoluteString) : Self.normalizedURL(source.absoluteString) else { throw URLError(.unsupportedURL) }
        let key = SHA256.hash(data: Data(url.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
        if !refreshing, let cached = memory.object(forKey: key as NSString) { return cached as Data }

        let file = directory.appendingPathComponent(key).appendingPathExtension("image")
        if !refreshing, isSafeCacheFile(file),
           let values = try? file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey]),
           values.isRegularFile == true, values.isSymbolicLink != true,
           let size = values.fileSize, size <= maxBytes,
           let data = try? Data(contentsOf: file), Self.isValidImage(data, maxBytes: maxBytes) {
            memory.setObject(data as NSData, forKey: key as NSString, cost: data.count)
            return data
        }

        let request: (id: UUID, task: Task<Data, Error>)
        if let existing = inFlight[key] {
            request = existing
        } else {
            let fetcher = self.fetcher
            let limit = maxBytes
            let external = allowsExternal
            request = (UUID(), Task.detached(priority: .utility) {
                let response = try await fetcher(url)
                guard response.statusCode == 200,
                      response.expectedContentLength <= Int64(limit),
                      (external ? MetadataNetwork.publicURL(response.finalURL.absoluteString) != nil : Self.allowsRedirect(to: response.finalURL)) else { throw URLError(.badServerResponse) }
                guard Self.isValidImage(response.data, maxBytes: limit) else {
                    throw URLError(.cannotDecodeContentData)
                }
                return response.data
            })
            inFlight[key] = request
        }

        do {
            let data = try await request.task.value
            if inFlight[key]?.id == request.id {
                inFlight.removeValue(forKey: key)
                if isSafeCacheFile(file) {
                    do {
                        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                        guard isSafeCacheFile(file) else { throw CocoaError(.fileWriteNoPermission) }
                        try data.write(to: file, options: .atomic)
                    } catch {
                        Self.logger.warning("图片本地缓存写入失败。")
                    }
                }
                memory.setObject(data as NSData, forKey: key as NSString, cost: data.count)
            }
            return data
        } catch {
            if inFlight[key]?.id == request.id { inFlight.removeValue(forKey: key) }
            throw error
        }
    }

    private func isSafeCacheFile(_ file: URL) -> Bool {
        guard file.deletingLastPathComponent().standardizedFileURL.path == directory.path,
              directory.resolvingSymlinksInPath().standardizedFileURL.path == directory.path else { return false }
        guard let values = try? file.resourceValues(forKeys: [.isSymbolicLinkKey]) else {
            return !FileManager.default.fileExists(atPath: file.path)
        }
        return values.isSymbolicLink != true
    }

    nonisolated static func isValidImage(_ data: Data, maxBytes: Int = defaultMaxBytes) -> Bool {
        guard !data.isEmpty, data.count <= maxBytes,
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetStatus(source) == .statusComplete,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0, width <= 20_000, height <= 20_000,
              width * height <= 40_000_000 else { return false }
        return true
    }

    nonisolated static func fetchExternal(_ url: URL) async throws -> FetchResponse {
        try await MetadataNetwork.checkPublicHost(url)
        let (data, response) = try await MetadataNetwork.request(URLRequest(url: url, timeoutInterval: 30), maxBytes: defaultMaxBytes)
        // 图片不跟随重定向，避免第三方来源借图片请求访问其他地址。
        return FetchResponse(statusCode: response.statusCode, finalURL: url, data: data)
    }

    nonisolated static func fetchRemote(_ url: URL) async throws -> FetchResponse {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 30
        configuration.timeoutIntervalForResource = 120
        let session = URLSession(configuration: configuration, delegate: ArtworkRedirectGuard(), delegateQueue: nil)
        defer { session.invalidateAndCancel() }
        let (bytes, response) = try await session.bytes(from: url)
        guard let response = response as? HTTPURLResponse, let finalURL = response.url else {
            throw URLError(.badServerResponse)
        }
        let expected = response.expectedContentLength
        guard expected < 0 || expected <= Int64(defaultMaxBytes) else { throw URLError(.dataLengthExceedsMaximum) }
        var data = Data()
        for try await byte in bytes {
            guard data.count < defaultMaxBytes else { throw URLError(.dataLengthExceedsMaximum) }
            data.append(byte)
        }
        return FetchResponse(statusCode: response.statusCode, finalURL: finalURL, data: data,
                             expectedContentLength: expected)
    }
}

private final class ArtworkRedirectGuard: NSObject, URLSessionTaskDelegate, Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(request.url.map(ArtworkImageCache.allowsRedirect) == true ? request : nil)
    }
}

struct CachedRemoteImage: View {
    let url: URL
    var contentMode: ContentMode = .fit
    var external = false
    var retryLabel = "重试图片"
    @State private var image: NSImage?
    @State private var failed = false
    @State private var attempt = 0

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image).resizable().aspectRatio(contentMode: contentMode)
                    .accessibilityLabel("作品图片已加载")
            } else if failed {
                Button {
                    failed = false
                    attempt += 1
                } label: {
                    Label(retryLabel, systemImage: "arrow.clockwise").font(.caption)
                }.buttonStyle(.plain)
            } else {
                ProgressView().controlSize(.small)
            }
        }
        .task(id: "\(url.absoluteString)#\(attempt)") {
            image = nil
            failed = false
            do {
                let cache = external ? ArtworkImageCache.external : ArtworkImageCache.shared
                let data = try await cache.imageData(for: url, refreshing: attempt > 0)
                guard !Task.isCancelled else { return }
                guard let decoded = NSImage(data: data) else { failed = true; return }
                image = decoded
            } catch {
                guard !Task.isCancelled else { return }
                failed = true
            }
        }
    }
}
