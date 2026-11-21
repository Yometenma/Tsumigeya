import Foundation
import CryptoKit
import CoreText

/// Wine 是后备启动方式；只有没有匹配到专用运行时的 Windows 程序才使用它。
public enum WineRuntime {
    public static func canonicalEngine(_ engine: String) -> String {
        ["unity", "rpgbakin", "wolfrpg"].contains(engine) ? "wine" : engine
    }

    public static func binary(_ dataDir: String) -> String {
        BinaryPaths.depsDir(dataDir, "wine", "wine") + "/Wine Devel.app/Contents/Resources/wine/bin/wine"
    }

    public static func server(for binary: String) -> String {
        (binary as NSString).deletingLastPathComponent + "/wineserver"
    }

    public static func prefix(dataDir: String, folder: String, gameID: String = "") -> String {
        let identity = gameID.isEmpty ? URL(fileURLWithPath: folder).standardizedFileURL.resolvingSymlinksInPath().path : "game:" + gameID
        let digest = CryptoKit.SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined()
        // 环境和存档不能放在 modules 内，否则卸载运行时会删掉用户数据。
        return dataDir + "/wine-prefixes/" + digest
    }

    public static var supervisor: String {
        Bundle.module.url(forResource: "supervisor", withExtension: "sh", subdirectory: "Wine")!.path
    }

    /// 不把仅仅改了扩展名的文件当作 Windows 可执行程序。
    public static func isExecutable(_ path: String) -> Bool {
        guard DetectPath.pathExtLower(path) == "exe",
              let handle = FileHandle(forReadingAtPath: path) else { return false }
        defer { try? handle.close() }
        guard let header = try? handle.read(upToCount: 64), header.count == 64,
              header[0] == 0x4d, header[1] == 0x5a else { return false }
        let offset = header[60..<64].enumerated().reduce(UInt64(0)) { $0 | UInt64($1.element) << ($1.offset * 8) }
        guard offset >= 64, (try? handle.seek(toOffset: offset)) != nil,
              let signature = try? handle.read(upToCount: 4) else { return false }
        return signature == Data([0x50, 0x45, 0, 0])
    }

    public static func executables(in folder: String) -> [String] {
        let entries = (try? FileManager.default.contentsOfDirectory(atPath: folder)) ?? []
        return entries.sorted().map { (folder as NSString).appendingPathComponent($0) }.filter(isExecutable)
    }

    public static func resolveEntry(folder: String, selected: String?, override: String? = nil,
                                    fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
                                    listDir: (String) -> [String] = { (try? FileManager.default.contentsOfDirectory(atPath: $0)) ?? [] }) -> Result<String, LaunchFailure> {
        if let override, !override.isEmpty {
            let entry = (override as NSString).isAbsolutePath ? override : (folder as NSString).appendingPathComponent(override)
            guard fileExists(entry), isExecutable(entry) else {
                return .failure(.spawnFailed(message: L10n.string("指定的 Windows 启动文件不存在或不是有效的 EXE，请在游戏设置中重新选择。")))
            }
            return .success(entry)
        }
        if let selected, fileExists(selected), isExecutable(selected) { return .success(selected) }
        let candidates = listDir(folder).map { (folder as NSString).appendingPathComponent($0) }.filter(isExecutable)
        guard candidates.count == 1, let entry = candidates.first else {
            return .failure(.spawnFailed(message: candidates.isEmpty
                ? L10n.string("游戏目录中没有有效的 Windows EXE，请选择游戏的启动文件。")
                : L10n.string("游戏目录有多个 EXE，请在游戏设置的“Windows 启动文件”中选择正确入口，不会自动运行安装或卸载程序。")))
        }
        return .success(entry)
    }

