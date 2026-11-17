import Foundation

struct TyranoAssistanceModule: AssistanceEngineModule {
    let info = AssistanceModuleInfo(id: .tyrano, runtime: "tyrano", title: "TyranoScript", transport: .webPanel,
        translation: "文字与文字选项标签；不含图片文字", cheats: "游戏／系统变量、锁定与数值筛选",
        installationNote: "两项独立启用。应用前需退出游戏；会备份原始页面，仅添加辅助加载入口。当前接入 NW.js 目录，不支持直接运行 Electron／ASAR 原包。译文修订完成后需重新应用。",
        cheatInstructions: "启用后启动游戏，点击右上角「游戏辅助」或按 ⇧F8。支持游戏变量 f、系统变量 sf 的搜索、修改、锁定及数值逐次筛选；不提供 RPG 专用的角色和战斗操作。")
    let scripts = ["loader.js", "translation.js", "cheats.js", "panel.js"].map {
        AssistanceScript(filename: $0, resource: $0 == "loader.js" ? $0 : "tyrano-" + $0)
    }
    func detect(_ root: URL) throws -> AssistanceProject? {
        guard let entry = try WebAssistanceEntry.load(root) else { return nil }
        let page = entry.page, content = entry.content
        guard ["tyrano/plugins/kag/kag.js", "tyrano/kag/kag.js"].contains(where: { FileManager.default.fileExists(atPath: content.appendingPathComponent($0).path) }) else { return nil }
        let candidate = ["tyrano/plugins/kag/kag.js", "tyrano/kag/kag.js"].map { content.appendingPathComponent($0) }.first { FileManager.default.fileExists(atPath: $0.path) }!
        var identityFiles = [candidate]
        let config = content.appendingPathComponent("data/system/Config.tjs")
        if FileManager.default.fileExists(atPath: config.path) { identityFiles.append(config) }
        let scenario = content.appendingPathComponent("data/scenario")
        guard scenario.path == scenario.resolvingSymlinksInPath().path else { throw AssistanceError.invalid("Tyrano 场景目录不能是符号链接。") }
        if let enumerator = FileManager.default.enumerator(at: scenario, includingPropertiesForKeys: [.isSymbolicLinkKey, .isRegularFileKey], options: [.skipsHiddenFiles]) {
            for case let url as URL in enumerator {
                let values = try url.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey])
                if values.isSymbolicLink == true { enumerator.skipDescendants(); continue }
                if values.isRegularFile == true, url.pathExtension.lowercased() == "ks" { identityFiles.append(url) }
                guard identityFiles.count <= 10000 else { throw AssistanceError.invalid("Tyrano 身份文件数量超出限制。") }
            }
        }
        let signature = try identityFiles.sorted { $0.path < $1.path }.map {
            String($0.path.dropFirst(root.path.count + 1)) + ":" + (try NativeAssistance.hash($0, within: root))
        }.joined(separator: "\0")
        return AssistanceProject(root: root, page: page, content: content, edition: "TyranoScript", identity: SHA256.hex(Array((root.path + "\0" + page.path + "\0" + signature + "\0TyranoScript").utf8)), engine: .tyrano)
    }
    func extract(_ project: AssistanceProject) throws -> [TranslationEntry] {
        try AdditionalTextExtractor.scripts(project, root: project.content.appendingPathComponent("data/scenario"), extension: "ks", parse: Self.parse)
    }
    static func parse(_ source: String) -> [String] {
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
