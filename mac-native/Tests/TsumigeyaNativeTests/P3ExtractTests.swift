// P3 解压层测试。
//
// 对应 Electron 版：`test/extract.test.ts` / `src/main/extract.ts`（136 行）
// 契约：docs/M1-实施方案.md §4（extract.ts 行）与 §6（extract 测试）
//
// ===== 本文件最重要的一条：LANG 为空时 bsdtar 会把中文名变成八进制转义 =====
//
// 老坑的症状（Electron 版在 mac 真机上抓到的，本文件用 `bsdtarOctalEscapeReproduced`
// 现场复现，**不是照抄传说**）：
//
//     $ env -i /usr/bin/tar -tf b.tar        # 没有任何 LANG / LC_ALL / LC_CTYPE
//     ./
//     ./\344\270\255\346\226\207 \346\226\207\344\273\266\345\220\215.txt
//
//   而 `assertSafeEntry` 的**第 3 条**是「拒绝反斜杠」→ **含中文名的包整包被拒**。
//
// 老坑隐蔽的两个原因：
//   ① 触发条件是「非交互式启动」（SSH / launchctl / Finder 启动的 .app 里 LANG 常为空），
//      终端手跑拿到登录环境反而正常 —— 本机 ssh 会话实测 `LANG=[] LC_ALL=[] LC_CTYPE=[]`；
//   ② **ASCII 名永远测不出**（`./Game.exe` 在无 LANG 下完全正常），
//      所以一条用 `file.txt` 写的测试在 Windows/Linux/CI 上全能绿。
//
// 所以本文件的往返测试**两条都写**：
//   · `bsdtarOctalEscapeReproduced` —— 用「LANG 为空」的环境跑 tar，**证明坑真的在**（负对照）
//   · `roundTripWithChineseNamesUnderEmptyLang` —— 同样的环境 + `Extract.tarEnv()`，证明修好了
//   只有负对照还在，后面那条才有意义：没有它，「往返通过」也可能只是这台机器恰好有 LANG。
//
// ⚠️ 环境变量在测试里怎么造：`Process.environment` 是**整体替换**（不继承），
//    所以给 `["PATH": "/usr/bin:/bin", "LANG": "", "LC_ALL": ""]` 就等于 SSH 那种病态环境。
//    `Extract.tarEnv(base:)` 吃同一个字典 —— 生产与测试走的是**同一份逻辑**，不各写一套。
import Foundation
import Testing

@testable import TsumigeyaCore

// MARK: - 测试用工具

/// 测试临时目录（与 P0-P2 的写法一致：`temporaryDirectory` + UUID，用完删）。
struct TempDir {
    let url: URL

    init(prefix: String = "tsmg-p3") {
        url = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(prefix)-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    /// 目录下的某个路径。
    func path(_ name: String) -> String {
        url.appendingPathComponent(name).path
    }

    /// 写一个文件（自动建中间层）。
    func write(_ name: String, _ content: String) throws {
        let full = path(name)
        try FileManager.default.createDirectory(
            atPath: (full as NSString).deletingLastPathComponent,
            withIntermediateDirectories: true)
        try content.write(toFile: full, atomically: true, encoding: .utf8)
    }

    func read(_ name: String) throws -> String {
        try String(contentsOfFile: path(name), encoding: .utf8)
    }

    func exists(_ name: String) -> Bool {
        FileManager.default.fileExists(atPath: path(name))
    }

    /// 清理。`defer { tmp.cleanup() }` 用。
    func cleanup() {
        try? FileManager.default.removeItem(at: url)
    }
}

/// 一次 tar 调用的结果。
struct TarRun {
    let stdout: String
    let stderr: String
    let status: Int32
}

/// 在**指定的环境**里跑一次 tar（测试专用，生产走 `Extract.extractArchive`）。
///
/// - Parameter env: 要用的完整环境字典。传 `Extract.tarEnv(base: ...)` = 生产口径；
///   传裸的病态字典 = 复现故障。
func runTar(_ args: [String], env: [String: String]) -> TarRun {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: Extract.tarPath)
    process.arguments = args
    process.environment = env

    let out = Pipe(), err = Pipe()
    process.standardOutput = out
    process.standardError = err

    do {
        try process.run()
    } catch {
        return TarRun(stdout: "", stderr: "spawn failed: \(error)", status: 127)
    }
    // 先读 stdout 到 EOF 再 wait（反过来在大输出时会死锁，见 Extract.runTar 的注释）
    let outData = out.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    let errData = err.fileHandleForReading.readDataToEndOfFile()

    func decode(_ d: Data) -> String {
        String(data: d, encoding: .utf8) ?? String(data: d, encoding: .isoLatin1) ?? ""
    }
    return TarRun(stdout: decode(outData), stderr: decode(errData),
                  status: process.terminationStatus)
}

/// 手工搓一个 ustar 归档（测试用）。
///
/// 为什么要手搓而不是 `tar -cf`：
///   ① `tar -cf` **造不出**带 `../` 的条目（它会拒绝/找不到那个路径，实测 `-cfP ../evil.txt`
///      直接 `Cannot stat`）→ 「拒绝不安全包」那条测试就没法用真包做原料。
///   ② 手搓可以把「名字里带换行」「名字里带 `..` 段」这类边界精确放进去。
/// 实测 bsdtar 3.5.3 能正常读这种头（`-tf` 列出 `../evil.txt` / `ok.txt`，退出码 0）。
///
/// ⚠️ 这是**测试夹具**，不参与生产逻辑；生产路径只认 `Extract` 那一份实现。
struct UstarFixture {

