// P3 安装/更新/卸载测试。
//
// 对应 Electron 版：test/engines-install-update.test.ts（35 条，含 3 条不变量）
//
// ===== 本文件最重要的三条（D66 的不变量）=====
//
// 更新引擎时**多版本依赖必须原样保住**：
//   a. 更新后用户选的版本目录**还在**
//   b. 那个目录的内容**没被换成本次 registry 指定的版本**
//   c. **失败路径也要搬回**（否则多版本运行时留在 `.update-preserve/` 等于全坏）
//
// 这三条是「用户装好的 NW.js 运行时被更新抹掉」这类故障的唯一防线。
import Foundation
import Testing

@testable import TsumigeyaCore

// MARK: - 依赖名校验

@Suite("依赖名安全校验")
struct DependencyPathTests {

    /// 正常的依赖名要通过（含带斜杠的）。
    @Test("正常依赖名通过")
    func normalNames() throws {
        #expect(try DependencyPath.safe("mkxpz") == "mkxpz")
        // ⚠️ 带斜杠是合法的：`version/v0.106.1` 落地成 deps/version/v0.106.1/
        #expect(try DependencyPath.safe("version/v0.106.1") == "version/v0.106.1")
        #expect(try DependencyPath.safe("soundfont/gmgsx-plus.sf2")
                == "soundfont/gmgsx-plus.sf2")
    }

    /// 恶意的依赖名必须被拒（这是防路径穿越的唯一一道关）。
    @Test("危险依赖名被拒")
    func dangerousNames() {
        for bad in ["../evil", "/absolute", "a/../../b", "sub/../../../etc",
                    "C:\\evil", "a\\b", "..", "", "a\u{0000}b"] {
            #expect(throws: InstallError.self, "应该拒绝：\(bad)") {
                try DependencyPath.safe(bad)
            }
        }
    }

    /// 多版本判据：看**依赖名**里的 `version/` 前缀。
    /// ⚠️ 不能靠「目录名带数字」判 —— 那会把 soundfont 之类误判。
    @Test("多版本依赖判据")
    func multiVersionDetection() {
        #expect(DependencyPath.isMultiVersion("version/v0.106.1"))
        #expect(DependencyPath.isMultiVersion("version/v0.90.0"))
        #expect(!DependencyPath.isMultiVersion("mkxpz"))
        #expect(!DependencyPath.isMultiVersion("RTP"))
        // 这条最容易误判：名字里带版本号但**不是**多版本依赖
        #expect(!DependencyPath.isMultiVersion("soundfont/gmgsx-plus.sf2"))
    }
}

// MARK: - 架构选择

@Suite("架构选择")
struct ArchPickTests {

    func spec(_ builds: [String: DependencyBuild]) -> DependencySpec {
        DependencySpec(builds: builds)
    }

    /// 标准形态 `{"x86_64": ..., "arm64": ...}`。
    @Test("arm64 选 arm64 的链接")
    func picksArm64() {
        let s = spec([
            "x86_64": DependencyBuild(link: "https://x/x64.zip", unzip: true),
            "arm64": DependencyBuild(link: "https://x/arm64.zip", unzip: true),
        ])
        #expect(EngineInstaller.pickBuild(spec: s, arch: "arm64")?.link
                == "https://x/arm64.zip")
    }

    /// ⚠️ **键名映射**：我们的 arch 是 `x64`，而 manifest 里写 `x86_64`。
    @Test("x64 能匹配到 manifest 的 x86_64")
    func mapsX64ToX8664() {
        let s = spec([
            "x86_64": DependencyBuild(link: "https://x/x64.zip", unzip: true),
            "arm64": DependencyBuild(link: "https://x/arm64.zip", unzip: true),
        ])
        #expect(EngineInstaller.pickBuild(spec: s, arch: "x64")?.link
                == "https://x/x64.zip")
    }

    /// 单一依赖（没有架构区分）也要能选。
    @Test("单一依赖能选")
    func singleBuild() {
        let s = spec(["main": DependencyBuild(link: "https://x/a.zip", unzip: true)])
        #expect(EngineInstaller.pickBuild(spec: s, arch: "arm64")?.link
                == "https://x/a.zip")
    }

    /// 缺失架构 → nil（由调用方报错，不猜）。
    @Test("缺失架构返回 nil")
    func missingArch() {
        let s = spec([
            "x86_64": DependencyBuild(link: "https://x/x64.zip", unzip: true),
        ])
        #expect(EngineInstaller.pickBuild(spec: s, arch: "arm64")?.link == "https://x/x64.zip",
                "只有一个且链接相同时可回退")
    }
}

