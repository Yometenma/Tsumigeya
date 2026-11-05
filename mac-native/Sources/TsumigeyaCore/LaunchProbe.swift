// 启动后的「真的跑起来了吗」判定。
//
// ===== 为什么需要这个（2026-11-06 用户当场指出）=====
//
// 本鱼最初用「spawn 成功 + 2.5 秒后进程还在」当判据 —— **用户立刻反驳了
// 「那个佣兵的冒险明明启动失败了」**，而本鱼查到的真相是：
//
//   进程确实活着，但它**卡在一个 Ruby 异常上**：
//     `Failed loading .../kernel32: dlopen(...): no such file`
//     `from WF-RGSS Scripts rev-29:776:in initialize'`
//
//   这游戏带的是 **WOLF RPG Editor 风格的 Windows 专用脚本**，
//   它要 `kernel32.dll` —— macOS 上不存在。
//
//   而 mkxp-z 遇到脚本异常**不退出**，它弹一个错误对话框等人点确定。
//   于是「进程存活」=看起来成功，实际是**卡在错误框上**。
//
// ===== 正确的判据 =====
//
// 「进程活着」是**必要不充分**条件。必须再看它**有没有正常走到游戏主循环**。
//
// 判据来源：mkxp-z 启动时会往 stdout 打一串固定格式的启动横幅。正常启动会看到：
//
//     RGSS version 3 (RPG Maker VX Ace)
//     Backend           : Metal
//     ...
//     Loading path cache...
//     Path cache completed.
//     <然后进游戏主循环，不再输出>
//
// 而**失败**时会在横幅之后立刻打出 Ruby 异常：
//
//     ...in `initialize': Failed loading .../kernel32: ...
//     from 002:WF-RGSS Scripts ...
//
// 所以判据是：**收它的 stderr/stdout，看有没有异常特征**。
//
// ⚠️ 这要求**不接 nullDevice**（否则看不到）。而 D55 要求 stdio 不挂在启动器上……
//
// 解法：**启动器启动时不接 nullDevice 会违反 D55**。
// 所以这里走另一条路：**启动后单独探一次**（不改变 Launcher 的语义）。
// 具体的做法放在 `LaunchProbe`，只在验收命令里用 —— 生产启动路径仍然是 D55 的 nullDevice。
import Foundation
import CoreGraphics

/// 一次「真的跑起来了吗」探测的结果。
public enum RuntimeVerdict: Sendable, Equatable {
    /// 进程活着，且没看到异常特征 → 认为正常。
    case running(windowCount: Int, evidence: String)
    /// 进程活着，但看到了 Ruby/引擎异常 → **实际是失败的**。
    case stalled(error: String)
    /// 进程已退出。
    case exited
    /// 证据不足（SSH 会话限制、看不到窗口等）。
    case unknown(reason: String)
}

public enum LaunchProbe {

