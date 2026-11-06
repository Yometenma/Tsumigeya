// 元数据编辑测试（D26：手改的值刷新时不覆盖）。
import Foundation
import Testing

@testable import TsumigeyaCore

@Suite("元数据编辑与保护")
struct GameMetaEditTests {

    func makeDataDir() -> String {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("meta-edit-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.path
    }

    func sample(title: String = "DLsite 原标题", circle: String = "DLsite 原社团") -> GameDlsiteMeta {
        GameDlsiteMeta(
            work: DlsiteWork(
                rj: "RJ331590", title: title, circle: circle,
                coverUrl: "https://img.dlsite.jp/a.jpg",
                description: "DLsite 原简介", fetchedAt: "t"),
            editedFields: [])
    }

    /// 基本读写。
    @Test("保存并读回")
    func saveAndLoad() throws {
        let dir = makeDataDir()
        defer { try? FileManager.default.removeItem(atPath: dir) }

        _ = GameMetaStore.save(dataDir: dir, gameId: "1", meta: sample())
        let loaded = try #require(GameMetaStore.load(dataDir: dir, gameId: "1"))
        #expect(loaded.work.title == "DLsite 原标题")
    }

    /// ⚠️⚠️ **本文件最重要的一条**：手改过的字段刷新时**不覆盖**（D26）。
    ///
    /// 守的是：用户把标题改成自己认得的中文名，下次点「刷新」时
    /// 被 DLsite 的日文原名盖回去 —— 而他会以为「软件不保存我的修改」。
    @Test("手改的字段刷新不覆盖")
    func editedFieldsSurviveRefresh() throws {
        let dir = makeDataDir()
        defer { try? FileManager.default.removeItem(atPath: dir) }

        // ① 用户手改了标题
        var meta = sample()
        meta.work.title = "我改的中文名"
        meta.editedFields = ["title"]
        _ = GameMetaStore.save(dataDir: dir, gameId: "1", meta: meta)

        // ② 刷新（从 DLsite 拿到新数据）
        let refreshed = sample(title: "DLsite 更新后的标题")
        let merged = EditedFields.merge(
            old: meta.work, incoming: refreshed.work, edited: Set(meta.editedFields))

        #expect(merged.title == "我改的中文名", "手改的标题被覆盖了")
        // 没改的字段会更新
        #expect(merged.circle == "DLsite 原社团")
    }

    /// 没改过的字段正常更新。
    @Test("没改的字段更新")
    func uneditedFieldsUpdate() throws {
        let dir = makeDataDir()
        defer { try? FileManager.default.removeItem(atPath: dir) }

        let meta = sample()
        let refreshed = GameDlsiteMeta(
            work: DlsiteWork(rj: "RJ331590", title: "新标题",
                             circle: "新社团", fetchedAt: "t2"),
            editedFields: [])
        let merged = EditedFields.merge(
            old: meta.work, incoming: refreshed.work, edited: [])

        #expect(merged.title == "新标题")
        #expect(merged.circle == "新社团")
    }

    /// ⚠️ **RJ 永远不可编辑**（D25）。
    @Test("rj 不在可编辑列表")
    func rjNotEditable() {
        let canEdit = EditedFields.editable.contains("rj")
        #expect(!canEdit, "rj 不该可编辑（改 RJ 等于换作品）")
    }

    /// 编辑元数据时**不能抹掉分类**（与 P6 那个 bug 同一类）。
    @Test("编辑元数据不抹掉分类")
    func preservesCategories() throws {
        let dir = makeDataDir()
        defer { try? FileManager.default.removeItem(atPath: dir) }

        // 先放一份带分类的文件
        let initial: [String: JSONValue] = [
            "1": .object(["dlsite": .object(["rj": .string("RJ111111")])]),
            "categories": .object([
                "cat-a": .object(["name": .string("动作类"), "order": .int(0)]),
            ]),
            "assignments": .object(["1": .array([.string("cat-a")])]),
        ]
        let url = URL(fileURLWithPath: dir).appendingPathComponent("library-meta.json")
        try JSONEncoder().encode(initial).write(to: url)

        // 改元数据
        _ = GameMetaStore.save(dataDir: dir, gameId: "1", meta: sample())

        let raw = GameMetaStore.readRaw(dataDir: dir)
        #expect(raw["categories"] != nil, "分类被抹掉了")
        #expect(raw["assignments"] != nil, "分类归属被抹掉了")
    }

    /// 多个字段同时被改。
    @Test("多字段保护")
    func multipleEditedFields() {
        let old = DlsiteWork(
            rj: "RJ1", title: "改标题", circle: "改社团",
            description: "改简介", fetchedAt: "t")
        let incoming = DlsiteWork(
            rj: "RJ1", title: "新标题", circle: "新社团",
            description: "新简介", fetchedAt: "t2")
        let merged = EditedFields.merge(
            old: old, incoming: incoming,
            edited: ["title", "circle", "description"])

        #expect(merged.title == "改标题")
        #expect(merged.circle == "改社团")
        #expect(merged.description == "改简介")
    }

    /// 只改一个，其他更新。
    @Test("部分保护")
    func partialProtection() {
        let old = DlsiteWork(
            rj: "RJ1", title: "改标题", circle: "旧社团", fetchedAt: "t")
        let incoming = DlsiteWork(
            rj: "RJ1", title: "新标题", circle: "新社团", fetchedAt: "t2")
        let merged = EditedFields.merge(old: old, incoming: incoming, edited: ["title"])

        #expect(merged.title == "改标题", "改过的保留")
        #expect(merged.circle == "新社团", "没改的更新")
    }
}
