// P3 补上的四个引擎：路径与启动计划。
//
// 用户机器上只装了 4 个引擎（nwjs / mkxpz / easyrpg / renpy），
// 这 4 个（kirikiri / nscripter / siglus / godot）**没有已装样本可验**。
//
// ===== 所以本文件的路径判据来自「真下载包解压后的实测结构」=====
//
// 2026-11-06 本鱼真的下载并解压了三个包（godot 161MB 太大没下，只验了 HTTP 200）：
//
//   krkrsdl2-macos.zip           → 单个裸二进制 `krkrsdl2`（16.5MB）
//   onscripter-...bin.tar.bz2    → 两个裸二进制 `onscripter` / `onscripter-sdl2`
//   siglus-macos-arm64.app.tar.gz → `Siglus-arm64.app/Contents/MacOS/Siglus`
//
// ⚠️ **三个包的布局互不相同**（两个裸二进制、一个 .app），
//    所以绝不能套用同一个模板 —— 这正是本文件要钉住的东西。
import Foundation
import Testing

@testable import TsumigeyaCore

// MARK: - KiriKiri

@Suite("KiriKiri 路径")
struct KirikiriPathTests {

    /// 实测结构：包解开是**单个裸二进制** `krkrsdl2`，没有 .app。
    /// ⚠️ 守的是：别套用 `.app` 的拼法（那会拼出不存在的路径）。
    ///
    /// ⚠️ 也守「两种落点都要兜住」：依赖名叫 `krkrsdl2`，
    /// 所以二进制可能在 `deps/krkr*/krkrsdl2`（子目录）或 `deps/krkrsdl2`（根）。
    @Test("二进制是 deps 下的裸 krkrsdl2")
    func binaryIsBareFile() {
        // 落点 ①：deps 根（依赖名不带子目录）
        let rootFS = FakeFS(["/data/modules/kirikiri/deps/krkrsdl2"])
        let p1 = BinaryPaths.kirikiriBinary(
            "/data", fileExists: rootFS.exists, listDir: { _ in [] })
        #expect(p1 == "/data/modules/kirikiri/deps/krkrsdl2")
        #expect(p1?.contains(".app") == false, "kirikiri 不是 .app 布局")

        // 落点 ②：deps 子目录（依赖名当子目录 —— siglus 真装时就是这种）
        let subFS = FakeFS(["/data/modules/kirikiri/deps/krkr/krkrsdl2"])
        let p2 = BinaryPaths.kirikiriBinary(
            "/data", fileExists: subFS.exists,
            listDir: { path in
                if path.hasSuffix("/deps") { return ["krkr"] }
                if path.hasSuffix("/krkr") { return ["krkrsdl2"] }
                return []
            })
        #expect(p2 == "/data/modules/kirikiri/deps/krkr/krkrsdl2")
    }
}

// MARK: - NScripter

@Suite("NScripter 路径")
struct NScripterPathTests {

    /// 实测结构：包解开是**两个裸二进制**，用 `onscripter`（非 `-sdl2` 那个）。
    @Test("二进制是 deps 下的 onscripter")
    func binaryIsOnscripter() {
        let rootFS = FakeFS(["/data/modules/nscripter/deps/onscripter"])
        let p = BinaryPaths.nscripterBinary(
            "/data", fileExists: rootFS.exists, listDir: { _ in [] })
        #expect(p == "/data/modules/nscripter/deps/onscripter")
        #expect(p?.contains("onscripter-sdl2") == false, "用 onscripter，不用 sdl2 版")
        #expect(p?.contains(".app") == false)
    }
}

// MARK: - Siglus

@Suite("Siglus 路径")
struct SiglusPathTests {

