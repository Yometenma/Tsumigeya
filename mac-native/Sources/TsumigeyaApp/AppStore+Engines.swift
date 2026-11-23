import Foundation
import AppKit
import TsumigeyaCore

@MainActor
extension AppStore {
    /// 刷新引擎状态表。
    func refreshEngineEntries() {
        engineEntries = EngineStatus.scan(dataDir: dataDir)
        installedEngines = Set(engineEntries.filter(\.installed).map(\.id))
    }

    /// 安装一个引擎。
    ///
    /// - Parameters:
    ///   - folder: 引擎 folder
    ///   - force: `true` = 已装也重装（覆盖）
    ///
    /// ⚠️ **拒绝覆盖已装的**（非 force），与 CLI 同一个保护：
    ///    用户机器上已有 1.1GB 运行时，误覆盖等于删掉他装好的东西。
    func installEngine(_ folder: String, force: Bool) {
        guard let definition = EngineRegistry.find(folder: folder) else { return }

        // 已经在装 → 忽略重复点击
        if installTasks[folder] != nil { return }

        // 已装且非 force → 拒绝
        let root = BinaryPaths.moduleDir(dataDir, folder)
        refreshEngineEntries()
        if !force && installedEngines.contains(folder) {
            engineErrors[folder] = String(format: L("「%@」已经装了。要重装请点「重装」。"), "\(definition.name)")
            return
        }
        if !runningGames.isEmpty {
            engineErrors[folder] = L("请先停止游戏，再安装或重新安装运行时。")
            return
        }
        var acceptRosettaLicense = false
        if folder == "wine", Arch.current().rawValue == "arm64", !WineRuntime.rosettaAvailable() {
            let alert = NSAlert()
            alert.messageText = L("安装 Wine 所需的 Rosetta 2？")
            alert.informativeText = L("此 Wine 运行时需要 Rosetta 2。继续即表示同意 Apple 的 Rosetta 2 软件许可，启动器将调用系统安装程序。取消不会安装。")
            alert.addButton(withTitle: L("同意并安装"))
            alert.addButton(withTitle: L("取消"))
            guard alert.runModal() == .alertFirstButtonReturn else { return }
            acceptRosettaLicense = true
        }
        engineErrors.removeValue(forKey: folder)
        let token = UUID()
        installTokens[folder] = token

        let deps = EngineDependencies.dependencies(for: folder)
        engineProgress[folder] = .step(label: L("准备中"))

        let task = Task { [weak self] in
            guard let self else { return }
            await self.runInstall(folder: folder, root: root, deps: deps, token: token, acceptRosettaLicense: acceptRosettaLicense)
        }
        installTasks[folder] = task
    }

    /// 真正的安装执行。
    ///
    /// ⚠️ **整个流程在 `Task` 里跑**（不是阻塞主线程）：
    ///    RTP 有 244MB，阻塞主线程会把 UI 冻住 —— 用户会以为卡死然后强杀。
    private func runInstall(
        folder: String, root: String, deps: [(name: String, spec: DependencySpec)], token: UUID, acceptRosettaLicense: Bool
    ) async {
        defer {
            if installTokens[folder] == token {
                engineProgress.removeValue(forKey: folder)
                installTasks.removeValue(forKey: folder)
                installTokens.removeValue(forKey: folder)
                refreshEngineEntries()
            }
        }
        let downloader = Downloader()
        let env = InstallEnvironment(
            download: { url, destination, progress in
                try await downloader.download(url, to: destination) { p in
                    progress?(p.receivedBytes, p.totalBytes)
                }
                let attrs = try? FileManager.default.attributesOfItem(atPath: destination)
                return (attrs?[.size] as? Int64) ?? 0
            },
            extract: { archive, destination in
                try Task.checkCancellation()
                try Extract.extractArchive(archive: archive, to: destination)
                try Task.checkCancellation()
            }
        )

        do {
            // 先写 manifest（D62：全新安装时本地还没有）
            try FileManager.default.createDirectory(
                atPath: root, withIntermediateDirectories: true)
            let manifestJSON = JSONValue.object(
                EngineDependencies.buildManifest(for: EngineRegistry.find(folder: folder)!))
            let data = try JSONStore.defaultEncoder.encode(manifestJSON)
            let path = (root as NSString).appendingPathComponent("manifest.json")
            try data.write(to: URL(fileURLWithPath: path), options: .atomic)
            try Task.checkCancellation()

            _ = try await EngineInstaller.install(
                root: root,
                dependencies: deps,
                env: env,
                arch: Arch.current().rawValue,
                acceptRosettaLicense: acceptRosettaLicense,
                onProgress: { [weak self] event in
                    // ⚠️ 进度回调在**后台线程** → 必须切回 MainActor 才能改 @Published
                    Task { @MainActor in
                        guard let self, self.installTokens[folder] == token,
                              self.installTasks[folder]?.isCancelled == false else { return }
                        switch event {
                        case .step(let key, let label, _):
                            let human = Self.humanLabel(forKey: key, label: label)
                            self.engineProgress[folder] = .step(label: human)
                        case .download(let name, let received, let total):
                            self.engineProgress[folder] = .downloading(
                                name: name, received: received, total: total)
                        }
                    }
                })

        } catch {
            if !Task.isCancelled {
                let message = (error as? InstallError)?.message ?? error.localizedDescription
                engineErrors[folder] = String(format: L("安装失败：%@"), "\(message)")
            }
        }
    }

