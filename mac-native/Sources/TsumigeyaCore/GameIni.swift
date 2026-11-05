// mkxp-z 的配置构造与写入。
//
// 对应 Electron 版：src/main/launchers/mkxpz.ts（357 行）+ diagnose.ts 的 GameIni 部分
// 契约：docs/M4.0-实施方案.md §10，D59 / D71 / D72
//
// ===== 三个必须照搬的实测结论（每条都踩过真机）=====
//
// ① **D72：mkxp-z 只读 app 包内的 `mkxp.json`，不看 cwd、不看游戏目录**
//
//    实测（Mac，2026-11-04）：把配置改写到游戏目录 → **无效**，它照旧读 app 包里那份旧配置
//    → 报 `Failed to parse mkxp.json: Unknown encoding`。
//    判据：把 Game.ini 都删掉、cwd 换成纯 ASCII 临时目录，它仍然报同一句。
//    → 配置**必须**写在 `Z-Universal.app/Contents/Game/mkxp.json`，且**不传 cwd**。
//    （v0.5.2 就是因为「按 cwd 找配置」这个错误理解，白绕一圈。）
//
// ② **D72：非 ASCII 路径要用 ASCII 符号链接**
//
//    实测对照：`/tmp/mkxp-ascii-test` → ✅ `RGSS version 3`；
//    中文路径 → ❌ `Failed to parse mkxp.json : Unknown encoding`
//    （它的 JSON 读取器**先做编码嗅探**，见到非 ASCII 字节就判失败，即使文件是合法 UTF-8）
//
//    ⚠️ **别写 \uXXXX 转义**：那样更糟 → 直接 crash
//    （`-[NSURL initFileURLWithPath:]: nil string parameter`）
//
//    → 配置里的 `gameFolder` 写成 `/tmp/tsumigeya-<basename>-<sha1前12>` 的符号链接，
//      让 mkxp-z 全程只见 ASCII。
//
// ③ **D71：Game.ini 的 `Title=` 是 GBK 时，整份 ini 都读不出来**
//
//    实测日志：`Could not read Game.ini` + `Could not determine encoding of Game.Title`
//    → mkxp-z 回落到 RGSS 1 (XP) → 找不到 `Scripts.rxdata` → 弹「No script file has been specified」。
//    → 启动前把 `Title=` 改成纯 ASCII（**先备份 `.tsumigeya-bak`，幂等**）。
//
// ===== D59：XP 的 RTP 目录名是 `Standard` 不是 `RPGXP` =====
// 实测 `RTP.zip` 里只有 `Standard` / `RPGVX` / `RPGVXAce`。错映射 → XP 永久判「RTP 缺失」，
// 而且一键补装也修不掉。
import Foundation

// MARK: - Game.ini 解析

/// `Game.ini` 的 ASCII 结构部分。
public struct GameIni: Sendable, Equatable {
    /// `RTP=` 的值（已 trim）。`nil` = 明确不使用 RTP（写了空值或没有这一行）。
    public var rtp: String?
    /// `[Game]` 段里到底有没有 `RTP=` 这一行（区分「没有行」与「行存在但为空」）。
    public var hasRtpLine: Bool
    /// `Scripts=` 的值（形如 `Data\\Scripts.rvdata2`）。
    public var scripts: String?
    /// `Library=` 的值（形如 `System\\RGSS300.dll`）。
    public var library: String?
    /// `Game.ini` 本身是否存在。
    public var exists: Bool

    public static let empty = GameIni(
        rtp: nil, hasRtpLine: false, scripts: nil, library: nil, exists: false)
}

public enum GameIniReader {

    /// Game.ini 超过这个尺寸就不再解析（正常只有几百字节；防御异常文件）。
    static let maxBytes = 256 * 1024

