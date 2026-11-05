// 游戏库的增删改（games.json 的写）。
//
// 对应 Electron 版：`src/main/games-store.ts`（410 行）
// 契约：D10（schema 与上游兼容）/ D18 旁挂存储
//
// ===== 这个文件最容易漏的一条：删游戏要清**四处** =====
//
//   `games.json` / `library-meta`（元数据）/ `play-stats`（游玩记录）/ **`assignments`（分类归属）**
//
// ⚠️ 漏掉后两项的后果很具体：`saveGame` 用 `Math.max(...)+1` 生成 id，
//    **很容易落回刚删的号** → 新游戏继承了上一个游戏的游玩历史和分类归属。
//    用户会看到「这个新游戏显示玩了 20 小时」——而他完全不知道原因。
//
// 回归测试：Electron 版 `test/delete-cleanup.test.ts`
import Foundation

public enum GameLibrary {

    /// 文件名校验（标题/路径的合法性）。
    ///
    /// ⚠️ 必须实现 `Error`：`Result` 的失败类型要求它（与 `LaunchFailure` 同一个理由）。
    public enum ValidationError: Error, Sendable, Equatable {
        case emptyTitle
        case emptyPath
        case duplicateTitle(existing: String)
        case invalidId

        public var message: String {
            switch self {
            case .emptyTitle: return "游戏名不能为空"
            case .emptyPath: return "游戏路径不能为空"
            case .duplicateTitle(let existing): return "已经有同名游戏了（id \(existing)）"
            case .invalidId: return "游戏 id 不合法"
            }
        }
    }

    /// 保存（新增或更新）一条游戏。
    ///
    /// - Parameters:
    ///   - map: 现有的游戏 map
    ///   - draft: 要保存的记录（`id == nil` = 新增）
    ///   - allRecords: 用于查重（可包含自己）
    ///
    /// - Returns: 新的 map + 实际使用的 id
    ///
    /// ⚠️ **id 的生成规则与 Electron 版一致**：`max(现有数字 id) + 1`。
    ///    这是 D10（上游 schema 兼容）的一部分 —— 上游就是这么算的。
    ///
    /// ⚠️ 但它有**副作用**：删掉最后一个游戏之后再添加，会**复用**那个 id（落到同一个数字）。
    ///    所以删游戏时必须清干净四处旁挂数据（见文件头）。这里不修这个特性
    ///    （改了会破坏与上游的兼容），而是靠「删除时清干净」来兜。
    public static func save(
        into map: GameMap,
        draft: GameRecord,
        id requestedId: String? = nil
    ) -> Result<(map: GameMap, id: String, changed: Bool), ValidationError> {

        var title = draft.gameTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        var path = draft.gamePath.trimmingCharacters(in: .whitespacesAndNewlines)

        if title.isEmpty { return .failure(.emptyTitle) }
        if path.isEmpty { return .failure(.emptyPath) }

        // id 决定是新增还是更新
        let id: String
        if let requestedId, !requestedId.isEmpty {
            // 更新：id 必须已存在
            guard map.games[requestedId] != nil else {
                return .failure(.invalidId)
            }
            id = requestedId
        } else {
            // 新增：max + 1
            let numericIds = map.games.keys.compactMap { Int($0) }
            id = String((numericIds.max() ?? 0) + 1)
        }

        // 查重（**排除自己**，否则更新时会和自己冲突）
        for (otherId, other) in map.games where otherId != id {
            if other.gameTitle.trimmingCharacters(in: .whitespaces).lowercased()
                == title.lowercased() {
                return .failure(.duplicateTitle(existing: otherId))
            }
        }

        // 组装记录（**保留未知字段** —— D10 的双向兼容）
        var record = draft
        record.id = id
        record.gameTitle = title
        record.gamePath = path

        var updated = map
        // 更新时先继承旧记录的未知字段（用户没主动改的要去还在）
        if let old = map.games[id], record.unknownFields.isEmpty {
            record.unknownFields = old.unknownFields
        }
        updated.games[id] = record

        return .success((updated, id, true))
    }

