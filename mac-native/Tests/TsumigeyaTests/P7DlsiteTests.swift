// DLsite 解析判据测试。
//
// 对应 Electron 版：`test/dlsite*.test.ts`
//
// ===== 本文件最重要的一条：括号配对扫描 =====
//
// 网上流传的抓法是用正则 `/(\{[\s\S]*?\});/`。**那个正则是错的**：
// 非贪婪 `*?` 遇到**作品简介里出现的 `};`** 会提前截断。
//
// 而那种失败**不会报错** —— 它只是「抓不到东西」，
// 用户会以为 DLsite 上没这部作品，而真正的原因是解析器断在了简介里的一个 `};`。
//
// 所以本文件用了**带 `};` 干扰的测试数据**来钉住这一点。
import Foundation
import Testing

@testable import TsumigeyaCore

// MARK: - RJ 号

@Suite("RJ 号规范化")
struct RJNormalizeTests {

    @Test("标准形态")
    func standard() {
        #expect(RJNumber.normalize("RJ294126") == "RJ294126")
        #expect(RJNumber.normalize("rj294126") == "RJ294126")
        #expect(RJNumber.normalize("294126") == "RJ294126")
    }

    @Test("带分隔符")
    func withSeparators() {
        #expect(RJNumber.normalize("RJ-294126") == "RJ294126")
        #expect(RJNumber.normalize("RJ_294126") == "RJ294126")
        #expect(RJNumber.normalize("RJ 294126") == "RJ294126")
    }

    @Test("位数范围")
    func digitRange() {
        // 6~8 位都接受
        #expect(RJNumber.normalize("RJ123456") == "RJ123456")
        #expect(RJNumber.normalize("RJ12345678") == "RJ12345678")
        // 5 位太短、9 位太长
        #expect(RJNumber.normalize("RJ12345") == nil)
        #expect(RJNumber.normalize("RJ123456789") == nil)
    }

    @Test("非法输入")
    func invalid() {
        #expect(RJNumber.normalize("") == nil)
        #expect(RJNumber.normalize(nil) == nil)
        #expect(RJNumber.normalize("abc") == nil)
        #expect(RJNumber.normalize("RJabc") == nil)
    }
}

@Suite("RJ 候选提取")
struct RJCandidateTests {

    @Test("基本提取")
    func basic() {
        #expect(RJNumber.candidates(in: "游戏名 RJ294126 作品") == ["RJ294126"])
    }

    /// ⚠️ **紧贴中文也要认**（不加词边界的原因）。
    @Test("紧贴中文")
    func adjacentToChinese() {
        #expect(RJNumber.candidates(in: "RJ294126作品") == ["RJ294126"])
        #expect(RJNumber.candidates(in: "_RJ294126_") == ["RJ294126"])
    }

    /// ⚠️⚠️ **尾部负向断言 `(?!\d)`**：9 位数字不能被截成 8 位。
    ///
    /// 少了这条，`RJ12345678` 后面还有个数字时会得到错的 RJ。
    @Test("不截断长数字")
    func doesNotTruncate() throws {
        // `RJ1234567890` 是 10 位 → 6~8 位都匹配不上 → 空
        let result = RJNumber.candidates(in: "RJ1234567890")
        #expect(result.isEmpty, "10 位数字不该被截成 8 位")
    }

    @Test("去重保序")
    func dedupe() {
        let result = RJNumber.candidates(in: "RJ111111 然后 RJ222222 再 RJ111111")
        #expect(result == ["RJ111111", "RJ222222"])
    }

    @Test("多个候选")
    func multiple() {
        let result = RJNumber.candidates(in: "RJ111111 与 RJ222222")
        #expect(result.count == 2)
    }
}

@Suite("从路径检测 RJ")
struct DetectRJFromPathTests {