    /// 追加安装一个 NW.js 版本（多版本共存，见 D66）。
    ///
    /// 为什么单独一个入口：`installEngine("nwjs")` 会按依赖表装「默认版本」，
    /// 而这里要装的是**用户挑的那一个**。装完不动其它已装版本，
    /// 游戏可以在「编辑游戏 → 引擎参数 → 版本」里选。
    func installNwjsVersion(_ version: String) {
        let folder = "nwjs"
        guard installTasks[folder] == nil else {
            engineErrors[folder] = L("正在安装，请等这次结束。")
            return
        }
        guard let dependency = EngineDependencies.nwjsDependency(forVersion: version) else {
            engineErrors[folder] = String(format: L("不认识的 NW.js 版本：%@"), "\(version)")
            return
        }
        if NwjsVersion.availableVersions(dataDir: dataDir).contains(version) {
            engineErrors[folder] = String(format: L("「%@」已经装了。"), "\(version)")
            return
        }
        if !runningGames.isEmpty {
            engineErrors[folder] = L("请先停止游戏，再安装运行时。")
            return
        }
        engineErrors.removeValue(forKey: folder)
        let token = UUID()
        installTokens[folder] = token
        let root = BinaryPaths.moduleDir(dataDir, folder)
        engineProgress[folder] = .step(label: L("准备中"))

        let task = Task { [weak self] in
            guard let self else { return }
            // 复用 runInstall：进度、取消、错误处理与「安装引擎」完全一致。
            // ⚠️ 它会重写 manifest.json（内容是 registry 里的默认依赖表），
            //    不包含这里追加的版本 —— 但版本枚举靠扫 `deps/version/` 目录
            //    （NwjsVersion.availableVersions），不依赖 manifest，所以没有副作用。
            await self.runInstall(
                folder: folder, root: root, deps: [dependency], token: token,
                acceptRosettaLicense: false)
        }
        installTasks[folder] = task
    }

    /// 把进度事件的 i18n key 翻成人话。
    ///
    /// ⚠️ core 里给的是 key（`progress.download`），因为 core 不该管文案
    ///    （规矩：文案一律进 locales）。这里做最后一步翻译。
    private static func humanLabel(forKey key: String, label: String) -> String {
        switch key {
        case "progress.prepare": return String(format: L("准备 %@"), "\(label)")
        case "progress.download": return String(format: L("正在下载 %@"), "\(label)")
        case "progress.extracting": return String(format: L("正在解压 %@"), "\(label)")
        case "progress.done": return String(format: L("%@ 完成"), "\(label)")
        default: return label
        }
    }

    /// 取消安装。
    ///
    /// ⚠️ 语义是「丢弃这次任务」而不是「优雅回滚」——
    ///    已下载的部分会成为**半截目录**。好在 `EngineStatus.scan` 的判据是
    ///    「二进制能不能找到」而不是「目录存不存在」，所以半截目录会显示成「未装」，
    ///    用户可以重装覆盖。**不做自动清理**（删了可能删到用户别的文件）。
    func cancelEngineInstall(_ folder: String) {
        guard let task = installTasks[folder] else { return }
        task.cancel()
        engineProgress[folder] = .step(label: L("正在取消…"))
    }

    /// 卸载引擎（删掉整个模块目录）。
    func uninstallEngine(_ folder: String) {
        refreshRunning()
        guard runningGames.isEmpty, installTasks[folder] == nil else {
            engineErrors[folder] = L("请先停止游戏并等待安装结束，再卸载运行时。")
            return
        }
        let root = BinaryPaths.moduleDir(dataDir, folder)
        EngineInstaller.uninstall(root: root)
        refreshEngineEntries()
    }

}