    /// 读 `Game.ini` 的 **ASCII 结构行**。
    ///
    /// ⚠️ **只按 latin1 语义读**（逐字节，不按 UTF-8 解码），
    /// **绝不用 `Title=`**（GBK，读出来是乱码），
    /// 也绝不尝试 UTF-8（会让中文标题变成替换字符、甚至解析错行）。
    /// 我们只关心 `RTP=` / `Scripts=` / `Library=` 这三个纯 ASCII 键。
    ///
    /// Swift 里「按 latin1 读」= `String(data:encoding:.isoLatin1)`。
    /// 它是单字节编码，任何字节都能解码，不会抛错 —— 正是我们要的。
    public static func read(
        gameDir: String, fileManager: FileManager = .default
    ) -> GameIni {
        let file = (gameDir as NSString).appendingPathComponent("Game.ini")

        guard let attrs = try? fileManager.attributesOfItem(atPath: file),
              let type = attrs[.type] as? FileAttributeType, type == .typeRegular,
              let size = attrs[.size] as? Int, size <= maxBytes,
              let data = fileManager.contents(atPath: file),
              let text = String(data: data, encoding: .isoLatin1) else {
            return .empty
        }

        var result = GameIni(
            rtp: nil, hasRtpLine: false, scripts: nil, library: nil, exists: true)
        var section = ""

        // ⚠️ **必须用 `components(separatedBy: .newlines)`，不能用 `split(separator: "\n")`。**
        //
        // 实测踩到的坑（2026-11-06，真实 `Game.ini`）：CRLF 文件用 `split(separator:)` 会
        // **整份文件变成 1 行** —— 因为 Swift 的 `String` 按 **Character（字素簇）** 比较，
        // 而 `\r\n` 是**一个** Character，`"\n"` 匹配不到它。
        //
        // 后果（极隐蔽，不报错）：
        //   · `[Game]` 那一行变成了 `"[Game]\r\nRTP=RPGVXAce\r\nLibrary=..."`
        //   · `removeFirst()` 去掉 `[`、`removeLast()` 去掉最后一个字符 →
        //     section 变成 `"game]\r\nRTP=...Library=System"`，**永远不等于 `"game"`**
        //   · 于是 `RTP=` / `Library=` / `Scripts=` 一个都读不到
        //   · 推断不出 rgssVersion → 配置里只写 gameFolder → mkxp-z 自己去猜版本
        //     （它能猜对，所以**游戏照样能启动**，问题被完全掩盖）
        //
        // 这条是本次移植最值得记住的教训：**LogicError 类问题在"能启动"面前不会暴露**。
        let allLines = text.components(separatedBy: .newlines)

        for rawLine in allLines {
            var line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty { continue }

            // 先剥 BOM（U+FEFF）—— `trimmingCharacters(in: .whitespacesAndNewlines)`
            // **不剥 BOM**（它不在这个 CharacterSet 里）。带 BOM 的文件会让
            // `hasPrefix("[")` 失败。虽然本机的 Game.ini 没有 BOM，
            // 但别人的可能有（Windows 编辑器常见）。
            if line.hasPrefix("\u{FEFF}") {
                line.removeFirst()
                line = line.trimmingCharacters(in: .whitespacesAndNewlines)
            }

            if line.isEmpty { continue }
            if line.hasPrefix(";") || line.hasPrefix("#") { continue }

            if line.hasPrefix("[") {
                var name = line
                name.removeFirst()                       // 去掉 [
                if name.hasSuffix("]") { name.removeLast() }
                section = name.trimmingCharacters(in: .whitespaces).lowercased()
                continue
            }
            guard section == "game" else { continue }

            guard let eq = line.firstIndex(of: "=") else { continue }
            guard eq != line.startIndex else { continue }
            let key = String(line[line.startIndex..<eq])
                .trimmingCharacters(in: .whitespaces).lowercased()
            let value = String(line[line.index(after: eq)...])
                .trimmingCharacters(in: .whitespaces)

            switch key {
            case "rtp":
                result.hasRtpLine = true
                result.rtp = value.isEmpty ? nil : value
            case "scripts":
                result.scripts = value.isEmpty ? nil : value
            case "library":
                result.library = value.isEmpty ? nil : value
            default:
                break
            }
        }
        return result
    }
}

// MARK: - RTP 版本映射（D59）

public enum RtpTable {

    /// ⚠️ **XP 的目录名是 `Standard`，不是 `RPGXP`**（D59）。
    ///
    /// 实测 `RTP.zip` 里只有 `Standard` / `RPGVX` / `RPGVXAce`。
    /// 错映射 → 查一个**永远不存在**的 `RPGXP` → XP 游戏永久判「RTP 缺失」，
    /// 而且一键补装也修不掉（因为装完还是查那个不存在的目录）。
    public static let byRgssVersion: [Int: String] = [
        1: "Standard",
        2: "RPGVX",
        3: "RPGVXace",
    ]

    /// 别名表：`Game.ini` 里 `RTP=` 的写法 → 版本号。
    ///
    /// ⚠️ 两张表**分开维护**：`byRgssVersion` 是**发版契约**（决定查哪个目录），
    /// 这张是**别名表**（决定输入怎么归一化）。混在一起会让「加一个别名」
    /// 变成「改一个对外行为」。
    static let aliases: [String: Int] = [
        "standard": 1,
        "rpgxp": 1,      // XP 的另一种常见写法（RTP.zip 里没有这个目录，但要认得）
        "rpgvx": 2,
        "rpgvxace": 3,
    ]

    /// 把 `RTP=` 的写法归一化成**真实目录名**。
    ///
    /// ⚠️ 为什么必须做（实测踩到的跨平台坑）：
    /// 真实目录名是 `RPGVXace`（小写 a），而不少游戏的 `Game.ini` 写成 `RPGVXAce`（大写 A）。
    /// - **Windows/macOS 默认文件系统大小写不敏感** → 两种写法都能 stat 成功，**本机永远测不出来**
    /// - **Linux 大小写敏感**（CI）→ `RPGVXAce` 目录找不到 → 诊断永远判「RTP 缺失」
    ///
    /// 规则：按**忽略大小写**匹配已知目录名（含 `RPGXP` → `Standard` 这类别名），
    /// 命中就返回规范写法；匹配不上（未知 RTP 名）原样返回 —— 那种情况由调用方判「无法确定」。
    public static func normalizeRtpName(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let version = aliases[trimmed.lowercased()] {
            return byRgssVersion[version]
        }
        return trimmed
    }