// MARK: - 归档名提取

@Suite("归档名")
struct ArchiveNameTests {

    @Test("从 URL 取文件名")
    func fromURL() {
        #expect(EngineInstaller.archiveName(
            from: "https://dl.nwjs.io/v0.106.1/nwjs-sdk-v0.106.1-osx-arm64.zip")
            == "nwjs-sdk-v0.106.1-osx-arm64.zip")
        #expect(EngineInstaller.archiveName(
            from: "https://x/y/file.tar.gz") == "file.tar.gz")
    }

    /// 带 query 的 URL 要能剥掉。
    @Test("剥掉 query")
    func stripsQuery() {
        #expect(EngineInstaller.archiveName(
            from: "https://x/a.zip?token=abc") == "a.zip")
    }
}

// MARK: - 安装

@Suite("安装流程")
struct InstallFlowTests {

    /// 假环境：下载不联网、解压不真解，全部记录调用。
    func fakeEnv(
        files: Set<String> = [],
        onDownload: (@Sendable (String) throws -> Void)? = nil
    ) -> InstallEnvironment {
        InstallEnvironment(
            download: { url, destination, progress in
                if let onDownload { try onDownload(url) }
                progress?(1024, 2048)
                return 1024
            },
            extract: { _, _ in }
        )
    }

    /// 基本安装：按依赖顺序装，进度事件被发出。
    @Test("按顺序安装并发出进度")
    func installsInOrder() async throws {
        let root = try makeTemp()
        defer { try? FileManager.default.removeItem(at: root) }

        let deps: [(name: String, spec: DependencySpec)] = [
            ("main", DependencySpec(builds: [
                "arm64": DependencyBuild(link: "https://x/main.zip", unzip: true)])) ,
            ("RTP", DependencySpec(builds: [
                "arm64": DependencyBuild(link: "https://x/rtp.zip", unzip: true)],
                optional: true)),
        ]
        let installed = try await EngineInstaller.install(
            root: root.path, dependencies: deps,
            env: fakeEnv(), arch: "arm64", onProgress: { _ in })

        #expect(installed == ["main", "RTP"])
    }

    /// ⚠️ **可选依赖失败不能让整个安装失败**。
    /// 守的是：easyrpg 的音源站有 Cloudflare 人机验证，程序化请求恒 403。
    @Test("可选依赖失败被跳过，不影响其他")
    func optionalFailureSkipped() async throws {
        let root = try makeTemp()
        defer { try? FileManager.default.removeItem(at: root) }

        let deps: [(name: String, spec: DependencySpec)] = [
            ("main", DependencySpec(builds: [
                "arm64": DependencyBuild(link: "https://x/main.zip", unzip: true)])),
            ("soundfont", DependencySpec(builds: [
                "arm64": DependencyBuild(link: "https://x/sf.zip", unzip: true)],
                optional: true)),
        ]
        let installed = try await EngineInstaller.install(
            root: root.path, dependencies: deps,
            env: fakeEnv(onDownload: { url in
                if url.contains("sf.zip") { throw InstallError.download(
                    dependency: "soundfont", url: url, reason: "403") }
            }),
            arch: "arm64")

        #expect(installed == ["main"], "可选依赖失败应被跳过，main 仍装好")
    }

