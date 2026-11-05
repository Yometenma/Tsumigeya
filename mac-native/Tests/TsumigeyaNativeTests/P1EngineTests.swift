// P1 引擎识别测试。
//
// 对应 Electron 版：test/engines-detect.test.ts（38 条）/ test/detect-priority.test.ts（12 条）
//
// 移植原则：**不是抄代码，是按判据重新实现一遍**。
// 每条测试都写清「它在守什么」——以后改实现时知道哪条不能动。
import Foundation
import Testing

@testable import TsumigeyaNative

// MARK: - 测试辅助：假文件系统

/// 假文件系统：给定一组存在路径，`exists` 只对它们返回 true。
///
/// 为什么用假的而不是真建文件：识别算法是**纯逻辑**（除了 fileExists 这一个注入点），
/// 用真的会慢、会有清理问题、且测试之间互相污染。
struct FakeFS {
    let existing: Set<String>

    init(_ paths: [String]) {
        self.existing = Set(paths.map { ($0 as NSString).standardizingPath })
    }

    func exists(_ path: String) -> Bool {
        existing.contains((path as NSString).standardizingPath)
    }
}

/// 组装「游戏目录 + 一组相对文件」的假文件系统。
func fakeFS(_ dir: String, _ files: [String]) -> FakeFS {
    FakeFS(files.map { (dir as NSString).appendingPathComponent($0) })
}

// MARK: - 路径工具（R1）

@Suite("路径工具 R1")
struct DetectPathTests {

    /// 归一化扩展名：剥任意多个前导点、小写。
    @Test("扩展名归一化")
    func normalizeExt() {
        #expect(DetectPath.normalizeExt(".py") == "py")
        #expect(DetectPath.normalizeExt("py") == "py")
        #expect(DetectPath.normalizeExt("..py") == "py")
        #expect(DetectPath.normalizeExt("PY") == "py")
        #expect(DetectPath.normalizeExt("") == "")
        #expect(DetectPath.normalizeExt(nil) == "")
        // 中间的点不剥：取最后一段
        #expect(DetectPath.pathExtLower("/x/a.tar.gz") == "gz")
    }

    /// ⚠️ R1 第 ② 条：尾斜杠必须剥，否则 .app 判定失败。
    /// 守的是：mac 上从 Finder 拖进来的路径**经常带尾斜杠**。
    @Test("尾斜杠不影响 .app 判定")
    func trailingSlash() {
        #expect(DetectPath.isAppBundle("/x/Game.app"))
        #expect(DetectPath.isAppBundle("/x/Game.app/"))
        #expect(DetectPath.isAppBundle("/x/Game.app//"))
        #expect(DetectPath.isAppBundle("/x/Game.APP/"))    // 大小写不敏感
        #expect(!DetectPath.isAppBundle("/x/Game.exe"))
        #expect(!DetectPath.isAppBundle("/x/Game.app/renpy"))
        #expect(!DetectPath.isAppBundle(nil))
    }

    /// ⚠️ R1 第 ① 条：`.app` 的探测点是它自己，不是父目录。
    /// 守的是：漏掉这条，mac 的 Ren'Py / NW.js 包内文件探测会全落在父目录 → 一个都探不到。
    @Test(".app 探测点是它自己，普通文件是父目录")
    func gameDirForFiles() {
        #expect(DetectPath.gameDirForFiles("/x/Game.app") == "/x/Game.app")
        #expect(DetectPath.gameDirForFiles("/x/Game.app/") == "/x/Game.app")
        #expect(DetectPath.gameDirForFiles("/x/Game.exe") == "/x")
        #expect(DetectPath.gameDirForFiles("/a/b/c/Game.exe") == "/a/b/c")
    }
}

// MARK: - 打分算法

@Suite("打分算法")
struct PickBestRuleTests {

    /// 强命中（all_required）压过打分命中。
    /// ⚠️ 这是整个识别的核心规则：
    /// 「easyrpg 的 RPG_RT.ini 只命中 1/3，但 mkxpz 的四个文件全在场」时必须选 mkxpz。
    @Test("强命中压过打分命中")
    func strongBeatsScored() {
        let dir = "/games/test"
        // 只有 RPG_RT.ini（easyrpg 打分 1/3）+ mkxpz 的四个文件全在
        let fake = FakeFS([
            "\(dir)/RPG_RT.ini",
            "\(dir)/Game.ini", "\(dir)/System", "\(dir)/Graphics", "\(dir)/Audio",
        ])
        let rules: [(key: String, rule: DetectRule?)] = [
            ("easyrpg", DetectRule(files: ["RPG_RT.ldb", "RPG_RT.lmt", "RPG_RT.ini"], allRequired: false)),
            ("mkxpz", DetectRule(files: ["Game.ini", "System", "Graphics", "Audio"], allRequired: true)),
        ]
        let winner = EngineDetector.pickBestRule(
            exe: "\(dir)/Game.exe", rules: rules, fileExists: fake.exists)
        #expect(winner == "mkxpz")
    }

