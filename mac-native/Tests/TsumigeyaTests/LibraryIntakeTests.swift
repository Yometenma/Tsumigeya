import Foundation
import Testing
@testable import TsumigeyaCore

private struct IntakeFixture {
    let root: URL
    init() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("intake-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }
    func folder(_ path: String, engine: String? = "kirikiri") throws -> URL {
        let url = root.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        if engine == "kirikiri" { try Data().write(to: url.appendingPathComponent("data.xp3")) }
        if engine == "godot" { try Data().write(to: url.appendingPathComponent("game.pck")) }
        if engine == "unity" { try Data().write(to: url.appendingPathComponent("UnityPlayer.dll")) }
        return url
    }
    func clean() { try? FileManager.default.removeItem(at: root) }
}

@Suite("批量扫描与定位规则")
struct LibraryIntakeTests {
    @Test("只检查当前目录，不向上误认；命中后不深入资源目录")
    func exactAndPruned() throws {
        let f = try IntakeFixture(); defer { f.clean() }
        let game = try f.folder("游戏.v2")
        let nested = try f.folder("游戏.v2/资源/另一个特征")
        #expect(try LibraryIntake.inspectFolder(nested.deletingLastPathComponent().path) == nil)
        let report = try LibraryIntake.scan(root: f.root.path)
        #expect(report.candidates.map(\.folder) == [game.path])
        #expect(report.candidates.first?.title == "游戏.v2")
        #expect(report.visited == 2)
    }

    @Test("识别仅扩展名游戏，并保留只能识别的引擎")
    func extensionsAndDetectOnly() throws {
        let f = try IntakeFixture(); defer { f.clean() }
        _ = try f.folder("乙", engine: "godot"); _ = try f.folder("甲", engine: "unity")
        let report = try LibraryIntake.scan(root: f.root.path)
        #expect(Set(report.candidates.map(\.engine)) == ["godot", "unity"])
        #expect(report.warnings.isEmpty)
    }

    @Test("目录符号链接和循环不跟随，根目录别名可用")
    func symbolicLinks() throws {
        let f = try IntakeFixture(); defer { f.clean() }
        let game = try f.folder("game")
        try FileManager.default.createSymbolicLink(at: f.root.appendingPathComponent("alias"), withDestinationURL: game)
        try FileManager.default.createSymbolicLink(at: f.root.appendingPathComponent("loop"), withDestinationURL: f.root)
        #expect(try LibraryIntake.scan(root: f.root.path).candidates.count == 1)
        #expect(try LibraryIntake.scan(root: f.root.appendingPathComponent("alias").path).candidates.count == 1)
    }

    @Test("深度、目录数和候选数都有硬上限并明确报告")
    func limits() throws {
        let f = try IntakeFixture(); defer { f.clean() }
        _ = try f.folder("a/b/c/game"); _ = try f.folder("z")
        let depth = try LibraryIntake.scan(root: f.root.path, maxDepth: 1)
        #expect(depth.limited); #expect(depth.candidates.count == 1)
        let count = try LibraryIntake.scan(root: f.root.path, maxDirectories: 1)
        #expect(count.visited == 1); #expect(count.limited); #expect(count.candidates.isEmpty)
        let candidates = try LibraryIntake.scan(root: f.root.path, maxCandidates: 1)
        #expect(candidates.candidates.count == 1); #expect(candidates.limited)
    }

    @Test("取消不再读取目录，文件和不存在路径不能当集合目录")
    func cancellationAndInvalidRoot() throws {
        let f = try IntakeFixture(); defer { f.clean() }
        let game = try f.folder("game")
        let cancelled = try LibraryIntake.scan(root: f.root.path, cancelled: { true })
        #expect(cancelled.cancelled); #expect(cancelled.visited == 0); #expect(cancelled.candidates.isEmpty)
        #expect(throws: (any Error).self) { try LibraryIntake.scan(root: game.appendingPathComponent("data.xp3").path) }
        #expect(throws: (any Error).self) { try LibraryIntake.scan(root: f.root.appendingPathComponent("missing").path) }
    }

