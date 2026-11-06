// DLsite 按名字搜索（解析 + URL 构造）。
//
// 对应 Electron 版：`src/main/dlsite.ts` 的 `buildSearchUrl` / `isSearchResultPage` / `parseSearchResults`
// 契约：D23（优先结构化锚点 `data-list_item_product_id`）/ D24（**绝不自动选第一条**）
//
// ===== ⚠️ 为什么绝不自动选第一条（D24）=====
//
// 实测：搜 `Karryn` 返回 4 条 —— **正片 + 3 个 DLC**：
//   · RJ331590   カリンズ・プリズン KARRYN'S PRISON     ← 正片
//   · RJ01063435 カリンズ・プリズン ジムトレーナーDLC
//   · RJ01036147 カリンズ・プリン ン 毛DLC
//   · RJ01260870 カリンズ・プリズン 魔乳DLC
//
// 如果是别的关键词，首条**经常不是**目标作品（同名续作、DLC、合集）。
// 自动选第一条 = 拿错的封面 + 错的简介，而用户不会意识到「这是别的作品的」。
//
// → 搜索只**返回候选列表**，由用户点选。（UI 侧负责展示。）
//
// ===== ⚠️ 结构化锚点优先于 href 正则（D23）=====
//
// 真实结果页每个作品都带 `data-list_item_product_id="RJ…"`，
// 而且每个 RJ 在整条记录里会**重复 5 次**（缩略图 / 链接 / 购物车按钮…）
// → **必须按 RJ 去重**。
//
// 用纯 href 正则（`product_id/RJ\d+`）会把按钮文案里的 RJ 也扫进来。
import Foundation

public enum DLsiteSearch {

    /// 搜索结果上限（DLsite 一页 25 条，取前 20）。
    public static let resultLimit = 20

    // MARK: - URL

    /// 构造搜索 URL。
    ///
    /// **唯一有效的格式**（M2.5 §1.1 实测）：
    /// `https://www.dlsite.com/{category}/fsr/=/keyword/{编码关键词}`
    ///
    /// ⚠️ 其余写法（`/fs?keyword=`、`/fsr/=/keywords/`）要么 404，
    ///    要么返回「条件搜索页」而非结果页。
    ///
    /// ⚠️ `category` **必须是纯小写字母**（注入别的字符会拼出非法 URL）。
    public static func searchURL(
        keyword: String, category: String = "maniax"
    ) -> String? {
        let trimmed = keyword.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        // category 白名单式校验（只允许小写字母）
        let safeCategory = category.unicodeScalars.allSatisfy {
            (0x61...0x7A).contains($0.value)
        } && !category.isEmpty ? category : "maniax"

        // ⚠️ 用 `addingPercentEncoding` 而不是手拼 —— 日文关键词必须编码
        guard let encoded = trimmed.addingPercentEncoding(
            withAllowedCharacters: .urlQueryAllowed) else { return nil }

        return "https://www.dlsite.com/\(safeCategory)/fsr/=/keyword/\(encoded)"
    }

    /// 搜索结果页判据：`<title>` 含「検索結果」。
    ///
    /// ⚠️ 为什么要这条：搜不到时 DLsite 返回的是**普通页面**（不是空列表），
    ///    直接解析会得到空结果，而用户分不清「没有这个作品」与「解析失败」。
    public static func isResultPage(_ html: String) -> Bool {
        guard let title = extractTitle(html) else { return false }
        return title.contains("検索結果")
    }