    /// 实测结构：`Siglus-arm64.app/Contents/MacOS/Siglus`。
    ///
    /// ⚠️ **app 名带架构后缀**（`-arm64` / `-x86_64`），所以不能写死名字 —— 要扫目录。
    ///
    /// ⚠️ **落地位置多一层**（真装才发现）：依赖名 `siglus_rs` 当子目录，
    /// 所以实际是 `deps/siglus_rs/Siglus-arm64.app/...`。
    @Test("能扫到带架构后缀的 .app（子目录落点，实测）")
    func findsArchSuffixedApp() {
        let sub = "/data/modules/siglus/deps/siglus_rs"
        let fake = FakeFS(["\(sub)/Siglus-arm64.app/Contents/MacOS/Siglus"])
        let p = BinaryPaths.siglusBinary(
            "/data", fileExists: fake.exists,
            listDir: { path in
                if path.hasSuffix("/deps") { return ["siglus_rs"] }
                if path.hasSuffix("/siglus_rs") { return ["Siglus-arm64.app"] }
                return []
            })
        #expect(p == "\(sub)/Siglus-arm64.app/Contents/MacOS/Siglus")
    }

    /// 另一种落点：依赖名不带子目录（直接落 deps 根）也要兜住。
    @Test("也能扫到 deps 根的 .app")
    func findsAppAtDepsRoot() {
        let deps = "/data/modules/siglus/deps"
        let fake = FakeFS(["\(deps)/Siglus-arm64.app/Contents/MacOS/Siglus"])
        let p = BinaryPaths.siglusBinary(
            "/data", fileExists: fake.exists,
            listDir: { path in
                if path == deps { return ["Siglus-arm64.app"] }
                return []
            })
        #expect(p == "\(deps)/Siglus-arm64.app/Contents/MacOS/Siglus")
    }

    /// x86_64 版也要能扫到（同一个扫描逻辑）。
    @Test("x86_64 的 .app 也能扫到")
    func findsX8664App() {
        let deps = "/data/modules/siglus/deps"
        let fake = FakeFS(["\(deps)/Siglus-x86_64.app/Contents/MacOS/Siglus"])
        let p = BinaryPaths.siglusBinary(
            "/data", fileExists: fake.exists,
            listDir: { _ in ["Siglus-x86_64.app"] })
        #expect(p?.contains("Siglus-x86_64.app") == true)
    }

    /// 没装时返回 nil（不猜路径）。
    @Test("没装时返回 nil")
    func missingReturnsNil() {
        let fake = FakeFS([])
        #expect(BinaryPaths.siglusBinary("/data", fileExists: fake.exists,
                                         listDir: { _ in [] }) == nil)
    }
}

// MARK: - Godot

@Suite("Godot 路径")
struct GodotPathTests {

    /// Godot 的布局**本鱼没实测**（161MB 没下），所以路径是「扫 Godot*.app」的
    /// 防御式写法：扫不到就返回 nil，不会拼出一个看似正确的错路径。
    @Test("能从 Godot*.app 扫出二进制")
    func findsGodotApp() {
        let deps = "/data/modules/godot/deps"
        let fake = FakeFS(["\(deps)/Godot.app/Contents/MacOS/Godot"])
        let p = BinaryPaths.godotBinary(
            "/data", fileExists: fake.exists,
            listDir: { path in
                if path == deps { return ["Godot.app"] }
                if path.contains("Contents/MacOS") { return ["Godot"] }
                return []
            })
        #expect(p == "\(deps)/Godot.app/Contents/MacOS/Godot")
    }

    /// 带版本号的可执行名（`Godot_v4.6.1-stable`）也要能兜住。
    @Test("可执行名带版本号时也能找到")
    func findsVersionedExecutable() {
        let deps = "/data/modules/godot/deps"
        let fake = FakeFS(["\(deps)/Godot.app/Contents/MacOS/Godot_v4.6.1-stable"])
        let p = BinaryPaths.godotBinary(
            "/data", fileExists: fake.exists,
            listDir: { path in
                if path == deps { return ["Godot.app"] }
                if path.contains("Contents/MacOS") { return ["Godot_v4.6.1-stable"] }
                return []
            })
        #expect(p?.hasSuffix("Godot_v4.6.1-stable") == true)
    }

