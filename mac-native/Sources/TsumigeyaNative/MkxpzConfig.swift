// mkxp.json 的构造与写入。
//
// 对应 Electron 版：src/main/launchers/mkxpz.ts 的 buildMkxpConfig / writeMkxpConfig / resolveRtp
// 契约：D71 / D72（配置位置与非 ASCII 处置）
//
// ⚠️ 这个文件的核心不是"拼 JSON"，而是**三个顺序不能错的处置**：
//   ① 先修 Game.ini 的 Title（D71）—— 不改的话 mkxp-z 连 ini 都读不出来
//   ② 再建 ASCII 符号链接（D72）—— 路径里只要有一个非 ASCII 字节它就崩
//   ③ 最后写配置到 **app 包内**（不是游戏目录，不是 cwd）
//
// 顺序反了会怎样：
//   · 先写配置再修 Title → 配置写对了，但 mkxp-z 还是因为 ini 读不出而回落 RGSS 1
//   · 先写配置再建链接 → 配置里的 gameFolder 是中文路径 → 它直接 `Unknown encoding`
import Foundation

/// mkxp.json 的形态。
///
/// 用 `[String: JSONValue]` 而不是强类型 struct，因为：
///   · `gameArgs` 里有一堆可选参数（fullscreen / vsync / windowTitle / ...），
///     形状由 manifest 决定，不是固定结构（D61 精简后仍有 10 个）
///   · 我们用「原样透传 + 只算三项（gameFolder / RTP / rgssVersion）」的策略，
///     与 Electron 版一致
public typealias MkxpConfig = [String: JSONValue]

public enum MkxpzConfig {

    /// 构造配置。
    ///
    /// - Parameter folder: 已解析成 ASCII 的**游戏目录**（调用方负责，见 `prepare`）
    public static func build(
        context ctx: LaunchContext,
        folder: String,
        rgssVersion: Int?,
        rtpDirs: [String],
        homedir: String = FileManager.default.homeDirectoryForCurrentUser.path
    ) -> MkxpConfig {
        var config: MkxpConfig = [:]
        config["gameFolder"] = .string(folder)

        if !rtpDirs.isEmpty {
            config["RTP"] = .array(rtpDirs.map { .string($0) })
        }
        if let rgssVersion {
            config["rgssVersion"] = .int(rgssVersion)
        }

        // 其余参数原样透传（转成 mkxp.json 认的类型）。
        // ⚠️ rgssVersion 与 RTP 跳过 —— 上面已经算出来了。
        for (key, value) in ctx.gameArgs
            where key != "rgssVersion" && key != "RTP" {
            config[key] = value
        }
        return config
    }

    /// 写配置。
    ///
    /// ⚠️ 4 空格缩进 —— 与 mkxp-z 的示例配置一致，便于用户手改时看。
    /// （这是给人看的文件，不是机器专用；JSON 的可读性在这里有意义。）
    public static func write(_ config: MkxpConfig, to file: String) -> String? {
        let dir = (file as NSString).deletingLastPathComponent
        do {
            try FileManager.default.createDirectory(
                atPath: dir, withIntermediateDirectories: true)
        } catch {
            return "建目录失败: \(error.localizedDescription)"
        }

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .withoutEscapingSlashes, .sortedKeys]
        guard let data = try? encoder.encode(config) else {
            return "序列化失败"
        }
        // 4 空格缩进：JSONEncoder 的 prettyPrinted 用的是 2 空格，
        // 这里替换成 4（与 mkxp-z 示例一致）。
        var text = String(data: data, encoding: .utf8) ?? "{}"
        text = text.replacingOccurrences(of: "\n  ", with: "\n    ")
        text = text.replacingOccurrences(of: "\n    \"", with: "\n    \"")
        // 递归缩进（每层 2→4）
        var lines = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        for (i, line) in lines.enumerated() {
            let leading = line.prefix { $0 == " " }.count
            if leading > 0 {
                lines[i] = String(repeating: " ", count: leading * 2) + line.dropFirst(leading)
            }
        }
        text = lines.joined(separator: "\n")

