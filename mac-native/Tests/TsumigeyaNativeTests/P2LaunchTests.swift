// P2 启动层测试。
//
// 对应 Electron 版：test/launchers-*.test.ts / test/binary-paths.test.ts / test/spawn-*.test.ts
//
// ===== 本文件最重要的两条（都是本次移植踩出来的真 bug）=====
//
// ① **CRLF 的 `split(separator: "\n")` 只切出 1 行**
//    见 GameIniTests.crlfSplitsProperly
//
// ② **mkxp.json 只能写 app 包内，不能写游戏目录**（D72）
//    见 MkxpzConfigTests.configGoesToBundle
import Foundation
import Testing

@testable import TsumigeyaNative

// MARK: - 路径拼法（D56 唯一来源）

@Suite("引擎二进制路径")
struct BinaryPathsTests {

    let data = "/data"

    @Test("NW.js 路径拼法")
    func nwjsPath() {
        let p = BinaryPaths.nwjsBinary(data, version: "v0.106.1", arch: "arm64")
        #expect(p == "/data/modules/nwjs/deps/version/v0.106.1/"
                + "nwjs-sdk-v0.106.1-osx-arm64/nwjs.app/Contents/MacOS/nwjs")
    }

    /// ⚠️ arch 必须由调用方传，不能自己读 —— 否则 x64 分支永远测不到。
    @Test("NW.js 的 arch 影响路径")
    func nwjsArchMatters() {
        let arm = BinaryPaths.nwjsBinary(data, version: "v0.1", arch: "arm64")
        let x64 = BinaryPaths.nwjsBinary(data, version: "v0.1", arch: "x64")
        #expect(arm != x64)
        #expect(arm.contains("osx-arm64"))
        #expect(x64.contains("osx-x64"))
    }

    @Test("mkxp-z 路径拼法")
    func mkxpzPath() {
        #expect(BinaryPaths.mkxpzBinary(data)
                == "/data/modules/mkxpz/deps/mkxpz/Z-Universal.app/Contents/MacOS/Z-Universal")
    }

    /// ⚠️ **配置在 app 包内**（D72），不是游戏目录。
    @Test("mkxp-z 配置路径在 app 包内")
    func mkxpzConfigInBundle() {
        let p = BinaryPaths.mkxpzConfigPath(data)
        #expect(p.hasSuffix("Z-Universal.app/Contents/Game/mkxp.json"))
    }

    @Test("EasyRPG 路径拼法")
    func easyrpgPath() {
        #expect(BinaryPaths.easyrpgBinary(data)
                == "/data/modules/easyrpg/deps/player/EasyRPG Player.app/Contents/MacOS/EasyRPG Player")
    }

    /// Ren'Py 两种布局都要认（平铺 / 带版本目录）。
    @Test("Ren'Py 平铺布局")
    func renpyFlat() {
        let fake = FakeFS(["/data/modules/renpy/deps/renpy/renpy.sh"])
        let p = BinaryPaths.renpySh(data, fileExists: fake.exists, listDir: { _ in [] })
        #expect(p == "/data/modules/renpy/deps/renpy/renpy.sh")
    }

    @Test("Ren'Py 带版本目录布局")
    func renpyVersioned() {
        let dir = "/data/modules/renpy/deps/renpy"
        let fake = FakeFS(["\(dir)/renpy-8.0.3-sdk/renpy.sh"])
        let p = BinaryPaths.renpySh(
            data, fileExists: fake.exists,
            listDir: { _ in ["renpy-8.0.3-sdk", "other"] })
        #expect(p == "\(dir)/renpy-8.0.3-sdk/renpy.sh")
    }

    @Test("Ren'Py 都没装时返回 nil")
    func renpyMissing() {
        let fake = FakeFS([])
        #expect(BinaryPaths.renpySh(data, fileExists: fake.exists, listDir: { _ in [] }) == nil)
    }

    /// 引擎 ID 列表必须与注册表的可启动引擎**同源**（多一个少一个都会红）。
    @Test("engineIDs 与注册表一致")
    func engineIDsMatchRegistry() {
        let registryFolders = EngineRegistry.launchable.map(\.folder).sorted()
        let pathFolders = BinaryPaths.engineIDs.sorted()
        #expect(registryFolders == pathFolders,
                "binary-paths 的 engineIDs 与 registry 的可启动引擎必须一致")
    }
}