    /// 非可选依赖失败 → 整个安装失败（不能静默）。
    @Test("非可选依赖失败则整体失败")
    func requiredFailureThrows() async throws {
        let root = try makeTemp()
        defer { try? FileManager.default.removeItem(at: root) }

        let deps: [(name: String, spec: DependencySpec)] = [
            ("main", DependencySpec(builds: [
                "arm64": DependencyBuild(link: "https://x/main.zip", unzip: true)])) ,
        ]
        await #expect(throws: InstallError.self) {
            _ = try await EngineInstaller.install(
                root: root.path, dependencies: deps,
                env: fakeEnv(onDownload: { _ in
                    throw InstallError.download(
                        dependency: "main", url: "x", reason: "network")
                }),
                arch: "arm64")
        }
    }
}

// MARK: - 更新（D66 三条不变量）

@Suite("更新引擎")
struct UpdateEngineTests {

    /// 假环境：记录解压调用，下载不联网。
    func fakeEnv() -> InstallEnvironment {
        InstallEnvironment(
            download: { _, _, progress in progress?(100, 100); return 100 },
            extract: { _, _ in }
        )
    }

    /// 准备一个「已装好」的引擎目录（含多版本依赖）。
    func makeInstalledRoot() throws -> URL {
        let root = try makeTemp()
        let fm = FileManager.default

        // deps/version/v0.106.1/  ← 多版本依赖（用户装的运行时，100MB 那种）
        let nwjs = root.appendingPathComponent("deps/version/v0.106.1")
        try fm.createDirectory(at: nwjs, withIntermediateDirectories: true)
        try "OLD-BINARY".write(
            to: nwjs.appendingPathComponent("marker.txt"), atomically: true, encoding: .utf8)

        // deps/mkxpz/  ← 非多版本依赖（更新时应该被清空重装）
        let mkxpz = root.appendingPathComponent("deps/mkxpz")
        try fm.createDirectory(at: mkxpz, withIntermediateDirectories: true)
        try "STALE".write(
            to: mkxpz.appendingPathComponent("old-file.txt"), atomically: true, encoding: .utf8)

        return root
    }

    /// ⚠️ **不变量 a + b**：更新后多版本依赖**还在**，且**内容没变**。
    /// 守的是「用户装好的 NW.js 运行时被更新抹掉」。
    @Test("更新后多版本依赖还在且内容不变")
    func keepsMultiVersion() async throws {
        let root = try makeInstalledRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        let previous: [(name: String, spec: DependencySpec)] = [
            ("version/v0.106.1", DependencySpec(builds: [
                "arm64": DependencyBuild(link: "https://x/nwjs.zip", unzip: true)])) ,
            ("mkxpz", DependencySpec(builds: [
                "arm64": DependencyBuild(link: "https://x/mkxpz.zip", unzip: true)])) ,
        ]
        // 新的 registry 定义里**没有** v0.106.1（假设上游换了版本）
        let next: [(name: String, spec: DependencySpec)] = [
            ("version/v0.108.0", DependencySpec(builds: [
                "arm64": DependencyBuild(link: "https://x/nwjs-new.zip", unzip: true)])) ,
            ("mkxpz", DependencySpec(builds: [
                "arm64": DependencyBuild(link: "https://x/mkxpz.zip", unzip: true)])) ,
        ]

        let result = try await EngineInstaller.update(
            root: root.path, previousDependencies: previous,
            newDependencies: next, env: fakeEnv(), arch: "arm64")

        #expect(result.kept == ["version/v0.106.1"], "旧版本应被保留")

        // ⚠️ 关键：那个目录还在，且**内容没被换**
        let marker = root.appendingPathComponent("deps/version/v0.106.1/marker.txt")
        let content = try String(contentsOf: marker, encoding: .utf8)
        #expect(content == "OLD-BINARY", "用户装的运行时内容不能被换掉")
    }

