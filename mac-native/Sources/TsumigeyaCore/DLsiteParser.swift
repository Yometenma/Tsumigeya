// DLsite 页面解析（**纯字符串操作，零网络**）。
//
// 对应 Electron 版：`src/main/dlsite.ts` 的解析段（约 200 行）
// 契约：D19（只解析 `var contents` JSON，**不抓 DOM**）/ D22（封面 host 白名单）
//       D23（搜索优先结构化锚点）/ D40（标签不建空字段）
//
// ===== 为什么要自己写 JSON 扫描而不是正则 =====
//
// 网上流传的抓法是用正则 `/var\s+contents\s*=(\{[\s\S]*?\});/`。
// **那个正则是错的**：非贪婪 `*?` 遇到**作品简介里出现的 `};`** 会提前截断。
//
// 实测：RJ294126 的简介里有「……};……」这种字符组合的话，
// 正则会在那里断掉，得到一个残缺的 JSON → 解析失败 → **整部作品的元数据全空**。
// 而这种失败**不会报错**，只是「抓不到东西」，用户会以为 DLsite 上没有这部作品。
//
// 所以必须做**字符串感知的括号配对扫描**：只在字符串之外计括号。
import Foundation

public enum DLsiteParser {

    // MARK: - 站点尾巴标记

    /// 站点自述的尾巴标记（`og:description` 里混进去的站点广告）。
    ///
    /// ⚠️ 为什么必须清洗：那个字段是「**作品简介 + 站点广告**」拼接的。
    ///    直接拿去渲染会把「国内最大級の二次元総合ダウンロードショップ」
    ///    贴到**每一张卡片**上，非常难看。
    ///
    /// 实测（RJ294126）：260 字 → 122 字，正好剥在
    /// 「「DLsite 同人 - R18」は同人誌…」之前。
    static let siteTailMarkers = [
        "「DLsite 同人",
        "DLsite は、",
        "国内最大級の二次元",
        "DLsiteは、",
    ]

    // MARK: - 简介清洗

    /// 清洗 `og:description`：剥掉站点自述的尾巴。
    ///
    /// - Returns: 清洗后的简介；**全空则返回 nil**（视为无简介，UI 显示「暂无」）。
    public static func cleanupDescription(_ raw: String?) -> String? {
        guard let raw, !raw.trimmingCharacters(in: .whitespaces).isEmpty else {
            return nil
        }
        var cut = raw.count
        for marker in siteTailMarkers {
            if let range = raw.range(of: marker) {
                let index = raw.distance(from: raw.startIndex, to: range.lowerBound)
                if index < cut { cut = index }
            }
        }
        let cleaned = String(raw.prefix(cut))
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty ? nil : cleaned
    }

    // MARK: - HTML 实体

    /// 极简 HTML 实体解码（`og:content` 里常见 `&amp;` / `&#xXXXX;`）。
    ///
    /// ⚠️ **只处理常见的几种**，不用完整 HTML 实体表：
    ///    DLsite 的 meta 字段里出现的就是这几种。
    ///    完整表有 2000+ 项，对这里没有收益（而且那是 Foundation 的活）。
    public static func decodeEntities(_ value: String) -> String {
        let named: [String: String] = [
            "amp": "&", "lt": "<", "gt": ">", "quot": "\"",
            "apos": "'", "nbsp": " ",
        ]

        var result = ""
        var index = value.startIndex
        while index < value.endIndex {
            guard value[index] == "&" else {
                result.append(value[index])
                index = value.index(after: index)
                continue
            }
            // 找配对的 `;`
            guard let semi = value[index...].firstIndex(of: ";"),
                  value.distance(from: index, to: semi) <= 10 else {
                result.append(value[index])
                index = value.index(after: index)
                continue
            }
            let body = String(value[value.index(after: index)..<semi])

            if body.hasPrefix("#") {
                // 数字实体（`#123` 或 `#x1A`）
                let hex = body.hasPrefix("#x") || body.hasPrefix("#X")
                let numStr = hex ? String(body.dropFirst(2)) : String(body.dropFirst())
                if let code = Int(numStr, radix: hex ? 16 : 10),
                   let scalar = Unicode.Scalar(code) {
                    result.append(Character(scalar))
                    index = value.index(after: semi)
                    continue
                }
            } else if let replacement = named[body.lowercased()] {
                result.append(contentsOf: replacement)
                index = value.index(after: semi)
                continue
            }
            // 不认识的实体 → 原样保留
            result.append(value[index])
            index = value.index(after: index)
        }
        return result
    }