// MARK: - Game.ini 解析

@Suite("Game.ini 解析")
struct GameIniTests {

    /// ⚠️⚠️ **本文件最重要的一条：CRLF 必须正确切行。**
    ///
    /// 实测踩到的真 bug（2026-11-06）：
    /// `text.split(separator: "\n")` 对 CRLF 文件**只切出 1 行** ——
    /// 因为 Swift 的 `String` 按 **Character（字素簇）** 比较，
    /// 而 `\r\n` 是**一个** Character，`"\n"` 匹配不到它。
    ///
    /// 后果（极隐蔽，完全不报错）：
    ///   · `[Game]` 那行变成 `"[Game]\r\nRTP=...\r\nLibrary=..."` 一整串
    ///   · section 变成 `"game]\r\nRTP=..."`，永远不等于 `"game"`
    ///   · RTP / Library / Scripts **一个都读不到**
    ///   · rgssVersion 推不出来 → mkxp.json 里只写 gameFolder
    ///   · **游戏照样能启动**（mkxp-z 会自己猜版本）→ 问题被完全掩盖
    ///
    /// 本机的真实 `Game.ini` 正是 CRLF（`5b47 616d 655d 0d0a` = `[Game]\r\n`）。
    @Test("CRLF 文件能正确切行")
    func crlfSplitsProperly() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-ini-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        // 完全按真实文件的字节结构：CRLF + RPGVXAce（大写 A）
        let content = "[Game]\r\nRTP=RPGVXAce\r\nLibrary=System\\RGSS300.dll\r\n"
            + "Scripts=Data\\Scripts.rvdata2\r\nTitle=_CHN\r\n"
        try content.write(toFile: tmp.appendingPathComponent("Game.ini").path,
                          atomically: true, encoding: .isoLatin1)

        let ini = GameIniReader.read(gameDir: tmp.path)

        #expect(ini.exists)
        #expect(ini.rtp == "RPGVXAce", "CRLF 下必须能读到 RTP")
        #expect(ini.library == "System\\RGSS300.dll")
        #expect(ini.scripts == "Data\\Scripts.rvdata2")
        #expect(ini.hasRtpLine)
    }

    /// LF 文件也要正确（不能修 CRLF 又坏 LF）。
    @Test("LF 文件能正确切行")
    func lfSplitsProperly() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-ini-lf-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let content = "[Game]\nRTP=RPGVXAce\nLibrary=System\\RGSS300.dll\n"
        try content.write(toFile: tmp.appendingPathComponent("Game.ini").path,
                          atomically: true, encoding: .isoLatin1)

        let ini = GameIniReader.read(gameDir: tmp.path)
        #expect(ini.rtp == "RPGVXAce")
        #expect(ini.library == "System\\RGSS300.dll")
    }

    /// GBK 的 Title **不能**影响结构行的读取（D71 的前提）。
    @Test("GBK Title 不影响结构行")
    func gbkTitleDoesNotBreakStructure() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-ini-gbk-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        // 「蒼」的 GBK 编码是 0xB2 0xD4；用 latin1 读会变成两个不可打印字符
        let prefix = "RTP=RPGVXAce\r\nLibrary=System\\RGSS300.dll\r\n"
        var bytes = Array("[Game]\r\n".utf8)
        bytes += Array(prefix.utf8)
        // 手写 GBK 字节的 Title 行
        bytes += Array("Title=".utf8)
        bytes += [0xB2, 0xD4, 0xD4, 0xC5]
        bytes += Array("\r\n".utf8)

        try Data(bytes).write(to: tmp.appendingPathComponent("Game.ini"))

        let ini = GameIniReader.read(gameDir: tmp.path)
        #expect(ini.rtp == "RPGVXAce")
        #expect(ini.library == "System\\RGSS300.dll")
    }

    @Test("没有 Game.ini 返回 empty")
    func missingIni() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-ini-none-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        let ini = GameIniReader.read(gameDir: tmp.path)
        #expect(ini.exists == false)
        #expect(ini.rtp == nil)
    }

    /// 只有 `[Game]` 段里的键才算 —— 别的段里有同名键不能读（避免误读）。
    @Test("只读 [Game] 段")
    func onlyGameSection() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-ini-sec-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let content = "[Other]\nRTP=RPGVX\n[Game]\nRTP=RPGVXace\n"
        try content.write(toFile: tmp.appendingPathComponent("Game.ini").path,
                          atomically: true, encoding: .isoLatin1)

        let ini = GameIniReader.read(gameDir: tmp.path)
        #expect(ini.rtp == "RPGVXace")
    }
}

