// 存档导出/导入测试（**用真文件、真 zip**）。
//
// 对应 Electron 版：`test/save-archive-io.test.ts`（26 条）
//
// ===== 本文件最重要的三条 =====
//
// ① **打整个目录**（D81）：插件写的 `lastsave.autobak` 也要在包里
// ② **导入顺序：先校验 → 再备份 → 才写**（最坏情况只是"没导进来"）
// ③ **备份幂等**：第二次导入不覆盖已有 `.tsumigeya-bak`
import Foundation
import Testing

@testable import TsumigeyaCore

// MARK: - 文件名清洗

@Suite("存档包文件名")
struct SaveArchiveNameTests {

    @Test("非法字符替换")
    func illegalChars() {
        #expect(SaveArchiveName.safePart("a/b") == "a_b")
        #expect(SaveArchiveName.safePart("a:b") == "a_b")
        #expect(SaveArchiveName.safePart("a*b?c") == "a_b_c")
    }

    /// ⚠️ **中文要保留**（用户的游戏名大多是中文，洗成 ASCII 就认不出来了）。
    @Test("保留中文")
    func keepsChinese() {
        #expect(SaveArchiveName.safePart("魔法少女セレスフォニア")
            == "魔法少女セレスフォニア")
    }

    @Test("空白变连字符")
    func spacesToDash() {
        #expect(SaveArchiveName.safePart("Karryn's Prison") == "Karryn's-Prison")
        #expect(SaveArchiveName.safePart("a   b") == "a-b")   // 连续空白压成一个
    }

    @Test("首尾点与连字符去掉")
    func trimsEdges() {
        #expect(SaveArchiveName.safePart(".hidden") == "hidden")
        #expect(SaveArchiveName.safePart("--x--") == "x")
    }

    /// ⚠️ 洗空了要兜底（不能生成一个空文件名的 zip）。
    @Test("洗空兜底")
    func emptyFallback() {
        #expect(SaveArchiveName.safePart("") == "game")
        #expect(SaveArchiveName.safePart(nil) == "game")
        #expect(SaveArchiveName.safePart("...") == "game")
    }

    @Test("过长截断")
    func truncates() {
        let long = String(repeating: "长", count: 100)
        let result = SaveArchiveName.safePart(long)
        #expect(result.count == 60)
    }

    @Test("完整文件名带时间戳")
    func fileNameWithTimestamp() {
        let name = SaveArchiveName.archiveFileName(
            title: "游戏名", at: Date(timeIntervalSince1970: 0))
        #expect(name.hasSuffix(".zip"))
        #expect(name.contains("游戏名"))
        // 时间戳是 8 位日期 + 连字符 + 4 位时间
        #expect(name.contains("-"))
    }
}

// MARK: - manifest 解析

@Suite("存档包 manifest")
struct SaveManifestTests {

    /// 正常的 manifest 能解析。
    @Test("正常解析")
    func parsesValid() throws {
        let json = JSONValue.object([
            "gameTitle": .string("测试游戏"),
            "engine": .string("nwjs"),
            "layout": .string("nwjs-mv"),
            "exportedAt": .string("2026-11-06T07:00:00Z"),
            "files": .array([
                .object([
                    "name": .string("file1.rpgsave"),
                    "sha256": .string(String(repeating: "a", count: 64)),
                ]),
            ]),
        ])
        let manifest = try #require(SaveManifestParser.parse(json))
        #expect(manifest.gameTitle == "测试游戏")
        #expect(manifest.files.count == 1)
    }

