// 解压层：系统 bsdtar（macOS 是 `/usr/bin/tar`，本身就是 bsdtar）的安全解压。
//
// 对应 Electron 版：src/main/extract.ts（136 行）
// 契约：docs/M1-实施方案.md §4（extract.ts 行）与 §6（extract 测试）
//
// ===== 流程（与 Electron 版一字不差，顺序有理由）=====
//
//   ① `tar -tf <archive>` 列出**全部**条目 → 逐条 `assertSafeEntry` 校验
//   ② 全部过关 → 建 destination（含中间层）→ `tar -xf <archive> --no-same-owner -C <dest>`
//
// 为什么必须「先列再解」、而不是「解出来再查」：
//   bsdtar 自己也拦路径穿越（实测：`../evil.txt: Path contains '..': Unknown error: -1`），
//   但那个拦截**发生在它已经开始写包内其它文件之后**（实测同一个包里的 `ok.txt` 会被写进 dest）。
//   我们要的语义是「**在动一个字节之前**就把整个包拒掉」——「目标目录里一个文件都不该出现」
//   是测试里的硬断言，也是给用户的承诺（他的游戏目录不该被半截写入）。
//
// ===== 本文件唯一真坑：bsdtar 在 LANG 为空时把非 ASCII 名转成八进制转义 =====
//
// 症状（本机实测，Mac / macOS 26.6.2 / bsdtar 3.5.3，2026-11-06）：
//
//      $ env -i /usr/bin/tar -tf b.tar        # 没有任何 LANG/LC_ALL/LC_CTYPE
//      ./
//      ./\344\270\255\346\226\207 \346\226\207\344\273\266\345\220\215.txt
//      ./Game.exe
//
//   「中文 文件名.txt」变成了 `\344\270\255...`。而 `assertSafeEntry` 有一条
//   **「拒绝反斜杠」的安全判据**（防 Windows 风格路径穿越）→ **含中文名的包整包被拒**。
//
// 触发条件极隐蔽：**SSH 会话 / launchctl / Finder 启动的 .app 里 LANG 常常是空的**
//   （本机 ssh 会话实测 `LANG=[] LC_ALL=[] LC_CTYPE=[]`、`TERM=dumb`），
//   而用户在终端里手跑（拿到 shell 的登录环境）反而正常 → 「我这儿好的」。
//   我们自己的探针、CI、以及打包后由 Finder 启动的 .app 全都在故障集合里。
//
// ⚠️ **绝对不要为此放行反斜杠判据**：那是安全判据，放行等于给 Windows 路径穿越开门。
//    转义是 tar 的**输出格式问题**，该在输入侧修（让 tar 输出原文）。
//
// ⚠️ 这个坑**只打在 `-tf` 的 stdout 解析上**，不在解压本身：
//    实测包里存的名字仍是原文（用 UTF-8 环境 `-tf` 或读 tar 头都能看到），
//    在无 LANG 环境下 `-xf` 解出来的文件名也是正确的中文。
//    → 所以「解压失败」这个描述是错的，真相是「安全校验被 tar 的输出格式骗了」。
//
// ⚠️ ASCII 名永远测不出这个坑：实测无 LANG 时 `./Game.exe`、`./` 一切正常，
//    只有非 ASCII 名被转义 → Windows/Linux 全绿、CI 也可能全绿，这就是它活下来的原因。
//
// ===== 同一条机制的另一面：换行 / 控制字符也会被转义（实测，不是推测）=====
//
// bsdtar 的 `-tf` 对**所有不可打印字符**统一输出反斜杠转义，不只是非 ASCII：
// 名字里含真换行（头里是字节 0x0A）的条目，输出是 `a\nb.txt` —— **反斜杠 + 字母 n 两个字符**，
// 不是真换行（od -c 验过）。
//
// 这带来一个很值得记住的副作用：**「拒绝反斜杠」这条判据顺带挡住了
// 「靠换行把 `../` 藏进文件名」这条攻击**（转义后整条必然含反斜杠 → 当场拒）。
// 代价是名字里真有换行的**合法**条目也会被拒 —— 本层接受：
// 游戏包里带换行文件名极端罕见，而放宽判据等于给路径穿越开门。
// 判据落在 `P3ExtractTests.newlineNameIsEscapedThenRejected`。
//
// ===== 非 UTF-8 文件名的真实行为（实测，别以为能靠 latin1 兜底救回来）=====
//
// 归档里如果有 gbk / latin1 编码的文件名（老 Windows 工具打的包很常见）：
//   · `-tf` 输出是**原始字节**（不转义），拿 latin1 解码能读到可读文本 → 校验层看不出问题
//   · 但 `-xf` 在 UTF-8 locale 下会**直接失败**：
//     `café.txt: Can't create 'café.txt': Illegal byte sequence`（退出码非 0）
//   · → 所以那种包会走到 `.extractFailed`，而不是静默建出一堆乱码文件
// 这是个**可接受**的结果：报错并告诉用户，比悄悄弄乱文件名好。
// （要根治得先 re-encode 包内名字，那超出本层职责，也超出 Electron 版的判据。）
//
// ===== ⚠️ 与 Electron 版的**故意偏离**：locale 必须无条件强制，不能尊重外部值 =====
//
// Electron 版写的是 `LC_ALL: process.env.LC_ALL || 'en_US.UTF-8'`（尊重外部已设的值）。
// 本机实测这条**有漏**：`LC_ALL` 的优先级**高于** `LANG`，外部只要有一个 `LC_ALL=C`
// （或 `LC_CTYPE=C`），我们给 `LANG` 塞 UTF-8 也救不回来：
//
//      LANG=en_US.UTF-8                  → 原文        ✅
//      LC_ALL=en_US.UTF-8                → 原文        ✅
//      LC_CTYPE=en_US.UTF-8              → 原文        ✅
//      LANG=en_US.UTF-8 + LC_ALL=C       → **八进制**  ❌  ← Electron 版过不了这条
//      LANG=en_US.UTF-8 + LC_CTYPE=C     → **八进制**  ❌
//      LANG=C                            → 八进制
//      （空串 LANG/LC_ALL）              → 八进制
//
// 所以 Swift 版**三个变量一律覆盖**，不看外部值：我们要的是「tar 的输出可预测」，
// 而「尊重用户 locale」在这条链上没有价值（我们只解析路径、不显示给用户看 locale 相关的东西）。
// 这条依据来自实测，不是猜的 —— 表在 `P3ExtractTests.tarEnvOverridesHostLocale`。
import Foundation