// MARK: - RTP 表（D59）

@Suite("RTP 表")
struct RtpTableTests {

    /// ⚠️ D59：**XP 的目录名是 `Standard`，不是 `RPGXP`**。
    /// 错映射 → 查一个永远不存在的目录 → XP 永久判「RTP 缺失」，补装也修不掉。
    @Test("XP 映射到 Standard 而不是 RPGXP")
    func xpIsStandard() {
        #expect(RtpTable.byRgssVersion[1] == "Standard")
        #expect(RtpTable.byRgssVersion[2] == "RPGVX")
        #expect(RtpTable.byRgssVersion[3] == "RPGVXace")
    }

    /// 别名归一化（含大小写不敏感）。
    @Test("RTP 名别名归一化")
    func normalizeAlias() {
        #expect(RtpTable.normalizeRtpName("RPGXP") == "Standard")
        #expect(RtpTable.normalizeRtpName("rpgxp") == "Standard")
        #expect(RtpTable.normalizeRtpName("Standard") == "Standard")
        // ⚠️ 小写 a 的规范名
        #expect(RtpTable.normalizeRtpName("RPGVXAce") == "RPGVXace")
        #expect(RtpTable.normalizeRtpName("rpgvxace") == "RPGVXace")
        #expect(RtpTable.normalizeRtpName("RPGVX") == "RPGVX")
        // 未知名原样返回（由调用方判「无法确定」）
        #expect(RtpTable.normalizeRtpName("Custom") == "Custom")
        #expect(RtpTable.normalizeRtpName("") == nil)
        #expect(RtpTable.normalizeRtpName(nil) == nil)
    }

    @Test("从目录名反查版本")
    func versionOfName() {
        #expect(RtpTable.versionOfRtpName("Standard") == 1)
        #expect(RtpTable.versionOfRtpName("RPGVX") == 2)
        #expect(RtpTable.versionOfRtpName("RPGVXace") == 3)
        #expect(RtpTable.versionOfRtpName("Unknown") == nil)
    }
}

// MARK: - ASCII 符号链接（D72）

@Suite("ASCII 符号链接")
struct AsciiAliasTests {

    @Test("中文路径需要别名，纯 ASCII 不需要")
    func needsAlias() {
        #expect(AsciiAlias.needsAsciiAlias("/Users/x/games/蒼藍星"))
        #expect(AsciiAlias.needsAsciiAlias("/Users/x/games/傭兵の冒険"))
        #expect(!AsciiAlias.needsAsciiAlias("/Users/x/games/MyGame"))
    }

