import Foundation

struct RenPyAssistanceModule: AssistanceEngineModule {
    let info = AssistanceModuleInfo(id: .renpy, runtime: "renpy", title: "Ren’Py", transport: .fileBridge,
        translation: L10n.string("剧本台词与显示文字；特殊语法由运行时捕获"), cheats: L10n.string("简单变量编辑、锁定与数值筛选"),
        installationNote: L10n.string("两项独立启用。应用前需退出游戏；添加独立辅助剧本，不替换原始剧本或数据库。译文修订完成后需重新应用。"),
        cheatInstructions: L10n.string("进入游戏后，在这里搜索和编辑简单变量。支持数字、布尔值和短文字；不执行任意脚本，也不修改复杂对象。"))
    let scripts = [AssistanceScript(filename: "renpy.py", resource: "renpy.py")]
    let entrySource: String? = """
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
    func matchesProcess(_ command: String, project: AssistanceProject) -> Bool {
        command.contains(project.root.path) && (command.lowercased().contains("python") || command.lowercased().contains("renpy"))
    }
    func detect(_ root: URL) throws -> AssistanceProject? {
        let fm = FileManager.default
        let game = root.appendingPathComponent("game")
        if fm.fileExists(atPath: root.appendingPathComponent("renpy").path), fm.fileExists(atPath: game.path) {
            guard game.resolvingSymlinksInPath().path == game.path else { throw AssistanceError.invalid(L10n.string("Ren’Py 游戏数据目录不能是符号链接。")) }
            guard let enumerator = fm.enumerator(at: game, includingPropertiesForKeys: [.isSymbolicLinkKey, .isRegularFileKey], options: [.skipsHiddenFiles]) else { throw AssistanceError.invalid(L10n.string("无法读取 Ren’Py 游戏目录。")) }
            var files: [URL] = []
            for case let url as URL in enumerator {
                let values = try url.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey])
                if values.isSymbolicLink == true || ["cache", "saves"].contains(url.lastPathComponent) { enumerator.skipDescendants(); continue }
                guard values.isRegularFile == true, ["rpy", "rpyc", "rpa"].contains(url.pathExtension),
                      url.deletingPathExtension().lastPathComponent != "zz_tsumigeya_assist",
                      !(url.pathExtension == "rpyc" && fm.fileExists(atPath: url.deletingPathExtension().appendingPathExtension("rpy").path)) else { continue }
                files.append(url.standardizedFileURL)
                guard files.count <= 10000 else { throw AssistanceError.invalid(L10n.string("Ren’Py 身份文件数量超出限制。")) }
            }
            guard !files.isEmpty else { throw AssistanceError.invalid(L10n.string("未找到 Ren’Py 剧本或资源归档。")) }
            let signature = try files.sorted { $0.path < $1.path }.map {
                String($0.path.dropFirst(game.path.count + 1)) + ":" + (try NativeAssistance.hash($0, within: root))
            }.joined(separator: "\0")
            let identity = SHA256.hex(Array((root.path + "\0RenPy\0" + signature).utf8))
            return .init(root: root, page: game.appendingPathComponent("zz_tsumigeya_assist.rpy"), content: game, edition: "Ren’Py", identity: identity, engine: .renpy)
        }
        return nil
    }
    func extract(_ project: AssistanceProject) throws -> [TranslationEntry] {
        try AdditionalTextExtractor.scripts(project, root: project.content, extension: "rpy", parse: Self.parse)
    }
    static func parse(_ source: String) -> [String] {
        let re = try! NSRegularExpression(pattern: #"^\s*(?:(?:[A-Za-z_][A-Za-z_0-9.]*\s+)*)([\"'])"#)
        let excluded: Set<String> = ["new", "image", "define", "default", "play", "queue", "stop", "voice", "scene", "show", "hide", "jump", "call", "return", "python", "init", "style", "text", "textbutton", "add", "label", "transform", "screen"]
        var result: [String] = [], excludedIndent: Int?, multiline: String?
        for line in source.components(separatedBy: .newlines) {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            let indent = line.prefix(while: { $0 == " " || $0 == "\t" }).reduce(0) { $0 + ($1 == "\t" ? 8 : 1) }
            if let delimiter = multiline {
                if trimmed.contains(delimiter) { multiline = nil }
                continue
            }
            if trimmed.isEmpty || trimmed.hasPrefix("#") { continue }
            if let blocked = excludedIndent {
                if indent > blocked { continue }
                excludedIndent = nil
            }
            // Python、screen 和样式块里的独立字符串不是对白，不能猜测成台词。
            let words = trimmed.split(whereSeparator: \.isWhitespace).map(String.init)
            if trimmed.hasSuffix(":") && (words.contains("python:") || words.contains("python") || ["screen", "style", "transform"].contains(words.first ?? "")) {
                excludedIndent = indent
                continue
            }
            if let delimiter = ["\"\"\"", String(repeating: "'", count: 3)].first(where: { trimmed.contains($0) }) {
                if trimmed.components(separatedBy: delimiter).count % 2 == 0 { multiline = delimiter }
                continue
            }
            let ns = line as NSString
            guard let match = re.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) else { continue }
            let start = match.range(at: 1).location
            let prefix = ns.substring(to: start).split(whereSeparator: \.isWhitespace).map(String.init)
            guard !prefix.contains(where: { excluded.contains($0) }) else { continue }
            let index = String.Index(utf16Offset: start, in: line)
            if let value = AdditionalTextExtractor.quoted(line[index...]) { result.append(value) }
        }
        return result
    }
}
