import Foundation
import Testing
@testable import TsumigeyaApp
@testable import TsumigeyaCore

private final class DetailLookupGate: @unchecked Sendable {
    let entered = DispatchSemaphore(value: 0)
    let release = DispatchSemaphore(value: 0)

    func takeEntry() -> Bool { entered.wait(timeout: .now()) == .success }

    func waitForEntry() async -> Bool {
        await withCheckedContinuation { continuation in
            DispatchQueue.global().async {
                continuation.resume(returning: self.entered.wait(timeout: .now() + 5) == .success)
            }
        }
    }
}

@Suite("详情查找不阻塞绘制且不串游戏", .serialized)
@MainActor
struct GameDetailLookupTests {
    private func game(_ id: String) -> GameRecord {
        GameRecord(id: id, gameTitle: "测试游戏", gamePath: "/不存在/\(id)/Game.exe", gameEngine: "nwjs")
    }

    @Test("目录判据在主线程外执行，同一记录重复加载不再扫描")
    func backgroundAndReuse() async {
        let calls = DetailLookupGate()
        let lookup = GameDetailLookup { game in
            #expect(!Thread.isMainThread)
            calls.entered.signal()
            return .byRJ(game.id)
        }
        let game = game("RJ123456")
        await lookup.load(game: game)
        #expect(lookup.step == .byRJ("RJ123456"))
        #expect(lookup.rj == "RJ123456")
        await lookup.load(game: game)
        #expect(lookup.step == .byRJ("RJ123456"))
        #expect(calls.takeEntry())
        #expect(!calls.takeEntry())
    }

    @Test("慢目录的旧结果和已取消任务不能覆盖新游戏，取消后原游戏仍可重载")
    func staleAndCancelledResults() async throws {
        let gate = DetailLookupGate()
        let firstGame = game("1"), nextGame = game("2")
        let lookup = GameDetailLookup { game in
            #expect(!Thread.isMainThread)
            if game.id == "1" {
                gate.entered.signal()
                #expect(gate.release.wait(timeout: .now() + 5) == .success)
            }
            return .byKeyword(game.id)
        }
        let old = Task { await lookup.load(game: firstGame) }
        let started = await gate.waitForEntry()
        #expect(started)
        await lookup.load(game: nextGame)
        #expect(lookup.step == .byKeyword("2"))
        gate.release.signal()
        await old.value
        #expect(lookup.step == .byKeyword("2"))

        let cancelled = Task { await lookup.load(game: firstGame) }
        let restarted = await gate.waitForEntry()
        #expect(restarted)
        cancelled.cancel()
        gate.release.signal()
        await cancelled.value
        #expect(lookup.step == nil)
        await lookup.load(game: nextGame)
        #expect(lookup.step == .byKeyword("2"))
    }

    @Test("保留真实 readme 编号识别及无编号时按标题查找")
    func realReadme() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("detail-lookup-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let path = dir.appendingPathComponent("Game.exe")
        try Data().write(to: path)
        let readme = dir.appendingPathComponent("readme.txt")
        try "作品 RJ123456".write(to: readme, atomically: true, encoding: .utf8)
        let game = GameRecord(id: "1", gameTitle: "测试作品", gamePath: path.path, gameEngine: "nwjs")
        let lookup = GameDetailLookup()
        await lookup.load(game: game)
        #expect(lookup.rj == "RJ123456")
        try FileManager.default.removeItem(at: readme)
        let reloaded = GameDetailLookup()
        await reloaded.load(game: game)
        #expect(reloaded.step == .byKeyword("测试作品"))
        #expect(reloaded.rj == nil)
    }
}
