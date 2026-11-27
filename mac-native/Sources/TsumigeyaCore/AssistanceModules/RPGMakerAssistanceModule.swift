import Foundation

struct RPGMakerAssistanceModule: AssistanceEngineModule {
    let info = AssistanceModuleInfo(id: .rpgMaker, runtime: "nwjs", title: "RPG Maker MV/MZ", transport: .webPanel,
        translation: L10n.string("仅已确认的 RPG Maker MV/MZ"), cheats: L10n.string("MV/MZ 引擎状态与游戏内面板"),
        installationNote: L10n.string("两项独立启用。应用前需退出游戏；会备份原始页面，仅添加辅助加载入口，不替换 main.js。译文修订完成后也需重新应用。"),
        cheatInstructions: L10n.string("启用后启动游戏，在游戏右上角点击「游戏辅助」或按 ⇧F8。进入游戏或读档后可操作，不需要启动器保持开启。\n• 物品、防具、武器按数据库自动分栏，显示描述与数量；行首方框勾上即锁定，可 ±1／±100 步进和整栏批量设置\n• 变量／开关搜索、编辑与持续锁定\n• 角色属性、装备槽更换与全队恢复\n• 已知／未知数值查找，按增加、减少、改变和未改变逐次筛选\n• 对象浏览：按 $ 开头的属性路径查看对象，并写入标量字段\n• 游戏／移动速度、随机遇敌控制、穿墙\n• 地图搜索与坐标传送、地图事件和公共事件查看及执行"))
    let scripts = ["loader.js", "translation.js", "cheats.js", "panel.js"].map { AssistanceScript(filename: $0, resource: $0) }
    func detect(_ root: URL) throws -> AssistanceProject? {
        guard let entry = try WebAssistanceEntry.load(root) else { return nil }
        let page = entry.page, content = entry.content
        let js = content.appendingPathComponent("js")
        let mv = FileManager.default.fileExists(atPath: js.appendingPathComponent("rpg_core.js").path)
        let mz = FileManager.default.fileExists(atPath: js.appendingPathComponent("rmmz_core.js").path)
        guard mv || mz else { return nil }
        guard mv != mz, FileManager.default.fileExists(atPath: content.appendingPathComponent("data/System.json").path) else {
            throw AssistanceError.invalid(L10n.string("无法确认为支持的翻译与作弊引擎。"))
        }
        let system = content.appendingPathComponent("data/System.json").resolvingSymlinksInPath()
        guard system.path.hasPrefix(content.path + "/"), let hash = SHA256.hexOfFile(at: system.path) else {
            throw AssistanceError.invalid(L10n.string("无法验证游戏数据库身份。"))
        }
        let identity = SHA256.hex(Array((root.path + "\0" + page.path + "\0" + hash + "\0" + (mv ? "MV" : "MZ")).utf8))
        return AssistanceProject(root: root, page: page, content: content, edition: mv ? "MV" : "MZ", identity: identity, engine: .rpgMaker)
    }
    func extract(_ project: AssistanceProject) throws -> [TranslationEntry] {
        let dir = project.content.appendingPathComponent("data")
        let urls = try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.isRegularFileKey])
            .filter { $0.pathExtension.lowercased() == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
        var result = TranslationCatalog(identity: project.identity)
        let database = Set(["Actors.json", "Classes.json", "Skills.json", "Items.json", "Weapons.json", "Armors.json", "Enemies.json", "States.json", "MapInfos.json"])
        for url in urls {
            try Task.checkCancellation()
            let name = url.lastPathComponent
            guard database.contains(name) || name == "System.json" || name == "CommonEvents.json" || name.range(of: #"^Map\d+\.json$"#, options: .regularExpression) != nil else { continue }
            guard url.resolvingSymlinksInPath().path.hasPrefix(dir.resolvingSymlinksInPath().path + "/") else { throw AssistanceError.invalid(L10n.string("数据文件越出游戏目录。")) }
            let raw = try Data(contentsOf: url)
            guard raw.count <= 64 * 1024 * 1024 else { throw AssistanceError.invalid(String(format: L10n.string("游戏数据文件过大：%@"), "\(name)")) }
            let json = try JSONDecoder().decode(JSONValue.self, from: raw)
            var entries: [TranslationEntry] = []
            func add(_ value: JSONValue?, _ context: String) {
                guard let text = value?.stringValue, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
                entries.append(.init(source: text, contexts: ["\(name)：\(context)"]))
            }
            func eventList(_ value: JSONValue?, _ context: String) {
                for command in value?.arrayValue ?? [] {
                    guard let obj = command.objectValue, let code = obj["code"]?.intValue else { continue }
                    let p = obj["parameters"]?.arrayValue ?? []
                    switch code {
                    case 401, 405: if let first = p.first { add(first, context) }
                    case 102: for choice in p.first?.arrayValue ?? [] { add(choice, context + L10n.string("选项")) }
                    case 101: if p.count > 4 { add(p[4], context + L10n.string("说话人")) }
                    case 320, 324, 325: if p.count > 1 { add(p[1], context + L10n.string("角色文字")) }
                    default: break // 脚本和插件命令参数不是任意可翻译字符串。
                    }
                }
            }
            if database.contains(name) {
                for (i, row) in (json.arrayValue ?? []).enumerated() {
                    let obj = row.objectValue ?? [:]
                    for key in ["name", "nickname", "profile", "description", "message1", "message2", "message3", "message4"] { add(obj[key], "\(i).\(key)") }
                }
            } else if name == "System.json" {
                let obj = json.objectValue ?? [:]
                add(obj["gameTitle"], L10n.string("标题")); add(obj["currencyUnit"], L10n.string("货币"))
                for key in ["elements", "skillTypes", "weaponTypes", "armorTypes", "equipTypes", "variables", "switches"] {
                    for v in obj[key]?.arrayValue ?? [] { add(v, key) }
                }
                func terms(_ value: JSONValue) {
                    switch value { case .string: add(value, L10n.string("系统用语"))
                    case .object(let d): for v in d.values { terms(v) }
                    case .array(let a): for v in a { terms(v) }
                    default: break }
                }
                if let t = obj["terms"] { terms(t) }
            } else if name == "CommonEvents.json" {
                for (i, row) in (json.arrayValue ?? []).enumerated() { eventList(row.objectValue?["list"], String(format: L10n.string("公共事件%@"), "\(i)")) }
            } else {
                let obj = json.objectValue ?? [:]; add(obj["displayName"], L10n.string("地图名"))
                for event in obj["events"]?.arrayValue ?? [] {
                    let e = event.objectValue ?? [:]
                    for page in e["pages"]?.arrayValue ?? [] { eventList(page.objectValue?["list"], String(format: L10n.string("事件%@"), "\(e["id"]?.intValue ?? 0)")) }
                }
            }
            result.merge(entries)
        }
        return result.entries
    }
}