    /// 多个强命中：文件命中数多的赢。
    @Test("强命中之间比文件数")
    func moreFilesWins() {
        let dir = "/games/x"
        let fake = FakeFS(["\(dir)/a", "\(dir)/b", "\(dir)/c"])
        let rules: [(key: String, rule: DetectRule?)] = [
            ("few", DetectRule(files: ["a"], allRequired: true)),
            ("many", DetectRule(files: ["a", "b", "c"], allRequired: true)),
        ]
        #expect(EngineDetector.pickBestRule(exe: "\(dir)/g.exe", rules: rules, fileExists: fake.exists)
                == "many")
    }

    /// 同分同文件数 → 保持**注册顺序**（先出现的赢）。
    /// 守的是：引擎页顺序 = 优先级顺序，不能随实现细节漂。
    @Test("完全同分时保持注册顺序")
    func stableOrder() {
        let dir = "/games/x"
        let fake = FakeFS(["\(dir)/a"])
        let rules: [(key: String, rule: DetectRule?)] = [
            ("first", DetectRule(files: ["a"], allRequired: true)),
            ("second", DetectRule(files: ["a"], allRequired: true)),
        ]
        #expect(EngineDetector.pickBestRule(exe: "\(dir)/g.exe", rules: rules, fileExists: fake.exists)
                == "first")
    }

    /// 体量大的强命中优先于小强命中（哪怕顺序在后）。
    @Test("强命中文件数优先于顺序")
    func fileCountBeforeOrder() {
        let dir = "/games/x"
        let fake = FakeFS(["\(dir)/a", "\(dir)/b"])
        let rules: [(key: String, rule: DetectRule?)] = [
            ("small", DetectRule(files: ["a"], allRequired: true)),
            ("big", DetectRule(files: ["a", "b"], allRequired: true)),
        ]
        #expect(EngineDetector.pickBestRule(exe: "\(dir)/g.exe", rules: rules, fileExists: fake.exists)
                == "big")
    }

    /// 扩展名规则（无文件规则）也能强命中。
    @Test("纯扩展名强命中")
    func extensionOnly() {
        let fake = FakeFS([])
        let rules: [(key: String, rule: DetectRule?)] = [
            ("godot", DetectRule(extensions: ["pck"], allRequired: true)),
        ]
        #expect(EngineDetector.pickBestRule(
            exe: "/games/x/game.pck", rules: rules, fileExists: fake.exists) == "godot")
        #expect(EngineDetector.pickBestRule(
            exe: "/games/x/game.exe", rules: rules, fileExists: fake.exists) == nil)
    }

    /// 空路径返回 nil（不猜）。
    @Test("空路径返回 nil")
    func emptyPath() {
        #expect(EngineDetector.pickBestRule(exe: "", rules: [], fileExists: { _ in true }) == nil)
    }

    /// 打分：文件命中比例 + 扩展名。
    @Test("打分按比例算")
    func scoringRatio() {
        let dir = "/games/x"
        let fake = FakeFS(["\(dir)/a"])
        let rules: [(key: String, rule: DetectRule?)] = [
            ("three", DetectRule(files: ["a", "b", "c"], allRequired: false)),   // 1/3 ≈ 0.33
            ("two", DetectRule(files: ["a", "b"], allRequired: false)),          // 1/2 = 0.5
        ]
        #expect(EngineDetector.pickBestRule(exe: "\(dir)/g.exe", rules: rules, fileExists: fake.exists)
                == "two")
    }
}

// MARK: - 真实引擎识别

@Suite("真实引擎识别")
struct EngineDetectionTests {

