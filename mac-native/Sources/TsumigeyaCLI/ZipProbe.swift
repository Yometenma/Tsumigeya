// CLI：生成一个测试 zip，用于**外部工具验证**。
//
// ===== 为什么需要这个命令 =====
//
// 「我写的 zip 能不能被标准工具打开」这件事，**单测证明不了** ——
// 单测只能证明「我读自己写的东西读得出来」（那可能是错的但自洽）。
//
// 必须用**独立的第三方实现**验：`unzip`（Info-ZIP）与 Python 的 `zipfile`
// （CPython 标准库）。它们如果都能正确读出**中文文件名**，
// 才证明我的 UTF-8 标志位与中央目录结构是对的。
import Foundation
import TsumigeyaCore

func runZipProbe(to directory: String) -> Int {
    let fm = FileManager.default
    let root = (directory as NSString).appendingPathComponent("zip-probe-\(UUID().uuidString)")
    let savesDir = (root as NSString).appendingPathComponent("saves")
    do {
        try fm.createDirectory(atPath: savesDir, withIntermediateDirectories: true)
    } catch {
        print("❌ 建目录失败：\(error.localizedDescription)")
        return 1
    }

    // 造几个**含中日文与空格**的文件名（这是最容易暴露编码问题的形态）
    let contents: [(String, String)] = [
        ("file1.rpgsave", "这是第一个存档的内容"),
        ("中文存档.rpgsave", "中文文件名的内容"),
        ("日本語セーブ.rvdata2", "日文文件名的内容"),
        ("config.rpgsave", "配置"),
        ("lastsave.autobak", "插件写的文件"),   // D81：这类文件也要带上
    ]

    var entries: [ZipWriter.Entry] = []
    for (name, text) in contents {
        let path = (savesDir as NSString).appendingPathComponent(name)
        let data = Array(text.utf8)
        do {
            try Data(data).write(to: URL(fileURLWithPath: path))
        } catch {
            print("❌ 写测试文件失败：\(error.localizedDescription)")
            return 1
        }
        entries.append(ZipWriter.Entry(path: "saves/\(name)", data: data))
    }

    let zipPath = (root as NSString).appendingPathComponent("probe.zip")
    if let error = ZipWriter.write(entries: entries, to: zipPath) {
        print("❌ 写 zip 失败：\(error)")
        return 1
    }

    print(zipPath)
    return 0
}
