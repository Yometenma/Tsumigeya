// 启动计划（纯数据 + 一个可选前置动作）。
//
// 对应 Electron 版：src/main/launchers/types.ts + nwjs.ts + spawn.ts
// 契约：docs/M4.0-实施方案.md §3.2，D53 / D54 / D55
//
// ===== D53：自实现启动，不碰游戏文件 =====
//
// 上游 launcher 542 行里真正启动只有第 534 行 `exec("nw" "gameFolder")`，
// 其余 533 行全是附加功能，**我们一律不做**：
//   · copyCheatFiles / removeCheatFiles          往游戏目录塞作弊文件
//   · modifyMVMainJs / modifyMZMainJs            **改写游戏的 js/main.js**
//   · applyProtection / removeProtection         改 package.json 的 chromium-args
//   · patchRpgmGetPixel                          改游戏取色函数
// 自实现启动的默认行为就是「不碰游戏目录」——这是 M4.0 最主要的收益。
//
// ===== D54：用 args 数组，不拼命令行字符串 =====
// `Process.arguments` 天然处理空格 / 中文 / 引号，不用自己写 quote()。
// 上游四个 launcher 各自写了一份 quote，那正是在补这个坑。
//
// ===== D55：进程必须能脱离启动器存活 =====
// Electron 版要用 `detached + stdio:'ignore' + unref()` 三件套。
// **Swift 的 Process 天然满足**（实测：父进程 exit(0) 后子进程仍存活，TTY 变成 ??），
// 但三件套的**意图**要保留：stdio 全部接 nullDevice。
import Foundation

/// 一次启动的上下文。
public struct LaunchContext: Sendable {
    /// 游戏根目录（已解析成绝对路径；gamePath 是文件时取它的父目录）。
    public let folder: String
    /// 用户的原始 gamePath（可能是文件夹里的某个 exe）。
    public let gamePath: String
    /// 引擎参数（**版本值已修正成真实目录名**）。
    public let gameArgs: [String: JSONValue]
    /// 游戏标题（Ren'Py 拿它当存档目录名）。
    public let gameTitle: String
    /// 数据目录（引擎模块所在处）。
    public let dataDir: String
    /// 架构（`arm64` / `x64`）。**由调用方传，不自己读**（单测要覆盖两种）。
    public let arch: String

    public init(
        folder: String, gamePath: String, gameArgs: [String: JSONValue],
        gameTitle: String, dataDir: String, arch: String
    ) {
        self.folder = folder
        self.gamePath = gamePath
        self.gameArgs = gameArgs
        self.gameTitle = gameTitle
        self.dataDir = dataDir
        self.arch = arch
    }
}

/// 一个引擎的「怎么启动」描述。
public struct LaunchPlan: Sendable {
    /// 要执行的二进制绝对路径。
    public let binary: String
    /// 参数**数组**（D54）。
    public let args: [String]
    /// 工作目录（默认取游戏目录）。
    public let cwd: String?
    /// 哪个引擎（诊断与日志用）。
    public let engine: String

    public init(binary: String, args: [String], cwd: String? = nil, engine: String) {
        self.binary = binary
        self.args = args
        self.cwd = cwd
        self.engine = engine
    }
}

/// 启动失败的原因分类。
///
/// ⚠️ `ENOENT` **有两种含义，必须分开**（否则文案会误导用户去「重装引擎」）：
///   · binary 不存在 → `.engineBinaryMissing`（真的没装 / 装错版本）
///   · cwd 不存在    → `.gameFolderMissing`（游戏目录被删了，不是引擎问题）
///
/// 判据是**先查 cwd 再查 binary** —— 反过来会把「游戏目录被删」误报成「引擎没装」。
///
/// ⚠️ 必须实现 `Error`：Swift 的 `Result<Success, Failure>` 要求
///    `Failure: Error`（`throws`/`throw` 语义的残留）。它**不**是 throw，
///    我们仍然用 `Result` 返回值来表达「预期内的失败」，
///    只有真正的意外才 throw（与 Electron 版 D36 的取向一致：
///    `launch` 有诊断失败时返回结构化结果，**不抛**）。
public enum LaunchFailure: Error, Sendable, Equatable {
    case engineBinaryMissing(binary: String)
    case gameFolderMissing(folder: String)
    case notExecutable(binary: String)
    case unsupportedEngine(engine: String)
    case spawnFailed(message: String)

    /// 给人看的中文说明（UI 直接显示）。
    public var message: String {
        switch self {
        case .engineBinaryMissing(let b):
            return "引擎运行时不存在：\(b)\n去「引擎」页安装或修复这个引擎。"
        case .gameFolderMissing(let f):
            return "游戏目录不存在：\(f)\n游戏可能被移动或删除了，请重新添加。"
        case .notExecutable(let b):
            return "引擎运行时没有执行权限：\(b)\n试着重装这个引擎。"
        case .unsupportedEngine(let e):
            return "引擎「\(e)」的运行时路径还没实现（P2 阶段只支持已装过的 4 个）。"
        case .spawnFailed(let m):
            return "启动失败：\(m)"
        }
    }
}

