// P0 单元测试。
//
// 对应 Electron 版：test/data-dir.test.ts / test/games-store 相关
//
// 移植原则（方案 §4）：**不是抄代码，是按判据重新实现一遍**。
// 每条测试都写清「它在守什么」，这样以后改实现时知道哪条不能动。
import Foundation
import Testing

@testable import TsumigeyaCore

// MARK: - 数据目录

@Suite("数据目录")
struct DataDirTests {

    /// 环境变量优先（开发隔离）。
    /// 守的是：`TSUMIGEYA_DATA_DIR` 一旦给了，就必须用它——否则开发时会写到真实数据目录里。
    @Test("环境变量优先")
    func envWins() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: tmp) }

        let result = DataDir.resolve(
            environment: ["TSUMIGEYA_DATA_DIR": tmp.path],
            homeDirectory: URL(fileURLWithPath: "/Users/nobody")
        )
        #expect(result.source == .environment)
        #expect(result.path == tmp.path)
        #expect(result.warning == nil)
    }

    /// 没有环境变量时走 mac 默认路径。
    /// 守的是 D58：数据目录必须是 `~/Library/Application Support/Tsumigeya`。
    @Test("默认路径是 ~/Library/Application Support/Tsumigeya")
    func defaultPath() throws {
        let home = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-home-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: home) }

        let result = DataDir.resolve(environment: [:], homeDirectory: home)
        #expect(result.source == .userDefault)
        #expect(result.path.hasSuffix("Library/Application Support/Tsumigeya"))
        #expect(result.warning == nil)

        // 目录真的建出来了
        var isDir: ObjCBool = false
        #expect(FileManager.default.fileExists(atPath: result.path, isDirectory: &isDir))
        #expect(isDir.boolValue)
    }

    /// 波浪号展开。
    /// 守的是：用户写 `~/xxx` 时要真的展开，不然会建出一个名叫 `~` 的目录。
    @Test("环境变量里的 ~ 会展开")
    func tildeExpansion() throws {
        let result = DataDir.resolve(
            environment: ["TSUMIGEYA_DATA_DIR": "~/tsmg-tilde-\(UUID().uuidString)"],
            homeDirectory: FileManager.default.homeDirectoryForCurrentUser
        )
        #expect(!result.path.contains("~"))
        #expect(result.warning == nil)
        try? FileManager.default.removeItem(atPath: result.path)
    }
}

// MARK: - JSON 原子写

@Suite("JSON 存储")
struct JSONStoreTests {

    struct Payload: Codable, Sendable, Equatable {
        var name: String
        var count: Int
    }

