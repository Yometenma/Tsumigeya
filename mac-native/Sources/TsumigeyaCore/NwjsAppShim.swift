// NW.js 应用目录的 package.json 兼容层。
//
// 对应契约：D53（不碰游戏文件）
//
// ===== 这是运行时差异，不是游戏文件损坏 =====
//
// 同一个游戏在 Windows 上正常，因为它自带的是 **NW.js 0.72.0**
// （`nw.dll` 里能看到 `0.72.0` 与 `nw72_win32` 的构建路径），老运行时容忍 `name` 为空。
// macOS 这边启动器用的是 **v0.106.1**（Chromium 143），它按 Chrome 扩展的语义校验
// app 清单，`name` 必须是非空字符串 —— 同一份 `package.json` 就被拒了。
//
// 实测：v0.106.1 直接传游戏目录会弹
//   “无法加载以下来源的扩展程序：… Required value 'name' is missing or invalid.”
// 之后进程**还活着**（它在等用户点确定），所以启动器看起来「启动成功」，实际上
// 游戏窗口从来没出现。这类失败只能由启动器兜住：兼容是我们的职责，不是让用户去改游戏。
//
// 同一台机器上另外四个 nwjs 游戏（`karrynsprison50` / `rmmz-game` / `celesphonia_mv`）
// 的 `name` 都正常，说明这不是「nwjs 支持不了」，而是**清单字段的校验差异**。
//
// ===== 怎么做（不改游戏文件）=====
//
// 在数据目录里生成一个「兼容 app 目录」，只在需要时生成：
//
//   <dataDir>/nwjs-apps/<sha1(游戏目录) 前 12>/
//       package.json        ← 只把 name 补成 <slug>-<hash8>，其余字段原样保留
//       www/   → 游戏目录/www      （绝对符号链接）
//       data/  → 游戏目录/data     （其余顶层条目逐个链接）
//
// 传给 nw.js 的是兼容目录；游戏的真实文件经符号链接读取。
// **存档位置不变**：MV 的 `StorageManager.localFileDirectoryPath()` 取
// `path.dirname(process.mainModule.filename) + 'save/'`，那条路径经 `www` 链接
// 仍然落在游戏真实的 `www/save/` 下（本游戏就是文件式存档）。
//
// ⚠️ name 同时决定 nw.js 的 profile 目录（localStorage 等）。这里用
//    `<目录名 slug>-<路径哈希前8>`：不同游戏不会共用 profile（避免 localStorage 串档），
//    同一游戏在同一路径下每次都得到同一个 name（稳定）。
import Foundation

public enum NwjsAppShim {

    /// 兼容目录的根：`<dataDir>/nwjs-apps`。
    public static func root(dataDir: String) -> String {
        (dataDir as NSString).appendingPathComponent("nwjs-apps")
    }

    /// 某个游戏的兼容 app 目录。
    public static func appDir(dataDir: String, folder: String) -> String {
        (root(dataDir: dataDir) as NSString)
            .appendingPathComponent(String(sha1Hex(folder).prefix(12)))
    }

    /// 游戏清单的路径。
    public static func packagePath(folder: String) -> String {
        (folder as NSString).appendingPathComponent("package.json")
    }

    /// 一份 `package.json` 在「能不能被 nw.js 当 app 清单加载」这个维度上的状态。
    ///
    /// 这几类的处置不同，不能混成一个布尔：
    ///   · `missing`     —— 没有清单，不是标准 nw.js app（或清单在子目录里）；不介入
    ///   · `unreadable`  —— 有清单但连解析都做不到（截断、编码损坏、根本不是 JSON）；
    ///                      **修不了，只能解释**
    ///   · `nameInvalid` —— 清单能解析但 `name` 不合格；用兼容目录补上
    ///   · `loose`       —— 能解析、`name` 也合格，但**原文不是严格 JSON**
    ///                      （尾逗号之类）；nw.js 会拒收，所以也要重写成标准 JSON
    ///
    /// ⚠️ 判据是 Foundation 的 JSON 解析，比 Chromium 的 `JSON.parse` 宽容
    ///    （实测容忍尾逗号）。所以「能解析」不代表 nw.js 一定吃得下 ——
    ///    `loose` 这一档就是用来补这个差集的（见 `StrictJSON`）。
    public enum ManifestStatus: Sendable, Equatable {
        case missing
        case unreadable
        case nameInvalid
        case loose
        case ok
    }

