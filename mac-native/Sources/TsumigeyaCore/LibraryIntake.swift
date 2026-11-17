import Foundation

/// 批量扫描只检查当前目录，不能沿用单文件导入的向上兜底，否则会把同一个游戏重复认领。
public enum LibraryIntake {
    public struct Candidate: Identifiable, Sendable, Equatable {
        public var id: String { folder }
        public let folder: String
        public var title: String
        public let engine: String
        public var entryPath: String
        public init(folder: String, title: String, engine: String, entryPath: String = "") {
            self.folder = folder; self.title = title; self.engine = engine; self.entryPath = entryPath
        }
    }

    public struct Scan: Sendable {
        public var candidates: [Candidate] = []
        public var warnings: [String] = []
        public var visited = 0
        public var limited = false
        public var cancelled = false
    }

    public struct Failure: Error, Sendable, CustomStringConvertible {
        public let description: String
        public init(_ message: String) { description = message }
    }

    public static func canonicalFolder(_ path: String) -> String {
        URL(fileURLWithPath: path).standardizedFileURL.resolvingSymlinksInPath().path
    }

    public static func duplicateFolder(_ folder: String, in map: GameMap, excluding id: String? = nil) -> String? {
        let key = canonicalFolder(folder)
        let attributes = try? FileManager.default.attributesOfItem(atPath: key)
        return map.ordered.first {
            guard $0.id != id else { return false }
            let other = canonicalFolder(DetectPath.gameDirForFiles($0.gamePath))
            if other == key { return true }
            guard let attributes, let inode = attributes[.systemFileNumber] as? NSNumber,
                  let device = attributes[.systemNumber] as? NSNumber,
                  let otherAttributes = try? FileManager.default.attributesOfItem(atPath: other) else { return false }
            return inode == otherAttributes[.systemFileNumber] as? NSNumber &&
                   device == otherAttributes[.systemNumber] as? NSNumber
        }?.id
    }

    public static func inspectFolder(_ folder: String) throws -> Candidate? {
        let url = URL(fileURLWithPath: folder).standardizedFileURL
        let values = try url.resourceValues(forKeys: [.isDirectoryKey])
        guard values.isDirectory == true else { throw Failure("请选择游戏目录。") }
        let files = try FileManager.default.contentsOfDirectory(
            at: url, includingPropertiesForKeys: [.isRegularFileKey, .isSymbolicLinkKey], options: [.skipsHiddenFiles])
        let probe = DetectPath.isAppBundle(url.path) ? url.path : url.appendingPathComponent("Game.exe").path
        var engine = EngineRegistry.detect(exe: probe)
        if engine == nil {
            for file in files.sorted(by: { $0.path < $1.path }) {
                let info = try file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
                guard info.isRegularFile == true, info.isSymbolicLink != true else { continue }
                if let found = EngineRegistry.detect(exe: file.path) { engine = found; break }
            }
        }
        guard let engine else { return nil }
        return Candidate(folder: url.path, title: DetectPath.isAppBundle(url.path) ? url.deletingPathExtension().lastPathComponent : url.lastPathComponent,
                         engine: engine.folder, entryPath: engine.folder == "wine" && WineRuntime.executables(in: url.path).count == 1 ? WineRuntime.executables(in: url.path)[0] : "")
    }