    /// D88：**只识别引擎绝不能抢走可启动引擎的游戏**。
    ///
    /// ⚠️ 守的是实测抓到过的真 bug：给 Unity 规则加 `extensions: ['exe']` 后，
    /// 一个只有 readme 的空目录都被判成 Unity —— 于是「不认识的 exe 游戏」
    /// 被报成「需要 Windows 兼容层」，而它也许是某个我们认识的引擎。
    /// 判据必须**只靠专有文件名**。
    @Test("只有 .exe 不判成 Unity")
    func exeAloneIsNotUnity() {
        let dir = "/games/unknown"
        let fake = fakeFS(dir, ["readme.txt", "Game.exe"])
        let result = EngineRegistry.detect(exe: "\(dir)/Game.exe", fileExists: fake.exists)
        // 不能是 unity（也不能是任何只识别引擎）
        #expect(result?.folder != "unity")
        #expect(result?.launchable ?? true)
    }

    /// Unity 有专有文件时才认得出（且标为不可启动）。
    @Test("有 UnityPlayer.dll 才判成 Unity（不可启动）")
    func unityDetected() {
        let dir = "/games/unity"
        let fake = fakeFS(dir, ["UnityPlayer.dll", "Game.exe"])
        let result = EngineRegistry.detect(exe: "\(dir)/Game.exe", fileExists: fake.exists)
        #expect(result?.folder == "unity")
        #expect(result?.launchable == false)
        #expect(result?.detectOnlyReasonKey == "detectOnly.unity")
    }

    /// NW.js 强命中（nw.dll + package.json 都在）。
    @Test("NW.js 强命中")
    func nwjsDetected() {
        let dir = "/games/mv"
        let fake = fakeFS(dir, ["nw.dll", "package.json", "Game.exe"])
        let result = EngineRegistry.detect(exe: "\(dir)/Game.exe", fileExists: fake.exists)
        #expect(result?.folder == "nwjs")
        #expect(result?.launchable == true)
    }

    /// mkxpz 强命中（Game.ini + System + Graphics + Audio）。
    @Test("mkxp-z 强命中")
    func mkxpzDetected() {
        let dir = "/games/ace"
        let fake = fakeFS(dir, ["Game.ini", "System", "Graphics", "Audio", "Game.exe"])
        let result = EngineRegistry.detect(exe: "\(dir)/Game.exe", fileExists: fake.exists)
        #expect(result?.folder == "mkxpz")
    }

    /// 吉里吉里只认 data.xp3。
    @Test("吉里吉里认 data.xp3")
    func kirikiriDetected() {
        let dir = "/games/kk"
        let fake = fakeFS(dir, ["data.xp3"])
        let result = EngineRegistry.detect(exe: "\(dir)/game.exe", fileExists: fake.exists)
        #expect(result?.folder == "kirikiri")
    }

    /// 吉里吉里不认散的 .tjs（会误伤）。
    @Test("散的 .tjs 不判成吉里吉里")
    func scatteredTjsNotKirikiri() {
        let dir = "/games/tjs"
        let fake = fakeFS(dir, ["startup.tjs", "main.tjs"])
        let result = EngineRegistry.detect(exe: "\(dir)/game.exe", fileExists: fake.exists)
        #expect(result?.folder != "kirikiri")
    }

    /// Tyrano 两目录判据。
    @Test("Tyrano 认 tyrano + data 两目录")
    func tyranoDetected() {
        let dir = "/games/tyrano"
        let fake = fakeFS(dir, ["tyrano", "data", "index.html"])
        let result = EngineRegistry.detect(exe: "\(dir)/game.exe", fileExists: fake.exists)
        #expect(result?.folder == "tyrano")
    }

    /// 只有 index.html 不判 Tyrano（网页项目都有它，会误伤）。
    @Test("只有 index.html 不判 Tyrano")
    func indexHtmlAloneNotTyrano() {
        let dir = "/games/web"
        let fake = fakeFS(dir, ["index.html"])
        let result = EngineRegistry.detect(exe: "\(dir)/game.exe", fileExists: fake.exists)
        #expect(result?.folder != "tyrano")
    }