    // MARK: - 括号配对扫描（**关键**）

    /// 从 `start` 处的 `{` 做**字符串感知**的括号配对扫描。
    ///
    /// - Returns: 匹配的 `}` 的下标（**相对整个文本**）；失败返回 nil。
    ///
    /// ⚠️ **这条是解析 DLsite 页面的地基**（见文件头）：
    ///    正则 `(\{[\s\S]*?\})` 遇到字符串里的 `};` 会提前截断，
    ///    而作品简介里什么字符都可能出现。
    ///
    /// 本扫描只在**字符串之外**计括号，能正确跨过 `"note":"…};…"`。
    public static func scanBalancedObject(_ text: String, from start: Int) -> Int? {
        let chars = Array(text)
        guard start < chars.count, chars[start] == "{" else { return nil }

        var depth = 0
        var inString = false
        var escaped = false

        for index in start..<chars.count {
            let char = chars[index]

            if inString {
                if escaped {
                    escaped = false
                    continue
                }
                if char == "\\" {
                    escaped = true
                    continue
                }
                if char == "\"" {
                    inString = false
                }
                continue
            }

            // 字符串之外
            if char == "\"" {
                inString = true
            } else if char == "{" {
                depth += 1
            } else if char == "}" {
                depth -= 1
                if depth == 0 { return index }
            }
        }
        return nil
    }

    /// 从 HTML 里提取 `var contents = {...};` 的 JSON 对象。
    ///
    /// 对应 Electron 版：`extractContentsJson`
    ///
    /// - Returns: 解析出的 JSON；找不到 / 解析失败返回 nil。
    ///
    /// ⚠️⚠️ **必须找 `var contents`，不能只找 `contents`**（本鱼实测踩到）。
    ///
    ///    真实页面（RJ331590）里 `contents` 这个词出现了 **7 次**：
    ///    · 前 6 次是 HTML class 名 `work_parts_multitype_item type_contents`
    ///    · 第 7 次才是真正的 `var contents = {...}`
    ///
    ///    本鱼第一版用 `html.range(of: "contents")` 找**第一个** ——
    ///    于是从一个无关位置往后找 `{`，扫到了别的东西 → **解析失败**。
    ///
    ///    症状很隐蔽：meta 兜底能成功（标题/社团/封面都对），
    ///    所以界面上「看起来能用」—— 但 `work_type` / `ageRating` 永远是空。
    ///
    ///    ⚠️ 而且 RJ294126 那个页面**只有 1 处 `contents`** ——
    ///       所以本鱼用那个页面做的测试**全部通过**，掩盖了这个 bug。
    ///       **两个真实样本才能暴露它。**
    public static func extractContentsJSON(_ html: String) -> JSONValue? {
        // 找 `var contents`（也接受 `let contents` / `contents =` 的变体）
        guard let varRange = html.range(of: "var contents") else { return nil }

        // 从 `var contents` 之后找第一个 `{`
        let after = html[varRange.upperBound...]
        guard let braceRel = after.firstIndex(of: "{") else { return nil }

        // 转成绝对下标（Array 索引）
        let braceAbs = html.distance(from: html.startIndex, to: braceRel)
        guard let endAbs = scanBalancedObject(html, from: braceAbs) else { return nil }

        // 切出 JSON 子串
        let jsonStart = html.index(html.startIndex, offsetBy: braceAbs)
        let jsonEnd = html.index(html.startIndex, offsetBy: endAbs + 1)
        let jsonText = String(html[jsonStart..<jsonEnd])

        guard let data = jsonText.data(using: .utf8),
              let value = try? JSONDecoder().decode(JSONValue.self, from: data) else {
            return nil
        }
        return value
    }

    // MARK: - meta 提取

