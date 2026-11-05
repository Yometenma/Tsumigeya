// 分类的纯逻辑测试。
//
// 对应 Electron 版：`test/categories.test.ts`（46 条）+ `test/category-ipc.test.ts`
//
// ===== 本文件守的三条「错了不报错、只是数据慢慢变脏」=====
//
// ① 删分类必须**同时**从所有归属里摘掉那个 id（否则留下悬空引用）
// ② 重命名**只改 name、id 不动**（改 id = 全库归属全丢）
// ③ 新建必须查重 + 生成**真正唯一**的 id（撞了 = 两个分类静默合并）
import Foundation
import Testing

@testable import TsumigeyaCore

// MARK: - 名字处理

@Suite("分类名字")
struct CategoryNameTests {

    /// 去首尾空白 + 压连续空白成一个空格。
    /// 守的是：`"我的 分类"` 与 `"我的   分类"` 查重时应算同一个。
    @Test("归一化压连续空白")
    func normalizeWhitespace() {
        #expect(Categories.normalizeName("  动作类  ") == "动作类")
        #expect(Categories.normalizeName("我的   分类") == "我的 分类")
        #expect(Categories.normalizeName("a\t\tb") == "a b")
        #expect(Categories.normalizeName(nil) == "")
        #expect(Categories.normalizeName("") == "")
    }

    /// ⚠️ **不改大小写**：英文名用户可能刻意保留大写。
    @Test("不改大小写")
    func preservesCase() {
        #expect(Categories.normalizeName("RPG") == "RPG")
        #expect(Categories.normalizeName("Rpg") == "Rpg")
    }

    @Test("名字校验")
    func validation() {
        #expect(Categories.validateName("") == .empty)
        #expect(Categories.validateName("   ") == .empty)
        #expect(Categories.validateName(nil) == .empty)
        #expect(Categories.validateName("动作类") == nil)
        // 24 字以内 OK
        #expect(Categories.validateName(String(repeating: "a", count: 24)) == nil)
        // 25 字超长
        #expect(Categories.validateName(String(repeating: "a", count: 25)) == .tooLong)
        // ⚠️ 中文按**字数**算，不是字节数
        #expect(Categories.validateName(String(repeating: "動", count: 24)) == nil)
    }

    /// 查重**大小写不敏感**（显示保留原样）。
    @Test("查重大小写不敏感")
    func duplicateCaseInsensitive() {
        let defs: CategoryDefs = ["rpg": CategoryDef(name: "RPG", order: 1)]
        #expect(Categories.isDuplicateName(defs, raw: "rpg"))
        #expect(Categories.isDuplicateName(defs, raw: "RPG"))
        #expect(Categories.isDuplicateName(defs, raw: "Rpg"))
        #expect(!Categories.isDuplicateName(defs, raw: "ACT"))
        // 重命名自己不该和自己冲突
        #expect(!Categories.isDuplicateName(defs, raw: "RPG", excludeId: "rpg"))
    }
}

// MARK: - slug

@Suite("分类 slug")
struct CategorySlugTests {

    /// 只取 ASCII 字母数字，其余当分隔符。
    @Test("从名字生成 slug")
    func slugify() {
        #expect(Categories.slugify("RPG Maker") == "rpg-maker")
        // 中文全被剥掉 → 走兜底 cat
        #expect(Categories.slugify("动作类") == "cat")
        #expect(Categories.slugify("我的 RPG") == "rpg")
        #expect(Categories.slugify("") == "cat")
        // 不产生空串（空 id 会被当「未分类」误伤）
        #expect(Categories.slugify("!!!") == "cat")
        #expect(!Categories.slugify("@@@").isEmpty)
    }

    /// ⚠️ 唯一性：撞了要追加 -2 / -3，**绝不能返回已存在的 id**。
    /// 守的是：两个分类静默合并 → 用户的归属数据当场错乱。
    @Test("生成的 id 一定唯一")
    func uniqueId() {
        var defs: CategoryDefs = [:]
        let id1 = Categories.uniqueId(defs, raw: "RPG")
        #expect(id1 == "rpg")
        defs[id1] = CategoryDef(name: "RPG", order: 1)

        let id2 = Categories.uniqueId(defs, raw: "RPG")
        #expect(id2 == "rpg-2")
        defs[id2] = CategoryDef(name: "RPG", order: 2)

        let id3 = Categories.uniqueId(defs, raw: "RPG")
        #expect(id3 == "rpg-3")
        // 三个 id 全不同
        #expect(Set([id1, id2, id3]).count == 3)
    }

    /// 中文名的两个分类都走 `cat` 兜底，但 id 仍必须唯一。
    @Test("中文名兜底后仍唯一")
    func chineseFallbackUnique() {
        var defs: CategoryDefs = [:]
        let id1 = Categories.uniqueId(defs, raw: "动作类")
        defs[id1] = CategoryDef(name: "动作类", order: 1)
        let id2 = Categories.uniqueId(defs, raw: "角色扮演")
        // 两个都是 cat 系，但不能撞
        #expect(id1 != id2)
        #expect(id2.hasPrefix("cat"))
    }
}

