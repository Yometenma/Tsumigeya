// swift-tools-version: 6.2
// Tsumigeya 原生版（P0 骨架）
//
// 为什么先做「可执行命令行」而不是 SwiftUI app：
//   P0–P3 全是纯逻辑层（数据目录 / JSON 读写 / 引擎识别 / 启动）。
//   做成命令行工具就能在 Mac 上无 UI 编译并验证，不浪费一帧 SwiftUI 代码。
//   P4 才换成 .app 目标（那时逻辑层已经稳了，方案 §4）。
//
// 为什么只有一个 target：
//   现在还没到需要拆模块的阶段。等 P1 之后再按 Engine / Store / Launch 拆，
//   那时才有真实边界可依据；提前拆只会拆错。
import PackageDescription

let package = Package(
    name: "TsumigeyaNative",
    platforms: [
        // macOS 26 —— 与用户真机（macOS 26.6.2）和 Xcode 27.2 对齐。
        // 不设更低目标：原生版的目标平台就是这台机器。
        //
        // ⚠️ `.v26` 需要 `swift-tools-version: 6.2`（PackageDescription 6.2 才引入）。
        //    写成 6.0 会报 `'v26' is unavailable` —— 实测踩到。
        .macOS(.v26)
    ],
    products: [
        .executable(name: "tsumigeya-cli", targets: ["TsumigeyaNative"]),
    ],
    targets: [
        .executableTarget(
            name: "TsumigeyaNative",
            path: "Sources/TsumigeyaNative"
        ),
        .testTarget(
            name: "TsumigeyaNativeTests",
            dependencies: ["TsumigeyaNative"],
            path: "Tests/TsumigeyaNativeTests"
        ),
    ]
)
