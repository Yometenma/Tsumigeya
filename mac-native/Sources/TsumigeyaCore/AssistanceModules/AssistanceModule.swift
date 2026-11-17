import Foundation

public enum AssistanceTransport: String, Sendable {
    case webPanel, fileBridge
}

public struct AssistanceModuleInfo: Sendable, Identifiable {
    public let id: AssistanceEngine
    public let runtime: String
    public let title: String
    public let transport: AssistanceTransport
    public let translation: String?
    public let cheats: String?
    public let installationNote: String
    public let cheatInstructions: String
}

struct AssistanceScript: Sendable {
    let filename: String
    let resource: String
}

// 模块声明引擎差异；身份校验、安装备份和文件桥仍由共用层执行。
protocol AssistanceEngineModule: Sendable {
    var info: AssistanceModuleInfo { get }
    var scripts: [AssistanceScript] { get }
    var entrySource: String? { get }
    var preloadScript: String? { get }
    var needsTranslationFont: Bool { get }
    func matchesProcess(_ command: String, project: AssistanceProject) -> Bool
    func detect(_ root: URL) throws -> AssistanceProject?
    func extract(_ project: AssistanceProject) throws -> [TranslationEntry]
}

extension AssistanceEngineModule {
    var entrySource: String? { nil }
    var preloadScript: String? { nil }
    var needsTranslationFont: Bool { false }
    func matchesProcess(_ command: String, project: AssistanceProject) -> Bool {
        command.contains(project.root.path) && command.lowercased().contains("nwjs")
    }
}

public enum AssistanceModules {
    public static var available: [AssistanceModuleInfo] { registered.map(\.info) }
    public static func forEngine(_ engine: AssistanceEngine) -> AssistanceModuleInfo { module(for: engine).info }
    public static func forRuntime(_ runtime: String) -> AssistanceModuleInfo? { registered.first { $0.info.runtime == runtime }?.info }

    static func module(for engine: AssistanceEngine) -> any AssistanceEngineModule {
        switch engine {
        case .rpgMaker: RPGMakerAssistanceModule()
        case .rgss: RGSSAssistanceModule()
        case .renpy: RenPyAssistanceModule()
        case .tyrano: TyranoAssistanceModule()
        }
    }
    // 保留原生项目优先的识别顺序，不能因残留 package.json 改认另一引擎。
    static var registered: [any AssistanceEngineModule] {
        [AssistanceEngine.rgss, .renpy, .rpgMaker, .tyrano].map { module(for: $0) }
    }
    static func detect(_ root: URL) throws -> AssistanceProject {
        for module in registered {
            if let project = try module.detect(root) { return project }
        }
        throw AssistanceError.invalid("无法确认为支持的翻译与作弊引擎。")
    }
    public static func extract(_ project: AssistanceProject) throws -> [TranslationEntry] {
        try module(for: project.engine).extract(project)
    }
    static func validate(_ options: AssistanceOptions, for project: AssistanceProject) throws {
        let info = forEngine(project.engine)
        guard !options.translation || info.translation != nil else { throw AssistanceError.invalid("当前引擎模块尚未接入翻译。") }
        guard !options.cheats || info.cheats != nil else { throw AssistanceError.invalid("当前引擎模块尚未接入作弊。") }
    }
}

struct WebAssistanceEntry {
    let page: URL
    let content: URL
    static func load(_ root: URL) throws -> Self? {
        guard FileManager.default.fileExists(atPath: root.appendingPathComponent("package.json").path) else { return nil }
        let package = root.appendingPathComponent("package.json")
        let json = try JSONDecoder().decode([String: JSONValue].self, from: Data(contentsOf: package))
        guard let main = json["main"]?.stringValue else { throw AssistanceError.invalid("游戏缺少有效的启动页面。") }
        let path = main.replacingOccurrences(of: "\\", with: "/").components(separatedBy: "?")[0].components(separatedBy: "#")[0]
        guard !path.hasPrefix("/"), !path.contains(":"), !path.isEmpty else { throw AssistanceError.invalid("游戏启动页面必须是游戏目录内的文件。") }
        let page = root.appendingPathComponent(path).standardizedFileURL.resolvingSymlinksInPath()
        guard page.path.hasPrefix(root.path + "/"), page.pathExtension.lowercased() == "html",
              FileManager.default.fileExists(atPath: page.path) else { throw AssistanceError.invalid("游戏启动页面不存在或越出游戏目录。") }
        let content = page.deletingLastPathComponent()
        return .init(page: page, content: content)
    }
}
