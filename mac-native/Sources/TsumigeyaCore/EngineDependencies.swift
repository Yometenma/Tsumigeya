// 引擎依赖表（下载 URL）。
//
// 对应 Electron 版：src/main/engines/registry.ts 每个引擎的 `dependencies` 段
// 契约：D62（安装时从 registry 生成 manifest）/ D69（保留单层目录）
//
// ===== 为什么单独一个文件 =====
//
// P1 时本鱼**刻意没搬**这张表（那时搬了也验证不了，是"写了但没人用"）。
// P3 装引擎时它成了硬需求 —— 全新安装没有本地 manifest，URL 只能从 registry 来。
//
// 单独放一个文件而不是塞进 EngineRegistry.swift：那张表是本文件的唯一内容，
// 让它自己成一篇，改 URL 时不用在 400 行里翻。
//
// ===== 数据来源 =====
//
// 全部**逐条照抄** `src/main/engines/registry.ts`（2026-11-06 提取）。
// 九条 URL 都实测过可达（本鱼下载了其中三个看包内结构，见 BinaryPaths 的注释）。
// tyrano **没有依赖**（复用 nwjs 的运行时，D87）。
import Foundation

public enum EngineDependencies {

    /// 可启动引擎的依赖表（按 folder 索引，**顺序即依赖声明顺序**）。
    ///
    /// ⚠️ 顺序有意义：mkxpz 本体在前、RTP / kawariki / soundfont 在后
    /// —— 用户看到进度条先动主二进制，心理上「它在装引擎」，
    /// 而不是先下 244MB 的 RTP 却不知道在装什么。
    public static func dependencies(for engine: String) -> [(name: String, spec: DependencySpec)] {
        switch WineRuntime.canonicalEngine(engine) {
        case "wine":
            return [("wine", DependencySpec(builds: ["universal": DependencyBuild(
                link: "https://github.com/Gcenx/macOS_Wine_builds/releases/download/11.21/wine-devel-11.21-osx64.tar.xz",
                unzip: true, sha256: "9909b486657e10ab66c7279371ae1f990345b596b3b1b3a0cf21f28af24fa0ce")]))]
        // ---- NW.js（RPG Maker MV / MZ）----
        //
        // ⚠️ 分架构包：arm64 与 x86_64 是两个完全不同的下载。
        //    版本目录名是 `version/v0.106.1`（**带 v**），落成 deps/version/v0.106.1/
        case "nwjs":
            return [
                ("version/v0.106.1", .split(
                    arm64: "https://dl.nwjs.io/v0.106.1/nwjs-sdk-v0.106.1-osx-arm64.zip",
                    x86_64: "https://dl.nwjs.io/v0.106.1/nwjs-sdk-v0.106.1-osx-x64.zip")),
            ]

        // ---- mkxp-z（RPG Maker XP / VX / VX Ace）----
        //
        // 四个依赖，顺序就是这里写的顺序。
        // ⚠️ soundfont 的 `unzip: false` —— 它是裸的 .sf2 文件，不是压缩包。
        case "mkxpz":
            return [
                ("mkxpz", .universal(
                    "https://github.com/m5kro/mkxp-z/releases/download/launcher/Z-universal.zip")),
                ("RTP", .universal(
                    "https://github.com/m5kro/mkxp-z/releases/download/launcher/RTP.zip")),
                ("kawariki", .universal(
                    "https://github.com/m5kro/mkxp-z/releases/download/launcher/kawariki.zip")),
                ("soundfont", .universal(
                    "https://github.com/mmontag/chip-player-js/raw/refs/heads/master/soundfonts/gmgsx-plus.sf2",
                    unzip: false)),
            ]

        // ---- EasyRPG（RPG Maker 2000 / 2003）----
        //
        // ⚠️ `soundfont` 是 **optional**：它的站有 Cloudflare 人机验证，
        //    程序化请求**恒 403**。可容忍失败的依赖不该让整个安装失败。
        case "easyrpg":
            return [
                ("player", .universal(
                    "https://ci.easyrpg.org/downloads/macos/EasyRPG-Player-macos.app.zip")),
                ("soundfont", .universal(
                    "https://musical-artifacts.com/artifacts/841/GMGSx.SF2",
                    unzip: false, optional: true)),
            ]

        // ---- Ren'Py ----
        case "renpy":
            return [
                ("renpy", .universal("https://www.renpy.org/dl/8.5.2/renpy-8.5.2-sdk.zip")),
            ]

        // ---- TyranoScript ----（**没有依赖**：复用 NW.js 的运行时，D87）
        case "tyrano":
            return []

        // ---- KiriKiri（krkrsdl2）----
        case "kirikiri":
            return [
                ("krkrsdl2", .universal(
                    "https://github.com/krkrsdl2/krkrsdl2/releases/download/latest/krkrsdl2-macos.zip")),
            ]

        // ---- NScripter（ONSyuri）----
        //
        // ===== 为什么换成 ONSyuri（2026-11-21 实测）=====
        //
        // tmkk 的 `onscripter-20230825bin.tar.bz2` 里那个 `onscripter` 是 ppc + i386，
        // 现代 macOS 直接 `bad CPU type in executable`；同包的 `onscripter-sdl2` 虽然是
        // x86_64 + arm64，但要外挂 SDL2（缺库时静默挂死），而且只有 SJIS 转换表 ——
        // 中文脚本必乱码、`nt2`/`nt3` 加密脚本读不出。
        //
        // ONSyuri（OnscripterYuri 0.7.7beta）给 arm64 原生 + `--enc:gbk|sjis|utf8`
        // + `nt2`/`nt3`，与 Launcher 按同一套约定启动。
        //
        // ⚠️ **必须自托管**：上游的 mac 包只动态链接 `/opt/homebrew/opt/...` 下的
        //    lua/sdl2 全家（用户机器上没有 Homebrew 就起不来）。所以这里下载的是
        //    我方重新打包的产物：二进制 + `lib/*.dylib`，依赖全部改写成 `@loader_path/lib`，
        //    并做了 ad-hoc 签名。解包后落成：
        //        deps/onsyuri/onsyuri
        //        deps/onsyuri/lib/*.dylib
        //    与其它运行时一样，**只有用户在「引擎」页点安装时才会下载**。
        //
        // ⚠️ `lib/libSDL3.dylib` 是必需的：brew 的 `libSDL2-2.0.0.dylib` 实际是
        //    **sdl2-compat**，它运行时会 dlopen `@loader_path/libSDL3.dylib`。
        //    dylibbundler 看不见这种加载 —— 漏了它 macOS 上启动即
        //    `Fatal error! Failed loading SDL3 library.`
        case "nscripter":
            return [
                ("onsyuri", DependencySpec(builds: ["universal": DependencyBuild(
                    link: "https://github.com/Yometenma/Tsumigeya/releases/download/deps-onsyuri-0.7.7/onsyuri-macos-arm64.tar.gz",
                    unzip: true,
                    sha256: "c9cd731e85d159d02d5cc94f42ea99e833c350b75b5c01e169fce501c10a6f4b")])),
            ]

        // ---- Siglus（siglus_rs）----
        //
        // ⚠️ 分架构包。**app 名里带架构后缀**（`Siglus-arm64.app` / `Siglus-x86_64.app`），
        //    所以 BinaryPaths.siglusBinary 要扫目录，不能写死名字。
        case "siglus":
            return [
                ("siglus_rs", .split(
                    arm64: "https://github.com/xmoezzz/siglus_rs/releases/download/pre-release/siglus-macos-arm64.app.tar.gz",
                    x86_64: "https://github.com/xmoezzz/siglus_rs/releases/download/pre-release/siglus-macos-x86_64.app.tar.gz")),
            ]

        case "godot":
            return [
                ("godot", .universal(
                    "https://github.com/godotengine/godot-builds/releases/download/4.6.1-stable/Godot_v4.6.1-stable_macos.universal.zip")),
            ]

        default:
            return []
        }
    }

