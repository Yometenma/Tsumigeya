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

// MARK: - 依赖解析检查（P3）

/// 检查每个已装引擎的 manifest 依赖表能不能正确解析。
///
/// 这是 P3 的静态验收：**不下载、不安装**，只验「读出来的依赖名/架构/可选标记对不对」。
/// 为什么不直接跑安装：那要下 1GB+，而且会动用户的 modules 目录。
func runDependencyCheck() -> Int {
    let dir = DataDir.resolve()
    print("")
    print("=== manifest 依赖解析 ===")

    let engines = ManifestStore.installedEngines(dataDir: dir.path)
    guard !engines.isEmpty else {
        print("（没有已装引擎）")
        return 0
    }

    var failures = 0
    for engine in engines {
        guard let m = ManifestStore.load(dataDir: dir.path, engine: engine) else {
            print("❌ \(engine): manifest 读不出来")
            failures += 1
            continue
        }
        print("\n\(engine)  (\(m.name) v\(m.version))  依赖 \(m.dependencyOrder.count) 个")
        if m.dependencyOrder.isEmpty {
            print("  ⚠️ 没有依赖（如果这个引擎该有运行时，说明解析漏了）")
        }
        for (name, spec) in m.orderedDependencies {
            let archs = spec.builds.keys.sorted().joined(separator: ",")
            let opt = spec.optional ? " [可选]" : ""
            let keep = spec.keepSingleDir ? "" : " [拍平]"
            print("  ✓ \(name)")
            print("      archs=\(archs)\(opt)\(keep)")
            // 预检：能不能为当前架构选出下载地址
            if EngineInstaller.pickBuild(spec: spec, arch: currentArch()) == nil {
                print("      ⚠️ 当前架构（\(currentArch())）选不出下载地址")
                failures += 1
            }
        }
    }

    print("")
    if failures == 0 {
        print("✅ 依赖解析全部正常")
    } else {
        print("❌ \(failures) 项有问题")
    }
    return failures == 0 ? 0 : 1
}
