import Testing
import Foundation
import CoreFoundation
@testable import TsumigeyaCore

@Suite("离线脚本文本替换")
struct OfflineScriptTests {
    private static let gbk = String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(CFStringEncoding(CFStringEncodings.GB_18030_2000.rawValue)))

    private func temporary() throws -> URL {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("tsumigeya-offline-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private let body = [
        "*define",
        "game",
        "*start",
        "bg \"bg\\\\room.png\",1",
        "\"こんにちは\"",
        "`セリフ",
        "「名前」の台詞",
        ";コメント \"これは取らない\"",
        "mov %0,100"
    ].joined(separator: "\r\n")

    private func write(_ text: String, name: String, encoding: String.Encoding, in dir: URL) throws -> URL {
        let url = dir.appendingPathComponent(name)
        guard let data = text.data(using: encoding) else { throw OfflineError.invalid("样本编码失败") }
        try data.write(to: url)
        return url
    }

    @Test("三种编码都能解析出正文行，命令行与注释不受影响")
    func parseEncodings() throws {
        let dir = try temporary(); defer { try? FileManager.default.removeItem(at: dir) }
        for (name, encoding, expected) in [("0.txt", String.Encoding.shiftJIS, ONSRuntime.Encoding.sjis),
                                           ("00.txt", String.Encoding.utf8, .utf8),
                                           ("0-cn.txt", Self.gbk, .gbk)] {
            let url = try write(body, name: name, encoding: encoding, in: dir)
            let document = try OfflineScript.load(url)
            #expect(document.encoding == expected)
            #expect(document.entries.map(\.source) == ["こんにちは", "セリフ", "名前"])
            #expect(document.entries.map(\.index) == [5, 6, 7])
        }
    }

    @Test("日文脚本写中文自动落到 UTF-8，并如实报告给调用方")
    func encryptedRoundTrip() throws {
        let dir = try temporary(); defer { try? FileManager.default.removeItem(at: dir) }
        let plain = try write(body, name: "0.txt", encoding: .shiftJIS, in: dir)
        let locked = dir.appendingPathComponent("nscript.dat")
        try Data(try Data(contentsOf: plain).map { $0 ^ 0x84 }).write(to: locked)

        let document = try OfflineScript.load(locked)
        #expect(document.encrypted)
        #expect(document.entries.map(\.source) == ["こんにちは", "セリフ", "名前"])

        let result = try OfflineScript.write(["こんにちは": "你好", "セリフ": "台词"], to: document)
        #expect(result.replaced == 2)
        #expect(result.encoding == .utf8)

        let restored = Data(try Data(contentsOf: locked).map { $0 ^ 0x84 })
        let text = String(data: restored, encoding: .utf8)
        #expect(text?.contains("\"你好\"") == true)
        #expect(text?.contains("`台词") == true)
    }

    @Test("日文译文保持在原编码，不触发换编码")
    func writePreservesLayout() throws {
        let dir = try temporary(); defer { try? FileManager.default.removeItem(at: dir) }
        let url = try write(body, name: "0.txt", encoding: .shiftJIS, in: dir)
        let document = try OfflineScript.load(url)
        let result = try OfflineScript.write(["名前": "名前さま"], to: document)
        #expect(result.replaced == 1)
        #expect(result.encoding == .sjis)

        let text = try #require(String(data: Data(contentsOf: url), encoding: .shiftJIS))
        #expect(text.contains("bg \"bg\\\\room.png\",1"))
        #expect(text.contains(";コメント \"これは取らない\""))
        #expect(text.contains("\"こんにちは\""))
        #expect(text.contains("「名前さま」の台詞"))
        #expect(text.contains("\r\n"))
        #expect(!text.contains("\n\n"))
        let backup = url.path + SaveArchive.backupSuffix
        #expect(FileManager.default.fileExists(atPath: backup))
        #expect(String(data: try Data(contentsOf: URL(fileURLWithPath: backup)), encoding: .shiftJIS) == body)
    }

    @Test("指定 GBK 时按 GBK 写回")
    func writesGBK() throws {
        let dir = try temporary(); defer { try? FileManager.default.removeItem(at: dir) }
        let url = try write(body, name: "0.txt", encoding: .shiftJIS, in: dir)
        let document = try OfflineScript.load(url)
        let result = try OfflineScript.write(["こんにちは": "你好"], to: document, encoding: .gbk)
        #expect(result.replaced == 1)
        #expect(result.encoding == .gbk)
        #expect(String(data: try Data(contentsOf: url), encoding: Self.gbk)?.contains("\"你好\"") == true)
    }

    @Test("改变控制符的译文被拒绝，不写进脚本")
    func rejectsTokenChanges() throws {
        let dir = try temporary(); defer { try? FileManager.default.removeItem(at: dir) }
        let source = "\"アイテム\\および\\!です\""
        let url = try write(source, name: "0.txt", encoding: .shiftJIS, in: dir)
        let document = try OfflineScript.load(url)
        #expect(document.entries.count == 1)
        let result = try OfflineScript.write([document.entries[0].source: "道具です"], to: document)
        #expect(result.replaced == 0)
        #expect(String(data: try Data(contentsOf: url), encoding: .shiftJIS) == source)
    }

    @Test("未闭合引号、空正文、命令行和符号链接都不参与替换")
    func ignoresBrokenLines() throws {
        #expect(OfflineScript.parseText("\"閉じていない") == nil)
        #expect(OfflineScript.parseText("\"\"") == nil)
        #expect(OfflineScript.parseText("mov %0,\"100\"") == nil)
        #expect(OfflineScript.parseText("  \"字下げされた台詞\"")?.content == "字下げされた台詞")
        #expect(OfflineScript.parseText("`行末まで本文")?.content == "行末まで本文")

        let dir = try temporary(); defer { try? FileManager.default.removeItem(at: dir) }
        let real = try write("\"台詞\"", name: "0.txt", encoding: .shiftJIS, in: dir)
        let link = dir.appendingPathComponent("00.txt")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
        #expect(throws: (any Error).self) { try OfflineScript.load(link) }
    }

    @Test("定位顺序与运行时一致：0.txt → 00.txt → nscript.dat")
    func locateOrder() throws {
        let dir = try temporary(); defer { try? FileManager.default.removeItem(at: dir) }
        #expect(OfflineScript.locate(in: dir.path) == nil)
        try Data("x".utf8).write(to: dir.appendingPathComponent("nscript.dat"))
        #expect(OfflineScript.locate(in: dir.path)?.lastPathComponent == "nscript.dat")
        try Data("x".utf8).write(to: dir.appendingPathComponent("00.txt"))
        #expect(OfflineScript.locate(in: dir.path)?.lastPathComponent == "00.txt")
        try Data("x".utf8).write(to: dir.appendingPathComponent("0.txt"))
        #expect(OfflineScript.locate(in: dir.path)?.lastPathComponent == "0.txt")
    }
}
