import Foundation

/// 启动前的可解释检查结果；只读，不执行准备动作，不启动游戏。
public enum LaunchDiagnosticLevel: Int, Sendable, Equatable, CaseIterable {
    case good = 0
    case notice = 1
    case blocking = 2
}

public struct LaunchDiagnosticItem: Identifiable, Sendable, Equatable {
    public let id: String
    public let level: LaunchDiagnosticLevel
    public let title: String
    public let detail: String
    public let action: String?

    public init(id: String, level: LaunchDiagnosticLevel, title: String,
                detail: String, action: String? = nil) {
        self.id = id
        self.level = level
        self.title = title
        self.detail = detail
        self.action = action
    }
}

public struct LaunchPlanPreview: Sendable, Equatable {
    public let binary: String
    public let arguments: [String]
    public let workingDirectory: String?
    public let engine: String

    public init(plan: LaunchPlan) {
        binary = plan.binary
        arguments = plan.args
        workingDirectory = plan.cwd
        engine = plan.engine
    }
}

public struct LaunchDiagnosis: Sendable, Equatable {
    public let gameID: String
    public let engine: String
    public let folder: String
    public let items: [LaunchDiagnosticItem]
    public let plan: LaunchPlanPreview?

    public init(gameID: String, engine: String, folder: String,
                items: [LaunchDiagnosticItem], plan: LaunchPlanPreview?) {
        self.gameID = gameID
        self.engine = engine
        self.folder = folder
        self.items = items
        self.plan = plan
    }

    public var hasBlockingIssues: Bool {
        items.contains { $0.level == .blocking }
    }

    public var isReady: Bool { !hasBlockingIssues }
}

public enum LaunchDiagnostics {

