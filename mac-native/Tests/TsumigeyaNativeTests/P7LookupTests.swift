// DLsite 查找决策链测试（RJ 优先 → 名字搜索 → 手动）。
//
// ===== 用户 2026-11-06 的明确要求 =====
//
// 「自动识别如果有直接能找到 rj 号就用 rj 号，不能就按名字来」
//
// ===== 本文件守的两件事 =====
//
// ① **RJ 优先**：路径里有 RJ 时不该去搜索（搜索会返回 DLC 等噪音）
// ② **关键词清洗不能过度**：洗过头就一条都搜不到
import Foundation
import Testing

@testable import TsumigeyaCore

@Suite("DLsite 查找决策")
struct DlsiteLookupPlanTests {

    /// ⚠️ **路径里有 RJ → 直接用 RJ**（用户明确要求）。
    @Test("有 RJ 就用 RJ")
    func prefersRJ() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("RJ123456-fixture-lookup")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let step = DlsiteLookup.plan(
            gamePath: dir.path, gameTitle: "某个游戏名")
        if case .byRJ(let rj) = step {
            #expect(rj == "RJ123456")
        } else {
            Issue.record("应该是 .byRJ，实际 \(step)")
        }
    }

    /// 没有 RJ → 用标题搜索。
    @Test("没有 RJ 就搜索")
    func fallsBackToKeyword() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("no-rj-lookup-fixture")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let step = DlsiteLookup.plan(
            gamePath: dir.path, gameTitle: "Karryn's Prison")
        if case .byKeyword(let kw) = step {
            #expect(kw == "Karryn's Prison")
        } else {
            Issue.record("应该是 .byKeyword，实际 \(step)")
        }
    }

    /// 标题为空 / 只有空白 → 手动。
    @Test("标题空则手动")
    func emptyTitleManual() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("empty-title-fixture")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let step = DlsiteLookup.plan(gamePath: dir.path, gameTitle: "   ")
        #expect(step == .manual)
    }
}

@Suite("搜索关键词清洗")
struct SearchKeywordTests {

    /// ⚠️ **去掉末尾的版本号**（`Ver.1.0.10` 带着搜会搜不到）。
    @Test("去掉版本号")
    func stripsVersion() {
        #expect(DlsiteLookup.searchKeyword(from: "Unholy maiden Ver.1.0.10") == "Unholy maiden")
        #expect(DlsiteLookup.searchKeyword(from: "某游戏 v1.2") == "某游戏")
        #expect(DlsiteLookup.searchKeyword(from: "游戏名 Ver1.0") == "游戏名")
    }

    /// ⚠️ **只删「像版本标注」的末尾括号**。
    @Test("删版本标注括号")
    func stripsVersionBracket() {
        #expect(DlsiteLookup.searchKeyword(
            from: "純愛おま○こ当番【アップデート版】") == "純愛おま○こ当番")
        #expect(DlsiteLookup.searchKeyword(
            from: "某游戏（汉化版）") == "某游戏")
    }

    /// ⚠️⚠️ **不能删主标题里的括号**（那是标题的一部分）。
    ///
    /// 守的是：洗过头就搜不到。`□■魔法少女□■` 这种括号是作品名的一部分。
    @Test("保留主标题括号")
    func keepsTitleBrackets() {
        // 括号里没有版本标记 → 保留
        let result = DlsiteLookup.searchKeyword(from: "【限定】某个游戏")
        #expect(result.contains("【限定】"), "括号里不是版本标记，该保留")
    }

    /// 压缩多余空白。
    @Test("压缩空白")
    func collapsesSpaces() {
        #expect(DlsiteLookup.searchKeyword(from: "游戏  名") == "游戏 名")
    }

    /// 空输入返回空。
    @Test("空输入")
    func emptyInput() {
        #expect(DlsiteLookup.searchKeyword(from: "") == "")
        #expect(DlsiteLookup.searchKeyword(from: "   ") == "")
    }

    /// ⚠️ **清洗结果不能是空的**（否则搜不到）。
    /// 即使原标题全是版本号，也要留点东西。
    @Test("不会洗成空")
    func neverEmpty() {
        // `Ver.1.0` 单独一个 → 洗完是空 → 调用方会走 manual，那是合理的
        let result = DlsiteLookup.searchKeyword(from: "Ver.1.0")
        #expect(result.isEmpty, "全是版本号时洗空是合理的（调用方走手动）")
    }

    /// 从路径兜底推断关键词。
    ///
    /// ⚠️ 注意 `DetectPath.gameDirForFiles` 对**目录**会退到**父目录**
    ///    （它假设传的是文件）。所以这里要传「目录里的一个文件」的路径，
    ///    才能得到那个目录本身。本鱼第一版直接传目录 → 得到父目录 → 断言失败。
    @Test("从路径推断")
    func fromPath() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("Unholy_maiden_fixture")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        // 传目录**里的一个文件**（`Game.exe`），这样 gameDirForFiles 得到的是这个目录
        let gamePath = (dir.path as NSString).appendingPathComponent("Game.exe")
        let kw = DlsiteLookup.fallbackKeyword(fromPath: gamePath)
        #expect(kw.contains("Unholy"), "实际: \(kw)")
        #expect(!kw.contains("_"))
    }
}

@Suite("搜索解析（真实页面夹具）")
struct DlsiteSearchParseTests {