    struct Entry {
        let name: String       // 允许含 `../`、换行等「正常 tar 造不出来」的名字
        let data: String
    }

    /// 生成归档字节。
    static func build(_ entries: [Entry]) -> Data {
        var out = Data()
        for entry in entries {
            out.append(header(name: entry.name, size: entry.data.utf8.count))
            out.append(Data(entry.data.utf8))
            // 数据区补齐到 512 边界
            let pad = (512 - entry.data.utf8.count % 512) % 512
            out.append(Data(repeating: 0, count: pad))
        }
        // 归档结尾：两个全零块（标准做法；bsdtar 没有它也能读，加上更规范）
        out.append(Data(repeating: 0, count: 1024))
        return out
    }

    /// 512 字节的 ustar 头。
    private static func header(name: String, size: Int) -> Data {
        var block = [UInt8](repeating: 0, count: 512)

        func put(_ range: Range<Int>, _ text: String) {
            for (i, byte) in text.utf8.enumerated() where range.lowerBound + i < range.upperBound {
                block[range.lowerBound + i] = byte
            }
        }
        /// 八进制数字段：n 字节，前 n-1 位是八进制，最后一位 NUL。
        func octal(_ range: Range<Int>, _ value: Int) {
            let digits = String(value, radix: 8)
            let padded = String(repeating: "0", count: max(0, range.count - 1 - digits.count)) + digits
            put(range, padded)
            block[range.upperBound - 1] = 0
        }

        put(0..<100, name)              // 文件名（100 字节；我们的用例都够短）
        octal(100..<108, 0o644)         // mode
        octal(108..<116, 0)             // uid
        octal(116..<124, 0)             // gid
        octal(124..<136, size)          // size
        octal(136..<148, 1_700_000_000) // mtime
        // 148..<156 是校验和，先用空格填满再算
        put(148..<156, "        ")
        block[156] = UInt8(ascii: "0")  // typeflag：普通文件
        put(257..<263, "ustar\0")       // magic
        put(263..<265, "00")            // version
        put(265..<297, "root")          // uname
        put(297..<329, "root")          // gname

        // 校验和 = 整个头（校验和字段按空格算）的字节和
        let sum = block.reduce(0) { $0 + Int($1) }
        let sumDigits = String(sum, radix: 8)
        let padded = String(repeating: "0", count: max(0, 6 - sumDigits.count)) + sumDigits
        put(148..<154, padded)
        block[154] = 0
        block[155] = UInt8(ascii: " ")  // 标准写法：6 位数字 + NUL + 空格

        return Data(block)
    }
}

/// 断言某条路径被当作**不安全**拒绝（且是 `.unsafeArchive`，不是别的错误）。
func expectUnsafe(_ entry: String, sourceLocation: SourceLocation = #_sourceLocation) {
    do {
        try Extract.assertSafeEntry(entry)
        Issue.record("这条本该被拒绝，却通过了：\(debugDescription(entry))",
                     sourceLocation: sourceLocation)
    } catch let error as ExtractError {
        if case .unsafeArchive = error { return }
        Issue.record("拒绝理由错了（应是 unsafeArchive）：\(error)",
                     sourceLocation: sourceLocation)
    } catch {
        Issue.record("抛了非 ExtractError：\(error)", sourceLocation: sourceLocation)
    }
}

/// 断言某条路径**放行**。
func expectSafe(_ entry: String, sourceLocation: SourceLocation = #_sourceLocation) {
    do {
        try Extract.assertSafeEntry(entry)
    } catch {
        Issue.record("这条本该通过，却被拒绝：\(debugDescription(entry)) → \(error)",
                     sourceLocation: sourceLocation)
    }
}

/// 把条目描述成「可见的字节」，免得测试失败信息里看不见控制字符 / 看不见转义差异。
func debugDescription(_ entry: String) -> String {
    let bytes = entry.utf8.map { byte -> String in
        if byte < 0x20 || byte == 0x7F { return "<0x\(String(byte, radix: 16))>" }
        if byte > 0x7E { return "<U+\(String(byte, radix: 16))>" }
        return String(UnicodeScalar(byte))
    }
    return "\"" + bytes.joined() + "\""
}

// MARK: - 安全校验：拒绝

@Suite("归档路径安全校验（拒绝）")
struct AssertSafeEntryRejectTests {

    @Test("绝对路径")
    func absolutePath() {
        // `"/"` 本身就是绝对路径，必须拒 —— 它是空目录条目里最容易被漏掉的一条
        expectUnsafe("/abs")
        expectUnsafe("/etc/passwd")
        expectUnsafe("/")
    }

    @Test("父目录穿越")
    func parentTraversal() {
        expectUnsafe("../x")
        expectUnsafe("a/../../x")
        expectUnsafe("../../../../etc/passwd")
        expectUnsafe("a/b/../../..")
    }