        do {
            try text.write(toFile: file, atomically: true, encoding: .utf8)
            return nil
        } catch {
            return "写入失败: \(error.localizedDescription)"
        }
    }

    // MARK: - RTP 解析

    /// RTP 决策结果。
    public struct RtpDecision: Sendable {
        public let rtpDirs: [String]
        public let rgssVersion: Int?
        /// 从哪里推出来的（`gameArgs` / `gameIni` / `none`）—— 排障用。
        public let source: String
    }

    /// 决定用哪个 RTP 目录、哪个 RGSS 版本。
    ///
    /// 三级优先级（与 Electron 版一致）：
    ///   ① `gameArgs.rgssVersion` 显式给了有效值（1/2/3）→ 直接用它
    ///   ② 否则读 `Game.ini` 的 `RTP=` → 归一化成真实目录名 → 反查版本
    ///   ③ 都没有 → 不填（让 mkxp-z 自己判断）
    public static func resolveRtp(
        context ctx: LaunchContext,
        fileManager: FileManager = .default
    ) -> RtpDecision {
        // ① 显式版本
        let explicit: Int?
        if let raw = ctx.gameArgs["rgssVersion"]?.intValue,
           raw == 1 || raw == 2 || raw == 3 {
            explicit = raw
        } else if let raw = ctx.gameArgs["rgssVersion"]?.stringValue,
                  let n = Int(raw.trimmingCharacters(in: .whitespaces)),
                  n == 1 || n == 2 || n == 3 {
            explicit = n
        } else {
            explicit = nil
        }

        // 用户显式给的 RTP 路径优先
        let userRtp: [String] = (ctx.gameArgs["RTP"]?.arrayValue ?? [])
            .compactMap { $0.stringValue }
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }

        if let version = explicit, let name = RtpTable.byRgssVersion[version] {
            let dirs = userRtp.isEmpty
                ? [BinaryPaths.mkxpzRtpDir(dataDir: ctx.dataDir, rtpName: name)]
                : userRtp
            return RtpDecision(rtpDirs: dirs, rgssVersion: version, source: "gameArgs")
        }

        // ② 从 Game.ini 推
        let ini = GameIniReader.read(gameDir: ctx.folder, fileManager: fileManager)
        // Library= 里能直接看出版本（System\RGSS300.dll → 3）
        var versionFromLibrary: Int?
        if let lib = ini.library?.lowercased() {
            if lib.contains("rgss3") || lib.contains("rgss300") {
                versionFromLibrary = 3
            } else if lib.contains("rgss2") || lib.contains("rgss200") {
                versionFromLibrary = 2
            } else if lib.contains("rgss1") || lib.contains("rgss10") {
                versionFromLibrary = 1
            }
        }

        // ⚠️ M3 的判据只从 `RTP=` 推出**目录名**，`rgssVersion` 要靠 `Library=` 才拿得到。
        //    但目录名本身就确定了版本（`RPGVXace` 必是 3）—— 所以这里反查一次。
        //    不反查的后果：`RTP=RPGVXace` 但没写 `Library=` 的游戏会得到 rgssVersion=0，
        //    于是我们告诉 mkxp-z「你自己判断」，它可能要试几次才知道该起哪个 RGSS 运行时。
        let rtpName = RtpTable.normalizeRtpName(ini.rtp)
        let versionFromRtp = rtpName.flatMap { RtpTable.versionOfRtpName($0) }
        let version = versionFromLibrary ?? versionFromRtp

        let dirs: [String]
        if !userRtp.isEmpty {
            dirs = userRtp
        } else if let rtpName {
            dirs = [BinaryPaths.mkxpzRtpDir(dataDir: ctx.dataDir, rtpName: rtpName)]
        } else {
            dirs = []
        }

        return RtpDecision(
            rtpDirs: dirs, rgssVersion: version,
            source: version != nil ? "gameIni" : "none")
    }

    // MARK: - Game.ini 的 Title 处置（D71）

    /// 把 `Game.ini` 的 `Title=` 改成纯 ASCII（**先备份，幂等**）。
    ///
    /// ⚠️ 为什么要做（实测日志）：
    ///   `Could not read Game.ini` + `Could not determine encoding of Game.Title`
    ///   → **整份 ini 都读不出来** → 回落到 RGSS 1 (XP) → 找不到 `Scripts.rxdata`
    ///   → mkxp-z 弹「No script file has been specified」
    ///
    /// `Title` 只是显示用，**不参与启动逻辑** —— 所以改它是安全的。
    public static func sanitizeGameIniTitle(
        gameDir: String, fileManager: FileManager = .default
    ) -> String? {
        let file = (gameDir as NSString).appendingPathComponent("Game.ini")
        let backup = file + ".tsumigeya-bak"

        guard let data = fileManager.contents(atPath: file),
              let text = String(data: data, encoding: .isoLatin1) else {
            return nil   // 没有 Game.ini（MZ 之类）—— 正常，不是错误
        }

        // 找出 `Title=` 那一行是不是含非 ASCII
        //
        // ⚠️ 同样必须用 `components(separatedBy: .newlines)`（见 GameIniReader 的教训）：
        //    CRLF 文件用 `split(separator: "\n")` 会把整份文件当成 1 行。
        var lines = text.components(separatedBy: .newlines)
        var needsFix = false
        var titleIndex: Int?
        var section = ""

        for (i, rawLine) in lines.enumerated() {
            var line = rawLine.trimmingCharacters(in: .whitespacesAndNewlines)
            // 剥 BOM（trimmingCharacters 不剥它）
            if line.hasPrefix("\u{FEFF}") {
                line.removeFirst()
                line = line.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            if line.hasPrefix("[") {
                var name = line
                name.removeFirst()
                if name.hasSuffix("]") { name.removeLast() }
                section = name.trimmingCharacters(in: .whitespaces).lowercased()
                continue
            }
            guard section == "game" else { continue }
            guard line.lowercased().hasPrefix("title=") else { continue }

            titleIndex = i
            let value = line.dropFirst("title=".count)
            if value.unicodeScalars.contains(where: { !$0.isASCII }) {
                needsFix = true
            }
            break
        }

        guard needsFix, let idx = titleIndex else { return nil }

        // 备份（幂等：已有备份不覆盖）
        //
        // ⚠️ 为什么幂等：这个文件是**用户的原件**。第二次启动时再覆盖备份，
        //    备份里就会变成「已经改过的那份」，原件永久丢失。
        if !fileManager.fileExists(atPath: backup) {
            do {
                try fileManager.copyItem(atPath: file, toPath: backup)
            } catch {
                // 备份失败 → **不改**。没有回退点的修改，风险高于收益。
                return "备份失败，跳过 Title 修正: \(error.localizedDescription)"
            }
        }

        // 保留缩进样式（有些 game.ini 用 tab）
        let original = lines[idx]
        let prefix = original.prefix { $0 == " " || $0 == "\t" }
        lines[idx] = "\(prefix)Title=Tsumigeya"
        let updated = lines.joined(separator: "\n")

        do {
            try updated.write(toFile: file, atomically: true, encoding: .isoLatin1)
            return nil
        } catch {
            return "写回 Game.ini 失败: \(error.localizedDescription)"
        }
    }
}
