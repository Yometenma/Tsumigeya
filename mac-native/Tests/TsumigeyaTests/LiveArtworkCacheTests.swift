import Foundation
import Testing
@testable import TsumigeyaApp
@testable import TsumigeyaCore

@Suite("作品图片真实下载验收")
struct LiveArtworkCacheTests {
    @Test("真实封面与预览图下载后，新实例在断网替身下从磁盘读取",
          .enabled(if: ProcessInfo.processInfo.environment["TSUMIGEYA_LIVE_ARTWORK"] == "1"))
    func downloadsAndReadsOffline() async throws {
        let fixture = try #require(Bundle.module.url(forResource: "dlsite-modern-RJ331590", withExtension: "html"))
        let html = try String(contentsOf: fixture, encoding: .utf8)
        let work = try #require(DLsiteParser.parseWork(from: html, rj: "RJ331590", fetchedAt: "test"))
        let addresses = [try #require(work.coverUrl), try #require(work.sampleImageURLs.first)]
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("live-artwork-" + UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let online = ArtworkImageCache(directory: directory)
        var downloaded: [Data] = []
        for address in addresses {
            let url = try #require(ArtworkImageCache.normalizedURL(address))
            let data = try await online.imageData(for: url)
            #expect(ArtworkImageCache.isValidImage(data))
            downloaded.append(data)
        }
        let offline = ArtworkImageCache(directory: directory) { _ in
            Issue.record("已有图片应读磁盘，不应再次请求网络")
            throw URLError(.notConnectedToInternet)
        }
        for (index, address) in addresses.enumerated() {
            let url = try #require(ArtworkImageCache.normalizedURL(address))
            #expect(try await offline.imageData(for: url) == downloaded[index])
        }
    }
}
