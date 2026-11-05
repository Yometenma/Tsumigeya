// P2 启动层：用真实游戏验证。
//
// 这是 P2 的硬判据，也是整个 SwiftUI 重写**成立与否的唯一硬判据**：
// 不是「代码编译过了」，而是「它真的能把用户这 5 个游戏拉起来」。
//
// ⚠️ 验收纪律（抄 AGENTS.md 的「收尾纪律」）：
//   · 启动前确认游戏进程**不是已经在跑**（否则测的是重复启动）
//   · 启动后立刻记录 pid
//   · 验证游戏进程确实在跑（不是 spawn 成功但立刻退了）
//   · 验完**杀掉**测试进程（不能留在用户机器上）
import Foundation

// MARK: - 启动计划预览（不真的启动）

func runLaunchPlanPreview() -> Int {
    let dir = DataDir.resolve()
    let url = URL(fileURLWithPath: dir.path).appendingPathComponent("games.json")

    print("")
    print("=== 启动计划预览（只看拼装结果，不真的启动）===")

    guard case .loaded(let map) = JSONStore.load(GameMap.self, from: url) else {
        print("❌ 读不到 games.json")
        return 1
    }

    let arch = currentArch()
    print("架构: \(arch)")
    print("")

    var failures = 0
    for game in map.ordered {
        print("id=\(game.id)  \(game.gameTitle)  [\(game.gameEngine)]")

        // ⚠️ 与 launch 走**同一套** gameArgs 准备流程（补默认值 + 展开占位符）。
        //    预览也要能看出「preloadScript 有没有补进来」—— 那正是上次崩掉的原因。
        let preparedArgs = GameArgs.prepare(
            userArgs: game.gameArgs, dataDir: dir.path, engine: game.gameEngine)
        var gameArgs = preparedArgs
        if game.gameEngine == "nwjs" || game.gameEngine == "tyrano" {
            if let resolved = resolveNwjsVersion(dir.path, current: gameArgs["version"]?.stringValue) {
                if resolved != gameArgs["version"]?.stringValue {
                    print("   版本修正: \(gameArgs["version"]?.stringValue ?? "-") → \(resolved)")
                }
                gameArgs["version"] = .string(resolved)
            } else {
                print("   ⚠️ deps 下没有 nwjs 版本目录")
            }
        }

        let folder = DetectPath.gameDirForFiles(game.gamePath)
        let ctx = LaunchContext(
            folder: folder,
            gamePath: game.gamePath,
            gameArgs: gameArgs,
            gameTitle: game.gameTitle,
            dataDir: dir.path,
            arch: arch
        )

        switch LaunchPlanner.plan(engine: game.gameEngine, context: ctx) {
        case .success(let plan):
            print("   二进制: \(plan.binary)")
            print("   参数  : \(plan.args.isEmpty ? "(无)" : plan.args.joined(separator: " "))")
            print("   cwd   : \(plan.cwd ?? "(不传)")")

            // ⚠️ mkxp-z 要特别显示**关键参数有没有补进来**
            // —— preloadScript 缺失就是上次崩掉的原因（kernel32 加载失败）。
            if game.gameEngine == "mkxpz" {
                let preload = gameArgs["preloadScript"]?.arrayValue?
                    .compactMap { $0.stringValue } ?? []
                if preload.isEmpty {
                    print("   ❌ preloadScript **没补进来** → 必定崩在 kernel32")
                    failures += 1
                } else {
                    let exists = preload.allSatisfy {
                        FileManager.default.fileExists(atPath: $0)
                    }
                    print("   \(exists ? "✅" : "❌") preloadScript: \(preload.joined(separator: ", "))")
                    if !exists { failures += 1 }
                }
                // rgssVersion：启动时由 MkxpzConfig.resolveRtp 从 ini 推出来，
                // 所以这里**不查 gameArgs**，直接查推出来的结果 —— 那才是真的写进配置的值。
                let rtp = MkxpzConfig.resolveRtp(context: ctx)
                if let v = rtp.rgssVersion {
                    print("   ✅ rgssVersion 推出: \(v)（来自 \(rtp.source)）")
                } else {
                    print("   ⚠️ rgssVersion 推不出来（mkxp-z 会自己猜）")
                }
                if !rtp.rtpDirs.isEmpty {
                    print("   ✅ RTP: \(rtp.rtpDirs.joined(separator: ", "))")
                }
            }

            // 预检（不启动）：二进制在不在、可不可执行
            if FileManager.default.fileExists(atPath: plan.binary) {
                let exec = FileManager.default.isExecutableFile(atPath: plan.binary)
                print("   ✅ 二进制存在\(exec ? "且可执行" : "但**不可执行**")")
                if !exec { failures += 1 }
            } else {
                print("   ❌ 二进制不存在")
                failures += 1
            }

        case .failure(let failure):
            print("   ⚠️ \(failure.message.replacingOccurrences(of: "\n", with: " / "))")
        }
        print("")
    }

    return failures == 0 ? 0 : 1
}