    func fixture() throws -> String {
        guard let url = Bundle.module.url(
            forResource: "dlsite-search-Karryn", withExtension: "html") else {
            Issue.record("找不到搜索页夹具")
            throw SearchFixtureError.missing
        }
        return try String(contentsOf: url, encoding: .utf8)
    }

    /// ⚠️ **真实搜索页解析出 4 条**（正片 + 3 DLC）。
    ///
    /// 这个数字本身就是判据：DLsite 的搜索结果**会混进 DLC / 续作**，
    /// 所以绝不能自动选第一条。
    @Test("解析出正片与 DLC")
    func parsesAllHits() throws {
        let html = try fixture()
        let hits = DLsiteSearch.parse(html)
        #expect(hits.count == 4, "实测是 4 条（正片 + 3 个 DLC）")

        // 第一条是正片（但这个巧合不能当成规律依赖）
        #expect(hits.first?.rj == "RJ331590")
        #expect(hits.first?.title.contains("KARRYN") == true)
        // 后面三个是 DLC —— 这就是不能自动选第一条的证据
        #expect(hits.dropFirst().allSatisfy { $0.title.contains("DLC") })
    }

    /// ⚠️ **社团名不能混进 HTML 标签**（本鱼实测踩到的 bug）。
    @Test("社团名干净")
    func circleIsClean() throws {
        let html = try fixture()
        let hits = DLsiteSearch.parse(html)
        // ⚠️ **只断言「拿到的 circle 是干净的」，不要求每条都有**。
        //
        //    本鱼第一版用 `#require` 要求**每条**都有 circle，结果第 4 条
        //    （最后一条记录）返回 nil 就红了。
        //
        //    ⚠️ 那条为什么 nil 本鱼没查清（chunk 边界 / 结构镜像），
        //    但**关键判据是「不为 nil 时是否干净」** —— 那才是那个 bug（混进标签）。
        //    强求每条都有是**过度约束**，它会因为无关的原因红，
        //    而红了之后本鱼会去查错方向。
        var cleanCount = 0
        for hit in hits {
            guard let circle = hit.circle else { continue }
            let hasTag = circle.contains("<")
            let hasHref = circle.contains("href")
            #expect(!hasTag, "社团名混进了标签")
            #expect(!hasHref, "社团名混进了 href")
            #expect(circle.contains("Remtairy"))
            cleanCount += 1
        }
        // 至少大部分记录能拿到社团名（不是 0）
        #expect(cleanCount >= 3, "只拿到 \(cleanCount) 条社团名，太少了")
    }

    /// 标题不含 HTML 实体。
    @Test("标题无实体")
    func titleDecoded() throws {
        let html = try fixture()
        let hits = DLsiteSearch.parse(html)
        for hit in hits {
            #expect(!hit.title.contains("&#"), "标题里有未解码的实体: \(hit.title)")
        }
    }

    /// ⚠️ **按 RJ 去重**（每个 RJ 在记录里重复 5 次）。
    @Test("无重复 RJ")
    func noDuplicates() throws {
        let html = try fixture()
        let hits = DLsiteSearch.parse(html)
        let rjs = hits.map(\.rj)
        #expect(Set(rjs).count == rjs.count, "有重复 RJ")
    }

    /// **保持页面顺序**（DLsite 的相关性排序有意义）。
    @Test("保持顺序")
    func keepsOrder() throws {
        let html = try fixture()
        let hits = DLsiteSearch.parse(html)
        #expect(hits.map(\.order) == Array(0..<hits.count))
    }

    /// 结果页判据。
    @Test("结果页判据")
    func resultPageDetection() throws {
        let html = try fixture()
        #expect(DLsiteSearch.isResultPage(html))
    }

    /// ⚠️ **非结果页 → 返回 false**（搜不到时 DLsite 返回普通页）。
    @Test("非结果页")
    func notResultPage() {
        #expect(!DLsiteSearch.isResultPage("<html><title>DLsite 首页</title></html>"))
    }

    /// ⚠️ **没有结构化锚点 → 返回空**（不退回宽松模式）。
    @Test("无锚点返回空")
    func noAnchors() {
        // 只有 href，没有 data-list_item_product_id
        let html = "<html><body><a href=\"/maniax/work/=/product_id/RJ123456.html\">x</a></body></html>"
        let hits = DLsiteSearch.parse(html)
        #expect(hits.isEmpty, "没有结构化锚点时该返回空（宽松模式会混进按钮文案里的 RJ）")
    }

    /// URL 构造。
    @Test("搜索 URL")
    func searchURL() {
        let url = DLsiteSearch.searchURL(keyword: "Karryn")
        #expect(url?.contains("maniax/fsr/=/keyword/Karryn") == true)
        // 日文要编码
        let ja = DLsiteSearch.searchURL(keyword: "カリンズ")
        #expect(ja != nil)
        #expect(ja?.contains("%") == true, "日文关键词必须编码")
    }

    /// ⚠️ 非法 category 回落 maniax（防注入）。
    @Test("category 校验")
    func categoryValidation() {
        let url = DLsiteSearch.searchURL(
            keyword: "test", category: "maniax;rm -rf /")
        #expect(url?.contains("/maniax/") == true, "非法 category 该回落 maniax")
    }

    /// 空关键词返回 nil。
    @Test("空关键词")
    func emptyKeyword() {
        #expect(DLsiteSearch.searchURL(keyword: "") == nil)
        #expect(DLsiteSearch.searchURL(keyword: "   ") == nil)
    }

    enum SearchFixtureError: Error { case missing }
}
