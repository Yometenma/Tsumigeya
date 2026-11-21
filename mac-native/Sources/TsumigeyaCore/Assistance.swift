import Foundation

public enum AssistanceError: LocalizedError, Sendable {
    case invalid(String)
    public var errorDescription: String? { if case .invalid(let message) = self { return message }; return nil }
}

public struct AssistanceProject: Sendable, Equatable {
    public let root: URL
    public let page: URL
    public let content: URL
    public let edition: String
    public let identity: String
    public let engine: AssistanceEngine
    public var displayName: String { engine == .rpgMaker || engine == .rgss ? "RPG Maker \(edition)" : engine.title }
    public var module: AssistanceModuleInfo { AssistanceModules.forEngine(engine) }
    public var usesFileBridge: Bool { module.transport == .fileBridge }

    public static func detect(folder: String) throws -> Self {
        try AssistanceModules.detect(URL(fileURLWithPath: folder).standardizedFileURL.resolvingSymlinksInPath())
    }
}

public typealias RPGMakerProject = AssistanceProject

public enum AssistanceEngine: String, Codable, CaseIterable, Sendable {
    case rpgMaker, rgss, renpy, tyrano
    public var title: String {
        AssistanceModules.forEngine(self).title
    }
}

public struct AssistanceOptions: Sendable, Equatable {
    public var translation = false
    public var cheats = false
    public init(translation: Bool = false, cheats: Bool = false) { self.translation = translation; self.cheats = cheats }
    public var json: [String: JSONValue] { ["translation": .bool(translation), "cheats": .bool(cheats)] }
}

public enum AssistanceProcesses {
    public static func isRunning(_ project: RPGMakerProject) throws -> Bool {
        let process = Process(); process.executableURL = URL(fileURLWithPath: "/bin/ps")
        process.arguments = ["-axo", "pid=,command="]
        let pipe = Pipe(); process.standardOutput = pipe; process.standardError = FileHandle.nullDevice
        try process.run(); let data = pipe.fileHandleForReading.readDataToEndOfFile(); process.waitUntilExit()
        guard process.terminationStatus == 0 else { throw AssistanceError.invalid(L10n.string("无法核对游戏进程，未修改辅助文件。")) }
        return String(decoding: data, as: UTF8.self).components(separatedBy: .newlines).contains { line in
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            let parts = trimmed.split(maxSplits: 1, whereSeparator: { $0.isWhitespace })
            guard parts.count == 2, Int32(parts[0]) != ProcessInfo.processInfo.processIdentifier else { return false }
            let command = String(parts[1])
            return AssistanceModules.module(for: project.engine).matchesProcess(command, project: project)
        }
    }
}

public enum AssistanceInstaller {
    public static let directory = ".tsumigeya-assist"
    private static let tag = "<script data-tsumigeya-assist=\"1\" src=\".tsumigeya-assist/loader.js\"></script>"
    private static func files(_ project: AssistanceProject) -> [String] { AssistanceModules.module(for: project.engine).scripts.map(\.filename) }

    static func resource(_ name: String) throws -> Data {
        let packaged = Bundle.main.resourceURL?.appendingPathComponent("Tsumigeya_TsumigeyaCore.bundle")
        let url = packaged.flatMap { Bundle(url: $0)?.url(forResource: name, withExtension: nil, subdirectory: "Assist") }
            ?? Bundle.module.url(forResource: name, withExtension: nil, subdirectory: "Assist")
        guard let url else { throw AssistanceError.invalid(String(format: L10n.string("应用缺少辅助脚本：%@"), "\(name)")) }
        return try Data(contentsOf: url)
    }

    private static func runtimeResource(_ name: String, project: AssistanceProject) throws -> Data {
        guard let mapped = AssistanceModules.module(for: project.engine).scripts.first(where: { $0.filename == name })?.resource else {
            throw AssistanceError.invalid(String(format: L10n.string("引擎模块未声明辅助脚本：%@"), "\(name)"))
        }
        return try resource(mapped)
    }

    public static func location(_ project: RPGMakerProject) -> URL { project.content.appendingPathComponent(directory) }

    private static func checkedDirectory(_ project: RPGMakerProject) throws -> URL {
        let dir = location(project)
        guard dir.resolvingSymlinksInPath().path == dir.path else { throw AssistanceError.invalid(L10n.string("辅助目录是符号链接，拒绝写入。")) }
        return dir
    }

    public static func options(_ project: RPGMakerProject) throws -> AssistanceOptions? {
        if project.usesFileBridge { return try NativeAssistance.options(project) }
        let dir = try checkedDirectory(project)
        guard FileManager.default.fileExists(atPath: dir.path) else { return nil }
        _ = try manifest(project)
        let data = try JSONDecoder().decode([String: JSONValue].self, from: Data(contentsOf: dir.appendingPathComponent("config.json")))
        return .init(translation: data["translation"]?.boolValue ?? false, cheats: data["cheats"]?.boolValue ?? false)
    }

