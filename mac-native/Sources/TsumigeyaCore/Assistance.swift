import Foundation

public enum AssistanceError: LocalizedError, Sendable {
    case invalid(String)
    public var errorDescription: String? { if case .invalid(let message) = self { return message }; return nil }
}

public struct RPGMakerProject: Sendable, Equatable {
    public let root: URL
    public let page: URL
    public let content: URL
    public let edition: String
    public let identity: String

    public static func detect(folder: String) throws -> Self {
        let root = URL(fileURLWithPath: folder).standardizedFileURL.resolvingSymlinksInPath()
        let package = root.appendingPathComponent("package.json")
        let json = try JSONDecoder().decode([String: JSONValue].self, from: Data(contentsOf: package))
        guard let main = json["main"]?.stringValue else { throw AssistanceError.invalid("游戏缺少有效的启动页面。") }
        let path = main.replacingOccurrences(of: "\\", with: "/").components(separatedBy: "?")[0].components(separatedBy: "#")[0]
        guard !path.hasPrefix("/"), !path.contains(":"), !path.isEmpty else { throw AssistanceError.invalid("游戏启动页面必须是游戏目录内的文件。") }
        let page = root.appendingPathComponent(path).standardizedFileURL.resolvingSymlinksInPath()
        guard page.path.hasPrefix(root.path + "/"), page.pathExtension.lowercased() == "html",
              FileManager.default.fileExists(atPath: page.path) else { throw AssistanceError.invalid("游戏启动页面不存在或越出游戏目录。") }
        let content = page.deletingLastPathComponent()
        let js = content.appendingPathComponent("js")
        let mv = FileManager.default.fileExists(atPath: js.appendingPathComponent("rpg_core.js").path)
        let mz = FileManager.default.fileExists(atPath: js.appendingPathComponent("rmmz_core.js").path)
        guard mv != mz, FileManager.default.fileExists(atPath: content.appendingPathComponent("data/System.json").path) else {
            throw AssistanceError.invalid("目前翻译与作弊支持 RPG Maker MV/MZ；这个游戏无法确认为其中一种。")
        }
        let system = content.appendingPathComponent("data/System.json").resolvingSymlinksInPath()
        guard system.path.hasPrefix(content.path + "/"), let hash = SHA256.hexOfFile(at: system.path) else {
            throw AssistanceError.invalid("无法验证游戏数据库身份。")
        }
        let identity = SHA256.hex(Array((root.path + "\0" + page.path + "\0" + hash + "\0" + (mv ? "MV" : "MZ")).utf8))
        return Self(root: root, page: page, content: content, edition: mv ? "MV" : "MZ", identity: identity)
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
        guard process.terminationStatus == 0 else { throw AssistanceError.invalid("无法核对游戏进程，未修改辅助文件。") }
        return String(decoding: data, as: UTF8.self).components(separatedBy: .newlines).contains { line in
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            let parts = trimmed.split(maxSplits: 1, whereSeparator: { $0.isWhitespace })
            guard parts.count == 2, Int32(parts[0]) != ProcessInfo.processInfo.processIdentifier else { return false }
            let command = String(parts[1])
            return command.contains(project.root.path) && command.lowercased().contains("nwjs")
        }
    }
}

public enum AssistanceInstaller {
    public static let directory = ".tsumigeya-assist"
    private static let tag = "<script data-tsumigeya-assist=\"1\" src=\".tsumigeya-assist/loader.js\"></script>"
    private static let files = ["loader.js", "translation.js", "cheats.js", "panel.js"]

    private static func resource(_ name: String) throws -> Data {
        let packaged = Bundle.main.resourceURL?.appendingPathComponent("Tsumigeya_TsumigeyaCore.bundle")
        let url = packaged.flatMap { Bundle(url: $0)?.url(forResource: name, withExtension: nil, subdirectory: "Assist") }
            ?? Bundle.module.url(forResource: name, withExtension: nil, subdirectory: "Assist")
        guard let url else { throw AssistanceError.invalid("应用缺少辅助脚本：\(name)") }
        return try Data(contentsOf: url)
    }