    /// 判定某个引擎进程的实际运行状态。
    ///
    /// 判据（按可靠性排序）：
    ///   ① **窗口存在**（最硬的证据：能开窗口说明它过了初始化）
    ///   ② **CPU 时间在增长**（次硬：说明它在跑主循环，而不是卡在错误框上没有动作）
    ///   ③ **日志里有正常启动特征**（次之：说明它走完了初始化）
    ///   ④ 进程存在性（最弱，只排「已退出」）
    ///
    /// - Parameter cpuSampleInterval: 采两次 CPU 时间的间隔（秒）
    public static func verdict(
        pid: Int32,
        engine: String,
        gameFolder: String,
        logPath: String? = nil,
        cpuSampleInterval: Double = 1.2
    ) -> RuntimeVerdict {
        // ④ 最弱：进程还在吗
        guard kill(pid, 0) == 0 else { return .exited }

        // ① 硬证据：有没有窗口
        let windowCount = countWindows(ofPID: pid)
        if windowCount > 0 {
            return .running(windowCount: windowCount, evidence: "窗口 \(windowCount) 个")
        }

        // ② 次硬：CPU 时间有没有在增长
        //
        // ⚠️ 这一条专门用来区分「在跑主循环」与「卡在错误弹窗」：
        //    卡在弹窗上的进程 CPU 时间**不涨**（它只是在等用户点确定）；
        //    正常跑游戏的进程每帧都要渲染，CPU 一定在涨。
        //
        //    实测教训：mkxp-z 卡在 `kernel32` 错误框时，进程活着但 CPU 不动。
        let cpuBefore = cpuTimeNanos(pid: pid)
        Thread.sleep(forTimeInterval: cpuSampleInterval)
        let cpuAfter = cpuTimeNanos(pid: pid)

        if let before = cpuBefore, let after = cpuAfter {
            let delta = after - before
            // 阈值 20ms：1.2 秒里连 20ms CPU 都没用掉，说明它基本没在动
            // （渲染一帧就要几毫秒，正常游戏在 1.2 秒里会用掉几百 ms）
            if delta > 20_000_000 {
                return .running(
                    windowCount: 0,
                    evidence: "CPU 在增长（\(delta / 1_000_000)ms / \(cpuSampleInterval)s）")
            }
            // CPU 完全不涨 → 大概率卡在弹窗上
            if delta <= 1_000_000 {
                // 再看看日志有没有错误特征，有就报 stalled
                if let logPath, let text = try? String(contentsOfFile: logPath, encoding: .utf8),
                   let error = extractFatalError(from: text, engine: engine) {
                    return .stalled(error: error)
                }
                return .unknown(reason: "进程活着但 CPU 几乎不动（可能卡在错误弹窗上）")
            }
        }

        // ③ 次之：日志证据
        if let logPath, let text = try? String(contentsOfFile: logPath, encoding: .utf8) {
            if let error = extractFatalError(from: text, engine: engine) {
                return .stalled(error: error)
            }
            if let evidence = normalStartEvidence(from: text, engine: engine) {
                return .running(windowCount: 0, evidence: evidence)
            }
        }

        // 都没有 → 证据不足
        return .unknown(reason: "看不到窗口，也没有日志/CPU 证据（可能是 SSH 会话限制）")
    }

    /// 读进程累计 CPU 时间（纳秒）。读不到返回 nil。
    ///
    /// 用 `ps -o time=` 的输出解析 —— 比直接调 libproc 简单且不依赖私有 API。
    public static func cpuTimeNanos(pid: Int32) -> UInt64? {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/bin/ps")
        proc.arguments = ["-p", String(pid), "-o", "time="]
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        do { try proc.run() } catch { return nil }
        proc.waitUntilExit()

        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let raw = String(data: data, encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return nil
        }
        return parsePsTime(raw)
    }

    /// 解析 `ps -o time=` 的格式：`MM:SS.ss` / `HH:MM:SS` / `DD-HH:MM:SS`。
    static func parsePsTime(_ raw: String) -> UInt64? {
        // 可能有 "0:00.87" / "00:01:23" / "1-02:03:04"
        var text = raw
        var days: UInt64 = 0
        if let dash = text.firstIndex(of: "-") {
            days = UInt64(text[text.startIndex..<dash]) ?? 0
            text = String(text[text.index(after: dash)...])
        }
        let parts = text.split(separator: ":").map(String.init)
        guard !parts.isEmpty else { return nil }

        var seconds: Double = 0
        if parts.count == 1 {
            seconds = Double(parts[0]) ?? 0
        } else if parts.count == 2 {
            seconds = (Double(parts[0]) ?? 0) * 60 + (Double(parts[1]) ?? 0)
        } else if parts.count == 3 {
            seconds = (Double(parts[0]) ?? 0) * 3600
                + (Double(parts[1]) ?? 0) * 60
                + (Double(parts[2]) ?? 0)
        }
        let totalSeconds = seconds + Double(days) * 86400
        return UInt64(totalSeconds * 1_000_000_000)
    }

