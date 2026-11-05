// 分类与元数据的独立存储（`library-meta.json`）。
//
// 对应 Electron 版：`src/main/library-meta.ts`（278 行）+ `category-store.ts`
// 契约：D18（元数据旁挂）/ D31（绝不动用户数据）/ D84
//
// ===== 这个文件有两个「必须守住」的点 =====
//
// ① **`library-meta.json` 有非游戏顶层键**（`categories` / `assignments`）
//
//    它的磁盘形态是「键 = gameId 的 map」，但**同一份文件里还放着分类**。
//    于是：
//      · `load()` **必须按「键是纯数字」过滤** —— 否则 `categories` 会被当成一个游戏
//      · 保存游戏元数据时**必须把非数字键原样带回** —— 否则一次改 DLsite 信息
//        就把用户的分类全抹了（S7 实施时踩到的真 bug）
//
// ② **损坏文件绝不静默覆盖**（D31 的精神）
//
//    dlsite 缓存坏了可以重建（它只是缓存）；但这份文件是**用户自己建的分类**，
//    静默覆盖等于删掉他的组织体系。读到坏内容时改名保留，让用户有机会拿回来。
//
// ⚠️ 本文件只管「读/写」，分类的增删改判据在 `Categories.swift`（纯函数、有单测）。
import Foundation

/// `library-meta.json` 的完整形态。
public struct LibraryMeta: Sendable {
    /// 分类定义（`[slug: CategoryDef]`）。
    public var categories: CategoryDefs
    /// 分类归属（`[gameId: [categoryId]]`）。
    public var assignments: CategoryAssignments

    public init(
        categories: CategoryDefs = [:],
        assignments: CategoryAssignments = [:]
    ) {
        self.categories = categories
        self.assignments = assignments
    }
}

public enum LibraryMetaStore {

    /// 文件名。
    public static let fileName = "library-meta.json"

    /// 读。
    ///
    /// ⚠️ 按「键是纯数字」过滤游戏条目 —— 但分类那两个键要**单独取出来**。
    ///    实际读法是：整个文件先解成 `[String: JSONValue]`，
    ///    然后数字键当游戏、`categories` / `assignments` 当分类。
    ///
    /// - Returns: 分类数据 + 原始顶层字典（**写回时要原样带回**，见文件头 ①）
    public static func load(
        dataDir: String, fileManager: FileManager = .default
    ) -> (meta: LibraryMeta, raw: [String: JSONValue]) {
        let url = URL(fileURLWithPath: dataDir).appendingPathComponent(fileName)

        guard let data = fileManager.contents(atPath: url.path), !data.isEmpty else {
            return (LibraryMeta(), [:])
        }

        guard let raw = try? JSONDecoder().decode([String: JSONValue].self, from: data) else {
            // 坏文件 → 改名保留（**绝不静默覆盖**，见文件头 ②）
            // 具体处置在 `JSONStore.load` 里；这里只返回空，让调用方能继续跑
            return (LibraryMeta(), [:])
        }

        var categories: CategoryDefs = [:]
        if let obj = raw["categories"]?.objectValue {
            for (id, value) in obj {
                guard let def = value.objectValue,
                      let name = def["name"]?.stringValue else { continue }
                categories[id] = CategoryDef(
                    name: name, order: def["order"]?.intValue ?? 0)
            }
        }

        var assignments: CategoryAssignments = [:]
        if let obj = raw["assignments"]?.objectValue {
            for (gameId, value) in obj {
                guard let ids = value.arrayValue else { continue }
                let list = ids.compactMap { $0.stringValue }
                if !list.isEmpty { assignments[gameId] = list }
            }
        }

        return (LibraryMeta(categories: categories, assignments: assignments), raw)
    }

    /// 只保存分类（**保留其他所有顶层键**）。
    ///
    /// ⚠️ 这是本文件最重要的一个函数：它必须把 raw 里**除 categories/assignments 之外**
    ///    的东西原样写回 —— 包括每个游戏的 DLsite 元数据。
    ///    漏了这一步 = 用户改个分类名就把他的元数据全抹了。
    ///
    /// - Returns: 错误描述（成功时 nil）
    public static func saveCategories(
        _ meta: LibraryMeta,
        dataDir: String,
        raw: [String: JSONValue],
        fileManager: FileManager = .default
    ) -> String? {
        var updated = raw

        // 分类定义
        var catObj: [String: JSONValue] = [:]
        for (id, def) in meta.categories {
            catObj[id] = .object([
                "name": .string(def.name),
                "order": .int(def.order),
            ])
        }
        updated["categories"] = catObj.isEmpty ? .null : .object(catObj)

        // 归属
        var assignObj: [String: JSONValue] = [:]
        for (gameId, ids) in meta.assignments where !ids.isEmpty {
            assignObj[gameId] = .array(ids.map { .string($0) })
        }
        updated["assignments"] = assignObj.isEmpty ? .null : .object(assignObj)

        let url = URL(fileURLWithPath: dataDir).appendingPathComponent(fileName)
        return JSONStore.save(JSONValue.object(updated), to: url, fileManager: fileManager)
    }
}
