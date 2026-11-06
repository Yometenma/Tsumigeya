// 存档的导出与导入（**两条路径的判据都在这里**）。
//
// 对应 Electron 版：`src/main/save-archive-io.ts`（305 行）+ save-store 的写盘部分
// 契约：M4 S3/S4，D81 / D82 / D86
//
// ===== ⚠️⚠️ 导入的顺序铁律（这条是本案最重要的东西）=====
//
// **先校验 sha256 → 再备份 → 才写**
//
// 为什么顺序不能变：
//   写与备份的交界处出事（磁盘满 / 断电 / 用户强杀）：
//     · **先备份**的最坏结果：只是「没导进来」—— 原来的存档完好
//     • **先写**的最坏结果：**半新半旧，既不能玩也不能回退**
//
//   而存档是**不可再生的用户数据**（游戏里几十小时的进度），
//   我们没有解析它的能力，也就没有修复它的能力。
//
// ===== 备份幂等 =====
//
// 已有 `.tsumigeya-bak` **不覆盖**。
//
// ⚠️ 为什么：第二次导入时，如果覆盖备份，那个"备份"里的内容就变成了
//    **「导入后的版本」**，而不是用户原本的存档 —— 备份失去回退意义，
//    而用户会以为「我有备份啊」。
import Foundation

public enum SaveArchiveError: Error, Sendable, Equatable {
    case blocked(ExportBlock)
    case noFilesToExport
    case writeFailed(String)
    case zipFailed(String)
    case notOurArchive
    case checksumMismatch(file: String)
    case nothingToImport
    case readFailed(String)

    public var message: String {
        switch self {
        case .blocked(let block): return block.message
        case .noFilesToExport: return "存档目录里没有可导出的文件。"
        case .writeFailed(let s): return "写入失败：\(s)"
        case .zipFailed(let s): return "打包失败：\(s)"
        case .notOurArchive:
            return "这个 zip 不是 Tsumigeya 的存档包（缺少 manifest.json 或格式不对）。"
        case .checksumMismatch(let f):
            return "文件校验失败（内容与清单不符）：\(f)。包可能在传输中损坏了。"
        case .nothingToImport: return "包里没有任何存档文件。"
        case .readFailed(let s): return "读取失败：\(s)"
        }
    }
}

// MARK: - 导出

public struct ExportResult: Sendable {
    /// 生成的包路径。
    public let archivePath: String
    /// 打包了多少个文件。
    public let fileCount: Int
    /// 总字节数。
    public let totalBytes: Int64
}

public enum SaveArchiveIO {

