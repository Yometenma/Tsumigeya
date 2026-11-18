import Foundation
import Testing
@testable import TsumigeyaCore

@Suite("RGSS 翻译字体缓存")
struct TranslationFontTests {
    @Test("本机字体按内容缓存，重复准备不改动原件")
    func cache() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("tsmg-font-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let source = root.appendingPathComponent("system.ttf")
        let bytes = Data("local-font".utf8)
        try bytes.write(to: source)
        let data = root.appendingPathComponent("data")
        let cache = try MkxpzTranslationFont.prepare(dataDir: data.path, source: source)
        #expect(try Data(contentsOf: URL(fileURLWithPath: cache).appendingPathComponent("Fonts/translation.ttf")) == bytes)
        #expect(try MkxpzTranslationFont.prepare(dataDir: data.path, source: source) == cache)
        #expect(try Data(contentsOf: source) == bytes)
    }

    @Test("缓存损坏不覆盖；符号链接不写入外部目录")
    func tampering() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("tsmg-font-\(UUID())")
        try fm.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        let source = root.appendingPathComponent("system.ttf")
        try Data("font".utf8).write(to: source)
        let data = root.appendingPathComponent("data")
        let cache = try MkxpzTranslationFont.prepare(dataDir: data.path, source: source)
        let target = URL(fileURLWithPath: cache).appendingPathComponent("Fonts/translation.ttf")
        try Data("changed".utf8).write(to: target)
        #expect(throws: (any Error).self) { try MkxpzTranslationFont.prepare(dataDir: data.path, source: source) }
        #expect(try Data(contentsOf: target) == Data("changed".utf8))
        let other = root.appendingPathComponent("other")
        try fm.createDirectory(at: other, withIntermediateDirectories: true)
        let linkData = root.appendingPathComponent("linked")
        try fm.createDirectory(at: linkData, withIntermediateDirectories: true)
        try fm.createSymbolicLink(at: linkData.appendingPathComponent("assist-fonts"), withDestinationURL: other)
        #expect(throws: (any Error).self) { try MkxpzTranslationFont.prepare(dataDir: linkData.path, source: source) }
        #expect(try fm.contentsOfDirectory(atPath: other.path).isEmpty)
    }
}
