import Foundation
import CryptoKit

public enum NativeAssistance {
    static func hash(_ url: URL, within root: URL) throws -> String {
        guard url.standardizedFileURL.path == url.resolvingSymlinksInPath().path,
              url.standardizedFileURL.path.hasPrefix(root.path + "/"),
              try url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else {
            throw AssistanceError.invalid("游戏身份文件不存在或经过符号链接。")
        }
        // 加密归档可能很大，按块校验，不能把整份归档复制进内存。
        let stream = try FileHandle(forReadingFrom: url)
        defer { try? stream.close() }
        var digest = CryptoKit.SHA256()
        while let chunk = try stream.read(upToCount: 1024 * 1024), !chunk.isEmpty { digest.update(data: chunk) }
        return digest.finalize().map { String(format: "%02x", $0) }.joined()
    }

    static func detect(_ root: URL) throws -> AssistanceProject? {
        let fm = FileManager.default
        let ini = root.appendingPathComponent("Game.ini")
        if fm.fileExists(atPath: ini.path), let text = String(data: try Data(contentsOf: ini), encoding: .isoLatin1) {
            let lines = text.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            if let line = lines.first(where: { $0.lowercased().hasPrefix("scripts=") }) {
                let path = String(line.dropFirst(8)).replacingOccurrences(of: "\\", with: "/")
                let ext = (path as NSString).pathExtension.lowercased()
                let edition = ["rxdata": "XP", "rvdata": "VX", "rvdata2": "VX Ace"][ext]
                if let edition {
                    _ = try hash(ini, within: root)
                    let scripts = root.appendingPathComponent(path).standardizedFileURL
                    let archive = root.appendingPathComponent(["XP": "Game.rgssad", "VX": "Game.rgss2a", "VX Ace": "Game.rgss3a"][edition]!)
                    guard let identityFile = fm.fileExists(atPath: scripts.path) ? scripts : (fm.fileExists(atPath: archive.path) ? archive : nil) else { throw AssistanceError.invalid("缺少 RGSS 脚本数据或游戏归档。") }
                    let digest = try hash(identityFile, within: root)
                    let identity = SHA256.hex(Array((root.path + "\0" + identityFile.path + "\0" + digest + "\0" + edition).utf8))
                    return .init(root: root, page: ini, content: root, edition: edition, identity: identity, engine: .rgss)
                }
            }
        }
        let game = root.appendingPathComponent("game")
        if fm.fileExists(atPath: root.appendingPathComponent("renpy").path), fm.fileExists(atPath: game.path) {
            guard game.resolvingSymlinksInPath().path == game.path else { throw AssistanceError.invalid("Ren’Py 游戏数据目录不能是符号链接。") }
            guard let enumerator = fm.enumerator(at: game, includingPropertiesForKeys: [.isSymbolicLinkKey, .isRegularFileKey], options: [.skipsHiddenFiles]) else { throw AssistanceError.invalid("无法读取 Ren’Py 游戏目录。") }
            var files: [URL] = []
            for case let url as URL in enumerator {
                let values = try url.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey])
                if values.isSymbolicLink == true || ["cache", "saves"].contains(url.lastPathComponent) { enumerator.skipDescendants(); continue }
                guard values.isRegularFile == true, ["rpy", "rpyc", "rpa"].contains(url.pathExtension),
                      url.deletingPathExtension().lastPathComponent != "zz_tsumigeya_assist",
                      !(url.pathExtension == "rpyc" && fm.fileExists(atPath: url.deletingPathExtension().appendingPathExtension("rpy").path)) else { continue }
                files.append(url.standardizedFileURL)
                guard files.count <= 10000 else { throw AssistanceError.invalid("Ren’Py 身份文件数量超出限制。") }
            }
            guard !files.isEmpty else { throw AssistanceError.invalid("未找到 Ren’Py 剧本或资源归档。") }
            let signature = try files.sorted { $0.path < $1.path }.map {
                String($0.path.dropFirst(game.path.count + 1)) + ":" + (try hash($0, within: root))
            }.joined(separator: "\0")
            let identity = SHA256.hex(Array((root.path + "\0RenPy\0" + signature).utf8))
            return .init(root: root, page: game.appendingPathComponent("zz_tsumigeya_assist.rpy"), content: game, edition: "Ren’Py", identity: identity, engine: .renpy)
        }
        return nil
    }
    private static func scriptFiles(_ p: AssistanceProject) -> [String] { p.engine == .renpy ? ["renpy.py"] : ["rgss.rb"] }
    private static func directory(_ p: AssistanceProject) throws -> URL {
        let url = AssistanceInstaller.location(p)
        guard url.path == url.resolvingSymlinksInPath().path else { throw AssistanceError.invalid("辅助目录不能是符号链接。") }
        return url
    }
    private static func checked(_ name: String, in dir: URL) throws -> URL {
        let url = dir.appendingPathComponent(name)
        guard url.path == url.resolvingSymlinksInPath().path else { throw AssistanceError.invalid("辅助文件不能是符号链接：\(name)") }
        return url
    }
    private static func manifest(_ p: AssistanceProject) throws -> [String: JSONValue] {
        let dir = try directory(p)
        let record = try JSONDecoder().decode([String: JSONValue].self, from: Data(contentsOf: checked("manifest.json", in: dir)))
        guard record["schema"]?.intValue == 2, record["identity"]?.stringValue == p.identity else { throw AssistanceError.invalid("辅助记录不属于当前游戏。") }
        for name in scriptFiles(p) {
            let url = try checked(name, in: dir)
            guard record[name]?.stringValue == SHA256.hexOfFile(at: url.path) else { throw AssistanceError.invalid("辅助脚本已被外部修改，停止覆盖：\(name)") }
        }
        if p.engine == .renpy {
            guard p.page.path == p.page.resolvingSymlinksInPath().path, record["entry"]?.stringValue == SHA256.hexOfFile(at: p.page.path) else { throw AssistanceError.invalid("Ren’Py 辅助入口已改变。") }
        }
        return record
    }
    static func options(_ p: AssistanceProject) throws -> AssistanceOptions? {
        let dir = try directory(p)
        guard FileManager.default.fileExists(atPath: dir.path) else { return nil }
        _ = try manifest(p)
        let json = try JSONDecoder().decode([String: JSONValue].self, from: Data(contentsOf: checked("config.json", in: dir)))
        return .init(translation: json["translation"]?.boolValue ?? false, cheats: json["cheats"]?.boolValue ?? false)
    }
    private static let renpyEntry = """
    init 999 python hide:
        import os as _tsumigeya_os
        import types as _tsumigeya_types
        import sys as _tsumigeya_sys
        _tsumigeya_file = _tsumigeya_os.path.join(config.gamedir, '.tsumigeya-assist', 'renpy.py')
        _tsumigeya_module = _tsumigeya_types.ModuleType('_tsumigeya_runtime')
        _tsumigeya_sys.modules['_tsumigeya_runtime'] = _tsumigeya_module
        with open(_tsumigeya_file, 'rb') as _tsumigeya_stream:
            exec(compile(_tsumigeya_stream.read(), _tsumigeya_file, 'exec'), _tsumigeya_module.__dict__)
        _tsumigeya_module.install(renpy)

    """
    static func configure(_ p: AssistanceProject, options: AssistanceOptions, translations: [String: String]?, running: Bool) throws {
        guard try AssistanceProject.detect(folder: p.root.path) == p else { throw AssistanceError.invalid("游戏身份已改变。") }
        guard !running, try !AssistanceProcesses.isRunning(p) else { throw AssistanceError.invalid("请先关闭游戏，再修改辅助功能。") }
        for (s,t) in translations ?? [:] { try TranslationTokens.validate(source: s, target: t) }
        let dir = try directory(p), fm = FileManager.default
        let exists = fm.fileExists(atPath: dir.path)
        var record: [String: JSONValue] = ["schema": .int(2), "identity": .string(p.identity)]
        var config = options.json
        config["identity"] = .string(p.identity)
        config["engine"] = .string(p.engine.rawValue)
        config["edition"] = .string(p.edition)
        if exists {
            record = try manifest(p)
            var prior = try JSONDecoder().decode([String: JSONValue].self, from: Data(contentsOf: checked("config.json", in: dir)))
            prior.merge(config) { _, new in new }; config = prior
        } else if p.engine == .renpy {
            for entry in [p.page, p.page.appendingPathExtension("bak"), p.page.deletingPathExtension().appendingPathExtension("rpyc")] {
                guard entry.path == entry.resolvingSymlinksInPath().path, !fm.fileExists(atPath: entry.path) else { throw AssistanceError.invalid("同名辅助入口已存在，拒绝覆盖。") }
            }
        }
        let dictionary: [String: String]
        if exists { dictionary = try JSONDecoder().decode([String: String].self, from: Data(contentsOf: checked("translations.json", in: dir))) }
        else { dictionary = [:] }
        var writes: [(URL, Data)] = []
        for name in scriptFiles(p) {
            let data = try AssistanceInstaller.resource(name)
            record[name] = .string(SHA256.hex(Array(data)))
            writes.append((try checked(name, in: dir), data))
        }
        let entryData = p.engine == .renpy ? Data(renpyEntry.utf8) : nil
        if let entryData { record["entry"] = .string(SHA256.hex(Array(entryData))) }
        writes.append((try checked("config.json", in: dir), try JSONEncoder().encode(config)))
        writes.append((try checked("translations.json", in: dir), try JSONEncoder().encode(translations ?? dictionary)))
        writes.append((try checked("manifest.json", in: dir), try JSONEncoder().encode(record)))
        // 最后才放入入口，避免新安装时配置写失败却让游戏加载不完整辅助。
        if let entryData { writes.append((p.page, entryData)) }
        if exists {
            // 先读完并备份全部目标，任何备份失败都不进入写入阶段。
            for (url, _) in writes {
                if url.pathExtension == "json" { _ = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url)) }
                let bak = url.appendingPathExtension("bak")
                guard bak.path == bak.resolvingSymlinksInPath().path else { throw AssistanceError.invalid("辅助备份是符号链接。") }
                try Data(contentsOf: url).write(to: bak, options: .atomic)
            }
        } else { try fm.createDirectory(at: dir, withIntermediateDirectories: false) }
        var saved: [String] = []
        do {
            for (url, data) in writes { try data.write(to: url, options: exists ? .atomic : .withoutOverwriting); saved.append(url.lastPathComponent) }
        } catch { throw AssistanceError.invalid("已保存：\(saved.joined(separator: "、"))；其余辅助文件未完成：\(error.localizedDescription)") }
    }
    static func updateTranslations(_ p: AssistanceProject, _ translations: [String: String]) throws {
        guard try AssistanceProject.detect(folder: p.root.path) == p else { throw AssistanceError.invalid("游戏身份已改变。") }
        _ = try manifest(p)
        for (s,t) in translations { try TranslationTokens.validate(source: s, target: t) }
        let url = try checked("translations.json", in: directory(p))
        _ = try JSONDecoder().decode([String: String].self, from: Data(contentsOf: url))
        let backup = try checked("translations.json.bak", in: directory(p))
        try Data(contentsOf: url).write(to: backup, options: .atomic)
        try JSONEncoder().encode(translations).write(to: url, options: .atomic)
    }
    static func restore(_ p: AssistanceProject, running: Bool) throws {
        guard !running, try !AssistanceProcesses.isRunning(p) else { throw AssistanceError.invalid("请先关闭游戏，再移除辅助。") }
        _ = try manifest(p)
        let dir = try directory(p), fm = FileManager.default
        let names = scriptFiles(p) + ["config.json", "translations.json", "manifest.json", "missing.json", "state.json", "command.json", "extracted.json"]
        let allowed = Set(names + names.map { $0 + ".bak" } + ["missing.tmp", "state.tmp", "command.tmp", "extracted.tmp", ".DS_Store"])
        for name in try fm.contentsOfDirectory(atPath: dir.path) {
            let url = try checked(name, in: dir)
            guard allowed.contains(name), (try url.resourceValues(forKeys: [.isRegularFileKey])).isRegularFile == true else { throw AssistanceError.invalid("辅助目录含未知文件，未移除任何文件。") }
        }
        var targets: [URL] = []
        if p.engine == .renpy {
            let compiled = p.page.deletingPathExtension().appendingPathExtension("rpyc")
            for url in [compiled, p.page.appendingPathExtension("bak")] where fm.fileExists(atPath: url.path) {
                guard url.path == url.resolvingSymlinksInPath().path, (try url.resourceValues(forKeys: [.isRegularFileKey])).isRegularFile == true else { throw AssistanceError.invalid("辅助编译文件不安全。") }
                targets.append(url)
            }
            targets.append(p.page)
        }
        var removed: [String] = []
        do {
            for url in targets { try fm.removeItem(at: url); removed.append(url.lastPathComponent) }
            try fm.removeItem(at: dir)
        } catch {
            throw AssistanceError.invalid("已移除：\(removed.isEmpty ? "无" : removed.joined(separator: "、"))；其余辅助文件未完成移除：\(error.localizedDescription)")
        }
    }

    static func translationFontRoot(for folder: String, dataDir: String) throws -> String? {
        guard let p = try detect(URL(fileURLWithPath: folder).standardizedFileURL.resolvingSymlinksInPath()),
              p.engine == .rgss, try options(p)?.translation == true else { return nil }
        return try MkxpzTranslationFont.prepare(dataDir: dataDir)
    }

    public static func preload(for folder: String) throws -> String? {
        guard let p = try detect(URL(fileURLWithPath: folder).standardizedFileURL.resolvingSymlinksInPath()), p.engine == .rgss,
              try options(p) != nil else { return nil }
        return AssistanceInstaller.location(p).appendingPathComponent("rgss.rb").path
    }
}

