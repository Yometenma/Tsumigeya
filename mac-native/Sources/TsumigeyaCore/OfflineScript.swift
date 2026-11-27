// 离线文本替换：不注入运行时，直接改游戏自己的脚本文件。
//
// ===== 为什么单独一篇 =====
//
// MTool 那一套（往游戏进程里塞 DLL + 在脚本 VM 里 eval）在 macOS 上没有落地条件：
// 我们的运行时要么是原生移植，要么跑在 Wine 里，没有可用的注入通道。
// 但 NScripter 的脚本本身就是**文件**：
//
//     `0.txt` / `00.txt`  → 明文脚本
//     `nscript.dat`       → 同一套字节，每个字节 XOR 0x84（ONS 的 encrypt_mode 1）
//
// 所以翻译不需要运行时：读出脚本、替换引号内的文本、按原编码写回去。
// 玩家改完直接开始游戏，工具不用一直挂着 —— 这是 MTool 的架构做不到的。
import Foundation
import CoreFoundation

public extension ONSRuntime.Encoding {
    /// 读写脚本字节用的编码。`.auto` 没有对应值 —— 调用前必须先解析成具体编码。
    ///
    /// ⚠️ GBK 走的是 **GB18030** 的编码表：GBK 是它的子集，编码方向对全部 GBK 字一致；
    ///    解回来的方向更宽松，不会把合法字节判成非法。这不是精确的 GBK 编解码器，
    ///    但对「改脚本正文」这个用法足够，而且 Foundation 没有独立的 GBK 常量。
    var stringEncoding: String.Encoding? {
        switch self {
        case .auto: return nil
        case .utf8: return .utf8
        case .sjis: return .shiftJIS
        case .gbk:
            let raw = CFStringConvertEncodingToNSStringEncoding(CFStringEncoding(CFStringEncodings.GB_18030_2000.rawValue))
            return String.Encoding(rawValue: raw)
        }
    }
}

public enum OfflineError: LocalizedError, Sendable {
    case invalid(String)
    public var errorDescription: String? { if case .invalid(let message) = self { return message }; return nil }
}

/// 脚本里一处可翻译的文本。
public struct OfflineScriptEntry: Sendable, Equatable, Identifiable {
    /// 脚本内的行号，从 1 起。
    public let index: Int
    /// 去掉外层引号后的原文。
    public let source: String
    public var id: Int { index }
}

/// 读进来的脚本：解析结果 + 足够写回原样所需的全部信息。
public struct OfflineScriptDocument: Sendable {
    public let url: URL
    public let encoding: ONSRuntime.Encoding
    public let encrypted: Bool
    public let entries: [OfflineScriptEntry]
    /// 每一行（已去掉行尾换行）与它原本的换行符。写回时逐行沿用，不做统一。
    let rows: [(line: String, ending: String)]
    /// 文件末尾是否有换行（决定拼接时要不要补）。
    let trailingNewline: Bool
}

/// 写回结果。`encoding` 是**实际写进去的编码** —— 日文原版脚本塞不下中文时会自动切到 UTF-8，
/// 调用方必须据此把游戏的 `--enc` 一起改掉，否则运行时还是按原编码读，满屏乱码。
public struct OfflineWriteResult: Sendable, Equatable {
    public let replaced: Int
    public let encoding: ONSRuntime.Encoding
    public var changedEncoding: Bool { encoding != .auto }
}

public enum OfflineScript {
    /// NScripter 的脚本入口查找顺序与运行时一致。
    public static let candidates = ["0.txt", "00.txt", "nscript.dat"]

    public static func locate(in root: String) -> URL? {
        for name in candidates {
            let url = URL(fileURLWithPath: root).appendingPathComponent(name)
            if FileManager.default.fileExists(atPath: url.path) { return url }
        }
        return nil
    }

    public static func load(_ url: URL) throws -> OfflineScriptDocument {
        guard url.resolvingSymlinksInPath().path == url.path else {
            throw OfflineError.invalid(L10n.string("脚本是符号链接，拒绝读写。"))
        }
        let raw = try Data(contentsOf: url)
        guard !raw.isEmpty else { throw OfflineError.invalid(L10n.string("脚本文件是空的。")) }
        let encrypted = url.lastPathComponent.lowercased() == "nscript.dat"
        let plain = encrypted ? Data(raw.map { $0 ^ 0x84 }) : raw
        let encoding = ONSRuntime.judge(plain)
        guard let text = String(data: plain, encoding: encoding.stringEncoding ?? .shiftJIS) else {
            throw OfflineError.invalid(L10n.string("脚本不是可识别的文本，未做任何修改。"))
        }
        let rows = splitKeepingEndings(text)
        var entries: [OfflineScriptEntry] = []
        for (offset, row) in rows.enumerated() {
            if let parsed = parseText(row.line) {
                entries.append(.init(index: offset + 1, source: parsed.content))
            }
        }
        return OfflineScriptDocument(url: url, encoding: encoding, encrypted: encrypted, entries: entries,
                                     rows: rows, trailingNewline: text.hasSuffix("\n"))
    }

