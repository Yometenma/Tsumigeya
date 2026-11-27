// 备份后缀：全仓只有这一个来源。
//
// 为什么单独一个文件：`Assistance` / `JSONStore` / `NativeAssistance` 曾经各自
// `appendingPathExtension("bak")`，而存档与离线脚本用 `.tsumigeya-bak`。同一个数据目录里
// 于是同时出现两种备份名，用户看不出哪份是启动器留的。统一在这里定义，
// 各处只引用 `Backup.suffix`。
import Foundation

public enum Backup {
    /// 备份文件名后缀（`games.json.tsumigeya-bak`）。
    public static let suffix = ".tsumigeya-bak"

    /// 旧后缀。v3.1.8 之前辅助文件用的是 `config.json.bak`，这些文件还在用户目录里，
    /// 清理/恢复清单必须继续认它，否则「目录含未识别文件」会把整个恢复挡掉。
    public static let legacySuffix = ".bak"

    /// 给某个路径加备份后缀。
    public static func path(for url: URL) -> URL {
        URL(fileURLWithPath: url.path + suffix)
    }

    /// 给某个路径字符串加备份后缀。
    public static func path(for path: String) -> String { path + suffix }

    /// 一个文件名可能对应的备份名（新后缀优先，旧后缀兜底）。不含原名。
    public static func backupNames(_ name: String) -> [String] {
        [name + suffix, name + legacySuffix]
    }

    /// 一个文件名的全部合法形态：原名 + 新后缀备份 + 旧后缀备份。
    ///
    /// 清理/恢复清单用它，而不是自己拼 `$0 + ".bak"` —— 旧版本留下的备份名
    /// 必须继续被认出来，否则「目录含未识别文件」会把整个恢复挡掉。
    public static func acceptedNames(_ name: String) -> [String] {
        [name] + backupNames(name)
    }
}