public struct AssistanceVariable: Codable, Sendable, Identifiable {
    public var key: String
    public var name: String
    public var value: JSONValue
    public var locked: Bool
    public var id: String { key }
}
public struct AssistanceSnapshot: Codable, Sendable {
    public var identity: String
    public var session: String
    public var updated: Double
    public var ready: Bool
    public var variables: [AssistanceVariable]
    public var ack: String?
    public var error: String?
}
public enum AssistanceBridge {
    public static func read(_ p: AssistanceProject, now: Date = .now) throws -> AssistanceSnapshot {
        _ = try NativeAssistance.options(p)
        let url = AssistanceInstaller.location(p).appendingPathComponent("state.json")
        guard url.path == url.resolvingSymlinksInPath().path else { throw AssistanceError.invalid("运行状态是符号链接。") }
        let data = try Data(contentsOf: url)
        guard data.count <= 4 * 1024 * 1024 else { throw AssistanceError.invalid("运行状态过大。") }
        let state = try JSONDecoder().decode(AssistanceSnapshot.self, from: data)
        guard state.identity == p.identity, !state.session.isEmpty, abs(now.timeIntervalSince1970 - state.updated) < 6,
              state.variables.count <= 10000, Set(state.variables.map(\.key)).count == state.variables.count else { throw AssistanceError.invalid("游戏尚未连接或状态已过期，请启动游戏并进入可操作画面。") }
        return state
    }
    @discardableResult public static func send(_ p: AssistanceProject, snapshot: AssistanceSnapshot, action: String, key: String, value: JSONValue = .null) throws -> String {
        let current = try read(p)
        guard current.session == snapshot.session, current.ready, ["set", "lock", "unlock", "reset"].contains(action),
              action == "reset" || current.variables.contains(where: { $0.key == key }) else { throw AssistanceError.invalid("游戏状态已改变，请刷新后重试。") }
        let url = AssistanceInstaller.location(p).appendingPathComponent("command.json")
        guard url.path == url.resolvingSymlinksInPath().path else { throw AssistanceError.invalid("命令文件是符号链接。") }
        let id = UUID().uuidString
        let command: [String: JSONValue] = ["id": .string(id), "session": .string(current.session), "identity": .string(p.identity), "expires": .double(Date.now.timeIntervalSince1970 + 5), "action": .string(action), "key": .string(key), "value": value]
        try JSONEncoder().encode(command).write(to: url, options: .atomic)
        return id
    }
}