    /// 从 RTP 目录名反查 RGSS 版本。
    public static func versionOfRtpName(_ rtpName: String) -> Int? {
        for (version, name) in byRgssVersion where name == rtpName {
            return version
        }
        return nil
    }
}

// MARK: - ASCII 符号链接（D72）

public enum AsciiAlias {

    /// 路径里是否有非 ASCII 字符。
    public static func needsAsciiAlias(_ path: String) -> Bool {
        path.unicodeScalars.contains { scalar in
            !scalar.isASCII
        }
    }

    /// 生成 ASCII 别名路径：`/tmp/tsumigeya-<basename>-<sha1前12>`。
    ///
    /// basename 也要先削成 ASCII —— 否则「中文名 + 固定前缀」仍然含非 ASCII。
    public static func aliasPath(for folder: String) -> String {
        let base = (folder as NSString).lastPathComponent
        // 把非 ASCII 字符换成 `_`，再取前 24 个字符，避免路径过长
        let asciiBase = String(base.unicodeScalars.map { $0.isASCII ? Character($0) : "_" }
            .prefix(24))
        let digest = sha1Hex(folder).prefix(12)
        return "/tmp/tsumigeya-\(asciiBase)-\(digest)"
    }

    /// 建（或复用）ASCII 符号链接。
    ///
    /// - Returns: 符号链接路径。建失败时抛错，由调用方决定要不要退回真实路径。
    public static func ensureAlias(
        for folder: String, fileManager: FileManager = .default
    ) throws -> String {
        let alias = aliasPath(for: folder)
        let fm = fileManager

        // 已存在 → 复用（幂等）。但要确认它指向同一个目标。
        if let dest = try? fm.destinationOfSymbolicLink(atPath: alias) {
            if dest == folder { return alias }
            // 指向别处 → 重建
            try? fm.removeItem(atPath: alias)
        }

        try fm.createSymbolicLink(atPath: alias, withDestinationPath: folder)
        return alias
    }

    /// 清理旧的符号链接（启动器退出时可选调用）。
    ///
    /// ⚠️ **不自动清理**：mkxp-z 可能还在跑，删掉链接它就读不到游戏了。
    /// 交给系统清理 /tmp（重启会清）。
    public static func removeAlias(for folder: String, fileManager: FileManager = .default) {
        try? fileManager.removeItem(atPath: aliasPath(for: folder))
    }
}

// MARK: - SHA1

/// 计算 SHA1（十六进制小写）。
///
/// 用 CryptoKit 的话要 `import CryptoKit`；这里手写一个是为了**不引依赖**
/// （SwiftPM 的 CryptoKit 在 macOS 上是系统框架，但手写也只有 40 行）。
/// 我们只用它做「路径 → 短哈希」的稳定标识，不涉及安全。
func sha1Hex(_ input: String) -> String {
    var h: (UInt32, UInt32, UInt32, UInt32, UInt32) =
        (0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0)

    var message = Array(input.utf8)
    let originalLength = message.count
    message.append(0x80)
    while (message.count % 64) != 56 { message.append(0) }
    // 长度（bit）大端
    let bitLen = UInt64(originalLength) * 8
    for i in (0..<8).reversed() {
        message.append(UInt8((bitLen >> UInt64(i * 8)) & 0xFF))
    }

    func rotl(_ v: UInt32, _ n: UInt32) -> UInt32 {
        (v << n) | (v >> (32 - n))
    }

    for chunk in stride(from: 0, to: message.count, by: 64) {
        var w = [UInt32](repeating: 0, count: 80)
        for i in 0..<16 {
            let base = chunk + i * 4
            w[i] = UInt32(message[base]) << 24
                | UInt32(message[base + 1]) << 16
                | UInt32(message[base + 2]) << 8
                | UInt32(message[base + 3])
        }
        for i in 16..<80 {
            w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1)
        }

        var (a, b, c, d, e) = h
        for i in 0..<80 {
            let f: UInt32
            let k: UInt32
            switch i {
            case 0..<20: f = (b & c) | (~b & d); k = 0x5A827999
            case 20..<40: f = b ^ c ^ d; k = 0x6ED9EBA1
            case 40..<60: f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC
            default: f = b ^ c ^ d; k = 0xCA62C1D6
            }
            let temp = rotl(a, 5) &+ f &+ e &+ k &+ w[i]
            e = d; d = c; c = rotl(b, 30); b = a; a = temp
        }
        h.0 = h.0 &+ a; h.1 = h.1 &+ b; h.2 = h.2 &+ c
        h.3 = h.3 &+ d; h.4 = h.4 &+ e
    }

    return String(format: "%08x%08x%08x%08x%08x", h.0, h.1, h.2, h.3, h.4)
}