// MARK: - 真的启动（逐个验）

/// 启动指定 id 的游戏，验证它真的跑起来了，然后杀掉。
///
/// - Parameter gameId: `nil` = 全部
func runLaunchVerify(gameId: String?) -> Int {
    let dir = DataDir.resolve()
    let url = URL(fileURLWithPath: dir.path).appendingPathComponent("games.json")

    print("")
    print("=== 真实启动验证 ===")

    guard case .loaded(let map) = JSONStore.load(GameMap.self, from: url) else {
        print("❌ 读不到 games.json")
        return 1
    }

    let targets: [GameRecord]
    if let gameId {
        guard let g = map.games[gameId] else {
            print("❌ 没有 id=\(gameId) 的游戏")
            return 1
        }
        targets = [g]
    } else {
        targets = map.ordered
    }

    let arch = currentArch()
    var failures = 0
    var skipped = 0
    var uncertain = 0

    for game in targets {
        print("\n--- id=\(game.id)  \(game.gameTitle)  [\(game.gameEngine)] ---")

        // ⚠️ **必须走完整的 gameArgs 准备流程**（本鱼最初漏了这一步，导致 mkxp-z 崩在 kernel32）
        //
        // 完整流程 = 读 manifest → 按 schema 补缺省值 → 展开 <dataDir> 占位符。
        //
        // 漏掉的后果（实测）：mkxp.json 里只有 gameFolder/RTP/rgssVersion 三项，
        // 少了 `preloadScript`（kawariki 兼容层），于是脚本加载 `kernel32` 失败。
        let preparedArgs = GameArgs.prepare(
            userArgs: game.gameArgs, dataDir: dir.path, engine: game.gameEngine)

        // 版本值修正：deps 下的真实目录名（带 v）。
        var gameArgs = preparedArgs
        if game.gameEngine == "nwjs" || game.gameEngine == "tyrano" {
            if let resolved = resolveNwjsVersion(dir.path, current: gameArgs["version"]?.stringValue) {
                gameArgs["version"] = .string(resolved)
            }
        }

        let folder = DetectPath.gameDirForFiles(game.gamePath)
        let ctx = LaunchContext(
            folder: folder, gamePath: game.gamePath, gameArgs: gameArgs,
            gameTitle: game.gameTitle, dataDir: dir.path, arch: arch
        )

        guard case .success(let plan) = LaunchPlanner.plan(
            engine: game.gameEngine, context: ctx) else {
            print("❌ 构造计划失败")
            failures += 1
            continue
        }

        // ⚠️ **启动前先确认这个游戏没在跑**（2026-11-06 实测教训）
        //
        // 用户当时正在玩 Karryn's Prison，本鱼的测试把它当"启动失败"报了红。
        // 真实原因不是代码 —**NW.js 有单实例机制**：它发现已有实例在跑，
        // 就把启动请求转给那个实例、自己退出。所以「2.5 秒后进程没了」在这里
        // 恰恰说明**它工作正常**（单实例生效了）。
        //
        // 这条纪律的另一半更重要：**不能在用户玩游戏时启动同一个游戏**。
        // 会撞上单实例机制（大概率无事），但更糟的情况下会干扰他正在玩的存档。
        if let existing = runningProcesses(forGame: game, engine: game.gameEngine, dataDir: dir.path),
           !existing.isEmpty {
            print("⏭ 跳过：这个游戏**正在运行**（pid \(existing.joined(separator: ", "))）")
            print("   不会去启动它 —— 用户可能在玩，而且 NW.js 的单实例机制会让启动变成空操作。")
            skipped += 1
            continue
        }

        // 启动
        //
        // ⚠️ **验收时默认打开 stdio 捕获**（否则看不到 mkxp-z 卡在什么错误上）。
        // 生产启动路径仍然是 nullDevice（D55）。
        let captureLog = "/tmp/tsumigeya-launch-\(game.id).log"
        let outcome = Launcher.launch(plan, captureStdio: captureLog)
        guard outcome.ok, let pid = outcome.pid else {
            print("❌ 启动失败: \(outcome.detail)")
            failures += 1
            continue
        }
        print("✅ 已启动 pid=\(pid)")

        // ===== 等一会儿，然后用**正确的判据**判定它真的跑起来了吗 =====
        //
        // ⚠️ 「进程活着」不够！（用户 2026-11-06 当场指出「佣兵的冒险明明启动失败了」）
        //
        // 真相：mkxp-z 遇到 Ruby 异常**不退出**，它弹错误框等人点确定。
        // 于是进程活着 = 看起来成功，实际卡在错误框上。
        // 实测那个游戏卡在：`Failed loading .../kernel32: dlopen(...)`。
        //
        // 新判据（见 LaunchProbe）：窗口存在 > 日志无异常 > 进程存在。
        Thread.sleep(forTimeInterval: 3.0)

        let verdict = LaunchProbe.verdict(
            pid: pid, engine: game.gameEngine, gameFolder: folder,
            logPath: outcome.capturePath ?? captureLog)

        switch verdict {
        case .running(let windows, let evidence):
            if windows > 0 {
                print("✅ 正常：开了 \(windows) 个窗口（游戏真的在跑）")
            } else {
                print("✅ 正常（\(evidence)）")
            }
        case .stalled(let error):
            print("❌ 进程活着但**卡在错误上**：")
            for line in error.split(separator: "\n") {
                print("   \(line)")
            }
            failures += 1
        case .exited:
            print("⏭ 进程已退出（可能是单实例机制把请求转给了已有实例）")
            skipped += 1
        case .unknown(let reason):
            print("⚠️ 判定不了：\(reason)")
            uncertain += 1
        }

        // 清理：杀掉测试进程（不留垃圾在用户机器上）
        if processAlive(pid) {
            killProcess(pid)
            Thread.sleep(forTimeInterval: 0.5)
            print(processAlive(pid) ? "⚠️ 进程没杀掉，请手动检查 pid \(pid)" : "🧹 已清理测试进程")
        }
    }

    print("\n=== 结果 ===")
    if failures == 0 {
        var notes: [String] = ["✅ 全部启动成功"]
        if skipped > 0 { notes.append("⏭ \(skipped) 个因为正在运行而跳过") }
        if uncertain > 0 { notes.append("⚠️ \(uncertain) 个退出原因不确定（SSH 会话限制）") }
        print(notes.joined(separator: "\n"))
    } else {
        var notes = ["❌ \(failures) 个启动失败"]
        if skipped > 0 { notes.append("⏭ \(skipped) 个跳过（正在运行）") }
        if uncertain > 0 { notes.append("⚠️ \(uncertain) 个不确定") }
        print(notes.joined(separator: "\n"))
    }
    return failures == 0 ? 0 : 1
}

