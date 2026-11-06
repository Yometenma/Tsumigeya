// DLsite 抓取服务：限速 + 缓存 + 错误分类。
//
// 接上 `DLsiteParser`（纯解析）与 `DLsiteTransport`（纯网络）。
//
// ===== 这一层要守的三件事 =====
//
// ① **限速**：两次请求之间至少 `minIntervalMs`（默认 800ms）
// ② **缓存**：TTL 内直接用缓存，不打网络
// ③ **错误不抛**：返回结构化 `Result`，让 UI 能按类型说不同的话
import Foundation

public actor DLsiteService {

    private let dataDir: String
    private let transport: DLsiteTransport
    /// 最小请求间隔（毫秒）。**测试传 0，生产用 800**。
    private let minIntervalMs: Int
    /// 单次请求超时（秒）。
    private let timeoutSeconds: TimeInterval
    /// 缓存有效期（秒）。默认 7 天。
    private let cacheTTL: TimeInterval
    /// 时间源（测试可注入）。
    private let now: @Sendable () -> TimeInterval

    /// 上次请求的时刻（限速用）。
    private var lastRequestAt: TimeInterval = -.infinity

    public init(
        dataDir: String,
        transport: DLsiteTransport = DLsiteURLTransport(),
        minIntervalMs: Int = 800,
        timeoutSeconds: TimeInterval = 15,
        cacheTTL: TimeInterval = 7 * 24 * 3600,
        now: @escaping @Sendable () -> TimeInterval = { Date().timeIntervalSince1970 }
    ) {
        self.dataDir = dataDir
        self.transport = transport
        self.minIntervalMs = minIntervalMs
        self.timeoutSeconds = timeoutSeconds
        self.cacheTTL = cacheTTL
        self.now = now
    }

    // MARK: - 缓存路径

    /// `<dataDir>/dlsite/<RJ>.json`
    public nonisolated func cachePath(rj: String) -> String {
        // 注意：String 没有 appendingPathComponent（那是 NSString 的方法）
        (((dataDir as NSString)
            .appendingPathComponent("dlsite")) as NSString)
            .appendingPathComponent("\(rj).json")
    }

    /// 读缓存（**不校验 TTL**，调用方决定）。
    public func readCache(rj: String) -> CachedWork? {
        let path = cachePath(rj: rj)
        guard let data = FileManager.default.contents(atPath: path),
              let cached = try? JSONDecoder().decode(CachedWork.self, from: data) else {
            return nil
        }
        return cached
    }

    /// 写缓存。
    func writeCache(_ cached: CachedWork) {
        let path = cachePath(rj: cached.work.rj)
        let dir = (path as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(
            atPath: dir, withIntermediateDirectories: true)

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(cached) else { return }
        try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
    }

    /// 缓存是否还在有效期内。
    func isCacheFresh(_ cached: CachedWork) -> Bool {
        let age = now() - cached.cachedAt
        // ⚠️ **未来时间戳当过期**（时钟回拨 / 用户改了系统时间）
        guard age >= 0 else { return false }
        return age < cacheTTL
    }

    // MARK: - 抓取

    /// 抓一部作品的元数据。
    ///
    /// - Parameters:
    ///   - rj: RJ 号（会先规范化）
    ///   - category: DLsite 的分类（`maniax` = R18 / `home` = 一般向）
    ///   - refresh: 强制重抓（忽略缓存 TTL）
    ///
    /// - Returns: 成功返回作品；失败返回**结构化错误**（不抛异常）
    public func fetchWork(
        rj rawRJ: String, category: String = "maniax", refresh: Bool = false
    ) async -> Result<DlsiteWork, DLsiteError> {

        // ① 规范化 RJ
        guard let rj = RJNumber.normalize(rawRJ) else {
            return .failure(.invalidURL(rawRJ))
        }

        // ② 缓存命中（非 refresh 时）
        if !refresh, let cached = readCache(rj: rj), isCacheFresh(cached) {
            return .success(cached.work)
        }

        // ③ 限速
        if let waitMs = rateLimitWaitMs() {
            // ⚠️ **返回 rateLimited 而不是 sleep 等待**：
            //    让调用方（UI）知道「现在不能立刻抓」，
            //    而不是让一个网络请求悄悄拖 800ms（那会让界面像卡住）。
            return .failure(.rateLimited(retryAfterMs: waitMs))
        }

        // ④ 构造 URL 并请求
        lastRequestAt = now()
        let url = Self.pageURL(category: category, rj: rj)

        let response: (status: Int, body: String)
        do {
            response = try await transport.fetch(url: url, timeout: timeoutSeconds)
        } catch {
            return .failure(.network(error.localizedDescription))
        }

        guard response.status == 200 else {
            return .failure(.httpStatus(response.status))
        }

        // ⑤ 解析
        guard let work = DLsiteParser.parseWork(
            from: response.body, rj: rj, fetchedAt: ISO8601.now()) else {
            return .failure(.parseFailed(rj: rj))
        }

        // ⑥ ⚠️ **RJ 必须对得上**（`parseWork` 内部也校验，这里再确认一次）
        //
        //    为什么两处都查：`parseWork` 只在 JSON 里查；
        //    如果页面连 JSON 都没有（纯 meta 兜底成功），那个校验会跳过。
        //    所以这里再确认一次 —— **拿到错作品的元数据比拿不到更糟**。
        guard work.rj == rj else {
            return .failure(.rjMismatch(requested: rj, got: work.rj))
        }

        // ⑦ 写缓存
        writeCache(CachedWork(work: work, cachedAt: now()))
        return .success(work)
    }

    /// 距离下次可请求还要等多久（毫秒）；nil = 可以立刻请求。
    func rateLimitWaitMs() -> Int? {
        guard minIntervalMs > 0 else { return nil }
        let elapsed = (now() - lastRequestAt) * 1000
        let remaining = Double(minIntervalMs) - elapsed
        guard remaining > 0 else { return nil }
        return Int(remaining)
    }

    /// 页面 URL（**唯一有效的格式**）。
    ///
    /// `https://www.dlsite.com/{category}/work/=/product_id/{RJ}.html`
    public nonisolated static func pageURL(category: String, rj: String) -> String {
        "https://www.dlsite.com/\(category)/work/=/product_id/\(rj).html"
    }
}

// MARK: - 时间格式化

enum ISO8601 {
    static func now() -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f.string(from: Date())
    }
}
