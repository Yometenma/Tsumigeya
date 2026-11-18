import Foundation
import Testing

@testable import TsumigeyaCore

private final class FailingSaveBackupFileManager: FileManager, @unchecked Sendable {
    override func copyItem(atPath srcPath: String, toPath dstPath: String) throws {
        if dstPath.hasSuffix("file2.rpgsave" + SaveArchive.backupSuffix) {
            throw CocoaError(.fileWriteNoPermission)
        }
        try super.copyItem(atPath: srcPath, toPath: dstPath)
    }
}

@Suite("存档导入安全性（真实 zip）")
struct SaveImportSafetyTests {
    private let originals: [(String, [UInt8])] = [
        ("file1.rpgsave", [0, 255, 1, 128, 10]),
        ("file2.rpgsave", [254, 0, 13, 10, 99]),
    ]
    private let incoming: [(String, [UInt8])] = [
        ("file1.rpgsave", [1, 2, 3]),
        ("file2.rpgsave", [4, 5, 6]),
    ]

    private func makeGame() throws -> URL {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-import-safety-\(UUID().uuidString)")
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent("www/save"), withIntermediateDirectories: true)
        try Data(#"{"main":"www/index.html"}"#.utf8)
            .write(to: root.appendingPathComponent("package.json"))
        for (name, bytes) in originals {
            try Data(bytes).write(to: root.appendingPathComponent("www/save/" + name))
        }
        return root
    }

    private func makeArchive(
        root: URL, files: [(String, [UInt8])],
        manifestEntries: [SaveManifest.FileEntry]? = nil
    ) throws -> String {
        let manifest = SaveManifest(
            gameTitle: "安全测试", engine: "nwjs", layout: "nwjs-mv", exportedAt: "t",
            files: manifestEntries ?? files.map { .init(name: $0.0, sha256: SHA256.hex($0.1)) })
        var entries = [ZipWriter.Entry(
            path: SaveArchive.manifestPath, data: SaveArchiveIO.manifestBytes(manifest))]
        entries += files.map { ZipWriter.Entry(path: "saves/" + $0.0, data: $0.1) }
        let path = root.appendingPathComponent("import.zip").path
        let error = ZipWriter.write(entries: entries, to: path)
        #expect(error == nil)
        if let error { throw SaveArchiveError.zipFailed(error) }
        return path
    }

    private func importArchive(
        _ path: String, root: URL, fileManager: FileManager = .default
    ) -> Result<SaveArchiveIO.ImportResult, SaveArchiveError> {
        SaveArchiveIO.importArchive(
            archivePath: path,
            gamePath: root.appendingPathComponent("www/save/file1.rpgsave").path,
            engine: "nwjs", fileManager: fileManager)
    }

    private func expectOriginalsUnchanged(root: URL) throws {
        for (name, bytes) in originals {
            let actual = try Data(contentsOf: root.appendingPathComponent("www/save/" + name))
            #expect(actual == Data(bytes), "原存档必须逐字节不变：\(name)")
        }
    }

