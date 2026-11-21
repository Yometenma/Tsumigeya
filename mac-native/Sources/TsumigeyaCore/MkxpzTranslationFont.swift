import Foundation

/// mkxp-z 不读取 macOS 系统字体；只在本机缓存系统已有字体，不随应用分发字体文件。
enum MkxpzTranslationFont {
    static func prepare(dataDir: String, source: URL = URL(fileURLWithPath: "/System/Library/Fonts/Supplemental/Arial Unicode.ttf")) throws -> String {
        let fm = FileManager.default
        let bytes = try Data(contentsOf: source)
        let digest = SHA256.hex(Array(bytes))
        let root = URL(fileURLWithPath: dataDir).resolvingSymlinksInPath()
            .appendingPathComponent("assist-fonts").appendingPathComponent(digest)
        let fonts = root.appendingPathComponent("Fonts")
        let target = fonts.appendingPathComponent("translation.ttf")
        for url in [root.deletingLastPathComponent(), root, fonts, target] {
            guard url.path == url.resolvingSymlinksInPath().path else {
                throw AssistanceError.invalid(L10n.string("翻译字体缓存经过符号链接，停止写入。"))
            }
        }
        if fm.fileExists(atPath: target.path) {
            guard try target.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile == true,
                  SHA256.hexOfFile(at: target.path) == digest else {
                throw AssistanceError.invalid(L10n.string("翻译字体缓存已改变，未覆盖原文件。"))
            }
        } else {
            try fm.createDirectory(at: fonts, withIntermediateDirectories: true)
            try bytes.write(to: target, options: .atomic)
        }
        return AsciiAlias.needsAsciiAlias(root.path) ? try AsciiAlias.ensureAlias(for: root.path) : root.path
    }
}
