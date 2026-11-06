// DLsite 抓取服务测试（限速 / 缓存 / 错误分类）。
//
// ===== 这一层测什么 =====
//
// 解析器用真数据测（P7DlsiteRealPageTests）。
// 本文件测的是**服务层的三件结构性的事**：
//
//   1. 限速：两次请求不为 0 间隔（对 DLsite 的基本礼貌，也是防封的直接手段）
//   2. 缓存：TTL 内不打网络
//   3. 错误**不抛异常**，返回结构化 Result（每种错误说不同的话）
//
// 用**假传输**测 —— 永远不联网（与 Download 层同一个取向）。
import Foundation
import Testing

@testable import TsumigeyaCore

/// 假传输：记录请求次数、可配置返回。
actor FakeTransport: DLsiteTransport {
    private(set) var requestCount = 0
    private(set) var requestedURLs: [String] = []
    private let status: Int
    private let body: String
    private let shouldThrow: Bool

    init(status: Int = 200, body: String = "", shouldThrow: Bool = false) {
        self.status = status
        self.body = body
        self.shouldThrow = shouldThrow
    }

    func fetch(url: String, timeout: TimeInterval) async throws -> (status: Int, body: String) {
        requestCount += 1
        requestedURLs.append(url)
        if shouldThrow {
            throw DLsiteError.network("模拟网络失败")
        }
        return (status, body)
    }
}

@Suite("DLsite 抓取服务")
struct DLsiteServiceTests {