/// 启动计划构造器。
public enum LaunchPlanner {

    /// 为某个引擎构造启动方案。
    ///
    /// - Parameters:
    ///   - fileExists: 注入用（单测传假实现）
    ///   - listDir: 注入用（siglus / godot 要扫目录找 .app）
    public static func plan(
        engine: String,
        context ctx: LaunchContext,
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
        listDir: (String) -> [String] = { dir in
            (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
        }
    ) -> Result<LaunchPlan, LaunchFailure> {

        switch engine {
        case "nwjs", "tyrano":
            return nwjsPlan(ctx, engine: engine, fileExists: fileExists)
        case "mkxpz":
            return mkxpzPlan(ctx, fileExists: fileExists)
        case "easyrpg":
            return easyrpgPlan(ctx, fileExists: fileExists)
        case "renpy":
            return renpyPlan(ctx, fileExists: fileExists)
        case "kirikiri", "nscripter", "siglus", "godot":
            return genericPlan(
                ctx, engine: engine, fileExists: fileExists, listDir: listDir)
        default:
            return .failure(.unsupportedEngine(engine: engine))
        }
    }

    // MARK: - 其余四个引擎（P3）

    /// KiriKiri / NScripter / Siglus / Godot 的通用启动方案。
    ///
    /// 这四个的共同点：**参数都是「游戏目录」**，二进制位置各自不同。
    ///
    /// ⚠️ 它们**没有已装样本可验**（用户机器上只装了 4 个引擎，这 4 个都不在）。
    /// 路径来自**真下载包解压后的实测结构**（见 `BinaryPaths` 各函数的注释），
    /// 但**启动参数**沿用各自 CLI 的通用约定 —— 这一点必须诚实：
    /// 参数可能不对，但那会在**真机上启动时才暴露**，而现在没有样本可验。
    static func genericPlan(
        _ ctx: LaunchContext, engine: String,
        fileExists: (String) -> Bool, listDir: (String) -> [String]
    ) -> Result<LaunchPlan, LaunchFailure> {
        let version = ctx.gameArgs["version"]?.stringValue ?? ""
        guard let binary = BinaryPaths.binary(
            for: engine, dataDir: ctx.dataDir, version: version, arch: ctx.arch,
            fileExists: fileExists, listDir: listDir) else {
            // 找不到二进制 → 明确报「运行时不存在」，而不是猜一个路径
            return .failure(.engineBinaryMissing(
                binary: "\(BinaryPaths.moduleDir(ctx.dataDir, engine))/deps/<未找到>"))
        }

        // 参数：游戏目录（这四个引擎都是 `播放器 <游戏目录>` 的形式）
        let args = [ctx.folder]
        return .success(LaunchPlan(
            binary: binary, args: args, cwd: ctx.folder, engine: engine))
    }

    // MARK: - NW.js

    /// NW.js 的启动方案。
    ///
    /// 参数：游戏目录 + 可选的全屏开关。
    /// NW.js 自己会读 `<游戏目录>/package.json` 决定主进程脚本。
    ///
    /// ⚠️ **全屏用命令行 `--start-fullscreen`，不改 `package.json` 的 `chromium-args`**
    ///    —— 后者要**改写用户的游戏文件**，是 D53 明确拒绝的事（D80）。
    ///
    /// ⚠️ **顺序：Chromium 开关放在游戏目录之后**。
    ///    NW.js 的用法是 `nw <path> [args]`；放在 `<path>` 之前会被当成 NW.js 自己的参数。
    ///    实测安全位置是**游戏目录之后**（NW.js 会把无法识别的项透传给 Chromium）。
    static func nwjsPlan(
        _ ctx: LaunchContext, engine: String, fileExists: (String) -> Bool
    ) -> Result<LaunchPlan, LaunchFailure> {
        let version = ctx.gameArgs["version"]?.stringValue ?? ""
        let binary = BinaryPaths.nwjsBinary(ctx.dataDir, version: version, arch: ctx.arch)

        guard fileExists(binary) else {
            return .failure(.engineBinaryMissing(binary: binary))
        }

        var args: [String] = [ctx.folder]
        if ctx.gameArgs["fullscreen"]?.boolValue == true {
            args.append("--start-fullscreen")   // 游戏目录**之后**（见上）
        }
        return .success(LaunchPlan(binary: binary, args: args, cwd: ctx.folder, engine: engine))
    }

    // MARK: - mkxp-z

    /// mkxp-z 的启动方案。
    ///
    /// ⚠️ mkxp-z **不接受命令行参数**，一切配置走 app 包内的 `mkxp.json`。
    /// ⚠️ **不传 cwd**：这份二进制不看 cwd，传了反而让「配置到底在哪」更难判
    ///    （v0.5.2 就是被 cwd 误导成「按 cwd 找配置」）。
    ///
    /// ===== 启动前的三步处置（顺序不能错）=====
    ///   ① 修 Game.ini 的 Title（D71）
    ///   ② 建 ASCII 符号链接（D72）
    ///   ③ 写配置到 **app 包内**
    ///
    /// 顺序反了会怎样：
    ///   · 先写配置再修 Title → 配置对了，但 mkxp-z 还是因为 ini 读不出而回落 RGSS 1
    ///   · 先写配置再建链接 → 配置里是中文路径 → 直接 `Unknown encoding`
    static func mkxpzPlan(
        _ ctx: LaunchContext, fileExists: (String) -> Bool
    ) -> Result<LaunchPlan, LaunchFailure> {
        let binary = BinaryPaths.mkxpzBinary(ctx.dataDir)
        guard fileExists(binary) else {
            return .failure(.engineBinaryMissing(binary: binary))
        }

        // ① 修 Title（D71）：删掉 ini 也照样能跑，失败只记不拦
        let iniWarning = MkxpzConfig.sanitizeGameIniTitle(gameDir: ctx.folder)
        if let iniWarning {
            FileHandle.standardError.write(
                "[tsumigeya] Game.ini Title 修正跳过：\(iniWarning)\n".data(using: .utf8)!)
        }

        // ② 建 ASCII 符号链接（D72）
        //
        // ⚠️ 建链接失败 → 退回真实路径。中文路径下 mkxp-z 大概率还是失败，
        //    但至少错误发生在它那边、不在我们这，用户看到的报错是引擎自己给的。
        var gameFolder = ctx.folder
        if AsciiAlias.needsAsciiAlias(gameFolder) {
            if let alias = try? AsciiAlias.ensureAlias(for: gameFolder) {
                gameFolder = alias
            }
        }

        // ③ 写配置到 app 包内
        let configPath = BinaryPaths.mkxpzConfigPath(ctx.dataDir)
        let rtp = MkxpzConfig.resolveRtp(context: ctx)
        let config = MkxpzConfig.build(
            context: ctx, folder: gameFolder,
            rgssVersion: rtp.rgssVersion, rtpDirs: rtp.rtpDirs)
        if let writeError = MkxpzConfig.write(config, to: configPath) {
            // 写配置失败 → **不启动**。没有配置它必然弹错误框，比不启动更糟。
            return .failure(.spawnFailed(message: "写 mkxp.json 失败：\(writeError)"))
        }

        // args 为空、cwd 为 nil（见上）
        return .success(LaunchPlan(binary: binary, args: [], cwd: nil, engine: "mkxpz"))
    }

    // MARK: - EasyRPG

    /// EasyRPG 的启动方案。
    ///
    /// 参数：游戏目录。全屏与缩放用官方 man page 的 `--fullscreen` / `--scaling`（D80）。
    static func easyrpgPlan(
        _ ctx: LaunchContext, fileExists: (String) -> Bool
    ) -> Result<LaunchPlan, LaunchFailure> {
        let binary = BinaryPaths.easyrpgBinary(ctx.dataDir)
        guard fileExists(binary) else {
            return .failure(.engineBinaryMissing(binary: binary))
        }

        var args: [String] = [ctx.folder]
        if ctx.gameArgs["fullscreen"]?.boolValue == true {
            args.append("--fullscreen")
        }
        // 音源：**只在文件真的存在时才传**。
        // 传一个不存在的路径会让 EasyRPG 启动即报错。
        let soundfont = BinaryPaths.easyrpgSoundfont(ctx.dataDir)
        if fileExists(soundfont) {
            args.append(contentsOf: ["--soundfont", soundfont])
        }
        return .success(LaunchPlan(binary: binary, args: args, cwd: ctx.folder, engine: "easyrpg"))
    }

    // MARK: - Ren'Py

    /// Ren'Py 的启动方案。
    ///
    /// ⚠️ Ren'Py 的二进制是 `renpy.sh`（脚本），两种布局都可能（平铺 / 带版本目录）。
    static func renpyPlan(
        _ ctx: LaunchContext, fileExists: (String) -> Bool
    ) -> Result<LaunchPlan, LaunchFailure> {
        guard let binary = BinaryPaths.renpySh(ctx.dataDir, fileExists: fileExists) else {
            return .failure(.engineBinaryMissing(
                binary: BinaryPaths.renpyRoot(ctx.dataDir) + "/renpy.sh"))
        }

        // Ren'Py 的用法：renpy.sh <game_folder>
        let args = [ctx.folder]
        return .success(LaunchPlan(binary: binary, args: args, cwd: ctx.folder, engine: "renpy"))
    }
}