    /// 导出存档到 zip。
    ///
    /// - Parameters:
    ///   - gamePath: 游戏的 gamePath
    ///   - engine: 引擎 folder
    ///   - gameTitle: 游戏标题（写进 manifest，也是文件名的一部分）
    ///   - outputDir: 输出目录
    ///   - isRunning: 游戏是否在运行（**运行中禁止导出**，D82）
    ///   - fileManager: 注入用
    ///
    /// - Returns: 成功返回结果；失败返回错误
    public static func export(
        gamePath: String, engine: String, gameTitle: String,
        outputDir: String, isRunning: Bool,
        at date: Date = Date(),
        fileManager: FileManager = .default
    ) -> Result<ExportResult, SaveArchiveError> {

        // ① 先探测存档位置
        let listing = SaveStore.list(
            gamePath: gamePath, engine: engine, fileManager: fileManager)

        // ② 判阻断（**顺序很重要**：先判运行再判位置，见 `SaveExportPolicy`）
        if let block = SaveExportPolicy.blocked(
            running: isRunning,
            hasLocation: listing.dir != nil,
            empty: !listing.hasSaves) {
            return .failure(.blocked(block))
        }
        guard let saveDir = listing.dir else {
            return .failure(.blocked(.noLocation))
        }

        // ③ 收集要打包的文件
        //
        // ⚠️ **打整个目录**（D81），不是只打槽 —— 插件写的
        //    `lastsave.autobak` / `sync_data.rpgsave` 也是存档数据。
        let entries: [String]
        do {
            entries = try fileManager.contentsOfDirectory(atPath: saveDir)
        } catch {
            return .failure(.readFailed(error.localizedDescription))
        }

        var files: [(name: String, data: [UInt8], modified: Date?)] = []
        for name in entries.sorted() {
            // ⚠️ 跳过点开头的系统噪音（D86）
            if SaveExportPolicy.isNoiseFile(name) { continue }
            let full = (saveDir as NSString).appendingPathComponent(name)
            var isDir: ObjCBool = false
            guard fileManager.fileExists(atPath: full, isDirectory: &isDir),
                  !isDir.boolValue else { continue }
            guard let data = fileManager.contents(atPath: full) else { continue }
            let attrs = try? fileManager.attributesOfItem(atPath: full)
            files.append((
                name: name,
                data: [UInt8](data),
                modified: attrs?[.modificationDate] as? Date
            ))
        }

        guard !files.isEmpty else { return .failure(.noFilesToExport) }

        // ④ 算 sha256 并组 manifest
        let manifestEntries = files.map { file in
            SaveManifest.FileEntry(
                name: file.name,
                sha256: SHA256.hex(file.data))
        }
        let manifest = SaveManifest(
            gameTitle: gameTitle,
            engine: engine,
            layout: layoutName(saveDir: saveDir, engine: engine),
            exportedAt: isoString(date),
            files: manifestEntries)

        // ⑤ 组 zip 条目（manifest.json + saves/...）
        var zipEntries: [ZipWriter.Entry] = [
            ZipWriter.Entry(
                path: SaveArchive.manifestPath,
                data: manifestBytes(manifest),
                modified: date),
        ]
        for file in files {
            zipEntries.append(ZipWriter.Entry(
                path: "\(SaveArchive.filesPrefix)\(file.name)",
                data: file.data,
                modified: file.modified))
        }

        // ⑥ 输出路径
        do {
            try fileManager.createDirectory(
                atPath: outputDir, withIntermediateDirectories: true)
        } catch {
            return .failure(.writeFailed(error.localizedDescription))
        }
        let archiveName = SaveArchiveName.archiveFileName(title: gameTitle, at: date)
        let archivePath = (outputDir as NSString).appendingPathComponent(archiveName)

        // ⑦ 写 zip
        if let error = ZipWriter.write(entries: zipEntries, to: archivePath) {
            return .failure(.zipFailed(error))
        }

        let totalBytes = files.reduce(Int64(0)) { $0 + Int64($1.data.count) }
        return .success(ExportResult(
            archivePath: archivePath,
            fileCount: files.count,
            totalBytes: totalBytes))
    }

    // MARK: - 导入

    public struct ImportResult: Sendable {
        /// 恢复了多少个文件。
        public let files: [String]
        /// 备份出来的文件名（`<原名>.tsumigeya-bak`）—— 用户想回退时找得到。
        public let backups: [String]
    }

