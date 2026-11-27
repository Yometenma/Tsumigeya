// swift-tools-version: 6.2
// Core 共享逻辑；CLI 与 SwiftUI 的入口必须分属不同模块。
import PackageDescription

let package = Package(
    name: "Tsumigeya",
    // 简体中文是源语言：没写进 en/ja 表的文案原样显示中文，不会变成空串。
    defaultLocalization: "zh-Hans",
    platforms: [
        .macOS(.v26)
    ],
    products: [
        .executable(name: "tsumigeya-cli", targets: ["TsumigeyaCLI"]),
        .executable(name: "Tsumigeya", targets: ["TsumigeyaApp"]),
    ],
    targets: [
        .target(
            name: "TsumigeyaCore",
            path: "Sources/TsumigeyaCore",
            resources: [
                .copy("Resources/Assist"),
                .copy("Resources/Wine"),
                // 界面文案（Core 生成的诊断、错误、引擎说明）的英文与日文表。
                .process("Resources/Localization"),
            ]
        ),
        .executableTarget(
            name: "TsumigeyaCLI",
            dependencies: ["TsumigeyaCore"],
            path: "Sources/TsumigeyaCLI"
        ),
        .executableTarget(
            name: "TsumigeyaApp",
            dependencies: ["TsumigeyaCore"],
            path: "Sources/TsumigeyaApp",
            // 界面文案的英文与日文表。放在 executable target 里，SwiftUI 的 Text
            // 才能通过 Bundle.main 找到（打包脚本会把 .lproj 平铺到 Contents/Resources）。
            resources: [.process("Resources")]
        ),
        .testTarget(
            name: "TsumigeyaTests",
            dependencies: ["TsumigeyaCore", "TsumigeyaApp"],
            path: "Tests/TsumigeyaTests",
            exclude: ["Assist/runtime.test.cjs", "Assist/panel.test.cjs", "Assist/renpy_runtime_test.py", "Assist/rgss_runtime_test.rb"],
            // 真实页面样本必须打包，测试通过 Bundle.module 读取。
            resources: [.process("Fixtures")]
        ),
    ]
)
