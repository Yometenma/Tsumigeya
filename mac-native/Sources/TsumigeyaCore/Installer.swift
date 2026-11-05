// 引擎安装 / 更新 / 卸载的编排。
//
// 对应 Electron 版：src/main/engines/install.ts（534 行）
// 契约：docs/M1-实施方案.md §3，D62 / D66 / D69
//
// ===== 本文件是整个 P3 最难的一块，有三个「看着能简化、实际一改就坏」的点 =====
//
// ① **依赖解压后必须保留单层目录**（D69）
//
//    为什么默认保留：
//       RTP      zip 顶层 `RTP/`                    → deps/RTP/RTP/RPGVXace（诊断查这个）
//       nwjs     zip 顶层 `nwjs-sdk-…-osx-arm64/`   → deps/version/v0.106.1/nwjs-sdk-…/nwjs.app/…
//       mkxpz    zip 顶层 `Z-Universal.app/`        → deps/mkxpz/Z-Universal.app/…
//       easyrpg  zip 顶层 `EasyRPG Player.app/`     → deps/player/EasyRPG Player.app/…
//       kawariki zip 顶层 `kawariki/`                → deps/kawariki/kawariki/preload.rb
//     **全部都要保留那一层。**
//
//    ⚠️ M4.2 之前用「顶层目录名 ≠ 依赖名就拍平」的启发式 → nwjs 被误拍平
//    （依赖名 `version/v0.106.1` 与目录名 `nwjs-sdk-…` 天然不同）→ 二进制路径少一层
//    → **mac 上 NW.js 游戏启动失败**（Windows 上无法复现）。
//    → 判据是**显式声明** `keepSingleDir`，默认 true，**绝不靠目录名猜**。
//
// ② **`updateEngine` 的多版本保留**（D66）
//
//    多版本依赖（`version/v0.106.1` 这种）在更新时**必须原样搬回**，一个字节都不碰。
//    三条不变量（测试钉死）：
//      a. 更新后用户选的版本目录还在
//      b. 那个目录的内容**没被换成本次 registry 指定的版本**（用户可能选了别的版本）
//      c. 失败路径也要搬回（否则多版本运行时留在 `.update-preserve/` 等于全坏）
//
//    ⚠️ 还有一条 S3 实施时才发现的真语义：**更新前要先清空非多版本依赖的 deps 子目录**。
//    不清就会变成「新 manifest + 旧二进制叠加」——
//    界面显示「已更新到 1.4.4」，启动时加载的却可能是旧二进制。
//
// ③ **可选依赖失败不能让整个安装失败**
//    easyrpg 的音源站有 Cloudflare 人机验证，程序化请求**恒 403**。
//    可容忍失败的依赖（`optional: true`）失败时记一条警告、跳过。
import Foundation

// MARK: - 依赖描述

/// manifest 里的一个依赖（`dependencies[name]`）。
public struct DependencySpec: Sendable {
    /// 各架构的下载地址：`["x86_64": {link, unzip}, "arm64": {...}]`
    public var builds: [String: DependencyBuild]
    /// 可选依赖：下载失败不中断整个安装（见文件头 ③）。
    public var optional: Bool
    /// 解压后**是否保留单层目录**（D69）。默认 **true**（保留）。
    public var keepSingleDir: Bool

    public init(
        builds: [String: DependencyBuild], optional: Bool = false,
        keepSingleDir: Bool = true
    ) {
        self.builds = builds
        self.optional = optional
        self.keepSingleDir = keepSingleDir
    }
}

/// 某个架构的下载信息。
public struct DependencyBuild: Sendable {
    public var link: String
    /// 下完是否要解压（zip / tar.gz 类要，裸二进制不要）。
    public var unzip: Bool

    public init(link: String, unzip: Bool) {
        self.link = link
        self.unzip = unzip
    }
}

// MARK: - 进度

/// 安装进度事件（与 Electron 版的 `onStep` / `onDownloadProgress` 对齐）。
public enum InstallProgress: Sendable {
    /// 阶段切换。`key` 对应 i18n key（`progress.prepare` / `progress.extracting` / `progress.done` / `progress.download`）。
    case step(key: String, label: String, phase: String)
    /// 字节进度。`total` 可能为 nil（服务器没给 content-length）。
    case download(name: String, received: Int64, total: Int64?)
}

// MARK: - 错误

public enum InstallError: Error, Sendable, Equatable {
    case moduleMissing(module: String)
    case invalidManifest(module: String, reason: String)
    case dependencyMissing(dependency: String, module: String)
    case download(dependency: String, url: String, reason: String)
    case extract(dependency: String, reason: String)
    case unsafeArchive
    case invalidDependency(name: String)
    case cancelled