    public static func location(_ project: RPGMakerProject) -> URL { project.content.appendingPathComponent(directory) }

    private static func checkedDirectory(_ project: RPGMakerProject) throws -> URL {
        let dir = location(project)
        guard dir.resolvingSymlinksInPath().path == dir.path else { throw AssistanceError.invalid("辅助目录是符号链接，拒绝写入。") }
        return dir
    }

    public static func options(_ project: RPGMakerProject) throws -> AssistanceOptions? {
        let dir = try checkedDirectory(project)
        guard FileManager.default.fileExists(atPath: dir.path) else { return nil }
        _ = try manifest(project)
        let data = try JSONDecoder().decode([String: JSONValue].self, from: Data(contentsOf: dir.appendingPathComponent("config.json")))
        return .init(translation: data["translation"]?.boolValue ?? false, cheats: data["cheats"]?.boolValue ?? false)
    }

    private static func manifest(_ project: RPGMakerProject) throws -> [String: JSONValue] {
        let dir = try checkedDirectory(project)
        let url = dir.appendingPathComponent("manifest.json")
        for name in files + ["manifest.json", "original.html", "config.json", "translations.json"] {
            let owned = dir.appendingPathComponent(name)
            guard owned.resolvingSymlinksInPath().path == owned.path else { throw AssistanceError.invalid("辅助文件是符号链接，拒绝访问：\(name)") }
        }
        let value = try JSONDecoder().decode([String: JSONValue].self, from: Data(contentsOf: url))
        guard value["schema"]?.intValue == 1, value["identity"]?.stringValue == project.identity,
              value["page"]?.stringValue == project.page.path,
              value["original"]?.stringValue == SHA256.hexOfFile(at: dir.appendingPathComponent("original.html").path),
              value["installed"]?.stringValue == SHA256.hexOfFile(at: project.page.path) else {
            throw AssistanceError.invalid("游戏入口或备份已改变，不能覆盖。请先手动核对原件与辅助目录。")
        }
        return value
    }

    private static func safeWrite(_ data: Data, to url: URL) throws {
        guard url.resolvingSymlinksInPath().path == url.path else { throw AssistanceError.invalid("目标文件是符号链接，拒绝写入。") }
        if FileManager.default.fileExists(atPath: url.path) {
            let backup = url.appendingPathExtension("bak")
            guard backup.resolvingSymlinksInPath().path == backup.path else { throw AssistanceError.invalid("备份文件是符号链接，拒绝写入。") }
            let old = try Data(contentsOf: url)
            if url.pathExtension == "json" { _ = try JSONDecoder().decode(JSONValue.self, from: old) }
            try old.write(to: backup, options: .atomic)
        }
        try data.write(to: url, options: .atomic)
    }