    /// 从 zip 导入存档。
    ///
    /// ⚠️ **顺序铁律：先校验 → 再备份 → 才写**（见文件头）。
    ///
    /// - Parameters:
    ///   - archivePath: 存档包路径
    ///   - gamePath: 游戏的 gamePath
    ///   - engine: 引擎 folder
    ///   - fileManager: 注入用
    public static func importArchive(
        archivePath: String, gamePath: String, engine: String,
        fileManager: FileManager = .default
    ) -> Result<ImportResult, SaveArchiveError> {

        // ① 解到临时目录（**先不动用户的存档**）
        let temp = (NSTemporaryDirectory() as NSString)
            .appendingPathComponent("tsmg-import-\(UUID().uuidString)")
        defer { try? fileManager.removeItem(atPath: temp) }

        if let error = SaveZip.extract(archive: archivePath, to: temp, fileManager: fileManager) {
            return .failure(.readFailed(error))
        }

        // ② 读 manifest
        let manifestPath = (temp as NSString).appendingPathComponent(SaveArchive.manifestPath)
        guard let raw = fileManager.contents(atPath: manifestPath),
              let json = try? JSONDecoder().decode(JSONValue.self, from: raw),
              let manifest = SaveManifestParser.parse(json) else {
            return .failure(.notOurArchive)
        }

        guard !manifest.files.isEmpty else { return .failure(.nothingToImport) }

        // ③ **校验全部文件的 sha256**（一个字节都不写之前完成）
        var verified: [(name: String, data: [UInt8])] = []
        for entry in manifest.files {
            let path = (temp as NSString).appendingPathComponent(
                "\(SaveArchive.filesPrefix)\(entry.name)")
            guard let data = fileManager.contents(atPath: path) else {
                return .failure(.readFailed("包里缺少文件：\(entry.name)"))
            }
            let actual = SHA256.hex([UInt8](data))
            guard actual == entry.sha256 else {
                return .failure(.checksumMismatch(file: entry.name))
            }
            verified.append((entry.name, [UInt8](data)))
        }

        // ④ 确定目标目录
        let listing = SaveStore.list(
            gamePath: gamePath, engine: engine, fileManager: fileManager)
        guard let saveDir = listing.dir else {
            return .failure(.blocked(.noLocation))
        }
        do {
            try fileManager.createDirectory(
                atPath: saveDir, withIntermediateDirectories: true)
        } catch {
            return .failure(.writeFailed(error.localizedDescription))
        }

        // ⑤ **备份现有文件**（幂等：已有备份不覆盖）
        var backups: [String] = []
        for entry in verified {
            let target = (saveDir as NSString).appendingPathComponent(entry.name)
            let backup = target + SaveArchive.backupSuffix
            // ⚠️ 已有备份 → 跳过（见文件头：覆盖会毁掉回退意义）
            if fileManager.fileExists(atPath: backup) { continue }
            if fileManager.fileExists(atPath: target) {
                if (try? fileManager.copyItem(atPath: target, toPath: backup)) != nil {
                    backups.append((backup as NSString).lastPathComponent)
                }
            }
        }

        // ⑥ **才写**
        var written: [String] = []
        for entry in verified {
            let target = (saveDir as NSString).appendingPathComponent(entry.name)
            do {
                try Data(entry.data).write(to: URL(fileURLWithPath: target))
                written.append(entry.name)
            } catch {
                return .failure(.writeFailed("\(entry.name)：\(error.localizedDescription)"))
            }
        }

        return .success(ImportResult(files: written, backups: backups))
    }

    // MARK: - 辅助

    /// manifest 编码成字节。
    static func manifestBytes(_ manifest: SaveManifest) -> [UInt8] {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(SaveManifestParser.encode(manifest)) else {
            return []
        }
        return [UInt8](data)
    }

    /// 布局名（写进 manifest，导入端据此判断是否同一个布局）。
    ///
    /// ⚠️ **不解析存档内容**，只看目录路径的形态：
    ///    `…/www/save` → `nwjs-mv`；`…/save` → `nwjs-mz`；`…/Data` → `rgss-data`
    static func layoutName(saveDir: String, engine: String) -> String {
        let lower = saveDir.lowercased()
        switch engine {
        case "nwjs":
            if lower.contains("/www/save") { return "nwjs-mv" }
            return "nwjs-mz"
        case "mkxpz":
            if lower.hasSuffix("/data") { return "rgss-data" }
            if lower.hasSuffix("/save") { return "rgss-save" }
            return "rgss-root"
        case "easyrpg":
            return "easyrpg-save"
        case "renpy":
            return "renpy-external"
        default:
            return engine
        }
    }

    /// ISO 8601 时刻。
    static func isoString(_ date: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f.string(from: date)
    }
}