    /// 别名路径必须**本身是纯 ASCII**（关键：basename 也要削）。
    @Test("别名路径是纯 ASCII")
    func aliasIsAscii() {
        let alias = AsciiAlias.aliasPath(for: "/Users/x/games/蒼藍星")
        #expect(alias.unicodeScalars.allSatisfy { $0.isASCII },
                "别名路径不能含任何非 ASCII：\(alias)")
        #expect(alias.hasPrefix("/tmp/tsumigeya-"))
    }

    /// 同一个路径必须得到同一个别名（幂等）。
    @Test("别名路径稳定")
    func aliasStable() {
        let a = AsciiAlias.aliasPath(for: "/Users/x/games/蒼藍星")
        let b = AsciiAlias.aliasPath(for: "/Users/x/games/蒼藍星")
        #expect(a == b)
    }

    /// 不同路径必须得到不同别名（否则两个中文游戏会互相覆盖链接）。
    @Test("不同路径得到不同别名")
    func aliasUnique() {
        let a = AsciiAlias.aliasPath(for: "/Users/x/games/蒼藍星")
        let b = AsciiAlias.aliasPath(for: "/Users/x/games/傭兵の冒険")
        #expect(a != b)
    }

    /// 真的建链接，并验证指向正确。
    @Test("建链接并解析回原路径")
    func createsRealSymlink() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-alias-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }
        defer { AsciiAlias.removeAlias(for: tmp.path) }

        let alias = try AsciiAlias.ensureAlias(for: tmp.path)
        #expect(try FileManager.default.destinationOfSymbolicLink(atPath: alias) == tmp.path)

        // 幂等：再建一次还是同一个
        let again = try AsciiAlias.ensureAlias(for: tmp.path)
        #expect(again == alias)
    }
}

// MARK: - SHA1

@Suite("SHA1")
struct SHA1Tests {

    /// 与已知向量比对（确保手写的 SHA1 是对的）。
    @Test("已知向量")
    func knownVectors() {
        #expect(sha1Hex("abc") == "a9993e364706816aba3e25717850c26c9cd0d89d")
        #expect(sha1Hex("") == "da39a3ee5e6b4b0d3255bfef95601890afd80709")
    }
}

// MARK: - mkxp.json 配置

@Suite("mkxp 配置")
struct MkxpzConfigTests {

    /// ⚠️ **配置必须写到 app 包内**（D72）。
    /// 守的是：v0.5.2 曾把配置写进游戏目录 → 完全无效（mkxp-z 根本不读那里）。
    @Test("配置路径在 app 包内，不在游戏目录")
    func configGoesToBundle() {
        let configPath = BinaryPaths.mkxpzConfigPath("/data")
        #expect(configPath.contains("Z-Universal.app/Contents/Game/mkxp.json"))
        #expect(!configPath.contains("/games/"))
    }

    /// 构造的配置里 gameFolder 是**传进来的**那个（由调用方决定是真实路径还是 ASCII 别名）。
    @Test("gameFolder 用调用方给的值")
    func gameFolderFromArgument() {
        let ctx = LaunchContext(
            folder: "/games/蒼藍星", gamePath: "/games/蒼藍星/Game.exe",
            gameArgs: [:], gameTitle: "蒼藍星", dataDir: "/data", arch: "arm64")
        let config = MkxpzConfig.build(
            context: ctx, folder: "/tmp/alias", rgssVersion: 3, rtpDirs: ["/data/RTP"])
        #expect(config["gameFolder"]?.stringValue == "/tmp/alias")
        #expect(config["rgssVersion"]?.intValue == 3)
    }

    /// RTP 显式版本优先。
    @Test("gameArgs.rgssVersion 优先")
    func explicitVersionWins() {
        let ctx = LaunchContext(
            folder: "/games/x", gamePath: "/games/x/Game.exe",
            gameArgs: ["rgssVersion": .int(3)],
            gameTitle: "x", dataDir: "/data", arch: "arm64")
        let rtp = MkxpzConfig.resolveRtp(context: ctx)
        #expect(rtp.rgssVersion == 3)
        #expect(rtp.source == "gameArgs")
        #expect(rtp.rtpDirs.count == 1)
        #expect(rtp.rtpDirs[0].hasSuffix("RTP/RPGVXace"))
    }

    /// 没显式版本 → 从 Game.ini 的 Library= 推。
    @Test("从 Library 推出 rgssVersion")
    func versionFromLibrary() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-mkxp-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        let content = "[Game]\r\nRTP=RPGVXAce\r\nLibrary=System\\RGSS300.dll\r\n"
        try content.write(toFile: tmp.appendingPathComponent("Game.ini").path,
                          atomically: true, encoding: .isoLatin1)

