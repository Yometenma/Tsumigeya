// P5 添加游戏 / 库 CRUD 测试。
//
// 对应 Electron 版：`test/import-target.test.ts`（29 条）+ games-store 相关
import Foundation
import Testing

@testable import TsumigeyaCore

// MARK: - 路径反推

@Suite("import-target 反推")
struct ImportTargetTests {

    /// 尾分隔符要剥掉（mac 上从 Finder 拖进来的路径常带 `/`）。
    @Test("剥尾分隔符")
    func stripTrailing() {
        #expect(ImportTarget.stripTrailingSep("/x/y/") == "/x/y")
        #expect(ImportTarget.stripTrailingSep("/x/y//") == "/x/y")
        #expect(ImportTarget.stripTrailingSep("/x/y") == "/x/y")
        // ⚠️ 根路径不能剥成空串
        #expect(ImportTarget.stripTrailingSep("/") == "/")
        #expect(ImportTarget.stripTrailingSep("") == "")
        #expect(ImportTarget.stripTrailingSep(nil) == "")
    }

    /// 尝试序列：从选中文件本身，逐层上退，**最多 2 层**。
    @Test("尝试序列逐层上退")
    func attemptsSequence() {
        let a = ImportTarget.attempts(selectedPath: "/games/MyGame/Game.exe")
        #expect(a.count == 3, "level 0/1/2")
        #expect(a[0].path == "/games/MyGame/Game.exe")
        #expect(a[0].level == 0)
        #expect(a[1].path == "/games/MyGame")
        #expect(a[1].level == 1)
        #expect(a[2].path == "/games")
        #expect(a[2].level == 2)
    }

    /// ⚠️ **最多退 2 层**（不是 3 层、不是无限）。
    /// 守的是：退得太深会撞上无关目录的残骸文件，认出一个「看起来对」的引擎。
    @Test("上限 2 层")
    func maxTwoAscends() {
        let a = ImportTarget.attempts(selectedPath: "/a/b/c/d/e/f.txt")
        #expect(a.count == 3)
        #expect(a.last?.path == "/a/b/c/d")
    }

    /// 到根就停（不能退到空字符串）。
    @Test("到根停止")
    func stopsAtRoot() {
        let a = ImportTarget.attempts(selectedPath: "/x")
        // "/x" → level0="/x"，父目录是 "/" → 停
        #expect(a.count == 1)
        #expect(a[0].path == "/x")
    }

    /// maxAscend = 0 时只试选中本身。
    @Test("可以关掉上退")
    func noAscend() {
        let a = ImportTarget.attempts(selectedPath: "/games/MyGame/Game.exe", maxAscend: 0)
        #expect(a.count == 1)
    }

    /// ⚠️ **按顺序取第一个成功的**（不能全都试完再挑）。
    /// 守的是：越具体的路径越接近用户意图。
    @Test("按顺序取第一个成功")
    func resolvesFirstMatch() {
        // 模拟：level 0 认不出，level 1 认得「mid」，level 2 认得「top」
        let result = ImportTarget.resolve(selectedPath: "/games/MyGame/Game.exe") { path -> String? in
            if path == "/games/MyGame" { return "mid" }
            if path == "/games" { return "top" }
            return nil
        }
        #expect(result?.value == "mid", "level 1 先命中，不该跳到 level 2")
        #expect(result?.attempt.level == 1)
    }

    /// 全都认不出 → nil（由调用方让用户手选）。
    @Test("全失败返回 nil")
    func noMatch() {
        let result = ImportTarget.resolve(selectedPath: "/games/MyGame/Game.exe") { _ in nil as String? }
        #expect(result == nil)
    }
}

// MARK: - 库 CRUD

@Suite("游戏库 CRUD")
struct GameLibraryTests {

    func rec(_ title: String, _ path: String = "/p") -> GameRecord {
        GameRecord(id: "", gameTitle: title, gamePath: path, gameEngine: "nwjs")
    }