    @Test("Windows 盘符绝对路径")
    func driveLetter() {
        expectUnsafe("C:/x")
        expectUnsafe("C:\\x")
        expectUnsafe("d:/Windows/system32")
        // 盘符后直接跟冒号也算（`Z:` 这种没有路径的写法）
        expectUnsafe("Z:")
    }

    @Test("反斜杠（Windows 风格路径混进来）")
    func backslash() {
        expectUnsafe("a\\b")
        expectUnsafe("..\\x")
        // ⚠️ 这条同时是「tar 八进制转义产物」的形状：
        //    bsdtar 在无 LANG 时输出 `./\344\270\255...`，正是靠这条判据被拦下的。
        //    所以**绝对不能**为了迁就转义输出而放行反斜杠 —— 那是安全判据（见文件头）。
        expectUnsafe("./\\344\\270\\255\\346\\226\\207.txt")
    }

    @Test("控制字符")
    func controlCharacters() {
        expectUnsafe("a\u{0000}b")
        expectUnsafe("a\u{0001}b")
        expectUnsafe("line\nbreak")
        expectUnsafe("tab\there")
        expectUnsafe("\u{007f}")
        expectUnsafe("\u{001f}")
    }

    /// ⚠️ **记录真实行为**：判据只覆盖 Electron 版列的 `U+0000-U+001F` 与 `U+007F`，
    /// **不覆盖** `U+0080-U+009F`（C1 控制区）和 `U+2028`（行分隔符）。
    ///
    /// 为什么不用 `CharacterSet.controlCharacters`：那个集合**比 Electorn 版宽**
    /// （含 C1 区与 U+2028 等），会拒掉一些合法路径 → 与契约判据不一致。
    /// 「照抄那 6 条」的意思是**不擅自加严也不放宽**，所以这里如实记录边界。
    @Test("C1 控制区不在判据范围内（真实行为）")
    func c1ControlCharactersAreAccepted() {
        expectSafe("a\u{0085}b")
        expectSafe("a\u{2028}b")
    }

    @Test("空字符串")
    func emptyString() {
        expectUnsafe("")
    }

    /// 按**字节**判据的理由：组合标记能把 `\` 「粘」进一个更大的字素簇，
    /// 让 `String.contains("\\")` **静默失效**（与 GameIni 的 CRLF 是同一类病：
    /// Swift 的 String 方法按 Character 比较，而字素簇可以吃掉后面的组合标记）。
    ///
    /// 这条测试同时钉两件事：
    ///   ① 我们的判据（字节级）**能**拦住它；
    ///   ② Character 级判据**拦不住** —— 所以为什么不写成 `entry.contains("\\")`。
    @Test("反斜杠被组合标记粘住：字节级能拒，Character 级会漏")
    func backslashWithCombiningMark() {
        // `\` + U+0301（组合尖音符）：一个 Character，字节层面是 0x5C + 0xCC 0x81
        let glued = "a\\\u{0301}b"

        #expect(glued.count == 3, "字素簇层面是 a / \\́ / b 三个字符（组合标记被吃掉了）")
        #expect(glued.utf8.count == 5, "字节层面是 a(1) + \\(1) + U+0301(2) + b(1) = 5 字节")
        #expect(glued.contains("\\") == false,
                "Character 级 contains 匹配不到这个反斜杠 —— 这正是不能用它的理由")

        // 我们的实现能拦住（因为按字节扫）
        expectUnsafe(glued)
    }

    /// `a/../b` 这种中间段穿越也拒（不只看开头和结尾）。
    @Test("`a/../b` 这种中间段穿越也拒")
    func traversalInMiddle() {
        expectUnsafe("a/../b")
        expectUnsafe("c/d/../../e")
    }

    /// ⚠️ **记录真实行为**（不是期望行为）：`..` 后面粘了组合标记，**不是**路径穿越。
    ///
    /// `"..\u{0301}"` 在文件系统里是一个名字叫「两个点加点符号」的**普通文件**，
    /// 不等于 `..`（内核按字节比较路径段，不会把它规范化成父目录）。
    /// 所以按字节判据（段长 ≠ 2）与 Character 级判据（`.` 后面那个不是纯 `.`）
    /// **都不拒绝** —— 这是对的，不是漏。
    @Test("`..` 粘组合标记不算穿越（真实行为）")
    func dottedWithCombiningMarkIsNotTraversal() {
        expectSafe("..\u{0301}/x")
    }
}

// MARK: - 安全校验：放行

@Suite("归档路径安全校验（放行）")
struct AssertSafeEntryAcceptTests {

    @Test("普通相对路径")
    func plainRelative() {
        expectSafe("file.txt")
        expectSafe("dir/file.txt")
        expectSafe("a/b/c/d.bin")
        // tar 的目录条目以 `/` 结尾，也必须是合法的
        expectSafe("dir/")
        expectSafe("./")
        expectSafe(".")
    }
    /// ⚠️ **这一条是本文件最重要的放行测试**：中文名绝不能被判成不安全。
    /// 它守着的是「不要为了 tar 的转义输出而放宽反斜杠判据」这个方向的反面 ——
    /// 正常中文名必须一路绿灯（至于解压链路里怎么保证它不被转义，看下面的往返测试）。
    @Test("中文名与空格")
    func unicodeAndSpaces() {
        expectSafe("游戏目录/启动器.exe")
        expectSafe("中文 空格/文件 名.dat")
        expectSafe("中文 文件名.txt")
        expectSafe("音乐/bgm.ogg")
        // 日文（DLsite 的作品名常见）
        expectSafe("ゲーム/起動.exe")
    }