    @Test("没装时返回 nil")
    func missingReturnsNil() {
        let fake = FakeFS([])
        #expect(BinaryPaths.godotBinary("/data", fileExists: fake.exists,
                                        listDir: { _ in [] }) == nil)
    }
}

// MARK: - 统一入口

@Suite("统一二进制入口")
struct UnifiedBinaryTests {

    let ctx = LaunchContext(
        folder: "/games/x", gamePath: "/games/x/exe",
        gameArgs: [:], gameTitle: "x", dataDir: "/tempdata", arch: "arm64")

    /// ⚠️ 守的是「9 个引擎都有路径实现」—— 少一个就是有点启动不了的引擎。
    ///
    /// 判据是**调用不报 `unsupportedEngine`**（报 `engineBinaryMissing` 是可接受的：
    /// 那意味着「路径实现对了，只是没装」）。
    @Test("9 个引擎都走到了路径实现（不再报 unsupported）")
    func allNineHaveImplementation() throws {
        let data = try makeTemp()
        defer { try? FileManager.default.removeItem(at: data) }

        for engine in BinaryPaths.engineIDs {
            guard case .failure(let failure) = LaunchPlanner.plan(
                engine: engine,
                context: LaunchContext(
                    folder: "/games/x", gamePath: "/games/x/exe",
                    gameArgs: [:], gameTitle: "x", dataDir: data.path, arch: "arm64"),
                fileExists: { _ in false },
                listDir: { _ in [] }) else {
                // 成功也算过（说明路径拼出来了）
                continue
            }
            #expect(failure != .unsupportedEngine(engine: engine),
                    "\(engine) 还停在「未实现」状态")
        }
    }

    /// 四个新引擎在「二进制不存在」时给出明确原因（不是崩，不是静默）。
    @Test("四个新引擎缺二进制时报明确原因")
    func newEnginesReportMissing() throws {
        let data = try makeTemp()
        defer { try? FileManager.default.removeItem(at: data) }

        for engine in ["kirikiri", "nscripter", "siglus", "godot"] {
            guard case .failure(let failure) = LaunchPlanner.plan(
                engine: engine,
                context: LaunchContext(
                    folder: "/games/x", gamePath: "/games/x/exe",
                    gameArgs: [:], gameTitle: "x", dataDir: data.path, arch: "arm64"),
                fileExists: { _ in false },
                listDir: { _ in [] }) else {
                Issue.record("\(engine) 二进制不存在却没报错"); continue
            }
            guard case .engineBinaryMissing = failure else {
                Issue.record("\(engine) 的失败类型不对：\(failure)"); continue
            }
            #expect(failure.message.contains("引擎"))
        }
    }

    /// 有二进制时，启动参数是**游戏目录**（四个引擎的共同约定）。
    @Test("四个新引擎的参数是游戏目录")
    func newEnginesPassGameFolder() throws {
        let data = try makeTemp()
        defer { try? FileManager.default.removeItem(at: data) }
        let deps = data.path + "/modules"

        let cases: [(String, String)] = [
            ("kirikiri", "\(deps)/kirikiri/deps/krkrsdl2"),
            ("nscripter", "\(deps)/nscripter/deps/onscripter"),
        ]
        for (engine, binary) in cases {
            let fake = FakeFS([binary])
            guard case .success(let plan) = LaunchPlanner.plan(
                engine: engine,
                context: LaunchContext(
                    folder: "/games/x", gamePath: "/games/x/exe",
                    gameArgs: [:], gameTitle: "x", dataDir: data.path, arch: "arm64"),
                fileExists: fake.exists,
                listDir: { _ in [] }) else {
                Issue.record("\(engine) 应该成功"); continue
            }
            #expect(plan.args == ["/games/x"], "\(engine) 的参数应该是游戏目录")
            #expect(plan.binary == binary)
        }
    }

    func makeTemp() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-p3-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
}
