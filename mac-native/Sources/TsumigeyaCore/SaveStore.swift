// 存档的 IO 层：探测、列出、导出、导入。
//
// 对应 Electron 版：`src/main/save-store.ts`（276 行）+ `save-archive-io.ts`（305 行）
// 契约：M4 S1/S3/S4，D81 / D82 / D86
//
// ===== 三条铁律（每条都是踩出来的）=====
//
// ① **导出打「整个存档目录」，不是只打槽**（D81）
//
//    真机实测：`Karryn's Prison/www/save/` 里有 `lastsave.autobak` /
//    `sync_data.rpgsave` —— 那是**游戏插件写的文件**，也是存档数据。
//    只打 `file*.rpgsave` 会让用户换机后少东西（插件数据丢了游戏行为就不一样），
//    而他不会怀疑「包少了东西」。
//
// ② **运行中禁止导出/导入**（D82）
//
//    运行中的存档可能正在写 → 导出的是**半截文件**（头对、尾缺）。
//    用户带着它换机，导入后游戏报存档损坏 —— 而他想不到问题出在「当初导没关游戏」。
//
// ③ **导入顺序：校验 sha256 → 备份 → 才写**
//
//    写与备份的交界处出事（磁盘满/断电）：
//      · 先备份的最坏结果：只是「没导进来」
//      · 先写的最坏结果：**半新半旧，既不能玩也不能回退**
//    **备份幂等**：已有 `.tsumigeya-bak` 不覆盖（否则第二次导入会把真存档盖成
//    「导入后的版本」）
import Foundation

public enum SaveIOError: Error, Sendable, Equatable {
    case saveDirMissing(path: String)
    case notADirectory(path: String)
    case exportBlocked(reason: String)
    case archiveMissing(path: String)
    case invalidArchive(reason: String)
    case checksumMismatch(file: String)
    case writeFailed(file: String, reason: String)
    case cancelled

    public var message: String {
        switch self {
        case .saveDirMissing(let p): return "找不到存档目录：\(p)"
        case .notADirectory(let p): return "这不是一个目录：\(p)"
        case .exportBlocked(let r): return r
        case .archiveMissing(let p): return "找不到存档包：\(p)"
        case .invalidArchive(let r): return "存档包格式不对：\(r)"
        case .checksumMismatch(let f): return "文件校验失败（内容与清单不符）：\(f)"
        case .writeFailed(let f, let r): return "写 \(f) 失败：\(r)"
        case .cancelled: return "操作已取消"
        }
    }
}

// MARK: - 存档列表

/// 一个存档条目。
public struct SaveItem: Sendable, Equatable, Identifiable {
    public var id: String { name }
    public let name: String
    /// 字节数（`nil` = stat 失败）。
    public let size: Int64?
    /// 修改时间（`nil` = 读不到）。
    public let modified: Date?
    /// 是配置而不是存档槽。
    public let isConfig: Bool

    public init(name: String, size: Int64?, modified: Date?, isConfig: Bool) {
        self.name = name
        self.size = size
        self.modified = modified
        self.isConfig = isConfig
    }
}

/// 一次列出的结果。
public struct SaveListing: Sendable {
    /// 存档目录（`nil` = **不知道在哪**，与「还没存档」是两件事，D85）。
    public let dir: String?
    public let items: [SaveItem]

    public init(dir: String?, items: [SaveItem]) {
        self.dir = dir
        self.items = items
    }

    /// 有没有存档（不含配置）。
    public var hasSaves: Bool {
        items.contains { !$0.isConfig }
    }
}

// MARK: - 探测 + 列出

public enum SaveStore {