    @Test("以点开头的合法相对路径（不是 ..）")
    func dotPrefixed() {
        expectSafe(".hidden/file")
        expectSafe("a/./b")
    }

    @Test("文件名里出现 .. 但不是独立路径段")
    func dotsInsideName() {
        expectSafe("file..name.txt")
        expectSafe("a..b/c..d")
        expectSafe("...txt")
    }
}

// MARK: - 环境变量

@Suite("tar 的环境变量")
struct TarEnvTests {

    @Test("三个 UTF-8 locale 变量都必须给")
    func allThreeLocales() {
        let env = Extract.tarEnv(base: ["PATH": "/usr/bin:/bin"])
        #expect(env["LANG"] == "en_US.UTF-8")
        #expect(env["LC_ALL"] == "en_US.UTF-8")
        #expect(env["LC_CTYPE"] == "en_US.UTF-8")
    }

    /// 父环境必须**整体保留**：`Process.environment` 是整体替换，
    /// 只装 LANG 的字典会把 PATH/HOME 一起丢掉（tar 在 mac 上会因此找不到东西）。
    @Test("父环境原样保留")
    func basePreserved() {
        let env = Extract.tarEnv(base: ["PATH": "/usr/bin:/bin", "HOME": "/Users/x", "FOO": "bar"])
        #expect(env["PATH"] == "/usr/bin:/bin")
        #expect(env["HOME"] == "/Users/x")
        #expect(env["FOO"] == "bar")
    }

    @Test("不修改传入的字典（base 是值传入，不能反而污染调用方）")
    func doesNotMutateBase() {
        let base = ["LANG": "C", "LC_ALL": "C"]
        let env = Extract.tarEnv(base: base)
        #expect(base["LANG"] == "C", "base 不该被改写")
        #expect(env["LANG"] == "en_US.UTF-8")
    }

    /// ⚠️ **与 Electron 版的故意偏离**：`LC_ALL` 的优先级**高于** `LANG`，
    /// Electron 版写的是 `process.env.LC_ALL || 'en_US.UTF-8'`（尊重外部值）→
    /// 外部只要有一个 `LC_ALL=C`，塞 UTF-8 的 `LANG` 也救不回来（实测八进制转义）。
    /// 所以 Swift 版**无条件覆盖**。这条测试就是钉这个偏离。
    @Test("宿主有 LC_ALL=C 也必须被覆盖")
    func overridesHostLocale() {
        let env = Extract.tarEnv(base: ["LANG": "C", "LC_ALL": "C", "LC_CTYPE": "C"])
        #expect(env["LANG"] == "en_US.UTF-8")
        #expect(env["LC_ALL"] == "en_US.UTF-8")
        #expect(env["LC_CTYPE"] == "en_US.UTF-8")
    }

    @Test("空串也当没设（不能把空串原样传给 tar）")
    func emptyStringsOverridden() {
        let env = Extract.tarEnv(base: ["LANG": "", "LC_ALL": "", "LC_CTYPE": ""])
        #expect(env["LANG"] == "en_US.UTF-8")
        #expect(env["LC_ALL"] == "en_US.UTF-8")
        #expect(env["LC_CTYPE"] == "en_US.UTF-8")
    }

    @Test("用户自己的 UTF-8 locale 也会被规范化成同一个（判据要可预测）")
    func userUTF8Normalized() {
        let env = Extract.tarEnv(base: ["LANG": "ja_JP.UTF-8", "LC_ALL": "ja_JP.UTF-8"])
        #expect(env["LANG"] == "en_US.UTF-8",
                "我们只关心 tar 输出可预测，不关心用户 locale —— 一切 UTF-8 locale 效果等价")
    }
}

// MARK: - 条目解析（纯函数）

@Suite("tar -tf 输出解析")
struct ListingEntriesTests {

    @Test("普通 LF 输出")
    func lf() {
        let entries = Extract.listingEntries(from: "./a.txt\n./b/c.txt\n")
        #expect(entries == ["./a.txt", "./b/c.txt"])
    }

    /// ⚠️ CRLF 必须正确切行。`split(separator: "\n")` 对 CRLF **只切出 1 行**
    /// （`\r\n` 是一个 Character），这是 `GameIni.swift` 踩过的同一个坑。
    @Test("CRLF 输出")
    func crlf() {
        let entries = Extract.listingEntries(from: "./a.txt\r\n./b.txt\r\n")
        #expect(entries == ["./a.txt", "./b.txt"])
    }

    @Test("空行被丢掉（对应 JS 的 filter(Boolean)）")
    func dropsEmpty() {
        #expect(Extract.listingEntries(from: "\n\n./a\n\n") == ["./a"])
        #expect(Extract.listingEntries(from: "") == [])
    }

    @Test("中文名原样保留")
    func keepsUnicode() {
        #expect(Extract.listingEntries(from: "./中文 文件名.txt\n")
                    == ["./中文 文件名.txt"])
    }
}

// MARK: - 真打包 → 真解包

@Suite("系统 tar 往返")
struct ExtractRoundTripTests {

