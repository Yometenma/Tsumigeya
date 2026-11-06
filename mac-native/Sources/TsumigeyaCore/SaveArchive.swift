// 存档导出包的格式（**纯数据 + 纯判据**）。
//
// 对应 Electron 版：`src/shared/save-archive.ts`（248 行 / 39 条单测）
// 契约：M4 S3/S4，D81（打整个目录）/ D82（运行中禁止）/ D86（点开头跳过）
//
// ===== 三条判据，每条都有过真 bug 撑着 =====
//
// ① **打「整个存档目录」，不是只打槽**（D81）
//    用户真机 `Karryn's Prison/www/save/` 里有 `lastsave.autobak` /
//    `sync_data.rpgsave` —— 那是**游戏插件写的**，也是存档数据。
//    只打 `file*.rpgsave` 会让用户换机后少东西，而他不会怀疑「包少了」。
//
// ② **运行中禁止导出**（D82）
//    游戏正在写存档时读出来是**半截文件**（头对、尾缺）。
//    用户带着它换机，导入后游戏报存档损坏 —— 而他想不到问题出在「当初没关游戏」。
//    这类故障**没有自愈余地**（我们不解析也不修存档）。
//
// ③ **点开头文件跳过**（D86）
//    `._file1.rpgsave` 是 macOS 的 AppleDouble（163 字节元数据镜像），
//    跨机后是垃圾。而且它会**命中槽判据** → 列表里多一个幽灵存档。
//
// ⚠️ 判据**只排除「点开头」**，绝不按扩展名白名单收窄 ——
//    那正是 D81 拒绝的做法。
import Foundation

// MARK: - 包内清单

/// 导出包里 `manifest.json` 的内容。
public struct SaveManifest: Sendable, Equatable {
    /// 游戏标题（用户库里的，不是 DLsite 的）。
    public var gameTitle: String
    /// 引擎模块名（nwjs / mkxpz / easyrpg / renpy）。
    public var engine: String
    /// 布局类别（`nwjs-mv` / `nwjs-mz` / `rgss-data` / ...）。
    public var layout: String
    /// 导出时刻（ISO 8601）。
    public var exportedAt: String
    /// 打包进去的**每一个**文件（含槽、配置、插件文件）。
    ///
    /// ⚠️ `name` 是**包内相对 `saves/` 的文件名**，不是绝对路径。
    ///    `sha256` 是小写十六进制 64 位。
    ///
    /// ⚠️ 这里**不收子目录**：存档目录是平铺的（实测 Karryn's Prison 的
    ///    `www/save/` 全是平铺文件）。真遇到子目录就整体跳过并在结果里报出来，
    ///    **而不是悄悄少带一个**。
    public var files: [FileEntry]

    public struct FileEntry: Sendable, Equatable {
        public let name: String
        public let sha256: String

        public init(name: String, sha256: String) {
            self.name = name
            self.sha256 = sha256
        }
    }

    public init(
        gameTitle: String, engine: String, layout: String,
        exportedAt: String, files: [FileEntry]
    ) {
        self.gameTitle = gameTitle
        self.engine = engine
        self.layout = layout
        self.exportedAt = exportedAt
        self.files = files
    }
}

// MARK: - 常量

public enum SaveArchive {
    /// manifest 的格式版本（将来改结构时用它分辨旧包）。
    public static let manifestVersion = 1

    /// 包内 manifest 的路径（固定）。
    public static let manifestPath = "manifest.json"

    /// 包内存档目录的路径前缀（固定）。
    public static let filesPrefix = "saves/"

    /// 导出包的扩展名（`.zip`，mac 上双击就能看内容）。
    public static let archiveExt = ".zip"

    /// 备份后缀（沿用 `Game.ini.tsumigeya-bak` 的既有约定，D71 起同一个后缀）。
    public static let backupSuffix = ".tsumigeya-bak"
}

// MARK: - 导出阻断

