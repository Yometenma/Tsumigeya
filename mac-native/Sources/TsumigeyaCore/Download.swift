// 依赖下载：下载器 + 架构名解析。
//
// 对应 Electron 版：src/main/engines/install.ts 的 `resolveArch` +
// `installDependencies` 的「下载」那一段（约 280–380 行）
// 契约：docs/M1-实施方案.md §3，D9（代理）/ D69（解压形态，不在本文件）
//
// ===== 本文件**只做两件事**，选构建不在其中 =====
//
// ① **架构名解析**（`Arch`）：本机是 arm64 还是 x64，以及 `x64` → `x86_64` 这条映射。
//
//    ⚠️ 键名不一致的根源：`currentArch()`（`os.arch()` 的等价物）返回 `x64` / `arm64`，
//    而 manifest 的分支键是 `x86_64` / `arm64`（registry.ts 里 nwjs 就写成
//    `{ x86_64: {link}, arm64: {link} }`）。Electron 版的处理在 `resolveArch()`：
//        const raw = options.arch ?? os.arch()
//        return raw === 'x64' ? 'x86_64' : raw
//    也就是**只做这一条映射，其余原样查表** —— 不做大小写/别名容错、不猜另一个键。
//
// ② **下载**（`Downloader` + `DownloadTransport`）：状态码检查 / 写文件 / 进度 / 取消。
//
// ===== 选构建去哪了（重要）=====
//
// 「从清单里挑本机架构那一项」**不在本文件**，它是 `Installer.swift` 的
// `EngineInstaller.pickBuild(spec:arch:)`。实测的真实清单有三种形态，
// 那份实现已经覆盖：
//
//   · `{"universal": {...}}`                ← mkxpz / RTP / kawariki / 音源
//   · `{"arm64": {...}, "x86_64": {...}}`   ← nwjs
//   · 单一键 / 所有 link 相同                ← 写法上分了架构但其实同一个包
//
// 本鱼第一版在这里自己写了一份 `BuildPicker`，**已删** —— 两份判据迟早分叉
// （D56 的老教训：路径/键名的拼法只能有一个来源）。
// 找不到构建时 `pickBuild` 返回 `nil`，由 `EngineInstaller` 抛
// `error.dependencyMissing`（Electron 版的 `error.buildMissing` 同义）。
//
// ⚠️ 那条「所有 link 相同就随便取一个」的兜底**保留在 Installer 里**是**有意**的
// （不是本鱼加的偏差）：实测 registry 里确实存在「键上分了架构、但链接其实同一个」
// 的写法，去掉它会让这类包在 arm64 上选不到构建。
//
// ===== 下载器的分层（为什么要把「网络层」抽成协议）=====
//
// 要求是「测试不能联网」，而 HTTP 状态码检查又必须真的被覆盖到 ——
// 如果状态检查写在 `URLSession` 那个实现里，测试就只能**假装**覆盖（用假实现绕过去
// 就断言不到真实的检查）。
//
// 所以拆成两层：
//
//   `DownloadTransport`  —— **只负责「打开一个 HTTP 响应」**：给出状态码、总字节数、
//                           以及一个字节块序列。真实实现是 `URLSessionTransport`。
//   本文件的 `Downloader` —— **状态码检查 / 写临时文件 / 进度 / 取消** 全在这一层。
//                           这些是真正的业务判据，测试用假 transport 就能全量覆盖。
//
// 取消的落点：`Task` 取消 → `Downloader` 的 `withTaskCancellationHandler` 调
// `DownloadResponse.cancel()` → transport 结束那个挂起的字节流 → `for await` 退出。
// 只靠 `Task.isCancelled` 检查是不够的：`for try await` 正卡在「等下一条数据」时
// 根本不会执行到那行检查，取消请求会被网络超时吞掉（用户点了取消还要再等 60 秒）。
import Darwin
import Foundation

// MARK: - 架构

