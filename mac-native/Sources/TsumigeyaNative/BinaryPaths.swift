// 引擎可执行文件路径（D56：**唯一来源**）。
//
// 对应 Electron 版：src/main/launchers/binary-paths.ts（413 行）
// 契约：docs/M4.0-实施方案.md §2.2（用户已实测，**路径拼法不要改**）
//
// ===== 这些路径是照抄实测的，一个字都别改 =====
//
//   nwjs:     <data>/modules/nwjs/deps/version/<version>/nwjs-sdk-<version>-osx-<arch>/
//             nwjs.app/Contents/MacOS/nwjs
//   mkxpz:    <data>/modules/mkxpz/deps/mkxpz/Z-Universal.app/Contents/MacOS/Z-Universal
//   easyrpg:  <data>/modules/easyrpg/deps/player/EasyRPG Player.app/Contents/MacOS/EasyRPG Player
//   renpy:    <data>/modules/renpy/deps/renpy/renpy.sh
//             或 <data>/modules/renpy/deps/renpy/renpy-<x.y.z>-sdk/renpy.sh
//
// ⚠️ nwjs 的 `<arch>` 是 `arm64` / `x64`，**由调用方传进来**，绝不自己读
//    `ProcessInfo`（那样单测只能覆盖当前架构，x64 分支永远测不到）。
//
// ⚠️ 这些路径是 **macOS 布局**。Windows 上跑单测时同样返回这套拼法 ——
//    路径计算不 stat 就不会出错；真正的 stat / spawn 发生在 mac 上。
import Foundation

public enum BinaryPaths {

    /// 模块目录名（与上游 module.js 的约定一致）。
    public static let modulesDirName = "modules"

    /// 9 个可启动引擎的 folder（与 `EngineRegistry.launchable` 必须同源）。
    ///
    /// ⚠️ 有测试逐个核对它和注册表一致 —— 这里多一个少一个都会红。
    public static let engineIDs: [String] = [
        "nwjs", "mkxpz", "easyrpg", "renpy",
        "tyrano", "kirikiri", "nscripter", "siglus", "godot",
    ]

    // MARK: - 基础拼法

    /// `<数据目录>/modules/<引擎>`
    public static func moduleDir(_ dataDir: String, _ engine: String) -> String {
        ((dataDir as NSString).appendingPathComponent(modulesDirName) as NSString)
            .appendingPathComponent(engine)
    }

    /// `<数据目录>/modules/<引擎>/deps[/seg...]`
    public static func depsDir(_ dataDir: String, _ engine: String, _ segments: String...) -> String {
        var result = (moduleDir(dataDir, engine) as NSString).appendingPathComponent("deps")
        for seg in segments {
            result = (result as NSString).appendingPathComponent(seg)
        }
        return result
    }

    // MARK: - NW.js

    /// `nwjs.app/Contents/MacOS/nwjs`
    ///
    /// ⚠️ `version` 必须是 deps 下的**真实目录名**（典型是 `v0.106.1`，**带 v**）。
    /// 用户没选版本时上游兜底 `0.106.1`（不带 v）→ 路径不存在 → 点启动没反应。
    /// 所以调用方要先把它修正成真实目录名。
    public static func nwjsBinary(_ dataDir: String, version: String, arch: String) -> String {
        (((((depsDir(dataDir, "nwjs", "version", version) as NSString)
            .appendingPathComponent("nwjs-sdk-\(version)-osx-\(arch)") as NSString)
            .appendingPathComponent("nwjs.app") as NSString)
            .appendingPathComponent("Contents") as NSString)
            .appendingPathComponent("MacOS") as NSString)
            .appendingPathComponent("nwjs")
    }

    /// `deps/version` ——「有没有装过任何版本」用它判断。
    public static func nwjsVersionsDir(_ dataDir: String) -> String {
        depsDir(dataDir, "nwjs", "version")
    }

    // MARK: - mkxp-z

    /// `Z-Universal.app/Contents/MacOS/Z-Universal`
    public static func mkxpzBinary(_ dataDir: String) -> String {
        (((((depsDir(dataDir, "mkxpz") as NSString)
            .appendingPathComponent("mkxpz") as NSString)
            .appendingPathComponent("Z-Universal.app") as NSString)
            .appendingPathComponent("Contents") as NSString)
            .appendingPathComponent("MacOS") as NSString)
            .appendingPathComponent("Z-Universal")
    }

