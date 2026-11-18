import CryptoKit
import Foundation
import Testing
@testable import TsumigeyaApp

private actor ArtworkFetchCounter {
    private(set) var count = 0
    @discardableResult func increment() -> Int { count += 1; return count }
}

@Suite("作品图片本地缓存")
struct ArtworkImageCacheTests {
    private let address = URL(string: "https://img.dlsite.jp/cover.jpg")!
    private let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC")!

    private func directory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("artwork-cache-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    @Test("首次下载原子落盘，同实例后续读取使用内存缓存")
    func writesAndUsesMemory() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let counter = ArtworkFetchCounter()
        let cache = ArtworkImageCache(directory: dir) { url in
            await counter.increment()
            return .init(statusCode: 200, finalURL: url, data: self.png)
        }
        #expect(try await cache.imageData(for: address) == png)
        #expect(try await cache.imageData(for: address) == png)
        #expect(await counter.count == 1)
        let files = try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.isRegularFileKey])
        #expect(files.count == 1)
        #expect(try Data(contentsOf: files[0]) == png)
    }

    @Test("新缓存实例优先命中磁盘，不再请求网络")
    func readsFromDisk() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let first = ArtworkImageCache(directory: dir) { url in .init(statusCode: 200, finalURL: url, data: self.png) }
        _ = try await first.imageData(for: address)
        let counter = ArtworkFetchCounter()
        let second = ArtworkImageCache(directory: dir) { url in
            await counter.increment()
            return .init(statusCode: 200, finalURL: url, data: self.png)
        }
        #expect(try await second.imageData(for: address) == png)
        #expect(await counter.count == 0)
    }

    @Test("首次创建多层缓存目录后，新实例仍能离线读取")
    func createsMissingDirectoryAndPersists() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("artwork-new-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        // 不提前创建目录，也不依赖 URL 是否带有目录末尾的斜线。
        let dir = root.appendingPathComponent("Tsumigeya/Artwork")
        let first = ArtworkImageCache(directory: dir) { url in .init(statusCode: 200, finalURL: url, data: self.png) }
        #expect(try await first.imageData(for: address) == png)
        let files = try FileManager.default.contentsOfDirectory(atPath: dir.path)
        #expect(files.count == 1)
        let second = ArtworkImageCache(directory: dir) { _ in
            Issue.record("首次缓存应已落盘")
            throw URLError(.notConnectedToInternet)
        }
        #expect(try await second.imageData(for: address) == png)
    }

    @Test("并发读取同一图片只发一个请求，一个等待者取消不影响其他等待者")
    func coalescesConcurrentRequests() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let counter = ArtworkFetchCounter()
        let cache = ArtworkImageCache(directory: dir) { url in
            await counter.increment()
            try await Task.sleep(for: .milliseconds(100))
            return .init(statusCode: 200, finalURL: url, data: self.png)
        }
        let first = Task { try await cache.imageData(for: address) }
        let second = Task { try await cache.imageData(for: address) }
        first.cancel()
        #expect(try await second.value == png)
        _ = try await first.value
        #expect(await counter.count == 1)
    }

    @Test("损坏缓存重新下载；失败请求可以重试，失败刷新不覆盖已有有效缓存")
    func corruptionAndRetry() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let initial = ArtworkImageCache(directory: dir) { url in .init(statusCode: 200, finalURL: url, data: self.png) }
        _ = try await initial.imageData(for: address)
        let file = try #require(FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil).first)
        try Data("broken".utf8).write(to: file)
        let counter = ArtworkFetchCounter()
        let cache = ArtworkImageCache(directory: dir) { url in
            let attempt = await counter.increment()
            if attempt == 1 || attempt == 3 { throw URLError(.notConnectedToInternet) }
            return .init(statusCode: 200, finalURL: url, data: self.png)
        }
        do { _ = try await cache.imageData(for: address); Issue.record("首个请求应失败") } catch { }
        #expect(try await cache.imageData(for: address) == png)
        do { _ = try await cache.imageData(for: address, refreshing: true); Issue.record("刷新应失败") } catch { }
        #expect(try Data(contentsOf: file) == png)
        #expect(try await cache.imageData(for: address) == png)
        #expect(await counter.count == 3)
    }

    @Test("只接受 DLsite HTTPS 图片地址，重定向也必须留在白名单")
    func validatesAddressesAndRedirects() {
        #expect(ArtworkImageCache.normalizedURL("//img.dlsite.jp/cover.jpg")?.scheme == "https")
        #expect(ArtworkImageCache.normalizedURL("https://example.com/cover.jpg") == nil)
        #expect(ArtworkImageCache.normalizedURL("https://img.dlsite.jp.evil.example/cover.jpg") == nil)
        #expect(ArtworkImageCache.normalizedURL("https://user@img.dlsite.jp/cover.jpg") == nil)
        #expect(ArtworkImageCache.allowsRedirect(to: URL(string: "https://img.dlsite.jp/next.jpg")!))
        #expect(!ArtworkImageCache.allowsRedirect(to: URL(string: "http://img.dlsite.jp/next.jpg")!))
        #expect(!ArtworkImageCache.allowsRedirect(to: URL(string: "https://example.com/next.jpg")!))
    }

    @Test("拒绝错误状态、非法图片、超过长度上限及跨域重定向")
    func rejectsInvalidResponses() async throws {
        let cases: [(Int, URL, Data, Int64)] = [
            (404, address, png, Int64(png.count)),
            (200, address, Data("not image".utf8), 9),
            (200, address, png, 100_000),
            (200, URL(string: "https://example.com/evil.jpg")!, png, Int64(png.count)),
        ]
        for (status, finalURL, data, length) in cases {
            let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
            let cache = ArtworkImageCache(directory: dir, maxBytes: 4096) { _ in
                .init(statusCode: status, finalURL: finalURL, data: data, expectedContentLength: length)
            }
            do {
                _ = try await cache.imageData(for: address)
                Issue.record("无效响应不应被缓存")
            } catch { }
            #expect(try FileManager.default.contentsOfDirectory(atPath: dir.path).isEmpty)
        }
    }

    @Test("磁盘缓存符号链接不会读取外部文件或覆盖其内容")
    func refusesSymlinkCacheEntry() async throws {
        let dir = try directory(); defer { try? FileManager.default.removeItem(at: dir) }
        let external = FileManager.default.temporaryDirectory.appendingPathComponent("outside-image-" + UUID().uuidString)
        let outsideData = Data("外部文件不得读取".utf8)
        try outsideData.write(to: external)
        defer { try? FileManager.default.removeItem(at: external) }
        let key = SHA256.hash(data: Data(address.absoluteString.utf8)).map { String(format: "%02x", $0) }.joined()
        let cacheFile = dir.appendingPathComponent(key).appendingPathExtension("image")
        try FileManager.default.createSymbolicLink(at: cacheFile, withDestinationURL: external)
        let counter = ArtworkFetchCounter()
        let cache = ArtworkImageCache(directory: dir) { url in
            await counter.increment()
            return .init(statusCode: 200, finalURL: url, data: self.png)
        }
        #expect(try await cache.imageData(for: address) == png)
        #expect(await counter.count == 1)
        #expect(try Data(contentsOf: external) == outsideData)
    }

    @Test("缓存目录不可写时返回有效图片并保留进程内副本")
    func diskFailureFallsBackToMemory() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("artwork-cache-file-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("not a directory".utf8).write(to: root)
        let counter = ArtworkFetchCounter()
        let cache = ArtworkImageCache(directory: root) { url in
            await counter.increment()
            return .init(statusCode: 200, finalURL: url, data: self.png)
        }
        #expect(try await cache.imageData(for: address) == png)
        #expect(try await cache.imageData(for: address) == png)
        #expect(await counter.count == 1)
    }
}
