// 游戏元数据的读写（`library-meta.json` 里的非分类部分）。
//
// 对应 Electron 版：`src/main/library-meta.ts` 的 `saveGameMeta` / `loadGameMeta`
// 契约：D18（元数据**旁挂**，删了游戏照样能启动）/ D26（editedFields 保护）
//       D25（可编辑字段不含 rj）
//
// ===== ⚠️ 这个文件最容易犯的错：把分类抹掉 =====
//
// `library-meta.json` 是**同一份文件装着两样东西**：
//   · 游戏元数据（键 = 数字 gameId）
//   · 分类（键 = `categories` / `assignments`，**非数字**）
//
// 而保存是**整体覆写**。所以写游戏元数据时**必须把非数字键原样带回** ——
// 漏了就等于「改一次 DLsite 信息，用户的分类全没了」。
//
// 这是 S7 实施时踩到的真 bug（Electron 版有回归测试）。
import Foundation

/// 一部游戏的 DLsite 元数据（存在 `library-meta.json[gameId].dlsite`）。
public struct GameDlsiteMeta: Sendable, Equatable, Codable {
    public var work: DlsiteWork
    /// 用户手动改过哪些字段（D26：刷新时不覆盖）。
    public var editedFields: [String]

    public init(work: DlsiteWork, editedFields: [String] = []) {
        self.work = work
        self.editedFields = editedFields
    }

    // ⚠️ 手写 Codable：`DlsiteWork` 本身不是 Codable（它刻意不带，
    //    只有 `CachedWork` 需要磁盘格式）。这里显式展开，
    //    加字段时不会静默改掉磁盘结构。
    enum CodingKeys: String, CodingKey {
        case rj, title, titleSub, circle, coverUrl, workType, ageRating
        case description, fetchedAt, editedFields
        case category, releaseDate, series, tags, languages, sampleImageURLs, creators, voiceActors, supportedSystems
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(work.rj, forKey: .rj)
        try c.encodeIfPresent(work.title, forKey: .title)
        try c.encodeIfPresent(work.titleSub, forKey: .titleSub)
        try c.encodeIfPresent(work.circle, forKey: .circle)
        try c.encodeIfPresent(work.coverUrl, forKey: .coverUrl)
        try c.encodeIfPresent(work.workType, forKey: .workType)
        try c.encodeIfPresent(work.ageRating, forKey: .ageRating)
        try c.encodeIfPresent(work.description, forKey: .description)
        try c.encode(work.fetchedAt, forKey: .fetchedAt)
        try c.encodeIfPresent(work.category, forKey: .category)
        try c.encodeIfPresent(work.releaseDate, forKey: .releaseDate)
        try c.encodeIfPresent(work.series, forKey: .series)
        try c.encode(work.tags, forKey: .tags)
        try c.encode(work.languages, forKey: .languages)
        try c.encode(work.sampleImageURLs, forKey: .sampleImageURLs)
        try c.encode(work.creators, forKey: .creators)
        try c.encode(work.voiceActors, forKey: .voiceActors)
        try c.encodeIfPresent(work.supportedSystems, forKey: .supportedSystems)
        try c.encode(editedFields, forKey: .editedFields)
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.work = DlsiteWork(
            rj: try c.decode(String.self, forKey: .rj),
            title: try c.decodeIfPresent(String.self, forKey: .title),
            titleSub: try c.decodeIfPresent(String.self, forKey: .titleSub),
            circle: try c.decodeIfPresent(String.self, forKey: .circle),
            coverUrl: try c.decodeIfPresent(String.self, forKey: .coverUrl),
            workType: try c.decodeIfPresent(String.self, forKey: .workType),
            ageRating: try c.decodeIfPresent(String.self, forKey: .ageRating),
            description: try c.decodeIfPresent(String.self, forKey: .description),
            fetchedAt: try c.decode(String.self, forKey: .fetchedAt),
            category: try c.decodeIfPresent(String.self, forKey: .category),
            releaseDate: try c.decodeIfPresent(String.self, forKey: .releaseDate),
            series: try c.decodeIfPresent(String.self, forKey: .series),
            tags: try c.decodeIfPresent([String].self, forKey: .tags) ?? [],
            languages: try c.decodeIfPresent([String].self, forKey: .languages) ?? [],
            sampleImageURLs: try c.decodeIfPresent([String].self, forKey: .sampleImageURLs) ?? [],
            creators: try c.decodeIfPresent([String].self, forKey: .creators) ?? [],
            voiceActors: try c.decodeIfPresent([String].self, forKey: .voiceActors) ?? [],
            supportedSystems: try c.decodeIfPresent(String.self, forKey: .supportedSystems))
        self.editedFields = try c.decodeIfPresent(
            [String].self, forKey: .editedFields) ?? []
    }
}

public enum GameMetaStore {

    static let fileName = "library-meta.json"

    /// 本地搜索一次读完整旁挂文件，避免每个候选都重复读同一个文件。
    public static func loadAll(dataDir: String) -> [String: GameDlsiteMeta] {
        readRaw(dataDir: dataDir).compactMapValues { entry in
            guard let dlsite = entry.objectValue?["dlsite"],
                  let data = try? JSONEncoder().encode(dlsite) else { return nil }
            return try? JSONDecoder().decode(GameDlsiteMeta.self, from: data)
        }
    }

