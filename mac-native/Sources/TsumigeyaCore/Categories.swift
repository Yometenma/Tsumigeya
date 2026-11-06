// 自定义分类（**多归属 + 扁平**，纯逻辑）。
//
// 对应 Electron 版：`src/shared/categories.ts`（206 行 / 46 条单测）
// 契约：D84（分类是库页的筛选器，不是侧边栏导航）
//
// ===== 用户拍板的两条语义 =====
//
// **多归属**（一个游戏可同时属于多个分类，像标签）+ **扁平**（不做父子层级）。
//
// ===== 为什么必须抽成纯函数 =====
//
// 分类对数据做的事全都是**批量改写**：
//   · 删一个分类 → 要从**所有**游戏上摘掉那个 id（写错一个就留下悬空引用）
//   · 重命名 → **只改 name、id 不动**（改动了 id 等于把全库的归属全丢了）
//   · 新建 → 名字查重 + 生成唯一 id（撞了 id 会把两个分类合并成一个）
//
// 这三件事的共同点：**错了不报错，只是数据慢慢变脏**。而且分类是用户会长期
// 累积的东西，脏一次很难还原。所以判据必须能单测。
import Foundation

/// 一条分类定义。
public struct CategoryDef: Sendable, Equatable {
    /// 显示名（用户建的）。
    public var name: String
    /// 排序权重。
    ///
    /// ⚠️ 用数字而不是数组下标：下标在「删掉中间一个」时会整体前移，
    ///    而 order 是稳定值 —— 用户删掉第 2 个，第 3 个不会突然变成第 2。
    public var order: Int

    public init(name: String, order: Int) {
        self.name = name
        self.order = order
    }
}

/// 定义表：`[slug: CategoryDef]`。
public typealias CategoryDefs = [String: CategoryDef]

/// 归属表：`[gameId: [categoryId]]`（**多归属**：一个游戏可属于多个）。
public typealias CategoryAssignments = [String: [String]]

public enum Categories {

    /// 一个分类名字符数上限（防止用户粘一整段进去把侧边栏撑爆）。
    public static let nameMax = 24
    /// id 长度上限（slug 是内部用的，不该长得像一句话）。
    public static let idMax = 32

    // MARK: - 名字

    /// 名字归一化：去首尾空白 + **把连续空白压成一个空格**。
    ///
    /// 为什么压空白：`"我的 分类"` 与 `"我的   分类"` 在查重时应该算同一个名字，
    /// 否则用户复制粘贴带多个空格就建出两个看起来一样的分类。
    ///
    /// ⚠️ **不改大小写**：中文没有大小写，而英文名（"RPG"）用户可能刻意要保留大写。
    ///    查重时才按小写比较（见 `isDuplicateName`），显示仍用原样。
    public static func normalizeName(_ raw: String?) -> String {
        guard let raw else { return "" }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        // 连续空白压成一个空格（含全角空格 U+3000）
        var result = ""
        var lastWasSpace = false
        for ch in trimmed {
            let isSpace = ch.isWhitespace || ch == "\u{3000}"
            if isSpace {
                if !lastWasSpace { result.append(" ") }
                lastWasSpace = true
            } else {
                result.append(ch)
                lastWasSpace = false
            }
        }
        return result
    }

    /// 名字是否合法。返回错误码而不是抛，调用方自己决定怎么提示。
    public enum NameError: Sendable, Equatable {
        case empty
        case tooLong
    }

    public static func validateName(_ raw: String?) -> NameError? {
        let name = normalizeName(raw)
        if name.isEmpty { return .empty }
        // ⚠️ 用 `count`（字素簇计数）而不是 utf8.count：
        //    中文一个字是一个 count，用户理解的就是字数。
        if name.count > nameMax { return .tooLong }
        return nil
    }

    /// 名字查重（**大小写不敏感**）。
    ///
    /// - Parameter excludeId: 用于「重命名」场景（改自己的名字不该和自己冲突）
    ///
    /// 为什么要查重：两个同名分类在界面上完全无法区分，用户点哪个都可能是错的。
    /// 而且删掉其中一个之后，另一个的归属看起来「凭空少了一半」—— 这类困惑极难解释。
    public static func isDuplicateName(
        _ defs: CategoryDefs, raw: String?, excludeId: String? = nil
    ) -> Bool {
        let name = normalizeName(raw).lowercased()
        if name.isEmpty { return false }
        for (id, def) in defs {
            if let excludeId, id == excludeId { continue }
            if normalizeName(def.name).lowercased() == name { return true }
        }
        return false
    }

    // MARK: - id