/// 能不能导出。
public enum ExportBlock: Sendable, Equatable {
    /// 游戏正在运行：导出的包可能是半截文件，换机会丢档。
    case running
    /// 找不到存档位置（什么都没打包）。
    case noLocation
    /// 位置找到了但目录里一个文件都没有（还没存过档）。
    case empty

    /// 给用户看的说明。
    ///
    /// ⚠️ **三条必须分开说** —— 它们要用户做的事完全不同：
    ///    · `running`    → 「去关掉游戏」（现在就能解决）
    ///    · `noLocation` → 「去排障 / 这个引擎还不支持」（要去查）
    ///    · `empty`      → 「先玩到存档点」（正常状态）
    ///
    /// 混成一句「不能导出」会让用户不知道下一步干什么。
    public var message: String {
        switch self {
        case .running:
            return "游戏正在运行，请先关掉游戏再导出。"
                + "运行中的存档可能正在写，导出的包会是**半截文件** —— "
                + "带着它换机会丢档。"
        case .noLocation:
            return "找不到这个游戏的存档目录。可能是引擎的存档位置还没实现，"
                + "或者游戏目录结构不常见。"
        case .empty:
            return "这个游戏的存档目录是空的 —— 先去游戏里存一次档，再回来导出。"
        }
    }
}

// MARK: - 阻断判据

public enum SaveExportPolicy {

    /// 能不能导出（**运行中一律禁止**，D82 的硬要求）。
    ///
    /// ⚠️ **判定顺序很重要**：先判运行，再判位置。
    ///
    ///    反过来会让一个**正在跑**的游戏显示「找不到存档」，
    ///    用户就去查目录了 —— 而真正的问题是「关掉游戏」。
    ///    这个顺序错误**不会崩溃**，只会让人查错方向。
    @discardableResult
    public static func blocked(
        running: Bool, hasLocation: Bool, empty: Bool
    ) -> ExportBlock? {
        if running { return .running }
        if !hasLocation { return .noLocation }
        if empty { return .empty }
        return nil
    }

    /// 这个文件名是不是**系统噪音**（不该打进导出包）。
    ///
    /// ⚠️ 判据**只排除「点开头」**，不按扩展名白名单收窄（见文件头）。
    public static func isNoiseFile(_ name: String) -> Bool {
        name.hasPrefix(".")
    }
}

// MARK: - 文件名清洗

public enum SaveArchiveName {

    /// 把游戏标题洗成**文件系统安全**的片段。
    ///
    /// 规则（每条都有单测）：
    ///   · 非法字符 `/ \ : * ? " < > |` → `_`
    ///     （Windows 上 `:` 会让创建文件直接失败）
    ///   · 控制字符（\u0000-\u001f）→ 去掉
    ///   · 首尾空白与点 → 去掉（`.` 开头的文件名在有些工具里行为诡异）
    ///   · 空白 → `-`（包名常被贴进命令行/聊天框，空格会被截断）
    ///   · 过长截断到 60 个字符（各平台都接受，访达里也看得全）
    ///   · 洗完是空的（比如标题全是中文标点）→ 用 `game`
    ///
    /// ⚠️ **刻意保留中文**：用户的游戏名大多是中文，洗成拼音或 ASCII
    ///    反而认不出来。UTF-8 文件名在 mac / Windows 现代版本都没问题。
    public static func safePart(_ title: String?) -> String {
        guard let title, !title.isEmpty else { return "game" }

        // ① 非法字符 → 下划线；② 控制字符去掉
        let illegal = CharacterSet(charactersIn: "/\\:*?\"<>|")
        var buffer = ""
        for scalar in title.unicodeScalars {
            if illegal.contains(scalar) {
                buffer.append("_")
            } else if scalar.value >= 0x20 && scalar.value != 0x7F {
                // 保留可打印字符（控制字符直接丢掉）
                buffer.unicodeScalars.append(scalar)
            }
            // 控制字符 → 什么都不加（等价于去掉）
        }
        var cleaned = buffer

        // ③ 空白 → 连字符
        //
        // ⚠️ 用正则而不是 `components(separatedBy: .whitespaces)` ——
        //    后者会把连续空白拆成多个空串，重组时又要处理，反而更绕。
        cleaned = cleaned.replacingOccurrences(
            of: "\\s+", with: "-", options: .regularExpression)

        // ④ 首尾的点与连字符去掉
        cleaned = cleaned.trimmingCharacters(
            in: CharacterSet(charactersIn: ".-").union(.whitespaces))

        // ⑤ 过长截断（按**字符**不是字节 —— 中文一个字算一个）
        if cleaned.count > 60 {
            cleaned = String(cleaned.prefix(60))
        }

        // ⑥ 洗空了 → 兜底
        return cleaned.isEmpty ? "game" : cleaned
    }

