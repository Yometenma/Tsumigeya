import Foundation
import TsumigeyaCore

func runAssistCommand(_ args: [String]) -> Int32 {
    do {
        guard args.count >= 2 else { print("用法：assist <inspect|extract|install|restore|state|command> <游戏目录> [--translation] [--cheats] [--running]"); return 2 }
        let action = args[0], project = try RPGMakerProject.detect(folder: args[1])
        switch action {
        case "inspect":
            let options = try AssistanceInstaller.options(project)
            print("\(project.displayName)；入口：\(project.page.path)；辅助：\(options == nil ? "未安装" : "已安装")")
        case "extract":
            let entries = try RPGTextExtractor.extract(project)
            let data = try JSONStore.defaultEncoder.encode(entries)
            print(String(decoding: data, as: UTF8.self))
        case "install":
            try AssistanceInstaller.configure(project, options: .init(translation: args.contains("--translation"), cheats: args.contains("--cheats")), running: args.contains("--running"))
            print("辅助功能已安装。")
        case "state":
            guard project.usesFileBridge else { throw AssistanceError.invalid("此引擎请使用游戏内辅助面板。") }
            let state = try AssistanceBridge.read(project)
            print(String(decoding: try JSONStore.defaultEncoder.encode(state), as: UTF8.self))
        case "command":
            guard project.usesFileBridge, args.count >= 3 else { throw AssistanceError.invalid("用法：assist command <目录> <set|lock|unlock|reset> [变量键] [JSON 值]") }
            let state = try AssistanceBridge.read(project)
            let value = args.count > 4 ? try JSONDecoder().decode(JSONValue.self, from: Data(args[4].utf8)) : .null
            let id = try AssistanceBridge.send(project, snapshot: state, action: args[2], key: args.count > 3 ? args[3] : "", value: value)
            print("命令已发送：\(id)；请读取 state 核对 ack 和 error。")
        case "restore":
            try AssistanceInstaller.restore(project, running: args.contains("--running")); print(project.usesFileBridge ? "辅助功能已移除。" : "原始入口已恢复。")
        default: print("未知辅助命令。 "); return 2
        }
        return 0
    } catch { print("失败：\(error.localizedDescription)"); return 1 }
}
