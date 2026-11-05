// P3 版本比较 + 依赖下载的测试。
//
// 对应 Electron 版：test/engines-semver.test.ts（26 条）+ test/engines-install-update.test.ts
// 的架构选择/下载部分。
//
// ===== 本文件的三条纪律 =====
//
// ① **下载测试绝不联网**。
//    下载器的「网络层」是 `DownloadTransport` 协议，测试注入 `ScriptedTransport`。
//    这样 HTTP 404 / 取消 / 进度 这些**真判据**都在测试里跑过，
//    而不是用假实现绕过去假装覆盖。
//
// ② **版本比较按 Electron 版的 26 条逐条等价**，外加几条 mac 侧的真实边界。
//    对应关系在每条注释里写，改实现时知道哪条不能动。
//
// ③ **nwjs 版本目录的排序行为不能变**。
//    `LaunchCheck.resolveNwjsVersion` 用 `dirs.max { compareVersions($0,$1) < 0 }`；
//    把简陋实现换成 Semver 之后，给同样的目录名必须选出同一个。这条单独钉住。
import Foundation
import Testing

@testable import TsumigeyaNative

// MARK: - 版本号：normalize / parse

@Suite("版本号 normalize")
struct SemverNormalizeTests {

    /// 对应 Electron 版 `S1 normalizeVersion：剥前导 v` 前两条。
    @Test("v / V 前缀都剥，大小写不影响")
    func stripsPrefix() {
        #expect(Semver.normalize("v0.106.1") == "0.106.1")
        #expect(Semver.normalize("V1.4.4") == "1.4.4")
        #expect(Semver.normalize("  1.4.4  ") == "1.4.4")
    }

    /// 没有前缀原样返回；nil 变空串（上游 `String(value ?? '')`）。
    @Test("没有前缀原样返回；nil 变空串")
    func noPrefix() {
        #expect(Semver.normalize("1.4.4") == "1.4.4")
        #expect(Semver.normalize(nil) == "")
        #expect(Semver.normalize("") == "")
    }

    /// ⚠️ 上游用的正则是 `^[vV]`（不是 `^[vV]+`），所以只剥一层。
    @Test("只剥开头一个 v（vv1.0 → v1.0）")
    func stripsOnlyOne() {
        #expect(Semver.normalize("vv1.0") == "v1.0")
    }
}

@Suite("版本号 parse")
struct SemverParseTests {

    /// 正式版没有 pre 段 —— 这是「正式版 vs 预发布版」的唯一信号。
    @Test("正式版没有 pre，预发布版有")
    func coreOnly() {
        let plain = Semver.parse("1.2.3")
        #expect(plain.core == [.number(1), .number(2), .number(3)])
        #expect(plain.pre == nil)

        let pre = Semver.parse("1.2.3-beta.1")
        #expect(pre.core == [.number(1), .number(2), .number(3)])
        #expect(pre.pre == [.text("beta"), .number(1)])
    }

    /// build metadata 被截掉（semver 规定不参与排序）。
    @Test("build metadata 被截掉")
    func stripsBuild() {
        let parsed = Semver.parse("1.2.3+build.9")
        #expect(parsed.core == [.number(1), .number(2), .number(3)])
        #expect(parsed.pre == nil)
    }

    /// 空段的落点：`1..2` 的第二段按 0。
    @Test("空段按 0")
    func emptySegment() {
        let parsed = Semver.parse("1..2")
        #expect(parsed.core == [.number(1), .number(0), .number(2)])
    }
}

// MARK: - 版本号：数字段

@Suite("版本号比较：数字段")
struct SemverNumericTests {

    @Test("大小关系与返回三元值")
    func ordering() {
        #expect(compareVersions("1.0.0", "1.0.1") == -1)
        #expect(compareVersions("1.0.1", "1.0.0") == 1)
        #expect(compareVersions("1.0.0", "1.0.0") == 0)
    }

