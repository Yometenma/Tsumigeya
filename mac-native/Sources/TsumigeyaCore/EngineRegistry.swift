import Foundation

/// 一个引擎（识别用部分）。
public struct EngineDefinition: Sendable, Equatable {
    /// 模块目录名（也是 `modules/<folder>/` 的目录名）。
    public let folder: String
    public let name: String
    public let autodetect: DetectRule?
    /// 是否可启动。`false` = 只认不跑（D88）。
    public let launchable: Bool
    /// 只识别引擎的「为什么不能跑」说明键（用于 UI 文案）。
    public let detectOnlyReasonKey: String?
    /// 依赖表（**顺序有意义**：安装时用户看到进度条先动主二进制）。
    ///
    /// ⚠️ P1 时这里是空的（那时搬了也验证不了）。**P3 补上**：
    /// 这些 URL 是纯数据，与 `src/main/engines/registry.ts` 一一对应。
    public let dependencies: [(name: String, spec: DependencySpec)]

    public init(
        folder: String, name: String, autodetect: DetectRule?,
        launchable: Bool = true, detectOnlyReasonKey: String? = nil,
        dependencies: [(name: String, spec: DependencySpec)] = []
    ) {
        self.folder = folder
        self.name = name
        self.autodetect = autodetect
        self.launchable = launchable
        self.detectOnlyReasonKey = detectOnlyReasonKey
        self.dependencies = dependencies
    }

    public static func == (a: EngineDefinition, b: EngineDefinition) -> Bool {
        a.folder == b.folder && a.name == b.name && a.launchable == b.launchable
    }
}

// MARK: - 依赖表的便捷构造

extension DependencySpec {
    /// 通用包（`universal` 键）—— mkxpz / RTP / easyrpg / renpy / kirikiri / nscripter / godot 都是这种。
    static func universal(_ url: String, unzip: Bool = true, optional: Bool = false) -> DependencySpec {
        DependencySpec(builds: ["universal": DependencyBuild(link: url, unzip: unzip)],
                       optional: optional)
    }

    /// 分架构包（`arm64` + `x86_64`）—— nwjs / siglus 是这种。
    static func split(arm64: String, x86_64: String, unzip: Bool = true) -> DependencySpec {
        DependencySpec(builds: [
            "arm64": DependencyBuild(link: arm64, unzip: unzip),
            "x86_64": DependencyBuild(link: x86_64, unzip: unzip),
        ])
    }
}

public enum EngineRegistry {

    /// 专用运行时优先识别，Wine 仅在真实 Windows 入口没有匹配时兜底。
    public static let launchable: [EngineDefinition] = [
        EngineDefinition(
            folder: "nwjs", name: "NW.js",
            autodetect: DetectRule(files: ["nw.dll", "package.json"], allRequired: true)),

        EngineDefinition(
            folder: "mkxpz", name: "mkxp-z",
            autodetect: DetectRule(
                files: ["Game.ini", "System", "Graphics", "Audio"], allRequired: true)),

        EngineDefinition(
            folder: "easyrpg", name: "EasyRPG",
            autodetect: DetectRule(
                files: ["RPG_RT.ldb", "RPG_RT.lmt", "RPG_RT.ini"], allRequired: false)),

        EngineDefinition(
            folder: "renpy", name: "RenPy",
            autodetect: DetectRule(extensions: ["py", "exe", "sh"], files: ["renpy"], allRequired: true)),

        EngineDefinition(
            folder: "tyrano", name: "TyranoScript",
            autodetect: DetectRule(files: ["tyrano", "data"], allRequired: true)),

        EngineDefinition(
            folder: "kirikiri", name: "KiriKiri",
            autodetect: DetectRule(files: ["data.xp3"], allRequired: true)),

        // ⚠️ `0.txt` / `00.txt` 必须列进来：ONScripter 的实际脚本入口是
        //    `0.txt` → `00.txt` → `nscript.dat` 依次查找，汉化/移植版几乎都用明文
        //    `0.txt`。只认 `nscript.dat` 会把这类作品判成未知引擎。
        EngineDefinition(
            folder: "nscripter", name: "NScripter",
            autodetect: DetectRule(
                files: ["nscript.dat", "0.txt", "00.txt", "arc.nsa"], allRequired: false)),

        EngineDefinition(
            folder: "siglus", name: "Siglus",
            autodetect: DetectRule(files: ["Scene.pck", "Gameexe.dat"], allRequired: false)),

        EngineDefinition(folder: "wine", name: L10n.string("Wine（Windows 兼容）"), autodetect: nil),

        EngineDefinition(
            folder: "godot", name: "Godot",
            autodetect: DetectRule(extensions: ["pck"], allRequired: false)),
    ]

    /// 旧标识只在读取已有游戏记录时解析，不再出现在运行时和引擎选择列表。
    public static let detectOnly: [EngineDefinition] = []
    public static var all: [EngineDefinition] { launchable }

    /// 按 folder 查引擎。
    public static func find(folder: String) -> EngineDefinition? {
        all.first { $0.folder == WineRuntime.canonicalEngine(folder) }
    }

    /// 取某个引擎的依赖表（**P3 的接线点**）。
    ///
    /// ⚠️ 为什么不直接放在 `EngineDefinition.dependencies`：
    /// 那张表在 `EngineDependencies.swift`（纯数据、单独一篇便于改 URL）。
    /// 这里做一个转发，让调用方（安装流程）不用知道数据分在哪。
    public static func dependencies(for folder: String) -> [(name: String, spec: DependencySpec)] {
        EngineDependencies.dependencies(for: folder)
    }
}

// MARK: - 识别入口

extension EngineRegistry {

    /// 用**registry 规则**认引擎（未安装也能认）。
    ///
    /// 对应 Electron 版 `detectEngineFromAutodetectMap`。
    /// 没有专用运行时匹配时检查实际 PE 文件，不能仅凭 .exe 扩展名认领。
    public static func detect(
        exe: String,
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
    ) -> EngineDefinition? {
        guard !exe.isEmpty else { return nil }
        let rules: [(key: String, rule: DetectRule?)] = all.filter { $0.folder != "wine" }.map { ($0.folder, $0.autodetect) }
        if let folder = EngineDetector.pickBestRule(exe: exe, rules: rules, fileExists: fileExists) {
            return find(folder: folder)
        }
        return fileExists(exe) && WineRuntime.isExecutable(exe) ? find(folder: "wine") : nil
    }

    /// 用**已装模块的 manifest** 认引擎。
    ///
    /// 对应 Electron 版 `detectEngineForPath`。传进来的 `manifests` 就是本地有的那些
    /// （「已装」这条信息由调用方体现）。
    public static func detect(
        exe: String,
        manifests: [String: DetectRule?],
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
    ) -> String? {
        guard !exe.isEmpty else { return nil }
        if let found = EngineDetector.pickBestRule(exe: exe, rules: magazines(manifests.filter { WineRuntime.canonicalEngine($0.key) != "wine" }), fileExists: fileExists) {
            return WineRuntime.canonicalEngine(found)
        }
        return manifests.keys.contains("wine") && fileExists(exe) && WineRuntime.isExecutable(exe) ? "wine" : nil
    }

    /// 把 manifest 字典转成有序规则表（保持键的插入顺序对稳定性不重要，
    /// 但这里显式排序，让结果可复现）。
    private static func magazines(_ manifests: [String: DetectRule?]) -> [(key: String, rule: DetectRule?)] {
        manifests.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
    }
}
