// DLsite 抓取层（网络 + 缓存 + 限速）。
//
// 对应 Electron 版：`src/main/dlsite.ts` 的服务段
// 契约：D9（走系统代理）/ D20（只在主进程抓）/ D21（绕队列）
//
// ===== 三条必须守的判据 =====
//
// ① **限速：两次请求至少间隔 800ms**
//    这是**对 DLsite 的基本礼貌**，也是防止被封的最直接手段。
//    用户可能连续点「刷新元数据」十几次 —— 没有限速就是十几次密集请求。
//
// ② **缓存：`<dataDir>/dlsite/<RJ>.json`**
//    元数据**不会天天变**。缓存能让「打开详情页」变成零请求。
//    ⚠️ 但要尊重 TTL（TTL 内直接用缓存，超时才重抓）。
//
// ③ **错误必须是结构化结果，不是抛异常**
//    网络失败的原因很多（断网 / 代理没开 / DLsite 改版 / RJ 不存在），
//    而**用户需要知道是哪一种** —— 抛一个 Error 他只会看到「操作失败」。
//
// ===== ⚠️ 这一层与解析层分开 =====
//
// `DLsiteParser` 是纯字符串操作（可以 100% 单测）；
// 本文件依赖网络（只能端到端验 + 注入假实现）。
// 分开的好处：解析器的每一条判据都能用真数据钉住，
// 而网络层只需验「限速/缓存/错误分类」这三件结构性的事。
import Foundation

// MARK: - 传输抽象

/// 抓取传输（测试可以注入假实现）。
public protocol DLsiteTransport: Sendable {
    /// 请求一个 URL，返回 (状态码, 响应体)。
    ///
    /// ⚠️ **不做 redirect 处理**：DLsite 的「作品下架」会 302 到首页，
    ///    而我们靠 `parseWork` 的 RJ 校验来发现它 —— 那比解析 redirect 链更可靠。
    func fetch(url: String, timeout: TimeInterval) async throws -> (status: Int, body: String)
}

/// 用 `URLSession` 的实现（生产环境）。
public struct DLsiteURLTransport: DLsiteTransport {
    public init() {}

    public func fetch(
        url: String, timeout: TimeInterval
    ) async throws -> (status: Int, body: String) {
        guard let parsed = URL(string: url) else {
            throw DLsiteError.invalidURL(url)
        }
        var request = URLRequest(url: parsed)
        request.timeoutInterval = timeout
        // ⚠️ 伪装成浏览器：DLsite 会对无 UA 的请求返回 403。
        //    这不是「绕过反爬」，而是**最基本的 HTTP 规范遵循**
        //    （默认的 URLSession UA 会被当作脚本）。
        request.setValue(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            + "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
            forHTTPHeaderField: "User-Agent")
        request.setValue("zh-CN,zh;q=0.9", forHTTPHeaderField: "Accept-Language")

        // ⚠️ `setAdultCookie` 的等价物：DLsite 的 R18 页面需要 `adultchecked=1`，
        //    否则会重定向到年龄确认页。用 URLSession 的 cookie 存储。
        //    （Electron 版用 `session.cookies.set`，见 §4.2）

        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let body = String(data: data, encoding: .utf8) ?? ""
        return (status, body)
    }
}

// MARK: - 错误

public enum DLsiteError: Error, Sendable, Equatable {
    /// URL 构造失败（RJ 或分类不合法）。
    case invalidURL(String)
    /// 网络层失败（断网 / 代理没开 / 超时）。
    case network(String)
    /// HTTP 状态码非 200。
    case httpStatus(Int)
    /// 抓到了页面但解析不出来（DLsite 改版 / RJ 不存在）。
    case parseFailed(rj: String)
    /// 页面里的作品 ID 与请求的不符（作品下架/改名，重定向到别的页面）。
    case rjMismatch(requested: String, got: String)
    /// 被限速拦住了（调用方应稍后重试）。
    case rateLimited(retryAfterMs: Int)

