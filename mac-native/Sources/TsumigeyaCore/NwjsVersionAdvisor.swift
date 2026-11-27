// 启动失败后「要不要建议换一个 NW.js 版本」的判定。
//
// ===== 为什么不做全自动降级 =====
//
// ① 判断不了「不兼容」：清单不兼容时进程**活着**、只是没有窗口
//    （实测：v0.106.1 与 v0.90.0 对 `name: ""` 都是弹框后进程仍在等），
//    而慢启动的游戏十几秒才出画面 —— 靠超时自动降级会误杀本来正常的游戏。
// ② 降版本有真实风险：nw.js 的 profile（localStorage 等）按 app 名共用一份目录，
//    高版本 Chromium 写过的 profile 被低版本读写可能损坏，等于拿用户存档冒险。
//
// 所以这里只做「有强信号时给建议」，由用户在详情页点一下决定：
//   强信号 = 启动后很短时间内进程就**没了**（不是「活着但没窗口」）。
//
// 反面例子要记牢：本项目的 FateEmpire of Dirt 不是这个信号能覆盖的 ——
// 它的进程一直活着，问题出在清单校验，解法是 `NwjsAppShim`，不是换版本。
import Foundation

public enum NwjsVersionAdvisor {

    /// 一条「换版本试试」的建议。
    public struct Suggestion: Sendable, Equatable {
        /// 刚启动用的版本。
        public let current: String
        /// 其它已装版本（按版本号降序，新的在前）。
        public let alternatives: [String]

        public init(current: String, alternatives: [String]) {
            self.current = current
            self.alternatives = alternatives
        }
    }

    /// 进程在多少秒内退出，才算「这个运行时压根没起来」。
    ///
    /// ⚠️ 别调太小：`Launcher.launch` 返回 pid 时进程刚 spwan，紧接着就查存活
    ///    会读到「还没起来」；2 秒轮询的第一拍大约在 2 秒后。
    ///    10 秒足够覆盖「起手就挂」（缺 dylib、架构不对、入口崩），
    ///    又不至于把「用户自己 10 秒内关掉」当成故障 —— 那种情况后面还有
    ///    `alternatives.isEmpty` 之外的人工判断（提示只是建议，不自动重启）。
    public static let earlyExitThreshold: TimeInterval = 10

    /// 是否该建议换版本。
    ///
    /// - Parameters:
    ///   - engine: 引擎 folder（只有 nwjs / tyrano 有意义）
    ///   - installed: 磁盘上已装的版本（`NwjsVersion.availableVersions`）
    ///   - current: 这次启动实际用的版本（可能是 nil：老记录没写 version）
    ///   - exitedAfter: 进程存活了多少秒就没了；`nil` = 不是这次启动的进程
    public static func suggestion(
        engine: String, installed: [String], current: String?,
        exitedAfter seconds: TimeInterval?
    ) -> Suggestion? {
        guard engine == "nwjs" || engine == "tyrano" else { return nil }
        guard let seconds, seconds >= 0, seconds <= earlyExitThreshold else { return nil }
        guard let current, !current.isEmpty, installed.contains(current) else { return nil }
        let others = installed
            .filter { $0 != current }
            .sorted { compareVersions($0, $1) > 0 }
        guard !others.isEmpty else { return nil }
        return Suggestion(current: current, alternatives: others)
    }
}