    /// 新增：id = max + 1。
    @Test("新增游戏 id 递增")
    func addIncrements() throws {
        var map = GameMap()
        let r1 = try GameLibrary.save(into: map, draft: rec("A")).get()
        #expect(r1.id == "1")
        map = r1.map

        let r2 = try GameLibrary.save(into: map, draft: rec("B")).get()
        #expect(r2.id == "2")
    }

    /// ⚠️ **删掉最后一个后新增会复用 id**（上游 schema 的特性）。
    /// 这条测试**记录真实行为**，而真正防「数据串号」的是「删游戏清四处」（见下）。
    @Test("删最后一个后 id 会被复用（上游特性）")
    func idReuse() throws {
        var map = GameMap()
        let r1 = try GameLibrary.save(into: map, draft: rec("A")).get()
        #expect(r1.id == "1")
        // ⚠️ **必须把 r1 的结果接回去**（本鱼第一版忘了这行 → 两次都从空 map 生成 id "1"）
        map = r1.map

        let r2 = try GameLibrary.save(into: map, draft: rec("B")).get()
        #expect(r2.id == "2")
        map = r2.map

        // 删掉 2 → 再加会复用 "2"
        map = GameLibrary.remove(from: map, id: "2")
        let r3 = try GameLibrary.save(into: map, draft: rec("C")).get()
        #expect(r3.id == "2", "上游用 max+1，删了最大的就会复用")
    }

    /// 同名游戏被拒（**大小写不敏感**）。
    @Test("同名游戏被拒")
    func duplicateTitle() throws {
        var map = GameMap()
        let r = try GameLibrary.save(into: map, draft: rec("苍蓝星")).get()
        map = r.map

        let result = GameLibrary.save(into: map, draft: rec("苍蓝星"))
        guard case .failure(.duplicateTitle) = result else {
            Issue.record("应该被拒"); return
        }
        // 大小写不敏感（英文名）
        let r2 = try GameLibrary.save(into: map, draft: rec("Karryn")).get()
        let map2 = r2.map
        guard case .failure(.duplicateTitle) =
                GameLibrary.save(into: map2, draft: rec("karryn")) else {
            Issue.record("大小写不同也算重名"); return
        }
    }

    /// 更新自己不算重名。
    @Test("更新自己不算重名")
    func updateSelfNotDuplicate() throws {
        var map = GameMap()
        let r = try GameLibrary.save(into: map, draft: rec("A")).get()
        map = r.map

        var draft = rec("A")
        draft.gameEngine = "mkxpz"
        let updated = GameLibrary.save(into: map, draft: draft, id: "1")
        guard case .success(let result) = updated else {
            Issue.record("应该成功"); return
        }
        #expect(result.map.games["1"]?.gameEngine == "mkxpz")
    }

    @Test("空标题/空路径被拒")
    func emptyFields() {
        guard case .failure(.emptyTitle) =
                GameLibrary.save(into: GameMap(), draft: rec("  ")) else {
            Issue.record("空标题应该被拒"); return
        }
        guard case .failure(.emptyPath) =
                GameLibrary.save(into: GameMap(), draft: rec("A", "  ")) else {
            Issue.record("空路径应该被拒"); return
        }
    }

    /// 更新不存在的 id → 报错（不静默新建）。
    @Test("更新不存在的 id 报错")
    func updateNonexistent() {
        guard case .failure(.invalidId) =
                GameLibrary.save(into: GameMap(), draft: rec("A"), id: "99") else {
            Issue.record("应该报 invalidId"); return
        }
    }

    /// ⚠️ 更新时**保留旧记录的未知字段**（D10 双向兼容）。
    /// 守的是：用户从 Electron 版带过来的字段不能被 Swift 版抹掉。
    @Test("更新保留未知字段")
    func updatePreservesUnknown() throws {
        var map = GameMap()
        var old = rec("A")
        old.unknownFields = ["legacyFlag": .bool(true), "futureField": .string("x")]
        let r = try GameLibrary.save(into: map, draft: old).get()
        map = r.map

        // 更新时 draft 没有 unknownFields → 应继承旧的
        var draft = rec("A")
        draft.gameEngine = "mkxpz"
        let updated = GameLibrary.save(into: map, draft: draft, id: "1")
        guard case .success(let result) = updated else {
            Issue.record("应该成功"); return
        }
        #expect(result.map.games["1"]?.unknownFields["legacyFlag"]?.boolValue == true)
        #expect(result.map.games["1"]?.unknownFields["futureField"]?.stringValue == "x")
    }

