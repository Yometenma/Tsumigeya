import Foundation
import Testing
@testable import TsumigeyaCore

func wineTestPE() -> Data {
    var data = Data(repeating: 0, count: 68)
    data[0] = 0x4d; data[1] = 0x5a; data[60] = 64
    data.replaceSubrange(64..<68, with: [0x50, 0x45, 0, 0])
    return data
}

@Suite("Wine 安装、识别与启动")
struct WineRuntimeTests {
    func fixture() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("wine-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    @Test("只用真实 PE 兜底，专用运行时优先；选中的 EXE 不丢失")
    func detection() throws {
        let folder = try fixture(); defer { try? FileManager.default.removeItem(at: folder) }
        let exe = folder.appendingPathComponent("实际入口.EXE")
        try wineTestPE().write(to: exe)
        #expect(EngineRegistry.detect(exe: exe.path)?.folder == "wine")
        #expect(GameImport.inspect(selectedPath: exe.path).entryPath == exe.path)
        try Data("not an exe".utf8).write(to: folder.appendingPathComponent("fake.exe"))
        #expect(EngineRegistry.detect(exe: folder.appendingPathComponent("fake.exe").path) == nil)
        try Data().write(to: folder.appendingPathComponent("nw.dll"))
        try Data().write(to: folder.appendingPathComponent("package.json"))
        #expect(EngineRegistry.detect(exe: exe.path)?.folder == "nwjs")
        #expect(EngineRegistry.all.allSatisfy { $0.launchable })
        #expect(!EngineRegistry.all.contains { ["unity", "rpgbakin", "wolfrpg"].contains($0.folder) })
    }

    @Test("多个入口拒绝猜测，明确指定时使用参数数组和正确工作目录")
    func plans() throws {
        let folder = try fixture(); defer { try? FileManager.default.removeItem(at: folder) }
        let a = folder.appendingPathComponent("游戏 ' A.exe")
        let b = folder.appendingPathComponent("uninstall.exe")
        try wineTestPE().write(to: a); try wineTestPE().write(to: b)
        let context = LaunchContext(folder: folder.path, gamePath: folder.appendingPathComponent("missing.exe").path,
                                    gameArgs: [:], gameTitle: "测试", dataDir: folder.path, arch: "x64", gameID: "game:7")
        #expect(throws: (any Error).self) { try WineRuntime.plan(context, fileExists: { _ in true }, listDir: { _ in [a.lastPathComponent, b.lastPathComponent] }).get() }
        let selected = LaunchContext(folder: folder.path, gamePath: a.path,
            gameArgs: ["arguments": .array([.string("a b"), .string("$(touch nope)")]), "locale": .string("ja_JP.UTF-8")],
            gameTitle: "测试", dataDir: folder.path, arch: "x64", gameID: "game:7")
        let plan = try WineRuntime.plan(selected, fileExists: { _ in true }, listDir: { _ in [] }).get()
        #expect(plan.args == [a.path, "a b", "$(touch nope)"])
        #expect(plan.cwd == folder.path)
        #expect(plan.environment["LANG"] == "ja_JP.UTF-8")
        #expect(plan.environment["WINEPREFIX"] == WineRuntime.prefix(dataDir: folder.path, folder: folder.path, gameID: "game:7"))
        #expect(try LaunchPlanner.plan(engine: "wolfrpg", context: selected, fileExists: { _ in true }, listDir: { _ in [] }).get().engine == "wine")
    }

    @Test("旧标识读取为 Wine，原始键和未知字段写回保留")
    func migration() throws {
        for engine in ["unity", "rpgbakin", "wolfrpg"] {
            let object: [String: JSONValue] = ["gameTitle": .string("测试"), "gameEngine": .string(engine), "gamePath": .string("/games/a/Actual.exe"), "custom": .object(["x": .int(1)])]
            let data = try JSONStore.defaultEncoder.encode(JSONValue.object(object))
            var game = try JSONDecoder().decode(GameRecord.self, from: data)
            #expect(game.gameEngine == "wine")
            #expect(EngineRegistry.find(folder: engine)?.folder == "wine")
            let encoded = try JSONDecoder().decode(JSONValue.self, from: JSONStore.defaultEncoder.encode(game))
            #expect(encoded.objectValue?["gameEngine"]?.stringValue == engine)
            #expect(encoded.objectValue?["custom"] == object["custom"])
            let identity = game.wineEnvironmentIdentity
            game.gameTitle = "改标题"
            game.gameEngine = "wine"
            #expect(game.wineEnvironmentIdentity == identity)
            game.gamePath = "/moved/Actual.exe"
            #expect(game.wineEnvironmentIdentity == identity)
        }
    }

    @Test("新记录独立环境不因游戏编号复用而串用；环境不随运行时卸载")
    func environments() {
        let a = GameRecord(id: "", gameTitle: "A", gamePath: "/game/A.exe", gameEngine: "wine")
        let b = GameRecord(id: "", gameTitle: "A", gamePath: "/game/A.exe", gameEngine: "wine")
        #expect(a.wineEnvironmentIdentity != b.wineEnvironmentIdentity)
        let prefix = WineRuntime.prefix(dataDir: "/data", folder: "/game", gameID: a.wineEnvironmentIdentity)
        #expect(!prefix.contains("/modules/"))
        #expect(prefix == WineRuntime.prefix(dataDir: "/data", folder: "/moved", gameID: a.wineEnvironmentIdentity))
    }

    @Test("安装定义包含校验且 manifest 往返保留校验和中文参数")
    func manifest() throws {
        let definition = try #require(EngineRegistry.find(folder: "wine"))
        let object = EngineDependencies.buildManifest(for: definition)
        let manifest = try JSONDecoder().decode(Manifest.self, from: JSONStore.defaultEncoder.encode(JSONValue.object(object)))
        #expect(manifest.dependencies["wine"]?.builds["universal"]?.sha256?.count == 64)
        #expect(Set(manifest.gameArgs.keys) == ["executable", "arguments", "locale"])
        #expect(ManifestStore.load(dataDir: "/missing", engine: "wine")?.gameArgs.count == 3)
    }

    @Test("下载校验失败不解压，不覆盖已有运行时")
    func checksum() async throws {
        let folder = try fixture(); defer { try? FileManager.default.removeItem(at: folder) }
        let old = folder.appendingPathComponent("deps/runtime/keep.txt")
        try FileManager.default.createDirectory(at: old.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("old".utf8).write(to: old)
        let env = InstallEnvironment(download: { _, destination, _ in
            try Data("corrupt".utf8).write(to: URL(fileURLWithPath: destination)); return 7
        }, extract: { _, _ in Issue.record("校验失败不应解压") })
        do {
            _ = try await EngineInstaller.install(root: folder.path,
                dependencies: [("runtime", .init(builds: ["universal": .init(link: "https://example.com/wine.tar.xz", unzip: true, sha256: String(repeating: "0", count: 64))]))],
                env: env, arch: "x64")
            Issue.record("校验失败应抛错")
        } catch { #expect((error as? InstallError)?.message.contains("SHA-256") == true) }
        #expect(try String(contentsOf: old, encoding: .utf8) == "old")
    }
    @Test("更新下载失败保留原 Wine；字体默认值不覆盖已有环境")
    func updateAndFonts() async throws {
        let folder = try fixture(); defer { try? FileManager.default.removeItem(at: folder) }
        let module = folder.appendingPathComponent("modules/wine")
        let old = module.appendingPathComponent("deps/wine/old")
        try FileManager.default.createDirectory(at: old.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("old".utf8).write(to: old)
        let spec = DependencySpec(builds: ["universal": .init(link: "https://example.com/wine.tar.xz", unzip: true)])
        let env = InstallEnvironment(download: { _, _, _ in throw URLError(.notConnectedToInternet) },
                                     extract: { _, _ in Issue.record("下载失败不应解压") })
        do {
            _ = try await EngineInstaller.update(root: module.path, previousDependencies: [("wine", spec)],
                newDependencies: [("wine", spec)], env: env, arch: "x64")
            Issue.record("失败更新不应返回成功")
        } catch { }
        #expect(try String(contentsOf: old, encoding: .utf8) == "old")
        let prefix = folder.appendingPathComponent("prefix").path
        try WineRuntime.prepareFonts(prefix: prefix)
        if FileManager.default.fileExists(atPath: prefix + ".fonts.reg") {
            let registry = try String(contentsOfFile: prefix + ".fonts.reg", encoding: .utf16)
            #expect(["STHeiti", "Heiti SC", "Hiragino Sans GB"].contains { registry.contains("\"Tahoma\"=\"\($0)\"") })
            try FileManager.default.removeItem(atPath: prefix + ".fonts.reg")
        }
        try FileManager.default.createDirectory(atPath: prefix, withIntermediateDirectories: true)
        try Data("user config".utf8).write(to: URL(fileURLWithPath: prefix + "/system.reg"))
        try WineRuntime.prepareFonts(prefix: prefix)
        #expect(!FileManager.default.fileExists(atPath: prefix + ".fonts.reg"))
        #expect(try String(contentsOfFile: prefix + "/system.reg", encoding: .utf8) == "user config")
    }

    @Test("真实 Wine 包校验、安装及 32／64 位程序运行", .enabled(if: ProcessInfo.processInfo.environment["TSUMIGEYA_WINE_TEST_ARCHIVE"] != nil))
    func realPackage() async throws {
        guard let archive = ProcessInfo.processInfo.environment["TSUMIGEYA_WINE_TEST_ARCHIVE"] else { return }
        let folder = try fixture(); defer { try? FileManager.default.removeItem(at: folder) }
        let module = folder.appendingPathComponent("modules/wine")
        let env = InstallEnvironment(download: { _, destination, _ in
            try FileManager.default.copyItem(atPath: archive, toPath: destination)
            return (try FileManager.default.attributesOfItem(atPath: destination)[.size] as? NSNumber)?.int64Value ?? 0
        }, extract: { archive, destination in try Extract.extractArchive(archive: archive, to: destination) })
        _ = try await EngineInstaller.install(root: module.path, dependencies: EngineDependencies.dependencies(for: "wine"), env: env, arch: Arch.current().rawValue)
        #expect(FileManager.default.isExecutableFile(atPath: WineRuntime.binary(folder.path)))
        #expect(EngineStatus.scan(dataDir: folder.path).first { $0.id == "wine" }?.installed == true)
        for architecture in ["x86_64-windows", "i386-windows"] {
            let gameFolder = folder.appendingPathComponent(architecture)
            try FileManager.default.createDirectory(at: gameFolder, withIntermediateDirectories: true)
            let cmd = gameFolder.appendingPathComponent("命令行.exe")
            let source = module.appendingPathComponent("deps/wine/Wine Devel.app/Contents/Resources/wine/lib/wine/" + architecture + "/cmd.exe")
            try FileManager.default.copyItem(at: source, to: cmd)
            let context = LaunchContext(folder: gameFolder.path, gamePath: cmd.path,
                gameArgs: ["arguments": .array([.string("/c"), .string("echo wine-" + architecture + ">result.txt")])],
                gameTitle: "Windows 控制台", dataDir: folder.path, arch: Arch.current().rawValue, gameID: architecture)
            let plan = try LaunchPlanner.plan(engine: "wine", context: context).get()
            let outcome = Launcher.launch(plan, captureStdio: gameFolder.appendingPathComponent("wine.log").path)
            let pid = try #require(outcome.pid)
            defer { if RunningProcesses().isAlive(pid: pid) { RunningProcesses().terminate(pid: pid) } }
            let deadline = Date().addingTimeInterval(90)
            while RunningProcesses().isAlive(pid: pid), Date() < deadline { try await Task.sleep(for: .milliseconds(100)) }
            let log = (try? String(contentsOf: gameFolder.appendingPathComponent("wine.log"), encoding: .utf8)) ?? "无日志"
            try #require(!RunningProcesses().isAlive(pid: pid), "Windows 程序未正常退出：\(log)")
            #expect(WineRuntime.lastExit(dataDir: folder.path, folder: gameFolder.path, gameID: architecture) == 0)
            #expect(try String(contentsOf: gameFolder.appendingPathComponent("result.txt"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines) == "wine-" + architecture)
        }
    }

    @Test("监护等待派生程序，停止仅清理当前 Wine 环境，传参不经 shell 展开")
    func supervisor() throws {
        let folder = try fixture(); defer { try? FileManager.default.removeItem(at: folder) }
        let wine = folder.appendingPathComponent("wine")
        let server = folder.appendingPathComponent("wineserver")
        try "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$WINEPREFIX.args\"\n(sleep 5; touch \"$WINEPREFIX.done\") >/dev/null 2>&1 &\nexit 0\n".write(to: wine, atomically: true, encoding: .utf8)
        try "#!/bin/sh\nif [ \"$1\" = -k ]; then touch \"$WINEPREFIX.done\"; touch \"$WINEPREFIX.stopped\"; fi\nwhile [ ! -f \"$WINEPREFIX.done\" ]; do sleep 0.05; done\n".write(to: server, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: wine.path)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: server.path)
        let prefix = folder.appendingPathComponent("环境 空格").path
        try FileManager.default.createDirectory(atPath: prefix, withIntermediateDirectories: true)
        try Data().write(to: URL(fileURLWithPath: prefix + "/system.reg"))
        let plan = LaunchPlan(binary: wine.path, args: ["a b", "$(touch nope)"], cwd: folder.path, engine: "wine", environment: ["WINEPREFIX": prefix])
        let capture = folder.appendingPathComponent("supervisor.log").path
        let outcome = Launcher.launch(plan, captureStdio: capture)
        let pid = try #require(outcome.pid)
        let deadline = Date().addingTimeInterval(3)
        while !FileManager.default.fileExists(atPath: prefix + ".args"), Date() < deadline {
            Thread.sleep(forTimeInterval: 0.02)
        }
        let log = (try? String(contentsOfFile: capture, encoding: .utf8)) ?? "无日志"
        try #require(FileManager.default.fileExists(atPath: prefix + ".args"), "Wine 监护没有运行入口：\(log)")
        #expect(RunningProcesses().isAlive(pid: pid))
        let args = try String(contentsOfFile: prefix + ".args", encoding: .utf8)
        #expect(args == "a b\n$(touch nope)\n")
        #expect(!FileManager.default.fileExists(atPath: folder.appendingPathComponent("nope").path))
        #expect(RunningProcesses().terminate(pid: pid, graceSeconds: 3))
        #expect(FileManager.default.fileExists(atPath: prefix + ".stopped"))
        #expect(try String(contentsOfFile: prefix + ".exit", encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines) == "143")
    }

}
