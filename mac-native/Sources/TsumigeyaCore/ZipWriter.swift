// 最小可用的 zip 写入器（**只写不压**，存储模式）。
//
// ===== ⚠️ 为什么不直接用系统 `ditto` / `zip`（实测否掉了）=====
//
// 实测（2026-11-06，Mac）：
//
// ```
// $ ditto -c -k --norsrc --noextattr $D /tmp/dt.zip
// $ python3 -c 'zipfile.ZipFile(...)'
// 'saves/Σ╕¡µûçσ¡ÿµíú.rpgsave'  flag_bits=0x8      ← UTF-8 标志位**没设**
//
// $ zip -r $D/saves /tmp/z.zip
// 'saves/Σ╕¡µûçσ¡ÿµíú.rpgsave'  flag_bits=0x0      ← 同样没设
// ```
//
// 两个工具都写入了**正确的 UTF-8 字节**，但**没有设置通用标志位 0x800**
// （"文件名是 UTF-8"）。于是解压端按 CP437 解 → `Σ╕¡µûç`。
//
// ⚠️ 为什么这在本项目里是**必现的严重问题**：
//    用户的游戏全是日文/中文名，存档目录里的文件名也可能是日文
//    （Ren'Py 的存档常按游戏内名字命名）。**编码一乱，导入时文件名对不上清单**，
//    校验会失败，用户看到「存档包损坏」而感到莫名其妙。
//
// 所以本文件自己写 zip —— 就为了**控制那个标志位**。
//
// ===== 为什么"只写不压"是可以接受的 =====
//
// 存档文件本身已经是压缩过的：
//   · `.rpgsave` 是 **JSON + LZString 压缩的 base64**（游戏自己压过了）
//   · `.rvdata2` 是 Ruby Marshal 格式（有内部压缩）
//   · `.rpgsave`（MZ）同理
// 再套一层 deflate 收益很小，而**风险很大**（压缩实现出错的后果是包打不开）。
//
// 实测参考：Karryn's Prison 的 4 个槽约 390KB，不压缩也完全能接受。
//
// ===== 格式要点（自己实现必须对的几条）=====
//
// 1. **本地文件头**（PK\x03\x04）+ **中央目录**（PK\x01\x02）+ **结尾记录**（PK\x05\x06）
// 2. 通用标志位**必须置 0x800**（UTF-8 文件名）—— 这是本文件存在的理由
// 3. 时间戳用 DOS 格式（2 字节时间 + 2 字节日期）
// 4. 压缩方法 0 = 存储（stored）
// 5. CRC32 必须对（有些解压工具会校验）
//
// ===== ⚠️ 实测验证结果（2026-11-06，Mac，三个独立实现）=====
//
// 写出的包用三种工具读，结果：
//
// | 工具 | 中日文文件名 | 内容 |
// |---|---|---|
// | Python `zipfile` | ✅ 完整（`utf8=True`） | ✅ |
// | `ditto -x`（**访达双击用的就是它**） | ✅ 完整 | ✅ |
// | `unzip -l`（Info-ZIP CLI） | ❌ 显示 `????` | ✅ |
//
// ⚠️ **Info-ZIP 的 `unzip` 是例外**：它按**终端 locale** 解析文件名
//    （而不是看 UTF-8 标志位），在 `LANG=C` 或某些环境下会解成问号。
//    但用户不会用命令行 `unzip` —— 双击 zip 走的是 `ditto`，那个是对的。
//
// ⚠️ **别为了迁就 Info-ZIP 改格式**：它的行为是工具本身的已知缺陷
//    （Info-ZIP 的 `-O` / `-I` 选项就是为这个存在的）。
//    我们的目标是「访达能正确解压」+「标准库能正确读」—— 两者都已达成。
import Foundation

public enum ZipWriter {

    /// 一个要写入的文件。
    public struct Entry {
        /// 包内路径（如 `saves/file1.rpgsave`）。
        public let path: String
        /// 文件内容。
        public let data: [UInt8]
        /// 修改时间（写进 DOS 时间戳）。
        public let modified: Date?

        public init(path: String, data: [UInt8], modified: Date? = nil) {
            self.path = path
            self.data = data
            self.modified = modified
        }
    }

