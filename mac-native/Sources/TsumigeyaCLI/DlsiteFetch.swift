// CLI：**真实抓取** DLsite 元数据（端到端验证限速 + 缓存）。
//
// ⚠️ 与 `dlsite-probe` 的区别：
//   · `dlsite-probe` 用**本地 HTML 文件**验解析器（不联网）
//   · 本命令**真的发网络请求**，验限速与缓存是否生效
//
// 这是唯一能证明「限速真的在起作用」的方式 ——
// 单测用冻结时钟能证明逻辑，但证明不了真实时间下的行为。
import Foundation
import TsumigeyaCore

func runDlsiteFetch(rj: String, category: String) async -> Int {
    let dataDir = DataDir.resolve().path
    print("数据目录: \(dataDir)")
    print("抓取 \(rj)（分类 \(category)）")
    print("")

    let service = DLsiteService(dataDir: dataDir, minIntervalMs: 800)

    // ① 第一次（真实网络）
    let start1 = Date()
    let first = await service.fetchWork(rj: rj, category: category, refresh: true)
    let elapsed1 = Date().timeIntervalSince(start1)

    switch first {
    case .success(let work):
        print("✅ 第一次抓取成功（\(String(format: "%.2f", elapsed1))s）")
        print("   rj        = \(work.rj)")
        print("   title     = \(work.title ?? "(无)")")
        print("   circle    = \(work.circle ?? "(无)")")
        print("   coverUrl  = \(work.coverUrl ?? "(无)")")
        print("   workType  = \(work.workType ?? "(无)")")
        print("   ageRating = \(work.ageRating ?? "(无)")")
        let desc = work.description ?? "(无)"
        print("   desc      = \(desc.prefix(60))...")
    case .failure(let error):
        print("❌ 第一次失败: \(error.message)")
        return 1
    }

    // ② 立刻再来一次 → 应该被限速挡住
    print("")
    print("=== 立刻再请求（应该被限速）===")
    let start2 = Date()
    let second = await service.fetchWork(rj: rj, category: category, refresh: true)
    let elapsed2 = Date().timeIntervalSince(start2)
    switch second {
    case .success:
        print("⚠️ 第二次成功了（限速没生效？）")
    case .failure(.rateLimited(let ms)):
        let fast = elapsed2 < 0.2
        print("✅ 被限速挡住，还要等 \(ms)ms\(fast ? "，且立即返回（不阻塞）" : "")")
    case .failure(let error):
        print("❌ 意外的失败: \(error.message)")
    }

    // ③ 等过限速后再请求一次 → 走缓存
    print("")
    print("=== 等 1 秒后再请求（应该走缓存）===")
    try? await Task.sleep(nanoseconds: 1_000_000_000)
    let start3 = Date()
    let third = await service.fetchWork(rj: rj, category: category)
    let elapsed3 = Date().timeIntervalSince(start3)
    switch third {
    case .success:
        let fast = elapsed3 < 0.1
        print("✅ 拿到结果（\(String(format: "%.3f", elapsed3))s）"
              + (fast ? " —— 走缓存（没有网络延迟）" : " ⚠️ 可能是重新抓的"))
    case .failure(let error):
        print("❌ 失败: \(error.message)")
        return 1
    }

    // ④ 缓存文件
    print("")
    print("=== 缓存文件 ===")
    let cachePath = service.cachePath(rj: RJNumber.normalize(rj) ?? rj)
    print("   \(cachePath)")
    if let size = try? FileManager.default.attributesOfItem(atPath: cachePath)[.size] {
        print("   大小 \(size) 字节")
        print("   ✅ 缓存已落盘")
    } else {
        print("   ❌ 缓存文件不存在")
    }

    return 0
}