    /// ⚠️ **目录名优先级最高**（用户多半把游戏解到 `RJ294126 作品名/`）。
    @Test("目录名优先")
    func dirNameFirst() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("RJ111111 游戏名-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let result = RJNumber.detectFromPath(gamePath: dir.path)
        #expect(result.first == "RJ111111", "目录名里的 RJ 应该排最前")
    }

    /// ⚠️ **按优先级排序**（多个不同 RJ 时让用户选，不瞎猜）。
    @Test("多候选按优先级")
    func orderedCandidates() throws {
        let outer = FileManager.default.temporaryDirectory
            .appendingPathComponent("RJ999999-outer-\(UUID().uuidString)")
        let inner = outer.appendingPathComponent("RJ111111")
        try FileManager.default.createDirectory(at: inner, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: outer) }

        let result = RJNumber.detectFromPath(gamePath: inner.path)
        #expect(result.first == "RJ111111", "最深层目录名优先")
        #expect(result.contains("RJ999999"), "上层目录的 RJ 也要在候选里")
    }

    /// 路径不存在也不该崩（用户可能先填了未安装的目录）。
    @Test("路径不存在")
    func nonexistentPath() {
        let result = RJNumber.detectFromPath(
            gamePath: "/nonexistent/RJ123456/Game.exe")
        #expect(result == ["RJ123456"])
    }

    /// 从 readme 里提取（目录名没有 RJ 时）。
    @Test("从 readme 提取")
    func fromReadme() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("plain-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        try "这是作品说明\nRJ555555\n更多内容".write(
            to: dir.appendingPathComponent("readme.txt"),
            atomically: true, encoding: .utf8)

        let result = RJNumber.detectFromPath(gamePath: dir.path)
        #expect(result == ["RJ555555"])
    }

    /// 没有 RJ 时返回空数组（不瞎猜）。
    ///
    /// ⚠️ **路径必须固定，不能用 `UUID()`**（本鱼实测踩到间歇性失败）。
    ///
    ///    `detectFromPath` 会扫**完整路径的各段**（那是刻意的：
    ///    用户把游戏放在 `/Users/xxx/RJ294126/` 下时就靠这个）。
    ///    而 `UUID` 的随机十六进制段里，**极小概率**出现 `RJ` + 6~8 位数字的组合，
    ///    于是这条测试会**间歇性失败**。
    ///
    ///    ⚠️ 间歇性失败比稳定失败更糟：本鱼会以为是别的原因，
    ///       重跑一次又过了，然后当作没事。
    @Test("没有 RJ")
    func noRJ() throws {
        // 固定的、确定不含 RJ 的路径
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-no-rj-fixture")
        try? FileManager.default.removeItem(at: dir)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        #expect(RJNumber.detectFromPath(gamePath: dir.path) == [])
    }
}

// MARK: - 简介清洗

@Suite("简介清洗")
struct DescriptionCleanupTests {

    /// ⚠️ **站点尾巴必须剥掉**。
    ///
    /// 不清洗的话，每张卡片上都会贴「国内最大級の二次元総合ダウンロードショップ」。
    @Test("剥掉站点尾巴")
    func stripsSiteTail() throws {
        let raw = "这是一部作品简介。\n\n「DLsite 同人 - R18」は同人誌・同人ゲームを中心とした"
        let cleaned = try #require(DLsiteParser.cleanupDescription(raw))
        #expect(cleaned == "这是一部作品简介。")
        #expect(!cleaned.contains("DLsite"))
    }

    /// 空 / 全空白 → nil（UI 显示「暂无」）。
    @Test("空值返回 nil")
    func emptyReturnsNil() {
        #expect(DLsiteParser.cleanupDescription(nil) == nil)
        #expect(DLsiteParser.cleanupDescription("") == nil)
        #expect(DLsiteParser.cleanupDescription("   \n  ") == nil)
    }

    /// 没有尾巴标记的原样返回。
    @Test("无尾巴原样")
    func noTail() {
        #expect(DLsiteParser.cleanupDescription("干净的简介") == "干净的简介")
    }
}

