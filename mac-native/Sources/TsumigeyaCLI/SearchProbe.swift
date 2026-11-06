// CLI：用**真实搜索页**验证解析器。
import Foundation
import TsumigeyaCore

func runSearchProbe(htmlPath: String) -> Int {
    guard let html = try? String(contentsOfFile: htmlPath, encoding: .utf8) else {
        print("❌ 读不到 \(htmlPath)")
        return 1
    }
    print("页面大小: \(html.count) 字符\n")

    // ① 结果页判据
    print("=== ① 是搜索结果页吗 ===")
    let title = DLsiteSearch.extractTitle(html) ?? "(无)"
    print("   title = \(title.prefix(70))")
    print(DLsiteSearch.isResultPage(html) ? "   ✅ 是结果页" : "   ❌ 不是结果页")

    // ② 锚点
    print("")
    print("=== ② 结构化锚点 ===")
    let anchors = DLsiteSearch.anchorPositions(in: html)
    print("   找到 \(anchors.count) 个锚点")
    for a in anchors.prefix(5) {
        print("     \(RJNumber.normalize(a.rj) ?? a.rj)")
    }

    // ③ 解析结果
    print("")
    print("=== ③ 解析结果 ===")
    let hits = DLsiteSearch.parse(html)
    print("   \(hits.count) 条")
    for hit in hits {
        print("")
        print("   \(hit.rj)  [order \(hit.order)]")
        print("     title  = \(hit.title)")
        print("     circle = \(hit.circle ?? "(无)")")
        print("     cover  = \((hit.coverUrl ?? "(无)").prefix(70))")
        if hit.title.contains("&#") { print("     ⚠️ 标题里还有 HTML 实体！") }
    }

    // ④ 自检
    print("")
    print("=== ④ 自检 ===")
    print(hits.isEmpty ? "❌ 没解析出任何结果" : "✅ 解析出 \(hits.count) 条")
    let dupes = hits.count != Set(hits.map(\.rj)).count
    print(dupes ? "❌ 有重复 RJ" : "✅ 无重复 RJ")
    let badTitles = hits.filter { $0.title.contains("&#") || $0.title.isEmpty }
    print(badTitles.isEmpty ? "✅ 标题都干净" : "❌ \(badTitles.count) 条标题有问题")
    let badCovers = hits.filter { $0.coverUrl != nil && !$0.coverUrl!.hasPrefix("https://") }
    print(badCovers.isEmpty ? "✅ 封面都是 https 绝对 URL" : "❌ \(badCovers.count) 条封面不对")

    return 0
}
