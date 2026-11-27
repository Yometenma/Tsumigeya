// 界面里重复出现的纯格式化。
//
// 为什么单独一个文件：`formatBytes` 曾在 `EnginesPage` 与 `SaveSection` 各写一份，
// 两处都要显示「已下载 12.3 MB」「存档 45 MB」这类数字。同一份数字格式分叉了，
// 用户会在两个页面看到不同的小数位。
import Foundation

enum ByteFormat {
    /// 人类可读的文件大小（`1 B` / `512 KB` / `12.3 MB` / `1.05 GB`）。
    ///
    /// 不本地化：单位符号（B/KB/MB/GB）是通用写法，`String(format:)` 的数字也跟随 locale。
    static func human(_ bytes: Int64) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        let kb = Double(bytes) / 1024
        if kb < 1024 { return String(format: "%.0f KB", kb) }
        let mb = kb / 1024
        if mb < 1024 { return String(format: "%.1f MB", mb) }
        return String(format: "%.2f GB", mb / 1024)
    }
}