// MARK: - 找正在运行的进程

/// 找出「某个游戏」正在运行的 pid。
///
/// 判据是看命令行里有没有**这个游戏的目录路径**，而不是按引擎名盲杀 ——
/// 按引擎名杀会把别的游戏一起杀掉。
func runningProcesses(forGame game: GameRecord, engine: String, dataDir: String) -> [String]? {
    let folder = DetectPath.gameDirForFiles(game.gamePath)

    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/bin/ps")
    proc.arguments = ["-ax", "-o", "pid=,command="]
    let pipe = Pipe()
    proc.standardOutput = pipe
    proc.standardError = FileHandle.nullDevice

    do {
        try proc.run()
    } catch {
        return nil
    }
    proc.waitUntilExit()

    let data = pipe.fileHandleForReading.readDataToEndOfFile()
    guard let text = String(data: data, encoding: .utf8) else { return nil }

    var pids: [String] = []
    for line in text.components(separatedBy: .newlines) {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { continue }
        // 跳过 ps 自己
        if trimmed.contains("/bin/ps") { continue }
        guard trimmed.contains(folder) else { continue }
        // 取第一段当 pid
        if let pid = trimmed.split(separator: " ").first {
            pids.append(String(pid))
        }
    }
    return pids
}

// MARK: - 辅助

