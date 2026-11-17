import Foundation
import Testing
@testable import TsumigeyaCore

@Suite("启动诊断")
struct LaunchDiagnosticsTests {
    private func fixture(_ name: String = "游戏") throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("diagnosis-" + UUID().uuidString)
            .appendingPathComponent(name)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    @Test("目录不存在与运行时缺失分别显示处理方向")
    func missingFolderAndRuntime() throws {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("diagnosis-missing-" + UUID().uuidString)
        let game = GameRecord(id: "1", gameTitle: "测试", gamePath: folder.appendingPathComponent("Game.exe").path, gameEngine: "kirikiri")
        let result = LaunchDiagnostics.inspect(game: game, dataDir: "/data", arch: "arm64")
        #expect(result.hasBlockingIssues)
        #expect(result.items.contains { $0.id == "game-folder" && $0.level == .blocking })
        #expect(result.items.contains { $0.id == "runtime-binary" && $0.level == .blocking })
    }

    @Test("已找到可执行运行时且目录可读时报告可启动")
    func readyWithRuntime() throws {
        let folder = try fixture()
        defer { try? FileManager.default.removeItem(at: folder.deletingLastPathComponent()) }
        let game = GameRecord(id: "2", gameTitle: "测试", gamePath: folder.appendingPathComponent("Game.exe").path, gameEngine: "kirikiri")
        let result = LaunchDiagnostics.inspect(
            game: game, dataDir: "/data", arch: "arm64",
            fileExists: { $0.hasSuffix("krkrsdl2") },
            isExecutable: { $0.hasSuffix("krkrsdl2") },
            listDir: { _ in [] })
        #expect(result.isReady)
        #expect(result.plan?.engine == "kirikiri")
        #expect(result.items.contains { $0.id == "runtime-binary" && $0.level == .good })
    }

    @Test("运行时存在但无执行权限时不能误报正常")
    func nonExecutable() throws {
        let folder = try fixture()
        defer { try? FileManager.default.removeItem(at: folder.deletingLastPathComponent()) }
        let game = GameRecord(id: "3", gameTitle: "测试", gamePath: folder.appendingPathComponent("Game.exe").path, gameEngine: "kirikiri")
        let result = LaunchDiagnostics.inspect(
            game: game, dataDir: "/data", arch: "arm64",
            fileExists: { $0.hasSuffix("krkrsdl2") },
            isExecutable: { _ in false },
            listDir: { _ in [] })
        #expect(result.hasBlockingIssues)
        #expect(result.items.contains { $0.id == "runtime-executable" && $0.level == .blocking })
    }

    @Test("旧 Unity 记录走 Wine，并检查真实启动入口")
    func detectOnly() throws {
        let folder = try fixture()
        defer { try? FileManager.default.removeItem(at: folder.deletingLastPathComponent()) }
        let game = GameRecord(id: "4", gameTitle: "测试", gamePath: folder.appendingPathComponent("Game.exe").path, gameEngine: "unity")
        let result = LaunchDiagnostics.inspect(
            game: game, dataDir: "/data", arch: "arm64",
            fileExists: { _ in true }, isExecutable: { _ in true }, listDir: { _ in [] })
        #expect(result.items.contains { $0.id == "engine-known" && $0.level == .good })
        #expect(result.items.contains { $0.id == "wine-prefix" })
        #expect(result.hasBlockingIssues)
    }

    @Test("已运行的游戏显示提示，但不改变其它启动条件判定")
    func alreadyRunning() throws {
        let folder = try fixture()
        defer { try? FileManager.default.removeItem(at: folder.deletingLastPathComponent()) }
        let game = GameRecord(id: "5", gameTitle: "测试", gamePath: folder.appendingPathComponent("Game.exe").path, gameEngine: "kirikiri")
        let result = LaunchDiagnostics.inspect(
            game: game, dataDir: "/data", arch: "arm64", runningPID: 123,
            fileExists: { $0.hasSuffix("krkrsdl2") }, isExecutable: { _ in true }, listDir: { _ in [] })
        #expect(result.isReady)
        #expect(result.items.contains { $0.id == "already-running" && $0.level == .notice })
    }

    @Test("诊断 mkxp-z 计划绝不写入配置或修改游戏文件")
    func mkxpzReadOnly() throws {
        let root = try fixture("mkxpz")
        defer { try? FileManager.default.removeItem(at: root.deletingLastPathComponent()) }
        let data = root.appendingPathComponent("data")
        let ini = root.appendingPathComponent("Game.ini")
        let original = Data("[Game]\nTitle=原文\n".utf8)
        try original.write(to: ini)
        let context = LaunchContext(
            folder: root.path,
            gamePath: root.appendingPathComponent("Game.exe").path,
            gameArgs: [:], gameTitle: "测试", dataDir: data.path, arch: "arm64")
        let result = LaunchPlanner.plan(
            engine: "mkxpz", context: context, fileExists: { _ in true },
            performPreparation: false)
        guard case .success(let plan) = result else {
            Issue.record("诊断模式不应因为准备文件不存在而失败")
            return
        }
        #expect(plan.engine == "mkxpz")
        #expect(try Data(contentsOf: ini) == original)
        #expect(!FileManager.default.fileExists(atPath: BinaryPaths.mkxpzConfigPath(data.path)))
    }
}