/// 目标架构（只有 mac 需要的两种）。
///
/// ⚠️ 与 manifest 的键名**不是一个词**：这个枚举的 `rawValue` 是 `x64` / `arm64`
/// （与 `currentArch()` 和 `BinaryPaths` 的拼法一致），而 manifest 用 `x86_64`。
/// 映射只在 `manifestKey` 这一处 —— 别在调用点各写一遍（AGENTS.md 的 D56 精神：
/// 路径/键名的拼法只能有一个来源）。
public enum Arch: String, Sendable, CaseIterable {
    case arm64
    /// Intel。注意 `rawValue` 是 `x64`（不是 `x86_64`），见上面的注释。
    case x64

    /// manifest 的 `dependencies[name]` 里的架构键名。
    public var manifestKey: String {
        switch self {
        case .arm64: return "arm64"
        case .x64: return "x86_64"
        }
    }

    /// 从任意写法解析（`x64` / `x86_64` / `amd64` / `arm64` / `aarch64`）。
    ///
    /// - Returns: `nil` = 认不出来。**不猜** —— 猜错了会装成另一个架构的二进制。
    public init?(archName: String) {
        switch archName.lowercased() {
        case "arm64", "aarch64": self = .arm64
        case "x64", "x86_64", "amd64": self = .x64
        default: return nil
        }
    }

    /// Electron 版 `resolveArch()` 的等价物：**只做一条映射**，其余原样返回。
    ///
    /// 为什么保留这个「原样返回」而不做枚举校验：manifest 是外部数据，
    /// 传进来一个 `ia32` 之类时，正确行为是「按这个名字去查表，查不到就报缺构建」，
    /// 而不是在选构建之前就抛一个「架构名不认识」——后者会让错误信息跑偏。
    public static func manifestKey(for rawArch: String) -> String {
        rawArch == "x64" ? "x86_64" : rawArch
    }

    /// 当前运行架构。
    ///
    /// ⚠️ **必须运行时判断，不能只看编译期常量**：swift 二进制在 Rosetta 下跑时，
    /// `#if arch(arm64)` 仍然成立，但这时要装的是 **x86_64** 的依赖 —— 否则
    /// 「在 Rosetta 里跑 x64 的 nwjs」这条路就走不通（用户手动用 Rosetta 打开时
    /// 会表现为「引擎装了却启动不了」）。
    /// 判据是 `sysctl.proc_translated`（Rosetta 官方就是用这个标志），与 Electron 版
    /// `os.arch()` 在 Rosetta 下返回 `x64` 的行为一致。
    public static func current() -> Arch {
        var translated: Int32 = 0
        var size = MemoryLayout<Int32>.size
        let ok = sysctlbyname("sysctl.proc_translated", &translated, &size, nil, 0)
        if ok == 0 && translated == 1 {
            return .x64
        }
        #if arch(arm64)
        return .arm64
        #else
        return .x64
        #endif
    }
}

// MARK: - 选构建（不在这里实现）
//
// 本鱼第一版在这里写了 BuildSpec / BuildPicker / BuildError，**已经删掉**。
//
// 理由：架构选择已经有一个唯一来源 —— `Installer.swift` 的
// `EngineInstaller.pickBuild(spec:arch:)`，它比本鱼那份更贴合真实清单：
//
//   · {"universal": {...}}                ← mkxpz / RTP / kawariki / 音源（实测）
//   · {"arm64": {...}, "x86_64": {...}}   ← nwjs（实测）
//   · 单一键 / 所有 link 相同             ← 写法上分了架构但其实同一个包
//
// 再写第二份只会让两份慢慢分叉（D56 的老教训：路径/键名的拼法只能有一个来源）。
// 本文件**只提供架构名的解析与映射**（`Arch`），选构建一律走 `EngineInstaller`。

// MARK: - 下载错误