    /// 给人看的中文说明。
    public var message: String {
        switch self {
        case .moduleMissing(let m):
            return "引擎「\(m)」的 manifest 不存在，需要先安装。"
        case .invalidManifest(let m, let r):
            return "引擎「\(m)」的 manifest 格式损坏：\(r)"
        case .dependencyMissing(let d, let m):
            return "引擎「\(m)」的定义里没有依赖「\(d)」。"
        case .download(let d, let u, let r):
            return "下载「\(d)」失败：\(r)\n地址：\(u)"
        case .extract(let d, let r):
            return "解压「\(d)」失败：\(r)"
        case .unsafeArchive:
            return "压缩包里的路径不安全，已拒绝解压。"
        case .invalidDependency(let n):
            return "依赖名不合法：\(n)"
        case .cancelled:
            return "操作已取消。"
        }
    }
}

// MARK: - 依赖名校验

public enum DependencyPath {

    /// 校验依赖名并转成可用的相对路径。
    ///
    /// ⚠️ 依赖名**可以带斜杠**（`version/v0.106.1`，斜杠 = 子目录，
    /// 落地成 `deps/version/v0.106.1/`）。所以要校验：不能有 `..`、不能是绝对路径、
    /// 不能有控制字符。
    public static func safe(_ name: String) throws -> String {
        guard !name.isEmpty else { throw InstallError.invalidDependency(name: name) }
        // 控制字符
        if name.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) {
            throw InstallError.invalidDependency(name: name)
        }
        // 绝对路径 / 盘符
        if name.hasPrefix("/") || name.hasPrefix("\\") {
            throw InstallError.invalidDependency(name: name)
        }
        if name.count >= 2 {
            let chars = Array(name)
            if chars[1] == ":" && chars[0].isLetter {
                throw InstallError.invalidDependency(name: name)
            }
        }
        // 反斜杠（Windows 风格路径穿越）
        if name.contains("\\") { throw InstallError.invalidDependency(name: name) }
        // .. 段
        if name.split(separator: "/").contains("..") {
            throw InstallError.invalidDependency(name: name)
        }
        return name
    }

    /// 是不是「多版本」依赖（D66 的判据）。
    ///
    /// 判据是**依赖名里出现 `version/` 前缀**（不是「目录名里带数字」——
    /// 那会把 `soundfont/gmgsx-plus.sf2` 之类误判）。
    public static func isMultiVersion(_ name: String) -> Bool {
        name.hasPrefix("version/") || name.contains("/version/")
    }
}

// MARK: - 安装器

/// 一次安装/更新需要的外部能力（注入用，便于单测替换）。
///
/// ⚠️ `@unchecked Sendable` 的理由：`FileManager` 不是 `Sendable`
/// （Apple 没给它加标注），但它**实际是线程安全的**（Foundation 的
/// 文档明确 FileManager 的实例方法可以并发调用，只是它没标注 conformance）。
/// 这个 struct 里的所有字段在创建后都不再被修改，所以跨并发域传递是安全的。
///
/// 替代方案是每个方法都传 `fileManager` 参数 —— 那样调用点会多一层噪音，
/// 而这个 struct 的语义就是「一次安装的环境快照」，放进来更自然。
public struct InstallEnvironment: @unchecked Sendable {
    /// 下载 `url` 到 `destination`，可选地报告字节进度。
    ///
    /// - Returns: 下载的字节数
    public var download: @Sendable (
        _ url: String,
        _ destination: String,
        _ onProgress: (@Sendable (Int64, Int64?) -> Void)?
    ) async throws -> Int64
    /// 解压 `archive` 到 `destination`。
    public var extract: @Sendable (String, String) throws -> Void
    /// 文件操作（便于单测换假实现时不用真建目录）。
    public var fileManager: FileManager

    public init(
        download: @escaping @Sendable (
            _ url: String,
            _ destination: String,
            _ onProgress: (@Sendable (Int64, Int64?) -> Void)?
        ) async throws -> Int64,
        extract: @escaping @Sendable (String, String) throws -> Void,
        fileManager: FileManager = .default
    ) {
        self.download = download
        self.extract = extract
        self.fileManager = fileManager
    }
}

public enum EngineInstaller {

