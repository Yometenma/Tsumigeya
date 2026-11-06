// DLsite 元数据的数据模型与**本地判据**（纯函数，零网络）。
//
// 对应 Electron 版：`src/main/dlsite.ts` 的 RJ 部分（`normalizeRj` / `extractRjCandidates`
//                   / `detectRjFromPath`）+ `src/shared/gamecard-info.ts`
// 契约：D18（元数据**旁挂** library-meta.json）/ D19（只解析 contents JSON）/ D24（搜索不自动选）
//       D25（可编辑字段不含 rj）/ D26（editedFields 保护）
//
// ===== 这一层特意与网络抓取分开 =====
//
// RJ 提取与 HTML 解析是**纯字符串操作**，可以 100% 单测；
// 而网络抓取（`DLsiteClient`）依赖真实站点，只能端到端验。
//
// ⚠️ 分开的好处：本鱼可以先证明「从路径/readme 里正确提取 RJ」，
//    再去碰网络 —— 而后者才是最不稳定、最难断言的。
import Foundation

// MARK: - RJ 号

public enum RJNumber {

    /// 校验并规范化 RJ 号。
    ///
    /// 接受 `RJ294126` / `rj294126` / `RJ-294126` / `294126`。
    ///
    /// - Returns: 规范化后的 `RJ<6-8位数字>`；非法返回 nil。
    ///
    /// ⚠️ **6~8 位**：DLsite 的 RJ 号目前是 6 位（如 RJ294126），
    ///    但历史上出现过更长的，留 8 位余量。
    public static func normalize(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        // 允许前缀 RJ/rj 与分隔符（空格 / 连字符 / 下划线）
        let pattern = "^[Rr]?[Jj]?[\\s\\-_]*(\\d{6,8})$"
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let range = NSRange(trimmed.startIndex..<trimmed.endIndex, in: trimmed)
        guard let match = regex.firstMatch(in: trimmed, range: range),
              match.numberOfRanges >= 2,
              let digitsRange = Range(match.range(at: 1), in: trimmed) else {
            return nil
        }
        return "RJ\(trimmed[digitsRange])"
    }

    /// 从任意文本里提取 RJ 号候选（按出现顺序去重）。
    ///
    /// ⚠️ **不加词边界前缀**：`RJ294126` 常紧跟中文或下划线，
    ///    加 `\b` 反而漏掉（`_` 在正则里算单词字符，`RJ294126_作品` 就匹配不到词边界）。
    ///
    /// ⚠️ **尾部必须有 `(?!\d)`**：防止把 `RJ29412699` 截成 `RJ294126`。
    ///    这个负向断言是本文件最容易漏掉的一条 —— 少了它，
    ///    一个 9 位数字会被当成合法的 8 位 RJ。
    public static func candidates(in value: String?) -> [String] {
        guard let value, !value.isEmpty else { return [] }

        let pattern = "[Rr][Jj][\\s\\-_]*(\\d{6,8})(?!\\d)"
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }

        var found: [String] = []
        let ns = value as NSString
        let matches = regex.matches(in: value, range: NSRange(location: 0, length: ns.length))

