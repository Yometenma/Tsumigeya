// CLI：诊断元数据保存（排查序列化失败）。
import Foundation
import TsumigeyaCore

func runMetaProbe(dataDir: String) -> Int {
    try? FileManager.default.createDirectory(atPath: dataDir, withIntermediateDirectories: true)

    let meta = GameDlsiteMeta(
        work: DlsiteWork(
            rj: "RJ294126", title: "测试", circle: "社团",
            coverUrl: "https://img.dlsite.jp/a.jpg",
            workType: "SOU", ageRating: "r18",
            description: "简介", fetchedAt: "2026-11-06T00:00:00Z"),
        editedFields: [])

    print("=== ① 单独 encode 测试 ===")
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted]
    do {
        let data = try encoder.encode(meta)
        print("✅ encode 成功，\(data.count) 字节")
        print(String(data: data, encoding: .utf8) ?? "?")
    } catch {
        print("❌ encode 失败: \(error)")
        return 1
    }

    print("")
    print("=== ② decode 回 JSONValue ===")
    do {
        let back = try JSONDecoder().decode(JSONValue.self, from: try encoder.encode(meta))
        print("✅ 成功: \(back)")
    } catch {
        print("❌ 失败: \(error)")
    }

    print("")
    print("=== ③ save ===")
    if let err = GameMetaStore.save(dataDir: dataDir, gameId: "1", meta: meta) {
        print("❌ save 失败: \(err)")
        return 1
    }
    print("✅ save 成功")

    let path = (dataDir as NSString).appendingPathComponent("library-meta.json")
    print("文件: \(path)")
    if let content = try? String(contentsOfFile: path, encoding: .utf8) {
        print(content)
    } else {
        print("❌ 文件不存在或读不出")
    }

    print("")
    print("=== ④ load ===")
    if let loaded = GameMetaStore.load(dataDir: dataDir, gameId: "1") {
        print("✅ load 成功: rj=\(loaded.work.rj) title=\(loaded.work.title ?? "nil")")
    } else {
        print("❌ load 返回 nil")
    }
    return 0
}
