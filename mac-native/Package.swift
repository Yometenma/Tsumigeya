// swift-tools-version: 6.2
// Tsumigeya 原生版
//
// ===== 为什么有两个 executable target =====
//
//   · `TsumigeyaNative`（库）：所有逻辑（识别 / 启动 / 安装 / 存档…），无 UI 依赖
//   · `tsumigeya-cli`  ：命令行验收工具。**必须保留** —— 没有它，
//     "真启动游戏" / "真装引擎" 这些只能在点 UI 时验，出问题难定位
//   · `Tsumigeya`      ：SwiftUI app（P4 起）
//
// ⚠️ **库与 CLI 必须分开**：SwiftUI 的 `@main` 与 `main.swift` 的顶层代码**互斥**
//    （同一个 module 里不能既有 `@main` 又有 `main.swift` 的顶层语句）。
//    所以逻辑全部下沉到库，两个 executable 各有一份入口。
import PackageDescription

let package = Package(
    name: "TsumigeyaNative",
    platforms: [
        // macOS 26 —— 与用户真机（macOS 26.6.2）和 Xcode 27.2 对齐。
        //
        // ⚠️ `.v26` 需要 `swift-tools-version: 6.2`（PackageDescription 6.2 才有）。
        //    写成 6.0 会报 `'v26' is unavailable` —— 实测踩到。
        .macOS(.v26)
    ],
    products: [
        .executable(name: "tsumigeya-cli", targets: ["TsumigeyaCLI"]),
        .executable(name: "Tsumigeya", targets: ["TsumigeyaApp"]),
    ],
    targets: [
        // 纯逻辑库（无 UI 依赖，可在测试里直接 import）
        .target(
            name: "TsumigeyaCore",
            path: "Sources/TsumigeyaCore"
        ),
        // 命令行验收工具
        .executableTarget(
            name: "TsumigeyaCLI",
            dependencies: ["TsumigeyaCore"],
            path: "Sources/TsumigeyaCLI"
        ),
        // SwiftUI app
        .executableTarget(
            name: "TsumigeyaApp",
            dependencies: ["TsumigeyaCore"],
            path: "Sources/TsumigeyaApp"
        ),
        .testTarget(
            name: "TsumigeyaNativeTests",
            dependencies: ["TsumigeyaCore"],
            path: "Tests/TsumigeyaNativeTests"
        ),
    ]
)