/// 下载失败的分类。
///
/// `Equatable` 是为了测试能直接断言具体分支 —— 纯字符串比较会把
/// 「HTTP 404」和「写文件失败」误判成同一类错误（文案都是「下载失败」）。
public enum DownloadError: Error, Sendable, Equatable, LocalizedError {
    /// URL 根本拼不出来（`"not a url"`、空串）。
    case invalidURL(String)
    /// HTTP 状态码不是 2xx。
    ///
    /// ⚠️ 这条**必须**是明确的错误，不能像「回调把字节写完了就当成功」那样静默通过：
    /// 404 的页面体是 HTML，会被原样写进 `.zip`，解压时报「不是压缩包」——
    /// 用户看到的是「解压失败」，真正原因（地址失效 / 版本下架）一个字都没露出来。
    case httpStatus(code: Int, url: String)
    /// 任务被取消（等价于 `CancellationError`，见文件头「取消的落点」）。
    case cancelled
    /// 传输层异常（连不上、TLS 失败、连接中途断开）。
    case transport(reason: String)
    /// 写本地文件失败（磁盘满 / 只读目录）。
    case writeFailed(path: String, reason: String)

    public var errorDescription: String? { message }

    /// 给人看的中文说明。
    public var message: String {
        switch self {
        case .invalidURL(let raw):
            return "下载地址不合法：\(raw)"
        case .httpStatus(let code, let url):
            return "下载失败：HTTP \(code)\n地址：\(url)"
        case .cancelled:
            return "下载已取消。"
        case .transport(let reason):
            return "下载失败：\(reason)"
        case .writeFailed(let path, let reason):
            return "写出下载文件失败：\(path)\n原因：\(reason)"
        }
    }
}

// MARK: - 下载进度

/// 一次进度回调的载荷。
public struct DownloadProgress: Sendable, Equatable {
    /// 已下载字节数（**累计**，不是这次读到的块）。
    public var receivedBytes: Int64
    /// 总字节数。`nil` = 服务器没给 `content-length`（chunked / 压缩流）。
    ///
    /// ⚠️ UI 必须能处理 `nil`：把 `nil` 当 0 会让进度条显示 0%，
    /// 用户以为下载没动，其实在动。（Electron 版这里是 `Number(...) || 0`，
    /// 也就是它把「未知」和「0 字节」糊成一个数 —— 我们保留 `nil` 的区分。）
    public var totalBytes: Int64?

    public init(receivedBytes: Int64, totalBytes: Int64?) {
        self.receivedBytes = receivedBytes
        self.totalBytes = totalBytes
    }
}

// MARK: - 传输层抽象（可注入）

/// 一次 HTTP 响应的「头 + 字节流」。
///
/// - Note: `bytes` 是**块级**的（不是逐字节）：真实实现按 URLSession 收到的
///   `didReceive data` 分块。逐字节的 `AsyncBytes` 迭代在 244MB 的 RTP 上慢到
///   不可接受（每个字节一次 `await`），所以这里选块级。
public struct DownloadResponse: Sendable {
    /// HTTP 状态码。非 HTTP 响应（理论上不该发生）会给 `-1`。
    public let statusCode: Int
    /// `content-length`（`nil` = 未知）。
    public let totalBytes: Int64?
    /// 响应体。消费方 `break` / 任务取消时必须调 `cancel()`，否则 URLSession 会继续拉。
    public let bytes: AsyncThrowingStream<Data, any Error>
    /// 主动中止。**幂等**：多次调用只生效一次。
    public let cancel: @Sendable () -> Void

    public init(
        statusCode: Int, totalBytes: Int64?,
        bytes: AsyncThrowingStream<Data, any Error>,
        cancel: @escaping @Sendable () -> Void
    ) {
        self.statusCode = statusCode
        self.totalBytes = totalBytes
        self.bytes = bytes
        self.cancel = cancel
    }
}

/// 「打开一个下载」的能力（网络层的唯一边界）。
///
/// 生产实现是 `URLSessionTransport`；测试注入假实现，**永远不联网**。
/// 单独抽出来的理由是文件头那段：状态码检查必须留在可测的那一侧。
public protocol DownloadTransport: Sendable {
    /// 打开 `url` 并返回响应。
    ///
    /// - Throws: `DownloadError.invalidURL` / `DownloadError.transport`
    ///   （**不**在这里检查 2xx —— 那是 `Downloader` 的判据）
    func open(_ url: String) async throws -> DownloadResponse
}

// MARK: - URLSession 实现