    /// 造一个带中文名的源目录，打成归档。
    ///
    /// - Parameter env: 跑 `tar -cf` 用的环境。**故意也允许传病态环境** ——
    ///   `-cf` 不受 LANG 影响（实测：包里存的名字始终是原文，用 UTF-8 环境读出来一模一样），
    ///   但这让测试能覆盖「包是别的机器/别的环境打的」这种真实场景。
    private func makeArchive(in tmp: TempDir, env: [String: String]) throws -> String {
        try tmp.write("src/Game.exe", "binary-ish-content")
        try tmp.write("src/data/System.rvdata2", "data-content")
        try tmp.write("src/中文 文件名.txt", "unicode content")
        try tmp.write("src/音乐/bgm.ogg", "audio")

        let archive = tmp.path("bundle.tar")
        let run = runTar(["-cf", archive, "-C", tmp.path("src"), "."], env: env)
        #expect(run.status == 0, "打包失败：\(run.stderr)")
        return archive
    }

    /// ⚠️⚠️ **负对照：先证明「LANG 为空 → 中文名变八进制」这个坑真的在这台机器上。**
    ///
    /// 没有这一条，下面的往返测试就可能是「这台机器恰好有 LANG」而假绿 ——
    /// 而这个坑最要命的地方正是「在别的机器/别的启动方式下才出现」。
    ///
    /// 本机实测（macOS 26.6.2 / bsdtar 3.5.3）：
    ///   · 无 LANG/LC_ALL → `./\344\270\255\346\226\207 \346\226\207\344\273\266\345\220\215.txt`
    ///   · `LANG=en_US.UTF-8` → `./中文 文件名.txt`
    @Test("负对照：LANG 为空时中文名确实会变成八进制转义")
    func bsdtarOctalEscapeReproduced() throws {
        guard Extract.hasSystemTar() else { return }   // 没有 tar 就跳过（§6 的规矩）
        let tmp = TempDir(prefix: "tsmg-p3-escape")
        defer { tmp.cleanup() }

        // 病态环境：只有 PATH，locale 全空 —— 等价于 SSH / Finder 启动 .app 的处境
        let hostile: [String: String] = ["PATH": "/usr/bin:/bin", "LANG": "", "LC_ALL": ""]
        let archive = try makeArchive(in: tmp, env: hostile)

        let raw = runTar(["-tf", archive], env: hostile)
        #expect(raw.status == 0, "tar -tf 失败：\(raw.stderr)")

        // 转义输出的形状是 `./\344\270\255...`：**含反斜杠**，且中文名不见了
        let hasBackslash = raw.stdout.contains("\\")
        let hasRealChinese = raw.stdout.contains("中文 文件名.txt")
        #expect(hasBackslash, "预期无 LANG 时输出八进制转义（含反斜杠），实际：\(raw.stdout)")
        #expect(!hasRealChinese, "预期无 LANG 时看不到原文中文名，实际：\(raw.stdout)")

        // 而这条转义输出会被安全校验拦下 —— 这正是「整包被拒」的机制
        let entries = Extract.listingEntries(from: raw.stdout)
        let rejected = entries.compactMap { entry -> String? in
            do { try Extract.assertSafeEntry(entry); return nil } catch { return entry }
        }
        #expect(!rejected.isEmpty, "预期转义条目被安全判据拒绝（这是老坑的症状）")
    }

    /// **正向：同一套病态环境 + `Extract.tarEnv()` → 中文名完整往返。**
    ///
    /// 这条测试的判据是「文件名正确 + 内容正确」，不是「没抛错」——
    /// 因为老坑的表现是「抛错」，修坏了的表现可能是「不抛错但名字是转义产物」。
    @Test("LANG 为空时，靠 tarEnv 也能完整往返（含中文名）")
    func roundTripWithChineseNamesUnderEmptyLang() throws {
        guard Extract.hasSystemTar() else { return }
        let tmp = TempDir(prefix: "tsmg-p3-roundtrip")
        defer { tmp.cleanup() }

        let hostile: [String: String] = ["PATH": "/usr/bin:/bin", "LANG": "", "LC_ALL": ""]
        let prodEnv = Extract.tarEnv(base: hostile)     // ← 生产口径（与 extractArchive 同一份）
        let archive = try makeArchive(in: tmp, env: prodEnv)

        let destination = tmp.path("deep/nested/out")   // 顺带验「中间层自动创建」
        try Extract.extractArchive(archive: archive, to: destination)

        let fm = FileManager.default
        // 文件名必须**原文**（不是 `\344\270\255...` 那种转义产物）
        let chinesePath = (destination as NSString).appendingPathComponent("中文 文件名.txt")
        #expect(fm.fileExists(atPath: chinesePath), "中文文件名必须原样落地")
        #expect(try String(contentsOfFile: chinesePath, encoding: .utf8) == "unicode content")

        // 其余条目也逐个验（不只验中文那一个）
        let game = (destination as NSString).appendingPathComponent("Game.exe")
        #expect(try String(contentsOfFile: game, encoding: .utf8) == "binary-ish-content")

        let rv = (destination as NSString).appendingPathComponent("data/System.rvdata2")
        #expect(fm.fileExists(atPath: rv))

        let bgm = (destination as NSString).appendingPathComponent("音乐/bgm.ogg")
        #expect(fm.fileExists(atPath: bgm), "中文目录名也必须原样落地")

        // 目录里不该有「转义产物」的残留（防止实现把两种名字都建出来）
        let all = (try? fm.contentsOfDirectory(atPath: destination)) ?? []
        #expect(!all.contains { $0.contains("\\344") })
    }

