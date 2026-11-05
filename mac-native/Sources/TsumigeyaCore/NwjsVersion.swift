// NW.js 的版本目录解析。
//
// 对应 Electron 版：`core-host.reconcileVersionArgs`（+ `engines/semver.ts`）
// 契约：D66（多版本保留）
//
// ===== 这个函数为什么必须存在（非常关键）=====
//
// `gameArgs.version` 与磁盘上的真实目录名**可能不一致**：
//
//   · 用户没选版本时，manifest 的默认值是**空串**
//   · 上游的兜底值是 `0.106.1`（**不带 v**）
//   · 而 deps 下的真实目录名是 `v0.106.1`（**带 v**）
//
// 直接拼路径 → `deps/version/0.106.1/nwjs-sdk-0.106.1-...` → **路径不存在**
// → 用户点启动**没反应**（不报错、不提示，因为路径拼出来了但文件不在）。
//
// 这是 Electron 版专门写了一个 `reconcileVersionArgs` 的原因。
// 本鱼把它搬过来 —— **不搬的理由一个都没有**（它是纯逻辑，与语言无关）。
import Foundation

public enum NwjsVersion {

    /// 解析出该用的版本目录名（**带 v** 的真实目录名）。
    ///
    /// 判据（按优先级）：
    ///   ① 用户选的那个（若**真实存在**于磁盘）
    ///   ② 用户选的是「不带 v」的形式 → 补个 v 再试
    ///   ③ 都没命中 → 取**版本号最大**的那个（用 `Semver.compareVersions`，不是字符串排序）
    ///
    /// - Parameter current: 用户当前选的值（可能为空、可能不带 v）
    /// - Returns: 真实目录名；`deps/version` 下没有任何版本时返回 nil
    public static func resolve(
        dataDir: String,
        current: String?,
        fileManager: FileManager = .default
    ) -> String? {
        let versionsDir = BinaryPaths.nwjsVersionsDir(dataDir)
        guard let entries = try? fileManager.contentsOfDirectory(atPath: versionsDir) else {
            return nil
        }

        // 只保留**目录**（`deps/version` 下可能有残留文件）
        let dirs = entries.filter { name in
            var isDir: ObjCBool = false
            let full = (versionsDir as NSString).appendingPathComponent(name)
            return fileManager.fileExists(atPath: full, isDirectory: &isDir) && isDir.boolValue
        }

        // ① 用户选的（若真实存在）
        if let current, !current.isEmpty, dirs.contains(current) {
            return current
        }

        // ② 「不带 v」→ 补 v
        if let current, !current.isEmpty, !current.hasPrefix("v") {
            let withV = "v" + current
            if dirs.contains(withV) { return withV }
        }

        // ③ 都没命中 → 版本号最大的
        //
        // ⚠️ **用 semver 比较，不是字符串排序**：
        //    字符串排序会把 `v0.90.0` 排在 `v0.106.1` **后面**（"9" > "1"），
        //    于是「最新版本」判错 → 启动用的是旧运行时。
        //    （Electron 版的占位实现也有这个毛病，P3 换成正式 Semver 才修好。）
        guard !dirs.isEmpty else { return nil }
        return dirs.max { compareVersions($0, $1) < 0 }
    }

    /// 列出所有可用版本（**按版本号升序**）。
    ///
    /// 给 UI 的版本选择器用（P5 的引擎页）：用户能看到装了哪些版本、选哪个。
    public static func availableVersions(
        dataDir: String, fileManager: FileManager = .default
    ) -> [String] {
        let versionsDir = BinaryPaths.nwjsVersionsDir(dataDir)
        guard let entries = try? fileManager.contentsOfDirectory(atPath: versionsDir) else {
            return []
        }
        return entries
            .filter { name in
                var isDir: ObjCBool = false
                let full = (versionsDir as NSString).appendingPathComponent(name)
                return fileManager.fileExists(atPath: full, isDirectory: &isDir) && isDir.boolValue
            }
            .sorted { compareVersions($0, $1) < 0 }
    }
}