        let ctx = LaunchContext(
            folder: tmp.path, gamePath: tmp.path + "/Game.exe",
            gameArgs: [:], gameTitle: "x", dataDir: "/data", arch: "arm64")
        let rtp = MkxpzConfig.resolveRtp(context: ctx)
        #expect(rtp.rgssVersion == 3)
        #expect(rtp.source == "gameIni")
        #expect(rtp.rtpDirs[0].hasSuffix("RTP/RPGVXace"))
    }

    /// 只有 RTP= 没有 Library= 也能推出（靠目录名反查 —— 这是必须的兜底）。
    @Test("只有 RTP= 时靠目录名反查版本")
    func versionFromRtpName() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-mkxp2-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: tmp, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: tmp) }

        // 没写 Library=，只有 RTP=
        try "[Game]\r\nRTP=RPGVXAce\r\n".write(
            toFile: tmp.appendingPathComponent("Game.ini").path,
            atomically: true, encoding: .isoLatin1)

        let ctx = LaunchContext(
            folder: tmp.path, gamePath: tmp.path + "/Game.exe",
            gameArgs: [:], gameTitle: "x", dataDir: "/data", arch: "arm64")
        let rtp = MkxpzConfig.resolveRtp(context: ctx)
        #expect(rtp.rgssVersion == 3)
    }

    /// XP 的 RTP=RPGXP 要映射成 Standard（D59）。
    @Test("XP 的 RPGXP 映射到 Standard")
    func xpMapping() throws {
        let ctx = LaunchContext(
            folder: "/games/xp", gamePath: "/games/xp/Game.exe",
            gameArgs: ["rgssVersion": .int(1)],
            gameTitle: "x", dataDir: "/data", arch: "arm64")
        let rtp = MkxpzConfig.resolveRtp(context: ctx)
        #expect(rtp.rtpDirs[0].hasSuffix("RTP/Standard"))
        #expect(!rtp.rtpDirs[0].hasSuffix("RPGXP"))
    }

    /// 写出来是合法 JSON，中文不转义。
    @Test("写出的配置是合法 JSON 且中文不转义")
    func writesValidJSON() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-write-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: tmp) }

        let config: MkxpConfig = [
            "gameFolder": .string("/tmp/alias"),
            "windowTitle": .string("傭兵の冒険"),
        ]
        #expect(MkxpzConfig.write(config, to: tmp.path) == nil)

        let text = try String(contentsOfFile: tmp.path, encoding: .utf8)
        #expect(text.contains("傭兵の冒険"))
        #expect(!text.contains("\\u"))
        // 可被重新解析
        let back = try JSONDecoder().decode(MkxpConfig.self, from: Data(text.utf8))
        #expect(back["gameFolder"]?.stringValue == "/tmp/alias")
    }
}

// MARK: - 启动计划

@Suite("启动计划")
struct LaunchPlanTests {

    let ctx = LaunchContext(
        folder: "/games/x", gamePath: "/games/x/Game.exe",
        gameArgs: [:], gameTitle: "x", dataDir: "/tempdata", arch: "arm64")

    /// NW.js：args = [游戏目录]。
    @Test("NW.js 参数只有游戏目录")
    func nwjsArgs() throws {
        // 用真临时目录（mkxpz 要写配置，不能全靠 FakeFS）
        let data = try makeTempDataDir()
        defer { try? FileManager.default.removeItem(at: data) }

        let ctx = LaunchContext(
            folder: "/games/x", gamePath: "/games/x/Game.exe",
            gameArgs: ["version": .string("v0.1")],
            gameTitle: "x", dataDir: data.path, arch: "arm64")
        let fake = FakeFS([BinaryPaths.nwjsBinary(data.path, version: "v0.1", arch: "arm64")])
        guard case .success(let plan) = LaunchPlanner.plan(
            engine: "nwjs", context: ctx, fileExists: fake.exists) else {
            Issue.record("应该成功"); return
        }
        #expect(plan.args == ["/games/x"])
        #expect(plan.cwd == "/games/x")
    }

