// CLI：用**真实 DLsite 页面**验证解析器。
//
// ⚠️ 为什么需要这个：手写 HTML 只能证明「本鱼的理解是对的」，
//    不能证明「真实页面长这样」。本鱼已经因此踩到两个真 bug：
//     ① `attribute()` 的字符串插值多了一层反斜杠 → meta 永远读不到
//     ② 把 `detail[0]`（作品数据）误当成统计信息
//    两个都是**真数据一跑就暴露、手写单测永远发现不了**。
import Foundation
import TsumigeyaCore

func runDlsiteProbe(htmlPath: String) -> Int {
    guard let html = try? String(contentsOfFile: htmlPath, encoding: .utf8) else {
        print("❌ 读不到 \(htmlPath)")
        return 1
    }
    print("页面大小: \(html.count) 字符\n")

    // ① contents JSON
    print("=== ① var contents ===")
    if let json = DLsiteParser.extractContentsJSON(html) {
        let obj = json.objectValue ?? [:]
        print("✅ 顶层键: \(obj.keys.sorted())")
        if let detail = obj["detail"]?.arrayValue {
            print("   detail 有 \(detail.count) 条")
            if let first = detail.first?.objectValue {
                print("   作品字段: \(first.keys.sorted())")
            }
        }
    } else {
        print("❌ 解析失败")
    }
    print("")

    // ② meta
    print("=== ② meta ===")
    for prop in ["og:title", "og:image", "og:description"] {
        let value = DLsiteParser.metaContent(html, property: prop)
        let shown = value.map { String($0.prefix(60)) } ?? "(无)"
        print("   \(prop) = \(shown)")
    }
    print("")

    // ③ 完整解析
    print("=== ③ parseWork ===")
    let rj = RJNumber.candidates(in: html).first ?? "RJ000000"
    if let work = DLsiteParser.parseWork(
        from: html, rj: rj, fetchedAt: "2026-11-06T00:00:00Z") {
        print("✅ 解析成功")
        print("   rj          = \(work.rj)")
        print("   title       = \(work.title ?? "(无)")")
        print("   circle      = \(work.circle ?? "(无)")")
        print("   coverUrl    = \(work.coverUrl ?? "(无)")")
        print("   workType    = \(work.workType ?? "(无)")")
        print("   ageRating   = \(work.ageRating ?? "(无)")")
        let desc = work.description ?? "(无)"
        print("   description = \(desc.prefix(80))\(desc.count > 80 ? "..." : "")")

        // 自检
        print("")
        print("=== ④ 自检 ===")
        print(work.coverUrl?.hasPrefix("https://") == true
              ? "✅ 封面是 https 绝对 URL" : "❌ 封面 URL 不对")
        print(work.coverUrl?.contains("img.dlsite.jp") == true
              ? "✅ 封面在 dlsite 图床" : "❌ 封面 host 不对")
        print(work.title?.contains("DLsite") == false
              ? "✅ 标题不含站点后缀" : "❌ 标题还有站点后缀")
    } else {
        print("❌ 解析失败（可能是页面结构与预期不符）")
        return 1
    }

    // ⑤ 标题拆分
    print("")
    print("=== ⑤ og:title 拆分 ===")
    if let og = DLsiteParser.metaContent(html, property: "og:title") {
        let parts = DLsiteParser.splitTitleAndCircle(og)
        print("   原始: \(og)")
        print("   标题: \(parts.title ?? "(无)")")
        print("   社团: \(parts.circle ?? "(无)")")
    }
    return 0
}
