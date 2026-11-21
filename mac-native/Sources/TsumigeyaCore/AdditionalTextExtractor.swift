import Foundation

public enum AdditionalTextExtractor {
    public static func extract(_ project: AssistanceProject) throws -> [TranslationEntry] {
        try AssistanceModules.extract(project)
    }
    static func scripts(_ project: AssistanceProject, root: URL, extension ext: String,
                        parse: (String) -> [String]) throws -> [TranslationEntry] {
        guard let enumerator = FileManager.default.enumerator(at: root, includingPropertiesForKeys: [.isSymbolicLinkKey, .isRegularFileKey, .fileSizeKey], options: [.skipsHiddenFiles]) else { throw AssistanceError.invalid(L10n.string("无法读取剧本目录。")) }
        var catalog = TranslationCatalog(identity: project.identity), visited = 0
        for case let url as URL in enumerator {
            let values = try url.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey, .fileSizeKey])
            if values.isSymbolicLink == true { enumerator.skipDescendants(); continue }
            guard values.isRegularFile == true, url.pathExtension == ext, url != project.page else { continue }
            visited += 1
            guard visited <= 5000, (values.fileSize ?? 0) <= 8 * 1024 * 1024 else { throw AssistanceError.invalid(L10n.string("剧本数量或文件大小超出提取限制，未保存部分结果。")) }
            let source = try String(contentsOf: url, encoding: .utf8)
            let strings = parse(source)
            catalog.merge(strings.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.count <= 4096 }.map { .init(source: $0, contexts: [url.lastPathComponent]) })
        }
        if catalog.entries.isEmpty {
            if let captured = try? AssistanceInstaller.capturedText(project), !captured.isEmpty { return captured }
            throw AssistanceError.invalid(L10n.string("未找到可直接读取的剧本台词。归档、动态拼接或特殊语法请应用辅助后使用跟随补译。"))
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
    public static func renpy(_ source: String) -> [String] { RenPyAssistanceModule.parse(source) }
    public static func tyrano(_ source: String) -> [String] { TyranoAssistanceModule.parse(source) }
}
