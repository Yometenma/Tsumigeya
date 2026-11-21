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

    private var lastRequestStart: ContinuousClock.Instant?

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
    public nonisolated func cachePath(rj: String, language: MetadataLanguage? = nil) -> String {
        // 注意：String 没有 appendingPathComponent（那是 NSString 的方法）
        (((dataDir as NSString)
            .appendingPathComponent(language.map { "dlsite/" + $0.rawValue } ?? "dlsite")) as NSString)
            .appendingPathComponent("\(rj).json")
    }

    /// 读缓存（**不校验 TTL**，调用方决定）。
    public func readCache(rj: String, language: MetadataLanguage? = nil) -> CachedWork? {
        let path = cachePath(rj: rj, language: language)
        guard let data = FileManager.default.contents(atPath: path),
              let cached = try? JSONDecoder().decode(CachedWork.self, from: data) else {
            return nil
        }
        return cached
    }

    /// 保留未知缓存字段；损坏原件和备份失败都停止写入。
    @discardableResult
    func writeCache(_ cached: CachedWork) -> String? {
        let url = URL(fileURLWithPath: cachePath(rj: cached.work.rj, language: cached.work.requestedLanguage.flatMap(MetadataLanguage.init(rawValue:))))
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            var raw: [String: JSONValue] = [:]
            if FileManager.default.fileExists(atPath: url.path) {
                raw = try JSONDecoder().decode([String: JSONValue].self, from: Data(contentsOf: url))
            }
            let encoded = try JSONDecoder().decode([String: JSONValue].self, from: JSONEncoder().encode(cached))
            for key in CachedWork.CodingKeys.allCases { raw.removeValue(forKey: key.rawValue) }
            raw.merge(encoded) { _, new in new }
            return JSONStore.save(raw, to: url)
        } catch { return error.localizedDescription }
    }

    /// 缓存是否还在有效期内。
    func isCacheFresh(_ cached: CachedWork) -> Bool {
        guard cached.formatVersion >= 2 else { return false }
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
        rj rawRJ: String, category: String = "maniax", refresh: Bool = false, language: MetadataLanguage? = nil
    ) async -> Result<DlsiteWork, DLsiteError> {

        guard ["maniax", "home", "pro"].contains(category) else { return .failure(.invalidURL(category)) }
        // ① 规范化 RJ
        guard let rj = RJNumber.normalize(rawRJ) else {
            return .failure(.invalidURL(rawRJ))
        }

        // ② 缓存命中（非 refresh 时）
        if !refresh, let cached = readCache(rj: rj, language: language), cached.work.rj == rj, cached.work.requestedLanguage == language?.rawValue, isCacheFresh(cached) {
            return .success(cached.work)
        }

        // ③ 限速
        do { try await waitForRequestSlot() }
        catch { return .failure(.cancelled) }

        let url = Self.pageURL(category: category, rj: rj, language: language)

        let response: (status: Int, body: String)
        do {
            response = try await transport.fetch(url: url, timeout: timeoutSeconds)
        } catch {
            return .failure(Task.isCancelled ? .cancelled : .network(error.localizedDescription))
        }

        guard !Task.isCancelled else { return .failure(.cancelled) }
        guard response.status == 200 else {
            return .failure(.httpStatus(response.status))
        }

        if Self.isVerificationPage(response.body) { return .failure(.verificationRequired) }
        // ⑤ 解析
        guard var work = DLsiteParser.parseWork(
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

        work.requestedLanguage = language?.rawValue
        work.metadataLanguage = MetadataLanguage.detect(response.body)?.rawValue
        work.category = work.category ?? category
        // 缓存独立于游戏信息，但不能覆盖损坏原件或绕过备份失败。
        if let error = writeCache(CachedWork(work: work, cachedAt: now())) {
            return .failure(.storage(error))
        }
        return .success(work)
    }

    /// 按名字搜索作品。
    ///
    /// ⚠️ **只返回候选列表，绝不自动选**（D24 —— 实测搜 `Karryn` 返回
    ///   正片 + 3 个 DLC，首条虽然碰巧是对的，但别的关键词常不是）。
    ///
    /// - Returns: 成功返回候选列表（可能为空 = 真没搜到）；
    ///   失败返回结构化错误（与 `fetchWork` 同一套错误类型）。
    public func search(
        keyword: String, category: String = "maniax", language: MetadataLanguage? = nil
    ) async -> Result<[DLsiteSearch.Hit], DLsiteError> {

        guard let url = DLsiteSearch.searchURL(
            keyword: keyword, category: category, language: language) else {
            return .failure(.invalidURL(keyword))
        }

        do { try await waitForRequestSlot() }
        catch { return .failure(.cancelled) }
        let response: (status: Int, body: String)
        do {
            response = try await transport.fetch(url: url, timeout: timeoutSeconds)
        } catch {
            return .failure(Task.isCancelled ? .cancelled : .network(error.localizedDescription))
        }

        guard response.status == 200 else {
            return .failure(.httpStatus(response.status))
        }

        if Self.isVerificationPage(response.body) { return .failure(.verificationRequired) }
        // ⚠️ **必须确认是结果页**：搜不到时 DLsite 返回普通页面，
        //    直接解析会得到空列表，而用户分不清「没有这个作品」与「解析失败」。
        guard DLsiteSearch.isResultPage(response.body) else {
            return .failure(.parseFailed(rj: String(format: L10n.string("搜索：%@"), "\(keyword)")))
        }

        let hits = DLsiteSearch.parse(response.body).map {
            DLsiteSearch.Hit(rj: $0.rj, title: $0.title, circle: $0.circle,
                             coverUrl: $0.coverUrl, order: $0.order, category: category)
        }
        // ⚠️ 结果页成立但解析出 0 条 → 这是**真的没搜到**，不是错误
        //    （`Result.success([])` 与 `parseFailed` 是两件事）
        return .success(hits)
    }

    /// 等待后重新检查实际发起时刻，防止 actor 重入或系统调度延迟让请求挤在一起。
    private func waitForRequestSlot() async throws {
        try Task.checkCancellation()
        while let previous = lastRequestStart {
            let remaining = previous.advanced(by: .milliseconds(minIntervalMs)) - .now
            if remaining <= .zero { break }
            try await Task.sleep(for: remaining)
            try Task.checkCancellation()
        }
        lastRequestStart = .now
    }

    public func fetchResolved(rj: String, category: String? = nil, refresh: Bool = false, preference: MetadataLanguagePreference? = nil) async -> Result<DlsiteWork, DLsiteError> {
        let categories = category.map { [$0] } ?? ["maniax", "home", "pro"]
        var last: DLsiteError = .parseFailed(rj: rj)
        for category in categories {
            let result = await fetchWork(rj: rj, category: category, refresh: refresh, language: preference?.preferred)
            switch result {
            case .success(var work):
                // 页面缺少目标语言时只在同一个 RJ 内回退，绝不自动换到翻译版商品。
                if let preference, let actualLanguage = work.metadataLanguage, actualLanguage != preference.preferred.rawValue,
                   let fallback = preference.fallback, fallback != preference.preferred {
                    let result = await fetchWork(rj: rj, category: category, refresh: refresh, language: fallback)
                    if case .success(let fallbackWork) = result { work = fallbackWork }
                    if case .failure(.cancelled) = result { return .failure(.cancelled) }
                }
                work.category = work.category ?? category
                return .success(work)
            case .failure(let error):
                last = error
                switch error {
                case .httpStatus(404), .parseFailed:
                    if let preference, let fallback = preference.fallback, fallback != preference.preferred {
                        let fallbackResult = await fetchWork(rj: rj, category: category, refresh: refresh, language: fallback)
                        if case .success = fallbackResult { return fallbackResult }
                        if case .failure(.cancelled) = fallbackResult { return .failure(.cancelled) }
                    }
                    continue
                default: return .failure(error)
                }
            }
        }
        return .failure(last)
    }

    public struct SearchReport: Sendable, Equatable {
        public let hits: [DLsiteSearch.Hit]
        public let warnings: [String]
        public let keywordsTried: [String]
    }

    public func searchAll(keyword: String, category: String? = nil) async -> Result<[DLsiteSearch.Hit], DLsiteError> {
        await searchReport(keyword: keyword, category: category).map(\.hits)
    }

    /// 保持页面顺序，跨分类按编号去重；部分分类失败不能丢掉已找到的候选。
    public func searchReport(keyword: String, category: String? = nil, preference: MetadataLanguagePreference? = nil) async -> Result<SearchReport, DLsiteError> {
        let categories = category.map { [$0] } ?? ["maniax", "home"]
        var tried: [String] = []
        for variant in DlsiteLookup.keywordVariants(keyword) {
            tried.append(variant)
            var hits: [DLsiteSearch.Hit] = []
            var warnings: [String] = []
            var firstError: DLsiteError?
            var seen: Set<String> = []
            for category in categories {
                var result = await search(keyword: variant, category: category, language: preference?.preferred)
                if case .success(let found) = result, found.isEmpty,
                   let preference, let fallback = preference.fallback, fallback != preference.preferred {
                    result = await search(keyword: variant, category: category, language: fallback)
                }
                switch result {
                case .success(let found):
                    hits += found.filter { seen.insert($0.rj).inserted }
                case .failure(.cancelled): return .failure(.cancelled)
                case .failure(let error):
                    firstError = firstError ?? error
                    let scope = category == "home" ? L10n.string("一般向") : (category == "pro" ? L10n.string("商业作品") : L10n.string("成人向同人"))
                    warnings.append(String(format: L10n.string("%@未完成：%@"), "\(scope)", "\(error.message)"))
                }
            }
            if !hits.isEmpty { return .success(SearchReport(hits: hits, warnings: warnings, keywordsTried: tried)) }
            // 网络或验证错误不是空结果，不能触发名称回退而掩盖故障。
            if let firstError { return .failure(firstError) }
        }
        return .success(SearchReport(hits: [], warnings: [], keywordsTried: tried))
    }

    private static func isVerificationPage(_ html: String) -> Bool {
        let title = DLsiteSearch.extractTitle(html)?.lowercased() ?? ""
        return title.contains("just a moment") || title.contains("captcha") || title.contains(L10n.string("年齢確認"))
    }

    /// 页面 URL（**唯一有效的格式**）。
    ///
    /// `https://www.dlsite.com/{category}/work/=/product_id/{RJ}.html`
    public nonisolated static func pageURL(category: String, rj: String, language: MetadataLanguage? = nil) -> String {
        "https://www.dlsite.com/\(category)/work/=/product_id/\(rj).html" + (language.map { "?locale=" + $0.rawValue } ?? "")
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