    /// 清单状态（只读，不写盘）。
    public static func manifestStatus(
        folder: String, fileManager: FileManager = .default
    ) -> ManifestStatus {
        guard let data = fileManager.contents(atPath: packagePath(folder: folder)) else {
            return .missing
        }
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return .unreadable
        }
        if !isValidAppName(object["name"]) { return .nameInvalid }
        return StrictJSON.isValid(data) ? .ok : .loose
    }

    /// `name` 是否合法（NW.js / Chrome 扩展的判据：非空、非下划线开头）。
    public static func isValidAppName(_ value: Any?) -> Bool {
        guard let raw = value as? String else { return false }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        return !trimmed.hasPrefix("_")
    }

    /// 这个游戏是否需要兼容目录（`name` 不合格，或清单不是严格 JSON）。
    public static func requiresRepair(folder: String, fileManager: FileManager = .default) -> Bool {
        switch manifestStatus(folder: folder, fileManager: fileManager) {
        case .nameInvalid, .loose: return true
        case .missing, .unreadable, .ok: return false
        }
    }

    /// 补好的 name：`<slug>-<sha1 前8>`。
    ///
    /// slug 只保留 `a-z0-9` 和单个 `-`（Chrome 对 name 无字符限制，但路径/目录名要安全），
    /// 空 slug（例如目录名全是中文）回落到 `game`。
    public static func appName(for folder: String) -> String {
        let base = (folder as NSString).lastPathComponent.lowercased()
        var slug = ""
        var lastWasDash = false
        for scalar in base.unicodeScalars {
            let isLower = scalar.value >= 97 && scalar.value <= 122
            let isDigit = scalar.value >= 48 && scalar.value <= 57
            if isLower || isDigit {
                slug.unicodeScalars.append(scalar)
                lastWasDash = false
            } else if !lastWasDash, !slug.isEmpty {
                slug.append("-")
                lastWasDash = true
            }
        }
        while slug.hasSuffix("-") { slug.removeLast() }
        if slug.isEmpty { slug = "game" }
        let hash = sha1Hex(folder).prefix(8)
        return "\(slug.prefix(32))-\(hash)"
    }

    /// 生成 / 更新兼容目录，返回要传给 nw.js 的目录；不需要或无法处理时返回 nil。
    ///
    /// 幂等：内容一致时不写盘；链接指向不对时重建那一条。
    /// 任何一步失败都返回 nil，由调用方退回「直接用游戏目录」——不能因为兼容层
    /// 出问题就把本来能跑的游戏也搞成不跑。
    public static func ensure(
        dataDir: String, folder: String, fileManager: FileManager = .default
    ) -> String? {
        let fm = fileManager
        let manifestPath = packagePath(folder: folder)
        guard let original = fm.contents(atPath: manifestPath),
              let object = try? JSONSerialization.jsonObject(with: original) as? [String: Any]
        else { return nil }

        let name = appName(for: folder)
        let needsName = !isValidAppName(object["name"])
        // 不严格（尾逗号之类）也要重写：nw.js 的 JSON.parse 不认这种写法
        let needsStrictRewrite = !StrictJSON.isValid(original)
        guard needsName || needsStrictRewrite else { return nil }

        var repaired = object
        if needsName { repaired["name"] = name }
        // sortedKeys：让同一份清单每次序列化结果一致，`ensure` 才能做「内容没变就不写」
        guard let payload = try? JSONSerialization.data(
            withJSONObject: repaired, options: [.prettyPrinted, .sortedKeys])
        else { return nil }

        let shim = appDir(dataDir: dataDir, folder: folder)
        let shimManifest = (shim as NSString).appendingPathComponent("package.json")

        do {
            var isDir: ObjCBool = false
            if !fm.fileExists(atPath: shim, isDirectory: &isDir) || !isDir.boolValue {
                try fm.createDirectory(atPath: shim, withIntermediateDirectories: true)
            }
            if fm.contents(atPath: shimManifest) != payload {
                try payload.write(to: URL(fileURLWithPath: shimManifest), options: .atomic)
            }

            // 顶层条目逐个链接（package.json 除外：用我们补好的那份）
            let entries = (try? fm.contentsOfDirectory(atPath: folder)) ?? []
            var wanted = Set<String>()
            for entry in entries where entry != "package.json" {
                wanted.insert(entry)
                let source = (folder as NSString).appendingPathComponent(entry)
                let link = (shim as NSString).appendingPathComponent(entry)
                if let destination = try? fm.destinationOfSymbolicLink(atPath: link) {
                    if destination == source { continue }
                    try? fm.removeItem(atPath: link)
                } else if fm.fileExists(atPath: link) {
                    // 不是链接的真实文件：不删（可能是用户自己放的），跳过
                    continue
                }
                try fm.createSymbolicLink(atPath: link, withDestinationPath: source)
            }

            // 游戏目录里已经没有的条目：只清理自己建的链接，真实文件不碰
            for stale in ((try? fm.contentsOfDirectory(atPath: shim)) ?? [])
            where stale != "package.json" && !wanted.contains(stale) {
                let path = (shim as NSString).appendingPathComponent(stale)
                if (try? fm.destinationOfSymbolicLink(atPath: path)) != nil {
                    try? fm.removeItem(atPath: path)
                }
            }
        } catch {
            return nil
        }
        return shim
    }

    /// 删除游戏时清掉它的兼容目录。
    ///
    /// 兼容目录是可再生的派生产物（只有补过 name 的清单和符号链接），不含用户数据；
    /// 留着会在 `nwjs-apps/` 里堆成垃圾，所以跟着游戏记录一起清。
    ///
    /// ⚠️ 只在「目录里全是链接 + package.json」时才删：万一用户在数据目录里
    /// 手放了真实文件，不动它（宁可留一个目录，也不误删用户的东西）。
    public static func removeCache(
        dataDir: String, folder: String, fileManager: FileManager = .default
    ) {
        let fm = fileManager
        let shim = appDir(dataDir: dataDir, folder: folder)
        guard shim.hasPrefix(root(dataDir: dataDir) + "/") else { return }
        guard let entries = try? fm.contentsOfDirectory(atPath: shim) else { return }
        for entry in entries {
            let path = (shim as NSString).appendingPathComponent(entry)
            guard entry == "package.json"
                || (try? fm.destinationOfSymbolicLink(atPath: path)) != nil
            else { return }
        }
        try? fm.removeItem(atPath: shim)
    }
}