    /// 从名字生成 slug（内部 id）。
    ///
    /// 规则：**只取 ASCII 字母数字**，其余（含中文、标点、emoji）当分隔符。
    ///   · `"动作类"` → 全是中文 → 无可用字符 → 走兜底 `cat`
    ///   · `"RPG Maker"` → `rpg-maker`
    ///   · `"我的 RPG"` → `rpg`（前缀中文被剥掉，没丢信息因为显示名还在 def.name 里）
    ///
    /// 为什么不做拼音转写：那要引入一张表（几百 KB）或一个库，而 id 是**内部标识**，
    /// 用户永远看不到它。可读性收益为零，成本不小。
    ///
    /// ⚠️ 兜底名是 `cat` 而不是空串：空 id 会被当成「未分类」的判据误伤
    ///    （`categories` 里有个空串，筛选时看着像"属于某个分类"但点进去什么都没有）。
    public static func slugify(_ raw: String?) -> String {
        let name = normalizeName(raw)
        var ascii = ""
        var lastWasDash = true
        for scalar in name.lowercased().unicodeScalars {
            let isAlnum = (scalar.value >= 97 && scalar.value <= 122)      // a-z
                || (scalar.value >= 48 && scalar.value <= 57)              // 0-9
            if isAlnum {
                ascii.append(Character(scalar))
                lastWasDash = false
            } else if !lastWasDash {
                ascii.append("-")
                lastWasDash = true
            }
        }
        // 去尾部 dash
        while ascii.hasSuffix("-") { ascii.removeLast() }
        let base = ascii.isEmpty ? "cat" : ascii
        let sliced = String(base.prefix(idMax))
        var trimmed = sliced
        while trimmed.hasSuffix("-") { trimmed.removeLast() }
        return trimmed.isEmpty ? "cat" : trimmed
    }

    /// 生成一个**在现有定义表里唯一**的 id。
    ///
    /// 撞了就追加 `-2` / `-3` / …（而不是随机串）：随机串在导出的 JSON 里没法看懂，
    /// 而 `cat-2` 一眼能猜到是"第二个没名字的分类"。
    ///
    /// 上限 1000 次后回落时间戳：正常用量绝不会走到，
    /// 但**绝不能返回一个已存在的 id**（那会把两个分类静默合并成一个，用户的归属数据当场错乱）。
    public static func uniqueId(_ defs: CategoryDefs, raw: String?) -> String {
        let base = slugify(raw)
        if defs[base] == nil { return base }
        for n in 2...1000 {
            let candidate = "\(base)-\(n)"
            if defs[candidate] == nil { return candidate }
        }
        // 兜底：时间戳（理论上到不了）
        return "\(base)-\(Int(Date().timeIntervalSince1970))"
    }

    // MARK: - 增删改

    /// 新建分类。
    ///
    /// - Returns: 新的 (defs, 新 id)；名字非法或重复时返回 nil
    public static func create(
        _ defs: CategoryDefs, name: String
    ) -> (defs: CategoryDefs, id: String)? {
        if validateName(name) != nil { return nil }
        if isDuplicateName(defs, raw: name) { return nil }

        let id = uniqueId(defs, raw: name)
        // order = 现有最大 + 1（最早创建的在最前）
        let nextOrder = (defs.values.map(\.order).max() ?? 0) + 1
        var updated = defs
        updated[id] = CategoryDef(name: normalizeName(name), order: nextOrder)
        return (updated, id)
    }

    /// 重命名（**只改 name、id 不动**）。
    ///
    /// ⚠️ 改 id 等于把全库的归属全丢了 —— 那是这个函数唯一不能犯的错。
    public static func rename(
        _ defs: CategoryDefs, id: String, newName: String
    ) -> CategoryDefs? {
        guard var def = defs[id] else { return nil }
        if validateName(newName) != nil { return nil }
        if isDuplicateName(defs, raw: newName, excludeId: id) { return nil }
        def.name = normalizeName(newName)
        var updated = defs
        updated[id] = def
        return updated
    }

    public static func remove(
        _ defs: CategoryDefs, assignments: CategoryAssignments, id: String
    ) -> (defs: CategoryDefs, assignments: CategoryAssignments) {
        var newDefs = defs
        newDefs.removeValue(forKey: id)

        var newAssignments: CategoryAssignments = [:]
        for (gameId, ids) in assignments {
            let filtered = ids.filter { $0 != id }
            if !filtered.isEmpty {
                newAssignments[gameId] = filtered
            }
            // 空了就整个键去掉（不留 `gameId: []` —— 那是噪音）
        }
        return (newDefs, newAssignments)
    }

    /// 把游戏归入/移出一个分类。
    public static func setMembership(
        _ assignments: CategoryAssignments, gameId: String, categoryId: String, member: Bool
    ) -> CategoryAssignments {
        var updated = assignments
        var ids = updated[gameId] ?? []
        if member {
            if !ids.contains(categoryId) { ids.append(categoryId) }
        } else {
            ids.removeAll { $0 == categoryId }
        }
        if ids.isEmpty {
            updated.removeValue(forKey: gameId)
        } else {
            updated[gameId] = ids
        }
        return updated
    }

    // MARK: - 排序

    /// 按 order 排序后的分类列表（带 id）。
    ///
    /// ⚠️ 同 order 时按 id 排 —— 否则 Swift 字典的遍历顺序会让
    ///    「同样 order 的两个分类」每次刷新换位置（用户会觉得界面在乱跳）。
    public static func ordered(_ defs: CategoryDefs) -> [(id: String, def: CategoryDef)] {
        defs.map { (id: $0.key, def: $0.value) }
            .sorted { a, b in
                if a.def.order != b.def.order { return a.def.order < b.def.order }
                return a.id < b.id
            }
    }
}
