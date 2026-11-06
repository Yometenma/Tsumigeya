// CLI：诊断 RJ 提取（排查「没有 RJ 的路径却提取到 RJ」）。
import Foundation
import TsumigeyaCore

func runRjProbe(paths: [String]) -> Int {
    for path in paths {
        let cands = RJNumber.detectFromPath(gamePath: path)
        print("路径: \(path)")
        print("  候选: \(cands)")
        // 逐段看是哪一段贡献的
        for segment in path.components(separatedBy: "/") where !segment.isEmpty {
            let segCands = RJNumber.candidates(in: segment)
            if !segCands.isEmpty {
                print("  ← 来自段「\(segment)」: \(segCands)")
            }
        }
        print("")
    }
    return 0
}
