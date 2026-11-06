// 用**真实 DLsite 页面**做回归测试。
//
// ===== 为什么这个文件和 P7DlsiteTests 分开 =====
//
// `P7DlsiteTests` 用手写 HTML 验「判据本身对不对」；
// 本文件用**从真实页面精简出来的结构**验「我们理解的结构对不对」。
//
// ⚠️ 两者缺一不可。本鱼已经因此踩到两个真 bug（手写 HTML 永远发现不了）：
//   1. `attribute()` 的字符串插值多了一层反斜杠 → meta 永远读不到
//   2. `detail[0]`（作品数据）被误当成统计信息
//
// 夹具来源：RJ294126 的真实页面（2026-11-06 抓取），
// 保留 `<meta og:*>` 全部 6 个 + `var contents` 的 JSON 原文。
import Foundation
import Testing

@testable import TsumigeyaCore

@Suite("真实 DLsite 页面")
struct DlsiteRealPageTests {

    /// 读夹具。
    ///
    /// ⚠️ **不能用 `try?` 静默吞掉失败**：读不到就 `Issue.record`，
    ///    否则测试会「通过」但**其实一个断言都没跑**。
    func fixture() throws -> String {
        // Bundle.module 由 SwiftPM 生成（Package.swift 里声明了 resources）
        guard let url = Bundle.module.url(
            forResource: "dlsite-RJ294126", withExtension: "html") else {
            Issue.record("找不到夹具 dlsite-RJ294126.html（Package.swift 里的 resources 声明有问题？）")
            throw FixtureError.missing
        }
        return try String(contentsOf: url, encoding: .utf8)
    }

    enum FixtureError: Error { case missing }

    /// 真实页面能解析出作品数据（`var contents` 的 `detail[0]`）。
    @Test("解析出作品数据")
    func parsesContentsJSON() throws {
        let html = try fixture()
        let json = try #require(DLsiteParser.extractContentsJSON(html),
                                "var contents 解析失败")
        let obj = try #require(json.objectValue)
        // ⚠️ 真实页面的三个顶层键：detail / impression / time
        #expect(obj["detail"] != nil)
        let detail = try #require(obj["detail"]?.arrayValue)
        #expect(detail.count == 1)
        let work = try #require(detail.first?.objectValue)
        #expect(work["id"]?.stringValue == "RJ294126")
    }

    /// ⚠️⚠️ **社团名必须是名字，不是 ID**。
    ///
    /// 真实页面 JSON 里 `brand` 是 `RG51931`（ID），而名字在 `og:title` 的
    /// `[青春×フェティシズム]` 里。
    ///
    /// 本鱼第一版直接把 brand 当 circle → 界面显示「RG51931」。
    /// **真实数据一跑就暴露了。**
    @Test("社团名不是 ID")
    func circleIsNameNotID() throws {
        let html = try fixture()
        let work = try #require(DLsiteParser.parseWork(
            from: html, rj: "RJ294126", fetchedAt: "t"))
        let circle = try #require(work.circle)
        #expect(!circle.hasPrefix("RG"), "社团名不该是 RG 开头的 ID")
        #expect(circle == "青春×フェティシズム")
    }

    /// meta 能读到（本鱼的 `attribute()` 正则 bug 由这条守）。
    @Test("meta 可读")
    func metaReadable() throws {
        let html = try fixture()
        let ogTitle = try #require(
            DLsiteParser.metaContent(html, property: "og:title"),
            "og:title 读不到 —— attribute() 的正则可能又写错了")
        #expect(ogTitle.contains("RJ") || ogTitle.contains("DLsite"))

        let ogImage = try #require(DLsiteParser.metaContent(html, property: "og:image"))
        #expect(ogImage.contains("img.dlsite.jp"))
    }

    /// og:title 拆分正确。
    @Test("标题拆分")
    func splitsTitle() throws {
        let html = try fixture()
        let og = try #require(DLsiteParser.metaContent(html, property: "og:title"))
        let parts = DLsiteParser.splitTitleAndCircle(og)
        let title = try #require(parts.title)
        let circle = try #require(parts.circle)
        #expect(!title.contains("| DLsite"), "标题不该含站点后缀")
        #expect(title == "純愛おま○こ当番【アップデート版】")
        #expect(circle == "青春×フェティシズム")
    }

    /// 完整解析的每个字段都对。
    @Test("完整字段")
    func fullParse() throws {
        let html = try fixture()
        let work = try #require(DLsiteParser.parseWork(
            from: html, rj: "RJ294126", fetchedAt: "t"))

        #expect(work.rj == "RJ294126")
        #expect(work.title == "純愛おま○こ当番【アップデート版】")
        #expect(work.circle == "青春×フェティシズム")
        #expect(work.workType == "SOU")
        #expect(work.ageRating == "r18")

        // 封面：真实页面里是协议相对的 `//img.dlsite.jp/...`
        let cover = try #require(work.coverUrl)
        #expect(cover.hasPrefix("https://"), "封面必须是 https 绝对 URL")
        #expect(cover.contains("img.dlsite.jp"))
        #expect(cover.contains("RJ294126"))

        // 简介：站点尾巴必须剥掉
        let desc = try #require(work.description)
        #expect(!desc.contains("DLsite 同人"))
        #expect(!desc.contains("国内最大級"))
        #expect(desc.count > 20)
    }

    /// ⚠️ **RJ 不匹配时返回 nil**（防止抓到别的作品的元数据）。
    @Test("RJ 不匹配返回 nil")
    func rejectsWrongRJ() throws {
        let html = try fixture()
        // 请求一个不同的 RJ
        let work = DLsiteParser.parseWork(
            from: html, rj: "RJ999999", fetchedAt: "t")
        #expect(work == nil, "页面里的 id 是 RJ294126，请求 RJ999999 必须拒绝")
    }

    /// 页面里提取到的 RJ 候选（真实页面里有 RJ294126 与 RJ295000）。
    @Test("页面里的 RJ 候选")
    func rjCandidates() throws {
        let html = try fixture()
        let cands = RJNumber.candidates(in: html)
        #expect(cands.contains("RJ294126"), "页面里该有 RJ294126")
    }
}
