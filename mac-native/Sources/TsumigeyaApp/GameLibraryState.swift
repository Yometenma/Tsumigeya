import Foundation
import Combine
import TsumigeyaCore

/// 游戏库记录、分类和筛选的唯一状态所有者；不持有运行时或资料请求任务。
@MainActor
final class GameLibraryState: ObservableObject {
    @Published private(set) var games: [GameRecord] = []
    @Published private(set) var categories: CategoryDefs = [:]
    @Published private(set) var assignments: CategoryAssignments = [:]
    @Published private(set) var loadError: String?
    @Published var searchText = ""
    @Published var activeCategory: String?
    @Published private var classificationOverrides: [String: JSONValue] = [:]
    var manualClassificationGameIDs: Set<String> {
        Set(classificationOverrides.compactMap { id, value in
            let state = value.objectValue ?? [:]
            return !(state["added"]?.arrayValue ?? []).isEmpty || !(state["removed"]?.arrayValue ?? []).isEmpty ? id : nil
        })
    }
    private var dataDir = ""
    @Published private var searchMetadata: [String: GameDlsiteMeta] = [:]
    var metadataByGameID: [String: GameDlsiteMeta] { searchMetadata }
    private var file: GameLibraryFile { GameLibraryFile(dataDir: dataDir) }

    func load(dataDirectory: String) -> String? {
        dataDir = dataDirectory
        do { games = try file.read().ordered; loadError = nil }
        catch { games = []; loadError = "\(error)" }
        var warning: String?
        if loadError == nil {
            do { _ = try LibraryClassification.change(.reconcile(gameIDs: games.map(\.id)), dataDir: dataDir) }
            catch { warning = "已有资料的自动分类未更新：\(error)" }
        }
        reloadRelatedData()
        return warning
    }

    private func reloadRelatedData() {
        let loaded = LibraryMetaStore.load(dataDir: dataDir)
        categories = loaded.meta.categories
        assignments = loaded.meta.assignments
        classificationOverrides = Dictionary(uniqueKeysWithValues: games.compactMap { game in
            guard let state = loaded.raw[game.id]?.objectValue?["classification"] else { return nil }
            return (game.id, state)
        })
        searchMetadata = GameMetaStore.loadAll(dataDir: dataDir)
        if let activeCategory, categories[activeCategory] == nil { self.activeCategory = nil }
    }

    func metadataDidSave(gameId: String, meta: GameDlsiteMeta, raw: [String: JSONValue]) {
        searchMetadata[gameId] = meta
        let decoded = LibraryMetaStore.decode(raw)
        categories = decoded.categories
        assignments = decoded.assignments
        classificationOverrides[gameId] = raw[gameId]?.objectValue?["classification"]
        if let activeCategory, categories[activeCategory] == nil { self.activeCategory = nil }
    }

    func metadata(for gameId: String) -> GameDlsiteMeta? { searchMetadata[gameId] }

    func game(id: String) -> GameRecord? { games.first { $0.id == id } }

    private func perform(_ operation: (GameLibraryFile) throws -> GameMap) throws {
        guard loadError == nil else { throw LibraryIntake.Failure(L("游戏库加载失败，请先处理读取错误。")) }
        let updated = try operation(file)
        games = updated.ordered
        reloadRelatedData()
    }

    func add(title: String, folder: String, engine: String, entryPath: String?) throws {
        try perform { try $0.add(title: title, folder: folder, engine: engine, entryPath: entryPath) }
    }
    func update(id: String, title: String, engine: String, gameArgs: [String: JSONValue]) throws {
        try perform { try $0.update(id: id, title: title, engine: engine, gameArgs: gameArgs) }
    }
    func addBatch(_ candidates: [LibraryIntake.Candidate]) throws {
        try perform { try $0.addBatch(candidates) }
    }
    func relocate(_ expected: GameRecord, folder: String) throws {
        try perform { try $0.relocate(expected, folder: folder) }
    }
    func setSaveDirectory(gameID: String, path: String?) throws {
        try perform { try $0.setSaveDirectory(gameID: gameID, path: path) }
    }
    func remove(_ expected: GameRecord) -> GameLibraryFile.RemovalReport {
        let report = file.remove(expected)
        if let map = report.map { games = map.ordered }
        // 即使只完成了关联数据清理，内存也必须反映已经保存的范围。
        reloadRelatedData()
        return report
    }
    func changeClassification(_ change: LibraryClassification.Change) throws {
        _ = try LibraryClassification.change(change, dataDir: dataDir)
        reloadRelatedData()
    }
    /// 一个分组（分类名 + 该组游戏）。
    struct Group: Identifiable {
        let id: String
        let title: String
        let games: [GameRecord]
    }

    /// 按分类分组的游戏列表。
    ///
    /// ⚠️ 三条必须守住的语义：
    ///  ① **多归属**：一个游戏可以出现在**多个**分组里（与标签一致）
    ///  ② **未归类放最后**，且**不能藏起来**（藏了用户以为游戏丢了）
    ///  ③ 搜索/筛选后为空的组**不显示**（否则一堆空标题）
    var groups: [Group] {
        let filtered = filteredGames

        // 分类顺序（按 order，相同 order 按 id —— 保证稳定）
        let ordered = Categories.ordered(categories)

        var result: [Group] = []

        for (catId, def) in ordered {
            let inCat = filtered.filter { game in
                (assignments[game.id] ?? []).contains(catId)
            }
            if inCat.isEmpty { continue }
            result.append(Group(id: catId, title: def.name, games: inCat))
        }

        // 未归类的：**没在任何分类里**的游戏
        //
        // ⚠️ 判据是「没有归属记录」而不是「不在任何已显示的分组里」——
        //    否则「被搜索过滤掉的归类游戏」会被误算进未分类。
        let unassigned = filtered.filter { game in
            let ids = assignments[game.id] ?? []
            // 完全没归属，或归属的分类都不存在（悬空引用）
            return ids.isEmpty || ids.allSatisfy { categories[$0] == nil }
        }
        if !unassigned.isEmpty {
            result.append(Group(id: "__unassigned", title: L("未分类"), games: unassigned))
        }

        // 如果既没分类也没未归类（比如全都归到已过滤掉的分类里）→ 兜底显示全部
        if result.isEmpty && !filtered.isEmpty {
            result.append(Group(id: "__all", title: L("全部"), games: filtered))
        }
        return result
    }

    /// 库页要显示的游戏（过滤后）。
    ///
    /// ⚠️ 判据**不要**写在 View 里（Electron 版踩过：画错不报错，只能靠单测钉）。
    var filteredGames: [GameRecord] {
        var result = LibraryFilter.apply(
            games: games,
            searchText: searchText,
            onlyUnbound: false,
            hasBinding: { !($0.gameArgs?.isEmpty ?? true) },
            metadata: { self.searchMetadata[$0.id]?.work }
        )
        if let activeCategory {
            result = result.filter { game in
                (assignments[game.id] ?? []).contains(activeCategory)
            }
        }
        return result
    }

}