    /// ⚠️ **sha256 必须是 64 位小写十六进制** —— 否则校验防线形同虚设。
    @Test("拒绝非法 sha256")
    func rejectsBadSha() {
        let base: [String: JSONValue] = [
            "gameTitle": .string("x"),
            "engine": .string("nwjs"),
            "layout": .string("l"),
            "exportedAt": .string("t"),
        ]
        // 太短
        var short = base
        short["files"] = .array([.object([
            "name": .string("a"), "sha256": .string("aaa")])])
        #expect(SaveManifestParser.parse(.object(short)) == nil)

        // 大写（不合法）
        var upper = base
        upper["files"] = .array([.object([
            "name": .string("a"),
            "sha256": .string(String(repeating: "A", count: 64))])])
        #expect(SaveManifestParser.parse(.object(upper)) == nil)

        // 长度对但含非十六进制字符
        var garbage = base
        garbage["files"] = .array([.object([
            "name": .string("a"),
            "sha256": .string(String(repeating: "z", count: 64))])])
        #expect(SaveManifestParser.parse(.object(garbage)) == nil)
    }

    /// ⚠️ **不是我们的包 → nil**（不去猜缺了什么再试着补）。
    @Test("拒绝缺字段")
    func rejectsMissingFields() {
        #expect(SaveManifestParser.parse(.object([:])) == nil)
        #expect(SaveManifestParser.parse(.object([
            "gameTitle": .string("x")])) == nil)   // 缺其他字段
        #expect(SaveManifestParser.parse(.string("not an object")) == nil)
    }

    /// 编码/解析往返。
    @Test("编码往返")
    func roundtrip() throws {
        let original = SaveManifest(
            gameTitle: "游戏", engine: "mkxpz", layout: "rgss-data",
            exportedAt: "2026-11-06T07:00:00Z",
            files: [
                .init(name: "Save1.rvdata2", sha256: String(repeating: "b", count: 64)),
            ])
        let encoded = SaveManifestParser.encode(original)
        let back = try #require(SaveManifestParser.parse(encoded))
        #expect(back == original)
    }
}

// MARK: - 导出阻断

@Suite("导出阻断")
struct SaveExportPolicyTests {

    /// ⚠️ **运行中一律禁止**（D82）。
    @Test("运行中禁止")
    func blocksRunning() {
        let block = SaveExportPolicy.blocked(
            running: true, hasLocation: true, empty: false)
        #expect(block == .running)
    }

    /// ⚠️ **判定顺序：先判运行再判位置**。
    ///
    /// 守的是：反过来会让一个**正在跑**的游戏显示「找不到存档」，
    /// 用户就去查目录了 —— 而真正的问题是「关掉游戏」。
    @Test("运行优先于找不到位置")
    func runningTakesPrecedence() {
        let block = SaveExportPolicy.blocked(
            running: true, hasLocation: false, empty: true)
        #expect(block == .running, "运行中必须先报「关掉游戏」，不是「找不到存档」")
    }

    @Test("找不到位置")
    func blocksNoLocation() {
        #expect(SaveExportPolicy.blocked(
            running: false, hasLocation: false, empty: false) == .noLocation)
    }

    @Test("空目录")
    func blocksEmpty() {
        #expect(SaveExportPolicy.blocked(
            running: false, hasLocation: true, empty: true) == .empty)
    }

    @Test("可以导出")
    func allowsExport() {
        #expect(SaveExportPolicy.blocked(
            running: false, hasLocation: true, empty: false) == nil)
    }

    /// 三种阻断的文案必须不同（要让用户知道下一步做什么）。
    @Test("三种文案不同")
    func messagesDiffer() {
        let running = ExportBlock.running.message
        let noLoc = ExportBlock.noLocation.message
        let empty = ExportBlock.empty.message
        #expect(running != noLoc)
        #expect(running != empty)
        #expect(noLoc != empty)
        #expect(running.contains("关掉游戏"))
        #expect(empty.contains("存一次档"))
    }

    /// 点开头文件是噪音（D86）。
    @Test("噪音文件")
    func noiseFiles() {
        #expect(SaveExportPolicy.isNoiseFile("._file1.rpgsave"))
        #expect(SaveExportPolicy.isNoiseFile(".DS_Store"))
        #expect(!SaveExportPolicy.isNoiseFile("file1.rpgsave"))
        // ⚠️ 插件文件**不是**噪音（D81：它们也是存档数据）
        #expect(!SaveExportPolicy.isNoiseFile("lastsave.autobak"))
        #expect(!SaveExportPolicy.isNoiseFile("sync_data.rpgsave"))
    }
}

