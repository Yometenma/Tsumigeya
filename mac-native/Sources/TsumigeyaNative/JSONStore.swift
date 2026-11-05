// JSON 读写层（原子写）。
//
// 对应 Electron 版：src/main/games-store.ts 的 readJSON / writeJSON
// 契约：docs/M1-实施方案.md §3.2，写文件规则照上游 worker.cjs:38-48
//
// ===== 为什么要原子写（不是"保险起见"）=====
//
// 写文件序列必须是：**校验旧文件 → 备份 .bak → 写 .tmp → rename**
//
// 为什么 `.tmp` + `rename`：POSIX 的 `rename` 对同一文件系统是**原子**的。
// 直接覆写若在中途断电/磁盘满，后果是**文件半新半旧** —— 既读不出新数据，
// 也回不去旧数据。而 rename 的最坏结果是「还是旧的那份」，那是可接受的。
//
// 为什么还要 `.bak`：rename 保住了「不半截」，但保不住「写进去的是坏数据」
// （比如序列化逻辑有 bug 写了个空对象）。这时候 `.bak` 是唯一回退点。
//
// ⚠️ **顺序不能调**：先备份再写。反过来（先写后备份）意味着
//    备份的那份可能是**已经写坏了的新内容**，等于没有备份。
//
// ⚠️ **读坏了不要删**：读到非法 JSON 时把它改名成 `.corrupt-<时间戳>`
//    再继续，**绝不静默删除**。用户的数据可能只是格式错了，
//    他还有机会拿回来；静默删掉就是永久丢。
import Foundation

/// 一次读盘的结果。
public enum LoadResult<Value: Sendable>: Sendable {
    /// 读到了并且能解析。
    case loaded(Value)
    /// 文件不存在（**正常状态**，不是错误 —— 首次运行就是这样）。
    case missing
    /// 文件存在但读不出/解析失败。`backupPath` 是改名保留的那份。
    case corrupt(LoadFailure)

    /// 是否「没有文件」。测试与调用方都用它判，不用自己 switch。
    public var isMissing: Bool {
        if case .missing = self { return true }
        return false
    }

    /// 是否损坏。
    public var isCorrupt: Bool {
        if case .corrupt = self { return true }
        return false
    }

    /// 取出成功值（没有就 nil）。
    public var value: Value? {
        if case .loaded(let v) = self { return v }
        return nil
    }
}

// 只在 `Value: Equatable` 时提供 `==`。
// 不能无条件加 —— `LoadResult` 本身不要求 Equatable，否则所有调用点都要跟着受限。
extension LoadResult: Equatable where Value: Equatable {}

public struct LoadFailure: Sendable, Equatable {
    public let path: String
    /// 改名后的保留路径（读到坏内容时不会静默删除）。
    public let backupPath: String?
    public let reason: String
}

public enum JSONStore {

    /// 读 JSON 文件。
    ///
    /// - Parameter decoder: 注入用。默认给一个宽松的 decoder。
    public static func load<T: Decodable & Sendable>(
        _ type: T.Type,
        from url: URL,
        fileManager: FileManager = .default,
        decoder: JSONDecoder = JSONStore.defaultDecoder,
        quarantineCorrupt: Bool = true
    ) -> LoadResult<T> {
        guard fileManager.fileExists(atPath: url.path) else {
            return .missing
        }

        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            return .corrupt(.init(path: url.path, backupPath: nil,
                                  reason: "unreadable: \(error.localizedDescription)"))
        }

        // 空文件按「还没有内容」处理，不算损坏。
        // 理由：应用首次启动时可能先 create 了一个空文件（或上一次写被中断在 create 之后）。
        // 这与「读到乱码」是两种处境：空 = 没有数据，乱码 = 有数据但坏了。
        if data.isEmpty {
            return .missing
        }

        do {
            return .loaded(try decoder.decode(T.self, from: data))
        } catch {
            let backupPath = quarantineCorrupt
                ? quarantine(url, fileManager: fileManager)
                : nil
            return .corrupt(.init(path: url.path, backupPath: backupPath,
                                  reason: "decode failed: \(error)"))
        }
    }

    /// 原子写：备份 `.bak` → 写 `.tmp` → rename。
    ///
    /// - Returns: 成功时返回 nil，失败时返回错误描述（**不抛** —— 调用方要能继续）。
    public static func save<T: Encodable>(
        _ value: T,
        to url: URL,
        fileManager: FileManager = .default,
        encoder: JSONEncoder = JSONStore.defaultEncoder
    ) -> String? {
        let data: Data
        do {
            data = try encoder.encode(value)
        } catch {
            return "encode failed: \(error)"
        }

        let tmp = url.appendingPathExtension("tmp")
        let bak = url.appendingPathExtension("bak")

        // ---- 1. 写 .tmp ----
        do {
            try data.write(to: tmp, options: .atomic)
        } catch {
            try? fileManager.removeItem(at: tmp)
            return "write tmp failed: \(error.localizedDescription)"
        }

        // ---- 2. 备份旧文件（**在 rename 之前**，见文件头）----
        if fileManager.fileExists(atPath: url.path) {
            do {
                if fileManager.fileExists(atPath: bak.path) {
                    try fileManager.removeItem(at: bak)
                }
                try fileManager.copyItem(at: url, to: bak)
            } catch {
                // 备份失败就**不继续**。没有回退点的新写入，风险高于收益。
                try? fileManager.removeItem(at: tmp)
                return "backup failed: \(error.localizedDescription)"
            }
        }

        // ---- 3. rename（原子）----
        do {
            if fileManager.fileExists(atPath: url.path) {
                try fileManager.removeItem(at: url)
            }
            try fileManager.moveItem(at: tmp, to: url)
            return nil
        } catch {
            try? fileManager.removeItem(at: tmp)
            return "rename failed: \(error.localizedDescription)"
        }
    }

    /// 把坏文件改名保留（**绝不删除**，见文件头）。
    /// - Returns: 改名后的路径；改名失败时返回 nil（原文件原地不动）。
    private static func quarantine(_ url: URL, fileManager: FileManager) -> String? {
        let stamp = ISO8601DateFormatter().string(from: Date())
            .replacingOccurrences(of: ":", with: "-")
        let corrupt = url.deletingPathExtension()
            .appendingPathExtension("corrupt-\(stamp)")
        do {
            try fileManager.moveItem(at: url, to: corrupt)
            return corrupt.path
        } catch {
            return nil
        }
    }

    // MARK: - 默认编解码器

    /// 默认 Encoder：输出可读的 JSON（带缩进 + 中文不转义）。
    ///
    /// ⚠️ 中文不转义很重要：这些 JSON 是用户**会打开看**的数据文件
    /// （`games.json` 里全是日文/中文游戏名）。`\u65e5` 那种形式人眼没法读，
    /// 也会让「手动编辑修一下」变得不可能。
    public static var defaultEncoder: JSONEncoder {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return e
    }

    /// 默认 Decoder：宽容（未知字段忽略）。
    public static var defaultDecoder: JSONDecoder {
        let d = JSONDecoder()
        return d
    }
}