// MARK: - 错误类型

/// 解压层的失败原因（对应 Electron 版的 i18n key 语义）。
///
/// ⚠️ 三者必须分开，不能糊成一句「解压失败」：
///   · `unsafeArchive` —— 包是恶意/损坏的，**拒了**（该告诉用户这个包不能解）
///   · `archiveNotFound` —— 我们这边找错文件（该告诉用户去检查下载/路径）
///   · `extractFailed` —— tar 自己报错（该把 tar 的原话给用户看）
/// 糊在一起的结果是用户永远查不出是哪一环出的问题（D36 同一取向）。
public enum ExtractError: Error, LocalizedError, Sendable, Equatable {

    /// 归档里某条路径不安全。`entry` 是触发拒绝的原始条目（排障用）。
    case unsafeArchive(entry: String)
    /// 压缩包文件不存在。
    case archiveNotFound(archive: String)
    /// tar 执行失败。`message` 里带 tar 自己的 stderr 尾巴。
    case extractFailed(message: String)

    /// 给人看的中文说明（UI 直接显示）。
    public var message: String {
        switch self {
        case .unsafeArchive(let entry):
            return "压缩包里的路径不安全：\(entry)"
        case .archiveNotFound(let archive):
            return "找不到压缩包：\(archive)"
        case .extractFailed(let message):
            return "解压失败：\(message)"
        }
    }

