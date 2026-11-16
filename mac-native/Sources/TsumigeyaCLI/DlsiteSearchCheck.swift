import Foundation
import TsumigeyaCore

func runDlsiteSearch(keyword: String, category: String?) async -> Int {
    let service = DLsiteService(dataDir: DataDir.resolve().path)
    switch await service.searchAll(keyword: keyword, category: category) {
    case .success(let hits):
        print("找到 \(hits.count) 个候选；不自动关联。")
        for hit in hits {
            print("\(hit.rj) [\(hit.category)] \(hit.title) / \(hit.circle ?? "未知社团")")
        }
        return 0
    case .failure(let error):
        print("查找失败：\(error.message)")
        return 1
    }
}
