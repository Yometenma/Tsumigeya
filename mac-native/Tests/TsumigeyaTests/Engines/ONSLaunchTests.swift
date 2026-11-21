// ONS（NScripter）的启动方案：目录参数、脚本编码、字体、全屏。
//
// 这些断言钉的是「换 ONSyuri 之后仍然能跑」的判据：
//   · 目录必须走 `-r`（ONScripter 没有位置参数，裸目录会被忽略）
//   · 编码必须显式给 `--enc`（ONSyuri 自己的默认是 gbk，日文原版会乱码）
//   · 游戏没自带字体时要用系统 CJK 字体补 `-f`（否则一个字都画不出来）
import Foundation
import Testing

@testable import TsumigeyaCore

@Suite("ONS 启动方案")
struct ONSLaunchTests {

    static let binary = "/data/modules/nscripter/deps/onsyuri/onsyuri"
    /// macOS 上实测可用：`PingFang.ttc` 会让 SDL_ttf 报 `can't open font file`。
    static let systemFont = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
    static let folder = "/games/x"

    /// 组装一次启动计划。`extraFiles` 只放游戏目录里的文件（字体、脚本等）。
    private func makePlan(
        folder: String = ONSLaunchTests.folder,
        gameArgs: [String: JSONValue] = [:],
        extraFiles: [String] = [],
        scripts: [String: Data] = [:],
        performPreparation: Bool = false
    ) -> Result<LaunchPlan, LaunchFailure> {
        let fs = FakeFS(extraFiles + [Self.binary])
        return LaunchPlanner.plan(
            engine: "nscripter",
            context: LaunchContext(
                folder: folder, gamePath: folder + "/nscr.exe",
                gameArgs: gameArgs, gameTitle: "x", dataDir: "/data", arch: "arm64"),
            fileExists: fs.exists,
            listDir: { path in
                if path.hasSuffix("/deps") { return ["onsyuri"] }
                if path.hasSuffix("/deps/onsyuri") { return ["onsyuri", "lib"] }
                return []
            },
            readFile: { scripts[$0] },
            performPreparation: performPreparation
        )
    }

    @Test("目录走 -r，没有明文脚本时按日文原版（sjis）并回落到系统字体")
    func defaultsToSjisAndSystemFont() throws {
        let plan = try makePlan(extraFiles: [Self.systemFont]).get()
        #expect(plan.args == ["-r", Self.folder, "--enc:sjis", "-f", Self.systemFont])
        #expect(plan.cwd == Self.folder, "cwd 仍是游戏目录（default.ttf 按 cwd 找）")
        #expect(plan.engine == "nscripter")
        #expect(plan.binary == Self.binary)
    }

    @Test("明文脚本是 UTF-8 时传 --enc:utf8")
    func detectsUTF8() throws {
        let script = "*define\ngame\n*start\n测试文本\nend\n".data(using: .utf8)!
        let plan = try makePlan(
            extraFiles: [Self.systemFont],
            scripts: [Self.folder + "/0.txt": script]).get()
        #expect(plan.args.contains("--enc:utf8"))
    }

    /// GBK 的「测试中」字节串（UTF-8 解码必失败，且首字节落在 GBK 独有区 0xB0–0xDF）。
    @Test("明文脚本是 GBK 时传 --enc:gbk")
    func detectsGBK() throws {
        let script = Data([0xD6, 0xD0, 0xCE, 0xC4, 0xB2, 0xE2, 0xCA, 0xD4])
        let plan = try makePlan(
            extraFiles: [Self.systemFont],
            scripts: [Self.folder + "/0.txt": script]).get()
        #expect(plan.args.contains("--enc:gbk"))
    }

    @Test("用户显式选了编码就不探测")
    func explicitEncodingWins() throws {
        let script = "*define\ngame\n*start\n测试文本\nend\n".data(using: .utf8)!
        let plan = try makePlan(
            gameArgs: ["encoding": .string("gbk")],
            extraFiles: [Self.systemFont],
            scripts: [Self.folder + "/0.txt": script]).get()
        #expect(plan.args.contains("--enc:gbk"), "用户的选择压过探测结果")
        #expect(!plan.args.contains("--enc:utf8"))
    }