// MARK: - HTML 实体

@Suite("HTML 实体解码")
struct HTMLEntityTests {

    @Test("命名实体")
    func named() {
        #expect(DLsiteParser.decodeEntities("a &amp; b") == "a & b")
        #expect(DLsiteParser.decodeEntities("&lt;tag&gt;") == "<tag>")
        #expect(DLsiteParser.decodeEntities("&quot;引号&quot;") == "\"引号\"")
    }

    @Test("数字实体")
    func numeric() {
        #expect(DLsiteParser.decodeEntities("&#65;") == "A")
        #expect(DLsiteParser.decodeEntities("&#x41;") == "A")
    }

    /// 不认识的实体原样保留（不破坏内容）。
    @Test("不认识的原样")
    func unknown() {
        #expect(DLsiteParser.decodeEntities("&unknownentity;") == "&unknownentity;")
        // 单独的 & 也原样
        #expect(DLsiteParser.decodeEntities("a & b") == "a & b")
    }
}

// MARK: - 括号配对扫描（**本文件的核心**）

@Suite("JSON 括号配对扫描")
struct BalancedScanTests {

    /// 第一个 `{` 在 Array 索引上的位置。
    func braceIndex(_ text: String) throws -> Int {
        let chars = Array(text)
        guard let idx = chars.firstIndex(of: "{") else {
            Issue.record("没有左花括号")
            throw ScanError.noBrace
        }
        return idx
    }

    enum ScanError: Error { case noBrace }

    @Test("简单对象")
    func simple() throws {
        let text = "var contents = {\"a\":1};"
        let start = try braceIndex(text)
        let end = try #require(DLsiteParser.scanBalancedObject(text, from: start))
        let chars = Array(text)
        #expect(chars[end] == "}")
        #expect(end == text.count - 2)   // `}` 在 `;` 之前
    }

    /// ⚠️⚠️ **本文件最重要的一条**：简介里出现 `};` 不能骗过扫描。
    ///
    /// 正则 `(\{[\s\S]*?\})` 会在这里**提前截断**，得到一个残缺 JSON
    /// → 解析失败 → **整部作品的元数据全空**，而用户会以为 DLsite 没这部作品。
    @Test("简介里的 }; 不会提前截断")
    func survivesBracesInString() throws {
        let text = """
        var contents = {"description":"这里有个 }; 在字符串里","title":"正常标题"};
        """
        let start = try braceIndex(text)
        let end = try #require(DLsiteParser.scanBalancedObject(text, from: start))
        let chars = Array(text)
        #expect(chars[end] == "}", "必须扫到真正的结尾，不能被字符串里的 }; 骗到")

        // 而且能解析出正确内容
        let json = try #require(DLsiteParser.extractContentsJSON(text))
        let obj = try #require(json.objectValue)
        #expect(obj["title"]?.stringValue == "正常标题")
        #expect(obj["description"]?.stringValue?.contains("};") == true)
    }