    /// 检查启动条件。这个入口不会写 Game.ini、符号链接或 mkxp.json。
    public static func inspect(
        game: GameRecord,
        dataDir: String,
        arch: String,
        runningPID: Int32? = nil,
        isDirectory: (String) -> Bool = { path in
            var directory: ObjCBool = false
            return FileManager.default.fileExists(atPath: path, isDirectory: &directory)
                && directory.boolValue
        },
        canReadDirectory: (String) -> Bool = { path in
            (try? FileManager.default.contentsOfDirectory(atPath: path)) != nil
        },
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
        isExecutable: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) },
        listDir: (String) -> [String] = { path in
            (try? FileManager.default.contentsOfDirectory(atPath: path)) ?? []
        }
    ) -> LaunchDiagnosis {
        let folder = DetectPath.gameDirForFiles(game.gamePath)
        var items: [LaunchDiagnosticItem] = []
        var preview: LaunchPlanPreview?

        func add(_ id: String, _ level: LaunchDiagnosticLevel, _ title: String,
                 _ detail: String, action: String? = nil) {
            items.append(LaunchDiagnosticItem(
                id: id, level: level, title: title, detail: detail, action: action))
        }

        let folderPresent = isDirectory(folder)
        if folderPresent {
            if canReadDirectory(folder) {
                add("game-folder", .good, L10n.string("游戏目录存在"), folder)
            } else {
                add("game-folder-readable", .blocking, L10n.string("游戏目录无法读取"), folder,
                    action: L10n.string("检查文件权限，或重新定位到一个可读取的目录。"))
            }
        } else {
            add("game-folder", .blocking, L10n.string("游戏目录不存在"), folder,
                action: L10n.string("确认游戏没有被移动或删除；如果已经移动，请使用“重新定位游戏目录”。"))
        }

        guard let definition = EngineRegistry.find(folder: game.gameEngine) else {
            add("engine-known", .blocking, L10n.string("当前版本不认识这个引擎"), game.gameEngine,
                action: L10n.string("更新启动器，或检查游戏记录中的引擎设置。"))
            return LaunchDiagnosis(gameID: game.id, engine: game.gameEngine,
                                   folder: folder, items: items, plan: nil)
        }

        if definition.launchable {
            add("engine-known", .good, L10n.string("引擎已接入启动流程"), definition.name)
        } else {
            add("engine-launchable", .blocking, L10n.string("这个引擎目前只能识别，不能启动"), definition.name,
                action: L10n.string("请使用对应的 macOS 运行方式，或等待启动器接入该引擎。"))
        }

        var args = GameArgs.prepare(
            userArgs: game.gameArgs, dataDir: dataDir, engine: game.gameEngine)
        if game.gameEngine == "nwjs" || game.gameEngine == "tyrano" {
            if let resolved = NwjsVersion.resolve(
                dataDir: dataDir, current: args["version"]?.stringValue) {
                args["version"] = .string(resolved)
            }
        }

        let context = LaunchContext(
            folder: folder, gamePath: game.gamePath, gameArgs: args,
            gameTitle: game.gameTitle, dataDir: dataDir, arch: arch, gameID: game.wineEnvironmentIdentity)
        switch LaunchPlanner.plan(
            engine: game.gameEngine, context: context,
            fileExists: fileExists, listDir: listDir, performPreparation: false
        ) {
        case .failure(let failure):
            add(failureID(failure), .blocking, failureTitle(failure), failureDetail(failure),
                action: failureAction(failure))
        case .success(let launchPlan):
            preview = LaunchPlanPreview(plan: launchPlan)
            if fileExists(launchPlan.binary) {
                if isExecutable(launchPlan.binary) {
                    add("runtime-binary", .good, L10n.string("运行时已找到且可执行"), launchPlan.binary)
                } else {
                    add("runtime-executable", .blocking, L10n.string("运行时没有执行权限"), launchPlan.binary,
                        action: L10n.string("请在运行时页面重装该引擎。"))
                }
            } else {
                add("runtime-binary", .blocking, L10n.string("运行时文件不存在"), launchPlan.binary,
                    action: L10n.string("去“运行时”页面安装或修复这个引擎。"))
            }
        }

        if game.gameEngine == "wine" {
            add("wine-prefix", .notice, L10n.string("独立 Windows 环境"),
                WineRuntime.prefix(dataDir: dataDir, folder: folder, gameID: game.wineEnvironmentIdentity))
            add("wine-compatibility", .notice, L10n.string("Windows 兼容运行"),
                L10n.string("支持通过 Wine 运行 Windows 程序；具体游戏兼容性取决于程序及其依赖，不支持 Windows 专用驱动。首次启动会初始化环境。"))
            if arch == "arm64" && !WineRuntime.rosettaAvailable() {
                add("wine-rosetta", .blocking, L10n.string("需要 Rosetta 2"), L10n.string("此 Wine 运行时使用 Intel 架构。"), action: L10n.string("在运行时页面重新安装 Wine，按提示安装 Rosetta 2。"))
            }
        }
        if let runningPID {
            add("already-running", .notice, L10n.string("游戏已经在运行"), String(format: L10n.string("进程 PID %@"), "\(runningPID)"),
                action: L10n.string("如需重新启动，请先停止当前游戏。"))
        }

        if game.gamePath.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            add("record-path", .blocking, L10n.string("游戏记录没有路径"), L10n.string("空路径"),
                action: L10n.string("重新添加游戏。"))
        }

        return LaunchDiagnosis(gameID: game.id, engine: game.gameEngine,
                               folder: folder, items: items, plan: preview)
    }

    private static func failureID(_ failure: LaunchFailure) -> String {
        switch failure {
        case .engineBinaryMissing, .notExecutable: return "runtime-binary"
        case .gameFolderMissing: return "game-folder"
        case .unsupportedEngine: return "engine-launchable"
        case .spawnFailed: return "launch-plan"
        }
    }

    private static func failureTitle(_ failure: LaunchFailure) -> String {
        switch failure {
        case .engineBinaryMissing: return L10n.string("找不到引擎运行时")
        case .gameFolderMissing: return L10n.string("游戏目录不存在")
        case .notExecutable: return L10n.string("引擎运行时不可执行")
        case .unsupportedEngine: return L10n.string("引擎不支持启动")
        case .spawnFailed: return L10n.string("启动准备失败")
        }
    }

    private static func failureDetail(_ failure: LaunchFailure) -> String {
        switch failure {
        case .engineBinaryMissing(let binary): return binary
        case .gameFolderMissing(let folder): return folder
        case .notExecutable(let binary): return binary
        case .unsupportedEngine(let engine): return engine
        case .spawnFailed(let message): return message
        }
    }

    private static func failureAction(_ failure: LaunchFailure) -> String {
        switch failure {
        case .engineBinaryMissing: return L10n.string("去“运行时”页面安装或修复这个引擎。")
        case .gameFolderMissing: return L10n.string("确认游戏没有被移动或删除；如果已经移动，请重新定位。")
        case .notExecutable: return L10n.string("请在运行时页面重装该引擎。")
        case .unsupportedEngine: return L10n.string("这个引擎当前没有可用的 macOS 启动流程。")
        case .spawnFailed: return L10n.string("检查游戏目录权限和运行时配置后重试。")
        }
    }
}
