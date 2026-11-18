import Foundation
import Testing
@testable import TsumigeyaCore

@Suite("XP 编号 RTP")
struct NumberedRtpTests {
    private func withIni(_ text: String, _ body: (String) throws -> Void) throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("tsmg-xp-rtp-\(UUID())")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        try text.write(to: folder.appendingPathComponent("Game.ini"), atomically: true, encoding: .isoLatin1)
        try body(folder.path)
    }

    @Test("官方 XP 游戏的 RTP1 被解析并传入启动配置")
    func officialXPLayout() throws {
        try withIni("[Game]\r\nLibrary=RGSS102E.dll\r\nScripts=Data\\Scripts.rxdata\r\nRTP1=Standard\r\nRTP2=\r\nRTP3=\r\n") { folder in
            let ini = GameIniReader.read(gameDir: folder)
            #expect(ini.rtp == "Standard")
            #expect(ini.hasRtpLine)
            #expect(ini.rtpNames == ["Standard"])
            let ctx = LaunchContext(folder: folder, gamePath: folder + "/Game.exe", gameArgs: [:], gameTitle: "测试", dataDir: "/data", arch: "arm64")
            let rtp = MkxpzConfig.resolveRtp(context: ctx)
            #expect(rtp.rgssVersion == 1)
            #expect(rtp.rtpDirs == [BinaryPaths.mkxpzRtpDir(dataDir: "/data", rtpName: "Standard")])
            #expect(MkxpzConfig.build(context: ctx, folder: folder, rgssVersion: rtp.rgssVersion, rtpDirs: rtp.rtpDirs)["RTP"] == .array(rtp.rtpDirs.map(JSONValue.string)))
        }
    }

    @Test("编号键按序保留，重复素材路径只加载一次，其他分节不参与")
    func multiplePacks() throws {
        try withIni("[Other]\r\nRTP1=Ignored\r\n[Game]\r\nRTP3=Custom\r\nRTP2=RPGXP\r\nRTP1=Standard\r\nRTP4=Ignored\r\n") { folder in
            #expect(GameIniReader.read(gameDir: folder).rtpNames == ["Standard", "RPGXP", "Custom"])
            let ctx = LaunchContext(folder: folder, gamePath: folder + "/Game.exe", gameArgs: [:], gameTitle: "测试", dataDir: "/data", arch: "arm64")
            let rtp = MkxpzConfig.resolveRtp(context: ctx)
            #expect(rtp.rgssVersion == 1)
            #expect(rtp.rtpDirs == ["Standard", "Custom"].map { BinaryPaths.mkxpzRtpDir(dataDir: "/data", rtpName: $0) })
        }
    }

    @Test("空编号 RTP 不回落到默认素材")
    func emptyPacks() throws {
        try withIni("[Game]\nLibrary=RGSS102E.dll\nRTP1=\nRTP2=\nRTP3=\n") { folder in
            let ini = GameIniReader.read(gameDir: folder)
            #expect(ini.hasRtpLine)
            #expect(ini.rtp == nil)
            #expect(ini.rtpNames.isEmpty)
            let ctx = LaunchContext(folder: folder, gamePath: folder + "/Game.exe", gameArgs: [:], gameTitle: "测试", dataDir: "/data", arch: "arm64")
            #expect(MkxpzConfig.resolveRtp(context: ctx).rtpDirs.isEmpty)
        }
    }

    @Test("单值 RTP 保持优先，用户自定义路径仍覆盖解析结果")
    func singularAndOverride() throws {
        try withIni("[Game]\nRTP1=Standard\nRTP=RPGVX\n") { folder in
            let ini = GameIniReader.read(gameDir: folder)
            #expect(ini.rtp == "RPGVX")
            #expect(ini.rtpNames == ["RPGVX", "Standard"])
            let ctx = LaunchContext(folder: folder, gamePath: folder + "/Game.exe", gameArgs: ["RTP": .array([.string("/custom")])], gameTitle: "测试", dataDir: "/data", arch: "arm64")
            #expect(MkxpzConfig.resolveRtp(context: ctx).rtpDirs == ["/custom"])
        }
    }
}
