// 进程存活检查与游戏启动/停止。
//
// 对应 Electron 版：`src/main/process-registry.ts` + `launchers/spawn.ts` 的停止部分
// 契约：D50（进程表只在内存）/ D52（两段式停止）/ D55（进程脱离启动器）
//
// ===== 为什么单独一个类型 =====
//
// `Launcher` 只管「把游戏拉起来」（D55 的 stdio/detach 三件套）。
// 这个类型管「它还在不在」与「把它停掉」—— 两个不同职责：
//   · 启动是**一次性动作**，失败就没戏
//   · 存活/停止是**长期状态**，要能被反复查询
// 混在一起会让 Launcher 持有全局状态，那正是 Electron 版 `process-registry` 分开的理由。
import Foundation

public struct RunningProcesses: Sendable {

    public init() {}

    /// 进程是否还活着。
    ///
    /// 用 `kill(pid, 0)` 而不是 `ps` —— 后者要 fork 一个进程去查，
    /// 而这是**每个 UI 刷新周期都可能调用**的东西（在列表里显示「运行中」徽标）。
    /// `kill(pid, 0)` 不发信号，只做存在性 + 权限检查，是 POSIX 标准做法。
    ///
    /// ⚠️ **但它有误判**：进程退出后 PID 可能被系统复用给一个不相干的新进程，
    ///    那时 `kill(pid, 0)` 仍返回 0。要更准就得比对启动时间（Electron 版也一样没做），
    ///    而那种误判的后果只是「显示运行中但点停止没反应」，可接受。
    public func isAlive(pid: Int32) -> Bool {
        guard pid > 0 else { return false }
        return kill(pid, 0) == 0
    }

    /// 停止一个进程（**两段式**，D52）。
    ///
    /// 先 SIGTERM（温和，让游戏有机会存档/清理），
    /// 等一段时间还没退就 SIGKILL（卡死的也能救）。
    ///
    /// ⚠️ **等多久**：Electron 版用 5 秒。这个数字的依据是
    /// 「正常游戏收到 TERM 后 <1 秒就退，5 秒足够覆盖慢的存档写盘」，
    /// 而再长会让用户觉得「点了停止没反应」。
    ///
    /// - Returns: 是否成功停止（已经不在也算成功 —— 幂等）
    @discardableResult
    public func terminate(pid: Int32, graceSeconds: Double = 5.0) -> Bool {
        guard isAlive(pid: pid) else { return true }

        kill(pid, SIGTERM)

        // 轮询等待（不用 waitpid：我们已经不是它的父进程了，D55 让它脱离了）
        let deadline = Date().addingTimeInterval(graceSeconds)
        while Date() < deadline {
            if !isAlive(pid: pid) { return true }
            Thread.sleep(forTimeInterval: 0.15)
        }

        // 还没退 → 强杀
        kill(pid, SIGKILL)
        // 再等一下确认（SIGKILL 是同步的，但进程回收有微小时延）
        for _ in 0..<10 {
            if !isAlive(pid: pid) { return true }
            Thread.sleep(forTimeInterval: 0.05)
        }
        return !isAlive(pid: pid)
    }
}