    private static func manifest(_ project: RPGMakerProject) throws -> [String: JSONValue] {
        let dir = try checkedDirectory(project)
        let url = dir.appendingPathComponent("manifest.json")
        for name in files(project) + ["manifest.json", "original.html", "config.json", "translations.json"] {
            let owned = dir.appendingPathComponent(name)
            guard owned.resolvingSymlinksInPath().path == owned.path else { throw AssistanceError.invalid(String(format: L10n.string("辅助文件是符号链接，拒绝访问：%@"), "\(name)")) }
        }
        let value = try JSONDecoder().decode([String: JSONValue].self, from: Data(contentsOf: url))
        guard value["schema"]?.intValue == 1, value["identity"]?.stringValue == project.identity,
              value["page"]?.stringValue == project.page.path,
              value["original"]?.stringValue == SHA256.hexOfFile(at: dir.appendingPathComponent("original.html").path),
              value["installed"]?.stringValue == SHA256.hexOfFile(at: project.page.path) else {
            throw AssistanceError.invalid(L10n.string("游戏入口或备份已改变，不能覆盖。请先手动核对原件与辅助目录。"))
        }
        return value
    }

    private static func safeWrite(_ data: Data, to url: URL) throws {
        guard url.resolvingSymlinksInPath().path == url.path else { throw AssistanceError.invalid(L10n.string("目标文件是符号链接，拒绝写入。")) }
        if FileManager.default.fileExists(atPath: url.path) {
            let backup = url.appendingPathExtension("bak")
            guard backup.resolvingSymlinksInPath().path == backup.path else { throw AssistanceError.invalid(L10n.string("备份文件是符号链接，拒绝写入。")) }
            let old = try Data(contentsOf: url)
            if url.pathExtension == "json" { _ = try JSONDecoder().decode(JSONValue.self, from: old) }
            try old.write(to: backup, options: .atomic)
        }
        try data.write(to: url, options: .atomic)
    }

    public static func configure(_ project: RPGMakerProject, options: AssistanceOptions,
                                 translations: [String: String]? = nil, running: Bool) throws {
        try AssistanceModules.validate(options, for: project)
        if project.usesFileBridge { try NativeAssistance.configure(project, options: options, translations: translations, running: running); return }
        guard try RPGMakerProject.detect(folder: project.root.path) == project else { throw AssistanceError.invalid(L10n.string("游戏目录或数据库已改变，请重新读取配置。")) }
        guard !running, try !AssistanceProcesses.isRunning(project) else { throw AssistanceError.invalid(L10n.string("请先关闭游戏，再更改辅助功能。")) }
        for (source, target) in translations ?? [:] { try TranslationTokens.validate(source: source, target: target) }
        let fm = FileManager.default
        let dir = try checkedDirectory(project)
        if fm.fileExists(atPath: dir.path) {
            _ = try manifest(project)
            let existingTranslations = try JSONDecoder().decode([String: String].self, from: Data(contentsOf: dir.appendingPathComponent("translations.json")))
            var config = try JSONDecoder().decode([String: JSONValue].self, from: Data(contentsOf: dir.appendingPathComponent("config.json")))
            config.merge(options.json) { _, new in new }
            // 所有备份先完成，再更新脚本；失败报告具体保存范围，不假装跨文件事务。
            var updates: [(URL, Data)] = []
            for name in files(project) {
                let url = dir.appendingPathComponent(name)
                let bytes = try runtimeResource(name, project: project)
                if try Data(contentsOf: url) != bytes { updates.append((url, bytes)) }
            }
            updates.append((dir.appendingPathComponent("translations.json"), try JSONEncoder().encode(translations ?? existingTranslations)))
            updates.append((dir.appendingPathComponent("config.json"), try JSONEncoder().encode(config)))
            for (url, _) in updates {
                let backup = url.appendingPathExtension("bak")
                guard backup.resolvingSymlinksInPath().path == backup.path else { throw AssistanceError.invalid(L10n.string("备份是符号链接。")) }
                try Data(contentsOf: url).write(to: backup, options: .atomic)
            }
            var saved: [String] = []
            do {
                for (url, bytes) in updates { try bytes.write(to: url, options: .atomic); saved.append(url.lastPathComponent) }
            } catch { throw AssistanceError.invalid(String(format: L10n.string("已保存：%@；其余文件未完成：%@"), "\(saved.isEmpty ? "无" : saved.joined(separator: "、"))", "\(error.localizedDescription)")) }
            return
        }
        let original = try Data(contentsOf: project.page)
        guard let html = String(data: original, encoding: .utf8),
              !html.contains("data-tsumigeya-assist"),
              let end = html.range(of: "</body>", options: [.caseInsensitive, .backwards]) else {
            throw AssistanceError.invalid(L10n.string("启动页面不是可识别的 UTF-8 HTML，不能安全添加辅助入口。"))
        }
        let installed = Data((String(html[..<end.lowerBound]) + tag + "\n" + String(html[end.lowerBound...])).utf8)
        var payload: [String: Data] = [:]
        for name in files(project) {
            payload[name] = try runtimeResource(name, project: project)
        }
        try fm.createDirectory(at: dir, withIntermediateDirectories: false)
        do {
            try original.write(to: dir.appendingPathComponent("original.html"), options: .withoutOverwriting)
            for (name, data) in payload { try data.write(to: dir.appendingPathComponent(name), options: .withoutOverwriting) }
            try JSONEncoder().encode(options.json).write(to: dir.appendingPathComponent("config.json"), options: .withoutOverwriting)
            try JSONEncoder().encode(translations ?? [:]).write(to: dir.appendingPathComponent("translations.json"), options: .withoutOverwriting)
            let record: [String: JSONValue] = ["schema": .int(1), "identity": .string(project.identity),
                "page": .string(project.page.path), "original": .string(SHA256.hex(Array(original))),
                "installed": .string(SHA256.hex(Array(installed)))]
            try JSONEncoder().encode(record).write(to: dir.appendingPathComponent("manifest.json"), options: .withoutOverwriting)
            guard try Data(contentsOf: project.page) == original else { throw AssistanceError.invalid(L10n.string("安装期间游戏入口发生变化，已停止。")) }
            try installed.write(to: project.page, options: .atomic)
        } catch {
            // 入口最后提交；之前失败只清理这次创建的目录，不碰游戏文件。
            if (try? Data(contentsOf: project.page)) == original { try? fm.removeItem(at: dir) }
            throw error
        }
    }