    /// 正常往返。
    @Test("读写往返一致")
    func roundtrip() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-json-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: tmp) }

        let original = Payload(name: "蒼藍星", count: 3)
        let err = JSONStore.save(original, to: tmp)
        #expect(err == nil)

        guard case .loaded(let loaded) = JSONStore.load(Payload.self, from: tmp) else {
            Issue.record("读不出来")
            return
        }
        #expect(loaded == original)
    }

    /// 中文不转义。
    /// 守的是：这些 JSON 是用户会打开看的数据文件（全中文/日文游戏名），
    /// `\u65e5` 那种形式人眼没法读，也没法手动修。
    @Test("中文不转义成 \\uXXXX")
    func noUnicodeEscaping() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-cjk-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: tmp) }

        _ = JSONStore.save(Payload(name: "傭兵の冒険", count: 1), to: tmp)
        let text = try String(contentsOf: tmp, encoding: .utf8)
        #expect(text.contains("傭兵の冒険"))
        #expect(!text.contains("\\u"))
    }

    /// 文件不存在 → `.missing`（正常状态，不是错误）。
    /// 守的是：首次运行就读不到文件，这时**不能**报错（那会让用户以为程序坏了）。
    @Test("文件不存在返回 missing 而不是错误")
    func missingIsNormal() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-none-\(UUID().uuidString).json")
        #expect(JSONStore.load(Payload.self, from: tmp) == .missing)
    }

    /// 空文件 → `.missing`（与「乱码」是两种处境）。
    @Test("空文件当没有内容")
    func emptyFileIsMissing() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-empty-\(UUID().uuidString).json")
        try Data().write(to: tmp)
        defer { try? FileManager.default.removeItem(at: tmp) }
        #expect(JSONStore.load(Payload.self, from: tmp) == .missing)
    }

    /// 坏 JSON → `.corrupt` 且**改名保留**，绝不静默删除。
    /// ⚠️ 守的是「用户的数据可能只是格式错了，他还有机会拿回来」。
    @Test("坏文件改名保留，不删除")
    func corruptQuarantined() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-bad-\(UUID().uuidString).json")
        try "{ not json".write(to: tmp, atomically: true, encoding: .utf8)
        defer {
            try? FileManager.default.removeItem(at: tmp)
            // 清理改名产物
            let dir = tmp.deletingLastPathComponent()
            if let items = try? FileManager.default.contentsOfDirectory(atPath: dir.path) {
                for name in items where name.hasPrefix(tmp.deletingPathExtension().lastPathComponent) {
                    try? FileManager.default.removeItem(at: dir.appendingPathComponent(name))
                }
            }
        }

        guard case .corrupt(let failure) = JSONStore.load(Payload.self, from: tmp) else {
            Issue.record("本该判损坏")
            return
        }
        #expect(failure.backupPath != nil)
        #expect(FileManager.default.fileExists(atPath: failure.backupPath!))
    }

    /// 写入会留下 `.bak`。
    /// 守的是：rename 保住了「不半截」，但保不住「写进去的是坏数据」，还需要回退点。
    @Test("第二次写入会生成 .bak 备份")
    func createsBackup() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-bak-\(UUID().uuidString).json")
        let bak = tmp.appendingPathExtension("bak")
        defer {
            try? FileManager.default.removeItem(at: tmp)
            try? FileManager.default.removeItem(at: bak)
        }

        _ = JSONStore.save(Payload(name: "first", count: 1), to: tmp)
        #expect(!FileManager.default.fileExists(atPath: bak.path))

        _ = JSONStore.save(Payload(name: "second", count: 2), to: tmp)
        #expect(FileManager.default.fileExists(atPath: bak.path))

        // .bak 里是**旧**内容（顺序不能反，见 JSONStore 文件头）
        guard case .loaded(let fromBak) = JSONStore.load(Payload.self, from: bak) else {
            Issue.record(".bak 读不出来")
            return
        }
        #expect(fromBak.name == "first")
    }

    /// 写完之后不能残留 .tmp。
    @Test("写完不留 .tmp")
    func noTmpLeftover() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-tmp-\(UUID().uuidString).json")
        let tmpFile = tmp.appendingPathExtension("tmp")
        defer {
            try? FileManager.default.removeItem(at: tmp)
        }
        _ = JSONStore.save(Payload(name: "x", count: 1), to: tmp)
        #expect(!FileManager.default.fileExists(atPath: tmpFile.path))
    }
}

// MARK: - JSONValue

@Suite("JSONValue")
struct JSONValueTests {

    /// `3` 必须保持 Int，不能变 `3.0`。
    /// 守的是：gameArgs 里有整型字段，写回成 `3.0` 会让用户的 diff 变脏。
    @Test("整数保持 Int，不变 Double")
    func intStaysInt() throws {
        let json = #"{"n":3,"f":3.5}"#.data(using: .utf8)!
        let obj = try JSONDecoder().decode([String: JSONValue].self, from: json)
        #expect(obj["n"]?.intValue == 3)
        if case .int = obj["n"]! {
        } else {
            Issue.record("3 被解成了非 Int")
        }
        #expect(obj["f"]?.doubleValue == 3.5)
    }

