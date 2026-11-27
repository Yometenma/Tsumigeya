import Testing
import Foundation
import TsumigeyaCore
@testable import TsumigeyaApp

/// 离线改写只对注入不了运行时的引擎开放；其余引擎走游戏内注入面板。
@Suite("离线改写入口范围")
struct OfflineTargetTests {
    @Test("只有 NScripter 与 RPG Maker 2000/2003 进入离线通道")
    func engineScope() {
        for engine in ["nscripter", "easyrpg"] {
            #expect(OfflineTarget.supports(engine), "\(engine) 应走离线通道")
        }
        for engine in ["nwjs", "mkxpz", "renpy", "tyrano", "godot", "siglus", "wine", ""] {
            #expect(!OfflineTarget.supports(engine), "\(engine) 不该出现离线入口")
        }
    }

    @Test("找不到脚本或数据库时返回 nil，不显示空入口")
    func detectsTargets() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("tsumigeya-offline-target-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        #expect(OfflineTarget.detect(engine: "nscripter", gamePath: dir.appendingPathComponent("game.exe").path) == nil)
        #expect(OfflineTarget.detect(engine: "easyrpg", gamePath: dir.appendingPathComponent("game.exe").path) == nil)

        try Data("x".utf8).write(to: dir.appendingPathComponent("nscript.dat"))
        let scripted = OfflineTarget.detect(engine: "nscripter", gamePath: dir.appendingPathComponent("game.exe").path)
        #expect(scripted?.fileName == "nscript.dat")

        try Data("x".utf8).write(to: dir.appendingPathComponent("RPG_RT.ldb"))
        let database = OfflineTarget.detect(engine: "easyrpg", gamePath: dir.appendingPathComponent("game.exe").path)
        #expect(database?.fileName == "RPG_RT.ldb")
    }

    @Test("2000/2003 数据库写回被拒绝，脚本写回真的落盘")
    @MainActor
    func appliesOnlyToScripts() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("tsumigeya-offline-apply-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try Data("\"こんにちは\"\n".utf8).write(to: dir.appendingPathComponent("0.txt"))
        try Data([0x0b] + Array("LcfDataBase".utf8) + [0x0b, 0x00]).write(to: dir.appendingPathComponent("RPG_RT.ldb"))

        let game = GameRecord(id: "1", gameTitle: "样本", gamePath: dir.appendingPathComponent("g.exe").path, gameEngine: "nscripter")
        let store = AppStore()
        let session = store.offlineSession(for: game)
        session.reload()
        #expect(session.target != nil)
        #expect(session.scriptEntries.map(\.source) == ["こんにちは"])
        #expect(session.apply(["こんにちは": "你好"]) == 1)
        let written = try String(contentsOf: dir.appendingPathComponent("0.txt"), encoding: .utf8)
        #expect(written.contains("你好"))
        #expect(FileManager.default.fileExists(atPath: dir.appendingPathComponent("0.txt.tsumigeya-bak").path))

        let legacy = GameRecord(id: "2", gameTitle: "旧作", gamePath: dir.appendingPathComponent("g.exe").path, gameEngine: "easyrpg")
        let other = store.offlineSession(for: legacy)
        other.reload()
        #expect(other.target != nil)
        #expect(other.apply(["Alex": "阿历克斯"]) == 0)
        #expect(other.error != nil)
    }

    @Test("字典导出两种目标都用空串占位，且不掺入不可译字段")
    @MainActor
    func exportsDictionary() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("tsumigeya-offline-export-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try Data("\"甲\"\n`乙\n".utf8).write(to: dir.appendingPathComponent("0.txt"))

        let game = GameRecord(id: "1", gameTitle: "样本", gamePath: dir.appendingPathComponent("g.exe").path, gameEngine: "nscripter")
        let store = AppStore()
        let session = store.offlineSession(for: game)
        session.reload()
        let data = try #require(session.exportDictionary())
        let dictionary = try JSONDecoder().decode([String: String].self, from: data)
        #expect(dictionary == ["甲": "", "乙": ""])
    }
}