    public static func plan(_ ctx: LaunchContext, fileExists: (String) -> Bool, listDir: (String) -> [String]) -> Result<LaunchPlan, LaunchFailure> {
        let binary = binary(ctx.dataDir)
        guard fileExists(binary), fileExists(server(for: binary)) else {
            return .failure(.engineBinaryMissing(binary: binary))
        }
        let entry: String
        switch resolveEntry(folder: ctx.folder, selected: ctx.gamePath,
                            override: ctx.gameArgs["executable"]?.stringValue,
                            fileExists: fileExists, listDir: listDir) {
        case .failure(let error): return .failure(error)
        case .success(let path): entry = path
        }
        let arguments: [String]
        if let value = ctx.gameArgs["arguments"] {
            guard let array = value.arrayValue, array.allSatisfy({ $0.stringValue != nil }) else {
                return .failure(.spawnFailed(message: L10n.string("Wine 启动参数必须是字符串列表，每一项单独填写。")))
            }
            arguments = array.compactMap(\.stringValue)
        } else { arguments = [] }
        let locale = ctx.gameArgs["locale"]?.stringValue ?? "zh_CN.UTF-8"
        guard ["zh_CN.UTF-8", "ja_JP.UTF-8", "en_US.UTF-8"].contains(locale) else {
            return .failure(.spawnFailed(message: L10n.string("请选择受支持的 Windows 语言环境。")))
        }
        let prefix = prefix(dataDir: ctx.dataDir, folder: ctx.folder, gameID: ctx.gameID)
        return .success(LaunchPlan(binary: binary, args: [entry] + arguments,
                                   cwd: (entry as NSString).deletingLastPathComponent, engine: "wine",
                                   environment: ["WINEPREFIX": prefix, "WINEDEBUG": "-all", "LANG": locale, "LC_ALL": locale,
                                                 "WINEDLLOVERRIDES": "winemenubuilder.exe=d"]))
    }

    /// 仅供新建环境使用；不覆盖用户后来安装的字体或 Windows 配置。
    public static func prepareFonts(prefix: String, fileManager: FileManager = .default) throws {
        let families = CTFontManagerCopyAvailableFontFamilyNames() as! [String]
        guard !fileManager.fileExists(atPath: prefix + "/system.reg"),
              let family = ["STHeiti", "Heiti SC", "Hiragino Sans GB"].first(where: families.contains) else { return }
        let values = ["SimSun", "NSimSun", "Tahoma", "MS Sans Serif", "System", "MS Shell Dlg", "MS Shell Dlg 2"]
            .map { "\"\($0)\"=\"\(family)\"" }.joined(separator: "\r\n")
        let registry = "Windows Registry Editor Version 5.00\r\n\r\n[HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows NT\\CurrentVersion\\FontSubstitutes]\r\n" + values + "\r\n"
        try registry.write(toFile: prefix + ".fonts.reg", atomically: true, encoding: .utf16)
    }

    public static func lastExit(dataDir: String, folder: String, gameID: String = "") -> Int? {
        let path = prefix(dataDir: dataDir, folder: folder, gameID: gameID) + ".exit"
        guard let value = try? String(contentsOfFile: path, encoding: .utf8) else { return nil }
        return Int(value.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    public static func rosettaAvailable() -> Bool {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/arch")
        process.arguments = ["-x86_64", "/usr/bin/true"]
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        do { try process.run(); process.waitUntilExit(); return process.terminationStatus == 0 }
        catch { return false }
    }

    public static func prepareHost(arch: String, acceptRosettaLicense: Bool) throws {
        guard arch == "arm64", !rosettaAvailable() else { return }
        guard acceptRosettaLicense else {
            throw InstallError.invalidManifest(module: "Wine", reason: L10n.string("需要 Rosetta 2。请在应用中确认 Apple 许可后安装，或为命令行安装添加 --accept-rosetta-license。"))
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/sbin/softwareupdate")
        process.arguments = ["--install-rosetta", "--agree-to-license"]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        try process.run()
        process.waitUntilExit()
        guard process.terminationStatus == 0, rosettaAvailable() else {
            throw InstallError.invalidManifest(module: "Wine", reason: L10n.string("Rosetta 2 安装未完成，请检查网络或系统权限后重试。"))
        }
    }

    public static let argumentSchema: [String: JSONValue] = [
        "executable": .object(["type": .string("text"), "label": .string(L10n.string("Windows 启动文件")), "default": .string("")]),
        "arguments": .object(["type": .string("array"), "label": .string(L10n.string("启动参数（每行一项）")), "default": .array([])]),
        "locale": .object(["type": .string("dropdown"), "label": .string(L10n.string("Windows 语言环境")), "default": .string("zh_CN.UTF-8"),
                           "options": .array(["zh_CN.UTF-8", "ja_JP.UTF-8", "en_US.UTF-8"].map(JSONValue.string))])
    ]
}
