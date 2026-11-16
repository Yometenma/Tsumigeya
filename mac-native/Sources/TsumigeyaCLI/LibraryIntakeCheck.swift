import Foundation
import TsumigeyaCore

/// 真实文件扫描，不写游戏库；入库仍需在界面逐项确认。
func runLibraryScan(path: String) -> Int {
    do {
        let scan = try LibraryIntake.scan(root: path)
        print("已检查 \(scan.visited) 个目录，候选 \(scan.candidates.count) 个")
        for candidate in scan.candidates {
            print("\(candidate.engine)\t\(candidate.title)\t\(candidate.folder)")
        }
        for warning in scan.warnings { print("⚠️ \(warning)") }
        if scan.limited { print("⚠️ 已达到深度或数量上限，结果可能不完整。") }
        print("只预览，未写入游戏库。")
        return scan.warnings.isEmpty && !scan.limited ? 0 : 1
    } catch { print("❌ 扫描失败：\(error)"); return 1 }
}

/// CLI 没有应用内运行状态，不能安全决定是否允许改路径，因此只做真实目录校验与预览。
func runRelocationProbe(id: String, folder: String) -> Int {
    let dir = DataDir.resolve().path
    let url = URL(fileURLWithPath: dir).appendingPathComponent("games.json")
    guard case .loaded(let map) = JSONStore.load(GameMap.self, from: url, quarantineCorrupt: false),
          let game = map.games[id] else { print("❌ 读取游戏记录失败"); return 1 }
    do {
        let result = try LibraryIntake.relocating(game, to: folder, in: map)
        print("原路径：\(game.gamePath)")
        print("新路径：\(result.games[id]!.gamePath)")
        print("校验通过。只预览，未写入；请停止游戏后在应用中确认保存。")
        return 0
    } catch { print("❌ 定位校验失败：\(error)"); return 1 }
}
