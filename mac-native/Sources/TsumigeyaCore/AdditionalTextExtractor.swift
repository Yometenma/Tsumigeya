import Foundation

public enum AdditionalTextExtractor {
    public static func extract(_ project: AssistanceProject) throws -> [TranslationEntry] {
        if project.engine == .rgss {
            let file = AssistanceInstaller.location(project).appendingPathComponent("extracted.json")
            guard try AssistanceInstaller.options(project) != nil, FileManager.default.fileExists(atPath: file.path), file.path == file.resolvingSymlinksInPath().path else {
                throw AssistanceError.invalid("请先应用辅助并通过启动器进入游戏一次，再提取 RGSS 对话和数据库。加密或自定义内容也可使用跟随补译。")
            }
            let data = try Data(contentsOf: file)
            guard data.count <= 32 * 1024 * 1024 else { throw AssistanceError.invalid("提取结果过大。") }
            let strings = try JSONDecoder().decode([String].self, from: data)
            guard strings.count <= 50000, strings.allSatisfy({ $0.count <= 4096 }) else { throw AssistanceError.invalid("提取结果超出限制。") }
            return strings.map { .init(source: $0, contexts: ["RGSS 运行时数据库与地图"]) }
        }
        let root = project.engine == .renpy ? project.content : project.content.appendingPathComponent("data/scenario")
        let ext = project.engine == .renpy ? "rpy" : "ks"
        guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isSymbolicLinkKey, .isRegularFileKey, .fileSizeKey], options: [.skipsHiddenFiles]) else { throw AssistanceError.invalid("无法读取剧本目录。") }
        var catalog = TranslationCatalog(identity: project.identity), visited = 0
        for case let url as URL in enumerator {
            let values = try url.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey, .fileSizeKey])
            if values.isSymbolicLink == true { enumerator.skipDescendants(); continue }
            guard values.isRegularFile == true, url.pathExtension == ext, url != project.page else { continue }
            visited += 1
            guard visited <= 5000, (values.fileSize ?? 0) <= 8 * 1024 * 1024 else { throw AssistanceError.invalid("剧本数量或文件大小超出提取限制，未保存部分结果。") }
            let source = try String(contentsOf: url, encoding: .utf8)
            let strings = project.engine == .renpy ? renpy(source) : tyrano(source)
            catalog.merge(strings.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.count <= 4096 }.map { .init(source: $0, contexts: [url.lastPathComponent]) })
        }
        if catalog.entries.isEmpty {
            if let captured = try? AssistanceInstaller.capturedText(project), !captured.isEmpty { return captured }
            throw AssistanceError.invalid("未找到可直接读取的剧本台词。归档、动态拼接或特殊语法请应用辅助后使用跟随补译。")
        }
        return catalog.entries
    }
    static func quoted(_ text: Substring) -> String? {
        guard let first = text.first, first == "\"" || first == "'", !text.hasPrefix(String(repeating: first, count: 3)) else { return nil }
        var result = "", escaped = false
        for c in text.dropFirst() {
            if escaped {
                switch c { case "n": result += "\n"; case "r": result += "\r"; case "t": result += "\t"; case "\\", "\"", "'": result.append(c); default: result += "\\"; result.append(c) }
                escaped = false
            } else if c == "\\" { escaped = true }
            else if c == first { return result }
            else { result.append(c) }
        }
        return nil
    }
    public static func renpy(_ source: String) -> [String] {
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
            if let value = quoted(line[index...]) { result.append(value) }
        }
        return result
    }

    public static func tyrano(_ source: String) -> [String] {
        var result: [String] = [], script = false, comment = false
        for raw in source.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.hasPrefix("/*") { comment = true }
            if comment { if line.contains("*/") { comment = false }; continue }
            if line.hasPrefix("[iscript") || line.hasPrefix("@iscript") || line.hasPrefix("[html") || line.hasPrefix("@html") { script = true; continue }
            if script { if line.contains("[endscript]") || line.hasPrefix("@endscript") || line.contains("[endhtml]") || line.hasPrefix("@endhtml") { script = false }; continue }
            if line.hasPrefix(";") || line.hasPrefix("*") || line.hasPrefix("@") || line.hasPrefix("#") { continue }
            var buffer = "", tag = false, quote: Character?
            for c in line {
                if tag {
                    if let q = quote { if c == q { quote = nil } }
                    else if c == "\"" || c == "'" { quote = c }
                    else if c == "]" { tag = false }
                } else if c == "[" { if !buffer.isEmpty { result.append(buffer); buffer = "" }; tag = true }
                else { buffer.append(c) }
            }
            if !buffer.isEmpty { result.append(buffer) }
        }
        return result
    }
}
