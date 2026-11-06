import Foundation
import TsumigeyaCore

// MARK: - 安装命令

func runInstall(engine: String?, dryRun: Bool) -> Int {
    let dir = DataDir.resolve()
    print("")
    print("=== 引擎安装（P3 端到端）===")
    print("数据目录: \(dir.path)")

    guard let engine, !engine.isEmpty else {
        print("")
        print("用法：tsumigeya-cli install <引擎名> [--dry-run]")
        print("可装引擎：")
        for e in EngineRegistry.launchable {
            let p = BinaryPaths.moduleDir(dir.path, e.folder)
            let installed = FileManager.default.fileExists(atPath: p)
            print("  \(e.folder.padding(toLength: 12, withPad: " ", startingAt: 0)) \(e.name)"
                  + (installed ? "  [已装]" : "  [未装]"))
        }
        return 2
    }

    guard let definition = EngineRegistry.launchable.first(where: { $0.folder == engine }) else {
        print("❌ 没有这个可启动引擎：\(engine)")
        return 1
    }

    let root = BinaryPaths.moduleDir(dir.path, definition.folder)
    let existed = FileManager.default.fileExists(atPath: root)

    print("")
    print("引擎    : \(definition.name)（\(definition.folder)）")
    print("落地目录: \(root)")
    print("状态    : \(existed ? "**已装**（会覆盖）" : "未装（全新安装）")")

    if existed && !dryRun {
        print("")
        print("⚠️ 这个引擎已经装了。为了不破坏你的运行时，这里**拒绝覆盖**。")
        print("   如果你确实要重装，先手动删掉：rm -rf \"\(root)\"")
        return 1
    }

    // ---- 拿依赖表（从 registry 生成，不是读本地 manifest）----
    //
    // ⚠️ **必须从 registry 来，不是读本地 manifest**：全新安装时本地还没有
    // manifest.json，读它必然失败。
    //
    // 依赖表在 `EngineDependencies.dependencies(for:)`（P3 补的）。
    let deps = EngineDependencies.dependencies(for: definition.folder)
    guard !deps.isEmpty || definition.folder == "tyrano" else {
        print("")
        print("❌ registry 里没有 \(definition.folder) 的依赖表 —— 无法安装。")
        return 1
    }

    print("")
    print("依赖    : \(deps.count) 个")
    for (name, spec) in deps {
        let build = EngineInstaller.pickBuild(spec: spec, arch: currentArch())
        let tag = spec.optional ? "[可选]" : ""
        if let build {
            print("  \(name.padding(toLength: 20, withPad: " ", startingAt: 0))\(tag)")
            print("      \(build.link)")
            if !build.unzip { print("      （不打包，直接落盘）") }
        } else {
            print("  \(name.padding(toLength: 20, withPad: " ", startingAt: 0))❌ 当前架构无链接")
        }
    }

    if dryRun {
        print("")
        print("（--dry-run：只展示计划，不下载）")
        return 0
    }

    // ---- 真装 ----
    return installRealEngine(
        definition: definition, dependencies: deps, root: root, dataDir: dir.path)
}

// MARK: - 真的装

func installRealEngine(
    definition: EngineDefinition,
    dependencies: [(name: String, spec: DependencySpec)],
    root: String, dataDir: String
) -> Int {
    let fileManager = FileManager.default
    let depsRoot = (root as NSString).appendingPathComponent("deps")

    print("")
    print("=== 开始安装（下载 → 解压）===")

    let before = (try? fileManager.contentsOfDirectory(atPath: root)) ?? []
    print("装之前目录内容: \(before.isEmpty ? "（不存在）" : before.joined(separator: ", "))")

    do {
        try fileManager.createDirectory(
            atPath: root, withIntermediateDirectories: true)
    } catch {
        print("❌ 建目录失败: \(error.localizedDescription)")
        return 1
    }

    // ⚠️ 先写 manifest（D62）：从 registry 生成，字段名兼容上游。
    //    执行顺序很重要：先写 manifest，之后 install 流程里读它才有东西可读。
    let manifestJSON = JSONValue.object(EngineDependencies.buildManifest(for: definition))
    if let manifestData = try? JSONStore.defaultEncoder.encode(manifestJSON) {
        let path = (root as NSString).appendingPathComponent("manifest.json")
        if (try? manifestData.write(to: URL(fileURLWithPath: path), options: .atomic)) == nil {
            print("❌ 写 manifest 失败")
            return 1
        }
        print("✅ manifest.json 已写入（\(manifestData.count) 字节）")
    }

    // 组装真实环境：URLSession 下载 + tar 解压
    let downloader = Downloader()
    let env = InstallEnvironment(
        download: { url, destination, progress in
            try await downloader.download(url, to: destination) { p in
                progress?(p.receivedBytes, p.totalBytes)
            }
            // 返回下载字节数（installer 目前不用它，但语义要正确）
            let attrs = try? FileManager.default.attributesOfItem(atPath: destination)
            return (attrs?[.size] as? Int64) ?? 0
        },
        extract: { archive, destination in
            try Extract.extractArchive(archive: archive, to: destination)
        }
    )

    do {
        let installed = try await_install(
            root: root, dependencies: dependencies, env: env)
        print("")
        print("✅ 安装完成，装好 \(installed.count) 个依赖：\(installed.joined(separator: ", "))")
    } catch let error as InstallError {
        print("")
        print("❌ 安装失败：\(error.message)")
        return 1
    } catch {
        print("")
        print("❌ 安装失败：\(error.localizedDescription)")
        return 1
    }

    // ---- 验证：二进制路径对不对 ----
    print("")
    print("=== 验证 ===")
    let arch = currentArch()
    if let binary = BinaryPaths.binary(
        for: definition.folder, dataDir: dataDir, arch: arch) {
        let exec = fileManager.isExecutableFile(atPath: binary)
        print("\(exec ? "✅" : "⚠️") 二进制: \(binary)")
        if !exec { print("     存在但不可执行") }
    } else {
        print("❌ 找不到二进制（路径拼法可能与实际布局不符）")
        // 列出 deps 实际内容，便于修正
        print("   deps 实际内容：")
        if let items = try? fileManager.contentsOfDirectory(atPath: depsRoot) {
            for item in items.sorted().prefix(10) { print("     \(item)") }
        }
        return 1
    }

    // 清理下载下来的压缩包（它们已经在 deps 里了，没必要留着占地方）
    //
    // ⚠️ 但**只删压缩包**，绝不删解压出来的东西。
    cleanupArchives(depsRoot: depsRoot)

    return 0
}