    /// `LocalizedError`：让 `error.localizedDescription` 与 UI 拿到同一句中文。
    public var errorDescription: String? { message }
}

// MARK: - 解压

public enum Extract {

    /// 系统 bsdtar 的绝对路径。
    ///
    /// macOS 的 `/usr/bin/tar` 就是 bsdtar（**不是** GNU tar）—— 这是本地唯一的 tar，
    /// 不查 PATH（PATH 上可能有 brew 装的 GNU tar，行为不一样）。
    public static let tarPath = "/usr/bin/tar"

    /// 强制给 tar 用的 UTF-8 locale（见文件头「与 Electron 版的故意偏离」）。
    public static let utf8Locale = "en_US.UTF-8"

    /// 本机有没有可用的 tar（测试里决定 skip / 做守卫）。
    public static func hasSystemTar() -> Bool {
        FileManager.default.isExecutableFile(atPath: tarPath)
    }

    // MARK: 路径安全校验（纯函数）

    /// 单条归档路径的安全校验。
    ///
    /// 纯函数、不碰磁盘，所以可以无成本地对几千条条目逐条调用，也便于单测直接钉判据。
    ///
    /// 判据（严格照抄 Electron 版，一条都不能少，顺序也保持一致）：
    ///   1. 空 → 拒
    ///   2. 含控制字符（`U+0000`-`U+001F`、`U+007F`）→ 拒
    ///   3. 含反斜杠 `\` → 拒（防 Windows 风格路径穿越 / 也挡住 tar 的八进制转义输出）
    ///   4. 以 `/` 开头（绝对路径）→ 拒
    ///   5. 匹配 `^[A-Za-z]:`（盘符绝对路径）→ 拒
    ///   6. 按 `/` 切开后，非空段里有 `..` → 拒
    ///
    /// 放行：普通相对路径、中文/空格名、`.` 开头（`.hidden`、`a/./b`）、
    /// 文件名里含 `..` 但不是独立段（`file..name.txt`）。
    ///
    /// - Parameter entry: 归档里的一条路径（tar 输出的一行，未做任何清洗）。
    /// - Throws: 不安全时抛 `.unsafeArchive(entry:)`。
    ///
    /// ⚠️ **为什么判据全走 `entry.utf8`（字节层面）而不是 `String.hasPrefix` / `split(separator:)`**
    ///
    /// 这跟 `GameIni.swift` 里那条 CRLF 是**同一类病**：Swift 的 `String` 方法按
    /// **Character（字素簇）** 比较，而字素簇可以被组合标记「粘走」——
    /// 拿 `/` 来说：`/` 后面跟一个组合标记（U+0301 之类）就合成**一个** Character，
    /// 于是：
    ///   · `entry.contains("\\")` 匹配不到那个反斜杠（判据 3 静默失效）
    ///   · `split(separator: "/")` 切不开（判据 6 静默失效）
    /// 一个恶意条目只要在路径段之间塞组合标记，就能让整条安全判据变成摆设，而且**不报错**。
    /// 按 UTF-8 字节判（0x2F = `/`、0x5C = `\`、0x2E = `.`）就完全绕开字素簇 —— 字节没有「组合」这回事。
    ///
    /// 附带好处：判据只涉及 `< 0x80` 的字节，而 latin1 与 UTF-8 在 ASCII 区间**字节完全一致**，
    /// 所以就算 tar 输出的是非 UTF-8 名（我们用 latin1 兜底解码，见 `runTar`），
    /// 这套判据的结论也一模一样 —— 不存在「换一种解码就判据失灵」的窗口。
    public static func assertSafeEntry(_ entry: String) throws {
        let bytes = Array(entry.utf8)

        // 1. 空
        guard !bytes.isEmpty else {
            throw ExtractError.unsafeArchive(entry: entry)
        }

        // 2. 控制字符（U+0000-U+001F 与 U+007F）
        //
        // ⚠️ 不用 `CharacterSet.controlCharacters`：那个集合比这里**宽**
        //    （还含 U+0080-U+009F 与 U+2028 等），会拒掉一些合法路径 → 与 Electron 版判据不一致。
        //    要的是「照抄那 6 条」，不是「顺手更严格」。
        for byte in bytes where byte < 0x20 || byte == 0x7F {
            throw ExtractError.unsafeArchive(entry: entry)
        }

        // 3. 反斜杠（既是 Windows 路径穿越，也是 tar 八进制转义那种输出）
        for byte in bytes where byte == 0x5C {
            throw ExtractError.unsafeArchive(entry: entry)
        }

        // 4. 绝对路径（以 `/` 开头）
        if bytes[0] == 0x2F {
            throw ExtractError.unsafeArchive(entry: entry)
        }

        // 5. 盘符绝对路径（`^[A-Za-z]:`）
        if bytes.count >= 2,
           isASCIIAlpha(bytes[0]),
           bytes[1] == 0x3A {          // ':'
            throw ExtractError.unsafeArchive(entry: entry)
        }

        // 6. `..` 段
        //
        // 「空段不参与」对应 Electron 版的 `.split('/').filter(Boolean)`：
        // `a//b` 里的空段、`/` 开头留下的空段都不算段，所以只看**非空**段。
        // 只看完整的 `..` 段 —— `file..name.txt` / `a..b` 是合法文件名，不能误伤。
        for segment in bytes.split(separator: 0x2F, omittingEmptySubsequences: true) {
            if segment.count == 2, segment[segment.startIndex] == 0x2E,
               segment[segment.startIndex + 1] == 0x2E {
                throw ExtractError.unsafeArchive(entry: entry)
            }
        }
    }