    /// ⚠️ **全屏开关必须在游戏目录之后**（D80）。
    /// 守的是：放在 `<path>` 之前会被 NW.js 当成它自己的参数。
    @Test("NW.js 全屏开关在游戏目录之后")
    func nwjsFullscreenOrder() throws {
        let data = try makeTempDataDir()
        defer { try? FileManager.default.removeItem(at: data) }

        let ctx = LaunchContext(
            folder: "/games/x", gamePath: "/games/x/Game.exe",
            gameArgs: ["fullscreen": .bool(true), "version": .string("v0.1")],
            gameTitle: "x", dataDir: data.path, arch: "arm64")
        let fake = FakeFS([BinaryPaths.nwjsBinary(data.path, version: "v0.1", arch: "arm64")])
        guard case .success(let plan) = LaunchPlanner.plan(
            engine: "nwjs", context: ctx, fileExists: fake.exists) else {
            Issue.record("应该成功"); return
        }
        #expect(plan.args.first == "/games/x", "游戏目录必须是第一个")
        #expect(plan.args.contains("--start-fullscreen"))
        #expect(plan.args.firstIndex(of: "--start-fullscreen")! > 0)
    }

    /// mkxp-z：**无参数、不传 cwd**（D72）。
    @Test("mkxp-z 无参数且不传 cwd")
    func mkxpzNoArgsNoCwd() throws {
        let data = try makeTempDataDir()
        defer { try? FileManager.default.removeItem(at: data) }

        let ctx = LaunchContext(
            folder: "/games/x", gamePath: "/games/x/Game.exe",
            gameArgs: [:], gameTitle: "x", dataDir: data.path, arch: "arm64")
        let fake = FakeFS([BinaryPaths.mkxpzBinary(data.path)])
        guard case .success(let plan) = LaunchPlanner.plan(
            engine: "mkxpz", context: ctx, fileExists: fake.exists) else {
            Issue.record("应该成功"); return
        }
        #expect(plan.args.isEmpty)
        #expect(plan.cwd == nil, "传 cwd 会误导「配置在哪」的判断")
    }

    /// 二进制不存在 → 明确的失败原因（不静默）。
    @Test("二进制不存在时给出明确原因")
    func missingBinary() throws {
        let data = try makeTempDataDir()
        defer { try? FileManager.default.removeItem(at: data) }
        let ctx = LaunchContext(
            folder: "/games/x", gamePath: "/games/x/Game.exe",
            gameArgs: ["version": .string("v0.1")],
            gameTitle: "x", dataDir: data.path, arch: "arm64")
        let fake = FakeFS([])
        guard case .failure(let failure) = LaunchPlanner.plan(
            engine: "nwjs", context: ctx, fileExists: fake.exists) else {
            Issue.record("应该失败"); return
        }
        guard case .engineBinaryMissing(let path) = failure else {
            Issue.record("失败类型不对"); return
        }
        #expect(path.contains("modules/nwjs"))
        #expect(failure.message.contains("引擎"))
    }

    /// 完全不认识的引擎 → 明确报「未实现」，而不是猜一个路径。
    ///
    /// ⚠️ 这条测试在 P3 之后换了对象：9 个引擎现在**全部有路径实现**
    /// （godot 也在 P3 补上了），所以要用一个**真的不存在**的引擎名来验。
    @Test("未知引擎明确报错")
    func unsupportedEngine() throws {
        let data = try makeTempDataDir()
        defer { try? FileManager.default.removeItem(at: data) }
        let ctx = LaunchContext(
            folder: "/games/x", gamePath: "/games/x/Game.exe",
            gameArgs: [:], gameTitle: "x", dataDir: data.path, arch: "arm64")
        guard case .failure(let failure) = LaunchPlanner.plan(
            engine: "no-such-engine", context: ctx, fileExists: { _ in true }) else {
            Issue.record("应该失败"); return
        }
        #expect(failure == .unsupportedEngine(engine: "no-such-engine"))
    }