// MARK: - 端到端（真 zip + 真文件）

@Suite("导出导入端到端")
struct SaveArchiveE2ETests {

    /// 造一个临时游戏目录（含存档）。
    func makeGame(
        saveSubdir: String,
        files: [(String, String)],
        engine: String = "nwjs",
        packageMain: String? = "www/index.html"
    ) throws -> (root: String, saveDir: String) {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-e2e-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)

        let saveDir = root.appendingPathComponent(saveSubdir).path
        try FileManager.default.createDirectory(atPath: saveDir, withIntermediateDirectories: true)

        // 写 package.json（决定 nwjs 的存档位置）
        if let main = packageMain {
            let pkg = "{\"main\": \"\(main)\"}"
            try pkg.write(
                to: root.appendingPathComponent("package.json"),
                atomically: true, encoding: .utf8)
        }
        // 写存档文件
        for (name, content) in files {
            try content.write(
                to: URL(fileURLWithPath: (saveDir as NSString).appendingPathComponent(name)),
                atomically: true, encoding: .utf8)
        }
        return (root.path, saveDir)
    }

    /// ⚠️⚠️ **导出打整个目录**（D81）—— 插件文件也要在包里。
    @Test("导出包含插件文件")
    func exportIncludesPluginFiles() throws {
        let (root, _) = try makeGame(
            saveSubdir: "www/save",
            files: [
                ("file1.rpgsave", "玩家存档1"),
                ("file2.rpgsave", "玩家存档2"),
                ("lastsave.autobak", "插件写的备份"),
                ("sync_data.rpgsave", "插件写的同步数据"),
                ("config.rpgsave", "配置"),
                ("._file1.rpgsave", "AppleDouble 噪音"),   // ← 这个不该进包
            ])
        defer { try? FileManager.default.removeItem(atPath: root) }

        // ⚠️ **先确认探测能认出位置**（本鱼第一版直接调 export，
        //    结果 4 条端到端测试全报 `noLocation` —— 探测没认出来）。
        //    测试造的是 `www/save` + `package.json{main:www/index.html}`，
        //    但 `SaveStore.list` 的 `gamePath` 参数传的是**文件**路径时，
        //    `DetectPath.gameDirForFiles` 会退到 `www/` —— 而不是游戏根。
        let gamePath = (root as NSString).appendingPathComponent("www/save/file1.rpgsave")
        let listing = SaveStore.list(gamePath: gamePath, engine: "nwjs")
        let detectedDir = try #require(listing.dir, "探测不到存档位置（测试造目录的方式有问题）")
        #expect(detectedDir.hasSuffix("www/save"), "该指向 www/save，实际 \(detectedDir)")

        let outDir = (root as NSString).appendingPathComponent("out")
        let result = SaveArchiveIO.export(
            gamePath: gamePath,
            engine: "nwjs", gameTitle: "测试游戏",
            outputDir: outDir, isRunning: false)
        let exported = try result.get()

        #expect(exported.fileCount == 5, "5 个真存档（噪音那 1 个不算）")

        // 读回包，核对内容
        let manifest = try readManifest(from: exported.archivePath)
        let names = Set(manifest.files.map(\.name))
        #expect(names.contains("lastsave.autobak"), "D81：插件文件必须在包里")
        #expect(names.contains("sync_data.rpgsave"))
        #expect(!names.contains("._file1.rpgsave"), "D86：点开头的不该进包")
    }

    /// ⚠️ **运行中禁止导出**。
    @Test("运行中拒绝导出")
    func refusesWhenRunning() throws {
        let (root, _) = try makeGame(
            saveSubdir: "www/save", files: [("file1.rpgsave", "x")])
        defer { try? FileManager.default.removeItem(atPath: root) }

        let result = SaveArchiveIO.export(
            gamePath: (root as NSString).appendingPathComponent("www/save/file1.rpgsave"),
            engine: "nwjs", gameTitle: "测试",
            outputDir: (root as NSString).appendingPathComponent("out"),
            isRunning: true)

        guard case .failure(.blocked(let block)) = result else {
            Issue.record("应该被拒绝，实际 \(result)"); return
        }
        #expect(block == .running)
    }

    /// ⚠️⚠️ **导入必须精确还原**（破坏后导入能救回来）。
    @Test("导入精确还原")
    func importRestoresExactly() throws {
        let (root, saveDir) = try makeGame(
            saveSubdir: "www/save",
            files: [
                ("file1.rpgsave", "原始内容1"),
                ("file2.rpgsave", "原始内容2"),
                ("lastsave.autobak", "原始备份"),
            ])
        defer { try? FileManager.default.removeItem(atPath: root) }

        // ① 导出
        let outDir = (root as NSString).appendingPathComponent("out")
        let exported = try SaveArchiveIO.export(
            gamePath: (saveDir as NSString).appendingPathComponent("file1.rpgsave"),
            engine: "nwjs", gameTitle: "测试",
            outputDir: outDir, isRunning: false).get()

        // ② 破坏源存档
        for name in ["file1.rpgsave", "file2.rpgsave", "lastsave.autobak"] {
            try "被破坏了".write(
                to: URL(fileURLWithPath: (saveDir as NSString).appendingPathComponent(name)),
                atomically: true, encoding: .utf8)
        }

        // ③ 导入
        let imported = try SaveArchiveIO.importArchive(
            archivePath: exported.archivePath,
            gamePath: (saveDir as NSString).appendingPathComponent("file1.rpgsave"),
            engine: "nwjs").get()

        #expect(imported.files.count == 3)
        #expect(imported.backups.count == 3, "每个被覆盖的文件都该有备份")

        // ④ 核对内容**精确还原**
        let fm = FileManager.default
        #expect(fm.contents(atPath: (saveDir as NSString).appendingPathComponent("file1.rpgsave"))
            .map { String(data: $0, encoding: .utf8) } == "原始内容1")
        #expect(fm.contents(atPath: (saveDir as NSString).appendingPathComponent("lastsave.autobak"))
            .map { String(data: $0, encoding: .utf8) } == "原始备份")

        // ⑤ 备份里是**被覆盖之前**的内容（不是导入后的）
        let backupPath = (saveDir as NSString)
            .appendingPathComponent("file1.rpgsave.tsumigeya-bak")
        #expect(fm.contents(atPath: backupPath)
            .map { String(data: $0, encoding: .utf8) } == "被破坏了",
            "备份内容应该是覆盖前的，不是导入后的")
    }

    /// ⚠️ **备份幂等**：第二次导入不覆盖已有备份。
    @Test("备份幂等")
    func backupIdempotent() throws {
        let (root, saveDir) = try makeGame(
            saveSubdir: "www/save", files: [("file1.rpgsave", "原始")])
        defer { try? FileManager.default.removeItem(atPath: root) }

        let outDir = (root as NSString).appendingPathComponent("out")
        let gamePath = (saveDir as NSString).appendingPathComponent("file1.rpgsave")
        let exported = try SaveArchiveIO.export(
            gamePath: gamePath, engine: "nwjs", gameTitle: "测试",
            outputDir: outDir, isRunning: false).get()

        // 第一次导入
        let first = try SaveArchiveIO.importArchive(
            archivePath: exported.archivePath,
            gamePath: gamePath, engine: "nwjs").get()
        #expect(first.backups.count == 1)

        // 第二次导入 → 备份已存在 → 不该再产生新备份
        let second = try SaveArchiveIO.importArchive(
            archivePath: exported.archivePath,
            gamePath: gamePath, engine: "nwjs").get()
        #expect(second.backups.isEmpty, "已有备份不该被再次覆盖（否则回退意义没了）")
    }

    /// ⚠️ **篡改包内文件 → 校验失败，一个字节都不写**。
    @Test("校验失败不写盘")
    func checksumMismatchWritesNothing() throws {
        let (root, saveDir) = try makeGame(
            saveSubdir: "www/save", files: [("file1.rpgsave", "原始")])
        defer { try? FileManager.default.removeItem(atPath: root) }

        let outDir = (root as NSString).appendingPathComponent("out")
        let gamePath = (saveDir as NSString).appendingPathComponent("file1.rpgsave")
        let exported = try SaveArchiveIO.export(
            gamePath: gamePath, engine: "nwjs", gameTitle: "测试",
            outputDir: outDir, isRunning: false).get()

        // 篡改：把 zip 里 saves/file1.rpgsave 的内容换掉，manifest 不变
        try tamperArchive(exported.archivePath, entry: "saves/file1.rpgsave",
                          newContent: [UInt8]("篡改过的".utf8))

        // 导入 → 必须校验失败
        let result = SaveArchiveIO.importArchive(
            archivePath: exported.archivePath, gamePath: gamePath, engine: "nwjs")
        guard case .failure(.checksumMismatch(let file)) = result else {
            Issue.record("应该校验失败，实际 \(result)"); return
        }
        #expect(file == "file1.rpgsave")

        // ⚠️ 源文件必须**原封不动**（校验不过就一个字节都不写）
        let content = FileManager.default.contents(
            atPath: (saveDir as NSString).appendingPathComponent("file1.rpgsave"))
        #expect(content.map { String(data: $0, encoding: .utf8) } == "原始")
    }

    /// 不是我们的包 → 明确拒绝。
    @Test("拒绝别人的 zip")
    func rejectsForeignArchive() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-foreign-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let fakeZip = dir.appendingPathComponent("fake.zip").path
        // 一个只有 saves/ 但没有 manifest.json 的包
        let entries = [ZipWriter.Entry(path: "saves/x.txt", data: [1, 2, 3])]
        _ = ZipWriter.write(entries: entries, to: fakeZip)

        let result = SaveArchiveIO.importArchive(
            archivePath: fakeZip,
            gamePath: "/games/nothing/Game.exe", engine: "nwjs")
        guard case .failure(.notOurArchive) = result else {
            Issue.record("应该拒绝，实际 \(result)"); return
        }
    }

    // MARK: - 辅助

    func readManifest(from archivePath: String) throws -> SaveManifest {
        let temp = (NSTemporaryDirectory() as NSString)
            .appendingPathComponent("tsmg-read-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(atPath: temp) }
        _ = SaveZip.extract(archive: archivePath, to: temp)
        let path = (temp as NSString)
            .appendingPathComponent(SaveArchive.manifestPath)
        guard let data = FileManager.default.contents(atPath: path),
              let json = try? JSONDecoder().decode(JSONValue.self, from: data),
              let manifest = SaveManifestParser.parse(json) else {
            throw SaveArchiveError.notOurArchive
        }
        return manifest
    }

    /// 篡改 zip 里某个条目的内容（重写整个包，manifest 保持不变）。
    func tamperArchive(_ path: String, entry target: String, newContent: [UInt8]) throws {
        let temp = (NSTemporaryDirectory() as NSString)
            .appendingPathComponent("tsmg-tamper-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(atPath: temp) }
        _ = SaveZip.extract(archive: path, to: temp)

        // 读所有文件原样，只换目标那个
        let fm = FileManager.default
        let savesDir = (temp as NSString).appendingPathComponent("saves")
        let names = (try? fm.contentsOfDirectory(atPath: savesDir)) ?? []

        var entries: [ZipWriter.Entry] = []
        // manifest 原样
        let manifestPath = (temp as NSString).appendingPathComponent(SaveArchive.manifestPath)
        if let data = fm.contents(atPath: manifestPath) {
            entries.append(ZipWriter.Entry(
                path: SaveArchive.manifestPath, data: [UInt8](data)))
        }
        for name in names {
            let full = (savesDir as NSString).appendingPathComponent(name)
            let zipPath = "saves/\(name)"
            if zipPath == target {
                entries.append(ZipWriter.Entry(path: zipPath, data: newContent))
            } else if let data = fm.contents(atPath: full) {
                entries.append(ZipWriter.Entry(path: zipPath, data: [UInt8](data)))
            }
        }
        _ = ZipWriter.write(entries: entries, to: path)
    }
}