        for match in matches {
            guard match.numberOfRanges >= 2 else { continue }
            let digits = ns.substring(with: match.range(at: 1))
            let rj = "RJ\(digits)"
            if !found.contains(rj) { found.append(rj) }
        }
        return found
    }

    /// 从游戏路径猜 RJ 号。
    ///
    /// 优先级（§4.6）：
    ///   ① **目录名**（用户多半把游戏解到 `RJ294126 作品名/`）
    ///   ② 路径各段（从最深层往上）
    ///   ③ readme 文件（只读头部若干字节，别整份进内存）
    ///
    /// - Returns: **按优先级排序**的候选。UI 默认取 `[0]`，
    ///   多个不同 RJ 时**让用户选**（不瞎猜，D24 的取向）。
    public static func detectFromPath(
        gamePath: String,
        maxReadmeBytes: Int = 256 * 1024,
        maxReadmeFiles: Int = 4,
        fileManager: FileManager = .default
    ) -> [String] {
        guard !gamePath.trimmingCharacters(in: .whitespaces).isEmpty else { return [] }

        // 路径可能是文件（Game.exe）或目录
        var dir = gamePath
        var isDir: ObjCBool = false
        if fileManager.fileExists(atPath: gamePath, isDirectory: &isDir), !isDir.boolValue {
            dir = (gamePath as NSString).deletingLastPathComponent
        }

        var found: [String] = []
        func consider(_ text: String) {
            for rj in candidates(in: text) where !found.contains(rj) {
                found.append(rj)
            }
        }

        // ① 目录名
        consider((dir as NSString).lastPathComponent)

        // ② 路径各段（从深到浅）
        for segment in dir.components(separatedBy: "/").reversed() where !segment.isEmpty {
            consider(segment)
        }

        // ③ readme（只读头部）
        let readmeFiles = listReadmeFiles(dir: dir, limit: maxReadmeFiles, fm: fileManager)
        for file in readmeFiles {
            let head = readHead(file: file, limit: maxReadmeBytes, fm: fileManager)
            consider(head)
        }

        return found
    }

    /// 列出目录里以 `readme` 开头的文件（大小写不敏感，最多 `limit` 个）。
    static func listReadmeFiles(
        dir: String, limit: Int, fm: FileManager
    ) -> [String] {
        guard let names = try? fm.contentsOfDirectory(atPath: dir) else { return [] }
        var out: [String] = []
        for name in names.sorted() {
            guard name.lowercased().hasPrefix("readme") else { continue }
            let full = (dir as NSString).appendingPathComponent(name)
            var isDir: ObjCBool = false
            guard fm.fileExists(atPath: full, isDirectory: &isDir), !isDir.boolValue else {
                continue
            }
            out.append(full)
            if out.count >= limit { break }
        }
        return out
    }

    /// 只读文件头部若干字节。
    ///
    /// ⚠️ **别整份读**：readme 可能很大（有些是几百 KB 的游戏说明），
    ///    而 RJ 号总在开头附近。整份读进内存是浪费，还可能卡住 UI。
    static func readHead(file: String, limit: Int, fm: FileManager) -> String {
        guard let handle = FileHandle(forReadingAtPath: file) else { return "" }
        defer { try? handle.close() }
        let data = handle.readData(ofLength: limit)
        return String(data: data, encoding: .utf8) ?? ""
    }
}

// MARK: - 元数据

/// DLsite 抓下来的一部作品。
///
/// 对应 Electron 版：`DlsiteWork`
public struct DlsiteWork: Sendable, Equatable {
    /// RJ 号（`RJ294126`）。
    public var rj: String
    /// 完整标题（可能带副标题）。
    public var title: String?
    /// 标题副标题。
    public var titleSub: String?
    /// 社团名。
    public var circle: String?
    /// 封面 URL（**必须已经在 `img.dlsite.jp` 白名单内**，D22）。
    public var coverUrl: String?
    /// 作品类型码（`ADV` / `RPG` / `SLN` ...）。
    public var workType: String?
    /// 年龄分级（`general` / `r18`）。
    public var ageRating: String?
    /// 简介（已清洗）。
    public var description: String?
    /// 抓取时刻（ISO 8601）。
    public var fetchedAt: String

    public init(
        rj: String, title: String? = nil, titleSub: String? = nil,
        circle: String? = nil, coverUrl: String? = nil,
        workType: String? = nil, ageRating: String? = nil,
        description: String? = nil, fetchedAt: String
    ) {
        self.rj = rj
        self.title = title
        self.titleSub = titleSub
        self.circle = circle
        self.coverUrl = coverUrl
        self.workType = workType
        self.ageRating = ageRating
        self.description = description
        self.fetchedAt = fetchedAt
    }
}

/// 用户手动改过的字段（刷新时不覆盖，D26）。
public enum EditedFields {
    /// 哪些字段被用户改过（存成 `[String]`）。
    ///
    /// ⚠️ **`rj` 不在可编辑列表里**（D25）：改 RJ 等于换一部作品，
    ///    那应该重新添加游戏，而不是在编辑页手打。
    public static let editable = [
        "title", "titleSub", "circle", "coverUrl",
        "workType", "ageRating", "description",
    ]

    /// 合并新旧元数据：**被用户改过的字段刷新时不覆盖**。
    ///
    /// 对应 Electron 版：`mergeWork`
    ///
    /// ⚠️ 这是 D26 的核心。用户手改的值属于用户 ——
    ///    刷新元数据（比如重新抓一次）不该把他改过的标题变回去。
    public static func merge(
        old: DlsiteWork?, incoming: DlsiteWork, edited: Set<String>
    ) -> DlsiteWork {
        guard let old else { return incoming }

        var result = incoming
        // 被编辑过的字段 → 沿用旧值
        if edited.contains("title") { result.title = old.title }
        if edited.contains("titleSub") { result.titleSub = old.titleSub }
        if edited.contains("circle") { result.circle = old.circle }
        if edited.contains("coverUrl") { result.coverUrl = old.coverUrl }
        if edited.contains("workType") { result.workType = old.workType }
        if edited.contains("ageRating") { result.ageRating = old.ageRating }
        if edited.contains("description") { result.description = old.description }

        // ⚠️ **RJ 永远以 incoming 为准**（它不可编辑，是作品的唯一标识）
        result.rj = incoming.rj
        return result
    }
}