    /// Tyrano 复用 NW.js 二进制（零新运行时，D87）。
    @Test("Tyrano 复用 NW.js 二进制")
    func tyranoUsesNwjs() throws {
        let data = try makeTempDataDir()
        defer { try? FileManager.default.removeItem(at: data) }

        let ctx = LaunchContext(
            folder: "/games/x", gamePath: "/games/x/Game.exe",
            gameArgs: ["version": .string("v0.1")],
            gameTitle: "x", dataDir: data.path, arch: "arm64")
        let fake = FakeFS([BinaryPaths.nwjsBinary(data.path, version: "v0.1", arch: "arm64")])
        guard case .success(let plan) = LaunchPlanner.plan(
            engine: "tyrano", context: ctx, fileExists: fake.exists) else {
            Issue.record("应该成功"); return
        }
        #expect(plan.binary.contains("nwjs.app"))
        #expect(plan.engine == "tyrano")
    }

    /// 建一个临时「数据目录」（含 modules 结构）。
    ///
    /// 为什么不用 FakeFS：mkxpzPlan 现在会**真的写** mkxp.json 到 app 包内
    /// （D72 要求），所以需要一个真实的目录。写进临时目录后删掉，不污染环境。
    func makeTempDataDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-data-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
}

// MARK: - 启动预检

@Suite("启动预检")
struct LauncherPrecheckTests {

    let plan = LaunchPlan(
        binary: "/nonexistent/binary", args: [], cwd: "/games/x", engine: "nwjs")

    /// ⚠️ **先查 cwd 再查 binary**。
    /// 守的是：反过来会把「游戏目录被删」误报成「引擎没装」，
    /// 用户会去重装引擎，而真正的问题是他拖走了游戏文件夹。
    @Test("cwd 不存在时报「游戏目录不存在」而不是「引擎没装」")
    func cwdCheckedFirst() {
        let outcome = Launcher.launch(plan)
        guard case .gameFolderMissing(let folder) = outcome.failure else {
            // 这里 binary 也不存在，但 cwd 先查 → 应该报 cwd
            Issue.record("应该优先报游戏目录不存在")
            return
        }
        #expect(folder == "/games/x")
    }

    @Test("binary 不存在报「引擎运行时不存在」")
    func binaryMissing() {
        let p = LaunchPlan(binary: "/nonexistent/b", args: [], cwd: nil, engine: "x")
        let outcome = Launcher.launch(p)
        guard case .engineBinaryMissing(let b) = outcome.failure else {
            Issue.record("应该报引擎缺失"); return
        }
        #expect(b == "/nonexistent/b")
    }

    /// 存在但不可执行 → 单独一类原因（与「不存在」不同）。
    @Test("不可执行报专属原因")
    func notExecutable() throws {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-nonexec-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: tmp) }
        try Data().write(to: tmp)
        // 去掉执行权限
        try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: tmp.path)

        let p = LaunchPlan(binary: tmp.path, args: [], cwd: nil, engine: "x")
        let outcome = Launcher.launch(p)
        guard case .notExecutable = outcome.failure else {
            Issue.record("应该报不可执行"); return
        }
    }

    /// ⚠️ **真的 spawn，并验证进程活着**（D55 的核心）。
    /// 用一个真实的、无害的命令（`/bin/sleep`）而不是游戏。
    @Test("真的能 spawn 并存活")
    func realSpawn() {
        let p = LaunchPlan(binary: "/bin/sleep", args: ["2"], cwd: nil, engine: "test")
        let outcome = Launcher.launch(p)
        #expect(outcome.ok)
        guard let pid = outcome.pid else {
            Issue.record("没拿到 pid"); return
        }
        // 立刻检查它活着
        #expect(kill(pid, 0) == 0)
        // 清理
        kill(pid, SIGTERM)
    }
}

// MARK: - 版本比较

@Suite("版本比较")
struct VersionCompareTests {

    @Test("基本比较")
    func basic() {
        #expect(compareVersions("1.2.3", "1.2.4") < 0)
        #expect(compareVersions("1.3.0", "1.2.9") > 0)
        #expect(compareVersions("1.2.3", "1.2.3") == 0)
        #expect(compareVersions("v1.2.3", "1.2.4") < 0)
        #expect(compareVersions("2.0", "1.9.9") > 0)
    }

    @Test("段数不同")
    func differentSegments() {
        #expect(compareVersions("1.2", "1.2.0") == 0)
        #expect(compareVersions("1.2.1", "1.2") > 0)
    }
}