    /// 生成导出包的文件名（`<标题>-<时间戳>.zip`）。
    public static func archiveFileName(title: String?, at date: Date) -> String {
        "\(safePart(title))-\(timestamp(date))\(SaveArchive.archiveExt)"
    }

    /// 时间戳（`20261106-0755` 这种，文件名安全且按名字排序就是按时间）。
    public static func timestamp(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone.current
        f.dateFormat = "yyyyMMdd-HHmm"
        return f.string(from: date)
    }
}

// MARK: - manifest 解析（导入端）

public enum SaveManifestParser {

    /// 解析 `manifest.json` 的原文。
    ///
    /// - Returns: 解析结果；`nil` = **不是我们的包**（或缺字段）。
    ///
    /// ⚠️ 判据**必须严格**：调用方按「拒绝」处理，
    ///    **不要**去猜缺了什么再试着补 —— 猜错了就是拿用户的存档冒险。
    ///
    /// ⚠️ 导出端与导入端**用同一份结构**（就是本文件）：
    ///    分成两处各写一半的话，漂移的表现是「自己导出的包自己拒收」。
    public static func parse(_ raw: JSONValue?) -> SaveManifest? {
        guard let obj = raw?.objectValue else { return nil }

        guard let title = obj["gameTitle"]?.stringValue, !title.isEmpty else { return nil }
        guard let engine = obj["engine"]?.stringValue, !engine.isEmpty else { return nil }
        guard let layout = obj["layout"]?.stringValue else { return nil }
        guard let exportedAt = obj["exportedAt"]?.stringValue else { return nil }
        guard let filesRaw = obj["files"]?.arrayValue else { return nil }

        var files: [SaveManifest.FileEntry] = []
        for entry in filesRaw {
            guard let item = entry.objectValue else { return nil }
            guard let name = item["name"]?.stringValue, !name.isEmpty else { return nil }
            guard let sha = item["sha256"]?.stringValue, isSha256Hex(sha) else { return nil }
            files.append(SaveManifest.FileEntry(name: name, sha256: sha))
        }

        return SaveManifest(
            gameTitle: title, engine: engine, layout: layout,
            exportedAt: exportedAt, files: files)
    }

    /// sha256 文本的形状（小写十六进制 64 位）。
    ///
    /// ⚠️ **必须校验形状**：sha256 是用来防「文件被改过」的，
    ///    如果接受任意字符串，那个防线就等于不存在（`"aaa"` 也能「匹配」）。
    public static func isSha256Hex(_ value: String) -> Bool {
        guard value.count == 64 else { return false }
        return value.unicodeScalars.allSatisfy { scalar in
            (0x30...0x39).contains(scalar.value)      // 0-9
                || (0x61...0x66).contains(scalar.value) // a-f（**小写**）
        }
    }

    /// manifest 转成 JSON（导出端写）。
    public static func encode(_ manifest: SaveManifest) -> JSONValue {
        .object([
            "gameTitle": .string(manifest.gameTitle),
            "engine": .string(manifest.engine),
            "layout": .string(manifest.layout),
            "exportedAt": .string(manifest.exportedAt),
            "files": .array(manifest.files.map { entry in
                .object(["name": .string(entry.name), "sha256": .string(entry.sha256)])
            }),
        ])
    }
}