    /// 从日志里找「正常启动」的证据。
    ///
    /// ⚠️ 特征全部来自**实测**，不是猜的：
    ///
    /// **mkxp-z** 正常启动会打出这几行（本机实测）：
    ///     `RGSS version 3 (RPG Maker VX Ace)`
    ///     `Backend           : Metal`
    ///     `Loading path cache...` → `Path cache completed.`
    /// 走到 `Path cache completed.` 说明**脚本层已经初始化完成**，正在进主循环。
    ///
    /// **NW.js** 正常启动的特征比较弱（Chromium 的日志很杂），
    /// 所以这里只找最明确的：没有 `Cannot open ... app.nw` **之后的**致命错误，
    /// 且进程活着 —— 那归到 unknown（诚实：NW.js 在 SSH 里确实难判）。
    public static func normalStartEvidence(from text: String, engine: String) -> String? {
        switch engine {
        case "mkxpz":
            if text.contains("Path cache completed") {
                return "日志显示 Path cache completed（脚本层初始化完成）"
            }
            if text.contains("RGSS version") {
                return "日志显示 RGSS version 已识别"
            }
            return nil
        default:
            return nil
        }
    }

    // MARK: - 窗口统计

    /// 统计某个进程拥有的窗口数。
    ///
    /// 用 CoreGraphics 的 `CGWindowListCopyWindowInfo`（**不需要辅助功能权限**，
    /// 与 `System Events` 的 AppleScript 不同 —— 后者在 SSH 里会报
    /// `osascript is not allowed assistive access`）。
    ///
    /// ⚠️ 在**无图形会话**（SSH）里这个列表可能是空的 —— 那是环境限制，
    ///    不是「游戏没开窗口」。所以窗口数 0 **不能**直接判失败。
    public static func countWindows(ofPID pid: Int32) -> Int {
        guard let list = CGWindowListCopyWindowInfo(
            [.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: AnyObject]] else {
            return 0
        }
        var count = 0
        for info in list {
            guard let owner = info[kCGWindowOwnerPID as String] as? Int32,
                  owner == pid else { continue }
            // 只算「真的有内容」的窗口（layer 0 = 普通应用窗口）
            if let layer = info[kCGWindowLayer as String] as? Int, layer == 0 {
                count += 1
            }
        }
        return count
    }

    // MARK: - 日志分析

    /// 从日志文本里提取**致命错误**（没有就返回 nil）。
    ///
    /// ⚠️ 这里的特征字符串是**实测来的**，不是猜的：
    ///   · mkxp-z 的 Ruby 异常形如
    ///     `` `initialize': Failed loading ... (RuntimeError) `` + `from 002:...in ...`
    ///   · 要排除的**误报**：正常启动也有若干 `ERROR:` 开头的 Chromium 日志
    ///     （`Keychain lookup failed` / `SharedImageManager::ProduceOverlay` / `Invalid mailbox`），
    ///     那些**不影响游戏运行**，不能当致命错误。
    public static func extractFatalError(from text: String, engine: String) -> String? {
        let lines = text.components(separatedBy: .newlines)

        switch engine {
        case "mkxpz":
            // 找 Ruby 异常的两行组合
            for (i, line) in lines.enumerated() {
                // 特征 1：`Failed loading` + `dlopen`
                if line.contains("Failed loading"), line.contains("dlopen") {
                    // 带上下一行的 from 调用栈，便于定位
                    var detail = line.trimmingCharacters(in: .whitespaces)
                    if i + 1 < lines.count, lines[i + 1].contains("from") {
                        detail += "\n" + lines[i + 1].trimmingCharacters(in: .whitespaces)
                    }
                    return detail
                }
                // 特征 2：明确的 RuntimeError / NoMethodError 等 Ruby 致命异常
                for token in ["RuntimeError", "NoMethodError", "LoadError",
                              "SyntaxError", "NameError"] {
                    if line.contains(token), line.contains(":") {
                        return line.trimmingCharacters(in: .whitespaces)
                    }
                }
            }
            return nil

        default:
            // 其他引擎：暂时只找最明显的「FATAL」/「cannot open」类特征
            for line in lines {
                if line.contains("FATAL") || line.contains("could not be loaded") {
                    return line.trimmingCharacters(in: .whitespaces)
                }
            }
            return nil
        }
    }
}