    /// ⚠️ **配置写在这里**（`Z-Universal.app/Contents/Game`）。
    ///
    /// 实测（Mac，2026-11-04）：这份 `Z-Universal` **只读这个位置的 `mkxp.json`**，
    /// 完全不看 cwd、也不看游戏目录。v0.5.2 曾把它改到游戏目录 → 无效（它照旧读这里）。
    /// 这就是 D72 的核心：别再把配置写进游戏目录。
    public static func mkxpzConfigDir(_ dataDir: String) -> String {
        ((((depsDir(dataDir, "mkxpz") as NSString)
            .appendingPathComponent("mkxpz") as NSString)
            .appendingPathComponent("Z-Universal.app") as NSString)
            .appendingPathComponent("Contents") as NSString)
            .appendingPathComponent("Game")
    }

    /// `Contents/Game/mkxp.json`
    public static func mkxpzConfigPath(_ dataDir: String) -> String {
        (mkxpzConfigDir(dataDir) as NSString).appendingPathComponent("mkxp.json")
    }

    /// RTP 根（`deps/RTP/RTP`），给定**引擎目录**。
    ///
    /// 为什么要有个「给定引擎目录」的版本：诊断拿到的是 `modulesDir + engine` 拼出来的
    /// 引擎目录，不是数据目录本身。两个入口指向同一个拼法，才谈得上「唯一来源」（D56）
    /// —— 否则诊断说缺、启动却填另一个路径，会互相打脸。
    public static func mkxpzRtpRoot(engineDir: String) -> String {
        (((engineDir as NSString).appendingPathComponent("deps") as NSString)
            .appendingPathComponent("RTP") as NSString)
            .appendingPathComponent("RTP")
    }

    /// RTP 目录（`deps/RTP/RTP/<名字>`），给定引擎目录。
    public static func mkxpzRtpDir(engineDir: String, rtpName: String) -> String {
        (mkxpzRtpRoot(engineDir: engineDir) as NSString).appendingPathComponent(rtpName)
    }

    /// RTP 目录，给定**数据目录**（启动时填 `mkxp.json` 的 RTP 用这个）。
    public static func mkxpzRtpDir(dataDir: String, rtpName: String) -> String {
        mkxpzRtpDir(engineDir: BinaryPaths.moduleDir(dataDir, "mkxpz"), rtpName: rtpName)
    }

    // MARK: - EasyRPG

    /// `EasyRPG Player.app/Contents/MacOS/EasyRPG Player`
    public static func easyrpgBinary(_ dataDir: String) -> String {
        (((((depsDir(dataDir, "easyrpg") as NSString)
            .appendingPathComponent("player") as NSString)
            .appendingPathComponent("EasyRPG Player.app") as NSString)
            .appendingPathComponent("Contents") as NSString)
            .appendingPathComponent("MacOS") as NSString)
            .appendingPathComponent("EasyRPG Player")
    }

    /// 默认音源（`deps/soundfont/GMGSx.SF2`）。
    ///
    /// ⚠️ 用户没设音源时才自动注入它，**且只在文件真的存在时**。
    /// 传一个不存在的路径会让 EasyRPG 启动即报错。
    public static func easyrpgSoundfont(_ dataDir: String) -> String {
        (depsDir(dataDir, "easyrpg", "soundfont") as NSString)
            .appendingPathComponent("GMGSx.SF2")
    }

    // MARK: - Ren'Py

    /// `deps/renpy` 根目录。
    public static func renpyRoot(_ dataDir: String) -> String {
        depsDir(dataDir, "renpy", "renpy")
    }