    /// 位数不等时缺段补 0 —— 上游 manifest 里 `8.5` 与 `8.5.2` 混着出现。
    @Test("位数不等时缺段补 0")
    func padsMissingSegments() {
        #expect(compareVersions("1.2", "1.2.0") == 0)
        #expect(compareVersions("1.2", "1.2.1") == -1)
        #expect(compareVersions("1.2", "1.3") == -1)
    }

    /// 真实形态：nwjs 依赖名带 v，manifest 的 version 不带 v。
    @Test("带 v 与不带 v 相等")
    func vPrefixEquivalent() {
        #expect(compareVersions("v0.106.1", "0.106.1") == 0)
        #expect(compareVersions("1.4.4", "v1.4.5") == -1)
    }

    /// 逐个比数值，不是字符串比（`10 > 9`）。
    @Test("多段数字逐个比")
    func numericNotLexical() {
        #expect(compareVersions("1.10.0", "1.9.0") == 1)
        #expect(compareVersions("1.2.10", "1.2.9") == 1)
    }

    /// 前导零按数值（上游 `Number('01')` 是 1）。
    @Test("前导零按数值")
    func leadingZeros() {
        #expect(compareVersions("1.01", "1.1") == 0)
    }
}

// MARK: - 版本号：预发布段

@Suite("版本号比较：预发布段")
struct SemverPrereleaseTests {

    /// 正式版压过同核心的预发布版。
    @Test("正式版大于同核心的预发布版")
    func releaseBeatsPrerelease() {
        #expect(compareVersions("1.0.0", "1.0.0-beta.1") == 1)
        #expect(compareVersions("1.0.0-beta.1", "1.0.0") == -1)
        #expect(compareVersions("1.0.0-rc.1", "1.0.0") == -1)
    }

    /// 字符串段按码位比（semver 的 ASCII 排序）。
    @Test("预发布标识符按码位比")
    func textualOrder() {
        #expect(compareVersions("1.0.0-beta", "1.0.0-rc") == -1)
        #expect(compareVersions("1.0.0-alpha", "1.0.0-beta") == -1)
    }

    @Test("预发布里的数字段按数值比")
    func numericInsidePrerelease() {
        #expect(compareVersions("1.0.0-beta.2", "1.0.0-beta.10") == -1)
        #expect(compareVersions("1.0.0-beta.1", "1.0.0-beta.2") == -1)
    }

    /// semver §11.4.4：前缀全等时段数少的更小。
    @Test("前缀相同、段数少的更小")
    func fewerSegmentsSmaller() {
        #expect(compareVersions("1.0.0-beta", "1.0.0-beta.1") == -1)
        #expect(compareVersions("1.0.0-beta.1", "1.0.0-beta.1.1") == -1)
    }

    /// semver §11.4.3：数字型标识符小于字符串型。
    @Test("预发布里数字段大于字符串段")
    func numericBeatsText() {
        #expect(compareVersions("1.0.0-1", "1.0.0-alpha") == 1)
    }

    @Test("核心段不同时先比核心段")
    func coreFirst() {
        #expect(compareVersions("1.0.1-beta", "1.0.0") == 1)
        #expect(compareVersions("0.9.9", "1.0.0-beta") == -1)
    }
}

// MARK: - 版本号：非数字段与脏值

@Suite("版本号比较：非数字段与脏值")
struct SemverDirtyInputTests {

    @Test("两个都是非数字段时按码位比")
    func bothText() {
        #expect(compareVersions("garbage", "garbage") == 0)
        #expect(compareVersions("abc", "def") == -1)
    }

    /// 「数字段排在字符串段之上」是**排序规则**，不是「忽略非数字段」。
    @Test("数字段排在字符串段之上")
    func numberBeatsText() {
        #expect(compareVersions("1.0", "alpha.0") == 1)
        #expect(compareVersions("alpha.0", "1.0") == -1)
    }

