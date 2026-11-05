// 数据目录解析。
//
// 对应 Electron 版：src/main/data-dir.ts（resolveDataDirWithFallback）
// 契约：docs/M1-实施方案.md §3.1、D4 / D58
//
// ===== 这里踩过的坑（Electron 版全踩过，原样保留）=====
//
// ① **优先级顺序不能变**：环境变量 > mac 默认 > 回退
//    环境变量优先是为了「开发隔离」：`TSUMIGEYA_DATA_DIR=... npm run dev`
//
// ② **mac 的默认路径是 `~/Library/Application Support/Tsumigeya`**（D58）
//    ⚠️ 不迁移旧的 `Xenolauncher` 目录 —— 迁移要在代码里永久留下旧目录字符串，
//    且只能搬索引、搬不动存档本体（D58 的完整理由）。
//
// ③ **不能靠 `APP_NAME` 自动推**：Electron 版踩过顶层 `app.setName()` 直接 segfault，
//    所以那里改成「显式决定」。Swift 没有这个坑，但「显式」这个取向保留 ——
//    路径不从 Bundle 名推，就是免得改个 productName 数据目录跟着漂。
//
// ④ **目录不可用时要有降级**：Electron 版踩过 Windows `%APPDATA%` 整体 EPERM。
//    mac 上少见，但 `~/Library/Application Support` 在某些沙箱/权限状态下也会拒写。
//    这里的策略：**先建再验**，建不出来就退到 `~/Library/Caches/Tsumigeya`，
//    并把「降级了」这件事**告诉调用方**（不是静默改）。
import Foundation

/// 数据目录解析结果。
///
/// `warning` 非空 = 发生了降级，UI 应该告诉用户（对应 Electron 版的 `dataDirWarning`）。
/// **静默降级是错的**：用户会以为数据在 A，其实在 B，出问题时找不到。
public struct DataDirResolution: Sendable {
    public let path: String
    public let source: Source
    public let warning: DataDirWarning?

    public enum Source: String, Sendable {
        case environment
        case userDefault
        case fallback
    }

    public struct DataDirWarning: Sendable {
        public let requested: String
        public let switchedTo: String
        public let code: String
    }
}

public enum DataDir {

    /// 应用目录名。**显式常量**，不从 Bundle 名推（见文件头 ③）。
    public static let appFolderName = "Tsumigeya"

    /// 解析数据目录，并按需创建。
    ///
    /// - Parameters:
    ///   - environment: 注入用（测试传自己的字典，生产传 `ProcessInfo.processInfo.environment`）
    ///   - homeDirectory: 注入用（测试传临时目录）
    public static func resolve(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
        fileManager: FileManager = .default
    ) -> DataDirResolution {

        // ---- 1. 环境变量优先（开发隔离）----
        if let raw = environment["TSUMIGEYA_DATA_DIR"],
           !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let expanded = (raw as NSString).expandingTildeInPath
            let url = URL(fileURLWithPath: expanded)
            if ensureDirectory(url, fileManager: fileManager) {
                return DataDirResolution(path: url.path, source: .environment, warning: nil)
            }
            // 显式指定的目录建不出来 → 不静默降级到别处，直接报出来。
            // 开发隔离失效比走错目录更难查。
            let fallback = defaultURL(home: homeDirectory).path
            _ = ensureDirectory(URL(fileURLWithPath: fallback), fileManager: fileManager)
            return DataDirResolution(
                path: fallback,
                source: .fallback,
                warning: .init(requested: url.path, switchedTo: fallback,
                               code: "envDirUnavailable")
            )
        }

        // ---- 2. mac 默认：~/Library/Application Support/Tsumigeya ----
        let preferred = defaultURL(home: homeDirectory)
        if ensureDirectory(preferred, fileManager: fileManager) {
            return DataDirResolution(path: preferred.path, source: .userDefault, warning: nil)
        }

        // ---- 3. 降级：~/Library/Caches/Tsumigeya ----
        // ⚠️ 用 Caches 而不是临时目录：macOS 会清 Caches，但至少比 /tmp 慢、
        //    且这个降级本身已经是异常路径，目标只是「别崩、别丢数据」。
        let fallback = homeDirectory
            .appendingPathComponent("Library/Caches", isDirectory: true)
            .appendingPathComponent(appFolderName, isDirectory: true)
        _ = ensureDirectory(fallback, fileManager: fileManager)

        return DataDirResolution(
            path: fallback.path,
            source: .fallback,
            warning: .init(requested: preferred.path, switchedTo: fallback.path,
                           code: "userDefaultUnavailable")
        )
    }

    /// 默认数据目录 URL（不创建）。
    public static func defaultURL(home: URL) -> URL {
        home
            .appendingPathComponent("Library/Application Support", isDirectory: true)
            .appendingPathComponent(appFolderName, isDirectory: true)
    }

    /// 建目录（含中间层）。已存在时返回 true。
    @discardableResult
    public static func ensureDirectory(_ url: URL, fileManager: FileManager = .default) -> Bool {
        var isDir: ObjCBool = false
        if fileManager.fileExists(atPath: url.path, isDirectory: &isDir) {
            return isDir.boolValue
        }
        do {
            try fileManager.createDirectory(at: url, withIntermediateDirectories: true)
            return true
        } catch {
            return false
        }
    }
}
