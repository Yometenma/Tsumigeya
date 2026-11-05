// 真正把游戏拉起来的唯一一处。
//
// 对应 Electron 版：src/main/launchers/spawn.ts
// 契约：D54 / D55
//
// ===== D55：进程必须能脱离启动器存活 =====
//
// 「关掉 Tsumigeya 游戏还在跑」是这个产品的定位（启动器是启动器，不是容器）。
//
// Electron 版要靠 `detached + stdio:'ignore' + unref()` 三件套，
// 缺一个游戏就会被一起杀掉。
//
// ⚠️ **Swift 的 Process 天然满足这一条** —— 实测（2026-11-06，Mac 真机）：
//    Swift 进程 `exit(0)` 之后，它 spawn 的 `sleep 30` 仍存活，
//    `ps` 的 TTY 列显示 `??`（已脱离终端，由 launchd 收养）。
//    所以这里**不需要**「detach」这个概念。
//
// 但三件套的**意图要保留**：stdio 全部接 `FileHandle.nullDevice`。
// 理由：
//   ① 不接 → 游戏往 stdout/stderr 写东西，而启动器已经退出了，
//      写到一个死掉的管道会收到 SIGPIPE → **游戏崩**
//   ② 接 nullDevice 等于把输出丢进 /dev/null，最安全
//
// ⚠️ 还有一条实测教训：`Process.run()` 对「文件不存在」是**同步抛错**（不像 Node 是异步 error 事件）。
//    Swift 这里反而更好办——错误就在 try 里，不用像 Electron 那样「必须挂 error 监听否则崩主进程」。
import Foundation

/// 一次 spawn 的结果。
public struct SpawnOutcome: Sendable {
    public let ok: Bool
    public let pid: Int32?
    public let failure: LaunchFailure?
    /// 给上层看的说明（成功时含 pid）。
    public let detail: String
    /// 验收通道的日志路径（只有设了 `TSUMIGEYA_CAPTURE_STDIO` 时才有值）。
    public let capturePath: String?

    public static func success(
        pid: Int32, engine: String, capturePath: String? = nil
    ) -> SpawnOutcome {
        SpawnOutcome(ok: true, pid: pid, failure: nil,
                     detail: "已启动 \(engine)（pid \(pid)）",
                     capturePath: capturePath)
    }

    public static func failure(_ failure: LaunchFailure) -> SpawnOutcome {
        SpawnOutcome(ok: false, pid: nil, failure: failure, detail: failure.message,
                     capturePath: nil)
    }
}

public enum Launcher {

    /// 执行一个启动计划。
    ///
    /// - Parameters:
    ///   - plan: 已构造好的计划（路径与参数都定好了）
    ///   - captureStdio: **验收通道**。给了路径就把 stdout/stderr 写进该文件，
    ///     而不是 nullDevice。生产路径**必须**保持 nil（D55 要求 stdio 不挂在启动器上）。
    public static func launch(_ plan: LaunchPlan, captureStdio: String? = nil) -> SpawnOutcome {
        // ---- 1. 先查 cwd 再查 binary（顺序不能反，见 LaunchFailure 的注释）----
        //
        // ⚠️ 反过来会把「游戏目录被删」误报成「引擎没装」——
        //    用户会去重装引擎，而真正的问题是他拖走了游戏文件夹。
        if let cwd = plan.cwd {
            var isDir: ObjCBool = false
            if !FileManager.default.fileExists(atPath: cwd, isDirectory: &isDir) || !isDir.boolValue {
                return .failure(.gameFolderMissing(folder: cwd))
            }
        }

        var isDir: ObjCBool = false
        guard FileManager.default.fileExists(atPath: plan.binary, isDirectory: &isDir),
              !isDir.boolValue else {
            return .failure(.engineBinaryMissing(binary: plan.binary))
        }
        guard FileManager.default.isExecutableFile(atPath: plan.binary) else {
            return .failure(.notExecutable(binary: plan.binary))
        }

        // ---- 2. 组装 Process ----
        let process = Process()
        process.executableURL = URL(fileURLWithPath: plan.binary)
        process.arguments = plan.args
        if let cwd = plan.cwd {
            process.currentDirectoryURL = URL(fileURLWithPath: cwd)
        }

        // ---- 3. stdio 全部接 nullDevice（见文件头）----
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice

        // ⚠️ **验收专用**：`TSUMIGEYA_CAPTURE_STDIO` 环境变量存在时，
        // 把 stdout/stderr 重定向到该**文件路径**，而不是 nullDevice。
        //
        // 为什么需要它（2026-11-06 用户当场指出「佣兵的冒险明明启动失败了」）：
        // 接 nullDevice 时**看不到任何输出**，于是 mkxp-z 卡在 Ruby 异常弹窗时
        // 我们只能看到「进程活着」→ 误判成功。
        //
        // ⚠️ 这只是**验收通道**，生产路径永远是 nullDevice（D55 要求 stdio 不挂在启动器上）。
        // 打开这个变量时进程输出会写进文件，但**父进程退出后管道会断** ——
        // 所以它只适合「启动后立刻观察」的验收场景，不适合日常使用。
        var capturePath: String? = nil
        if let path = captureStdio ?? ProcessInfo.processInfo.environment["TSUMIGEYA_CAPTURE_STDIO"],
           !path.isEmpty {
            if FileManager.default.createFile(atPath: path, contents: nil),
               let handle = FileHandle(forWritingAtPath: path) {
                process.standardOutput = handle
                process.standardError = handle
                capturePath = path
            }
        }

        // ⚠️ 环境变量：必须带上 HOME / PATH / USER 这些，否则很多引擎会不正常
        //   （mkxp-z 要找 SDL 配置、Ren'Py 要找 python、nwjs 要读 ~/Library）。
        //   Swift 的 Process 默认**继承**父进程环境，所以这里**不覆盖** ——
        //   但在启动器（.app）里，环境比从 shell 启动要干净得多，
        //   这是 P2 真机验收要盯的一个点。
        //
        // 这里显式注入 `LANG`（见下面 tarEnv 的同款教训）：
        //   Finder 启动的 .app 里 LANG 常常为空，而某些引擎依赖 UTF-8 locale。
        var env = ProcessInfo.processInfo.environment
        if env["LANG"] == nil || env["LANG"] == "" {
            env["LANG"] = "en_US.UTF-8"
        }
        env["TSUMIGEYA_LAUNCHED_BY"] = "native"
        process.environment = env

        // ---- 4. 跑 ----
        do {
            try process.run()
        } catch {
            return .failure(.spawnFailed(message: error.localizedDescription))
        }

        let pid = process.processIdentifier
        guard pid > 0 else {
            return .failure(.spawnFailed(message: "进程没有拿到 pid"))
        }

        // ⚠️ **不要 wait**：wait 会阻塞到游戏退出，等于启动器卡死。
        //    也不要持强引用（Process 对象释放不影响子进程存活 —— 实测过）。

        return .success(pid: pid, engine: plan.engine, capturePath: capturePath)
    }
}
