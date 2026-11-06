// zip 的读写（存档包的载体）。
//
// ===== ⚠️ 技术选择：为什么用系统 `ditto` 而不是自己实现 zip =====
//
// Electron 版用 `fflate`（纯 JS，零原生依赖）。Swift 这边有三个选项：
//
// ① **自己实现 zip 读写**
//   要处理中央目录、本地文件头、deflate 压缩、CRC32、UTF-8 文件名标志位……
//   约 800~1000 行。**风险最高**：写错了表现是「包打不开」，
//   而用户会以为是存档坏了。
//
// ② **用第三方包**（ZIPFoundation 等）
//   要加一个依赖。而本项目的重型依赖已经出过问题（D95 的两套实现的代价）。
//
// ③ **用系统 `ditto`**（本文件的选择）
//   macOS **自带**，`ditto -c -k --sequesterRsrc --keepParent` 就是"打 zip"，
//   `ditto -x -k` 就是"解 zip"。**零依赖、零自己实现的代码**。
//
// ⚠️ 但选 ③ 有个**硬约束**：`ditto` 是 macOS 专有 ——
//    Swift 版本来就只跑 macOS（P8 打包是 dmg），所以这不是问题。
//    **但单测在 Windows 上跑不了**（我们的测试都在 Mac 上跑，没问题）。
//
// ⚠️ 还有一个坑：`ditto` 默认会把扩展属性（xattr）也打进去，
//    用 `--norsrc --noextattr` 关掉 —— 存档是游戏数据，不需要 mac 的元数据
//    （那正是 D86 要防的 `._*` 文件）。
//
// ===== 为什么不直接调 `/usr/bin/zip` =====
//
// `zip` 也能用，但它在处理**中文文件名**时依赖 locale（与 tarEnv 那个坑同源）：
// `LANG=C` 时会写成 CP437 而不是 UTF-8 → 解出来是乱码。
// 而 `ditto` 不做编码转换，直接原样存 UTF-8。
import Foundation

public enum SaveZip {

    /// 打一个 zip。
    ///
    /// - Parameters:
    ///   - sourceDir: 要打包的目录
    ///   - destination: 输出的 .zip 路径
    ///
    /// - Returns: 成功返回 nil；失败返回错误说明
    ///
    /// ⚠️ 用 `ditto` 而不是 `zip`（理由见文件头：`zip` 的中文文件名依赖 locale）。
    public static func create(
        sourceDir: String, destination: String,
        fileManager: FileManager = .default
    ) -> String? {
        guard fileManager.fileExists(atPath: sourceDir) else {
            return "源目录不存在：\(sourceDir)"
        }
        // 目标目录必须存在（ditto 不会帮我们建）
        let destDir = (destination as NSString).deletingLastPathComponent
        if !fileManager.fileExists(atPath: destDir) {
            do {
                try fileManager.createDirectory(
                    atPath: destDir, withIntermediateDirectories: true)
            } catch {
                return "建目标目录失败：\(error.localizedDescription)"
            }
        }
        // 已存在就删掉（否则 ditto 会追加/报错）
        if fileManager.fileExists(atPath: destination) {
            try? fileManager.removeItem(atPath: destination)
        }

        let result = run("/usr/bin/ditto", [
            "-c",              // create archive
            "-k",              // 用 zip 格式
            "--sequesterRsrc", // 把资源分叉放到 __MACOSX/ 而不是弄坏文件
            "--norsrc",        // ⚠️ **不打扩展属性**（D86 的精神：不要 mac 元数据垃圾）
            "--noextattr",     // ⚠️ 同上
            sourceDir, destination,
        ])
        if let error = result.stderr, !error.isEmpty {
            return "ditto 打包失败：\(error.trimmingCharacters(in: .whitespacesAndNewlines))"
        }
        return result.exitCode == 0 ? nil : "ditto 返回 \(result.exitCode)"
    }

    /// 解一个 zip 到目标目录。
    ///
    /// - Returns: 成功返回 nil；失败返回错误说明
    ///
    /// ⚠️ 目标目录会被**创建**（不存在时）。已存在的内容**不删** ——
    ///    调用方（`SaveArchiveIO.import`）负责先把旧文件备份。
    public static func extract(
        archive: String, to destination: String,
        fileManager: FileManager = .default
    ) -> String? {
        guard fileManager.fileExists(atPath: archive) else {
            return "存档包不存在：\(archive)"
        }
        if !fileManager.fileExists(atPath: destination) {
            do {
                try fileManager.createDirectory(
                    atPath: destination, withIntermediateDirectories: true)
            } catch {
                return "建目标目录失败：\(error.localizedDescription)"
            }
        }

        let result = run("/usr/bin/ditto", [
            "-x", "-k",
            "--noextattr",   // 不解出扩展属性
            "--noqtn",       // 不解出 quarantine（存档不是下载的软件）
            archive, destination,
        ])
        if let error = result.stderr, !error.isEmpty {
            return "ditto 解包失败：\(error.trimmingCharacters(in: .whitespacesAndNewlines))"
        }
        return result.exitCode == 0 ? nil : "ditto 返回 \(result.exitCode)"
    }

    // MARK: - 执行

    /// 跑一个子进程并收集 stdout/stderr。
    struct RunResult {
        let exitCode: Int32
        let stdout: String?
        let stderr: String?
    }

    static func run(_ executable: String, _ arguments: [String]) -> RunResult {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments

        let outPipe = Pipe()
        let errPipe = Pipe()
        // ⚠️ **必须读 pipe，否则子进程写满缓冲区后会阻塞**（经典死锁）
        process.standardOutput = outPipe
        process.standardError = errPipe
        // ⚠️ 显式设置 locale：与 tarEnv 同一个理由 —— SSH/launchctl 起的进程
        //    LANG 常为空，那样 ditto/底层工具可能按 C locale 处理文件名。
        var env = ProcessInfo.processInfo.environment
        env["LANG"] = "en_US.UTF-8"
        env["LC_ALL"] = "en_US.UTF-8"
        env["LC_CTYPE"] = "en_US.UTF-8"
        process.environment = env

        do {
            try process.run()
        } catch {
            return RunResult(
                exitCode: -1, stdout: nil,
                stderr: "启动 \(executable) 失败：\(error.localizedDescription)")
        }
        process.waitUntilExit()

        let outData = outPipe.fileHandleForReading.readDataToEndOfFile()
        let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
        return RunResult(
            exitCode: process.terminationStatus,
            stdout: String(data: outData, encoding: .utf8),
            stderr: String(data: errData, encoding: .utf8))
    }
}