    /// 从 `var contents = {...}` 里解析出一部作品。
    ///
    /// 对应 Electron 版：`parseDlsiteWork`
    ///
    /// ===== ⚠️ 真实页面结构（2026-11-06 实测 RJ294126）=====
    ///
    /// ```json
    /// {
    ///   "impression": [],
    ///   "detail": [{
    ///     "id": "RJ294126",
    ///     "name": "純愛おま○ご当番【アップデート版】",
    ///     "category": "maniax",
    ///     "brand": "RG51931",
    ///     "price": 750,
    ///     "regist_date": "2020/08/30",
    ///     "image_main": "//img.dlsite.jp/modpub/.../RJ294126_img_main.jpg",
    ///     "official_price": 1650,
    ///     "series_id": "SRI0000026279",
    ///     "series_name": "…",
    ///     "discount": 825,
    ///     "work_type": "SOU",
    ///     "lang_options": "JPN",
    ///     "price_with_tax": 1650
    ///   }],
    ///   "time": 0.000792...
    /// }
    /// ```
    ///
    /// ⚠️ **作品数据在 `detail[0]` 里，不是顶层**。
    ///    本鱼的 CLI 探针第一版就是把它当统计信息了 —— 真实数据才看得出来。
    ///
    /// ⚠️ `image_main` 是**协议相对 URL**（`//img.dlsite.jp/...`），
    ///    必须补 `https:`（`normalizeCoverUrl` 已经处理）。
    ///
    /// - Parameter rj: 从 URL 或路径得到的 RJ（**优先于页面里的 id**）
    public static func parseWork(
        from html: String, rj: String, fetchedAt: String
    ) -> DlsiteWork? {
        var work = DlsiteWork(rj: rj, fetchedAt: fetchedAt)

        // ① 先试 contents JSON（最可靠：结构化数据）
        if let json = extractContentsJSON(html),
           let detail = json.objectValue?["detail"]?.arrayValue,
           let first = detail.first?.objectValue {

            work.title = first["name"]?.stringValue
            work.workType = first["work_type"]?.stringValue

            if let brand = first["brand"]?.stringValue, !brand.isEmpty {
                work.circle = brand
            }
            if let image = first["image_main"]?.stringValue {
                work.coverUrl = normalizeCoverUrl(image)
            }
        }

        // ② 退化到 meta（JSON 解析失败时）
        //
        // ⚠️ **必须有这条兜底**：DLsite 改版会让 `var contents` 消失或换位置，
        //    而 meta 标签是**给搜索引擎看的**，改版时最可能保留。
        //
        // ⚠️ 而且**它还是社团名的唯一来源**：JSON 里的 `brand` 是 ID（RG 开头），
        //    名字只在 `og:title` 的 `[社团名]` 里。
        if let ogTitle = metaContent(html, property: "og:title") {
            let parsed = splitTitleAndCircle(ogTitle)
            // 标题：只有 JSON 没给才用（`name` 通常比 og:title 干净）
            if work.title == nil { work.title = parsed.title }
            // ⚠️ 社团：**只要 meta 有名字就覆盖**（哪怕 JSON 给了一个 RG 开头的 ID）
            if let circle = parsed.circle, !circle.isEmpty {
                work.circle = circle
            }
        }
        if work.coverUrl == nil {
            work.coverUrl = normalizeCoverUrl(metaContent(html, property: "og:image"))
        }
        if work.description == nil {
            work.description = cleanupDescription(
                metaContent(html, property: "og:description"))
        }

        if let json = extractContentsJSON(html),
           let cat = json.objectValue?["detail"]?.arrayValue?
            .first?.objectValue?["category"]?.stringValue {
            work.ageRating = (cat == "maniax" || cat == "pro")
                ? "r18" : "general"
        }

        // ④ **RJ 必须对得上**（防止抓到别的作品的页面）
        //
        // ⚠️ 这条很重要：如果页面里的 id 与请求的 rj 不同，
        //    说明 DLsite 重定向了（作品下架/改名）→ **返回 nil 而不是错的元数据**。
        if let json = extractContentsJSON(html),
           let pageId = json.objectValue?["detail"]?.arrayValue?
            .first?.objectValue?["id"]?.stringValue {
            guard normalizeRJ(pageId) == rj else {
                return nil
            }
        }

        // 至少要有一个字段才算抓到
        let hasContent = work.title != nil || work.coverUrl != nil
        return hasContent ? work : nil
    }

    /// RJ 规范化（内部用，等同于 `RJNumber.normalize`）。
    static func normalizeRJ(_ value: String) -> String? {
        RJNumber.normalize(value)
    }