    /// 转义的引号不能打乱状态机。
    @Test("转义引号")
    func escapedQuotes() throws {
        let text = #"""
        var contents = {"note":"他说\"你好\"然后结束","x":1};
        """#
        let start = try braceIndex(text)
        let end = try #require(DLsiteParser.scanBalancedObject(text, from: start))
        let chars = Array(text)
        #expect(chars[end] == "}")

        let json = try #require(DLsiteParser.extractContentsJSON(text))
        let obj = try #require(json.objectValue)
        #expect(obj["x"]?.intValue == 1)
    }

    /// 嵌套对象。
    @Test("嵌套对象")
    func nested() throws {
        let text = #"var contents = {"a":{"b":{"c":1}},"d":2};"#
        let start = try braceIndex(text)
        let end = try #require(DLsiteParser.scanBalancedObject(text, from: start))
        let chars = Array(text)
        #expect(chars[end] == "}")

        let json = try #require(DLsiteParser.extractContentsJSON(text))
        let obj = try #require(json.objectValue)
        #expect(obj["d"]?.intValue == 2)
    }

    /// 找不到对象时返回 nil（不崩）。
    @Test("无对象")
    func noObject() {
        #expect(DLsiteParser.scanBalancedObject("没有括号", from: 0) == nil)
        #expect(DLsiteParser.extractContentsJSON("<html>没有 contents</html>") == nil)
    }
}

// MARK: - 封面 URL

@Suite("封面 URL 校验")
struct CoverUrlTests {

    /// ⚠️ **host 白名单**（D22）：封面 URL 来自外部页面，
    /// 不校验就等于让它决定我们去请求任意地址。
    @Test("只允许 dlsite 图床")
    func whitelist() {
        #expect(DLsiteParser.normalizeCoverUrl(
            "https://img.dlsite.jp/modpub/images2/work/doujin/RJ294126/RJ294126_img_main.jpg")
            != nil)
    }

    @Test("拒绝其他 host")
    func rejectsOtherHosts() {
        #expect(DLsiteParser.normalizeCoverUrl("https://evil.com/a.jpg") == nil)
        #expect(DLsiteParser.normalizeCoverUrl("https://img.dlsite.jp.evil.com/a.jpg") == nil)
    }

    /// 协议相对 URL 补 https。
    @Test("协议相对")
    func protocolRelative() {
        let result = DLsiteParser.normalizeCoverUrl("//img.dlsite.jp/a.jpg")
        #expect(result?.hasPrefix("https://") == true)
    }

    /// http 强制升 https。
    @Test("http 升 https")
    func upgradesHTTP() {
        let result = DLsiteParser.normalizeCoverUrl("http://img.dlsite.jp/a.jpg")
        #expect(result?.hasPrefix("https://") == true)
    }

    @Test("空值")
    func empty() {
        #expect(DLsiteParser.normalizeCoverUrl(nil) == nil)
        #expect(DLsiteParser.normalizeCoverUrl("") == nil)
        #expect(DLsiteParser.normalizeCoverUrl("   ") == nil)
    }
}

// MARK: - 元数据合并（D26）

@Suite("元数据合并")
struct MergeWorkTests {

    func work(title: String?, circle: String? = nil) -> DlsiteWork {
        DlsiteWork(rj: "RJ294126", title: title, circle: circle, fetchedAt: "t")
    }

    /// ⚠️ **用户改过的字段刷新时不覆盖**（D26：用户手改的值属于用户）。
    @Test("被编辑的字段保留")
    func keepsEditedFields() {
        let old = work(title: "用户改的标题")
        let incoming = work(title: "DLsite 原标题")
        let merged = EditedFields.merge(old: old, incoming: incoming, edited: ["title"])
        #expect(merged.title == "用户改的标题")
    }

    /// 没被编辑的字段用新抓的。
    @Test("未编辑的字段更新")
    func updatesUneditedFields() {
        let old = work(title: "旧", circle: "旧社团")
        let incoming = work(title: "新标题", circle: "新社团")
        let merged = EditedFields.merge(old: old, incoming: incoming, edited: ["title"])
        #expect(merged.title == "旧", "改过的保留")
        #expect(merged.circle == "新社团", "没改的更新")
    }

    /// ⚠️ **RJ 永远以 incoming 为准**（不可编辑，是作品的唯一标识）。
    @Test("RJ 不可编辑")
    func rjNotEditable() {
        #expect(!EditedFields.editable.contains("rj"),
                "rj 不该在可编辑列表里（D25：改 RJ 等于换作品）")
    }

    /// 没有旧数据时直接用新的。
    @Test("无旧数据")
    func noOld() {
        let incoming = work(title: "新")
        let merged = EditedFields.merge(old: nil, incoming: incoming, edited: ["title"])
        #expect(merged.title == "新")
    }
}