    /// 把译文写回脚本。只替换 `translations` 里命中的行，其余行原样重建。
    ///
    /// 编码按 `document.encoding` → UTF-8 的顺序试探：日文原版脚本（Shift_JIS）装不下中文，
    /// 那时自动落到 UTF-8 并在返回值里说明，调用方要把游戏的 `--enc` 同步改掉。
    @discardableResult
    public static func write(_ translations: [String: String], to document: OfflineScriptDocument,
                             destination: URL? = nil, backup: Bool = true,
                             encoding target: ONSRuntime.Encoding? = nil) throws -> OfflineWriteResult {
        var replaced = 0
        var output: [String] = []
        for row in document.rows {
            guard let parsed = parseText(row.line), let target = translations[parsed.content],
                  passesTokenCheck(source: parsed.content, target: target) else {
                output.append(row.line); continue
            }
            replaced += 1
            output.append(parsed.prefix + target + parsed.suffix)
        }
        guard replaced > 0 else { return .init(replaced: 0, encoding: document.encoding) }
        var text = ""
        for (offset, row) in document.rows.enumerated() { text += output[offset] + row.ending }
        if !document.trailingNewline, text.hasSuffix("\n") { text.removeLast() }

        let url = destination ?? document.url
        guard url.resolvingSymlinksInPath().path == url.path else {
            throw OfflineError.invalid(L10n.string("目标是符号链接，拒绝写入。"))
        }
        var candidates: [ONSRuntime.Encoding] = target.map { [$0] } ?? [document.encoding, .utf8]
        if candidates.count == 2, candidates[0] == candidates[1] { candidates.removeLast() }
        for encoding in candidates {
            guard let data = text.data(using: encoding.stringEncoding ?? .shiftJIS) else { continue }
            let payload = document.encrypted ? Data(data.map { $0 ^ 0x84 }) : data
            try writeWithBackup(payload, to: url, backup: backup)
            return .init(replaced: replaced, encoding: encoding)
        }
        throw OfflineError.invalid(L10n.string("译文无法用脚本的编码写回；请改用 UTF-8 或 GBK。"))
    }

    /// 写文件前先留一份 `.tsumigeya-bak`；已有备份不覆盖（与存档导出同一约定）。
    public static func writeWithBackup(_ data: Data, to url: URL, backup: Bool) throws {
        let fm = FileManager.default
        if backup, fm.fileExists(atPath: url.path) {
            let copy = URL(fileURLWithPath: url.path + SaveArchive.backupSuffix)
            guard copy.resolvingSymlinksInPath().path == copy.path else {
                throw OfflineError.invalid(L10n.string("备份路径是符号链接，拒绝写入。"))
            }
            if !fm.fileExists(atPath: copy.path) {
                let original = try Data(contentsOf: url)
                try original.write(to: copy, options: .atomic)
            }
        }
        try data.write(to: url, options: .atomic)
    }

    // MARK: - 解析

    /// 只把「整行以引号开头的行」当作正文：
    ///   `"テキスト` / `` `テキスト `` / `「テキスト」`
    ///
    /// ⚠️ 命令行参数里的引号不能碰 —— `bg "bg\room.png",1` 这种行以命令名开头，
    ///    不会被认成正文。`*label`、`;注释`、`\` 同理。
    static func parseText(_ line: String) -> (prefix: String, content: String, suffix: String)? {
        let characters = Array(line)
        var start = 0
        while start < characters.count, characters[start] == " " || characters[start] == "\t" { start += 1 }
        guard start < characters.count else { return nil }
        let prefix = String(characters[0...start])
        // 反引号行没有闭合符：从它开始到行尾都是正文（`\` 控制符原样留在正文里）。
        if characters[start] == "`" {
            let rest = String(characters[(start + 1)...])
            let trimmed = rest.replacingOccurrences(of: "\\s+$", with: "", options: .regularExpression)
            guard !trimmed.isEmpty else { return nil }
            return (prefix, trimmed, String(rest.dropFirst(trimmed.count)))
        }
        let close: Character
        switch characters[start] {
        case "\"": close = "\""
        case "「": close = "」"
        default: return nil
        }
        var content = ""
        var index = start + 1
        while index < characters.count {
            let character = characters[index]
            if character == "\\", index + 1 < characters.count {
                content.append(character); content.append(characters[index + 1]); index += 2; continue
            }
            if character == close {
                guard !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
                // 闭合符留在 suffix 里，重建时才能原样拼回去。
                return (prefix, content, String(characters[index...]))
            }
            content.append(character); index += 1
        }
        return nil
    }

    /// 按行切分但保留每行原本的换行符，避免把 CRLF 文件统一成 LF。
    ///
    /// ⚠️ 不能用 `for character in text` 找 `"\n"`：`\r\n` 在 Swift 里是**一个** Character
    ///    （扩展字素簇），那样遍历永远匹配不到换行，整个文件会被当成一行。
    ///    这里按字符串（而不是字素簇）切分。
    static func splitKeepingEndings(_ text: String) -> [(line: String, ending: String)] {
        let pieces = text.components(separatedBy: "\n")
        var rows: [(String, String)] = []
        for (offset, piece) in pieces.enumerated() {
            let isLast = offset == pieces.count - 1
            if isLast, piece.isEmpty { break }
            let crlf = piece.hasSuffix("\r")
            let line = crlf ? String(piece.dropLast()) : piece
            rows.append((line, isLast ? "" : (crlf ? "\r\n" : "\n")))
        }
        return rows
    }

    private static func passesTokenCheck(source: String, target: String) -> Bool {
        (try? TranslationTokens.validate(source: source, target: target)) != nil
    }
}