    /// 装一个引擎的全部依赖。
    ///
    /// - Parameters:
    ///   - root: 引擎目录（`<dataDir>/modules/<引擎>`）
    ///   - dependencies: engine 定义里的依赖表（**顺序有意义**：用户看到进度条先动主二进制）
    ///   - env: 注入的下载/解压能力
    ///   - onProgress: 进度回调（**抛错不能中断安装**，见下）
    ///
    /// - Returns: 装好的依赖名列表
    ///
    /// ⚠️ **进度回调抛错不能打断安装**：它与 Electron 版的 `safeCall` 是同一条规矩。
    ///    进度只是 UI 反馈，不该成为失败原因。
    public static func install(
        root: String,
        dependencies: [(name: String, spec: DependencySpec)],
        env: InstallEnvironment,
        arch: String,
        onProgress: (@Sendable (InstallProgress) -> Void)? = nil
    ) async throws -> [String] {
        let depsRoot = (root as NSString).appendingPathComponent("deps")
        var installed: [String] = []

        for (name, spec) in dependencies {
            let depRelative: String
            do {
                depRelative = try DependencyPath.safe(name)
            } catch {
                throw error
            }
            let depDir = (depsRoot as NSString).appendingPathComponent(depRelative)

            // 建目录
            do {
                try env.fileManager.createDirectory(
                    atPath: depDir, withIntermediateDirectories: true)
            } catch {
                throw InstallError.extract(dependency: name, reason: error.localizedDescription)
            }

            // 选对应架构的下载地址
            guard let build = pickBuild(spec: spec, arch: arch) else {
                if spec.optional { continue }
                throw InstallError.dependencyMissing(dependency: name, module: root)
            }

            let archiveName = Self.archiveName(from: build.link)
            let archivePath = (depDir as NSString).appendingPathComponent(archiveName)

            // ---- 下载 ----
            safeProgress(onProgress, .step(key: "progress.download", label: name, phase: "download"))
            do {
                // 进度回调要转成 download 闭包要的形状（字节级），
                // 再由我们包一层变成 `InstallProgress.download`。
                let byteProgress: @Sendable (Int64, Int64?) -> Void = { received, total in
                    safeProgress(onProgress, .download(name: name, received: received, total: total))
                }
                _ = try await env.download(build.link, archivePath, byteProgress)
            } catch {
                if spec.optional {
                    // 见文件头 ③：可选依赖失败不能让整个安装失败
                    continue
                }
                throw InstallError.download(
                    dependency: name, url: build.link,
                    reason: (error as? InstallError)?.message ?? error.localizedDescription)
            }

            // ---- 解压 ----
            if build.unzip, env.fileManager.fileExists(atPath: archivePath) {
                safeProgress(onProgress, .step(key: "progress.extracting", label: name, phase: "extracting"))
                do {
                    try env.extract(archivePath, depDir)
                } catch {
                    throw InstallError.extract(
                        dependency: name,
                        reason: (error as? InstallError)?.message ?? error.localizedDescription)
                }
            }

            installed.append(name)
        }

        return installed
    }

    /// 选对应架构的构建。
    ///
    /// ⚠️ **键名有三种写法，实测都遇到过**：
    ///   · `{"x86_64": {...}, "arm64": {...}}`   ← nwjs 这类分架构的包
    ///   · `{"universal": {...}}`                ← mkxpz / RTP 这类通用包（**实测确认**）
    ///   · `{"main": {...}}` / 单个键           ← 单一包
    ///
    /// ⚠️ 还有一层映射：我们的 `currentArch()` 返回 `x64` / `arm64`，
    /// 而 manifest 里写的是 `x86_64` / `arm64`。
    ///
    /// 判据（按优先级）：
    ///   ① 精确匹配 arch（含 x64 → x86_64 映射）
    ///   ② `universal` 键（通用包，任何架构都能用）
    ///   ③ 所有 build 的 link 都相同 → 随便取一个（写法上分了架构但其实是同一个包）
    ///   ④ 只有一个 build → 用它
    public static func pickBuild(spec: DependencySpec, arch: String) -> DependencyBuild? {
        let builds = spec.builds

        // ① 精确匹配（含 x64 ↔ x86_64 映射）
        let candidates = [arch, arch == "x64" ? "x86_64" : arch, "x86_64", "x64"]
        for key in candidates {
            if let build = builds[key] { return build }
        }

        // ② universal（实测：mkxpz 与 RTP 都用这个键）
        if let universal = builds["universal"] { return universal }

        // ③ 所有 link 相同 → 随便取
        if let first = builds.values.first {
            let allSame = builds.values.allSatisfy { $0.link == first.link }
            if allSame { return first }
        }

        return nil
    }

    /// 从 URL 取归档文件名（去掉 query）。
    public static func archiveName(from link: String) -> String {
        guard let url = URL(string: link) else { return "download.bin" }
        let last = url.lastPathComponent
        return last.isEmpty ? "download.bin" : last
    }

    /// 安全的进度回调：**抛错不能打断安装**（见 install 的注释）。
    private static func safeProgress(
        _ onProgress: (@Sendable (InstallProgress) -> Void)?, _ event: InstallProgress
    ) {
        guard let onProgress else { return }
        // 这里不能 throw —— 进度回调没有 throws 签名，但调用方可能在里面搞事情。
        // Swift 的闭包不是 throws，所以这里的「安全」指的是：我们不依赖它的返回值，
        // 也不把它的异常（它抛不出去）当成失败。
        onProgress(event)
    }
}