/// `URLSession` 的下载实现。
///
/// ⚠️ **它自己不做任何业务判断**：状态码照样返回（哪怕是 404），
/// 由 `Downloader` 决定这是不是失败。这样「404 报错」这条测试覆盖的是真判据，
/// 不是假实现里随手写的一句 throw。
///
/// ⚠️ 系统代理：`URLSession` 默认就会读系统代理设置（Electron 版要手动
/// `session.setProxy({mode:'system'})` 才生效，D9 那条坑在 Swift 里不存在）。
public final class URLSessionTransport: DownloadTransport, @unchecked Sendable {

    private let configuration: URLSessionConfiguration

    /// - Parameter configuration: `.ephemeral`（默认）不写磁盘缓存 ——
    ///   依赖包动辄 100MB+，缓存只会白占用户磁盘。
    public init(configuration: URLSessionConfiguration = .ephemeral) {
        self.configuration = configuration
    }

    public func open(_ url: String) async throws -> DownloadResponse {
        guard let parsed = URL(string: url), parsed.scheme != nil else {
            throw DownloadError.invalidURL(url)
        }

        let delegate = BodyStreamDelegate()
        let session = URLSession(
            configuration: configuration, delegate: delegate, delegateQueue: nil)
        let task = session.dataTask(with: URLRequest(url: parsed))
        delegate.attach(task: task, session: session)

        // 字节流的取消必须能回溯到 URLSession 任务，否则「取消」只是不再读，
        // 底层还在继续下载（用户会看到流量继续涨）。
        let (stream, chunks) = AsyncThrowingStream<Data, any Error>.makeStream()
        delegate.attach(chunks: chunks)
        chunks.onTermination = { @Sendable _ in
            delegate.cancel()
        }

        let head: BodyStreamDelegate.Head = try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<BodyStreamDelegate.Head, any Error>) in
                delegate.attach(head: continuation)
                task.resume()
            }
        } onCancel: {
            delegate.cancel()
        }

        return DownloadResponse(
            statusCode: head.statusCode,
            totalBytes: head.totalBytes,
            bytes: stream,
            cancel: { delegate.cancel() }
        )
    }
}

/// 把 `URLSessionDataDelegate` 的回调桥成「一个头 + 一个块流」。
///
/// 全部状态都在 `lock` 里读写：delegate 的回调来自 URLSession 的内部串行队列，
/// 而 `open()` / `cancel()` 来自调用方的并发域 —— 没有锁的话，
/// 「取消」与「收到 response」会互相覆盖对方的 continuation（概率低，但一发生就是挂死）。
final class BodyStreamDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {

    /// `open()` 需要等到的响应头。
    struct Head: Sendable {
        let statusCode: Int
        let totalBytes: Int64?
    }

    private let lock = NSLock()
    private var headContinuation: CheckedContinuation<Head, any Error>?
    private var chunkContinuation: AsyncThrowingStream<Data, any Error>.Continuation?
    private var task: URLSessionTask?
    private var session: URLSession?
    private var didFinish = false
    private var isCancelled = false

    func attach(task: URLSessionTask, session: URLSession) {
        lock.lock()
        self.task = task
        self.session = session
        let alreadyCancelled = isCancelled
        lock.unlock()
        if alreadyCancelled { task.cancel() }
    }

    func attach(chunks: AsyncThrowingStream<Data, any Error>.Continuation) {
        lock.lock()
        chunkContinuation = chunks
        lock.unlock()
    }

    func attach(head: CheckedContinuation<Head, any Error>) {
        lock.lock()
        if didFinish || isCancelled {
            lock.unlock()
            head.resume(throwing: DownloadError.cancelled)
            return
        }
        headContinuation = head
        lock.unlock()
    }

    /// 取消（幂等）。
    func cancel() {
        lock.lock()
        if isCancelled {
            lock.unlock()
            return
        }
        isCancelled = true
        let pendingHead = headContinuation
        let pendingChunks = chunkContinuation
        headContinuation = nil
        chunkContinuation = nil
        let task = self.task
        let session = self.session
        lock.unlock()

        task?.cancel()
        pendingHead?.resume(throwing: DownloadError.cancelled)
        pendingChunks?.finish(throwing: DownloadError.cancelled)
        session?.invalidateAndCancel()
    }

