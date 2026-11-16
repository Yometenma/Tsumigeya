// swift-tools-version: 6.2
// Core 共享逻辑；CLI 与 SwiftUI 的入口必须分属不同模块。
import PackageDescription

let package = Package(
    name: "Tsumigeya",
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
            path: "Sources/TsumigeyaCore"
        ),
        .executableTarget(
            name: "TsumigeyaCLI",
            dependencies: ["TsumigeyaCore"],
            path: "Sources/TsumigeyaCLI"
        ),
        .executableTarget(
            name: "TsumigeyaApp",
            dependencies: ["TsumigeyaCore"],
            path: "Sources/TsumigeyaApp"
        ),
        .testTarget(
            name: "TsumigeyaTests",
            dependencies: ["TsumigeyaCore", "TsumigeyaApp"],
            path: "Tests/TsumigeyaTests",
            // 真实页面样本必须打包，测试通过 Bundle.module 读取。
            resources: [.process("Fixtures")]
        ),
    ]
)