    // MARK: 环境变量

    /// 给 tar 子进程用的环境变量 —— **必须显式带上 UTF-8 locale**。
    ///
    /// 父进程的环境（`base`）**整体保留**再覆盖：`PATH` / `HOME` / `USER` 这些 tar 要用，
    /// 丢给 tar 一个「只有 LANG」的空环境会让它找不到东西。
    ///
    /// ⚠️ `Process.environment` 的语义是**整体替换**（设了就不再继承），
    ///    所以「显式覆盖」的正确写法永远是「先拷父环境，再改要改的键」——
    ///    不能新建一个只装 LANG/LC_ALL 的字典（那样等于把 PATH 一起丢了）。
    ///
    /// - Parameter base: 要继承的环境变量。生产传默认值（当前进程环境）；
    ///   测试传自己的字典，用来构造「LANG 为空 / LC_ALL=C」这类病态输入。
    /// - Returns: 覆盖后的新字典（不修改 `base`）。
    ///
    /// 三个变量都设、且都**不看外部值**的理由见文件头「与 Electron 版的故意偏离」。
    /// `LC_CTYPE` 也设：实测它单独就能决定 bsdtar 是否转义，而 `LC_ALL` 又会盖掉它，
    /// 只设两个留一个缺口实在不值得 —— 三条的代价是三次字典赋值。
    public static func tarEnv(base: [String: String] = ProcessInfo.processInfo.environment)
        -> [String: String] {
        var env = base
        env["LANG"] = utf8Locale
        env["LC_ALL"] = utf8Locale
        env["LC_CTYPE"] = utf8Locale
        return env
    }

    // MARK: 解压