    /// 写一个 zip 到指定路径。
    ///
    /// - Returns: 成功返回 nil；失败返回错误说明
    public static func write(entries: [Entry], to destination: String) -> String? {
        var out = Data()

        // 中央目录要记录每个条目的偏移与大小
        struct CentralRecord {
            let pathBytes: [UInt8]
            let crc: UInt32
            let size: UInt32
            let offset: UInt32
            let dosTime: UInt16
            let dosDate: UInt16
        }
        var central: [CentralRecord] = []

        // ---- 逐条目写本地头 + 数据 ----
        for entry in entries {
            let offset = UInt32(out.count)
            let pathBytes = [UInt8](entry.path.utf8)
            let size = UInt32(entry.data.count)
            let crc = CRC32.compute(entry.data)
            let (dosTime, dosDate) = dosTimestamp(entry.modified ?? Date())

            // 本地文件头（30 字节固定 + 文件名）
            out.append(contentsOf: [0x50, 0x4B, 0x03, 0x04])  // PK\3\4
            out.append(contentsOf: le16(20))                  // version needed
            // ⚠️ **0x0800 = 文件名是 UTF-8**（本文件存在的唯一理由）
            out.append(contentsOf: le16(0x0800))
            out.append(contentsOf: le16(0))                   // 压缩方法 0 = 存储
            out.append(contentsOf: le16(dosTime))
            out.append(contentsOf: le16(dosDate))
            out.append(contentsOf: le32(crc))
            out.append(contentsOf: le32(size))                // 压缩后大小
            out.append(contentsOf: le32(size))                // 原始大小
            out.append(contentsOf: le16(UInt16(pathBytes.count)))
            out.append(contentsOf: le16(0))                   // extra field 长度
            out.append(contentsOf: pathBytes)
            out.append(contentsOf: entry.data)

            central.append(CentralRecord(
                pathBytes: pathBytes, crc: crc, size: size,
                offset: offset, dosTime: dosTime, dosDate: dosDate))
        }

        // ---- 中央目录 ----
        let centralStart = UInt32(out.count)
        for rec in central {
            out.append(contentsOf: [0x50, 0x4B, 0x01, 0x02])  // PK\1\2
            out.append(contentsOf: le16(20))                  // version made by
            out.append(contentsOf: le16(20))                  // version needed
            out.append(contentsOf: le16(0x0800))              // ⚠️ UTF-8 标志
            out.append(contentsOf: le16(0))                   // 压缩方法
            out.append(contentsOf: le16(rec.dosTime))
            out.append(contentsOf: le16(rec.dosDate))
            out.append(contentsOf: le32(rec.crc))
            out.append(contentsOf: le32(rec.size))
            out.append(contentsOf: le32(rec.size))
            out.append(contentsOf: le16(UInt16(rec.pathBytes.count)))
            out.append(contentsOf: le16(0))                   // extra
            out.append(contentsOf: le16(0))                   // comment
            out.append(contentsOf: le16(0))                   // disk number
            out.append(contentsOf: le16(0))                   // internal attrs
            out.append(contentsOf: le32(0))                   // external attrs
            out.append(contentsOf: le32(rec.offset))
            out.append(contentsOf: rec.pathBytes)
        }

        // ---- 结尾记录 ----
        let centralSize = UInt32(out.count) - centralStart
        out.append(contentsOf: [0x50, 0x4B, 0x05, 0x06])      // PK\5\6
        out.append(contentsOf: le16(0))                       // 本 disk 号
        out.append(contentsOf: le16(0))                       // 中央目录起始 disk
        out.append(contentsOf: le16(UInt16(central.count)))   // 本 disk 条目数
        out.append(contentsOf: le16(UInt16(central.count)))   // 总条目数
        out.append(contentsOf: le32(centralSize))
        out.append(contentsOf: le32(centralStart))
        out.append(contentsOf: le16(0))                       // 注释长度

        // ---- 落盘 ----
        do {
            try out.write(to: URL(fileURLWithPath: destination))
            return nil
        } catch {
            return "写 zip 失败：\(error.localizedDescription)"
        }
    }

    // MARK: - 小工具

    static func le16(_ v: UInt16) -> [UInt8] {
        [UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF)]
    }

    static func le32(_ v: UInt32) -> [UInt8] {
        [UInt8(v & 0xFF), UInt8((v >> 8) & 0xFF),
         UInt8((v >> 16) & 0xFF), UInt8((v >> 24) & 0xFF)]
    }

    /// DOS 时间戳（zip 格式用）。
    ///
    /// ⚠️ DOS 时间从 **1980** 年开始（早于它的要钳到 1980）——
    ///    1980 年之前的日期写进去会变成负数/绕过，有些工具直接报错。
    static func dosTimestamp(_ date: Date) -> (time: UInt16, date: UInt16) {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "UTC") ?? .current
        let c = cal.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)

        let year = max(1980, min(2107, c.year ?? 1980))
        let month = max(1, min(12, c.month ?? 1))
        let day = max(1, min(31, c.day ?? 1))
        let hour = max(0, min(23, c.hour ?? 0))
        let minute = max(0, min(59, c.minute ?? 0))
        let second = max(0, min(59, c.second ?? 0))

        // DOS 格式：时间 = hour<<11 | minute<<5 | (second/2)
        let time = UInt16(hour << 11 | minute << 5 | (second / 2))
        // 日期 = (year-1980)<<9 | month<<5 | day
        let dateValue = UInt16((year - 1980) << 9 | month << 5 | day)
        return (time, dateValue)
    }
}

// MARK: - CRC32

/// CRC32（zip 校验用，与 PKZIP 一致的反射多项式 0xEDB88320）。
public enum CRC32 {

    private static let table: [UInt32] = {
        (0..<256).map { n -> UInt32 in
            var c = UInt32(n)
            for _ in 0..<8 {
                c = (c & 1) != 0 ? (0xEDB88320 ^ (c >> 1)) : (c >> 1)
            }
            return c
        }
    }()

    /// 计算 CRC32。
    public static func compute(_ data: [UInt8]) -> UInt32 {
        var crc: UInt32 = 0xFFFFFFFF
        for byte in data {
            let idx = Int((crc ^ UInt32(byte)) & 0xFF)
            crc = table[idx] ^ (crc >> 8)
        }
        return crc ^ 0xFFFFFFFF
    }
}
