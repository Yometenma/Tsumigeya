import Foundation

struct RGSSAssistanceModule: AssistanceEngineModule {
    let info = AssistanceModuleInfo(id: .rgss, runtime: "mkxpz", title: "RPG Maker XP/VX/VX Ace", transport: .fileBridge,
        translation: L10n.string("XP/VX/VX Ace；需通过启动器加载辅助"), cheats: L10n.string("金钱、物品、角色数值、变量／开关与锁定"),
        installationNote: L10n.string("两项独立启用。应用前需退出游戏；不替换原始剧本或数据库，必须通过本启动器启动。译文修订完成后需重新应用。"),
        cheatInstructions: L10n.string("通过启动器进入游戏后，在这里修改金钱、物品、角色生命／魔力／等级、变量和开关。"))
    let scripts = [AssistanceScript(filename: "rgss.rb", resource: "rgss.rb")]
    let preloadScript: String? = "rgss.rb"
    let needsTranslationFont = true
    func matchesProcess(_ command: String, project: AssistanceProject) -> Bool {
        let canonical = project.root.resolvingSymlinksInPath().path
        // mkxp-z 的进程参数没有游戏路径，需要核对它正在使用的 app 内配置。
        let executable = command.components(separatedBy: ".app/").first.map { $0 + ".app/Contents/Game/mkxp.json" }
        if command.lowercased().contains("mkxp"), let executable,
           let data = try? Data(contentsOf: URL(fileURLWithPath: executable)),
           let config = try? JSONDecoder().decode([String: JSONValue].self, from: data), let folder = config["gameFolder"]?.stringValue {
            return URL(fileURLWithPath: folder).resolvingSymlinksInPath().path == canonical
        }
        return false
    }
    func detect(_ root: URL) throws -> AssistanceProject? {
        let fm = FileManager.default
        let ini = root.appendingPathComponent("Game.ini")
        if fm.fileExists(atPath: ini.path), let text = String(data: try Data(contentsOf: ini), encoding: .isoLatin1) {
            let lines = text.components(separatedBy: .newlines).map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            if let line = lines.first(where: { $0.lowercased().hasPrefix("scripts=") }) {
                let path = String(line.dropFirst(8)).replacingOccurrences(of: "\\", with: "/")
                let ext = (path as NSString).pathExtension.lowercased()
                let edition = ["rxdata": "XP", "rvdata": "VX", "rvdata2": "VX Ace"][ext]
                if let edition {
                    _ = try NativeAssistance.hash(ini, within: root)
                    let scripts = root.appendingPathComponent(path).standardizedFileURL
                    let archive = root.appendingPathComponent(["XP": "Game.rgssad", "VX": "Game.rgss2a", "VX Ace": "Game.rgss3a"][edition]!)
                    guard let identityFile = fm.fileExists(atPath: scripts.path) ? scripts : (fm.fileExists(atPath: archive.path) ? archive : nil) else { throw AssistanceError.invalid(L10n.string("缺少 RGSS 脚本数据或游戏归档。")) }
                    let digest = try NativeAssistance.hash(identityFile, within: root)
                    let identity = SHA256.hex(Array((root.path + "\0" + identityFile.path + "\0" + digest + "\0" + edition).utf8))
                    return .init(root: root, page: ini, content: root, edition: edition, identity: identity, engine: .rgss)
                }
            }
        }
        return nil
    }
    func extract(_ project: AssistanceProject) throws -> [TranslationEntry] {
        let file = AssistanceInstaller.location(project).appendingPathComponent("extracted.json")
        guard try AssistanceInstaller.options(project) != nil, FileManager.default.fileExists(atPath: file.path), file.path == file.resolvingSymlinksInPath().path else {
            throw AssistanceError.invalid(L10n.string("请先应用辅助并通过启动器进入游戏一次，再提取 RGSS 对话和数据库。加密或自定义内容也可使用跟随补译。"))
        }
        let data = try Data(contentsOf: file)
        guard data.count <= 32 * 1024 * 1024 else { throw AssistanceError.invalid(L10n.string("提取结果过大。")) }
        let strings = try JSONDecoder().decode([String].self, from: data)
        guard strings.count <= 50000, strings.allSatisfy({ $0.count <= 4096 }) else { throw AssistanceError.invalid(L10n.string("提取结果超出限制。")) }
        return strings.map { .init(source: $0, contexts: ["RGSS 运行时数据库与地图"]) }
    }
}