    /// 不传 locale 的对照组：说明「为什么必须走 tarEnv」——
    /// 这一条**断言失败**是有意义的，它证明修复不可省。
    @Test("对照：不走 tarEnv 时含中文名的包会被判不安全")
    func withoutTarEnvChineseArchiveRejected() throws {
        guard Extract.hasSystemTar() else { return }
        let tmp = TempDir(prefix: "tsmg-p3-nofix")
        defer { tmp.cleanup() }

        // 用病态环境打包（名字在包里仍是原文，见 makeArchive 注释）
        let hostile: [String: String] = ["PATH": "/usr/bin:/bin", "LANG": "", "LC_ALL": ""]
        let archive = try makeArchive(in: tmp, env: hostile)

        // 模拟「修复没接上」：直接拿 hostile 环境列条目，然后按生产判据校验
        let raw = runTar(["-tf", archive], env: hostile)
        let entries = Extract.listingEntries(from: raw.stdout)
        do {
            for entry in entries { try Extract.assertSafeEntry(entry) }
            Issue.record("预期会被判不安全（这正是 tarEnv 存在的理由），实际全过了")
        } catch let error as ExtractError {
            if case .unsafeArchive = error { return }   // 预期
            Issue.record("拒绝理由不对：\(error)")
        }
    }

    @Test("目标目录已存在也能解（往里合并，不报错）")
    func destinationExists() throws {
        guard Extract.hasSystemTar() else { return }
        let tmp = TempDir(prefix: "tsmg-p3-existing")
        defer { tmp.cleanup() }

        try tmp.write("src/a.txt", "x")
        let archive = tmp.path("a.tar")
        #expect(runTar(["-cf", archive, "-C", tmp.path("src"), "."],
                       env: Extract.tarEnv()).status == 0)

        let destination = tmp.path("out")
        try? FileManager.default.createDirectory(atPath: destination, withIntermediateDirectories: true)
        try Extract.extractArchive(archive: archive, to: destination)
        #expect(FileManager.default.fileExists(
            atPath: (destination as NSString).appendingPathComponent("a.txt")))
    }
}

// MARK: - 不安全归档

@Suite("不安全归档必须整包拒绝")
struct UnsafeArchiveTests {

    /// 含 `../evil.txt` 的包 → 拒绝，且**目标目录里一个文件都不该出现**。
    ///
    /// 为什么「一个文件都不该出现」是硬判据而不是洁癖：
    ///   bsdtar 自己也拦路径穿越（实测报 `Path contains '..'`），
    ///   但它**在已经写出包内其它文件之后**才拦（实测同一包里的 `ok.txt` 落进了 dest）。
    ///   用户的游戏目录被半截写入 = 打包失败、目录被污染、下次添加游戏认错引擎。
    ///   所以流程必须是「**先列全量条目 → 全部校验 → 才动手**」（见 Extract.extractArchive）。
    @Test("含 ../ 的包被拒，且目标目录不出现任何文件")
    func traversalArchiveRejected() throws {
        guard Extract.hasSystemTar() else { return }
        let tmp = TempDir(prefix: "tsmg-p3-evil")
        defer { tmp.cleanup() }

        let archive = tmp.path("evil.tar")
        let entries = [
            UstarFixture.Entry(name: "../evil.txt", data: "EVIL"),
            UstarFixture.Entry(name: "ok.txt", data: "OK"),
        ]
        try UstarFixture.build(entries).write(to: URL(fileURLWithPath: archive))

        // 先确认这个包在 tar 眼里是「真能读出 ../」的（否则测试在骗人）
        let listing = runTar(["-tf", archive], env: Extract.tarEnv())
        #expect(listing.status == 0, "手搓的包必须能被 bsdtar 读：\(listing.stderr)")
        #expect(listing.stdout.contains("../evil.txt"), "包里的 ../ 条目必须真的存在")

        let destination = tmp.path("out")
        do {
            try Extract.extractArchive(archive: archive, to: destination)
            Issue.record("含 ../ 的包本该被拒绝，却解压成功了")
        } catch let error as ExtractError {
            guard case .unsafeArchive = error else {
                Issue.record("拒绝理由应是 unsafeArchive，实际：\(error)")
                return
            }
        }

        // ① 目标目录必须**不存在**（校验在 mkdir 之前，恶意包连空目录都不留）
        #expect(!FileManager.default.fileExists(atPath: destination),
                "拒绝路径上不该创建目标目录")