    /// 提取 `<title>` 内容。
    public static func extractTitle(_ html: String) -> String? {
        guard let start = html.range(of: "<title", options: .caseInsensitive),
              let gt = html.range(of: ">", range: start.upperBound..<html.endIndex),
              let end = html.range(
                of: "</title>", options: .caseInsensitive,
                range: gt.upperBound..<html.endIndex) else {
            return nil
        }
        return String(html[gt.upperBound..<end.lowerBound])
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - 解析

    /// 一条搜索结果。
    public struct Hit: Sendable, Equatable, Identifiable {
        public var id: String { rj }
        /// 规范化大写（`RJ331590`）。
        public let rj: String
        /// 标题（已过滤噪音）。
        public let title: String
        /// 社团名（`maker_name` 块）。
        public let circle: String?
        /// 封面（已归一化到 https + 白名单）。
        public let coverUrl: String?
        /// 页面里的顺序（保持 DLsite 的排序，不重排 —— 相关性是它算的）。
        public let order: Int

        public init(
            rj: String, title: String, circle: String?,
            coverUrl: String?, order: Int
        ) {
            self.rj = rj
            self.title = title
            self.circle = circle
            self.coverUrl = coverUrl
            self.order = order
        }
    }

    /// 解析搜索结果页。
    ///
    /// - Returns: 按 RJ 去重、**保持页面顺序**的候选列表。
    ///
    /// ⚠️ **保持页面顺序**：DLsite 的排序是它算的相关性，
    ///    我们重排（比如按 RJ 大小、按标题长度）会打乱那个信号。
    public static func parse(
        _ html: String, limit: Int = DLsiteSearch.resultLimit
    ) -> [Hit] {
        guard !html.isEmpty else { return [] }

        // ① 找所有结构化锚点（`data-list_item_product_id="RJ…"`）
        let anchors = anchorPositions(in: html)
        guard !anchors.isEmpty else {
            // ⚠️ 没有锚点时**返回空**，不退回宽松匹配。
            //
            //    宽松模式（扫所有 `product_id/RJ\d+`）会把按钮文案里的 RJ 也扫进来，
            //    得到一堆重复 + 噪音。**宁可没有，也不要脏数据** ——
            //    脏数据会被用户当成「真搜索结果」。
            return []
        }

        var hits: [Hit] = []
        var seen: Set<String> = []

        for (index, anchor) in anchors.enumerated() {
            // 这条记录的文本范围：从本锚点到下一个锚点
            let start = anchor.range.location
            let end = index + 1 < anchors.count
                ? anchors[index + 1].range.location
                : html.count
            guard start < end else { continue }

            let chunk = substring(html, from: start, to: end)
            guard let rj = RJNumber.normalize(anchor.rj) else { continue }
            // ② 按 RJ 去重（同一 RJ 在整条记录里重复 5 次）
            guard !seen.contains(rj) else { continue }
            seen.insert(rj)

            // ③ 标题：`work_name` 块的 `<a title="...">`
            guard let title = extractWorkName(chunk), !title.isEmpty else { continue }
            // ④ 社团：`maker_name` 块
            let circle = extractCircle(chunk)
            // ⑤ 封面：`img_main`（240x240 缩略图）
            let cover = extractCover(chunk)

            hits.append(Hit(
                rj: rj, title: title, circle: circle,
                coverUrl: cover, order: index))

            if hits.count >= limit { break }
        }

        return hits
    }

    // MARK: - 锚点

    public struct Anchor: Sendable {
        public let rj: String
        let range: NSRange
    }

    /// 找所有结构化锚点。
    ///
    /// ⚠️ 锚点形如 `data-list_item_product_id="RJ331590"`。
    ///    用正则找而不是字符串查找 —— 要**位置**（切记录范围用）。
    public static func anchorPositions(in html: String) -> [Anchor] {
        let pattern = "data-list_item_product_id=\"([^\"]+)\""
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }

        let ns = html as NSString
        let matches = regex.matches(
            in: html, range: NSRange(location: 0, length: ns.length))

        return matches.compactMap { match in
            guard match.numberOfRanges >= 2 else { return nil }
            let rj = ns.substring(with: match.range(at: 1))
            return Anchor(rj: rj, range: match.range)
        }
    }

    // MARK: - 字段提取

    /// 从一条记录里提取标题（`work_name` 块的 `title` 属性）。
    ///
    /// ⚠️ 真实结构：
    /// `<dd class="work_name"><a href="…" title="カリンズ・プリズン KARRYN&#039;S PRISON">`
    ///
    /// ⚠️ **必须解码 HTML 实体**（`&#039;` → `'`），否则标题里会出现 `&#039;`。
    static func extractWorkName(_ chunk: String) -> String? {
        guard let blockStart = chunk.range(of: "class=\"work_name\""),
              let blockEnd = chunk.range(
                of: "</dd>", range: blockStart.upperBound..<chunk.endIndex) else {
            return nil
        }
        let block = String(chunk[blockStart.lowerBound..<blockEnd.upperBound])

        // 优先 `title` 属性（比标签内文本干净：不带嵌套 div 的空白）
        if let title = firstAttribute(in: block, name: "title") {
            let decoded = DLsiteParser.decodeEntities(title)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !decoded.isEmpty { return decoded }
        }
        return nil
    }

