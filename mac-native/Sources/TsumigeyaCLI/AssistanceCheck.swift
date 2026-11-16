import Foundation
import TsumigeyaCore

func runAssistCommand(_ args: [String]) -> Int32 {
    do {
        guard args.count >= 2 else { print("用法：assist <inspect|extract|install|restore> <游戏目录> [--translation] [--cheats] [--running]"); return 2 }
        let action = args[0], project = try RPGMakerProject.detect(folder: args[1])
        switch action {
        case "inspect":
            let options = try AssistanceInstaller.options(project)
            print("RPG Maker \(project.edition)；入口：\(project.page.path)；辅助：\(options == nil ? "未安装" : "已安装")")
        case "extract":
            let entries = try RPGTextExtractor.extract(project)
            let data = try JSONStore.defaultEncoder.encode(entries)
            print(String(decoding: data, as: UTF8.self))
        case "install":
            try AssistanceInstaller.configure(project, options: .init(translation: args.contains("--translation"), cheats: args.contains("--cheats")), running: args.contains("--running"))
            print("辅助功能已安装。")
        case "restore":
            try AssistanceInstaller.restore(project, running: args.contains("--running")); print("原始入口已恢复。")
        default: print("未知辅助命令。 "); return 2
        }
        return 0
    } catch { print("失败：\(error.localizedDescription)"); return 1 }
}