    /// 命中后不进入资源子目录；不跟随子目录符号链接，限制深度及目录总量。
    public static func scan(root: String, maxDepth: Int = 3, maxDirectories: Int = 2000,
                            maxCandidates: Int = 200, cancelled: () -> Bool = { false }) throws -> Scan {
        let start = URL(fileURLWithPath: canonicalFolder(root))
        guard try start.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true else {
            throw Failure("请选择要扫描的目录。")
        }
        var report = Scan()
        var queue: [(URL, Int)] = [(start, 0)]
        var index = 0
        var seen = Set<String>()
        while index < queue.count {
            if cancelled() { report.cancelled = true; break }
            if report.visited >= max(1, maxDirectories) || report.candidates.count >= max(1, maxCandidates) {
                report.limited = true; break
            }
            let (url, depth) = queue[index]; index += 1
            guard seen.insert(canonicalFolder(url.path)).inserted else { continue }
            report.visited += 1
            do {
                if let candidate = try inspectFolder(url.path) {
                    report.candidates.append(candidate)
                    continue
                }
                // 应用包不作为普通游戏集合继续递归。
                if DetectPath.isAppBundle(url.path) { continue }
                let children = try FileManager.default.contentsOfDirectory(
                    at: url, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey], options: [.skipsHiddenFiles])
                for child in children.sorted(by: { $0.path < $1.path }) {
                    let info = try child.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                    guard info.isDirectory == true, info.isSymbolicLink != true else { continue }
                    if depth >= max(0, maxDepth) { report.limited = true; continue }
                    if queue.count >= max(1, maxDirectories) { report.limited = true; continue }
                    queue.append((child, depth + 1))
                }
            } catch { report.warnings.append("无法读取 \(url.path)：\(error.localizedDescription)") }
        }
        return report
    }

    /// 先验证整个选择集，再返回一份新 map；调用方只需原子写入一次 games.json。
    public static func adding(_ candidates: [Candidate], to map: GameMap) throws -> GameMap {
        guard !candidates.isEmpty else { throw Failure("请先勾选要添加的游戏。") }
        var result = map
        for candidate in candidates {
            guard let detected = try inspectFolder(candidate.folder), detected.engine == candidate.engine else {
                throw Failure("目录已变化或引擎不匹配，请重新扫描：\(candidate.folder)")
            }
            if let id = duplicateFolder(candidate.folder, in: result) {
                throw Failure("此目录已入库（游戏 \(id)），未添加任何游戏。")
            }
            let entry: String
            if candidate.engine == "wine" {
                switch WineRuntime.resolveEntry(folder: candidate.folder, selected: candidate.entryPath) {
                case .success(let path): entry = path
                case .failure(let error): throw Failure(error.message)
                }
            } else { entry = (candidate.folder as NSString).appendingPathComponent("Game.exe") }
            let draft = GameRecord(id: "", gameTitle: candidate.title,
                                   gamePath: entry,
                                   gameEngine: candidate.engine, gameArgs: [:])
            switch GameLibrary.save(into: result, draft: draft) {
            case .success(let saved): result = saved.map
            case .failure(let error): throw Failure(error.message)
            }
        }
        return result
    }

    /// 只改变原记录的路径；编号、参数、未知字段与所有旁挂数据保持不变。
    public static func relocating(_ expected: GameRecord, to folder: String, in map: GameMap) throws -> GameMap {
        guard map.games[expected.id] == expected else { throw Failure("游戏记录已变化，请关闭后重新打开定位窗口。") }
        guard let detected = try inspectFolder(folder), detected.engine == expected.gameEngine else {
            throw Failure("所选目录无法识别为原引擎，请确认选择的是同一个游戏。")
        }
        guard duplicateFolder(folder, in: map, excluding: expected.id) == nil else {
            throw Failure("此目录已关联到其他游戏，不能重复定位。")
        }
        var result = map
        var game = expected
        if expected.gameEngine == "wine" {
            game.unknownFields["tsumigeyaWineEnvironment"] = .string(expected.wineEnvironmentIdentity)
            let previousName = (expected.gamePath as NSString).lastPathComponent
            let proposed = (folder as NSString).appendingPathComponent(previousName)
            switch WineRuntime.resolveEntry(folder: folder, selected: proposed) {
            case .success(let entry): game.gamePath = entry
            case .failure(let error): throw Failure(error.message)
            }
            if let override = game.gameArgs?["executable"]?.stringValue,
               override.hasPrefix(DetectPath.gameDirForFiles(expected.gamePath) + "/") {
                let relative = String(override.dropFirst(DetectPath.gameDirForFiles(expected.gamePath).count + 1))
                game.gameArgs?["executable"] = .string((folder as NSString).appendingPathComponent(relative))
            }
        } else { game.gamePath = (folder as NSString).appendingPathComponent("Game.exe") }
        result.games[game.id] = game
        return result
    }
}