        // ② 包里的普通文件 `ok.txt` 也不能落地（这才是「整包拒」的本意）
        #expect(!FileManager.default.fileExists(
            atPath: (destination as NSString).appendingPathComponent("ok.txt")))

        // ③ 更不能穿越到父目录去
        let escaped = (destination as NSString).deletingLastPathComponent
        #expect(!FileManager.default.fileExists(
            atPath: (escaped as NSString).appendingPathComponent("evil.txt")),
                "../evil.txt 不该写到目标目录之外")
    }

    /// 目标目录**已存在**且里有旧文件时，恶意包也不能动它们。
    @Test("已存在的目标目录不被污染")
    func existingDestinationUntouched() throws {
        guard Extract.hasSystemTar() else { return }
        let tmp = TempDir(prefix: "tsmg-p3-evil2")
        defer { tmp.cleanup() }

        let destination = tmp.path("out")
        try? FileManager.default.createDirectory(atPath: destination, withIntermediateDirectories: true)
        try tmp.write("out/keep.txt", "KEEP")

        let archive = tmp.path("evil.tar")
        try UstarFixture.build([
            UstarFixture.Entry(name: "../evil.txt", data: "EVIL"),
        ]).write(to: URL(fileURLWithPath: archive))

        do {
            try Extract.extractArchive(archive: archive, to: destination)
            Issue.record("本该拒绝")
        } catch let error as ExtractError {
            guard case .unsafeArchive = error else {
                Issue.record("理由应是 unsafeArchive：\(error)")
                return
            }
        }

        // 旧文件仍在、内容没变、没有新增
        #expect(try tmp.read("out/keep.txt") == "KEEP")
        let files = (try? FileManager.default.contentsOfDirectory(atPath: destination)) ?? []
        #expect(files == ["keep.txt"], "拒绝后目标目录里不该有新增文件，实际：\(files)")
    }

    /// 绝对路径条目同样整包拒。
    @Test("绝对路径条目被拒")
    func absoluteEntryRejected() throws {
        guard Extract.hasSystemTar() else { return }
        let tmp = TempDir(prefix: "tsmg-p3-abs")
        defer { tmp.cleanup() }

        let archive = tmp.path("abs.tar")
        try UstarFixture.build([
            UstarFixture.Entry(name: "/etc/evil.conf", data: "EVIL"),
        ]).write(to: URL(fileURLWithPath: archive))

        let listing = runTar(["-tf", archive], env: Extract.tarEnv())
        #expect(listing.stdout.contains("/etc/evil.conf") || listing.stdout.contains("etc/evil.conf"),
                "包里的绝对路径条目必须真的存在：\(listing.stdout)")

        do {
            try Extract.extractArchive(archive: archive, to: tmp.path("out"))
            Issue.record("含绝对路径的包本该被拒绝")
        } catch let error as ExtractError {
            guard case .unsafeArchive = error else {
                Issue.record("理由应是 unsafeArchive：\(error)")
                return
            }
        }
        #expect(!FileManager.default.fileExists(atPath: tmp.path("out")))
    }

    /// ⚠️ **记录真实行为，不是期望行为**：名字里含**字面换行**的条目，
    /// bsdtar 的 `-tf` 会把它输出成 **`\n` 两个字符**（反斜杠 + n），不是真换行。
    ///
    /// 实测（od -c，本机 bsdtar 3.5.3）：
    ///     头里的名字是 `61 0a 62 2e 74 78 74`（真的 0x0A）
    ///     `-tf` 输出却是 `a \ n b . t x t \n` —— 中间那个 `\n` 是**转义文本**，不是换行
    ///
    /// 这跟「LANG 为空时的八进制转义」是**同一条机制**：bsdtar 对**所有不可打印字符**
    /// （非 ASCII 名、换行、控制字符）统一输出反斜杠转义。
    /// 于是：
    ///   · 好处 —— 「拒绝反斜杠」判据**顺带**挡住了「靠换行把恶意路径藏进文件名」这条路；
    ///   · 代价 —— 名字里真有换行的**合法**条目也会被拒（本层接受这个代价：
    ///     游戏包里带换行文件名是极端罕见，而放宽判据等于给路径穿越开门）。
    ///
    /// ⚠️ 与 Electron 版的实际差别：`listingEntries` 是**按字节切行**的（能吃 CRLF），
    ///    所以文件名里那种 `\n` **会**落地成一个真正的换行字符；如果这个名字里还有反斜杠
    ///    （换行名经 tar 转义必然带反斜杠），就会被判 unsafe。
    @Test("名字里的字面换行会被 tar 转义成反斜杠+n，于是整条被拒（真实行为）")
    func newlineNameIsEscapedThenRejected() throws {
        guard Extract.hasSystemTar() else { return }
        let tmp = TempDir(prefix: "tsmg-p3-newline")
        defer { tmp.cleanup() }

        let archive = tmp.path("nl.tar")
        try UstarFixture.build([
            UstarFixture.Entry(name: "a\nb.txt", data: "Z"),
            UstarFixture.Entry(name: "plain.txt", data: "P"),
        ]).write(to: URL(fileURLWithPath: archive))

        let listing = runTar(["-tf", archive], env: Extract.tarEnv())
        #expect(listing.status == 0, "\(listing.stderr)")

        let entries = Extract.listingEntries(from: listing.stdout)
        // 实测：2 条，第一条是 `a\nb.txt`（反斜杠 + n 的字面量，不是真换行）
        #expect(entries.count == 2, "实际条目：\(entries)")
        #expect(entries[0] == "a\\nb.txt",
                "换行被转义成字面 `\\n` 两个字符，实际：\(entries[0])")
        #expect(!entries[0].contains("\n"), "输出里不该有真正的换行")

        // 关键结论：转义产物**含反斜杠** → 被安全判据拒（整包拒）
        do {
            try Extract.extractArchive(archive: archive, to: tmp.path("out"))
            Issue.record("含换行名的包实测会被判不安全，却解压成功了")
        } catch let error as ExtractError {
            guard case .unsafeArchive = error else {
                Issue.record("理由应是 unsafeArchive：\(error)")
                return
            }
        }
        #expect(!FileManager.default.fileExists(atPath: tmp.path("out")))
    }

    /// 反面：想用「换行把 `../` 藏起来」也绕不过去 ——
    /// 转义后整条变成 `a\n../evil`，含反斜杠 → 当场拒。
    @Test("换行藏穿越绕不过判据")
    func newlineSplitCannotBypassTraversal() throws {
        guard Extract.hasSystemTar() else { return }
        let tmp = TempDir(prefix: "tsmg-p3-newline2")
        defer { tmp.cleanup() }

        let archive = tmp.path("nl2.tar")
        try UstarFixture.build([
            UstarFixture.Entry(name: "a\n../evil", data: "E"),
        ]).write(to: URL(fileURLWithPath: archive))

        let listing = runTar(["-tf", archive], env: Extract.tarEnv())
        let entries = Extract.listingEntries(from: listing.stdout)
        #expect(entries.count == 1, "实际条目：\(entries)")
        // 转义后整条含反斜杠 —— 这是被拒的直接原因
        #expect(entries[0].contains("\\"), "实测应含转义出的反斜杠：\(entries[0])")

        do {
            try Extract.extractArchive(archive: archive, to: tmp.path("out"))
            Issue.record("本该被拒")
        } catch let error as ExtractError {
            guard case .unsafeArchive = error else {
                Issue.record("理由应是 unsafeArchive：\(error)")
                return
            }
        }
    }
}

