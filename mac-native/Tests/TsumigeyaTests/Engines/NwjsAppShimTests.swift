// nw.js 应用清单（package.json）的兼容层回归。
//
// 守的是 2026-11-23 的真机故障：FateEmpire of Dirt 的 package.json 里 `"name": ""`，
// nw.js 拒绝加载（"Required value 'name' is missing or invalid."），点开始游戏没反应。
//
// 判据必须是「游戏文件没被改 + 兼容目录真的能当 app 目录用」，不能只看路径拼对了。
import Foundation
import Testing

@testable import TsumigeyaCore

@Suite("NW.js 清单兼容层")
struct NwjsAppShimTests {

    /// 造一个「游戏目录」：package.json + www/index.html。
    private func makeGame(
        name: String?, extraFiles: [String] = ["Game.exe"]
    ) throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-game-\(UUID().uuidString)")
        let www = root.appendingPathComponent("www")
        try FileManager.default.createDirectory(at: www, withIntermediateDirectories: true)
        try Data("<html></html>".utf8).write(to: www.appendingPathComponent("index.html"))

        var manifest: [String: Any] = ["main": "www/index.html"]
        if let name { manifest["name"] = name }
        let data = try JSONSerialization.data(withJSONObject: manifest)
        try data.write(to: root.appendingPathComponent("package.json"))

