// 识别自检：对真实游戏目录跑识别，结果要与 Electron 版一致。
//
// 这是 P1 的**唯一硬判据**：42 条单测证明算法语义对，但只有这台机器上的
// 真实游戏能证明「它真的认得出来」。
import Foundation
import TsumigeyaCore

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

// MARK: - 存档探测检查（P6）

/// 用真实游戏验证存档位置探测。
///
/// ⚠️ 这是 P6 的唯一硬判据：单测证明「布局 A 指向 B」，
///    但只有真实游戏能证明「它真的能找到用户的存档」。
func runSaveCheck() -> Int {
    let dir = DataDir.resolve()
    print("")
    print("=== 存档位置探测（真实游戏）===")

    let url = URL(fileURLWithPath: dir.path).appendingPathComponent("games.json")
    guard case .loaded(let map) = JSONStore.load(GameMap.self, from: url) else {
        print("❌ 读不到 games.json")
        return 1
    }

    var failures = 0
    for game in map.ordered {
        print("")
        print("id=\(game.id)  \(game.gameTitle)  [\(game.gameEngine)]")

        let listing = SaveStore.list(gamePath: game.gamePath, engine: game.gameEngine)

        guard let saveDir = listing.dir else {
            // ⚠️ **`nil` 有两种含义，文案必须分开**（本鱼第一版混成一句，
            //    CLI 实测时把「这个游戏还没存过档」误报成「引擎未实现」）：
            //
            //    · 引擎的**探测逻辑没实现**（tyrano / kirikiri）→ 那是我们的活没做完
            //    · 引擎**实现了但找不到位置**（mkxpz 的三个约定目录都不存在）
            //      → 那是「这个游戏还没存过档」，**正常状态**
            //
            //    两者对用户的含义完全不同，混成一句会让人以为程序坏了。
            let engineImplemented = ["nwjs", "mkxpz", "easyrpg", "renpy"]
                .contains(game.gameEngine)
            if engineImplemented {
                print("  ⚠️ 找不到存档位置 —— 三个约定目录都不存在")
                print("     （很可能是还没在这个游戏里存过档；这不影响启动）")
            } else {
                print("  ⚠️ 这个引擎的存档位置**还没实现**（已知缺口，不是 bug）")
            }
            continue
        }

        print("  目录: \(saveDir)")
        let exists = FileManager.default.fileExists(atPath: saveDir)
        print("  存在: \(exists ? "是" : "**否**（用户还没存过档 —— 正常）")")

        if listing.items.isEmpty {
            print("  条目: 0（空）")
        } else {
            let slots = listing.items.filter { !$0.isConfig }
            let configs = listing.items.filter { $0.isConfig }
            print("  条目: \(slots.count) 个槽 + \(configs.count) 个配置")
            for item in listing.items.prefix(6) {
                let size = item.size.map { "\($0) B" } ?? "?"
                print("    \(item.isConfig ? "[配置] " : "")\(item.name)  \(size)")
            }
            if listing.items.count > 6 {
                print("    …还有 \(listing.items.count - 6) 个")
            }
        }
    }

    print("")
    if failures == 0 { print("✅ 存档探测完成") } else { print("❌ \(failures) 项有问题") }
    return failures == 0 ? 0 : 1
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
        if m.dependencyOrder.isEmpty && engine != "tyrano" {
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

        // ⚠️ **二进制路径检查**（P3 加）：依赖装好了但路径找不到 = 白装。
        // 这是端到端测试抓到的真问题（siglus 落地多一层子目录）。
        //
        // ⚠️ nwjs 需要**版本号**才能拼路径（`deps/version/v0.106.1/...`），
        //    而这里没有 gameArgs。所以对 nwjs 用「扫版本目录取最新」兜住 ——
        //    真正的启动路径由 `resolveNwjsVersion` 从游戏参数解析，这里只是健康检查。
        let arch = currentArch()
        var version = ""
        if engine == "nwjs" {
            version = NwjsVersion.resolve(dataDir: dir.path, current: nil) ?? ""
        }
        if let binary = BinaryPaths.binary(
            for: engine, dataDir: dir.path, version: version, arch: arch) {
            let exec = FileManager.default.isExecutableFile(atPath: binary)
            print("  二进制: \(exec ? "✅" : "⚠️ 存在但不可执行") \(binary)")
            if !exec { failures += 1 }
        } else {
            // tyrano 复用 nwjs，没自己的二进制；只识别引擎不参与
            if EngineRegistry.find(folder: engine)?.launchable == true && engine != "tyrano" {
                print("  ❌ 找不到二进制（依赖装了但路径不对）")
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