    @Test("第二个备份复制失败时所有原存档逐字节不变")
    func backupFailureWritesNothing() throws {
        let root = try makeGame()
        defer { try? FileManager.default.removeItem(at: root) }
        let path = try makeArchive(root: root, files: incoming)
        let result = importArchive(path, root: root, fileManager: FailingSaveBackupFileManager())
        guard case .failure(.writeFailed) = result else {
            Issue.record("备份失败必须终止导入，实际：\(result)"); return
        }
        try expectOriginalsUnchanged(root: root)
        let firstBackup = root.appendingPathComponent("www/save/file1.rpgsave" + SaveArchive.backupSuffix)
        #expect(try Data(contentsOf: firstBackup) == Data(originals[0].1))
        #expect(!FileManager.default.fileExists(atPath:
            root.appendingPathComponent("www/save/file2.rpgsave" + SaveArchive.backupSuffix).path))
    }

    @Test("最后一个文件校验失败前不允许备份或写入")
    func allHashesBeforeAnyBackup() throws {
        let root = try makeGame()
        defer { try? FileManager.default.removeItem(at: root) }
        let entries = [
            SaveManifest.FileEntry(name: incoming[0].0, sha256: SHA256.hex(incoming[0].1)),
            SaveManifest.FileEntry(name: incoming[1].0, sha256: SHA256.hex([99])),
        ]
        let path = try makeArchive(root: root, files: incoming, manifestEntries: entries)
        let result = importArchive(path, root: root)
        guard case .failure(.checksumMismatch(file: "file2.rpgsave")) = result else {
            Issue.record("应拒绝最后一个文件的错误 hash，实际：\(result)"); return
        }
        try expectOriginalsUnchanged(root: root)
        for (name, _) in originals {
            #expect(!FileManager.default.fileExists(atPath:
                root.appendingPathComponent("www/save/" + name + SaveArchive.backupSuffix).path))
        }
    }

    @Test("备份路径已是目录时拒绝，先前文件也不能写入")
    func backupDirectoryIsRejected() throws {
        let root = try makeGame()
        defer { try? FileManager.default.removeItem(at: root) }
        let backup = root.appendingPathComponent("www/save/file2.rpgsave" + SaveArchive.backupSuffix)
        try FileManager.default.createDirectory(at: backup, withIntermediateDirectories: false)
        let path = try makeArchive(root: root, files: incoming)
        guard case .failure(.writeFailed) = importArchive(path, root: root) else {
            Issue.record("目录不能充当合法备份"); return
        }
        try expectOriginalsUnchanged(root: root)
        var isDirectory: ObjCBool = false
        #expect(FileManager.default.fileExists(atPath: backup.path, isDirectory: &isDirectory))
        #expect(isDirectory.boolValue)
    }

    @Test("已有普通文件备份幂等，重复导入不覆盖")
    func existingBackupIsPreserved() throws {
        let root = try makeGame()
        defer { try? FileManager.default.removeItem(at: root) }
        let backup = root.appendingPathComponent("www/save/file1.rpgsave" + SaveArchive.backupSuffix)
        let preserved = Data([88, 0, 255])
        try preserved.write(to: backup)
        let path = try makeArchive(root: root, files: incoming)
        let first = try importArchive(path, root: root).get()
        #expect(first.backups == ["file2.rpgsave" + SaveArchive.backupSuffix])
        let second = try importArchive(path, root: root).get()
        #expect(second.backups.isEmpty)
        #expect(try Data(contentsOf: backup) == preserved)
        for (name, bytes) in incoming {
            #expect(try Data(contentsOf: root.appendingPathComponent("www/save/" + name)) == Data(bytes))
        }
    }

    @Test("拒绝非平铺路径、绝对路径、保留名称及重复名称", arguments: [
        ["../outside.rpgsave"], ["/tmp/outside.rpgsave"], ["nested/file.rpgsave"],
        ["nested\\file.rpgsave"], ["C:\\outside.rpgsave"], ["C:outside.rpgsave"],
        ["."], [".."], [""], ["bad\u{0}name"],
        ["manifest.json"], ["MANIFEST.JSON"], ["file1.rpgsave.tsumigeya-bak"],
        ["file1.rpgsave", "file1.rpgsave"], ["file1.rpgsave", "FILE1.RPGSAVE"],
        ["file1.rpgsave", "file1.rpgsave.tsumigeya-bak"],
    ])
    func unsafeManifestNamesAreRejected(names: [String]) throws {
        let root = try makeGame()
        defer { try? FileManager.default.removeItem(at: root) }
        let outside = root.appendingPathComponent("www/outside.rpgsave")
        let outsideBytes = Data([254, 33, 0, 255])
        try outsideBytes.write(to: outside)
        let entries = names.map { SaveManifest.FileEntry(name: $0, sha256: SHA256.hex([9])) }
        // zip 本身只含安全路径，确保拒绝来自 manifest 校验，而不是解压器。
        let path = try makeArchive(root: root, files: incoming, manifestEntries: entries)
        guard case .failure(.notOurArchive) = importArchive(path, root: root) else {
            Issue.record("危险清单必须作为无效包拒绝：\(names)"); return
        }
        try expectOriginalsUnchanged(root: root)
        #expect(try Data(contentsOf: outside) == outsideBytes)
        for (name, _) in originals {
            #expect(!FileManager.default.fileExists(atPath:
                root.appendingPathComponent("www/save/" + name + SaveArchive.backupSuffix).path))
        }
    }

    @Test("平铺中文名及插件文件可导入")
    func acceptsFlatPluginFiles() throws {
        let root = try makeGame()
        defer { try? FileManager.default.removeItem(at: root) }
        let files: [(String, [UInt8])] = [
            ("中文存档.rpgsave", [1, 255]), ("lastsave.autobak", [2, 0]),
            ("sync_data.rpgsave", [3]),
        ]
        let path = try makeArchive(root: root, files: files)
        let result = try importArchive(path, root: root).get()
        #expect(result.files == files.map { $0.0 })
        for (name, bytes) in files {
            #expect(try Data(contentsOf: root.appendingPathComponent("www/save/" + name)) == Data(bytes))
        }
    }
}