    /// 探测并列出某个游戏的存档。
    ///
    /// - Parameters:
    ///   - gamePath: 游戏的 gamePath（可能是文件，内部会反推目录）
    ///   - engine: 引擎 folder
    ///   - fileManager: 注入用
    ///
    /// - Returns: 列表结果。`dir == nil` 表示**不知道存档在哪**（不是「没有存档」）
    public static func list(
        gamePath: String, engine: String, fileManager: FileManager = .default
    ) -> SaveListing {
        let root = DetectPath.gameDirForFiles(gamePath)

        // 读出所有可能的目录快照
        let wwwSave = snapshot(path: (root as NSString).appendingPathComponent("www/save"), fm: fileManager)
        let gameSave = snapshot(path: (root as NSString).appendingPathComponent("save"), fm: fileManager)
        let dataDir = snapshot(path: (root as NSString).appendingPathComponent("Data"), fm: fileManager)
        let saveDir = snapshot(path: (root as NSString).appendingPathComponent("Save"), fm: fileManager)
        let rootSnap = snapshot(path: root, fm: fileManager)

        // Ren'Py 的外部目录（`~/Library/RenPy/<游戏名>/`）
        //
        // ⚠️ 游戏名从路径取（不是从 gameTitle —— gameTitle 是用户可改的显示名，
        //    而 Ren'Py 用的是**目录名**）。
        let gameName = (root as NSString).lastPathComponent
        let external = snapshot(
            path: (NSHomeDirectory() as NSString)
                .appendingPathComponent("Library/RenPy/\(gameName)"),
            fm: fileManager)

        // package.json 的 main（**只有 nwjs 用得到**，D85）
        //
        // ⚠️ **要往上找几层**：`gamePath` 可能是
        //    · `…/Game.exe`（在游戏根）→ `gameDirForFiles` 得到根 ✅
        //    · `…/www/save/file1.rpgsave`（**存档文件本身**）→ 得到 `…/www/save`
        //      而 package.json 在**根** → 直接查那个目录会查不到
        //
        //    实测（2026-11-06）：本鱼写端到端测试时传的是存档文件路径，
        //    4 条测试全报 `noLocation` —— 就是这个原因。
        //
        //    用户从详情页导出时 gamePath 是 Game.exe（在根），不会踩到；
        //    但「能处理两种输入」比「只接受一种」更稳。
        //
        // ⚠️ 顺便把**真正的游戏根**也找出来（`gameRoot` 要用它拼路径）。
        let (packageMain, realGameRoot) = locatePackageMain(
            root: root, engine: engine, fileManager: fileManager)

        let location = SaveLocate.detect(
            engine: engine,
            wwwSave: wwwSave, gameSave: gameSave,
            dataDir: dataDir, saveDir: saveDir,
            root: rootSnap, external: external,
            packageMain: packageMain,
            // ⚠️ 传**真正的游戏根**（不是 root —— root 可能是 `…/www/save`）：
            //    目标目录可能还不存在（用户没存过档），
            //    那时也要能拼出**完整路径**（不能是相对的 `www/save`）。
            gameRoot: realGameRoot)

        guard let location else {
            // **不知道在哪** —— 与「空」是两件事
            return SaveListing(dir: nil, items: [])
        }

        // 列出那个目录里的文件
        let entries = (try? fileManager.contentsOfDirectory(atPath: location.dir)) ?? []
        let classified = SaveEntries.classify(entries: entries, engine: engine)

        var items: [SaveItem] = []
        for name in classified.slots + classified.configs {
            let full = (location.dir as NSString).appendingPathComponent(name)
            let attrs = try? fileManager.attributesOfItem(atPath: full)
            items.append(SaveItem(
                name: name,
                size: attrs?[.size] as? Int64,
                modified: attrs?[.modificationDate] as? Date,
                isConfig: classified.configs.contains(name)
            ))
        }
        return SaveListing(dir: location.dir, items: items)
    }

    /// 建一个目录快照（目录不存在时返回 nil）。
    private static func snapshot(path: String, fm: FileManager) -> DirSnapshot? {
        var isDir: ObjCBool = false
        guard fm.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue else {
            return nil
        }
        let entries = (try? fm.contentsOfDirectory(atPath: path)) ?? []
        return DirSnapshot(path: path, entries: entries)
    }

    /// 找 `package.json` 的 `main`，同时确定**真正的游戏根**。
    ///
    /// - Returns: (main 字段, 游戏根目录)。找不到 package.json 时 main 为 nil，
    ///   根目录退回传进来的 `root`。
    ///
    /// ⚠️ **为什么要往上找**：`gamePath` 可能是存档文件本身
    ///    （`…/www/save/file1.rpgsave`），那时 `gameDirForFiles` 得到的是
    ///    `…/www/save`，而 `package.json` 在**游戏根**。
    ///
    ///    上限 2 层，与 `ImportTarget.maxAscend` 同一个取向
    ///    （再深就不是游戏目录了）。
    static func locatePackageMain(
        root: String, engine: String, fileManager: FileManager
    ) -> (main: String?, gameRoot: String) {
        guard engine == "nwjs" else { return (nil, root) }

        var candidate = root
        for _ in 0...2 {
            let pkgPath = (candidate as NSString).appendingPathComponent("package.json")
            if let data = fileManager.contents(atPath: pkgPath),
               let obj = try? JSONDecoder().decode([String: JSONValue].self, from: data) {
                return (obj["main"]?.stringValue, candidate)
            }
            let parent = (candidate as NSString).deletingLastPathComponent
            if parent == candidate || parent.isEmpty || parent == "/" { break }
            candidate = parent
        }
        return (nil, root)
    }
}
