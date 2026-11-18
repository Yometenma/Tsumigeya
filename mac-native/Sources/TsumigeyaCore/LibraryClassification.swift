import Foundation

/// 只将已识别的游戏作品类型用于主分类，站点分区和题材标签不参与归类。
public enum GameWorkType {
    public static func code(_ value: String?) -> String? {
        guard let value else { return nil }
        let code = value.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let normalized = code == "ACN" ? "ACT" : code
        return names[normalized] == nil ? nil : normalized
    }

    public static let names = ["RPG": "角色扮演", "ADV": "冒险游戏", "SLN": "模拟游戏",
                               "ACT": "动作游戏", "PZL": "益智游戏"]
}

/// 自动归属和人工增删分别保存；有效归属仍写入 assignments，兼容原有筛选及旧库。
public enum LibraryClassification {
    static func strings(_ value: JSONValue?) -> [String] {
        value?.arrayValue?.compactMap(\.stringValue) ?? []
    }

    static func synchronize(_ raw: inout [String: JSONValue], gameIDs: [String]) {
        var meta = LibraryMetaStore.decode(raw)
        let disabled = Set(strings(raw["classificationSettings"]?.objectValue?["disabledTypes"]))
        for gameID in gameIDs.sorted() {
            var entry = raw[gameID]?.objectValue ?? [:]
            let code = GameWorkType.code(GameMetaStore.activeWorkJSON(entry)?.objectValue?["workType"]?.stringValue)
            guard code != nil || entry["classification"] != nil || !(meta.assignments[gameID] ?? []).isEmpty else { continue }
            var state = entry["classification"]?.objectValue ?? [:]
            // 首次接管时把旧归属视为人工添加，不能猜测用户原来的意图。
            if entry["classification"] == nil {
                state["added"] = .array((meta.assignments[gameID] ?? []).map(JSONValue.string))
            }
            let added = strings(state["added"]).filter { meta.categories[$0] != nil }
            let removed = Set(strings(state["removed"]))
            var ids = added
            if let code, !disabled.contains(code), let name = GameWorkType.names[code] {
                let ordered = Categories.ordered(meta.categories)
                let existing = ordered.first { $0.def.sourceWorkType == code }?.id
                    ?? ordered.first {
                        Categories.normalizeName($0.def.name).lowercased() == name.lowercased()
                        && $0.def.sourceWorkType == nil
                    }?.id
                let id: String?
                if let existing { id = existing }
                else if let created = Categories.create(meta.categories, name: name) {
                    meta.categories = created.defs
                    id = created.id
                } else { id = nil }
                if let id {
                    meta.categories[id]?.sourceWorkType = code
                    if !removed.contains(id), !ids.contains(id) { ids.append(id) }
                }
            }
            state["added"] = .array(added.map(JSONValue.string))
            entry["classification"] = .object(state)
            raw[gameID] = .object(entry)
            meta.assignments[gameID] = ids.isEmpty ? nil : ids
        }
        // 没有分类数据时不为读取空库创建旁挂文件。
        if !meta.categories.isEmpty || raw["categories"] != nil || !meta.assignments.isEmpty {
            raw = LibraryMetaStore.applying(meta, to: raw)
        }
    }

    public enum Change: Sendable {
        case reconcile(gameIDs: [String])
        case create(name: String, gameIDs: [String])
        case rename(id: String, name: String)
        case delete(id: String)
        case membership(gameID: String, categoryID: String, member: Bool)
        case restoreAutomatic(gameID: String)
    }

