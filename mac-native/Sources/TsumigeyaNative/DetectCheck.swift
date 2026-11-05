// 识别自检：对真实游戏目录跑识别，结果要与 Electron 版一致。
//
// 这是 P1 的**唯一硬判据**：42 条单测证明算法语义对，但只有这台机器上的
// 真实游戏能证明「它真的认得出来」。
import Foundation

// MARK: - 识别自检入口

func runDetectCheck() -> Int {
    let dir = DataDir.resolve()
    let url = URL(fileURLWithPath: dir.path).appendingPathComponent("games.json")

    print("")
    print("=== 引擎识别（真实游戏）===")
    print("数据目录: \(dir.path)")

    guard case .loaded(let map) = JSONStore.load(GameMap.self, from: url) else {
        print("❌ 读不到 games.json")
        return 1
    }

    var mismatches = 0
    let ordered = map.ordered
    print("共 \(ordered.count) 个游戏\n")

    for game in ordered {
        // 【期望值】来自 games.json 里存的 gameEngine —— 那是 Electron 版当初识别出来的结果
        let expected = game.gameEngine

        // 【实际值】Swift 版按同一套规则重新识别
        guard let detected = EngineRegistry.detect(exe: game.gamePath) else {
            print("❌ id=\(game.id) \(game.gameTitle)")
            print("   路径: \(game.gamePath)")
            print("   Swift 识别: nil（认不出）    Electron 记录: \(expected)")
            mismatches += 1
            continue
        }

        let match = detected.folder == expected
        let mark = match ? "✅" : "❌"
        print("\(mark) id=\(game.id)  \(game.gameTitle)")
        print("     路径      : \(game.gamePath)")
        print("     Swift 识别: \(detected.folder) (\(detected.name))")
        print("     Electron  : \(expected)")

        if !match {
            // 不只看「不同」，还说清「为什么」——这是排查的关键
            print("     ⚠️ 不一致！")
            mismatches += 1
        }
        print("")
    }

    print("=== 结果 ===")
    if mismatches == 0 {
        print("✅ \(ordered.count)/\(ordered.count) 全部与 Electron 版一致")
    } else {
        print("❌ \(mismatches)/\(ordered.count) 个不一致")
    }
    return mismatches == 0 ? 0 : 1
}

// MARK: - 已装引擎目录检查

func runInstalledCheck() -> Int {
    let dir = DataDir.resolve()
    let modulesDir = URL(fileURLWithPath: dir.path).appendingPathComponent("modules")

    print("")
    print("=== 已装引擎目录 ===")

    guard let contents = try? FileManager.default.contentsOfDirectory(
        at: modulesDir, includingPropertiesForKeys: nil) else {
        print("（没有 modules 目录）")
        return 0
    }

    let folders = contents
        .filter { (try? $0.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true }
        .map { $0.lastPathComponent }
        .sorted()

    print("共 \(folders.count) 个：")
    var unknown: [String] = []
    for folder in folders {
        if let engine = EngineRegistry.find(folder: folder) {
            let kind = engine.launchable ? "可启动" : "只识别"
            print("  ✅ \(folder.padding(toLength: 10, withPad: " ", startingAt: 0)) \(engine.name)  [\(kind)]")
        } else {
            print("  ❓ \(folder)  ← 注册表里没有这个引擎")
            unknown.append(folder)
        }
    }

    if !unknown.isEmpty {
        print("\n⚠️ 有 \(unknown.count) 个目录对不上注册表：\(unknown.joined(separator: ", "))")
        return 1
    }
    print("\n✅ 全部对得上注册表")
    return 0
}