        for file in extraFiles {
            try Data("x".utf8).write(to: root.appendingPathComponent(file))
        }
        return root
    }

    private func makeDataDir() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-data-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    @Test("name 是空串时需要兼容目录")
    func emptyNameNeedsRepair() throws {
        let game = try makeGame(name: "")
        defer { try? FileManager.default.removeItem(at: game) }
        #expect(NwjsAppShim.requiresRepair(folder: game.path))
    }

    @Test("name 缺失时需要兼容目录")
    func missingNameNeedsRepair() throws {
        let game = try makeGame(name: nil)
        defer { try? FileManager.default.removeItem(at: game) }
        #expect(NwjsAppShim.requiresRepair(folder: game.path))
    }

    @Test("name 合法时不需要兼容目录")
    func validNameNeedsNoRepair() throws {
        let game = try makeGame(name: "rmmz-game")
        defer { try? FileManager.default.removeItem(at: game) }
        #expect(!NwjsAppShim.requiresRepair(folder: game.path))
    }

    /// 下划线开头是 Chrome 扩展的保留前缀，同样要被 nw.js 拒绝。
    @Test("name 以下划线开头也要修")
    func underscoreNameNeedsRepair() throws {
        let game = try makeGame(name: "_hidden")
        defer { try? FileManager.default.removeItem(at: game) }
        #expect(NwjsAppShim.requiresRepair(folder: game.path))
    }

    @Test("兼容目录：补好 name、链接回游戏目录、原文件不动")
    func shimIsUsable() throws {
        let game = try makeGame(name: "")
        let data = try makeDataDir()
        defer {
            try? FileManager.default.removeItem(at: game)
            try? FileManager.default.removeItem(at: data)
        }

        let originalManifest = try Data(contentsOf: game.appendingPathComponent("package.json"))
        let shim = try #require(
            NwjsAppShim.ensure(dataDir: data.path, folder: game.path))
        let fm = FileManager.default

        // 1) 兼容目录里的清单 name 合法，且 main 等其它字段原样保留
        let repaired = try Data(contentsOf: URL(fileURLWithPath: shim)
            .appendingPathComponent("package.json"))
        let object = try #require(
            try JSONSerialization.jsonObject(with: repaired) as? [String: Any])
        #expect(NwjsAppShim.isValidAppName(object["name"]))
        #expect(object["main"] as? String == "www/index.html")

        // 2) 游戏的真实文件通过符号链接可读（app 目录里没有 www 的副本）
        let wwwLink = URL(fileURLWithPath: shim).appendingPathComponent("www")
        #expect(fm.fileExists(atPath: wwwLink.appendingPathComponent("index.html").path))
        #expect(try fm.destinationOfSymbolicLink(atPath: wwwLink.path)
                == game.appendingPathComponent("www").path)

        // 3) 游戏自己的 package.json 一个字节都没变（D53）
        let after = try Data(contentsOf: game.appendingPathComponent("package.json"))
        #expect(after == originalManifest)

        // 4) 幂等：再调一次还是同一个目录，且没把链接搞坏
        let again = try #require(NwjsAppShim.ensure(dataDir: data.path, folder: game.path))
        #expect(again == shim)
        #expect(try fm.destinationOfSymbolicLink(atPath: wwwLink.path)
                == game.appendingPathComponent("www").path)
    }

    /// 兼容目录里的 name 必须稳定：否则每次启动换一个 profile。
    @Test("同一个游戏的 name 稳定")
    func appNameIsStable() throws {
        let game = try makeGame(name: "")
        defer { try? FileManager.default.removeItem(at: game) }
        #expect(NwjsAppShim.appName(for: game.path) == NwjsAppShim.appName(for: game.path))
        #expect(NwjsAppShim.isValidAppName(NwjsAppShim.appName(for: game.path)))
    }

    /// 中文目录名不能把 slug 留空。
    @Test("中文目录名也能得到合法 name")
    func cjkFolderGetsName() {
        let name = NwjsAppShim.appName(for: "/games/苍蓝星")
        #expect(NwjsAppShim.isValidAppName(name))
        #expect(name.hasPrefix("game-"))
    }

    // MARK: - 接进启动计划

    @Test("name 坏的游戏：计划指向兼容目录，cwd 仍是游戏目录")
    func planUsesShim() throws {
        let game = try makeGame(name: "")
        let data = try makeDataDir()
        defer {
            try? FileManager.default.removeItem(at: game)
            try? FileManager.default.removeItem(at: data)
        }

        let ctx = LaunchContext(
            folder: game.path, gamePath: game.appendingPathComponent("Game.exe").path,
            gameArgs: ["version": .string("v0.1")], gameTitle: "x",
            dataDir: data.path, arch: "arm64")
        let binary = BinaryPaths.nwjsBinary(data.path, version: "v0.1", arch: "arm64")

        guard case .success(let plan) = LaunchPlanner.plan(
            engine: "nwjs", context: ctx, fileExists: { $0 == binary }) else {
            Issue.record("应该成功"); return
        }
        #expect(plan.args.first == NwjsAppShim.appDir(dataDir: data.path, folder: game.path))
        #expect(plan.args.first != game.path)
        #expect(plan.cwd == game.path, "cwd 仍是游戏目录，游戏里的相对路径行为不变")
        #expect(FileManager.default.fileExists(
            atPath: URL(fileURLWithPath: plan.args[0])
                .appendingPathComponent("package.json").path))
    }

    @Test("name 正常：计划还是直接用游戏目录")
    func planKeepsGameFolder() throws {
        let game = try makeGame(name: "rmmz-game")
        let data = try makeDataDir()
        defer {
            try? FileManager.default.removeItem(at: game)
            try? FileManager.default.removeItem(at: data)
        }

        let ctx = LaunchContext(
            folder: game.path, gamePath: game.appendingPathComponent("Game.exe").path,
            gameArgs: ["version": .string("v0.1")], gameTitle: "x",
            dataDir: data.path, arch: "arm64")
        let binary = BinaryPaths.nwjsBinary(data.path, version: "v0.1", arch: "arm64")

        guard case .success(let plan) = LaunchPlanner.plan(
            engine: "nwjs", context: ctx, fileExists: { $0 == binary }) else {
            Issue.record("应该成功"); return
        }
        #expect(plan.args == [game.path])
    }

    /// 诊断不能产物：`performPreparation: false` 时不能真的建目录。
    @Test("诊断不建兼容目录")
    func planWithoutPreparationDoesNotWrite() throws {        let game = try makeGame(name: "")
        let data = try makeDataDir()
        defer {
            try? FileManager.default.removeItem(at: game)
            try? FileManager.default.removeItem(at: data)
        }

        let ctx = LaunchContext(
            folder: game.path, gamePath: game.appendingPathComponent("Game.exe").path,
            gameArgs: ["version": .string("v0.1")], gameTitle: "x",
            dataDir: data.path, arch: "arm64")
        let binary = BinaryPaths.nwjsBinary(data.path, version: "v0.1", arch: "arm64")

        guard case .success(let plan) = LaunchPlanner.plan(
            engine: "nwjs", context: ctx, fileExists: { $0 == binary },
            performPreparation: false) else {
            Issue.record("应该成功"); return
        }
        #expect(plan.args.first == NwjsAppShim.appDir(dataDir: data.path, folder: game.path))
        #expect(!FileManager.default.fileExists(atPath: NwjsAppShim.root(dataDir: data.path)))
    }

    // MARK: - 删除游戏时清掉派生产物

    @Test("删除游戏时兼容目录跟着清掉")
    func removeCacheDeletesShim() throws {
        let game = try makeGame(name: "")
        let data = try makeDataDir()
        defer {
            try? FileManager.default.removeItem(at: game)
            try? FileManager.default.removeItem(at: data)
        }

        let shim = try #require(NwjsAppShim.ensure(dataDir: data.path, folder: game.path))
        #expect(FileManager.default.fileExists(atPath: shim))

        NwjsAppShim.removeCache(dataDir: data.path, folder: game.path)
        #expect(!FileManager.default.fileExists(atPath: shim))
        // 游戏目录本身不能受影响
        #expect(FileManager.default.fileExists(
            atPath: game.appendingPathComponent("www/index.html").path))
    }

    /// 兼容目录里出现真实文件（用户手放）时不能整目录删掉。
    @Test("兼容目录里有真实文件时不删")
    func removeCacheKeepsForeignFiles() throws {
        let game = try makeGame(name: "")
        let data = try makeDataDir()
        defer {
            try? FileManager.default.removeItem(at: game)
            try? FileManager.default.removeItem(at: data)
        }

        let shim = try #require(NwjsAppShim.ensure(dataDir: data.path, folder: game.path))
        let foreign = URL(fileURLWithPath: shim).appendingPathComponent("mine.txt")
        try Data("keep me".utf8).write(to: foreign)

        NwjsAppShim.removeCache(dataDir: data.path, folder: game.path)
        #expect(FileManager.default.fileExists(atPath: foreign.path))
    }

    // MARK: - 清单状态（诊断用）

    private func makeFolder(manifest: String?) throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-folder-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        if let manifest {
            try Data(manifest.utf8).write(to: root.appendingPathComponent("package.json"))
        }
        return root
    }

    @Test("没有 package.json = missing，不介入")
    func statusMissing() throws {
        let folder = try makeFolder(manifest: nil)
        defer { try? FileManager.default.removeItem(at: folder) }
        #expect(NwjsAppShim.manifestStatus(folder: folder.path) == .missing)
        #expect(!NwjsAppShim.requiresRepair(folder: folder.path))
    }

    /// 根本不是 JSON / 截断：修不了，只能告诉用户（诊断走 unreadable 分支）。
    ///
    /// ⚠️ 样本不能用「尾逗号」：新版 Foundation 的 JSONSerialization 容忍尾逗号，
    ///    用它测到的是 ok/nameInvalid，测不出 unreadable。
    @Test("坏 JSON = unreadable，不静默当正常")
    func statusUnreadable() throws {
        let folder = try makeFolder(manifest: "{ this is not json ")
        defer { try? FileManager.default.removeItem(at: folder) }
        #expect(NwjsAppShim.manifestStatus(folder: folder.path) == .unreadable)
        // 解析不了就不能补：不能返回一个假的兼容目录
        #expect(!NwjsAppShim.requiresRepair(folder: folder.path))
    }

    @Test("name 合法 = ok")
    func statusOK() throws {
        let folder = try makeFolder(manifest: "{\"name\":\"rmmz-game\",\"main\":\"index.html\"}")
        defer { try? FileManager.default.removeItem(at: folder) }
        #expect(NwjsAppShim.manifestStatus(folder: folder.path) == .ok)
    }

    @Test("name 非字符串也算不合格")
    func statusNonStringName() throws {
        let folder = try makeFolder(manifest: "{\"name\":123,\"main\":\"index.html\"}")
        defer { try? FileManager.default.removeItem(at: folder) }
        #expect(NwjsAppShim.manifestStatus(folder: folder.path) == .nameInvalid)
    }

    @Test("name 全是空格也算不合格")
    func statusBlankName() throws {
        let folder = try makeFolder(manifest: "{\"name\":\"   \"}")
        defer { try? FileManager.default.removeItem(at: folder) }
        #expect(NwjsAppShim.manifestStatus(folder: folder.path) == .nameInvalid)
    }

    /// 尾逗号：Foundation 解析得动，nw.js 的 JSON.parse 不认。
    /// 这一档必须判成 `loose` 并重写，否则用户继续看到「点了没反应」。
    @Test("尾逗号：name 合格但清单不严格 = loose，重写成标准 JSON")
    func looseManifestGetsRewritten() throws {
        let folder = try makeFolder(manifest: "{\n  \"name\": \"rmmz-game\",\n  \"main\": \"index.html\",\n}\n")
        let data = try makeDataDir()
        defer {
            try? FileManager.default.removeItem(at: folder)
            try? FileManager.default.removeItem(at: data)
        }

        let original = try Data(contentsOf: folder.appendingPathComponent("package.json"))
        #expect(NwjsAppShim.manifestStatus(folder: folder.path) == .loose)
        #expect(NwjsAppShim.requiresRepair(folder: folder.path))

        let shim = try #require(NwjsAppShim.ensure(dataDir: data.path, folder: folder.path))
        let rewritten = try Data(contentsOf: URL(fileURLWithPath: shim)
            .appendingPathComponent("package.json"))
        #expect(StrictJSON.isValid(rewritten), "兼容清单必须是严格 JSON，nw.js 才吃")

        let object = try #require(
            try JSONSerialization.jsonObject(with: rewritten) as? [String: Any])
        // name 本来就合格 → 不该被改掉
        #expect(object["name"] as? String == "rmmz-game")
        #expect(object["main"] as? String == "index.html")
        // 游戏原文一个字都没动
        #expect(try Data(contentsOf: folder.appendingPathComponent("package.json")) == original)
    }
}