// MARK: - 更新（D66 的核心）

/// 一次更新的结果。
public struct UpdateEngineResult: Sendable, Equatable {
    /// 被原样保留的多版本依赖名。
    public var kept: [String]
    /// 被重新下载安装的依赖名。
    public var installed: [String]

    public init(kept: [String], installed: [String]) {
        self.kept = kept
        self.installed = installed
    }
}

extension EngineInstaller {

    /// 更新一个引擎，**保住多版本依赖**（D66）。
    ///
    /// 步骤（每一步都有它存在的理由）：
    ///   ① 找出旧 manifest 里所有多版本依赖，**rename** 到 `.update-preserve/`
    ///      （rename 不是 cp：保留目录动辄 100+ MB，cp 会慢且中途失败会留半份）
    ///   ② 写新 manifest（registry 生成，D62）
    ///   ③ **先清空**非多版本依赖的 deps 子目录，再装
    ///      （见文件头 ②，不清会变成「新 manifest + 旧二进制叠加」）
    ///   ④ **finally 里搬回**（成功也搬、失败也搬）
    ///
    /// - Parameters:
    ///   - root: 引擎目录
    ///   - previousDependencies: 旧 manifest 的依赖表（用来找多版本依赖）
    ///   - newDependencies: 新 engine 定义的依赖表
    public static func update(
        root: String,
        previousDependencies: [(name: String, spec: DependencySpec)],
        newDependencies: [(name: String, spec: DependencySpec)],
        env: InstallEnvironment,
        arch: String,
        onProgress: (@Sendable (InstallProgress) -> Void)? = nil
    ) async throws -> UpdateEngineResult {
        let depsRoot = (root as NSString).appendingPathComponent("deps")
        let preserveRoot = (root as NSString).appendingPathComponent(".update-preserve")

        // ① 找出多版本依赖并搬走
        let multiVersionNames = previousDependencies
            .filter { DependencyPath.isMultiVersion($0.name) }
            .map(\.name)

        var moved: [(relative: String, from: String)] = []
        do {
            for name in multiVersionNames {
                let relative = try DependencyPath.safe(name)
                let source = (depsRoot as NSString).appendingPathComponent(relative)
                // 用户没装过这个版本：没什么可保留的
                guard env.fileManager.fileExists(atPath: source) else { continue }

                let destination = (preserveRoot as NSString).appendingPathComponent(relative)
                try env.fileManager.createDirectory(
                    atPath: (destination as NSString).deletingLastPathComponent,
                    withIntermediateDirectories: true)
                try env.fileManager.moveItem(atPath: source, toPath: destination)
                moved.append((relative, destination))
            }
        } catch {
            throw InstallError.extract(dependency: "多版本保留", reason: error.localizedDescription)
        }

        // ⚠️ 用 defer 保证「失败也搬回」。
        //    否则用户的多版本运行时留在 `.update-preserve/` 里等于全坏。
        defer {
            for item in moved {
                let target = (depsRoot as NSString).appendingPathComponent(item.relative)
                try? env.fileManager.removeItem(atPath: target)
                try? env.fileManager.createDirectory(
                    atPath: (target as NSString).deletingLastPathComponent,
                    withIntermediateDirectories: true)
                try? env.fileManager.moveItem(atPath: item.from, toPath: target)
            }
            try? env.fileManager.removeItem(atPath: preserveRoot)
        }

        // ③ 清空非多版本依赖的 deps 子目录（见文件头 ②）
        let wanted = newDependencies.filter { !DependencyPath.isMultiVersion($0.name) }
        for (name, _) in wanted {
            guard let relative = try? DependencyPath.safe(name) else { continue }
            let depDir = (depsRoot as NSString).appendingPathComponent(relative)
            if env.fileManager.fileExists(atPath: depDir) {
                try? env.fileManager.removeItem(atPath: depDir)
            }
        }

        // 装非多版本依赖
        let installed = try await install(
            root: root, dependencies: wanted, env: env, arch: arch, onProgress: onProgress)

        return UpdateEngineResult(
            kept: moved.map(\.relative), installed: installed)
    }

    /// 卸载引擎：删掉整个模块目录。
    ///
    /// 一个删除就够 —— **不需要**额外清理什么：
    /// 卸载的语义就是「这个引擎我不要了」，用户装过的运行时也一起删才是用户预期。
    /// （对比 update：那里是「我还要用，只是刷新定义」，所以必须保住多版本。）
    ///
    /// 目录不存在时静默成功 —— 卸载本来就该幂等。
    public static func uninstall(root: String, fileManager: FileManager = .default) {
        try? fileManager.removeItem(atPath: root)
    }
}
