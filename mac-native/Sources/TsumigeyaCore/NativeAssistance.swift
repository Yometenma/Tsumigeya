import Foundation
import CryptoKit

public enum NativeAssistance {
    static func hash(_ url: URL, within root: URL) throws -> String {
        guard url.standardizedFileURL.path == url.resolvingSymlinksInPath().path,
              url.standardizedFileURL.path.hasPrefix(root.path + "/"),
              try url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true else {
            throw AssistanceError.invalid(L10n.string("游戏身份文件不存在或经过符号链接。"))
        }
        // 加密归档可能很大，按块校验，不能把整份归档复制进内存。
        let stream = try FileHandle(forReadingFrom: url)
        defer { try? stream.close() }
        var digest = CryptoKit.SHA256()
        while let chunk = try stream.read(upToCount: 1024 * 1024), !chunk.isEmpty { digest.update(data: chunk) }
        return digest.finalize().map { String(format: "%02x", $0) }.joined()
    }

    static func detect(_ root: URL) throws -> AssistanceProject? {
        for module in AssistanceModules.registered where module.info.transport == .fileBridge {
            if let project = try module.detect(root) { return project }
        }
        return nil
    }
    private static func scriptFiles(_ p: AssistanceProject) -> [String] { AssistanceModules.module(for: p.engine).scripts.map(\.filename) }
    private static func directory(_ p: AssistanceProject) throws -> URL {
        let url = AssistanceInstaller.location(p)
        guard url.path == url.resolvingSymlinksInPath().path else { throw AssistanceError.invalid(L10n.string("辅助目录不能是符号链接。")) }
        return url
    }
    private static func checked(_ name: String, in dir: URL) throws -> URL {
        let url = dir.appendingPathComponent(name)
        guard url.path == url.resolvingSymlinksInPath().path else { throw AssistanceError.invalid(String(format: L10n.string("辅助文件不能是符号链接：%@"), "\(name)")) }
        return url
    }
    private static func manifest(_ p: AssistanceProject) throws -> [String: JSONValue] {
        let dir = try directory(p)
        let record = try JSONDecoder().decode([String: JSONValue].self, from: Data(contentsOf: checked("manifest.json", in: dir)))
        guard record["schema"]?.intValue == 2, record["identity"]?.stringValue == p.identity else { throw AssistanceError.invalid(L10n.string("辅助记录不属于当前游戏。")) }
        for name in scriptFiles(p) {
            let url = try checked(name, in: dir)
            guard record[name]?.stringValue == SHA256.hexOfFile(at: url.path) else { throw AssistanceError.invalid(String(format: L10n.string("辅助脚本已被外部修改，停止覆盖：%@"), "\(name)")) }
        }
        if AssistanceModules.module(for: p.engine).entrySource != nil {
            guard p.page.path == p.page.resolvingSymlinksInPath().path, record["entry"]?.stringValue == SHA256.hexOfFile(at: p.page.path) else { throw AssistanceError.invalid(L10n.string("Ren’Py 辅助入口已改变。")) }
        }
        return record
    }
    static func options(_ p: AssistanceProject) throws -> AssistanceOptions? {
        let dir = try directory(p)
        guard FileManager.default.fileExists(atPath: dir.path) else { return nil }
        _ = try manifest(p)
        let json = try JSONDecoder().decode([String: JSONValue].self, from: Data(contentsOf: checked("config.json", in: dir)))
        return .init(translation: json["translation"]?.boolValue ?? false, cheats: json["cheats"]?.boolValue ?? false,
                     fontScale: json["fontScale"]?.doubleValue ?? 0.92)
    }
    static func configure(_ p: AssistanceProject, options: AssistanceOptions, translations: [String: String]?, running: Bool) throws {
        guard try AssistanceProject.detect(folder: p.root.path) == p else { throw AssistanceError.invalid(L10n.string("游戏身份已改变。")) }
        guard !running, try !AssistanceProcesses.isRunning(p) else { throw AssistanceError.invalid(L10n.string("请先关闭游戏，再修改辅助功能。")) }
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
        } else if AssistanceModules.module(for: p.engine).entrySource != nil {
            // 入口旁的备份名也认旧后缀：`game.rpy.bak` 是早期版本留下的。
            let compiled = p.page.deletingPathExtension().appendingPathExtension("rpyc")
            let guarded = [p.page, compiled] + Backup.backupNames(p.page.path).map { URL(fileURLWithPath: $0) }
            for entry in guarded {
                guard entry.path == entry.resolvingSymlinksInPath().path, !fm.fileExists(atPath: entry.path) else { throw AssistanceError.invalid(L10n.string("同名辅助入口已存在，拒绝覆盖。")) }
            }
        }
        let dictionary: [String: String]
        if exists { dictionary = try JSONDecoder().decode([String: String].self, from: Data(contentsOf: checked("translations.json", in: dir))) }
        else { dictionary = [:] }
        var writes: [(URL, Data)] = []
        for script in AssistanceModules.module(for: p.engine).scripts {
            let name = script.filename
            let data = try AssistanceInstaller.resource(script.resource)
            record[name] = .string(SHA256.hex(Array(data)))
            writes.append((try checked(name, in: dir), data))
        }
        let entryData = AssistanceModules.module(for: p.engine).entrySource.map { Data($0.utf8) }
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
                let bak = Backup.path(for: url)
                guard bak.path == bak.resolvingSymlinksInPath().path else { throw AssistanceError.invalid(L10n.string("辅助备份是符号链接。")) }
                try Data(contentsOf: url).write(to: bak, options: .atomic)
            }
        } else { try fm.createDirectory(at: dir, withIntermediateDirectories: false) }
        var saved: [String] = []
        do {
            for (url, data) in writes { try data.write(to: url, options: exists ? .atomic : .withoutOverwriting); saved.append(url.lastPathComponent) }
        } catch { throw AssistanceError.invalid(String(format: L10n.string("已保存：%@；其余辅助文件未完成：%@"), "\(saved.joined(separator: "、"))", "\(error.localizedDescription)")) }
    }
    static func updateTranslations(_ p: AssistanceProject, _ translations: [String: String]) throws {
        guard try AssistanceProject.detect(folder: p.root.path) == p else { throw AssistanceError.invalid(L10n.string("游戏身份已改变。")) }
        _ = try manifest(p)
        for (s,t) in translations { try TranslationTokens.validate(source: s, target: t) }
        let url = try checked("translations.json", in: directory(p))
        _ = try JSONDecoder().decode([String: String].self, from: Data(contentsOf: url))
        let backup = try checked("translations.json" + Backup.suffix, in: directory(p))
        try Data(contentsOf: url).write(to: backup, options: .atomic)
        try JSONEncoder().encode(translations).write(to: url, options: .atomic)
    }
    static func restore(_ p: AssistanceProject, running: Bool) throws {
        guard !running, try !AssistanceProcesses.isRunning(p) else { throw AssistanceError.invalid(L10n.string("请先关闭游戏，再移除辅助。")) }
        _ = try manifest(p)
        let dir = try directory(p), fm = FileManager.default
        let names = scriptFiles(p) + ["config.json", "translations.json", "manifest.json", "missing.json", "state.json", "command.json", "extracted.json"]
        // 允许清单同时认原名、新后缀备份与旧后缀备份：旧版本写下的 `*.json.bak` 还在目录里。
        let allowed = Set(names.flatMap(Backup.acceptedNames)
                          + ["missing.tmp", "state.tmp", "command.tmp", "extracted.tmp", ".DS_Store"])
        for name in try fm.contentsOfDirectory(atPath: dir.path) {
            let url = try checked(name, in: dir)
            guard allowed.contains(name), (try url.resourceValues(forKeys: [.isRegularFileKey])).isRegularFile == true else { throw AssistanceError.invalid(L10n.string("辅助目录含未知文件，未移除任何文件。")) }
        }
        var targets: [URL] = []
        if AssistanceModules.module(for: p.engine).entrySource != nil {
            let compiled = p.page.deletingPathExtension().appendingPathExtension("rpyc")
            let candidates = [compiled] + Backup.backupNames(p.page.path).map { URL(fileURLWithPath: $0) }
            for url in candidates where fm.fileExists(atPath: url.path) {
                guard url.path == url.resolvingSymlinksInPath().path, (try url.resourceValues(forKeys: [.isRegularFileKey])).isRegularFile == true else { throw AssistanceError.invalid(L10n.string("辅助编译文件不安全。")) }
                targets.append(url)
            }
            targets.append(p.page)
        }
        var removed: [String] = []
        do {
            for url in targets { try fm.removeItem(at: url); removed.append(url.lastPathComponent) }
            try fm.removeItem(at: dir)
        } catch {
            throw AssistanceError.invalid(String(format: L10n.string("已移除：%@；其余辅助文件未完成移除：%@"), "\(removed.isEmpty ? "无" : removed.joined(separator: "、"))", "\(error.localizedDescription)"))
        }
    }

    static func translationFontRoot(for folder: String, dataDir: String) throws -> String? {
        guard let p = try detect(URL(fileURLWithPath: folder).standardizedFileURL.resolvingSymlinksInPath()),
              AssistanceModules.module(for: p.engine).needsTranslationFont, try options(p)?.translation == true else { return nil }
        return try MkxpzTranslationFont.prepare(dataDir: dataDir)
    }

    public static func preload(for folder: String) throws -> String? {
        guard let p = try detect(URL(fileURLWithPath: folder).standardizedFileURL.resolvingSymlinksInPath()), let script = AssistanceModules.module(for: p.engine).preloadScript,
              try options(p) != nil else { return nil }
        return AssistanceInstaller.location(p).appendingPathComponent(script).path
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
        guard url.path == url.resolvingSymlinksInPath().path else { throw AssistanceError.invalid(L10n.string("运行状态是符号链接。")) }
        let data = try Data(contentsOf: url)
        guard data.count <= 4 * 1024 * 1024 else { throw AssistanceError.invalid(L10n.string("运行状态过大。")) }
        let state = try JSONDecoder().decode(AssistanceSnapshot.self, from: data)
        guard state.identity == p.identity, !state.session.isEmpty, abs(now.timeIntervalSince1970 - state.updated) < 6,
              state.variables.count <= 10000, Set(state.variables.map(\.key)).count == state.variables.count else { throw AssistanceError.invalid(L10n.string("游戏尚未连接或状态已过期，请启动游戏并进入可操作画面。")) }
        return state
    }
    @discardableResult public static func send(_ p: AssistanceProject, snapshot: AssistanceSnapshot, action: String, key: String, value: JSONValue = .null) throws -> String {
        let current = try read(p)
        guard current.session == snapshot.session, current.ready, ["set", "lock", "unlock", "reset"].contains(action),
              action == "reset" || current.variables.contains(where: { $0.key == key }) else { throw AssistanceError.invalid(L10n.string("游戏状态已改变，请刷新后重试。")) }
        let url = AssistanceInstaller.location(p).appendingPathComponent("command.json")
        guard url.path == url.resolvingSymlinksInPath().path else { throw AssistanceError.invalid(L10n.string("命令文件是符号链接。")) }
        let id = UUID().uuidString
        let command: [String: JSONValue] = ["id": .string(id), "session": .string(current.session), "identity": .string(p.identity), "expires": .double(Date.now.timeIntervalSince1970 + 5), "action": .string(action), "key": .string(key), "value": value]
        try JSONEncoder().encode(command).write(to: url, options: .atomic)
        return id
    }
}
