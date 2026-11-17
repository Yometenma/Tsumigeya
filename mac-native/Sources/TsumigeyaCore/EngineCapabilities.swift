import Foundation

public struct EngineCapabilities: Sendable {
    public let launch: String
    public let translation: String
    public let cheats: String
    public static func forEngine(_ folder: String) -> Self {
        let launch = EngineRegistry.find(folder: folder)?.launchable == true ? "已接入启动路径，兼容性以作品实测为准" : "仅识别，未接入启动"
        switch folder {
        case "nwjs": return .init(launch: launch, translation: "仅已确认的 RPG Maker MV/MZ", cheats: "MV/MZ 引擎状态与游戏内面板")
        case "mkxpz": return .init(launch: launch, translation: "XP/VX/VX Ace；需通过启动器加载辅助", cheats: "金钱、物品、角色数值、变量／开关与锁定")
        case "renpy": return .init(launch: launch, translation: "剧本台词与显示文字；特殊语法由运行时捕获", cheats: "简单变量编辑、锁定与数值筛选")
        case "tyrano": return .init(launch: launch, translation: "文字与文字选项标签；不含图片文字", cheats: "游戏／系统变量、锁定与数值筛选")
        default: return .init(launch: launch, translation: "未接入", cheats: "未接入")
        }
    }
}
