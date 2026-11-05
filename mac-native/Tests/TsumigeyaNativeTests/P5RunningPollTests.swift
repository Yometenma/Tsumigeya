// 运行状态轮询的判据测试。
//
// 用户 2026-11-06 报：「关掉游戏之后，为什么还是显示游戏运行中？」
//
// ===== 根因（值得记）=====
//
// `refreshRunning()` **只在 `load()` 里被调用过一次**（app 启动时），
// 之后**没有任何定时刷新**。于是：
//   · 内存表停在你启动游戏那一刻
//   · 游戏关了，表里那个 pid 还在
//   · 界面一直显示「运行中」
//
// ⚠️ 为什么单看代码看不出来：`refreshRunning()` 本身写得**完全正确**，
//    问题是**没人调用它**。这与 AGENTS.md 记的 S5 那条一模一样：
//    「判据写了、测了、但没人调用 —— 测试全绿，功能等于没写」。
//
// 所以本文件除了测 `RunningProcesses` 的行为，还要测**「轮询确实被接上了」**。
import Foundation
import Testing

@testable import TsumigeyaCore

// MARK: - 进程存活的判据

@Suite("进程存活判定")
struct RunningProcessesTests {

    /// 自己这个进程一定活着。
    @Test("当前进程存活")
    func selfIsAlive() {
        let processes = RunningProcesses()
        #expect(processes.isAlive(pid: getpid()))
    }

    /// ⚠️ **pid <= 0 一律当「不在」**。
    ///
    /// 守的是：`kill(0, 0)` 会检查**整个进程组**（永远返回成功），
    /// `kill(-1, 0)` 检查所有有权限的进程 —— 都被当「活着」的话，
    /// 界面会显示一堆假运行。
    @Test("pid 非正数当不在")
    func nonPositivePid() {
        let processes = RunningProcesses()
        #expect(!processes.isAlive(pid: 0))
        #expect(!processes.isAlive(pid: -1))
    }

    /// ⚠️ **已退出的子进程必须判成「不在」**。
    ///
    /// 实测记录（2026-11-06，Mac）：Swift 的 `Process`（= 我们的启动器用的）
    /// **会自动 reap**，所以子进程退出后 `kill(pid, 0)` 立刻返回 -1，
    /// **不会留下僵尸** —— 这是 `isAlive` 判据可靠的前提。
    ///
    /// ⚠️ 本测试**不用 `fork()`**：Swift 6 把它标成 unavailable
    ///    （"Please use threads or posix_spawn*()"），编译就过不了。
    ///    改用 `Process` 起一个短命进程，验证「它退出后判据变成不在」。
    @Test("退出的子进程判成不在")
    func exitedChildIsNotAlive() throws {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", "exit 0"]
        try p.run()

        let pid = p.processIdentifier
        #expect(pid > 0)

        // 等它退出并 reap（`waitUntilExit` 会 reap）
        p.waitUntilExit()

        let processes = RunningProcesses()
        let result = processes.isAlive(pid: pid)
        #expect(!result, "已退出的进程不该被当成运行中")
    }

    /// 一个**不存在**的 pid 判成不在（且不崩）。
    @Test("不存在的 pid")
    func nonexistentPid() {
        let processes = RunningProcesses()
        // 用一个几乎不可能存在的 pid（超出 macOS 上限）
        #expect(!processes.isAlive(pid: 999_999))
    }
}

// MARK: - 轮询必须被接上（源码级判据）

@Suite("运行状态轮询接线")
struct RunningPollWiringTests {

    /// 读 AppStore 源码。
    func appStoreSource() -> String? {
        let thisFile = URL(fileURLWithPath: #filePath)
        let packageRoot = thisFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let target = packageRoot
            .appendingPathComponent("Sources/TsumigeyaApp/AppStore.swift")
        return try? String(contentsOf: target, encoding: .utf8)
    }

    /// 去掉注释行后的代码行。
    func codeLines(_ source: String) -> [String] {
        source.split(separator: "\n").compactMap { line -> String? in
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("//") || t.hasPrefix("///") || t.hasPrefix("*") { return nil }
            return t
        }
    }

    /// ⚠️⚠️ **`startRunningPoll` 必须被调用**（不止是定义）。
    ///
    /// 守的是：定义了但没人调 = 功能等于没写，而**编译、单测全绿**。
    @Test("轮询有多处调用点")
    func pollHasMultipleCallSites() throws {
        let source = try #require(appStoreSource(), "读不到 AppStore.swift")
        let calls = codeLines(source).filter { $0.contains("startRunningPoll()") }
        let callSites = calls.filter { !$0.contains("func startRunningPoll") }
        #expect(callSites.count >= 2)
    }

    /// ⚠️ **必须有「切回应用立刻刷新」的入口**。
    @Test("切回应用时立刻刷新")
    func refreshOnActivation() throws {
        let source = try #require(appStoreSource(), "读不到 AppStore.swift")
        let has = source.contains("refreshRunningFromAppActivation")
        #expect(has)
    }

    /// ⚠️ **启动游戏成功后必须开始轮询**（这是「关了还显示运行中」的最直接原因）。
    @Test("启动后开始轮询")
    func pollAfterLaunch() throws {
        let source = try #require(appStoreSource(), "读不到 AppStore.swift")
        let lines = source.split(separator: "\n", omittingEmptySubsequences: false)
        var found = false
        for (idx, line) in lines.enumerated() {
            guard line.contains("runningGames[game.id] = pid") else { continue }
            let end = min(idx + 5, lines.count)
            let window = lines[idx..<end].joined()
            if window.contains("startRunningPoll()") {
                found = true
                break
            }
        }
        #expect(found)
    }
}