    public static func updateTranslations(_ project: RPGMakerProject, translations: [String: String]) throws {
        if project.usesFileBridge { try NativeAssistance.updateTranslations(project, translations); return }
        guard try RPGMakerProject.detect(folder: project.root.path) == project else { throw AssistanceError.invalid(L10n.string("游戏身份已改变，已停止更新译文。")) }
        _ = try manifest(project)
        for (source, target) in translations { try TranslationTokens.validate(source: source, target: target) }
        try safeWrite(JSONEncoder().encode(translations), to: location(project).appendingPathComponent("translations.json"))
    }

    public static func capturedText(_ project: RPGMakerProject) throws -> [TranslationEntry] {
        if project.usesFileBridge { _ = try NativeAssistance.options(project) } else { _ = try manifest(project) }
        let url = location(project).appendingPathComponent("missing.json")
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        guard url.resolvingSymlinksInPath().path == url.path else { throw AssistanceError.invalid(L10n.string("待译文本文件是符号链接。")) }
        let data = try Data(contentsOf: url)
        guard data.count <= 32 * 1024 * 1024 else { throw AssistanceError.invalid(L10n.string("待译文本文件过大。")) }
        let texts = try JSONDecoder().decode([String].self, from: data)
        guard texts.count <= 5000, texts.allSatisfy({ !$0.isEmpty && $0.count <= 4096 }) else { throw AssistanceError.invalid(L10n.string("待译文本超出限制。")) }
        return texts.map { TranslationEntry(source: $0, contexts: [L10n.string("游戏运行时捕获")]) }
    }

    public static func restore(_ project: RPGMakerProject, running: Bool) throws {
        if project.usesFileBridge { try NativeAssistance.restore(project, running: running); return }
        guard !running, try !AssistanceProcesses.isRunning(project) else { throw AssistanceError.invalid(L10n.string("请先关闭游戏，再恢复原始入口。")) }
        _ = try manifest(project)
        let dir = try checkedDirectory(project)
        let allowed = Set(files(project) + files(project).map { $0 + ".bak" } + ["manifest.json", "original.html", "config.json", "config.json.bak", "translations.json", "translations.json.bak", "missing.json", "missing.tmp", ".DS_Store"])
        let names = try FileManager.default.contentsOfDirectory(atPath: dir.path)
        guard names.allSatisfy({ name in
            var isDirectory: ObjCBool = false
            _ = FileManager.default.fileExists(atPath: dir.appendingPathComponent(name).path, isDirectory: &isDirectory)
            return allowed.contains(name) && !isDirectory.boolValue
        }) else { throw AssistanceError.invalid(L10n.string("辅助目录包含未识别文件，已保留全部文件。请先移走自添文件再恢复。")) }
        let original = try Data(contentsOf: dir.appendingPathComponent("original.html"))
        try original.write(to: project.page, options: .atomic)
        do { try FileManager.default.removeItem(at: dir) }
        catch { throw AssistanceError.invalid(String(format: L10n.string("原始入口已恢复，但辅助目录清理失败：%@"), "\(error.localizedDescription)")) }
    }
}
