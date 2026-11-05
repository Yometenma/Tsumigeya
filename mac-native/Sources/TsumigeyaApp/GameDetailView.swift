// 详情页。
//
// 布局参考 phoenix（MIT）的 `GameDetailView`：
//   · 顶部**大图**（400px 高）+ 渐变遮罩把下边缘融进背景
//   · 图下方是信息区：标题 / 引擎 / 路径 / 操作按钮
//
// ⚠️ **只参考结构，不抄代码**（见 RootView 文件头）。
//
// ===== 封面图的现实 =====
//
// P4 还没有 DLsite 集成（P7）。所以顶部大图位置显示**占位**：
// 引擎配色渐变 + 大图标 + 游戏名。
//
// ⚠️ **绝不伪造封面**：不从游戏目录里随便挖图 —— 那会挖到素材（可能是 R18 或无关图），
//    用户会以为那是封面。宁可显示占位，也不要骗人。
import SwiftUI
import TsumigeyaCore

struct GameDetailView: View {
    let game: GameRecord
    @EnvironmentObject private var store: AppStore

    /// 顶图高度。
    ///
    /// ⚠️ 从 320 降到 **240**（用户截图反馈：占的纵向空间太多，
    ///    窗口不高的时候下面信息区被挤）。
    ///    240 在常见窗口高度下能留出足够的信息区，同时大图仍有「海报感」。
    private let headerHeight: CGFloat = 240

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                bodyContent
            }
        }
        .background(Color(nsColor: .textBackgroundColor))
        // ⚠️ **标题交给 RootView 统一管**（用户截图反馈：原来标题重复了 ——
        //    窗口标题栏显示游戏名，大图里又有一遍）。
        //
        //    这里不再设 navigationTitle（否则会和 RootView 的冲突，
        //    SwiftUI 的 NavigationSplitView 只有 detail 侧那个生效，
        //    而侧边栏折叠后就会看到两个不同的标题）。
        //
        //    现在：窗口标题 = 「游戏库」（侧边栏视角），
        //          游戏名只在大图上（内容区的身份）。
    }

    // MARK: - 顶部大图

    private var header: some View {
        ZStack(alignment: .bottomLeading) {
            // 占位背景：引擎配色渐变
            //
            // ⚠️ **必须够深**（用户截图反馈的第一个隐患）：
            //    大图上的标题是**白字**，底色太浅就看不清。
            //    原来用 `tint.opacity(0.55)`，浅色引擎（teal / cyan / mint）配白字会发灰。
            //
            //    现在：底色用 tint 的**混合暗色**（与 .black 混），保证足够暗；
            //    并且底部再压一层渐变，标题区的对比度恒定。
            LinearGradient(
                colors: [
                    engineTint.mix(with: .black, by: 0.35),
                    engineTint.mix(with: .black, by: 0.05),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )

            // 大图标（等 P7 有封面后换成 AsyncImage）
            Image(systemName: "gamecontroller.fill")
                .font(.system(size: 76))
                .foregroundStyle(.white.opacity(0.22))
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            // ⚠️ **只用一层渐变遮罩**（用户截图反馈：原来叠了两层，
            //    在 55% 处形成一条**可见的横向分界线**）。
            //
            //    叠加两层渐变的错误在于：每层的 stops 位置不同，
            //    交叠处（第二层从 clear 开始的点）会出现一个**斜率突变**，
            //    人眼就会看到一条线。正确做法是**一个** `LinearGradient`，
            //    用多个 stop 一次插值完。
            //
            //    stops 设计（自上而下）：
            //      0.00 透明        ← 顶部保留原色
            //      0.55 轻微压暗     ← 过渡开始（缓，不要陡）
            //      1.00 完全背景色   ← 底部融进背景
            LinearGradient(
                stops: [
                    .init(color: .clear, location: 0.0),
                    .init(color: Color(nsColor: .textBackgroundColor).opacity(0.22), location: 0.52),
                    .init(color: Color(nsColor: .textBackgroundColor).opacity(0.72), location: 0.82),
                    .init(color: Color(nsColor: .textBackgroundColor), location: 1.0),
                ],
                startPoint: .top,
                endPoint: .bottom
            )

            // 标题叠在图上（左下角）
            VStack(alignment: .leading, spacing: 7) {
                Text(game.gameTitle)
                    .font(.system(size: 26, weight: .bold))
                    .foregroundStyle(.white)
                    // ⚠️ 阴影用黑色半透明 + 小半径：让白字在任何底色上都立得住
                    .shadow(color: .black.opacity(0.45), radius: 8, y: 1)
                    .lineLimit(3)
                    .fixedSize(horizontal: false, vertical: true)

                HStack(spacing: 8) {
                    engineBadge
                    if store.runningGames[game.id] != nil {
                        runningBadge
                    }
                }

                // ⚠️ **大图空白处补一句路径摘要**（用户截图反馈：240px 全蓝很空）。
                //    放大图右下角而不是底部：底部已经在渐隐，
                //    右下角是「视觉上仍然清晰」的区域。
                //
                //    信息选择：只显示**路径末尾**（父目录名），
                //    因为完整路径太长会挤标题，而父目录名正好能告诉用户「这是哪个文件夹」。
                Text(folderHint)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.62))
                    .lineLimit(1)
                    .truncationMode(.head)
                    .padding(.top, 2)
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 18)
        }
        .frame(height: headerHeight)
        .clipped()
    }

    /// 游戏目录名（父目录的最后一段）。
    private var folderHint: String {
        let dir = DetectPath.gameDirForFiles(game.gamePath)
        return (dir as NSString).lastPathComponent
    }

    // MARK: - 信息区

    private var bodyContent: some View {
        VStack(alignment: .leading, spacing: 18) {
            // 启动按钮（D41 的精神：**操作在详情页**，卡片/列表只是浏览入口）
            launchSection

            Divider()

            infoRows

            Divider()

            engineArgsSection
        }
        .padding(.horizontal, 28)
        .padding(.top, 18)
        .padding(.bottom, 40)
    }

    // MARK: 启动

    private var launchSection: some View {
        HStack(spacing: 12) {
            let isRunning = store.runningGames[game.id] != nil

            // ⚠️ **主按钮必须「实心、醒目」**（用户截图反馈：原来那个浅紫描边
            //    看起来像**禁用状态**，完全看不出是主操作）。
            //
            //    SwiftUI 的 `.borderedProminent` + `.tint` 是实心填充的正确做法。
            //    但**不能用 label 里的 Label 图标把它压暗** —— 图标与文字都该是白的。
            //
            //    尺寸：`.controlSize(.large)` + 自定义 padding，让按钮有分量感
            //    （mac 的主操作用户期待它大一点）。
            Button {
                if isRunning {
                    store.stop(game: game)
                } else {
                    store.launch(game: game)
                }
            } label: {
                HStack(spacing: 7) {
                    Image(systemName: isRunning ? "stop.fill" : "play.fill")
                        .font(.system(size: 13, weight: .semibold))
                    Text(isRunning ? "停止" : "启动")
                        .font(.system(size: 14, weight: .semibold))
                }
                .frame(minWidth: 96)
                .padding(.vertical, 4)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            // 运行中 → 红色（停止是「危险/打断」动作）；否则 → 引擎主色
            .tint(isRunning ? .red : .accentColor)
            .keyboardShortcut(.defaultAction)

            if let failure = store.lastLaunchFailure[game.id] {
                // ⚠️ 启动失败要**明确显示原因**，不能静默。
                //    Electron 版的教训（D36）：失败必须返回结构化结果，不抛错。
                Label(failure, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout)
                    .foregroundStyle(.orange)
                    .lineLimit(2)
                    .textSelection(.enabled)
            }

            Spacer()
        }
    }

    // MARK: 信息行

    private var infoRows: some View {
        VStack(alignment: .leading, spacing: 10) {
            infoRow("引擎", engineDisplayName)
            infoRow("路径", game.gamePath, mono: true)
            if let pid = store.runningGames[game.id] {
                infoRow("进程", "运行中（pid \(pid)）")
            }
        }
    }

    private func infoRow(_ label: String, _ value: String, mono: Bool = false) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(label)
                .font(.callout)
                .foregroundStyle(.secondary)
                .frame(width: 44, alignment: .leading)
            Text(value)
                .font(mono ? .system(size: 12, design: .monospaced) : .callout)
                .textSelection(.enabled)   // 路径能选中复制
                .lineLimit(2)
                .truncationMode(.middle)
        }
    }

    // MARK: 引擎参数

    @ViewBuilder
    private var engineArgsSection: some View {
        let args = game.gameArgs ?? [:]
        if !args.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                Text("引擎参数")
                    .font(.headline)

                // ⚠️ **参数名与值不能横跨整个窗口**（用户截图反馈：
                //    `fullscreen` 在左、值「关」在最右边，视线要横跨一整屏）。
                //
                //    改成**表格式两列**：名固定宽度、值紧跟其后左对齐。
                //    这与 mac 系统的「表单」惯例一致（设置面板都是左标签右值）。
                VStack(spacing: 0) {
                    ForEach(Array(args.keys.sorted().enumerated()), id: \.element) { idx, key in
                        if idx > 0 {
                            Divider().padding(.leading, 10)
                        }
                        HStack(alignment: .top, spacing: 10) {
                            Text(key)
                                .font(.system(size: 12, design: .monospaced))
                                .foregroundStyle(.secondary)
                                .frame(width: 132, alignment: .leading)
                            Text(describe(args[key]!))
                                .font(.system(size: 12))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 6)
                    }
                }
                .background(Color(nsColor: .controlBackgroundColor),
                            in: RoundedRectangle(cornerRadius: 8))
            }
        }
    }

    /// 把 JSONValue 描述成可读文本。
    private func describe(_ value: JSONValue) -> String {
        switch value {
        case .null: return "（空）"
        case .bool(let b): return b ? "开" : "关"
        case .int(let i): return "\(i)"
        case .double(let d): return "\(d)"
        case .string(let s): return s.isEmpty ? "（空）" : s
        case .array(let items):
            if items.isEmpty { return "（空）" }
            return items.compactMap { $0.stringValue }.joined(separator: ", ")
        case .object:
            return "（对象）"
        }
    }

    // MARK: 徽标

    private var engineBadge: some View {
        Text(engineDisplayName)
            .font(.caption.weight(.medium))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(.white.opacity(0.22), in: Capsule())
            .foregroundStyle(.white)
    }

    private var runningBadge: some View {
        HStack(spacing: 4) {
            Circle().fill(.green).frame(width: 6, height: 6)
            Text("运行中")
                .font(.caption.weight(.medium))
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(.black.opacity(0.35), in: Capsule())
        .foregroundStyle(.white)
    }

    private var engineDisplayName: String {
        EngineRegistry.find(folder: game.gameEngine)?.name ?? game.gameEngine
    }

    private var engineTint: Color {
        switch game.gameEngine {
        case "nwjs": return .blue
        case "mkxpz": return .orange
        case "easyrpg": return .green
        case "renpy": return .pink
        case "tyrano": return .purple
        case "kirikiri": return .teal
        case "nscripter": return .indigo
        case "siglus": return .brown
        case "godot": return .cyan
        default: return .gray
        }
    }
}