// MARK: - 增删改

@Suite("分类增删改")
struct CategoryMutationTests {

    @Test("新建")
    func create() {
        let result = Categories.create([:], name: "动作类")
        #expect(result != nil)
        #expect(result?.defs.count == 1)
        let def = result?.defs[result!.id]
        #expect(def?.name == "动作类")
        #expect(def?.order == 1)
    }

    /// 重复名字建不出来（返回 nil 让 UI 提示）。
    @Test("重复名字建不出来")
    func createDuplicate() {
        let defs: CategoryDefs = ["rpg": CategoryDef(name: "RPG", order: 1)]
        #expect(Categories.create(defs, name: "RPG") == nil)
        #expect(Categories.create(defs, name: "rpg") == nil)   // 大小写不敏感
    }

    @Test("非法名字建不出来")
    func createInvalid() {
        #expect(Categories.create([:], name: "") == nil)
        #expect(Categories.create([:], name: "   ") == nil)
        #expect(Categories.create([:], name: String(repeating: "a", count: 30)) == nil)
    }

    /// order 递增（新建的排在后面）。
    @Test("order 递增")
    func orderIncrements() {
        var defs: CategoryDefs = [:]
        for (i, name) in ["A", "B", "C"].enumerated() {
            let r = Categories.create(defs, name: name)!
            defs = r.defs
            #expect(defs[r.id]?.order == i + 1)
        }
    }

    /// ⚠️ **重命名只改 name、id 不动** —— 改 id 等于把全库归属全丢了。
    @Test("重命名不改 id")
    func renameKeepsId() throws {
        var defs: CategoryDefs = ["rpg": CategoryDef(name: "RPG", order: 1)]
        let updated = try #require(Categories.rename(defs, id: "rpg", newName: "角色扮演"))
        #expect(updated["rpg"]?.name == "角色扮演")
        #expect(updated["rpg"] != nil, "id 必须还在")
        #expect(updated.count == defs.count, "不能多也不能少")
    }

    @Test("重命名到重复名字被拒")
    func renameDuplicate() {
        let defs: CategoryDefs = [
            "a": CategoryDef(name: "A", order: 1),
            "b": CategoryDef(name: "B", order: 2),
        ]
        #expect(Categories.rename(defs, id: "a", newName: "B") == nil)
        #expect(Categories.rename(defs, id: "a", newName: "b") == nil)   // 大小写不敏感
    }

    /// ⚠️ **删分类必须同时从所有归属里摘掉那个 id**。
    /// 守的是：只删 defs 会留下悬空引用 —— 筛选时显示一个不存在的分类，
    /// 点进去永远是空列表。
    @Test("删分类同时清掉归属")
    func removeCleansAssignments() {
        let defs: CategoryDefs = [
            "a": CategoryDef(name: "A", order: 1),
            "b": CategoryDef(name: "B", order: 2),
        ]
        let assignments: CategoryAssignments = [
            "1": ["a", "b"],
            "2": ["a"],
            "3": ["b"],
        ]
        let result = Categories.remove(defs, assignments: assignments, id: "a")

        #expect(result.defs.count == 1)
        #expect(result.defs["a"] == nil)
        // 游戏 1 还剩 b；游戏 2 没有归属了（键要被整个去掉）；游戏 3 不受影响
        #expect(result.assignments["1"] == ["b"])
        #expect(result.assignments["2"] == nil, "空的归属键要去掉")
        #expect(result.assignments["3"] == ["b"])
    }

    /// ⚠️ **删分类绝不删游戏**（D31 的精神：那是用户数据）。
    @Test("删分类不删游戏归属记录本身")
    func removeNeverDeletesGames() {
        let defs: CategoryDefs = ["a": CategoryDef(name: "A", order: 1)]
        let assignments: CategoryAssignments = ["1": ["a"], "2": ["a"]]
        let result = Categories.remove(defs, assignments: assignments, id: "a")
        // defs 空了，但 games 的归属键（空了会被去掉）—— 关键是**游戏本身还在 games.json 里**
        #expect(result.assignments.isEmpty)
        #expect(result.defs.isEmpty)
    }

    /// 归属的增删。
    @Test("设置归属")
    func setMembership() {
        var a: CategoryAssignments = [:]
        a = Categories.setMembership(a, gameId: "1", categoryId: "x", member: true)
        #expect(a["1"] == ["x"])

        // 幂等：再加一次不重复
        a = Categories.setMembership(a, gameId: "1", categoryId: "x", member: true)
        #expect(a["1"] == ["x"])

        // 多归属
        a = Categories.setMembership(a, gameId: "1", categoryId: "y", member: true)
        #expect(a["1"] == ["x", "y"])

        // 移出
        a = Categories.setMembership(a, gameId: "1", categoryId: "x", member: false)
        #expect(a["1"] == ["y"])

        // 全移出 → 键去掉
        a = Categories.setMembership(a, gameId: "1", categoryId: "y", member: false)
        #expect(a["1"] == nil)
    }
}

