// LCF：RPG Maker 2000／2003 的数据库（`.ldb`）、地图树（`.lmt`）与存档（`.lsd`）共用的容器格式。
//
// ===== 格式（照 liblcf 的 `Struct::ReadLcf` 实现） =====
//
//   文件   = 头部 + chunk 序列
//   头部   = `BER 11` + "LcfDataBase"（存档是 "LcfSaveData"）
//   chunk  = `BER ID` + `BER 长度` + `长度` 字节数据
//   数组   = `BER 元素数` + （`BER 元素ID` + 元素自身的 chunk 序列）*
//
// `BER` 是**大端 7 位**变长整数：`value = (value << 7) | (b & 0x7F)`，直到某字节高位为 0。
//
// ⚠️ 这里只做「读」：写回需要重建整个 chunk 树并重算每层长度，比读复杂得多，
//    没有真实存档样本时不值得冒写坏文件的风险。
import Foundation

public struct LCFChunk: Sendable, Equatable {
    public let id: Int
    /// 数据在文件里的字节区间（不含 ID 与长度本身）。
    public let range: Range<Int>
}

public enum LCFError: LocalizedError, Sendable {
    case invalid(String)
    public var errorDescription: String? { if case .invalid(let message) = self { return message }; return nil }
}

public enum LCF {
    /// 大端 7 位变长整数。
    public static func readInt(_ bytes: [UInt8], _ offset: inout Int) throws -> Int {
        var value = 0
        for _ in 0..<5 {
            guard offset < bytes.count else { throw LCFError.invalid(L10n.string("整数在文件末尾被截断。")) }
            let byte = bytes[offset]; offset += 1
            value = (value << 7) | Int(byte & 0x7F)
            if byte & 0x80 == 0 { return value }
        }
        throw LCFError.invalid(L10n.string("压缩整数超过 5 字节。"))
    }

    /// 读一个 chunk 的 ID 与数据区间；返回 nil 表示到了序列结尾（ID 0）。
    public static func readChunk(_ bytes: [UInt8], _ offset: inout Int) throws -> LCFChunk? {
        let id = try readInt(bytes, &offset)
        if id == 0 { return nil }
        let length = try readInt(bytes, &offset)
        guard length >= 0, offset + length <= bytes.count else {
            throw LCFError.invalid(String(format: L10n.string("chunk %d 的长度超出文件。"), id))
        }
        let range = offset..<(offset + length)
        offset += length
        return LCFChunk(id: id, range: range)
    }

    /// 读完整 chunk 序列（到文件尾或 ID 0 为止）。
    public static func readChunks(_ bytes: [UInt8], from start: Int, to end: Int) throws -> [LCFChunk] {
        var offset = start
        var chunks: [LCFChunk] = []
        while offset < end {
            guard let chunk = try readChunk(bytes, &offset) else { break }
            chunks.append(chunk)
            if offset > end { break }
        }
        return chunks
    }

    /// LCF 字符串：`BER 长度` + 原始字节。
    public static func readString(_ bytes: [UInt8], _ offset: inout Int, limit: Int) throws -> String {
        let length = try readInt(bytes, &offset)
        guard length >= 0, offset + length <= min(limit, bytes.count) else {
            throw LCFError.invalid(L10n.string("字符串长度超出范围。"))
        }
        let raw = Array(bytes[offset..<(offset + length)])
        offset += length
        return decode(raw)
    }

    /// 2000 用 ANSI／GBK，2003 与新版工具可能写 UTF-8；两种都试。
    public static func decode(_ raw: [UInt8]) -> String {
        let data = Data(raw)
        if let text = String(data: data, encoding: .utf8) { return text }
        let gbk = CFStringConvertEncodingToNSStringEncoding(CFStringEncoding(CFStringEncodings.GB_18030_2000.rawValue))
        if let text = String(data: data, encoding: String.Encoding(rawValue: gbk)) { return text }
        if let text = String(data: data, encoding: .shiftJIS) { return text }
        return String(decoding: raw, as: UTF8.self)
    }
}

public extension LCF {
    /// 判断并剥掉文件头，返回字节与正文起点。
    static func open(_ data: Data, expecting magic: String) throws -> (bytes: [UInt8], bodyStart: Int) {
        let bytes = Array(data)
        var offset = 0
        let length = try readInt(bytes, &offset)
        guard length > 0, offset + length <= bytes.count else {
            throw LCFError.invalid(L10n.string("文件头长度非法。"))
        }
        let header = String(decoding: bytes[offset..<(offset + length)], as: UTF8.self)
        guard header == magic else {
            throw LCFError.invalid(String(format: L10n.string("文件头是 %@，不是 %@。"), header, magic))
        }
        return (bytes, offset + length)
    }
}