    /// 往返不改变类型。
    @Test("往返保持类型")
    func roundtripPreservesType() throws {
        let original = JSONValue.object([
            "a": .int(1),
            "b": .double(2.5),
            "c": .string("蒼藍星"),
            "d": .bool(true),
            "e": .null,
            "f": .array([.int(1), .string("x")]),
        ])
        let data = try JSONEncoder().encode(original)
        let back = try JSONDecoder().decode(JSONValue.self, from: data)
        #expect(back == original)
    }

    /// 「只认显式 false」的开关语义。
    @Test("缺省当开，只有显式 false 才算关")
    func boolOrDefaultTrue() throws {
        #expect(JSONValue.bool(false).boolOrDefaultTrue == false)
        #expect(JSONValue.bool(true).boolOrDefaultTrue == true)
        #expect(JSONValue.string("x").boolOrDefaultTrue == true)   // 读不出来也当开
        #expect(JSONValue.null.boolOrDefaultTrue == true)
    }
}

// MARK: - 游戏记录

@Suite("游戏记录")
struct GameRecordTests {

    /// 未知字段必须保留（D10 + 上游兼容）。
    /// ⚠️ 守的是：Swift 的 Codable 默认忽略未知字段 = **静默丢数据**。
    /// 磁盘上有、本版本不认识的键，写回时必须带回去 —— 否则 Electron 版写的字段会被抹掉。
    @Test("未知字段读进来又写回去")
    func preservesUnknownFields() throws {
        let json = """
        {
          "1": {
            "gameTitle": "蒼藍星",
            "gamePath": "/Users/x/games/苍蓝星/Game.exe",
            "gameEngine": "nwjs",
            "someFutureField": {"nested": 42},
            "legacyFlag": true
          }
        }
        """.data(using: .utf8)!

        let map = try JSONDecoder().decode(GameMap.self, from: json)
        let game = map.games["1"]!
        #expect(game.gameTitle == "蒼藍星")
        #expect(game.id == "1")
        #expect(game.unknownFields["someFutureField"] != nil)
        #expect(game.unknownFields["legacyFlag"]?.boolValue == true)

        // 写回后未知字段还在
        let out = try JSONEncoder().encode(map)
        let obj = try JSONDecoder().decode([String: [String: JSONValue]].self, from: out)
        #expect(obj["1"]?["someFutureField"] != nil)
        #expect(obj["1"]?["legacyFlag"]?.boolValue == true)
    }

    /// id 来自 map 的键，不在记录内部（D10）。
    @Test("id 来自 map 的键")
    func idFromKey() throws {
        let json = #"{"7":{"gameTitle":"x","gamePath":"/p","gameEngine":"nwjs"}}"#
            .data(using: .utf8)!
        let map = try JSONDecoder().decode(GameMap.self, from: json)
        #expect(map.games["7"]?.id == "7")
    }

    /// 按 id **数值**排序（不是字符串）。
    /// 守的是：id 是 "1" "2" "10"，字符串排序会把 10 排到 2 前面。
    @Test("按 id 数值排序")
    func ordersNumerically() throws {
        var map = GameMap()
        for id in ["10", "2", "1"] {
            map.games[id] = GameRecord(
                id: id, gameTitle: "t\(id)", gamePath: "/p", gameEngine: "nwjs")
        }
        #expect(map.ordered.map(\.id) == ["1", "2", "10"])
    }

    /// gameArgs 的形状不定，但读写不能变。
    @Test("gameArgs 任意结构往返一致")
    func gameArgsRoundtrip() throws {
        let record = GameRecord(
            id: "1", gameTitle: "x", gamePath: "/p", gameEngine: "nwjs",
            gameArgs: ["fullscreen": .bool(false), "version": .string("v0.106.1")]
        )
        var map = GameMap()
        map.games["1"] = record

        let data = try JSONEncoder().encode(map)
        let back = try JSONDecoder().decode(GameMap.self, from: data)
        #expect(back.games["1"]?.gameArgs == record.gameArgs)
    }
}