    /// 按依赖表生成一份 manifest（D62：字段名兼容上游）。
    ///
    /// ⚠️ **字段名一个不能差**：这份 manifest 要能被我方读回，
    /// 也要能让原版 Xenolauncher 读（万一用户的 modules 目录被两边共用）。
    ///
    /// ⚠️ 依赖表从 `dependencies(for:)` 取，**不从 `definition.dependencies`** ——
    /// 那个字段在 registry 里是空的（数据实际放在本文件）。
    public static func buildManifest(for definition: EngineDefinition) -> [String: JSONValue] {
        var deps: [String: JSONValue] = [:]
        for (name, spec) in dependencies(for: definition.folder) {
            var builds: [String: JSONValue] = [:]
            for (arch, build) in spec.builds {
                var value: [String: JSONValue] = ["link": .string(build.link), "unzip": .bool(build.unzip)]
                if let hash = build.sha256 { value["sha256"] = .string(hash) }
                builds[arch] = .object(value)
            }
            var depObj = builds
            if spec.optional { depObj["optional"] = .bool(true) }
            // ⚠️ D69：只有在**明确要拍平**时才写这个字段（默认是保留）
            if !spec.keepSingleDir { depObj["keepSingleDir"] = .bool(false) }
            deps[name] = .object(depObj)
        }

        var autodetect: JSONValue = .object([:])
        if let rule = definition.autodetect {
            var obj: [String: JSONValue] = [:]
            if let ext = rule.extensions { obj["extensions"] = .array(ext.map { .string($0) }) }
            if let ext = rule.extension_ { obj["extension"] = .string(ext) }
            if let files = rule.files { obj["files"] = .array(files.map { .string($0) }) }
            if let all = rule.allRequired { obj["all_required"] = .bool(all) }
            autodetect = .object(obj)
        }

        return [
            "name": .string(definition.name),
            "version": .string(definition.folder == "wine" ? "11.21" : "1.0.0"),
            "description": .string("Managed by Tsumigeya."),
            "author": .string(definition.folder == "wine" ? "Wine 项目／Gcenx" : "Tsumigeya"),
            "license": .string(definition.folder == "wine" ? "LGPL-2.1-or-later" : "GPL-3.0"),
            "autodetect": autodetect,
            "gameArgs": .object(argumentSchema(for: definition.folder)),
            "dependencies": .object(deps),
        ]
    }

    /// 每个引擎写进 manifest 的参数 schema。
    ///
    /// ⚠️ 只有**需要用户干预**的引擎才给 schema：
    ///    wine 指 Windows 启动文件与语言环境，ONS 指脚本编码（编码判错就是乱码）。
    ///    其余引擎的参数表单是空的（D61 精简），别为了「看起来完整」塞默认项。
    static func argumentSchema(for folder: String) -> [String: JSONValue] {
        switch WineRuntime.canonicalEngine(folder) {
        case "wine": return WineRuntime.argumentSchema
        case "nscripter": return ONSRuntime.argumentSchema
        default: return [:]
        }
    }
}