    /// 从一条记录里提取社团名（`maker_name` 块）。
    static func extractCircle(_ chunk: String) -> String? {
        guard let blockStart = chunk.range(of: "class=\"maker_name\""),
              let blockEnd = chunk.range(
                of: "</dd>", range: blockStart.upperBound..<chunk.endIndex) else {
            return nil
        }
        let block = String(chunk[blockStart.lowerBound..<blockEnd.upperBound])

        // 标签之间的文本：`<a ...>Remtairy (レムテイリー)</a>`
        //
        // ⚠️⚠️ **必须从 `<dd class="maker_name"` 之后开始找 `>`**。
        //
        //    本鱼第一版写的是 `block.range(of: ">")` —— 从 block **开头**找，
        //    而 block 本身就含 `<dd class="maker_name"><a href="...">`，
        //    于是第一个 `>` 落在 `<dd ...>` 的结尾 → 切出来的文本里
        //    **混进了整个 `<a href="...">` 标签**（探针实测看到）。
        //
        //    正确做法：先定位到 `class="maker_name"` 之后，再从那个位置找 `>`。
        // ⚠️⚠️ **必须找 `<a` 标签的 `>`，不是 dd 的 `>`**（探针实测）。
        //
        //    真实结构是：`<dd class="maker_name"><a href="...">Remtairy</a></dd>`
        //
        //    从 `class="maker_name"` 往后找第一个 `>` → 那是 **`<dd ...>` 的结尾**
        //    → 切出来的文本会从 `<a href=...` 开始，**混进整个 a 标签**。
        //
        //    正确做法：先定位 `<a`，再从 `<a` 往后找 `>`。
        guard let classRange = block.range(of: "class=\"maker_name\"") else {
            return nil
        }
        guard let aStart = block.range(of: "<a",
                                       range: classRange.upperBound..<block.endIndex) else {
            return nil
        }
        guard let gt = block.range(of: ">", range: aStart.upperBound..<block.endIndex),
              let close = block.range(of: "</a>",
                                      range: gt.upperBound..<block.endIndex) else {
            return nil
        }
        let raw = String(block[gt.upperBound..<close.lowerBound])
        let decoded = DLsiteParser.decodeEntities(raw)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return decoded.isEmpty ? nil : decoded
    }

    /// 从一条记录里提取封面。
    ///
    /// ⚠️ 真实结构里缩略图是 `//img.dlsite.jp/.../RJ331590_img_main_240x240.webp`。
    ///    用 `img_main` 而不是 `_240x240` —— 前者是原图在 `alt` 附近，
    ///    但**搜索页只给了缩略图**，所以取缩略图即可（列表里不需要大图）。
    static func extractCover(_ chunk: String) -> String? {
        // 找第一个 `img.dlsite.jp` 的图片地址
        guard let range = chunk.range(of: "//img.dlsite.jp/") else { return nil }
        // 往后找引号结束
        let rest = chunk[range.lowerBound...]
        guard let quote = rest.firstIndex(where: { $0 == "'" || $0 == "\"" }) else {
            return nil
        }
        let raw = String(rest[..<quote])
        return DLsiteParser.normalizeCoverUrl(raw)
    }

    /// 从一段文本里取第一个 `name="value"` 或 `name='value'`。
    static func firstAttribute(in text: String, name: String) -> String? {
        for quote in ["\"", "'"] {
            let pattern: String
            if quote == "\"" {
                pattern = name + "=\"([^\"]*)\""
            } else {
                pattern = name + "='([^']*)'"
            }
            guard let regex = try? NSRegularExpression(pattern: pattern) else { continue }
            let ns = text as NSString
            if let match = regex.firstMatch(
                in: text, range: NSRange(location: 0, length: ns.length)),
               match.numberOfRanges >= 2 {
                return ns.substring(with: match.range(at: 1))
            }
        }
        return nil
    }

    /// 按字符索引切子串（`NSRange` 是 UTF-16 单位的，`String` 索引要转换）。
    ///
    /// ⚠️ **不能用 `String.prefix(n)`**（那是按 Character 数，与 UTF-16 对不上）。
    static func substring(_ text: String, from: Int, to: Int) -> String {
        let ns = text as NSString
        let length = ns.length
        let start = min(max(0, from), length)
        let end = min(max(start, to), length)
        return ns.substring(with: NSRange(location: start, length: end - start))
    }
}
