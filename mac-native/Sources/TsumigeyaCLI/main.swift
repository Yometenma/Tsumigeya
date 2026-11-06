// P0 骨架的入口（命令行）。
//
// 这个文件在 P4 会被换成 SwiftUI 的 `@main struct App: App`。
// 现在就做成命令行的理由见 Package.swift 文件头：
// P0–P3 是纯逻辑层，能在 Mac 上无 UI 验证，先不浪费一帧 UI 代码。
//
// 用法：
//   tsumigeya-cli data-dir          打印解析到的数据目录（含降级警告）
//   tsumigeya-cli list-games        读真实 games.json 并列出游戏
//   tsumigeya-cli roundtrip-games   读 → 写回临时文件 → 再读，验证不丢字段
//   tsumigeya-cli selftest          跑全部 P0 自检
import Foundation
import TsumigeyaCore

func main() {
    let args = CommandLine.arguments.dropFirst()
    let cmd = args.first ?? "selftest"

    switch cmd {
    case "data-dir":
        printDataDir()
    case "list-games":
        printGames()
    case "roundtrip-games":
        roundtripGames()
    case "detect":
        var f = 0
        f += runDetectCheck()
        f += runInstalledCheck()
        exit(f == 0 ? 0 : 1)
    case "deps":
        exit(runDependencyCheck() == 0 ? 0 : 1)
    case "saves":
        exit(runSaveCheck() == 0 ? 0 : 1)
    case "zip-probe":
        // zip-probe <目录>：生成一个测试 zip（给外部工具验证用）
        let out = args.count > 1
            ? args[args.index(args.startIndex, offsetBy: 1)]
            : FileManager.default.temporaryDirectory.path
        exit(runZipProbe(to: out) == 0 ? 0 : 1)
    case "install":
        // install <引擎> [--dry-run]
        let rest = Array(args.dropFirst())
        let engineArg = rest.first { !$0.hasPrefix("--") }
        let dryRun = rest.contains("--dry-run")
        exit(runInstall(engine: engineArg, dryRun: dryRun) == 0 ? 0 : 1)
    case "plan":
        exit(runLaunchPlanPreview() == 0 ? 0 : 1)
    case "launch":
        // launch [id]：不给 id 就是全部
        let target = args.count > 1 ? args[args.index(args.startIndex, offsetBy: 1)] : nil
        exit(runLaunchVerify(gameId: target) == 0 ? 0 : 1)
    case "selftest":
        var failures = 0
        failures += printDataDir()
        failures += printGames()
        failures += roundtripGames()
        failures += runDetectCheck()
        failures += runInstalledCheck()
        print("")
        if failures == 0 {
            print("✅ 全部自检通过")
        } else {
            print("❌ 自检有 \(failures) 项失败")
            exit(1)
        }
    default:
        print("未知命令：\(cmd)")
        print("可用：data-dir / list-games / roundtrip-games / detect / deps / plan / launch / selftest")
        exit(2)
    }
}

// MARK: - 数据目录

@discardableResult
func printDataDir() -> Int {
    let dir = DataDir.resolve()
    print("=== 数据目录 ===")
    print("路径    : \(dir.path)")
    print("来源    : \(dir.source.rawValue)")
    if let warning = dir.warning {
        print("⚠️ 降级  : 请求 \(warning.requested) → 实际 \(warning.switchedTo) (\(warning.code))")
        return 1
    }
    print("✅ 无降级")
    return 0
}

// MARK: - 列出游戏

@discardableResult
func printGames() -> Int {
    let dir = DataDir.resolve()
    let url = URL(fileURLWithPath: dir.path).appendingPathComponent("games.json")

    print("")
    print("=== 游戏列表 ===")
    print("文件    : \(url.path)")

    switch JSONStore.load(GameMap.self, from: url) {
    case .missing:
        print("（没有 games.json —— 首次运行会是这样，正常）")
        return 0

    case .corrupt(let failure):
        print("❌ 读不出：\(failure.reason)")
        if let backup = failure.backupPath {
            print("   已改名保留：\(backup)")
        }
        return 1

    case .loaded(let map):
        let ordered = map.ordered
        print("共 \(ordered.count) 个游戏：")
        for g in ordered {
            let unknown = g.unknownFields.isEmpty ? "" : "  [未知字段 \(g.unknownFields.keys.sorted().joined(separator: ", "))]"
            print("  \(g.id.padding(toLength: 2, withPad: " ", startingAt: 0))  \(g.gameEngine.padding(toLength: 7, withPad: " ", startingAt: 0))  \(g.gameTitle)\(unknown)")
            print("      \(g.gamePath)")
        }
        return 0
    }
}

// MARK: - 往返测试

@discardableResult
func roundtripGames() -> Int {
    let dir = DataDir.resolve()
    let src = URL(fileURLWithPath: dir.path).appendingPathComponent("games.json")

    print("")
    print("=== 往返（读 → 写 → 再读）===")

    guard case .loaded(let original) = JSONStore.load(GameMap.self, from: src) else {
        print("（没有可读的 games.json，跳过）")
        return 0
    }

    // 写到**临时目录**，绝不动用户的真实文件。
    // ⚠️ 这条是纪律：验证永远不碰真实数据（AGENTS.md「收尾纪律」同款取向）。
    let tmpDir = FileManager.default.temporaryDirectory
        .appendingPathComponent("tsmg-roundtrip-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: tmpDir) }

    let tmpFile = tmpDir.appendingPathComponent("games.json")

    if let err = JSONStore.save(original, to: tmpFile) {
        print("❌ 写入失败：\(err)")
        return 1
    }

    guard case .loaded(let reparsed) = JSONStore.load(GameMap.self, from: tmpFile) else {
        print("❌ 写回的文件读不出来")
        return 1
    }

    // 逐条比对：id、标题、路径、引擎、未知字段
    var mismatches = 0
    if original.games.count != reparsed.games.count {
        print("❌ 条数变了：\(original.games.count) → \(reparsed.games.count)")
        mismatches += 1
    }
    for (id, a) in original.games {
        guard let b = reparsed.games[id] else {
            print("❌ 丢了游戏 id=\(id)")
            mismatches += 1
            continue
        }
        if a.gameTitle != b.gameTitle
            || a.gamePath != b.gamePath
            || a.gameEngine != b.gameEngine
            || a.gameArgs != b.gameArgs
            || a.unknownFields != b.unknownFields {
            print("❌ id=\(id) 字段不一致")
            mismatches += 1
        }
    }

    print(mismatches == 0
          ? "✅ 往返无损：\(original.games.count) 个游戏、字段全部一致"
          : "❌ 往返有 \(mismatches) 处不一致")
    return mismatches == 0 ? 0 : 1
}

main()