    @Test("一次构建整个批次，未知字段保留且编号连续")
    func batch() throws {
        let f = try IntakeFixture(); defer { f.clean() }
        let a = try f.folder("a"); let b = try f.folder("b")
        let old = GameRecord(id: "7", gameTitle: "旧", gamePath: "/missing/Game.exe", gameEngine: "nwjs", unknownFields: ["future": .int(3)])
        let map = GameMap(games: ["7": old])
        let candidates = try [a, b].map { try #require(try LibraryIntake.inspectFolder($0.path)) }
        let saved = try LibraryIntake.adding(candidates, to: map)
        #expect(saved.games.count == 3); #expect(saved.games["7"] == old)
        #expect(saved.games["8"]?.gameTitle == "a"); #expect(saved.games["9"]?.gameTitle == "b")
        #expect(map.games.count == 1)
    }

    @Test("重复标题、重复目录、符号链接别名以及空选择拒绝整个批次")
    func duplicates() throws {
        let f = try IntakeFixture(); defer { f.clean() }
        let a = try f.folder("a"); let b = try f.folder("b")
        let ca = try #require(try LibraryIntake.inspectFolder(a.path))
        var cb = try #require(try LibraryIntake.inspectFolder(b.path)); cb.title = ca.title
        #expect(throws: (any Error).self) { try LibraryIntake.adding([ca, cb], to: GameMap()) }
        #expect(throws: (any Error).self) { try LibraryIntake.adding([ca, ca], to: GameMap()) }
        #expect(throws: (any Error).self) { try LibraryIntake.adding([], to: GameMap()) }
        let map = try LibraryIntake.adding([ca], to: GameMap())
        let alias = f.root.appendingPathComponent("alias")
        try FileManager.default.createSymbolicLink(at: alias, withDestinationURL: a)
        #expect(LibraryIntake.duplicateFolder(alias.path, in: map) == "1")
        #expect(throws: (any Error).self) { try LibraryIntake.adding([ca], to: map) }
    }

    @Test("扫描后目录变化或候选引擎被篡改不会写入")
    func revalidate() throws {
        let f = try IntakeFixture(); defer { f.clean() }
        let a = try f.folder("a")
        let ca = try #require(try LibraryIntake.inspectFolder(a.path))
        let wrong = LibraryIntake.Candidate(folder: a.path, title: "a", engine: "nwjs")
        #expect(throws: (any Error).self) { try LibraryIntake.adding([wrong], to: GameMap()) }
        try FileManager.default.removeItem(at: a.appendingPathComponent("data.xp3"))
        #expect(throws: (any Error).self) { try LibraryIntake.adding([ca], to: GameMap()) }
    }

    @Test("定位只修改路径；参数、标签与未知字段原样保留")
    func relocate() throws {
        let f = try IntakeFixture(); defer { f.clean() }
        let new = try f.folder("new")
        let old = GameRecord(id: "42", gameTitle: "原标题", gamePath: "/missing/Game.exe", gameEngine: "kirikiri", iconPath: "icon", tags: ["tag"], gameArgs: ["x": .bool(true)], unknownFields: ["future": .string("keep")])
        let map = GameMap(games: [old.id: old])
        let relocated = try LibraryIntake.relocating(old, to: new.path, in: map)
        var expected = old; expected.gamePath = new.appendingPathComponent("Game.exe").path
        #expect(relocated.games["42"] == expected)
        #expect(map.games["42"] == old)
    }

    @Test("定位拒绝引擎不符、未知目录、记录被外部改动和已用目录")
    func relocateConflicts() throws {
        let f = try IntakeFixture(); defer { f.clean() }
        let target = try f.folder("target"); let wrong = try f.folder("wrong", engine: "godot")
        let unknown = try f.folder("unknown", engine: nil)
        let old = GameRecord(id: "1", gameTitle: "原", gamePath: "/gone/Game.exe", gameEngine: "kirikiri")
        let map = GameMap(games: ["1": old])
        for folder in [wrong, unknown] {
            #expect(throws: (any Error).self) { try LibraryIntake.relocating(old, to: folder.path, in: map) }
        }
        var stale = map; stale.games["1"]?.gameTitle = "外部改动"
        #expect(throws: (any Error).self) { try LibraryIntake.relocating(old, to: target.path, in: stale) }
        var occupied = map
        occupied.games["2"] = GameRecord(id: "2", gameTitle: "另一个", gamePath: target.appendingPathComponent("Game.exe").path, gameEngine: "kirikiri")
        #expect(throws: (any Error).self) { try LibraryIntake.relocating(old, to: target.path, in: occupied) }
    }
}