    // MARK: URLSessionDataDelegate

    func urlSession(
        _ session: URLSession, dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping @Sendable (URLSession.ResponseDisposition) -> Void
    ) {
        let http = response as? HTTPURLResponse
        let total: Int64? = response.expectedContentLength > 0
            ? Int64(response.expectedContentLength)
            : nil

        lock.lock()
        let pendingHead = headContinuation
        headContinuation = nil
        let cancelled = isCancelled
        lock.unlock()

        // ⚠️ 非 2xx 也用 `.allow`：状态码由 Downloader 判定并抛错，
        //    这里若改成 `.cancel`，错误就会先变成「URLError.cancelled」，
        //    把「404」这个**真正的原因**盖掉。
        pendingHead?.resume(returning: Head(statusCode: http?.statusCode ?? -1, totalBytes: total))
        completionHandler(cancelled ? .cancel : .allow)
    }

    func urlSession(
        _ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data
    ) {
        lock.lock()
        let chunks = chunkContinuation
        let cancelled = isCancelled
        lock.unlock()
        guard !cancelled else { return }
        chunks?.yield(data)
    }

    func urlSession(
        _ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?
    ) {
        lock.lock()
        didFinish = true
        let pendingHead = headContinuation
        let pendingChunks = chunkContinuation
        headContinuation = nil
        chunkContinuation = nil
        let cancelled = isCancelled
        let heldSession = self.session
        lock.unlock()

        // 没收到 response 就结束 = 连接层失败（DNS / TLS / 超时）
        if let pendingHead {
            pendingHead.resume(throwing: cancelled
                ? DownloadError.cancelled
                : DownloadError.transport(reason: error?.localizedDescription ?? "连接提前结束"))
        }
        if let pendingChunks {
            if cancelled {
                pendingChunks.finish(throwing: DownloadError.cancelled)
            } else if let error {
                pendingChunks.finish(throwing: DownloadError.transport(reason: error.localizedDescription))
            } else {
                pendingChunks.finish()
            }
        }
        heldSession?.finishTasksAndInvalidate()
    }
}

// MARK: - 下载器（业务判据全在这一层）

/// 顺序写文件的小句柄。
///
/// `@unchecked Sendable` 的理由：它只在**同一个** async 调用链里顺序使用（
/// 一个下载一个 sink），没有并发写；锁会带来无意义的开销。
/// 换成 `FileHandle` 直接跨 `await` 传是不行的 —— Swift 6 里它不是 `Sendable`。
final class FileSink: @unchecked Sendable {
    private let path: String
    private let handle: FileHandle

    init(path: String) throws {
        // ⚠️ `self.path` 必须**先**赋值：Swift 要求「要么全部初始化，要么 throw」。
        //    本鱼第一版把它留到最后 → 编译报
        //    `return from initializer without initializing all stored properties`。
        self.path = path
        let url = URL(fileURLWithPath: path)
        let parent = url.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(
                at: parent, withIntermediateDirectories: true)
        } catch {
            throw DownloadError.writeFailed(path: path, reason: error.localizedDescription)
        }
        guard FileManager.default.createFile(atPath: path, contents: nil) else {
            throw DownloadError.writeFailed(path: path, reason: "无法创建文件")
        }
        do {
            handle = try FileHandle(forWritingTo: url)
        } catch {
            throw DownloadError.writeFailed(path: path, reason: error.localizedDescription)
        }
    }

    func append(_ data: Data) throws {
        do {
            try handle.write(contentsOf: data)
        } catch {
            throw DownloadError.writeFailed(path: path, reason: error.localizedDescription)
        }
    }

    func close() {
        try? handle.close()
    }

    /// 失败/取消时用：关掉句柄**并删掉半截文件**。
    ///
    /// 为什么要删：调用方拿到的是「下载失败」，但磁盘上留着一个
    /// `xxx.zip` 半截文件。下一轮安装如果命中「文件已存在就跳过」之类的逻辑
    /// （或者用户手动去点那个文件），就会解压一个残缺的包 ——
    /// 报的还是「解压失败」，与真正的原因（下载断了）完全对不上号。
    func abort() {
        try? handle.close()
        try? FileManager.default.removeItem(atPath: path)
    }
}