    /// 读一部游戏的元数据。
    ///
    /// - Returns: 元数据；没有 / 解析失败返回 nil（**不猜**）
    public static func load(
        dataDir: String, gameId: String, fileManager: FileManager = .default
    ) -> GameDlsiteMeta? {
        let raw = readRaw(dataDir: dataDir, fileManager: fileManager)
        guard let entry = raw[gameId]?.objectValue,
              let dlsiteRaw = entry["dlsite"]?.objectValue else {
            return nil
        }
        // 把 `[String: JSONValue]` 转成 JSON 再解码（复用 Codable 的健壮性）
        guard let data = try? JSONEncoder().encode(JSONValue.object(dlsiteRaw)),
              let meta = try? JSONDecoder().decode(GameDlsiteMeta.self, from: data) else {
            return nil
        }
        return meta
    }

    /// 保存一部游戏的元数据。
    ///
    /// ⚠️⚠️ **必须把非数字键原样带回**（见文件头）。
    ///
    /// - Returns: 写入失败时返回错误说明；成功返回 nil
    @discardableResult
    public static func save(
        dataDir: String, gameId: String, meta: GameDlsiteMeta,
        fileManager: FileManager = .default
    ) -> String? {
        mutationLock.lock()
        defer { mutationLock.unlock() }
        var raw: [String: JSONValue]
        do { raw = try readRawForUpdate(dataDir: dataDir, fileManager: fileManager) }
        catch { return error.localizedDescription }

        // 拿到这个游戏条目（可能是新的）
        var entry = raw[gameId]?.objectValue ?? [:]

        // 序列化 dlsite 部分
        guard let data = try? JSONEncoder().encode(meta),
              let json = try? JSONDecoder().decode(JSONValue.self, from: data) else {
            return "序列化元数据失败"
        }
        // 保留新旧版本扩展字段，同时允许本次清空已知的可选字段。
        var dlsite = entry["dlsite"]?.objectValue ?? [:]
        for key in ["rj", "title", "titleSub", "circle", "coverUrl", "workType",
                    "ageRating", "description", "fetchedAt", "editedFields",
                    "category", "releaseDate", "series", "tags", "languages", "sampleImageURLs", "creators", "voiceActors", "supportedSystems"] {
            dlsite.removeValue(forKey: key)
        }
        dlsite.merge(json.objectValue ?? [:]) { _, new in new }
        entry["dlsite"] = .object(dlsite)
        raw[gameId] = .object(entry)
        // 资料与自动分类共用一次原子写入，不能出现资料已保存但分类未更新。
        LibraryClassification.synchronize(&raw, gameIDs: [gameId])

        // 基于完整原件定点合并；分类之外的顶层键、人工覆盖与未知扩展不丢失。
        return writeRaw(raw, dataDir: dataDir, fileManager: fileManager)
    }

    /// 删一部游戏的元数据（删游戏时调）。
    ///
    /// ⚠️ 只删这个 gameId 的条目，**不动分类**（D31 的精神）。
    @discardableResult
    public static func remove(
        dataDir: String, gameId: String, fileManager: FileManager = .default
    ) -> String? {
        removeData(dataDir: dataDir, gameId: gameId, assignments: false,
                   fileManager: fileManager)
    }

    /// 删游戏时在同一次写入中清理元数据和分类归属，避免 id 复用继承旧分类。
    @discardableResult
    public static func removeGameData(
        dataDir: String, gameId: String, fileManager: FileManager = .default
    ) -> String? {
        removeData(dataDir: dataDir, gameId: gameId, assignments: true,
                   fileManager: fileManager)
    }

    private static func removeData(
        dataDir: String, gameId: String, assignments: Bool, fileManager: FileManager
    ) -> String? {
        mutationLock.lock()
        defer { mutationLock.unlock() }
        var raw: [String: JSONValue]
        do { raw = try readRawForUpdate(dataDir: dataDir, fileManager: fileManager) }
        catch { return error.localizedDescription }
        raw.removeValue(forKey: gameId)
        if assignments, var ids = raw["assignments"]?.objectValue {
            ids.removeValue(forKey: gameId)
            raw["assignments"] = .object(ids)
        }
        return writeRaw(raw, dataDir: dataDir, fileManager: fileManager)
    }

    // MARK: - 原始读写

    // 分类与元数据共享文件，锁必须覆盖整个读改写而不只是最后一次写盘。
    static let mutationLock = NSRecursiveLock()

    static func readRawForUpdate(
        dataDir: String, fileManager: FileManager = .default
    ) throws -> [String: JSONValue] {
        let url = URL(fileURLWithPath: dataDir).appendingPathComponent(fileName)
        guard fileManager.fileExists(atPath: url.path) else { return [:] }
        let data = try Data(contentsOf: url)
        // 已存在的空文件也可能来自中断写入，不能把它当首次运行覆盖。
        return try JSONDecoder().decode([String: JSONValue].self, from: data)
    }

    /// 读整份文件（**保留所有键，包括非数字的**）。
    static func readRaw(
        dataDir: String, fileManager: FileManager = .default
    ) -> [String: JSONValue] {
        let url = URL(fileURLWithPath: dataDir).appendingPathComponent(fileName)
        guard let data = fileManager.contents(atPath: url.path), !data.isEmpty,
              let raw = try? JSONDecoder().decode([String: JSONValue].self, from: data) else {
            return [:]
        }
        return raw
    }

    /// 写整份文件。
    static func writeRaw(
        _ raw: [String: JSONValue], dataDir: String,
        fileManager: FileManager = .default
    ) -> String? {
        let url = URL(fileURLWithPath: dataDir).appendingPathComponent(fileName)
        return JSONStore.save(JSONValue.object(raw), to: url, fileManager: fileManager)
    }
}