    /// ⚠️ **R1 的边界：`.app` 路径能让 `files` 规则生效，但 `extensions` 规则不命中。**
    ///
    /// 这条测试记的是一段**真实行为**（不是本鱼想要的行为）：
    /// RenPy 的规则是 `extensions: ['py','exe','sh'] + files: ['renpy'] + all_required: true`。
    /// 当 exe 是 `/games/Renpy.app` 时：
    ///   · 扩展名是 `app` → **不在** `[py, exe, sh]` 里 → `extMatch = false`
    ///   · `all_required` 要求 `needExt && needFiles` → **整体不成立**
    ///
    /// 也就是说 `.app` 包**必须**走强命中这条路，而它的扩展名挡在前面。
    /// Electron 版有同样的行为（`detect.ts` 只解决了「探测点用哪个目录」，
    /// 没有解决「扩展名规则在 .app 上不命中」）。
    ///
    /// 本鱼在这里**记录事实**而不是编造期望：这条测试守住「行为没变」，
    /// 将来若要去掉这个限制（比如给 `.app` 单独放行扩展名），会先在这里红。
    @Test("Ren'Py 的 .app：扩展名规则不命中（记录真实行为）")
    func renpyAppExtensionMismatch() {
        let fake = FakeFS(["/games/Renpy.app/renpy"])
        let winner = EngineDetector.pickBestRule(
            exe: "/games/Renpy.app",
            rules: [("renpy", EngineRegistry.find(folder: "renpy")!.autodetect)],
            fileExists: fake.exists)
        #expect(winner == nil, "扩展名 app 不匹配 py/exe/sh，强命中不成立")

        // 反向：扩展名对上时（用户选的是包内 .sh），探测点退到 .app 本身 → 能认出来
        let fake2 = FakeFS(["/games/Renpy.app/renpy"])
        let winner2 = EngineDetector.pickBestRule(
            exe: "/games/Renpy.app/renpy.sh",
            rules: [("renpy", EngineRegistry.find(folder: "renpy")!.autodetect)],
            fileExists: fake2.exists)
        #expect(winner2 == "renpy")
    }

    /// ✅ R1 第 ① 条的正向证明：**files 规则**确实以 `.app` 本身为探测点。
    ///
    /// 用一条**只有 files 规则、没有扩展名规则**的假设引擎来验，
    /// 干扰最小，能纯净地测「探测点选对了吗」。
    @Test("files 规则的探测点是 .app 本身（R1 ①）")
    func probePointIsBundleItself() {
        // 只在 .app 包**内部**放文件
        let fake = FakeFS(["/games/Game.app/marker.txt"])
        let rule = DetectRule(files: ["marker.txt"], allRequired: true)

        // 探测点 = .app 本身 → 应该找到 marker.txt
        let inside = EngineDetector.pickBestRule(
            exe: "/games/Game.app", rules: [("probe", rule)], fileExists: fake.exists)
        #expect(inside == "probe")

        // 反向：普通文件的探测点是父目录 /games，那里没有 marker.txt → nil
        let wrong = EngineDetector.pickBestRule(
            exe: "/games/plain.exe", rules: [("probe", rule)], fileExists: fake.exists)
        #expect(wrong == nil, "父目录 /games 里没有 marker.txt，证明探测点确实不同")
    }

    /// 未知引擎 → nil（不猜、不回退，D57）。
    @Test("完全不认识的目录返回 nil")
    func unknownReturnsNil() {
        let dir = "/games/mystery"
        let fake = fakeFS(dir, ["a.bin", "b.dat"])
        #expect(EngineRegistry.detect(exe: "\(dir)/game.exe", fileExists: fake.exists) == nil)
    }
}

// MARK: - 注册表完整性

@Suite("注册表")
struct RegistryTests {

    /// 9 个可启动 + 3 个只识别（D87/D91/D88）。
    @Test("引擎数量：9 可启动 + 3 只识别")
    func counts() {
        #expect(EngineRegistry.launchable.count == 9)
        #expect(EngineRegistry.detectOnly.count == 3)
        #expect(EngineRegistry.all.count == 12)
    }

    /// folder 唯一。
    @Test("folder 不重复")
    func uniqueFolders() {
        let folders = EngineRegistry.all.map(\.folder)
        #expect(Set(folders).count == folders.count)
    }

    /// ⚠️ 只识别引擎**一律 allRequired = false**（走打分）。
    /// 守的是：设成 true 就会强命中去抢走可启动引擎的游戏。
    @Test("只识别引擎一律走打分")
    func detectOnlyNeverStrong() {
        for engine in EngineRegistry.detectOnly {
            #expect(engine.autodetect?.allRequired == false,
                    "\(engine.folder) 的 all_required 必须是 false")
            #expect(engine.launchable == false)
            #expect(engine.detectOnlyReasonKey != nil)
        }
    }

    /// 可启动引擎至少有一条识别规则（否则它永远认不出来 = 摆设）。
    @Test("可启动引擎都有识别规则")
    func launchableHaveRules() {
        for engine in EngineRegistry.launchable {
            let hasRule = engine.autodetect.map {
                !($0.files ?? []).isEmpty || !($0.collectedExtensions).isEmpty
            } ?? false
            #expect(hasRule, "\(engine.folder) 没有任何识别规则")
        }
    }
}