    /// ⚠️ **脏值不抛错**：本地 manifest 的 version 可能是旧版留下的任意字符串，
    /// 抛错会让整个更新检查因为「某个引擎的字段脏了」而失败。
    @Test("脏值不抛错，能给出稳定结果")
    func dirtyDoesNotThrow() {
        #expect(compareVersions("not a version", "1.0.0") != 0)
        #expect(compareVersions("", "") == 0)
        // 空串当全 0 → 比 1.0.0 小
        #expect(compareVersions("", "1.0.0") == -1)
    }

    @Test("空段按 0 处理（1..2 不炸）")
    func emptySegmentEqualsZero() {
        #expect(compareVersions("1..2", "1.0.2") == 0)
    }

    /// build metadata 不参与排序（`+` 之后一律忽略）。
    @Test("build metadata 不参与排序")
    func ignoresBuildMetadata() {
        #expect(compareVersions("1.0.0+build.5", "1.0.0") == 0)
        #expect(compareVersions("1.0.0+a", "1.0.0+b") == 0)
        // 有 build 也有 pre：pre 照样生效
        #expect(compareVersions("1.0.0-beta+exp.a", "1.0.0") == -1)
    }
}

// MARK: - hasUpdate

@Suite("hasUpdate")
struct HasUpdateTests {

    @Test("期望版本更新 → true；相同或更旧 → false")
    func basicUpdate() {
        #expect(hasUpdate(current: "1.4.3", remote: "1.4.4"))
        #expect(!hasUpdate(current: "1.4.4", remote: "1.4.4"))
        #expect(!hasUpdate(current: "1.4.5", remote: "1.4.4"))
    }

    /// ⚠️ 本地没装 / 没版本 → 谈不上「有更新」。
    @Test("本地版本缺失一律 false")
    func missingCurrent() {
        #expect(!hasUpdate(current: nil, remote: "1.4.4"))
        #expect(!hasUpdate(current: "", remote: "1.4.4"))
        #expect(!hasUpdate(current: "N/A", remote: "1.4.4"))
    }

    /// ⚠️ **期望版本未知不能报「有更新」**，
    /// 否则引擎页会挂一个永远消不掉的红点（上游那两行 if 删了就是这个症状）。
    @Test("期望版本缺失一律 false")
    func missingRemote() {
        #expect(!hasUpdate(current: "1.0.0", remote: nil))
        #expect(!hasUpdate(current: "1.0.0", remote: ""))
        #expect(!hasUpdate(current: "1.0.0", remote: "N/A"))
    }

    /// nwjs 依赖名的真实形态（本地人手填 `v0.106.0`，期望 `0.106.1`）。
    @Test("带 v 与不带 v 混合比较仍正确")
    func mixedPrefix() {
        #expect(!hasUpdate(current: "1.4.4", remote: "v1.4.4"))
        #expect(hasUpdate(current: "v0.106.0", remote: "0.106.1"))
    }

    @Test("两边都是脏值时按比较结果来，不抛错")
    func dirtyBoth() {
        #expect(!hasUpdate(current: "", remote: ""))
    }
}

// MARK: - nwjs 版本目录排序（行为不能变）

@Suite("nwjs 版本目录排序")
struct NwjsVersionOrderingTests {

    /// ⚠️ **这条守的是「换实现不换行为」**。
    ///
    /// `LaunchCheck.resolveNwjsVersion` 的兜底是
    /// `dirs.max { compareVersions($0, $1) < 0 }` —— 选版本号最大的目录。
    /// 旧的简陋实现与 Semver 在这些**真实目录名**上必须选出同一个。
    @Test("max 选出版本号最大的目录")
    func maxPicksNewest() {
        let dirs = ["v0.106.1", "v0.90.0", "v0.119.2", "v0.104.1"]
        let newest = dirs.max { compareVersions($0, $1) < 0 }
        #expect(newest == "v0.119.2")
    }