    /// Ren'Py 的 `renpy.sh`。
    ///
    /// ⚠️ 两种布局都可能有（实测）：
    ///   · `deps/renpy/renpy.sh`                     —— 平铺解开
    ///   · `deps/renpy/renpy-<x.y.z>-sdk/renpy.sh`   —— 带版本目录
    /// 所以要扫目录找。**不是猜**：真的去 readdir 看哪个存在。
    public static func renpySh(
        _ dataDir: String,
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
        listDir: (String) -> [String] = { dir in
            (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
        }
    ) -> String? {
        let root = renpyRoot(dataDir)

        // ① 平铺
        let flat = (root as NSString).appendingPathComponent("renpy.sh")
        if fileExists(flat) { return flat }

        // ② 带版本目录：找第一个 renpy-*-sdk/renpy.sh
        let entries = listDir(root).sorted()
        for name in entries where name.hasPrefix("renpy-") && name.hasSuffix("-sdk") {
            let candidate = (((root as NSString).appendingPathComponent(name) as NSString)
                .appendingPathComponent("renpy.sh"))
            if fileExists(candidate) { return candidate }
        }
        return nil
    }

    // MARK: - Tyrano（复用 NW.js）

    /// TyranoScript 没有自己的运行时，**复用 NW.js**（零新运行时，D87）。
    /// 所以它的二进制路径就是 nwjs 的。
    public static func tyranoBinary(_ dataDir: String, version: String, arch: String) -> String {
        nwjsBinary(dataDir, version: version, arch: arch)
    }

    // MARK: - 其余四个引擎（P3 实测补齐）

    /// KiriKiri 的可执行文件（`deps/krkr*/krkrsdl2`）。
    ///
    /// ===== 实测（2026-11-06，真下载包 + 真安装）=====
    /// 包 `krkrsdl2-macos.zip` 解开后是**单个裸二进制**：
    ///     krkrsdl2        （16.5MB，可执行）
    ///
    /// ⚠️ **依赖名会多一层子目录**：依赖名叫 `krkrsdl2`，
    /// 所以二进制可能落在 `deps/krkr*/krkrsdl2`（与 siglus 同一个道理）。
    /// 两种落点都兜住：先扫子目录，再看 deps 根。
    public static func kirikiriBinary(
        _ dataDir: String,
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
        listDir: (String) -> [String] = { dir in
            (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
        }
    ) -> String? {
        let deps = depsDir(dataDir, "kirikiri")
        return findBareBinary(
            deps: deps, binaryName: "krkrsdl2",
            fileExists: fileExists, listDir: listDir)
    }

    /// NScripter 的可执行文件（`deps/onscripter*/onscripter`）。
    ///
    /// ===== 实测（2026-11-06，真下载包）=====
    /// 包 `onscripter-20230825bin.tar.bz2` 解开是**两个裸二进制**：
    ///     onscripter         （3.9MB）
    ///     onscripter-sdl2    （5.1MB）
    ///
    /// ⚠️ 用 `onscripter` 而不是 `onscripter-sdl2`：
    /// SDL2 版在无窗口/远程会话下更容易出问题。
    public static func nscripterBinary(
        _ dataDir: String,
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
        listDir: (String) -> [String] = { dir in
            (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
        }
    ) -> String? {
        let deps = depsDir(dataDir, "nscripter")
        return findBareBinary(
            deps: deps, binaryName: "onscripter",
            fileExists: fileExists, listDir: listDir)
    }

    /// 在 deps 及其子目录里找一个**裸二进制**（没有 .app 包装的那种）。
    ///
    /// 判据：先扫 `deps/*/`（依赖名当子目录时），再扫 `deps/` 根。
    /// ⚠️ **子目录优先**：如果依赖名带子目录，二进制就在那里；
    ///    直接扫根会找不到（siglus 真装时就踩了这个）。
    static func findBareBinary(
        deps: String, binaryName: String,
        fileExists: (String) -> Bool, listDir: (String) -> [String]
    ) -> String? {
        // ① deps 根（依赖名不带子目录时）
        let rootCandidate = (deps as NSString).appendingPathComponent(binaryName)
        if fileExists(rootCandidate) { return rootCandidate }

        // ② deps 下每个子目录（依赖名带子目录时 —— 实测 siglus 就是这样）
        //
        // ⚠️ 这里**不能**用 `fileExists(sub)` 判它是目录：
        //    注入的 fileExists 只回答「路径存不存在」，答不了「是不是目录」。
        //    正确做法是直接拿 listDir 试探 —— 它能列出说明是目录。
        for name in listDir(deps).sorted() where !name.hasPrefix(".") {
            let sub = (deps as NSString).appendingPathComponent(name)
            // listDir 对文件会返回空数组，对目录返回内容 → 内容非空说明是目录
            let entries = listDir(sub)
            guard !entries.isEmpty else { continue }
            let candidate = (sub as NSString).appendingPathComponent(binaryName)
            if fileExists(candidate) { return candidate }
        }
        return nil
    }

    /// Siglus 的可执行文件。
    ///
    /// ===== 实测（2026-11-06，真下载包 + 真安装）=====
    /// 包 `siglus-macos-arm64.app.tar.gz` 解开：
    ///     Siglus-arm64.app/Contents/MacOS/Siglus
    ///
    /// ⚠️ 但**落地位置多一层**（真装才发现）：依赖名叫 `siglus_rs`，
    /// 所以实际路径是
    ///     deps/siglus_rs/Siglus-arm64.app/Contents/MacOS/Siglus
    ///     注意 `deps/siglus_rs/` 这一层 —— 它是**依赖名**，不是包内目录。
    ///
    /// ⚠️ 而且 **app 名里带架构后缀**（`-arm64` / `-x86_64`），所以不能写死名字。
    ///
    /// 判据：先看 `deps/<依赖名>/` 下，再看 `deps/` 根（两种布局都要兜住 ——
    /// 依赖名可能不带子目录，那时它就落在 deps 根）。
    ///
    /// - Returns: 二进制路径；找不到 .app 时返回 nil（由调用方报「引擎没装好」）
    public static func siglusBinary(
        _ dataDir: String,
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
        listDir: (String) -> [String] = { dir in
            (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
        }
    ) -> String? {
        let deps = depsDir(dataDir, "siglus")

        // ⚠️ 两种可能的落点：
        //   ① deps/siglus_rs/Siglus-*.app   ← 实测的（依赖名当子目录）
        //   ② deps/Siglus-*.app             ← 依赖名不带子目录时
        var searchRoots = [deps]
        var subdirs: [String] = []
        for name in listDir(deps) where name.hasPrefix("siglus") || name.hasPrefix("Siglus") {
            let candidate = (deps as NSString).appendingPathComponent(name)
            subdirs.append(candidate)
        }
        // 子目录优先（实测这才是对的）
        searchRoots = subdirs + [deps]

        for root in searchRoots {
            let apps = listDir(root)
                .filter { $0.hasPrefix("Siglus") && $0.hasSuffix(".app") }
                .sorted()
            guard let app = apps.first else { continue }

            let binary = ((((root as NSString).appendingPathComponent(app) as NSString)
                .appendingPathComponent("Contents") as NSString)
                .appendingPathComponent("MacOS") as NSString)
                .appendingPathComponent("Siglus")
            if fileExists(binary) { return binary }
        }
        return nil
    }

    /// Godot 的可执行文件。
    ///
    /// ⚠️ **未实测**（2026-11-06）：
    /// 包是 `Godot_v4.6.1-stable_macos.universal.zip`（**161MB**），
    /// 本鱼只验了 HTTP 200 与 content-length，**没有真下载解压看结构**。
    ///
    /// 已知信息（来自 D92 的调研）：官方 mac 包解开是
    /// `Godot.app/Contents/MacOS/Godot`。
    ///
    /// ⚠️ 但**版本号在包名里**（`Godot_v4.6.1-stable_macos.universal.zip`），
    /// 解开后目录名可能是 `Godot.app`（不带版本）也可能带。**所以这里扫目录**，
    /// 与 siglus 同一策略（不写死名字）。
    ///
    /// 如果实际布局与假设不符，`siglusBinary` 式的扫描会返回 nil，
    /// 调用方会报「引擎没装好」而不是崩 —— 这是「不猜」的最低保证。
    public static func godotBinary(
        _ dataDir: String,
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
        listDir: (String) -> [String] = { dir in
            (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
        }
    ) -> String? {
        let deps = depsDir(dataDir, "godot")

        // 扫 deps 下的 Godot*.app
        let apps = listDir(deps)
            .filter { $0.hasPrefix("Godot") && $0.hasSuffix(".app") }
            .sorted()
        guard let app = apps.first else { return nil }

        // 可执行名可能是 `Godot` 或 `Godot_v4.6.1-stable`（不确定，两个都试）
        let macosDir = (((deps as NSString).appendingPathComponent(app) as NSString)
            .appendingPathComponent("Contents") as NSString)
            .appendingPathComponent("MacOS")
        for name in ["Godot", "godot"] {
            let candidate = (macosDir as NSString).appendingPathComponent(name)
            if fileExists(candidate) { return candidate }
        }
        // 兜底：扫 MacOS 目录下第一个可执行（文件名完全不定时）
        let entries = listDir(macosDir)
            .filter { !$0.hasPrefix(".") }
            .sorted()
        for name in entries {
            let candidate = (macosDir as NSString).appendingPathComponent(name)
            if fileExists(candidate) { return candidate }
        }
        return nil
    }

    // MARK: - 统一的引擎二进制入口

    /// 按引擎名给出可执行文件路径。**这是唯一入口**。
    ///
    /// - Returns: 路径；`nil` 表示「这个引擎的运行时还没装好/找不到」
    public static func binary(
        for engine: String,
        dataDir: String,
        version: String = "",
        arch: String = "arm64",
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
        listDir: (String) -> [String] = { dir in
            (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
        }
    ) -> String? {
        switch engine {
        case "nwjs", "tyrano":
            let p = nwjsBinary(dataDir, version: version, arch: arch)
            return fileExists(p) ? p : nil
        case "mkxpz":
            let p = mkxpzBinary(dataDir)
            return fileExists(p) ? p : nil
        case "easyrpg":
            let p = easyrpgBinary(dataDir)
            return fileExists(p) ? p : nil
        case "renpy":
            return renpySh(dataDir, fileExists: fileExists, listDir: listDir)
        case "kirikiri":
            return kirikiriBinary(
                dataDir, fileExists: fileExists, listDir: listDir)
        case "nscripter":
            return nscripterBinary(
                dataDir, fileExists: fileExists, listDir: listDir)
        case "siglus":
            return siglusBinary(dataDir, fileExists: fileExists, listDir: listDir)
        case "godot":
            return godotBinary(dataDir, fileExists: fileExists, listDir: listDir)
        default:
            return nil
        }
    }
}
