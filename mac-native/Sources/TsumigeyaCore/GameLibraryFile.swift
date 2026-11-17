import Foundation

/// 游戏库的唯一读改写入口；业务校验继续复用 GameLibrary 和 LibraryIntake。
public struct GameLibraryFile: Sendable {
    public let dataDir: String
    private static let lock = NSRecursiveLock()
    private var url: URL { URL(fileURLWithPath: dataDir).appendingPathComponent("games.json") }

    public init(dataDir: String) { self.dataDir = dataDir }

    public func read() throws -> GameMap {
        switch JSONStore.load(GameMap.self, from: url, quarantineCorrupt: false) {
        case .loaded(let map): return map
        case .missing: return GameMap()
        case .corrupt(let failure):
            throw LibraryIntake.Failure("无法读取游戏库，原件未改动：\(failure.reason)")
        }
    }

    private func modify(_ transform: (GameMap) throws -> GameMap) throws -> GameMap {
        Self.lock.lock()
        defer { Self.lock.unlock() }
        let updated = try transform(read())
        if let error = JSONStore.save(updated, to: url) {
            throw LibraryIntake.Failure("保存游戏库失败，未完成操作：\(error)")
        }
        return updated
    }

    public func add(title: String, folder: String, engine: String, entryPath: String? = nil) throws -> GameMap {
        try modify { map in
            if let id = LibraryIntake.duplicateFolder(folder, in: map) {
                throw LibraryIntake.Failure("此目录已入库（游戏 \(id)）")
            }
            let entry: String
            if engine == "wine" {
                switch WineRuntime.resolveEntry(folder: folder, selected: entryPath) {
                case .success(let resolved): entry = resolved
                case .failure(let error): throw LibraryIntake.Failure(error.message)
                }
            } else { entry = (folder as NSString).appendingPathComponent("Game.exe") }
            let draft = GameRecord(id: "", gameTitle: title, gamePath: entry, gameEngine: engine, gameArgs: [:])
            switch GameLibrary.save(into: map, draft: draft) {
            case .success(let saved): return saved.map
            case .failure(let error): throw LibraryIntake.Failure(error.message)
            }
        }
    }

    public func update(id: String, title: String, engine: String, gameArgs: [String: JSONValue]) throws -> GameMap {
        try modify { map in
            guard var draft = map.games[id] else { throw LibraryIntake.Failure("游戏已移除。") }
            draft.gameTitle = title
            draft.gameEngine = engine
            draft.gameArgs = gameArgs
            switch GameLibrary.save(into: map, draft: draft, id: id) {
            case .success(let saved): return saved.map
            case .failure(let error): throw LibraryIntake.Failure(error.message)
            }
        }
    }

    public func addBatch(_ candidates: [LibraryIntake.Candidate]) throws -> GameMap {
        try modify { try LibraryIntake.adding(candidates, to: $0) }
    }

    public func relocate(_ expected: GameRecord, folder: String) throws -> GameMap {
        try modify { try LibraryIntake.relocating(expected, to: folder, in: $0) }
    }

    public func setSaveDirectory(gameID: String, path: String?) throws -> GameMap {
        let normalized: String?
        if let trimmed = path?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty {
            let candidate = URL(fileURLWithPath: trimmed).standardizedFileURL.path
            var directory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: candidate, isDirectory: &directory), directory.boolValue,
                  FileManager.default.isReadableFile(atPath: candidate) else {
                throw LibraryIntake.Failure("存档目录不存在或无法读取：\(candidate)")
            }
            normalized = candidate
        } else { normalized = nil }
        return try modify { map in
            switch GameLibrary.settingSaveDirectory(in: map, gameId: gameID, directory: normalized) {
            case .success(let updated): return updated
            case .failure(let error): throw LibraryIntake.Failure(error.message)
            }
        }
    }

    public enum RemovalStep: String, Sendable, Equatable {
        case metadata = "作品资料和分类归属"
        case playStats = "游玩记录"
        case game = "游戏库记录"
    }

    public struct RemovalReport: Sendable {
        public let completed: [RemovalStep]
        public let failure: String?
        public let map: GameMap?
        public var message: String? {
            guard let failure else { return nil }
            let saved = completed.isEmpty ? "尚未保存任何删除步骤。" : "已保存：" + completed.map(\.rawValue).joined(separator: "、") + "。"
            return "移除游戏未完成：\(failure)\n\(saved)游戏库记录仍保留，可排除问题后重试；不会删除游戏目录或存档。"
        }
    }

    /// 先预检全部文档，再逐文件提交；游戏记录最后删除，失败时保留编号供重试。
    /// 不承诺跨文件事务。应用层必须在调用前取消请求、使功能会话失效。
    public func remove(_ expected: GameRecord) -> RemovalReport {
        Self.lock.lock()
        defer { Self.lock.unlock() }
        GameMetaStore.mutationLock.lock()
        defer { GameMetaStore.mutationLock.unlock() }
        var completed: [RemovalStep] = []
        do {
            let map = try read()
            guard map.games[expected.id] == expected else {
                throw LibraryIntake.Failure("游戏已移除或记录发生变化，请刷新游戏库。")
            }
            _ = try GameMetaStore.readRawForUpdate(dataDir: dataDir)
            let statsURL = URL(fileURLWithPath: dataDir).appendingPathComponent("play-stats.json")
            var stats: [String: JSONValue]?
            switch JSONStore.load([String: JSONValue].self, from: statsURL, quarantineCorrupt: false) {
            case .loaded(let value): stats = value
            case .missing: break
            case .corrupt(let failure): throw LibraryIntake.Failure("无法读取游玩记录：\(failure.reason)")
            }
            if let error = GameMetaStore.removeGameData(dataDir: dataDir, gameId: expected.id) {
                throw LibraryIntake.Failure("清理作品资料和分类归属失败：\(error)")
            }
            completed.append(.metadata)
            if var stats {
                stats.removeValue(forKey: expected.id)
                if let error = JSONStore.save(stats, to: statsURL) {
                    throw LibraryIntake.Failure("保存游玩记录失败：\(error)")
                }
            }
            completed.append(.playStats)
            let updated = GameLibrary.remove(from: map, id: expected.id)
            if let error = JSONStore.save(updated, to: url) {
                throw LibraryIntake.Failure("保存游戏库失败：\(error)")
            }
            completed.append(.game)
            return RemovalReport(completed: completed, failure: nil, map: updated)
        } catch {
            return RemovalReport(completed: completed, failure: "\(error)", map: nil)
        }
    }
}