    /// 把 `archive` 解压到 `destination`。
    ///
    /// 流程（顺序有意义，别调换）：
    ///   1. archive 必须存在（不存在抛 `.archiveNotFound`）
    ///   2. `tar -tf` 列全部条目 → 逐条 `assertSafeEntry`（有任何一条不安全 → 整个包拒）
    ///   3. 才建 destination（含中间层）——**放在校验之后**，恶意包连空目录都不留
    ///   4. `tar -xf <archive> --no-same-owner -C <dest>`（带 `tarEnv()` 的环境）
    ///
    /// - Parameters:
    ///   - archive: 压缩包路径（tar/tgz 都行，由 bsdtar 自己认格式）。
    ///   - destination: 解压目标目录。**不存在会被创建**（含中间层）；已存在则往里合并。
    /// - Throws: `ExtractError`。不抛任何别的错误类型（`Process` 的抛错也在这里收拢）。
    ///
    /// ⚠️ `--no-same-owner` 的位置**不是一个具体参数位**，而是 `-xf archive` 之后、`-C dest` 之前：
    ///    本机实测 `tar -xf x.tar --no-same-owner -C dest` 正常工作（两次都验过，含无 LANG 环境）。
    ///    加它的理由：解压时不要把归档里的 uid/gid 落到用户磁盘上（普通用户本来也没权限，
    ///    但 bsdtar 会**警告**并让退出码变得不可靠）。mac 才有，Windows 的 tar.exe 不加（§8 已知坑）。
    public static func extractArchive(archive: String, to destination: String) throws {
        guard FileManager.default.fileExists(atPath: archive) else {
            throw ExtractError.archiveNotFound(archive: archive)
        }

        let env = tarEnv()

        // ---- 1. 先列全部条目 ----
        //
        // 一次拿完整清单再校验，**不能一边列一边解**：那样校验到第 N 条时前面 N-1 条已经落地了。
        let listing = runTar(["-tf", archive], env: env)
        guard listing.status == 0 else {
            throw ExtractError.extractFailed(
                message: "列出条目失败（tar 退出码 \(listing.status)）："
                    + summarize(listing.stderr))
        }

        for entry in listingEntries(from: listing.stdout) {
            try assertSafeEntry(entry)
        }

        // ---- 2. 校验全过，才建目录 ----
        do {
            try FileManager.default.createDirectory(
                atPath: destination, withIntermediateDirectories: true)
        } catch {
            throw ExtractError.extractFailed(
                message: "创建目标目录失败：\(error.localizedDescription)")
        }

        // ---- 3. 解压 ----
        var args = ["-xf", archive]
        args.append("--no-same-owner")
        args += ["-C", destination]

        let result = runTar(args, env: env)
        guard result.status == 0 else {
            throw ExtractError.extractFailed(
                message: "tar 退出码 \(result.status)：\(summarize(result.stderr))")
        }
    }

    // MARK: - 内部：跑 tar