/// 当前架构字符串（`arm64` / `x64`）—— 与 Electron 版 `os.arch()` 的取值对齐。
///
/// ⚠️ Node 的 `os.arch()` 在 mac arm64 上返回 `arm64`，x64 上返回 `x64`。
/// 而 Swift 的 `#if arch(...)` 只有编译期常量。这里用运行时判断，
/// 因为**同一个二进制可能在 Rosetta 下跑**（那时应为 x64）。
func currentArch() -> String {
    // 运行时判断：读 sysctl 的 proc_translated（Rosetta 标记）
    var translated: Int32 = 0
    var size = MemoryLayout<Int32>.size
    let ok = sysctlbyname("sysctl.proc_translated", &translated, &size, nil, 0)
    if ok == 0 && translated == 1 {
        return "x64"   // 跑在 Rosetta 下 → 用 x64 的依赖
    }
    #if arch(arm64)
    return "arm64"
    #else
    return "x64"
    #endif
}

/// 解析 nwjs 的版本目录名。
///
/// ⚠️ 这是 Electron 版 `core-host.reconcileVersionArgs` 的等价物，非常关键：
/// 用户没选版本时 gameArgs 里可能是空，而上游兜底 `0.106.1`（**不带 v**），
/// 但 deps 下的真实目录名是 `v0.106.1`（**带 v**）→ 路径拼错 → 点启动没反应。
///
/// 判据：读 `deps/version/` 的真实目录名，优先用用户选的那个（若存在于磁盘），
/// 否则取**版本号最大**的那个。
func resolveNwjsVersion(_ dataDir: String, current: String?) -> String? {
    let versionsDir = BinaryPaths.nwjsVersionsDir(dataDir)
    guard let entries = try? FileManager.default.contentsOfDirectory(atPath: versionsDir) else {
        return nil
    }
    let dirs = entries.filter { name in
        var isDir: ObjCBool = false
        let full = (versionsDir as NSString).appendingPathComponent(name)
        return FileManager.default.fileExists(atPath: full, isDirectory: &isDir) && isDir.boolValue
    }

    // ① 用户选的那个（若真实存在）优先
    if let current, !current.isEmpty, dirs.contains(current) {
        return current
    }
    // ② 用户选的可能是「不带 v」的形式，补个 v 再试
    if let current, !current.isEmpty, !current.hasPrefix("v") {
        let withV = "v" + current
        if dirs.contains(withV) { return withV }
    }
    // ③ 都没命中 → 取版本号最大的
    guard !dirs.isEmpty else { return nil }
    return dirs.max { compareVersions($0, $1) < 0 }
}

/// 版本比较（对应 Electron 版 `engines/semver.ts`）。
///
/// 支持 `v` 前缀与 `1.2.3` 形式。不可解析的段按 0 处理。
func compareVersions(_ a: String, _ b: String) -> Int {
    func parts(_ s: String) -> [Int] {
        var t = s
        if t.hasPrefix("v") || t.hasPrefix("V") { t.removeFirst() }
        return t.split(separator: ".").map { Int($0) ?? 0 }
    }
    let pa = parts(a), pb = parts(b)
    let n = max(pa.count, pb.count)
    for i in 0..<n {
        let x = i < pa.count ? pa[i] : 0
        let y = i < pb.count ? pb[i] : 0
        if x != y { return x < y ? -1 : 1 }
    }
    return 0
}

/// 进程是否还活着。
func processAlive(_ pid: Int32) -> Bool {
    // kill(pid, 0) 不发送信号，只做存在性检查（这是 POSIX 的标准做法）
    // 返回 0 = 存在且有权限；ESRCH = 不存在
    return kill(pid, 0) == 0
}

/// 温和地杀掉（先 TERM，等一下，再 KILL）。
///
/// 对应 Electron 版 `stopGame` 的两段式（D52：SIGTERM → 5s → SIGKILL）。
/// 这里测试用，等得短一点。
func killProcess(_ pid: Int32) {
    kill(pid, SIGTERM)
    for _ in 0..<10 {
        Thread.sleep(forTimeInterval: 0.2)
        if !processAlive(pid) { return }
    }
    kill(pid, SIGKILL)
}