/// 依赖下载器。
///
/// 用法（生产）：
/// ```swift
/// let downloader = Downloader()                     // URLSessionTransport
/// try await downloader.download(link, to: archivePath) { p in ... }
/// ```
/// 测试注入假 transport：
/// ```swift
/// let downloader = Downloader(transport: ScriptedTransport { _ in ... })
/// ```
public struct Downloader: Sendable {

    private let transport: any DownloadTransport

    public init(transport: any DownloadTransport = URLSessionTransport()) {
        self.transport = transport
    }

    /// 下载到指定路径。
    ///
    /// - Parameters:
    ///   - urlString: 下载地址。
    ///   - destination: 落地路径（**已存在会被截断覆盖**）。父目录会自动创建。
    ///   - onProgress: 每收到一块回调一次（`receivedBytes` 是累计值）。
    ///     块大小由实现决定（URLSession 通常是 16KB 量级），**不要**在回调里做重活。
    ///
    /// - Throws: `DownloadError`（四种分支）：
    ///   · `.httpStatus` —— 非 2xx（**明确报错**，不给「静默成功」留缝）
    ///   · `.cancelled` —— 任务被取消（等价于 `CancellationError`）
    ///   · `.writeFailed` —— 本地写失败
    ///   · `.transport` / `.invalidURL` —— 由 transport 抛上来
    ///
    /// - Note: 失败时**不留半截文件**（见 `FileSink.abort`）。
    public func download(
        _ urlString: String,
        to destination: String,
        onProgress: @Sendable (DownloadProgress) -> Void = { _ in }
    ) async throws {
        let response = try await transport.open(urlString)

        guard (200..<300).contains(response.statusCode) else {
            // 先中止底层传输再抛：否则 URLSession 还在拉那个 404 的 HTML 页面
            response.cancel()
            throw DownloadError.httpStatus(code: response.statusCode, url: urlString)
        }

        let sink = try FileSink(path: destination)
        var received: Int64 = 0

        do {
            try await withTaskCancellationHandler {
                for try await chunk in response.bytes {
                    // 每块检查一次取消：只靠 onCancel 里的流结束是不够的 ——
                    // 如果取消恰好发生在「块已经到、下一块还没来」之间，这行能立刻退出。
                    if Task.isCancelled { throw DownloadError.cancelled }
                    try sink.append(chunk)
                    received += Int64(chunk.count)
                    onProgress(DownloadProgress(
                        receivedBytes: received, totalBytes: response.totalBytes))
                }
            } onCancel: {
                response.cancel()
            }
            // ⚠️ 循环正常结束也要查一次取消：Task 取消时 `for try await` 可能
            //    **只是安静地结束**（底层流被终止而没有抛错），于是「取消」会被
            //    当成「下载完成」—— 用户点了取消，界面却报成功。
            //    这条与本方法里那句「失败时不留半截文件」是同一类判据：宁可多查一次。
            if Task.isCancelled { throw DownloadError.cancelled }
        } catch let error as DownloadError {
            // 取消要把半截文件删掉（见 FileSink.abort）
            sink.abort()
            throw error
        } catch is CancellationError {
            sink.abort()
            throw DownloadError.cancelled
        } catch {
            sink.abort()
            throw DownloadError.transport(reason: error.localizedDescription)
        }

        sink.close()
    }

