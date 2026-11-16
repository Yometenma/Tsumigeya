import Darwin
import Foundation
import Testing
@testable import TsumigeyaApp
@testable import TsumigeyaCore

@MainActor
private func waitForState(
    timeout: Duration = .seconds(6), _ condition: () -> Bool
) async throws {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while !condition(), clock.now < deadline {
        try await Task.sleep(for: .milliseconds(20))
    }
    try #require(condition(), "等待实际进程或游戏库状态更新超时")
}

// 使用真实启动路径和本地 sleep 进程；不下载运行时，不读用户游戏库。
@MainActor
private final class RunningGameFixture {
    let directory: URL
    let store = AppStore()
    let game: GameRecord
    private var pid: Int32?

    init() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-running-" + UUID().uuidString)
        game = GameRecord(
            id: "fixture", gameTitle: "进程验收", gamePath: directory.appendingPathComponent("game.exe").path,
            gameEngine: "kirikiri")
        do {
            let binary = URL(fileURLWithPath: BinaryPaths.depsDir(directory.path, "kirikiri", "krkrsdl2"))
            try FileManager.default.createDirectory(at: binary.deletingLastPathComponent(), withIntermediateDirectories: true)
            try "#!/bin/sh\nexec /bin/sleep 30\n".write(to: binary, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: binary.path)
            try Data().write(to: URL(fileURLWithPath: game.gamePath))
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
    }

    func launch() async throws {
        await store.load(dataDirectory: directory.path)
        store.launch(game: game)
        pid = store.runningGames[game.id]
        let launchedPID = try #require(pid, "本地测试进程未启动：\(store.lastLaunchFailure)")
        try #require(RunningProcesses().isAlive(pid: launchedPID))
        #expect(store.lastLaunchFailure[game.id] == nil)
    }

    func exitGame() async throws {
        let currentPID = try #require(pid)
        try #require(kill(currentPID, SIGTERM) == 0)
        try await waitForState { !RunningProcesses().isAlive(pid: currentPID) }
        pid = nil
    }

    func cleanup() {
        store.stopRunningPoll()
        if let pid, RunningProcesses().isAlive(pid: pid) { kill(pid, SIGKILL) }
        try? FileManager.default.removeItem(at: directory)
    }
}

@Suite("应用运行状态")
@MainActor
struct AppRunningStateTests {
    @Test("正常启动后，游戏自行退出无需手工刷新即可从运行表消失")
    func launchStartsAutomaticRefresh() async throws {
        let fixture = try RunningGameFixture()
        defer { fixture.cleanup() }
        try await fixture.launch()
        try await fixture.exitGame()
        try await waitForState { fixture.store.runningGames[fixture.game.id] == nil }
    }

    @Test("切回应用立即清除已退出游戏，不依赖后台轮询")
    func activationRefreshesImmediately() async throws {
        let fixture = try RunningGameFixture()
        defer { fixture.cleanup() }
        try await fixture.launch()
        fixture.store.stopRunningPoll()
        try await fixture.exitGame()
        try #require(fixture.store.runningGames[fixture.game.id] != nil)
        fixture.store.refreshRunningFromAppActivation()
        #expect(fixture.store.runningGames[fixture.game.id] == nil)
    }

    @Test("切回应用保留存活游戏，并恢复之后的自动刷新")
    func activationRestartsPollingForLiveGame() async throws {
        let fixture = try RunningGameFixture()
        defer { fixture.cleanup() }
        try await fixture.launch()
        fixture.store.stopRunningPoll()
        fixture.store.refreshRunningFromAppActivation()
        #expect(fixture.store.runningGames[fixture.game.id] != nil)
        try await fixture.exitGame()
        try await waitForState { fixture.store.runningGames[fixture.game.id] == nil }
    }
}