    /// 十位进位不能退化成字符串序（`v0.90.0` < `v0.100.0`）。
    /// 这正是旧实现 `Int` 分段做对、而「字符串比」会做错的地方。
    @Test("两位与三位段的进位")
    func twoVsThreeDigits() {
        let dirs = ["v0.90.0", "v0.104.1"]
        #expect(dirs.max { compareVersions($0, $1) < 0 } == "v0.104.1")
    }

    /// 带 v 与不带 v 混在同一个目录里也不会错选。
    @Test("混着 v 前缀")
    func mixedPrefixDirectories() {
        let dirs = ["0.106.1", "v0.119.2"]
        #expect(dirs.max { compareVersions($0, $1) < 0 } == "v0.119.2")
    }
}

// MARK: - 架构名解析

@Suite("架构名解析")
struct ArchTests {

    /// ⚠️ **键名映射是唯一的一处**：`currentArch()` 返回 `x64`，
    /// manifest 用 `x86_64`。这条映射写错的表现是「arm64 机器装到 x64 运行时，
    /// 装完能下载、启动时报 `bad CPU type in executable`」。
    @Test("x64 映射成 x86_64，arm64 原样")
    func manifestKeyMapping() {
        #expect(Arch.x64.manifestKey == "x86_64")
        #expect(Arch.arm64.manifestKey == "arm64")
        // Electron 版 resolveArch() 是「只做一条映射，其余原样」
        #expect(Arch.manifestKey(for: "x64") == "x86_64")
        #expect(Arch.manifestKey(for: "arm64") == "arm64")
    }

    /// 认不出来的架构名**不猜**（猜错了会装成另一个架构的二进制）。
    @Test("别名解析")
    func aliases() {
        #expect(Arch(archName: "x64") == .x64)
        #expect(Arch(archName: "x86_64") == .x64)
        #expect(Arch(archName: "arm64") == .arm64)
        #expect(Arch(archName: "aarch64") == .arm64)
        #expect(Arch(archName: "ia32") == nil)
        #expect(Arch(archName: "ppc") == nil)
    }

    /// 当前架构只可能是这两个之一（不会返回 nil / 空串）。
    @Test("currentArch 只会给 x64 / arm64")
    func currentArchShape() {
        let arch = Arch.current()
        #expect(["x64", "arm64"].contains(arch.rawValue))
        // 与 LaunchCheck 的字符串入口同源
        #expect(currentArch() == arch.rawValue)
    }
}

// MARK: - 假传输层（下载测试永不联网）

/// 假的 HTTP 传输层。
///
/// ⚠️ 它**不检查状态码**、**不判断 2xx** —— 状态码原样交给 `Downloader`。
/// 这样测试断言的是 `Downloader` 里那行真判据，而不是假实现里随手写的 if。
struct ScriptedTransport: DownloadTransport {
    let statusCode: Int
    let totalBytes: Int64?
    /// 依次 yield 的块。`nil` = 流的构造抛错（模拟连接层失败）。
    let chunks: [Data]
    /// 每块之间等多久（模拟「下载慢」用于测取消）。
    let delayNanos: UInt64
    /// 是否在流结束后抛错（模拟中途断连）。
    let failAtEnd: Bool

    init(
        statusCode: Int = 200, totalBytes: Int64? = nil,
        chunks: [Data] = [], delayNanos: UInt64 = 0, failAtEnd: Bool = false
    ) {
        self.statusCode = statusCode
        self.totalBytes = totalBytes
        self.chunks = chunks
        self.delayNanos = delayNanos
        self.failAtEnd = failAtEnd
    }