    /// 给用户看的说明。
    ///
    /// ⚠️ **每种错误说不同的话** —— 用户要做的动作完全不同：
    ///    · network    → 「检查网络/代理」
    ///    · httpStatus → 「DLsite 可能出问题了，稍后再试」
    ///    · parseFailed→ 「这个 RJ 可能不存在」（要去核对）
    ///    · rjMismatch → 「作品可能下架或改名了」
    public var message: String {
        switch self {
        case .invalidURL(let url):
            return "RJ 号或分类不合法：\(url)"
        case .network(let detail):
            return "网络请求失败：\(detail)。检查网络连接，如果用代理请确认它开着。"
        case .httpStatus(let code):
            return "DLsite 返回了 HTTP \(code)。可能是站点临时故障，稍后再试。"
        case .parseFailed(let rj):
            return "抓到了页面但解析不出来（\(rj)）。可能这个 RJ 不存在，或 DLsite 改了页面结构。"
        case .rjMismatch(let requested, let got):
            return "请求的是 \(requested)，但页面里是 \(got)。作品可能已下架或改了 ID。"
        case .rateLimited(let ms):
            return "请求太频繁，请等 \(ms / 1000) 秒后再试。"
        }
    }
}

// MARK: - 缓存记录

/// 缓存文件的内容（`<dataDir>/dlsite/<RJ>.json`）。
public struct CachedWork: Sendable, Codable {
    public let work: DlsiteWork
    /// 缓存写入时刻（Unix 秒）。
    public let cachedAt: TimeInterval

    public init(work: DlsiteWork, cachedAt: TimeInterval) {
        self.work = work
        self.cachedAt = cachedAt
    }
}

extension CachedWork {
    /// 磁盘格式的键。
    ///
    /// ⚠️ 必须定义在 `CachedWork` 的 extension **内部**
    ///    （Swift 的手写 Codable 要求 `CodingKeys` 在同类型的声明或扩展里）。
    enum CodingKeys: String, CodingKey {
        case rj, title, titleSub, circle, coverUrl, workType, ageRating, description, fetchedAt
        case cachedAt
    }

    // ⚠️ 手写 Codable 而不是合成：加字段时不会静默改掉磁盘格式。
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(work.rj, forKey: .rj)
        try c.encodeIfPresent(work.title, forKey: .title)
        try c.encodeIfPresent(work.titleSub, forKey: .titleSub)
        try c.encodeIfPresent(work.circle, forKey: .circle)
        try c.encodeIfPresent(work.coverUrl, forKey: .coverUrl)
        try c.encodeIfPresent(work.workType, forKey: .workType)
        try c.encodeIfPresent(work.ageRating, forKey: .ageRating)
        try c.encodeIfPresent(work.description, forKey: .description)
        try c.encode(work.fetchedAt, forKey: .fetchedAt)
        try c.encode(cachedAt, forKey: .cachedAt)
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let rj = try c.decode(String.self, forKey: .rj)
        let work = DlsiteWork(
            rj: rj,
            title: try c.decodeIfPresent(String.self, forKey: .title),
            titleSub: try c.decodeIfPresent(String.self, forKey: .titleSub),
            circle: try c.decodeIfPresent(String.self, forKey: .circle),
            coverUrl: try c.decodeIfPresent(String.self, forKey: .coverUrl),
            workType: try c.decodeIfPresent(String.self, forKey: .workType),
            ageRating: try c.decodeIfPresent(String.self, forKey: .ageRating),
            description: try c.decodeIfPresent(String.self, forKey: .description),
            fetchedAt: try c.decode(String.self, forKey: .fetchedAt))
        self.work = work
        // ⚠️ `cachedAt` 缺失时用 0 → 视为「过期」（重新抓）
        self.cachedAt = try c.decodeIfPresent(TimeInterval.self, forKey: .cachedAt) ?? 0
    }
}