// MARK: - 其他失败路径

@Suite("解压失败路径")
struct ExtractFailureTests {

    @Test("压缩包不存在 → archiveNotFound（而不是 unsafeArchive）")
    func missingArchive() {
        do {
            try Extract.extractArchive(archive: "/definitely/not/here.tar", to: "/tmp/tsmg-out")
            Issue.record("本该抛 archiveNotFound")
        } catch let error as ExtractError {
            guard case .archiveNotFound(let archive) = error else {
                Issue.record("种类应是 archiveNotFound，实际：\(error)")
                return
            }
            #expect(archive == "/definitely/not/here.tar")
        } catch {
            Issue.record("抛了非 ExtractError：\(error)")
        }
    }

    /// 不是 tar 的文件 → `extractFailed`（带 tar 的原话），**不是** unsafeArchive。
    /// 两者处境不同：前者「这个文件坏了」，后者「这个包想动我的文件」。
    @Test("不是归档 → extractFailed，且带上 tar 的原话")
    func notAnArchive() throws {
        guard Extract.hasSystemTar() else { return }
        let tmp = TempDir(prefix: "tsmg-p3-bad")
        defer { tmp.cleanup() }

        let notTar = tmp.path("fake.tar")
        try "not a tar at all".write(toFile: notTar, atomically: true, encoding: .utf8)

        do {
            try Extract.extractArchive(archive: notTar, to: tmp.path("out"))
            Issue.record("本该抛 extractFailed")
        } catch let error as ExtractError {
            guard case .extractFailed(let message) = error else {
                Issue.record("种类应是 extractFailed，实际：\(error)")
                return
            }
            #expect(message.contains("Unrecognized archive format") || message.contains("tar"),
                    "失败消息应带上 tar 的原话，实际：\(message)")
        }
        // 校验都失败到列目录这一步了，目标目录也不该被建出来
        #expect(!FileManager.default.fileExists(atPath: tmp.path("out")))
    }

    @Test("错误消息是中文且能区分三种处境")
    func errorMessagesAreDistinct() {
        let unsafe = ExtractError.unsafeArchive(entry: "../x").message
        let missing = ExtractError.archiveNotFound(archive: "/a.tar").message
        let failed = ExtractError.extractFailed(message: "boom").message

        #expect(unsafe.contains("不安全"))
        #expect(missing.contains("找不到"))
        #expect(failed.contains("失败"))
        #expect(unsafe != missing)
        #expect(missing != failed)

        // localizedDescription 走同一句（LocalizedError 的 errorDescription）
        #expect(ExtractError.unsafeArchive(entry: "../x").localizedDescription == unsafe)
    }

    @Test("tar 二进制路径是本机的 /usr/bin/tar，且可执行")
    func tarBinaryUsable() {
        #expect(Extract.tarPath == "/usr/bin/tar")
        #expect(Extract.hasSystemTar(), "macOS 一定有 /usr/bin/tar；没有说明环境异常")
    }

    @Test("stderr 摘要不会把几十行全塞进错误气泡")
    func summarizeKeepsItShort() {
        let many = (1...20).map { "warning line \($0)" }.joined(separator: "\n")
        let summary = Extract.summarize(many)
        #expect(summary.contains("warning line 20"), "要留下最后（最关键）那几行")
        #expect(!summary.contains("warning line 1\n"), "不该把前面几十行全带上")
        #expect(summary.count <= 420)

        #expect(Extract.summarize("") == "（tar 没有输出错误信息）")
    }
}
