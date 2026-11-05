// 引擎注册表（9 个可启动 + 3 个只识别）。
//
// 对应 Electron 版：src/main/engines/registry.ts（967 行）
// 契约：docs/M1-实施方案.md §2，D60 / D87 / D88 / D91
//
// ===== 这里是**数据**，不是逻辑 =====
//
// Electron 版那 967 行里，真正是数据的是：folder / name / autodetect 规则 /
// 下载 URL / 参数 schema。其余是注释（讲为什么这么设计）与参数默认值。
//
// 本文件只搬**识别要用**的那部分：folder + name + autodetect 规则 + 是否可启动。
// 下载 URL 与参数 schema 等 P3 再搬（那时才用得上，现在搬了也验证不了）。
//
// ===== 判据（D87/D88，别改）=====
//
// · **可启动的 9 个**：判据是「资源跨平台 + 有 macOS 运行时」，**不是**
//   「DLsite 标没标支持 Mac」。这个启动器的存在理由就是
//   「游戏只发 Windows 包、我们用自己装的 mac 运行时跑它的资源」。
//
// · **只识别的 3 个**（Unity / RPGBakin / ウディタ）：用户要「范围尽可能广」，
//   但**「认得出」和「跑得动」是两件事**。塞进可启动表 → 引擎页列成「可安装」
//   但下载地址空 → 点了必失败（D60 的「不起作用的开关」教训）。
//   完全不认 → 用户得到「未知引擎」，而「未知」与「需要 Windows 兼容层」
//   是**两种不同处境**（前者像程序坏了）。
//
// ===== ⚠️ 三条规则背后的实测教训（写规则时别踩回去）=====
//
// ① **Unity 绝不能加 `extensions: ['exe']`**
//    实测抓到过：加了之后，一个只有 readme 的空目录都被判成 Unity。
//    于是「一个我们完全不认识的 exe 游戏」被判成 Unity，报「需要 Windows 兼容层」
//    —— 而它也许其实是我们认识的某个引擎（只是强命中没匹配上）。
//    判据必须**只靠专有文件名**，宁可认不出（返回 nil）也不能乱认。
//
// ② **Tyrano 用两个目录当判据**（`tyrano` + `data`），**不用 index.html** ——
//    后者在任何网页项目里都有，会误伤。
//    也**不写** `resources/app` —— 那个路径在很多 Electron 应用里都有，
//    写了会把任何 Electron 打包的程序都认成 Tyrano。
//
// ③ **吉里吉里只认 `data.xp3`**（最标志性的归档产物）。
//    不认 `startup.tjs` + 散文件那种形态：认了会把「一堆 .tjs」的项目误判，
//    而那些散文件布局没有统一约定。
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

    public init(
        folder: String, name: String, autodetect: DetectRule?,
        launchable: Bool = true, detectOnlyReasonKey: String? = nil
    ) {
        self.folder = folder
        self.name = name
        self.autodetect = autodetect
        self.launchable = launchable
        self.detectOnlyReasonKey = detectOnlyReasonKey
    }
}

public enum EngineRegistry {

    /// **可启动的 9 个引擎**（D87 / D91）。顺序即引擎页顺序，**同分时靠它定序**。
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

        EngineDefinition(
            folder: "nscripter", name: "NScripter",
            autodetect: DetectRule(files: ["nscript.dat", "arc.nsa"], allRequired: false)),

        EngineDefinition(
            folder: "siglus", name: "Siglus",
            autodetect: DetectRule(files: ["Scene.pck", "Gameexe.dat"], allRequired: false)),

        EngineDefinition(
            folder: "godot", name: "Godot",
            autodetect: DetectRule(extensions: ["pck"], allRequired: false)),
    ]

    /// **只识别、不启动的 3 个**（D88）。
    ///
    /// ⚠️ 它们的 `allRequired` **一律 false（走打分）**，因为靠「强命中」去抢
    /// 会挤掉可启动引擎（`pickBestRule` 的「强命中永远压过打分命中」保证了
    /// 可启动引擎一旦强命中就赢）。实测见 `test/detect-priority.test.ts` 的 12 条。
    public static let detectOnly: [EngineDefinition] = [
        EngineDefinition(
            folder: "unity", name: "Unity",
            autodetect: DetectRule(
                files: ["UnityPlayer.dll", "unity default resources"], allRequired: false),
            launchable: false, detectOnlyReasonKey: "detectOnly.unity"),

        EngineDefinition(
            folder: "rpgbakin", name: "RPG Developer Bakin",
            autodetect: DetectRule(files: ["BakinData"], allRequired: false),
            launchable: false, detectOnlyReasonKey: "detectOnly.rpgbakin"),

        EngineDefinition(
            folder: "wolfrpg", name: "WOLF RPG Editor (ウディタ)",
            autodetect: DetectRule(files: ["Data.wolf"], allRequired: false),
            launchable: false, detectOnlyReasonKey: "detectOnly.wolfrpg"),
    ]

    /// 合并两张表（参与识别打分用）。
    ///
    /// ⚠️ 顺序：**可启动的在前**。这很关键 —— 同分时 `pickBestRule` 保持传入顺序，
    /// 把可启动的放前面，可启动引擎在同分时天然赢过只识别的。
    ///
    /// ⚠️ `pickBestRule` 的「强命中永远压过打分命中」还保证了另一条：
    /// 只识别条目一律 `allRequired: false`（只能走打分），所以它们**绝不可能**
    /// 强命中去抢走一个本该属于可启动引擎的游戏。
    public static var all: [EngineDefinition] {
        launchable + detectOnly
    }

    /// 按 folder 查引擎。
    public static func find(folder: String) -> EngineDefinition? {
        all.first { $0.folder == folder }
    }
}

// MARK: - 识别入口

extension EngineRegistry {

    /// 用**registry 规则**认引擎（未安装也能认）。
    ///
    /// 对应 Electron 版 `detectEngineFromAutodetectMap`。
    /// 返回 `nil` 表示「没有已知引擎能认领」—— **不猜、不回退**（D57 的精神）。
    public static func detect(
        exe: String,
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
    ) -> EngineDefinition? {
        guard !exe.isEmpty else { return nil }
        let rules: [(key: String, rule: DetectRule?)] = all.map { ($0.folder, $0.autodetect) }
        guard let folder = EngineDetector.pickBestRule(
            exe: exe, rules: rules, fileExists: fileExists) else { return nil }
        return find(folder: folder)
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
        return EngineDetector.pickBestRule(
            exe: exe, rules: magazines(manifests), fileExists: fileExists)
    }

    /// 把 manifest 字典转成有序规则表（保持键的插入顺序对稳定性不重要，
    /// 但这里显式排序，让结果可复现）。
    private static func magazines(_ manifests: [String: DetectRule?]) -> [(key: String, rule: DetectRule?)] {
        manifests.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
    }
}