/// 异步安装的同步包装（CLI 是同步的）。
///
/// ⚠️ **不能用 `Task { }` + `DispatchSemaphore`**：Swift 6 的严格并发检查会报
/// `sending value of non-Sendable type '() async -> ()' risks causing data races`
/// ——闭包捕获了 `result`（可变）和 `semaphore`，跨并发域传递不安全。
///
/// 解法：用 `DispatchQueue` + 一个**独立的** `@Sendable` 结果盒子。
/// 更简单可靠的做法是让整个 main 变成 async（见 `mainAsync`），
/// 但那样要改 main.swift 的调用方式 —— 这里用信号量 + 加锁盒子，改动面最小。
final class ResultBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Result<[String], Error>?

    func set(_ result: Result<[String], Error>) {
        lock.lock()
        defer { lock.unlock() }
        value = result
    }

    func get() -> Result<[String], Error>? {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}

func await_install(
    root: String, dependencies: [(name: String, spec: DependencySpec)],
    env: InstallEnvironment
) throws -> [String] {
    let semaphore = DispatchSemaphore(value: 0)
    let box = ResultBox()

    // ⚠️ `dependencies` 是元组数组（非 Sendable 是因为 DependencySpec 含闭包？
    //    不，DependencySpec 是纯值。但元组数组本身要显式标注）。
    //    这里把它换成 Sendable 的包装：EngineInstaller.install 内部只用值语义。
    let deps: [(name: String, spec: DependencySpec)] = dependencies

    Task { @Sendable in
        do {
            let installed = try await EngineInstaller.install(
                root: root,
                dependencies: deps,
                env: env,
                arch: currentArch(),
                onProgress: { event in
                    switch event {
                    case .step(let key, let label, _):
                        print("   [\(key)] \(label)")
                    case .download(let name, let received, let total):
                        if let total, total > 0 {
                            let pct = Int(Double(received) / Double(total) * 100)
                            print("   ↓ \(name) \(pct)% (\(received)/\(total))")
                        } else {
                            print("   ↓ \(name) \(received) 字节")
                        }
                    }
                })
            box.set(.success(installed))
        } catch {
            box.set(.failure(error))
        }
        semaphore.signal()
    }

    semaphore.wait()
    guard let result = box.get() else {
        throw InstallError.extract(dependency: "install", reason: "安装没有返回结果")
    }
    return try result.get()
}

/// 删 deps 下的压缩包（解压完就不再需要）。
func cleanupArchives(depsRoot: String) {
    let fm = FileManager.default
    guard let enumerator = fm.enumerator(atPath: depsRoot) else { return }
    var removed = 0
    for case let path as String in enumerator {
        let name = (path as NSString).lastPathComponent
        let isArchive = name.hasSuffix(".zip") || name.hasSuffix(".tgz")
            || name.hasSuffix(".tar.gz") || name.hasSuffix(".tar.bz2")
            || name.hasSuffix(".tbz2")
        guard isArchive else { continue }
        let full = (depsRoot as NSString).appendingPathComponent(path)
        if (try? fm.removeItem(atPath: full)) != nil { removed += 1 }
    }
    if removed > 0 {
        print("🧹 清理了 \(removed) 个压缩包（解压后的内容保留）")
    }
}
