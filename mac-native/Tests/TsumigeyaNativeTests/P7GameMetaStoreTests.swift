// 游戏元数据读写测试。
//
// ===== 本文件最重要的一条：改元数据不能抹掉分类 =====
//
// `library-meta.json` 是同一份文件装着两样东西：
//   · 游戏元数据（键 = 数字 gameId）
//   · 分类（键 = categories / assignments，**非数字**）
//
// 保存是**整体覆写**。写游戏元数据时漏了「带回非数字键」
// 就等于「改一次 DLsite 信息，用户的分类全没了」。
//
// 这是 S7 实施时踩到的真 bug（Electron 版有回归测试）。
import Foundation
import Testing

@testable import TsumigeyaCore

@Suite("游戏元数据读写")
struct GameMetaStoreTests {

    /// 造一个**唯一**的临时数据目录。
    ///
    /// ⚠️⚠️ **不能用固定路径**（本鱼实测踩到）。
    ///
    ///    Swift Testing 的测试**默认并行执行**，而同一批测试用同一个固定目录
    ///    （`.../meta-store`）会互相覆盖：
    ///      · 测试 A 刚写 `gameId 1`，测试 B 的 `defer` 就把整个目录删了
    ///      · 表现是**随机几条失败**，重跑可能又过
    ///
    ///    ⚠️ 这与「DlsiteService 的缓存目录」那条是同一类：
    ///       固定共享资源 + 并行 = 间歇性失败。间歇性失败比稳定失败更糟
    ///       （本鱼会以为是别的原因，重跑一次又过了，然后当没事）。
    func makeDataDir() -> String {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("meta-store-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.path
    }

    func sampleMeta(title: String = "测试作品") -> GameDlsiteMeta {
        GameDlsiteMeta(
            work: DlsiteWork(
                rj: "RJ294126", title: title, circle: "社团",
                coverUrl: "https://img.dlsite.jp/a.jpg",
                workType: "SOU", ageRating: "r18",
                description: "简介", fetchedAt: "2026-11-06T00:00:00Z"),
            editedFields: [])
    }

    /// 基本往返。
    @Test("读写往返")
    func roundtrip() throws {
        let dataDir = makeDataDir()
        defer { try? FileManager.default.removeItem(atPath: dataDir) }

        let meta = sampleMeta()
        #expect(GameMetaStore.save(dataDir: dataDir, gameId: "1", meta: meta) == nil)

        let loaded = try #require(GameMetaStore.load(dataDir: dataDir, gameId: "1"))
        #expect(loaded.work.rj == "RJ294126")
        #expect(loaded.work.title == "测试作品")
        #expect(loaded.work.coverUrl == "https://img.dlsite.jp/a.jpg")
    }

    /// ⚠️⚠️ **本文件最重要的一条**：保存元数据时分类必须还在。
    ///
    /// 守的是：一次改 DLsite 信息就把用户的分类全抹了（S7 的真 bug）。
    @Test("不抹掉分类")
    func doesNotWipeCategories() throws {
        let dataDir = makeDataDir()
        defer { try? FileManager.default.removeItem(atPath: dataDir) }

        // 先放一份带分类的文件
        let initial: [String: JSONValue] = [
            "1": .object([
                "dlsite": .object(["rj": .string("RJ111111")]),
            ]),
            "categories": .object([
                "cat-a": .object(["name": .string("动作类"), "order": .int(0)]),
            ]),
            "assignments": .object([
                "1": .array([.string("cat-a")]),
            ]),
        ]
        let url = URL(fileURLWithPath: dataDir)
            .appendingPathComponent("library-meta.json")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted]
        try encoder.encode(initial).write(to: url)

        // 改元数据
        #expect(GameMetaStore.save(
            dataDir: dataDir, gameId: "1", meta: sampleMeta()) == nil)

        // 读回来：分类必须还在
        let raw = GameMetaStore.readRaw(dataDir: dataDir)
        #expect(raw["categories"] != nil, "分类被抹掉了！")
        #expect(raw["assignments"] != nil, "分类归属被抹掉了！")

        let categories = try #require(raw["categories"]?.objectValue)
        #expect(categories["cat-a"] != nil)
        let catDef = try #require(categories["cat-a"]?.objectValue)
        #expect(catDef["name"]?.stringValue == "动作类")

        // 元数据也更新了
        #expect(raw["1"]?.objectValue?["dlsite"]?.objectValue?["rj"]?.stringValue
                == "RJ294126")
    }

    /// 多条游戏的元数据互不影响。
    @Test("多游戏独立")
    func multipleGames() throws {
        let dataDir = makeDataDir()
        defer { try? FileManager.default.removeItem(atPath: dataDir) }

        #expect(GameMetaStore.save(
            dataDir: dataDir, gameId: "1", meta: sampleMeta(title: "作品A")) == nil)
        #expect(GameMetaStore.save(
            dataDir: dataDir, gameId: "2", meta: sampleMeta(title: "作品B")) == nil)

        #expect(GameMetaStore.load(dataDir: dataDir, gameId: "1")?.work.title == "作品A")
        #expect(GameMetaStore.load(dataDir: dataDir, gameId: "2")?.work.title == "作品B")
    }

    /// 删一部游戏的元数据，不影响其他游戏与分类。
    @Test("删除单条")
    func removeOne() throws {
        let dataDir = makeDataDir()
        defer { try? FileManager.default.removeItem(atPath: dataDir) }

        _ = GameMetaStore.save(dataDir: dataDir, gameId: "1", meta: sampleMeta())
        _ = GameMetaStore.save(dataDir: dataDir, gameId: "2", meta: sampleMeta())
        GameMetaStore.remove(dataDir: dataDir, gameId: "1")

        #expect(GameMetaStore.load(dataDir: dataDir, gameId: "1") == nil)
        #expect(GameMetaStore.load(dataDir: dataDir, gameId: "2") != nil)
    }

    /// 没有元数据时返回 nil（不猜）。
    @Test("没有元数据")
    func missing() throws {
        let dataDir = makeDataDir()
        defer { try? FileManager.default.removeItem(atPath: dataDir) }
        #expect(GameMetaStore.load(dataDir: dataDir, gameId: "1") == nil)
    }

    /// 文件损坏时不崩（返回 nil）。
    @Test("损坏文件")
    func corrupt() throws {
        let dataDir = makeDataDir()
        defer { try? FileManager.default.removeItem(atPath: dataDir) }

        let url = URL(fileURLWithPath: dataDir)
            .appendingPathComponent("library-meta.json")
        try "{ 坏 json".write(to: url, atomically: true, encoding: .utf8)

        #expect(GameMetaStore.load(dataDir: dataDir, gameId: "1") == nil)
    }

    /// `editedFields` 往返。
    @Test("editedFields 往返")
    func editedFieldsRoundtrip() throws {
        let dataDir = makeDataDir()
        defer { try? FileManager.default.removeItem(atPath: dataDir) }

        let meta = GameDlsiteMeta(
            work: DlsiteWork(rj: "RJ294126", title: "用户改的", fetchedAt: "t"),
            editedFields: ["title"])
        #expect(GameMetaStore.save(dataDir: dataDir, gameId: "1", meta: meta) == nil)

        let loaded = try #require(GameMetaStore.load(dataDir: dataDir, gameId: "1"))
        #expect(loaded.editedFields == ["title"])
    }
}