    /// 从 `og:title` 拆出标题与社团名。
    ///
    /// 真实形态：`純愛おま○ご当番【アップデート版】 [青春×フェティシズム] | DLsite`
    /// →  title = `純愛おま○ご当番【アップデート版】`
    ///    circle = `青春×フェティシズム`
    ///
    /// ⚠️ **末尾的 ` [社团] | DLsite` 是固定格式**，用正则拆。
    ///    但**拆不动时不能丢内容**（有些作品标题里就带方括号）：
    ///    拆不出来就整个当 title，circle 留 nil。
    public static func splitTitleAndCircle(
        _ ogTitle: String
    ) -> (title: String?, circle: String?) {
        var value = ogTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        // 去掉站点后缀
        for suffix in [" | DLsite", "| DLsite"] {
            if let range = value.range(of: suffix, options: .backwards) {
                value = String(value[..<range.lowerBound])
                    .trimmingCharacters(in: .whitespaces)
            }
        }

        // 末尾的 ` [社团]`
        guard value.hasSuffix("]"),
              let openBracket = value.range(of: "[", options: .backwards) else {
            return (value.isEmpty ? nil : value, nil)
        }
        let title = String(value[..<openBracket.lowerBound])
            .trimmingCharacters(in: .whitespaces)
        let circle = String(value[openBracket.upperBound...])
            .replacingOccurrences(of: "]", with: "")
            .trimmingCharacters(in: .whitespaces)

        // ⚠️ 拆完标题为空 → 说明那个 `[...]` 是标题的一部分（不是社团）→ 不拆
        guard !title.isEmpty else { return (value, nil) }
        return (title, circle.isEmpty ? nil : circle)
    }

    /// 从 HTML 里提取 `<meta property="..." content="...">`。
    ///
    /// ⚠️ 属性顺序**不固定**（`property` 可能在 `content` 前面或后面），
    ///    所以要用"同一标签内"的匹配而不是假设顺序。
    public static func metaContent(_ html: String, property: String) -> String? {
        // 找所有 `<meta ...>`，筛出含目标 property 的那个，再取它的 content
        let pattern = "<meta[^>]*>"
        guard let regex = try? NSRegularExpression(
            pattern: pattern, options: [.caseInsensitive]) else { return nil }

        let ns = html as NSString
        let matches = regex.matches(in: html, range: NSRange(location: 0, length: ns.length))

        for match in matches {
            let tag = ns.substring(with: match.range)
            guard tag.contains(property) else { continue }
            // 从这个标签里取 content
            if let content = attribute(in: tag, name: "content") {
                return decodeEntities(content)
            }
        }
        return nil
    }

    static func attribute(in tag: String, name: String) -> String? {
        for quote in ["\"", "'"] {
            // 用 `NSRegularExpression.escapedPattern` 或者直接手写两条正则，
            // 别用字符串插值拼转义 —— 那正是上面那个 bug 的来源。
            let pattern: String
            if quote == "\"" {
                pattern = name + "=\"([^\"]*)\""
            } else {
                pattern = name + "='([^']*)'"
            }
            guard let regex = try? NSRegularExpression(
                pattern: pattern, options: [.caseInsensitive]) else { continue }
            let ns = tag as NSString
            if let match = regex.firstMatch(
                in: tag, range: NSRange(location: 0, length: ns.length)),
               match.numberOfRanges >= 2 {
                return ns.substring(with: match.range(at: 1))
            }
        }
        return nil
    }

    // MARK: - 封面 URL 规范化（D22）

    /// 封面 host 白名单（D22：**外部数据不可信**）。
    public static let allowedCoverHosts = [
        "img.dlsite.jp",
        "img.dlsite.jp:443",
    ]

    /// 规范化封面 URL。
    ///
    /// - Returns: 合法 URL；不是白名单 host / 不是 https / 为空 → nil。
    ///
    /// ⚠️ **必须校验 host**（D22）：封面 URL 来自**外部页面**，
    ///    而我们会用它去发请求。不校验就等于让 DLsite 的页面
    ///    决定我们去请求任意地址（SSRF 面）。
    public static func normalizeCoverUrl(_ raw: String?) -> String? {
        guard let raw else { return nil }
        var value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return nil }

        // 协议相对 URL（`//img.dlsite.jp/...`）→ 补 https
        if value.hasPrefix("//") {
            value = "https:" + value
        }
        // `http://` → 强制 https（混用内容会让 mac 端拒绝加载）
        if value.hasPrefix("http://") {
            value = "https://" + value.dropFirst("http://".count)
        }

        guard let url = URL(string: value),
              let host = url.host,
              allowedCoverHosts.contains(host),
              url.scheme == "https" else {
            return nil
        }
        return url.absoluteString
    }
}