    public static func configure(_ project: RPGMakerProject, options: AssistanceOptions,
                                 translations: [String: String]? = nil, running: Bool) throws {
        guard try RPGMakerProject.detect(folder: project.root.path) == project else { throw AssistanceError.invalid("游戏目录或数据库已改变，请重新读取配置。") }
        guard !running, try !AssistanceProcesses.isRunning(project) else { throw AssistanceError.invalid("请先关闭游戏，再更改辅助功能。") }
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
            for name in files {
                let url = dir.appendingPathComponent(name)
                let bytes = try resource(name)
                if try Data(contentsOf: url) != bytes { updates.append((url, bytes)) }
            }
            updates.append((dir.appendingPathComponent("translations.json"), try JSONEncoder().encode(translations ?? existingTranslations)))
            updates.append((dir.appendingPathComponent("config.json"), try JSONEncoder().encode(config)))
            for (url, _) in updates {
                let backup = url.appendingPathExtension("bak")
                guard backup.resolvingSymlinksInPath().path == backup.path else { throw AssistanceError.invalid("备份是符号链接。") }
                try Data(contentsOf: url).write(to: backup, options: .atomic)
            }
            var saved: [String] = []
            do {
                for (url, bytes) in updates { try bytes.write(to: url, options: .atomic); saved.append(url.lastPathComponent) }
            } catch { throw AssistanceError.invalid("已保存：\(saved.isEmpty ? "无" : saved.joined(separator: "、"))；其余文件未完成：\(error.localizedDescription)") }
            return
        }
        let original = try Data(contentsOf: project.page)
        guard let html = String(data: original, encoding: .utf8),
              !html.contains("data-tsumigeya-assist"),
              let end = html.range(of: "</body>", options: [.caseInsensitive, .backwards]) else {
            throw AssistanceError.invalid("启动页面不是可识别的 UTF-8 HTML，不能安全添加辅助入口。")
        }
        let installed = Data((String(html[..<end.lowerBound]) + tag + "\n" + String(html[end.lowerBound...])).utf8)
        var payload: [String: Data] = [:]
        for name in files {
            payload[name] = try resource(name)
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
            guard try Data(contentsOf: project.page) == original else { throw AssistanceError.invalid("安装期间游戏入口发生变化，已停止。") }
            try installed.write(to: project.page, options: .atomic)
        } catch {
            // 入口最后提交；之前失败只清理这次创建的目录，不碰游戏文件。
            if (try? Data(contentsOf: project.page)) == original { try? fm.removeItem(at: dir) }
            throw error
        }
    }

    public static func updateTranslations(_ project: RPGMakerProject, translations: [String: String]) throws {
        guard try RPGMakerProject.detect(folder: project.root.path) == project else { throw AssistanceError.invalid("游戏身份已改变，已停止更新译文。") }
        _ = try manifest(project)
        for (source, target) in translations { try TranslationTokens.validate(source: source, target: target) }
        try safeWrite(JSONEncoder().encode(translations), to: location(project).appendingPathComponent("translations.json"))
    }

    public static func capturedText(_ project: RPGMakerProject) throws -> [TranslationEntry] {
        _ = try manifest(project)
        let url = location(project).appendingPathComponent("missing.json")
        guard FileManager.default.fileExists(atPath: url.path) else { return [] }
        guard url.resolvingSymlinksInPath().path == url.path else { throw AssistanceError.invalid("待译文本文件是符号链接。") }
        let data = try Data(contentsOf: url)
        guard data.count <= 32 * 1024 * 1024 else { throw AssistanceError.invalid("待译文本文件过大。") }
        let texts = try JSONDecoder().decode([String].self, from: data)
        guard texts.count <= 5000, texts.allSatisfy({ !$0.isEmpty && $0.count <= 4096 }) else { throw AssistanceError.invalid("待译文本超出限制。") }
        return texts.map { TranslationEntry(source: $0, contexts: ["游戏运行时捕获"]) }
    }

    public static func restore(_ project: RPGMakerProject, running: Bool) throws {
        guard !running, try !AssistanceProcesses.isRunning(project) else { throw AssistanceError.invalid("请先关闭游戏，再恢复原始入口。") }
        _ = try manifest(project)
        let dir = try checkedDirectory(project)
        let allowed = Set(files + files.map { $0 + ".bak" } + ["manifest.json", "original.html", "config.json", "config.json.bak", "translations.json", "translations.json.bak", "missing.json", "missing.tmp", ".DS_Store"])
        let names = try FileManager.default.contentsOfDirectory(atPath: dir.path)
        guard names.allSatisfy({ name in
            var isDirectory: ObjCBool = false
            _ = FileManager.default.fileExists(atPath: dir.appendingPathComponent(name).path, isDirectory: &isDirectory)
            return allowed.contains(name) && !isDirectory.boolValue
        }) else { throw AssistanceError.invalid("辅助目录包含未识别文件，已保留全部文件。请先移走自添文件再恢复。") }
        let original = try Data(contentsOf: dir.appendingPathComponent("original.html"))
        try original.write(to: project.page, options: .atomic)
        do { try FileManager.default.removeItem(at: dir) }
        catch { throw AssistanceError.invalid("原始入口已恢复，但辅助目录清理失败：\(error.localizedDescription)") }
    }
}