    @Test("游戏自带 default.ttf 时不传 -f")
    func bundledFontSkipsFontArgument() throws {
        let plan = try makePlan(
            extraFiles: [Self.folder + "/default.ttf"]).get()
        #expect(!plan.args.contains("-f"))
    }

    @Test("全屏开关落到 --fullscreen")
    func fullscreenFlag() throws {
        let plan = try makePlan(
            gameArgs: ["fullscreen": .bool(true)],
            extraFiles: [Self.systemFont]).get()
        #expect(plan.args.contains("--fullscreen"))
    }

    /// DLsite 作品解压出来常是日文目录名（实测 `ココロのクサリ２体験版`）。
    /// ONS 用 `fopen` 拼路径，非 ASCII 会读不到脚本，所以要换成 /tmp 的 ASCII 别名。
    @Test("日文目录名走 ASCII 别名（-r 与 cwd 都用别名）")
    func japaneseFolderUsesAsciiAlias() throws {
        let folder = "/games/ココロのクサリ２体験版"
        let alias = AsciiAlias.aliasPath(for: folder)
        defer { AsciiAlias.removeAlias(for: folder) }

        let plan = try makePlan(folder: folder, performPreparation: true).get()
        #expect(plan.args.first == "-r")
        #expect(plan.args.count > 1 && plan.args[1] == alias)
        #expect(plan.cwd == alias)
        #expect(alias.unicodeScalars.allSatisfy { $0.isASCII }, "别名本身必须是纯 ASCII")
    }

    @Test("诊断模式（performPreparation=false）不建链接")
    func diagnosticModeLeavesNoAlias() throws {
        let folder = "/games/テスト診断用一意識別子"
        let alias = AsciiAlias.aliasPath(for: folder)
        AsciiAlias.removeAlias(for: folder)
        defer { AsciiAlias.removeAlias(for: folder) }

        let plan = try makePlan(folder: folder, performPreparation: false).get()
        #expect(plan.args.count > 1 && plan.args[1] == folder, "诊断走真实路径")
        #expect(!FileManager.default.fileExists(atPath: alias), "诊断不能留链接")
    }

    @Test("已 ASCII 的目录不受影响")
    func asciiFolderStaysAsIs() throws {
        let plan = try makePlan(extraFiles: [Self.systemFont], performPreparation: true).get()
        #expect(plan.args[1] == Self.folder)
        #expect(plan.cwd == Self.folder)
    }

    @Test("二进制不存在时报引擎问题（不是崩溃）")
    func missingBinary() {
        let result = LaunchPlanner.plan(
            engine: "nscripter",
            context: LaunchContext(
                folder: Self.folder, gamePath: Self.folder + "/nscr.exe",
                gameArgs: [:], gameTitle: "x", dataDir: "/data", arch: "arm64"),
            fileExists: { _ in false },
            listDir: { _ in [] },
            readFile: { _ in nil })
        guard case .failure(let failure) = result else {
            Issue.record("二进制不存在却没报错"); return
        }
        guard case .engineBinaryMissing = failure else {
            Issue.record("失败类型不对：\(failure)"); return
        }
    }
}

// MARK: - 识别

@Suite("ONS 识别")
struct ONSDetectionTests {

    /// 汉化/移植版几乎都用明文 `0.txt` 当脚本入口，只有 `nscript.dat` 会漏判。
    @Test("只有明文 0.txt 的移植版也认成 NScripter")
    func detectsPlainScript() {
        let dir = "/games/ons"
        let fake = fakeFS(dir, ["0.txt", "arc.nsa"])
        let result = EngineRegistry.detect(exe: "\(dir)/nscr.exe", fileExists: fake.exists)
        #expect(result?.folder == "nscripter")
    }

    @Test("00.txt 也认")
    func detectsDoubleZeroScript() {
        let dir = "/games/ons2"
        let fake = fakeFS(dir, ["00.txt"])
        let result = EngineRegistry.detect(exe: "\(dir)/nscr.exe", fileExists: fake.exists)
        #expect(result?.folder == "nscripter")
    }
}