    func open(_ url: String) async throws -> DownloadResponse {
        guard URL(string: url)?.scheme != nil else {
            throw DownloadError.invalidURL(url)
        }
        let chunks = self.chunks
        let delay = delayNanos
        let fail = failAtEnd
        let stream = AsyncThrowingStream<Data, any Error> { continuation in
            Task {
                for chunk in chunks {
                    if delay > 0 { try? await Task.sleep(nanoseconds: delay) }
                    continuation.yield(chunk)
                }
                if fail {
                    continuation.finish(throwing: DownloadError.transport(reason: "连接中断"))
                } else {
                    continuation.finish()
                }
            }
        }
        // 总字节数缺省时按内容算（模拟 content-length 正确的情况）
        let total = totalBytes ?? Int64(chunks.reduce(0) { $0 + $1.count })
        return DownloadResponse(
            statusCode: statusCode, totalBytes: total, bytes: stream, cancel: {})
    }
}

/// 收集进度回调（闭包不是引用类型，测试里需要能事后断言）。
final class ProgressRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [DownloadProgress] = []

    var all: [DownloadProgress] {
        lock.lock(); defer { lock.unlock() }
        return items
    }

    func record(_ progress: DownloadProgress) {
        lock.lock(); defer { lock.unlock() }
        items.append(progress)
    }
}

// MARK: - 下载器

@Suite("下载器")
struct DownloaderTests {

    /// 成功路径：写文件 + **字节进度回调被调用**（且累计值正确）。
    @Test("成功路径：进度回调被调用，累计字节正确")
    func successWritesFileAndReportsProgress() async throws {
        let dir = try makeDownloadTemp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let target = dir.appendingPathComponent("pkg.zip").path

        let chunks = [Data([1, 2, 3]), Data([4, 5]), Data([6])]
        let recorder = ProgressRecorder()
        let downloader = Downloader(transport: ScriptedTransport(
            statusCode: 200, totalBytes: 6, chunks: chunks))

        try await downloader.download("https://x/pkg.zip", to: target) { recorder.record($0) }

        // 文件内容 = 三块拼起来
        let written = try Data(contentsOf: URL(fileURLWithPath: target))
        #expect(written == Data([1, 2, 3, 4, 5, 6]))

        // 进度是**累计**的：3 / 5 / 6，不是每块的大小
        let seen = recorder.all
        #expect(seen.count == 3)
        #expect(seen.map(\.receivedBytes) == [3, 5, 6])
        #expect(seen.allSatisfy { $0.totalBytes == 6 })
    }

    /// ⚠️ 总字节可能为 `nil`（服务器没给 content-length）。
    /// 把 `nil` 当 0 会让 UI 显示「0%」——用户以为没动，其实在动。
    @Test("总字节未知时进度仍是 nil 而不是 0")
    func unknownTotalStaysNil() async throws {
        struct NoLengthTransport: DownloadTransport {
            func open(_ url: String) async throws -> DownloadResponse {
                let stream = AsyncThrowingStream<Data, any Error> { c in
                    c.yield(Data([1, 2])); c.finish()
                }
                return DownloadResponse(
                    statusCode: 200, totalBytes: nil, bytes: stream, cancel: {})
            }
        }
        let dir = try makeDownloadTemp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let target = dir.appendingPathComponent("x.bin").path
        let recorder = ProgressRecorder()

        try await Downloader(transport: NoLengthTransport())
            .download("https://x/x.bin", to: target) { recorder.record($0) }

        #expect(recorder.all.count == 1)
        #expect(recorder.all[0].totalBytes == nil)
        #expect(recorder.all[0].receivedBytes == 2)
    }

