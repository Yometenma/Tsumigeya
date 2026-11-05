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

    // MARK: - 其余引擎（P3 再补具体布局）

    /// Krkrz / ONScripter / Siglus / Godot 的具体路径。
    ///
    /// ⚠️ P2 阶段这四项目前**没有已装样本可验**（用户机器上只装了 4 个引擎，
    /// 这 4 个都不在里面）。**不凭猜写路径** —— 猜出来的路径「看起来对」，
    /// 但启动时才失败，而且失败原因会指向"引擎装坏了"。
    ///
    /// 所以这里返回 nil，由调用方报「这个引擎的运行时路径还没实现」。
    /// P3 装上真实引擎后，按 `deps/` 下**实际看到的**目录布局补上。
    public static func unverifiedBinary(_ engine: String) -> String? {
        switch engine {
        case "kirikiri", "nscripter", "siglus", "godot":
            return nil
        default:
            return nil
        }
    }
}
