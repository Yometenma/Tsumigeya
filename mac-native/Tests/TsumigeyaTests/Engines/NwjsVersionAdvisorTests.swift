// 「换 NW.js 版本试试」建议的判定回归。
//
// 守的是**别自动乱降级**：只有「刚起来就没了」这种强信号、且有别的版本可换时才提示，
// 玩了几小时后正常关掉不能弹这个（否则等于把正常退出当故障）。
import Foundation
import Testing

@testable import TsumigeyaCore

@Suite("NW.js 换版本建议")
struct NwjsVersionAdvisorTests {

    private let installed = ["v0.106.1", "v0.90.0", "v0.80.0"]

    @Test("刚起来就退出 → 建议，且候选按版本号降序")
    func suggestsOnEarlyExit() throws {
        let suggestion = try #require(NwjsVersionAdvisor.suggestion(
            engine: "nwjs", installed: installed, current: "v0.106.1", exitedAfter: 3))
        #expect(suggestion.current == "v0.106.1")
        #expect(suggestion.alternatives == ["v0.90.0", "v0.80.0"])
    }

    /// 正常关游戏不能弹这个：那会让用户以为游戏坏了。
    @Test("跑很久之后退出 → 不建议")
    func noSuggestionAfterLongRun() {
        #expect(NwjsVersionAdvisor.suggestion(
            engine: "nwjs", installed: installed, current: "v0.106.1", exitedAfter: 600) == nil)
        #expect(NwjsVersionAdvisor.suggestion(
            engine: "nwjs", installed: installed, current: "v0.106.1",
            exitedAfter: NwjsVersionAdvisor.earlyExitThreshold + 1) == nil)
    }

    @Test("边界：正好等于阈值仍算早期退出")
    func thresholdBoundary() {
        #expect(NwjsVersionAdvisor.suggestion(
            engine: "nwjs", installed: installed, current: "v0.106.1",
            exitedAfter: NwjsVersionAdvisor.earlyExitThreshold) != nil)
    }

    @Test("只装了一个版本 → 没得换，不建议")
    func noAlternativeInstalled() {
        #expect(NwjsVersionAdvisor.suggestion(
            engine: "nwjs", installed: ["v0.106.1"], current: "v0.106.1", exitedAfter: 2) == nil)
    }

    @Test("别的引擎不掺和（mkxp-z / wine 的问题不是换 nwjs 版本）")
    func ignoresOtherEngines() {
        for engine in ["mkxpz", "wine", "renpy", "nscripter"] {
            #expect(NwjsVersionAdvisor.suggestion(
                engine: engine, installed: installed, current: "v0.106.1",
                exitedAfter: 2) == nil)
        }
        // tyrano 复用 nw.js 运行时，要管
        #expect(NwjsVersionAdvisor.suggestion(
            engine: "tyrano", installed: installed, current: "v0.106.1", exitedAfter: 2) != nil)
    }

    @Test("没有启动记录 / 当前版本不在已装列表里 → 不建议")
    func ignoresMissingContext() {
        #expect(NwjsVersionAdvisor.suggestion(
            engine: "nwjs", installed: installed, current: nil, exitedAfter: 2) == nil)
        #expect(NwjsVersionAdvisor.suggestion(
            engine: "nwjs", installed: installed, current: "v0.70.0", exitedAfter: 2) == nil)
        #expect(NwjsVersionAdvisor.suggestion(
            engine: "nwjs", installed: installed, current: "", exitedAfter: 2) == nil)
        #expect(NwjsVersionAdvisor.suggestion(
            engine: "nwjs", installed: installed, current: "v0.106.1", exitedAfter: nil) == nil)
    }
}