    /// 跑一次 tar，返回 stdout / stderr / 退出码。
    ///
    /// - Parameters:
    ///   - args: tar 的参数（不含 tar 自身路径）。
    ///   - env: **必须**传 `tarEnv()` 的结果 —— 传空/漏 locale 会让中文名变成八进制转义，
    ///     于是 `assertSafeEntry` 把正常包判成恶意（见文件头）。
    ///
    /// ⚠️ 读管道的顺序不能反：**先 `readDataToEndOfFile()` 读 stdout 到 EOF，再 `waitUntilExit()`**。
    ///    反过来（先 wait 再读）在输出大于管道缓冲（约 64KB）时**死锁** ——
    ///    子进程卡在写、父进程卡在等它退出，两边都不动。`tar -tf` 对大包很容易超过 64KB。
    ///
    /// ⚠️ stderr 用 Pipe 而不是 nullDevice：失败时 tar 的原话是排障唯一的线索
    ///    （「Path contains '..'」和「Unrecognized archive format」要能区分开）。
    ///    代价是理论上「tar 往 stderr 狂写 >64KB」会卡住 —— 实测 tar 的错误输出只有几行，
    ///    这里接受这个边界（真要防得给 stderr 单开一个线程去读，不值得）。
    private static func runTar(_ args: [String], env: [String: String])
        -> (stdout: String, stderr: String, status: Int32) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: tarPath)
        process.arguments = args
        process.environment = env

        let outPipe = Pipe()
        let errPipe = Pipe()
        process.standardOutput = outPipe
        process.standardError = errPipe

        do {
            try process.run()
        } catch {
            // `Process.run()` 对「可执行文件不存在」是**同步抛错**（不像 Node 是异步 error 事件）。
            // tar 不在时走到这里，按「解压失败」而不是「压缩包不安全」报 —— 两者处境不同。
            return ("", "无法启动 tar（\(tarPath)）：\(error.localizedDescription)", 127)
        }

        let outData = outPipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let errData = errPipe.fileHandleForReading.readDataToEndOfFile()

        return (decode(outData), decode(errData), process.terminationStatus)
    }

    /// 把 tar 的输出字节解码成文本。
    ///
    /// 先试 UTF-8；失败回落 **latin1**（单字节编码，任何字节都能解码，永不失败）。
    ///
    /// ⚠️ 回落不是为了「凑合能读」，是为了**不因为解码失败就放行**：
    ///    如果归档里有非 UTF-8 的文件名，UTF-8 解码会得到 nil；若此时返回空串，
    ///    就等于「一条条目都没校验」→ 整个包静默放行。latin1 是安全的兜底：
    ///    `assertSafeEntry` 的判据只涉及 ASCII 字节，latin1 视图下的结论与原文一致。
    private static func decode(_ data: Data) -> String {
        String(data: data, encoding: .utf8)
            ?? String(data: data, encoding: .isoLatin1)
            ?? ""
    }

    /// 把 `tar -tf` 的输出切成条目列表（空行丢掉，对应 Electron 的 `.filter(Boolean)`）。
    ///
    /// ⚠️ **不用 `components(separatedBy: .newlines)`，也不用 `split(separator: "\n")`**：
    ///    后者对 CRLF 只切出 1 行（`\r\n` 是**一个** Character，`"\n"` 匹配不到），
    ///    这是 `GameIni.swift` 里踩过的同一个坑。这里按**字节**切（0x0A / 0x0D），
    ///    字素簇再也不会影响结果。
    ///    （tar 的 `-tf` 输出正常是 LF，但这条不依赖「正常」—— 判据不该建立在对手行为良好的假设上。）
    static func listingEntries(from text: String) -> [String] {
        var entries: [String] = []
        var current: [UInt8] = []

        func flush() {
            if !current.isEmpty {
                entries.append(String(decoding: current, as: UTF8.self))
                current.removeAll(keepingCapacity: true)
            }
        }

        for byte in text.utf8 {
            if byte == 0x0A || byte == 0x0D {   // \n / \r
                flush()
            } else {
                current.append(byte)
            }
        }
        flush()
        return entries
    }

    /// 把 tar 的 stderr 压成一行可读的尾巴（UI 显示用）。
    ///
    /// 只取最后 3 行 + 截断：tar 有时会刷几十行警告，全塞进错误气泡里会把真正的那句埋掉。
    static func summarize(_ stderr: String) -> String {
        let lines = stderr
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        guard !lines.isEmpty else { return "（tar 没有输出错误信息）" }

        let tail = lines.suffix(3).joined(separator: " | ")
        return tail.count > 400 ? String(tail.prefix(400)) + "…" : tail
    }

    /// ASCII 字母（盘符判据用）。
    ///
    /// 手写而不是 `Character.isLetter`：后者对非 ASCII 字母也返回 true，
    /// 会把 `中:` 这种条目当成盘符（虽然无害，但判据要与 Electron 的 `[A-Za-z]` 严格一致）。
    private static func isASCIIAlpha(_ byte: UInt8) -> Bool {
        (byte >= 0x41 && byte <= 0x5A) || (byte >= 0x61 && byte <= 0x7A)
    }
}