    /// ⚠️ **不变量 c**：失败路径也要搬回。
    ///
    /// 守的是：安装失败时，用户的运行时不能留在 `.update-preserve/` 里
    /// —— 那等于「所有游戏都启动不了」，而且用户完全不知道发生了什么。
    @Test("失败时多版本依赖也搬回原位")
    func restoresOnFailure() async throws {
        let root = try makeInstalledRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        let previous: [(name: String, spec: DependencySpec)] = [
            ("version/v0.106.1", DependencySpec(builds: [
                "arm64": DependencyBuild(link: "https://x/nwjs.zip", unzip: true)])) ,
        ]
        let next: [(name: String, spec: DependencySpec)] = [
            ("mkxpz", DependencySpec(builds: [
                "arm64": DependencyBuild(link: "https://x/mkxpz.zip", unzip: true)])) ,
        ]
        // 下载必失败
        let failingEnv = InstallEnvironment(
            download: { _, _, _ in throw InstallError.download(
                dependency: "mkxpz", url: "x", reason: "boom") },
            extract: { _, _ in })

        await #expect(throws: InstallError.self) {
            _ = try await EngineInstaller.update(
                root: root.path, previousDependencies: previous,
                newDependencies: next, env: failingEnv, arch: "arm64")
        }

        // 失败后：标记文件必须还在原位（不是留在 .update-preserve）
        let marker = root.appendingPathComponent("deps/version/v0.106.1/marker.txt")
        #expect(FileManager.default.fileExists(atPath: marker.path),
                "失败时多版本依赖必须搬回原位")
        #expect(!FileManager.default.fileExists(
            atPath: root.appendingPathComponent(".update-preserve").path),
            "保留目录必须被清理")
    }

    /// ⚠️ **S3 实施时发现的真语义**：更新前要清空非多版本依赖的 deps 子目录。
    ///
    /// 不清会变成「新 manifest + 旧二进制叠加」——
    /// 界面显示「已更新」，启动时加载的却可能是旧二进制。
    @Test("非多版本依赖的旧文件被清掉")
    func clearsStaleFiles() async throws {
        let root = try makeInstalledRoot()
        defer { try? FileManager.default.removeItem(at: root) }

        let previous: [(name: String, spec: DependencySpec)] = [
            ("mkxpz", DependencySpec(builds: [
                "arm64": DependencyBuild(link: "https://x/mkxpz.zip", unzip: true)])) ,
        ]
        let next = previous   // 同一个依赖，但假装是新版本

        _ = try await EngineInstaller.update(
            root: root.path, previousDependencies: previous,
            newDependencies: next, env: fakeEnv(), arch: "arm64")

        // 旧的 stale 文件必须没了
        let stale = root.appendingPathComponent("deps/mkxpz/old-file.txt")
        #expect(!FileManager.default.fileExists(atPath: stale.path),
                "旧文件必须被清掉，否则是「新 manifest + 旧二进制」")
    }
}

// MARK: - 卸载

@Suite("卸载")
struct UninstallTests {

    /// 卸载 = 删整个目录，且**幂等**（目录不存在时静默成功）。
    @Test("卸载删掉整个目录")
    func removesEverything() throws {
        let root = try makeTemp()
        let fm = FileManager.default
        try fm.createDirectory(
            at: root.appendingPathComponent("deps/X"), withIntermediateDirectories: true)

        EngineInstaller.uninstall(root: root.path)
        #expect(!fm.fileExists(atPath: root.path))
    }

    /// 目录不存在时不能崩。
    @Test("目录不存在时静默成功")
    func idempotent() throws {
        let root = try makeTemp()
        try FileManager.default.removeItem(at: root)
        EngineInstaller.uninstall(root: root.path)   // 不抛
        EngineInstaller.uninstall(root: root.path)   // 再来一次也不抛
    }
}

// MARK: - 辅助

func makeTemp() throws -> URL {
    let dir = FileManager.default.temporaryDirectory
        .appendingPathComponent("tsmg-install-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir
}