    /// 下载到临时文件，返回临时文件 URL（**调用方负责删除**）。
    ///
    /// 为什么需要这个入口：`installEngine` 之外的场景（比如清单预览、诊断包里
    /// 临时拉一份小文件）不该自己造临时目录 —— 那种「各自造临时目录」的写法
    /// 迟早会漏清理。
    ///
    /// 临时目录是 `<tmp>/tsumigeya-download-<uuid>/<原始文件名>`：
    /// 保留原始文件名是因为上游一些包（nwjs 的 zip）自己就靠文件名判断平台，
    /// 改名会让解压/安装逻辑多一层猜。
    public func downloadToTemporaryFile(
        _ urlString: String,
        onProgress: @Sendable (DownloadProgress) -> Void = { _ in }
    ) async throws -> URL {
        guard let parsed = URL(string: urlString), parsed.scheme != nil else {
            throw DownloadError.invalidURL(urlString)
        }
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsumigeya-download-\(UUID().uuidString)")
        let file = directory.appendingPathComponent(Self.suggestedFileName(from: urlString))

        do {
            try await download(urlString, to: file.path, onProgress: onProgress)
        } catch {
            try? FileManager.default.removeItem(at: directory)
            throw error
        }
        return file
    }

    /// 从下载地址推出落地文件名（去掉 query，空则 `download.bin`）。
    ///
    /// `Installer` 的 `archiveName` 也走这里 —— 两处「从 URL 取文件名」必须同源，
    /// 否则同一个包在两处会得到不同名字，缓存/断点续传之类的后续优化全会踩坑。
    public static func suggestedFileName(from link: String) -> String {
        guard let url = URL(string: link) else { return "download.bin" }
        let last = url.lastPathComponent
        return last.isEmpty ? "download.bin" : last
    }
}

// MARK: - 生产装配（这条线不通，上面所有判据都等于没写）

extension InstallEnvironment {

    /// 用真实网络 + 真实 tar 装好的环境（`EngineInstaller.install/update` 的生产入口）。
    ///
    /// ⚠️ **为什么要专门留这一个装配点**（AGENTS.md「判据写了、测了、但没人调用」那一条）：
    /// `Downloader` 与 `Extract` 各自都有测试、都全绿，但如果没人把两者拼成
    /// `InstallEnvironment`，生产代码里就永远只有测试在用它们 —— 功能等于没写。
    /// 把它集中在这里，还有一个好处：`activate` 的**两处边界**一眼可见 ——
    /// 「下载器返回字节数」和「解压用哪个归档名」都在下面这段，不会散落在调用点。
    ///
    /// - Parameters:
    ///   - transport: 网络层。默认 `URLSessionTransport`（走系统代理）。
    ///   - fileManager: 文件操作。默认 `.default`，单测可换。
    ///
    /// - Note: `extract` 直接把 `archive` 解到 `destination` **并保留单层目录** ——
    ///   与 `Installer` 的 D69 语义一致：`Extract.extractArchive` 本身不做拍平，
    ///   拍平与否由 `DependencySpec.keepSingleDir` 在调用方决定（本装配点不介入）。
    public static func live(
        transport: any DownloadTransport = URLSessionTransport(),
        fileManager: FileManager = .default
    ) -> InstallEnvironment {
        let downloader = Downloader(transport: transport)

        return InstallEnvironment(
            download: { url, destination, onProgress in
                // ⚠️ 需要「字节数」返回值，而 `Downloader.download` 只回调不返回。
                //    用一个只写一次的小盒子接住最后一次累计值 —— 比再写一个
                //    「带返回值的 download」多一个入口要省事，也不会两套逻辑分叉。
                let box = FinalBytes()
                try await downloader.download(url, to: destination) { progress in
                    box.set(progress.receivedBytes)
                    onProgress?(progress.receivedBytes, progress.totalBytes)
                }
                // 空文件（零字节）时一次回调都不会有 → 返回 0，不是 nil
                return box.value
            },
            extract: { archive, destination in
                try Extract.extractArchive(archive: archive, to: destination)
            },
            fileManager: fileManager
        )
    }
}

/// 「累计字节」的单次写入盒子（`InstallEnvironment.download` 要求返回 `Int64`）。
///
/// `@unchecked Sendable` 的理由与 `FileSink` 相同：只在一次下载的生命周期内使用，
/// 写入发生在 `Downloader` 的顺序回调里，读取发生在它返回之后 —— 没有并发竞争。
private final class FinalBytes: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Int64 = 0

    var value: Int64 {
        lock.lock(); defer { lock.unlock() }
        return stored
    }

    func set(_ bytes: Int64) {
        lock.lock(); defer { lock.unlock() }
        stored = bytes
    }
}