    /// 每次从磁盘读取完整文档并在共享锁内定点修改，不写回界面的旧分类快照。
    @discardableResult
    public static func change(_ change: Change, dataDir: String) throws -> LibraryMeta {
        GameMetaStore.mutationLock.lock()
        defer { GameMetaStore.mutationLock.unlock() }
        var raw = try GameMetaStore.readRawForUpdate(dataDir: dataDir)
        let original = raw
        var meta = LibraryMetaStore.decode(raw)
        switch change {
        case .reconcile(let ids):
            synchronize(&raw, gameIDs: ids)
        case .create(let name, let gameIDs):
            guard let created = Categories.create(meta.categories, name: name) else {
                throw LibraryIntake.Failure("分类名称无效或已存在。")
            }
            meta.categories = created.defs
            // 手动重建同名的类型分类，视为明确重新启用该类型。
            if let code = GameWorkType.names.keys.sorted().first(where: { GameWorkType.names[$0] == Categories.normalizeName(name) }) {
                meta.categories[created.id]?.sourceWorkType = code
                var settings = raw["classificationSettings"]?.objectValue ?? [:]
                settings["disabledTypes"] = .array(strings(settings["disabledTypes"]).filter { $0 != code }.map(JSONValue.string))
                raw["classificationSettings"] = .object(settings)
            }
            raw = LibraryMetaStore.applying(meta, to: raw)
            synchronize(&raw, gameIDs: gameIDs)
        case .rename(let id, let name):
            guard let updated = Categories.rename(meta.categories, id: id, newName: name) else {
                throw LibraryIntake.Failure("分类名称无效、重复或分类已移除。")
            }
            meta.categories = updated
            raw = LibraryMetaStore.applying(meta, to: raw)
        case .delete(let id):
            if let code = meta.categories[id]?.sourceWorkType {
                var settings = raw["classificationSettings"]?.objectValue ?? [:]
                var disabled = Set(strings(settings["disabledTypes"]))
                disabled.insert(code)
                settings["disabledTypes"] = .array(disabled.sorted().map(JSONValue.string))
                raw["classificationSettings"] = .object(settings)
            }
            let result = Categories.remove(meta.categories, assignments: meta.assignments, id: id)
            meta.categories = result.defs
            meta.assignments = result.assignments
            // 清理人工覆盖，避免同名分类未来重建时继承已删除的归属。
            for key in raw.keys.sorted() where raw[key]?.objectValue?["classification"] != nil {
                guard var entry = raw[key]?.objectValue else { continue }
                var state = entry["classification"]?.objectValue ?? [:]
                for field in ["added", "removed"] {
                    state[field] = .array(strings(state[field]).filter { $0 != id }.map(JSONValue.string))
                }
                entry["classification"] = .object(state)
                raw[key] = .object(entry)
            }
            raw = LibraryMetaStore.applying(meta, to: raw)
        case .membership(let gameID, let categoryID, let member):
            guard meta.categories[categoryID] != nil else { throw LibraryIntake.Failure("分类已移除。") }
            synchronize(&raw, gameIDs: [gameID])
            var entry = raw[gameID]?.objectValue ?? [:]
            var state = entry["classification"]?.objectValue ?? [:]
            var added = Set(strings(state["added"]))
            var removed = Set(strings(state["removed"]))
            if member { added.insert(categoryID); removed.remove(categoryID) }
            else { added.remove(categoryID); removed.insert(categoryID) }
            state["added"] = .array(added.sorted().map(JSONValue.string))
            state["removed"] = .array(removed.sorted().map(JSONValue.string))
            entry["classification"] = .object(state)
            raw[gameID] = .object(entry)
            synchronize(&raw, gameIDs: [gameID])
        case .restoreAutomatic(let gameID):
            var entry = raw[gameID]?.objectValue ?? [:]
            var state = entry["classification"]?.objectValue ?? [:]
            state["added"] = .array([])
            state["removed"] = .array([])
            entry["classification"] = .object(state)
            raw[gameID] = .object(entry)
            synchronize(&raw, gameIDs: [gameID])
        }
        if raw != original, let error = GameMetaStore.writeRaw(raw, dataDir: dataDir) {
            throw LibraryIntake.Failure("保存分类失败：\(error)")
        }
        return LibraryMetaStore.decode(raw)
    }
}
