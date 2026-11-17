import Foundation

public struct EngineCapabilities: Sendable {
    public let launch: String
    public let translation: String
    public let cheats: String
    public static func forEngine(_ folder: String) -> Self {
        let launch = WineRuntime.canonicalEngine(folder) == "wine" ? "通过 Wine 运行 Windows 程序，兼容性取决于作品及其依赖" : EngineRegistry.find(folder: folder)?.launchable == true ? "已接入启动路径，兼容性以作品实测为准" : "仅识别，未接入启动"
        let module = AssistanceModules.forRuntime(folder)
        return .init(launch: launch, translation: module?.translation ?? "未接入", cheats: module?.cheats ?? "未接入")
    }
}