    /// ⚠️ **HTTP 404 必须明确报错**，不能「把 404 的 HTML 写成 .zip 然后报解压失败」。
    @Test("HTTP 404 → 明确的 httpStatus 错误")
    func notFoundIsExplicitError() async throws {
        let dir = try makeDownloadTemp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let target = dir.appendingPathComponent("404.zip").path

        let downloader = Downloader(transport: ScriptedTransport(
            statusCode: 404, chunks: [Data("<html>not found</html>".utf8)]))

        await #expect(throws: DownloadError.httpStatus(code: 404, url: "https://x/404.zip")) {
            try await downloader.download("https://x/404.zip", to: target)
        }
        // 判据的另一半：**不能留下任何文件**（半截 / 错误内容的都不行）
        #expect(!FileManager.default.fileExists(atPath: target))
    }

    /// 500 也一样（非 2xx 一律失败，不是只挡 404）。
    @Test("HTTP 500 同样明确报错")
    func serverErrorIsExplicit() async throws {
        let dir = try makeDownloadTemp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let target = dir.appendingPathComponent("500.zip").path

        await #expect(throws: DownloadError.httpStatus(code: 500, url: "https://x/500.zip")) {
            try await Downloader(transport: ScriptedTransport(statusCode: 500))
                .download("https://x/500.zip", to: target)
        }
        #expect(!FileManager.default.fileExists(atPath: target))
    }

    /// ⚠️ **取消**：任务取消后要抛 `DownloadError.cancelled`（等价于 `CancellationError`），
    /// 而且**不能留下半截文件**。
    @Test("取消 → .cancelled，且不留半截文件")
    func cancellation() async throws {
        let dir = try makeDownloadTemp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let target = dir.appendingPathComponent("slow.zip").path

        // 每块之间等 50ms，共 20 块 → 不取消要 1 秒
        let downloader = Downloader(transport: ScriptedTransport(
            chunks: Array(repeating: Data([0xAA]), count: 20),
            delayNanos: 50_000_000,
            failAtEnd: false))

        let task = Task {
            try await downloader.download("https://x/slow.zip", to: target)
        }
        // 等它开始写（前一块已落地）再取消
        try? await Task.sleep(nanoseconds: 120_000_000)
        task.cancel()

        let result = await task.result
        switch result {
        case .success:
            Issue.record("取消后不该成功返回")
        case .failure(let error):
            #expect(error as? DownloadError == .cancelled,
                    "取消应抛 .cancelled，实际：\(error)")
        }
        // 半截文件必须被删掉（否则下一轮会解压一个残缺的包）
        #expect(!FileManager.default.fileExists(atPath: target))
    }

    /// 传输层异常要能透上来（不能变成「静默成功」）。
    @Test("传输层中断 → .transport")
    func transportFailurePropagates() async throws {
        let dir = try makeDownloadTemp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let target = dir.appendingPathComponent("broken.zip").path

        let downloader = Downloader(transport: ScriptedTransport(
            chunks: [Data([1, 2])], failAtEnd: true))

        await #expect(throws: DownloadError.self) {
            try await downloader.download("https://x/broken.zip", to: target)
        }
        #expect(!FileManager.default.fileExists(atPath: target))
    }

    /// 非法地址在**发起请求之前**就该失败。
    @Test("非法 URL → .invalidURL")
    func invalidURL() async throws {
        let dir = try makeDownloadTemp()
        defer { try? FileManager.default.removeItem(at: dir) }
        let target = dir.appendingPathComponent("x.bin").path

        await #expect(throws: DownloadError.self) {
            try await Downloader(transport: ScriptedTransport())
                .download("not a url", to: target)
        }
    }

    /// 下载到临时文件：父目录自动建、文件名沿用 URL 的、调用方负责删。
    @Test("下载到临时文件并保留原始文件名")
    func temporaryFile() async throws {
        let downloader = Downloader(transport: ScriptedTransport(
            chunks: [Data([7, 7, 7])]))
        let url = try await downloader.downloadToTemporaryFile(
            "https://x/dir/nwjs-sdk-v0.1-osx-arm64.zip")
        defer { try? FileManager.default.removeItem(
            at: url.deletingLastPathComponent()) }

        #expect(url.lastPathComponent == "nwjs-sdk-v0.1-osx-arm64.zip")
        #expect(try Data(contentsOf: url) == Data([7, 7, 7]))
    }

    /// `Downloader` 与 `Installer` 的「从 URL 取文件名」必须同源。
    @Test("文件名提取与 Installer.archiveName 同源")
    func fileNameMatchesInstaller() {
        #expect(Downloader.suggestedFileName(
            from: "https://dl.nwjs.io/v0.106.1/nwjs-sdk-v0.106.1-osx-arm64.zip")
            == EngineInstaller.archiveName(
                from: "https://dl.nwjs.io/v0.106.1/nwjs-sdk-v0.106.1-osx-arm64.zip"))
        // 带 query 时都剥掉
        #expect(Downloader.suggestedFileName(from: "https://x/a.zip?token=abc") == "a.zip")
    }

    /// ⚠️ **这条守的是「装配点存在」**（AGENTS.md 的「判据写了、测了、但没人调用」）。
    ///
    /// `Downloader` 与 `Extract` 各自有测试、都全绿，但如果没人把它们拼成
    /// `InstallEnvironment`，生产代码里就永远只有测试在用它们 —— 功能等于没写。
    /// 这里走 `InstallEnvironment.live()` 跑一遍**完整安装链路**（下载 → 解压 → 落地），
    /// 网络层换成 `ScriptedTransport`（不联网），写一个**真的 zip** 让 tar 真解一次。
    @Test("InstallEnvironment.live 把下载器与解压真的接起来了")
    func liveEnvironmentInstalls() async throws {
        // 用一个真 zip（tar 认 zip 只认 .zip 扩展名 + 是合法容器；这里用 tar.gz 更稳）
        let archiveDir = try makeDownloadTemp()
        defer { try? FileManager.default.removeItem(at: archiveDir) }
        let archivePath = archiveDir.appendingPathComponent("pkg.tar.gz").path
        try makeTarGz(at: archivePath, entries: ["marker.txt": "HELLO"])

        let archiveBytes = try Data(contentsOf: URL(fileURLWithPath: archivePath))
        let target = try makeDownloadTemp()
        defer { try? FileManager.default.removeItem(at: target) }

        // 下载器把「归档内容」原样吐出来，解压器真的 tar 解一次
        let env = InstallEnvironment.live(transport: ScriptedTransport(
            statusCode: 200, chunks: [archiveBytes]))

        let installed = try await EngineInstaller.install(
            root: target.path,
            dependencies: [(
                name: "pkg",
                // filename 从 link 推出来 = pkg.tar.gz，与上面造的包同名
                spec: DependencySpec(builds: [
                    "arm64": DependencyBuild(
                        link: "https://x/pkg.tar.gz", unzip: true)])
            )],
            env: env,
            arch: "arm64")

        #expect(installed == ["pkg"])
        // 解压真的发生了：marker.txt 落在 deps/pkg/ 下
        let marker = target.appendingPathComponent("deps/pkg/marker.txt")
        #expect(FileManager.default.fileExists(atPath: marker.path),
                "解压环节没接上 → 下载器与 Extract 其实没被装配")
        #expect(try String(contentsOf: marker, encoding: .utf8) == "HELLO")
    }
}

/// 造一个真的 tar.gz（用系统 bsdtar，不引入第三方依赖）。
func makeTarGz(at path: String, entries: [String: String]) throws {
    let staging = FileManager.default.temporaryDirectory
        .appendingPathComponent("tsmg-tarsrc-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: staging) }

    for (name, content) in entries {
        try content.write(
            to: staging.appendingPathComponent(name), atomically: true, encoding: .utf8)
    }

    let proc = Process()
    proc.executableURL = URL(fileURLWithPath: "/usr/bin/tar")
    proc.arguments = ["-czf", path, "-C", staging.path, "."]
    proc.standardOutput = FileHandle.nullDevice
    proc.standardError = FileHandle.nullDevice
    try proc.run()
    proc.waitUntilExit()
    #expect(proc.terminationStatus == 0, "造测试归档失败")
}

// MARK: - 辅助

func makeDownloadTemp() throws -> URL {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("tsmg-download-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}