    /// 删除是幂等的。
    @Test("删除幂等")
    func removeIdempotent() throws {
        var map = GameMap()
        let r = try GameLibrary.save(into: map, draft: rec("A")).get()
        map = r.map

        map = GameLibrary.remove(from: map, id: "1")
        #expect(map.games.isEmpty)
        map = GameLibrary.remove(from: map, id: "1")   // 再来一次不崩
        #expect(map.games.isEmpty)
    }
}

// MARK: - 导入（识别）

@Suite("游戏导入识别")
struct GameImportTests {

    /// 正常的 MV 游戏：选 Game.exe 就能认出 nwjs。
    @Test("选 Game.exe 认出引擎")
    func detectsFromEntry() {
        let folder = "/games/苍蓝星"
        let fake = FakeFS([
            "\(folder)/Game.exe",
            "\(folder)/nw.dll",
            "\(folder)/package.json",
        ])
        let result = GameImport.inspect(selectedPath: "\(folder)/Game.exe", fileExists: fake.exists)
        #expect(result.engine?.folder == "nwjs")
        #expect(result.resolvedFolder == folder)
        #expect(result.ascendLevel == 0, "直接选中文件就认出来了，不该上退")
    }

    /// ⚠️ **用户选错文件时的兜底**（选 readme 也要能找到游戏）。
    /// 守的是：用户从 Finder 里随便点一个文件拖进来就能用。
    @Test("选 readme 也能反推出游戏目录")
    func detectsFromWrongFile() {
        let folder = "/games/MyGame"
        let fake = FakeFS([
            "\(folder)/readme.txt",
            "\(folder)/nw.dll",
            "\(folder)/package.json",
        ])
        // 选的是 readme（level 0/1 都认不出：level0 因为 gameDirForFiles 退到父目录后
        // 会去试 MyGame/，其实 level0 传的 exe 是 readme.txt 本身，
        // gameDirForFiles(readme.txt) = MyGame → 能认出）
        let result = GameImport.inspect(
            selectedPath: "\(folder)/readme.txt", fileExists: fake.exists)
        #expect(result.engine?.folder == "nwjs")
        #expect(result.resolvedFolder == folder)
    }

    /// 认不出时 engine 为 nil（**不猜**，由 UI 让用户手选）。
    @Test("认不出返回 nil")
    func unknownEngine() {
        let folder = "/games/Mystery"
        let fake = FakeFS(["\(folder)/a.bin", "\(folder)/b.dat"])
        let result = GameImport.inspect(
            selectedPath: "\(folder)/a.bin", fileExists: fake.exists)
        #expect(result.engine == nil, "认不出就该是 nil，不能猜")
        #expect(result.resolvedFolder == folder)
    }

    /// Ren'Py 的入口在子目录（`游戏名/game/script.rpy`）→ 要上退到 `游戏名/`。
    @Test("RenPy 子目录入口要上退")
    func renpySubdir() {
        let root = "/games/RenpyGame"
        let fake = FakeFS([
            "\(root)/game/script.rpy",
            "\(root)/renpy",
            "\(root)/RenpyGame.sh",
        ])
        // 选 game/script.rpy：
        //   level 0: gameDirForFiles = /games/RenpyGame/game → 里面没有 renpy/ → 认不出
        //   level 1: /games/RenpyGame/game （同上）
        //   level 2: /games/RenpyGame → 有 renpy/ 和 .sh → 认出 renpy
        let result = GameImport.inspect(
            selectedPath: "\(root)/game/script.rpy", fileExists: fake.exists)
        #expect(result.engine?.folder == "renpy", "应该上退到游戏根才认得出")
        #expect(result.resolvedFolder == root)
    }
}

// MARK: - 假文件系统

// ⚠️ `FakeFS` 已在 P1 的测试文件里定义（`P1EngineTests.swift`）。
//    同一个 test target 里不能重复声明，这里直接用那个。