// MARK: - 排序

@Suite("分类排序")
struct CategoryOrderTests {

    /// 按 order 排序；同 order 时按 id（保证**稳定**）。
    /// 守的是：字典遍历顺序会让同样 order 的分类每次刷新换位置。
    @Test("按 order 排序且同 order 稳定")
    func ordering() {
        let defs: CategoryDefs = [
            "z": CategoryDef(name: "Z", order: 1),
            "a": CategoryDef(name: "A", order: 1),   // 同 order
            "m": CategoryDef(name: "M", order: 3),
        ]
        let ordered = Categories.ordered(defs)
        #expect(ordered.map(\.id) == ["a", "z", "m"], "同 order 按 id 排")
        #expect(ordered.map(\.def.name) == ["A", "Z", "M"])
    }
}

// MARK: - 存储（非数字键必须带回）

@Suite("分类存储")
struct LibraryMetaStoreTests {

    func makeTempDir() throws -> String {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-meta-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.path
    }

    /// ⚠️⚠️ **本文件最重要的一条**：保存分类时必须把**其他所有顶层键**原样带回。
    ///
    /// 守的是：`library-meta.json` 里除了分类还有**每个游戏的 DLsite 元数据**。
    /// 漏了「带回」= 用户改个分类名就把他的元数据全抹了。
    /// （S7 实施时踩到的真 bug。）
    @Test("保存分类保留其他顶层键（元数据不能被抹）")
    func preservesOtherKeys() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(atPath: dir) }

        // 模拟已有文件：分类 + 游戏元数据 + 别的未知键
        let raw: [String: JSONValue] = [
            "1": .object(["title": .string("蒼藍星"), "rj": .string("RJ123")]),
            "2": .object(["title": .string("Karryn")]),
            "someFutureKey": .string("keep me"),
            "categories": .null,
            "assignments": .null,
        ]
        let url = URL(fileURLWithPath: dir).appendingPathComponent(LibraryMetaStore.fileName)
        _ = JSONStore.save(JSONValue.object(raw), to: url)

        // 只加一个分类
        var meta = LibraryMeta()
        meta.categories = ["rpg": CategoryDef(name: "RPG", order: 1)]
        meta.assignments = ["1": ["rpg"]]

        let err = LibraryMetaStore.saveCategories(meta, dataDir: dir, raw: raw)
        #expect(err == nil, "保存不该失败")

        // 读回：游戏元数据与未知键都必须在
        let data = try Data(contentsOf: url)
        let back = try JSONDecoder().decode([String: JSONValue].self, from: data)

        #expect(back["1"]?.objectValue?["title"]?.stringValue == "蒼藍星", "游戏元数据不能被抹")
        #expect(back["2"] != nil, "第二个游戏也不能丢")
        #expect(back["someFutureKey"]?.stringValue == "keep me", "未知键必须带回")
        // 分类写进去了
        #expect(back["categories"]?.objectValue?["rpg"]?.objectValue?["name"]?.stringValue == "RPG")
        #expect(back["assignments"]?.objectValue?["1"]?.arrayValue?.count == 1)
    }

    /// 读：数字键当游戏、categories/assignments 单独取。
    /// 守的是：`load()` 不按「键是纯数字」过滤的话，`categories` 会被当成一个游戏。
    @Test("读时区分游戏键与分类键")
    func loadDistinguishesKeys() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(atPath: dir) }

        let raw: [String: JSONValue] = [
            "1": .object(["title": .string("A")]),
            "categories": .object([
                "rpg": .object(["name": .string("RPG"), "order": .int(1)]),
            ]),
            "assignments": .object([
                "1": .array([.string("rpg")]),
            ]),
        ]
        let url = URL(fileURLWithPath: dir).appendingPathComponent(LibraryMetaStore.fileName)
        _ = JSONStore.save(JSONValue.object(raw), to: url)

        let loaded = LibraryMetaStore.load(dataDir: dir)
        #expect(loaded.meta.categories.count == 1)
        #expect(loaded.meta.categories["rpg"]?.name == "RPG")
        #expect(loaded.meta.assignments["1"] == ["rpg"])
        // raw 要保留全部键（写回时用）
        #expect(loaded.raw["1"] != nil)
        #expect(loaded.raw["categories"] != nil)
    }

    /// 文件不存在 → 空（正常状态，首次运行就是这样）。
    @Test("没有文件时返回空")
    func missingIsEmpty() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(atPath: dir) }
        let loaded = LibraryMetaStore.load(dataDir: dir)
        #expect(loaded.meta.categories.isEmpty)
        #expect(loaded.meta.assignments.isEmpty)
    }
}