    /// 删游戏。
    ///
    /// ⚠️ **本函数只负责 games map**。四处旁挂数据的清理是调用方（AppStore）的责任 ——
    ///    因为它们在不同文件里，不该由这个纯函数碰 IO。
    ///
    /// - Returns: 新的 map（id 不存在时原样返回，**幂等**）
    public static func remove(from map: GameMap, id: String) -> GameMap {
        var updated = map
        updated.games.removeValue(forKey: id)
        return updated
    }

    /// 下一个可用的 id（给 UI 预览用）。
    public static func nextId(in map: GameMap) -> String {
        let numericIds = map.games.keys.compactMap { Int($0) }
        return String((numericIds.max() ?? 0) + 1)
    }
}

// MARK: - 添加游戏（识别 → 保存）

public enum GameImport {

    /// 一次导入尝试的结果。
    public struct Outcome: Sendable {
        /// 用户选的原始路径。
        public let selectedPath: String
        /// 反推得到的游戏目录（可能等于 selectedPath）。
        public let resolvedFolder: String
        /// 往上退了几层（0 = 没退）。
        public let ascendLevel: Int
        /// 识别出的引擎（nil = 认不出）。
        public let engine: EngineDefinition?
        /// 用于启动的入口文件路径。
        ///
        /// ⚠️ 为什么不是「用户选的那个文件」：
        ///    用户可能选的是 `readme.txt`，而真正的入口是
        ///    `www/index.html` 或游戏根里的某个 exe。
        ///    这里只保证「是游戏目录下的一个文件」，不追求精确到可执行文件
        ///    （真正启动时由 `LaunchPlanner` 按引擎规则拼）。
        public let entryPath: String
    }

    /// 从用户选的文件反推游戏目录并识别引擎。
    ///
    /// - Parameters:
    ///   - selectedPath: 用户选的文件绝对路径
    ///   - fileExists: 注入用
    ///
    /// - Returns: 识别结果。`engine == nil` 表示认不出（UI 该让用户手选）。
    public static func inspect(
        selectedPath: String,
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
    ) -> Outcome {
        let base = ImportTarget.stripTrailingSep(selectedPath)

        // ⚠️ **`resolvedFolder` 必须是「目录」，不是 `attempt.path`**。
        //
        //    识别器真正去看的目录是 `DetectPath.gameDirForFiles(probe)`：
        //      · level 0 传的是**文件** → 那个目录是它的**父目录**（= 用户想要的）
        //      · level ≥1 传的是 `<目录>/Game.exe` → 父目录正好是那个目录
        //
        //    所以两种情况下，「认出来的目录」都是 `gameDirForFiles(probe)`。
        //    本鱼第一版把 `folder = attempt.path` 直接赋值 ——
        //    level 0 时 `attempt.path` 是**文件**，于是 folder 成了 `…/Game.exe`（错的）。
        var folder = base
        var level = 0
        var engine: EngineDefinition?

        for attempt in ImportTarget.attempts(selectedPath: base) {
            let probe: String
            if attempt.level == 0 {
                probe = attempt.path          // 文件本身（或 .app 包）
            } else {
                probe = (attempt.path as NSString).appendingPathComponent("Game.exe")
            }
            if let found = EngineRegistry.detect(exe: probe, fileExists: fileExists) {
                // ✅ 用 gameDirForFiles 确定真正的目录（这是识别器实际看的地方）
                folder = DetectPath.gameDirForFiles(probe)
                level = attempt.level
                engine = found
                break
            }
        }

        // ⚠️ 全都不认得时，**落回「用户所选文件的父目录」而不是它自己** ——
        //    因为「游戏目录」几乎不会是用户选中的那个文件本身。
        //    （这条本鱼第一版写错了：直接拿 base 当 folder，于是
        //     `selectedPath = /games/Mystery/a.bin` 时 folder 也成了 `a.bin`。）
        if engine == nil {
            let parent = (base as NSString).deletingLastPathComponent
            folder = parent.isEmpty || parent == base ? base : parent
        }

        return Outcome(
            selectedPath: selectedPath,
            resolvedFolder: folder,
            ascendLevel: level,
            engine: engine,
            entryPath: (folder as NSString).appendingPathComponent("Game.exe")
        )
    }
}