    /// 造一个**唯一**的临时数据目录。
    ///
    /// ⚠️ **不能用固定路径**：Swift Testing 默认并行执行，
    ///    同一批测试共享一个固定目录（`dlsite-svc`）会互相覆盖缓存，
    ///    表现是**随机几条失败**（本鱼实测踩到「缓存命中」那条）。
    func makeDataDir() -> String {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("dlsite-svc-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.path
    }

    /// 一个最小的有效页面（能解析出 RJ 与标题）。
    func validPage(rj: String = "RJ294126") -> String {
        let json = "{\"detail\":[{\"id\":\"" + rj + "\",\"name\":\"测试作品\","
            + "\"work_type\":\"SOU\",\"category\":\"maniax\","
            + "\"image_main\":\"//img.dlsite.jp/a.jpg\"}],"
            + "\"impression\":[],\"time\":0.01}"
        return "<html><head>"
            + "<meta property=\"og:title\" content=\"测试作品 [社团] | DLsite\">"
            + "<meta property=\"og:image\" content=\"https://img.dlsite.jp/a.jpg\">"
            + "</head><body><script>var contents = " + json + "</script></body></html>"
    }

    /// 限速：连续两次请求，第二次必须被 rateLimited 挡住。
    @Test("限速")
    func rateLimit() async throws {
        let dataDir = makeDataDir()
        defer { try? FileManager.default.removeItem(atPath: dataDir) }

        let fake = FakeTransport(body: validPage())
        let service = DLsiteService(
            dataDir: dataDir, transport: fake,
            minIntervalMs: 800,
            now: { 1000.0 })

        let first = await service.fetchWork(rj: "RJ294126", refresh: true)
        guard case .success = first else {
            Issue.record("第一次应该成功")
            return
        }

        let second = await service.fetchWork(rj: "RJ294127", refresh: true)
        guard case .failure(.rateLimited(let ms)) = second else {
            Issue.record("第二次应该被限速挡住")
            return
        }
        #expect(ms > 0 && ms <= 800)

        let count = await fake.requestCount
        #expect(count == 1, "被限速时不该真的发请求")
    }

    /// 限速返回结构化错误而不是内部 sleep。
    @Test("限速不阻塞")
    func rateLimitDoesNotBlock() async throws {
        let dataDir = makeDataDir()
        defer { try? FileManager.default.removeItem(atPath: dataDir) }

        let fake = FakeTransport(body: validPage())
        let service = DLsiteService(
            dataDir: dataDir, transport: fake, minIntervalMs: 800,
            now: { 1000.0 })

        _ = await service.fetchWork(rj: "RJ294126", refresh: true)
        let start = Date()
        let result = await service.fetchWork(rj: "RJ294127", refresh: true)
        let elapsed = Date().timeIntervalSince(start)
        guard case .failure(.rateLimited) = result else {
            Issue.record("应该返回 rateLimited")
            return
        }
        #expect(elapsed < 0.5, "不该为了限速阻塞调用方")
    }

    /// 缓存命中时不打网络。
    @Test("缓存命中")
    func cacheHit() async throws {
        let dataDir = makeDataDir()
        defer { try? FileManager.default.removeItem(atPath: dataDir) }

        let fake = FakeTransport(body: validPage())
        let service = DLsiteService(
            dataDir: dataDir, transport: fake,
            minIntervalMs: 0,
            now: { 1000.0 })

        let first = await service.fetchWork(rj: "RJ294126")
        guard case .success = first else {
            Issue.record("第一次应该成功")
            return
        }
        let second = await service.fetchWork(rj: "RJ294126")
        guard case .success = second else {
            Issue.record("第二次应该成功（缓存）")
            return
        }

        let count = await fake.requestCount
        #expect(count == 1, "第二次该走缓存，不该再请求")
    }

    /// refresh 忽略缓存。
    @Test("refresh 忽略缓存")
    func refreshBypassesCache() async throws {
        let dataDir = makeDataDir()
        defer { try? FileManager.default.removeItem(atPath: dataDir) }

        let fake = FakeTransport(body: validPage())
        let service = DLsiteService(
            dataDir: dataDir, transport: fake, minIntervalMs: 0, now: { 1000.0 })

        _ = await service.fetchWork(rj: "RJ294126")
        _ = await service.fetchWork(rj: "RJ294126", refresh: true)

        let count = await fake.requestCount
        #expect(count == 2, "refresh 应该绕过缓存")
    }

    /// 缓存过期后重新抓。
    @Test("缓存过期")
    func cacheExpiry() async throws {
        let dataDir = makeDataDir()
        defer { try? FileManager.default.removeItem(atPath: dataDir) }

        let clock = MutableClock(start: 1000)
        let fake = FakeTransport(body: validPage())
        let service = DLsiteService(
            dataDir: dataDir, transport: fake, minIntervalMs: 0,
            cacheTTL: 7 * 24 * 3600,
            now: { clock.now() })

        _ = await service.fetchWork(rj: "RJ294126")
        clock.advance(by: 8 * 24 * 3600)
        _ = await service.fetchWork(rj: "RJ294126")

        let count = await fake.requestCount
        #expect(count == 2, "缓存过期后应该重抓")
    }

    /// HTTP 非 200 → 结构化错误。
    @Test("HTTP 错误")
    func httpError() async throws {
        let dataDir = makeDataDir()
        defer { try? FileManager.default.removeItem(atPath: dataDir) }

        let fake = FakeTransport(status: 503, body: "Service Unavailable")
        let service = DLsiteService(
            dataDir: dataDir, transport: fake, minIntervalMs: 0, now: { 1000.0 })

        let result = await service.fetchWork(rj: "RJ294126", refresh: true)
        guard case .failure(.httpStatus(503)) = result else {
            Issue.record("应该是 httpStatus(503)")
            return
        }
    }

    /// 网络失败 → 结构化错误。
    @Test("网络失败")
    func networkError() async throws {
        let dataDir = makeDataDir()
        defer { try? FileManager.default.removeItem(atPath: dataDir) }

        let fake = FakeTransport(shouldThrow: true)
        let service = DLsiteService(
            dataDir: dataDir, transport: fake, minIntervalMs: 0, now: { 1000.0 })

        let result = await service.fetchWork(rj: "RJ294126", refresh: true)
        guard case .failure(.network) = result else {
            Issue.record("应该是 network 错误")
            return
        }
    }

    /// 解析失败 → 结构化错误。
    @Test("解析失败")
    func parseError() async throws {
        let dataDir = makeDataDir()
        defer { try? FileManager.default.removeItem(atPath: dataDir) }

        let fake = FakeTransport(body: "<html><body>什么都没有</body></html>")
        let service = DLsiteService(
            dataDir: dataDir, transport: fake, minIntervalMs: 0, now: { 1000.0 })

        let result = await service.fetchWork(rj: "RJ294126", refresh: true)
        guard case .failure(.parseFailed) = result else {
            Issue.record("应该是 parseFailed")
            return
        }
    }

    /// RJ 不匹配时绝不能返回 success（会拿到别的作品的封面）。
    @Test("RJ 不匹配")
    func rjMismatch() async throws {
        let dataDir = makeDataDir()
        defer { try? FileManager.default.removeItem(atPath: dataDir) }

        let fake = FakeTransport(body: validPage(rj: "RJ999999"))
        let service = DLsiteService(
            dataDir: dataDir, transport: fake, minIntervalMs: 0, now: { 1000.0 })

        let result = await service.fetchWork(rj: "RJ294126", refresh: true)
        if case .success = result {
            Issue.record("RJ 不匹配时绝不能返回 success")
        }
    }

    /// URL 构造。
    @Test("页面 URL")
    func pageURL() {
        let url = DLsiteService.pageURL(category: "maniax", rj: "RJ294126")
        #expect(url == "https://www.dlsite.com/maniax/work/=/product_id/RJ294126.html")
    }

    /// 非法 RJ → invalidURL（不崩、不发请求）。
    @Test("非法 RJ")
    func invalidRJ() async throws {
        let dataDir = makeDataDir()
        defer { try? FileManager.default.removeItem(atPath: dataDir) }

        let fake = FakeTransport(body: validPage())
        let service = DLsiteService(
            dataDir: dataDir, transport: fake, minIntervalMs: 0, now: { 1000.0 })

        let result = await service.fetchWork(rj: "不是RJ", refresh: true)
        guard case .failure(.invalidURL) = result else {
            Issue.record("应该是 invalidURL")
            return
        }
        let count = await fake.requestCount
        #expect(count == 0, "非法 RJ 不该发请求")
    }

    /// 每种错误的文案必须不同（用户要做的动作不同）。
    @Test("错误文案各不相同")
    func errorMessagesDiffer() {
        let messages = [
            DLsiteError.network("x").message,
            DLsiteError.httpStatus(503).message,
            DLsiteError.parseFailed(rj: "RJ294126").message,
            DLsiteError.rjMismatch(requested: "A", got: "B").message,
            DLsiteError.rateLimited(retryAfterMs: 500).message,
        ]
        #expect(Set(messages).count == messages.count, "每种错误要有不同的说明")
    }
}

// MARK: - 可变时钟

/// 可变时钟（缓存过期测试用）。
///
/// 用带锁的类而不是 `var` 捕获：`now` 是 `@Sendable () -> TimeInterval`。
final class MutableClock: @unchecked Sendable {
    private let lock = NSLock()
    private var value: TimeInterval

    init(start: TimeInterval) { self.value = start }

    func now() -> TimeInterval {
        lock.lock(); defer { lock.unlock() }
        return value
    }

    func advance(by seconds: TimeInterval) {
        lock.lock(); defer { lock.unlock() }
        value += seconds
    }
}
