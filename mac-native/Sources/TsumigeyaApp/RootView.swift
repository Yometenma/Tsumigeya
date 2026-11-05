// 主界面：左侧游戏列表（按分类分组）+ 右侧详情页。
//
// ===== 布局参考（用户 2026-11-06 拍板）=====
//
// 「左侧列表 + 右侧详情大图」这个形式参考了两个成熟项目：
//   · phoenix（MIT）—— SwiftUI 写的 mac 游戏启动器
//     它的结构是 `NavigationSplitView { List(selection:) } detail: { 详情页 }`，
//     详情页顶部是 **400px 大图 + 渐变遮罩**，下方是信息区。
//   · 用户的原话：「你参考的和可以抄的都是这样的形式，感觉这样更省事」
//
// ⚠️ **只参考结构，不抄代码**（phoenix 是 MIT，抄了要带版权声明；
//    而且它的生命周期、依赖（AlertToast/Defaults/WhatsNewKit）与本项目完全不同）。
//
// ===== 为什么这个布局比卡片网格好（本鱼的实际判断）=====
//
// ① 用户的游戏是**逐个添加的**（不是浏览商店），几十个就要滚动
// ② 游戏名是**日文**，长短差很大（「～馬蹄通りの小聖女～」那种），
//    卡片里两行截断很难看；列表里一行省略号反而干净
// ③ 详情页能放**顶部大封面**——等 P7 接上 DLsite 后会很好看
//
// ===== 分组 =====
//
// **按自定义分类分组**（用户拍板）。分类是「多归属」的，所以一个游戏可能
// 出现在多个分组里 —— 这是**有意的**（与标签语义一致，D31 的精神）。
//
// ⚠️ 未归类的游戏放在最后的「未分类」组（**不能藏起来** —— 藏起来用户会以为游戏丢了）。
import SwiftUI
import TsumigeyaCore

struct RootView: View {
    @EnvironmentObject private var store: AppStore
    @State private var selection: String?

    var body: some View {
        NavigationSplitView {
            GameListView(selection: $selection)
                // 侧边栏宽度：mac 惯例 200~260，拖动范围限制住
                .navigationSplitViewColumnWidth(min: 200, ideal: 240, max: 320)
        } detail: {
            if let id = selection, let game = store.game(id: id) {
                GameDetailView(game: game)
            } else {
                WelcomeView()
            }
        }
        .task {
            await store.load()
        }
    }
}

// MARK: - 侧边栏列表

struct GameListView: View {
    @EnvironmentObject private var store: AppStore
    @Binding var selection: String?

    var body: some View {
        List(selection: $selection) {
            // ⚠️ `List(selection:)` 是 mac 原生多选：⌘ 点选、⇧ 范围选都是系统白送的
            //    （Electron 版是自己实现了一套批量模式）。
            ForEach(store.groups, id: \.id) { group in
                Section {
                    ForEach(group.games, id: \.id) { game in
                        GameListRow(
                            game: game,
                            isRunning: store.runningGames[game.id] != nil
                        )
                        .tag(game.id)
                    }
                } header: {
                    // 组标题带计数（用户一眼知道这组有几个）
                    HStack(spacing: 6) {
                        Text(group.title)
                        Text("\(group.games.count)")
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
            }
        }
        .listStyle(.sidebar)
        .searchable(text: $store.searchText, placement: .sidebar,
                    prompt: "搜索游戏名、路径或引擎")
        // ⚠️ **窗口标题放这里（不是详情页）**，理由见 GameDetailView 的注释。
        //
        //    侧边栏的标题是「游戏库」—— 它表达的是「这个窗口在看什么分类的东西」，
        //    而具体是哪个游戏由内容区（大图上的标题）表达。
        //    两处都写游戏名 = 重复（用户截图反馈的第一个问题）。
        .navigationTitle("游戏库")
        .navigationSubtitle(store.games.isEmpty ? "" : "共 \(store.games.count) 个游戏")
            .toolbar {
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        // TODO(P5)：添加游戏向导
                    } label: {
                        Label("添加游戏", systemImage: "plus")
                    }
                    .help("添加游戏（P5 实现）")
                }
            }
    }
}

// MARK: - 列表行

struct GameListRow: View {
    let game: GameRecord
    let isRunning: Bool

    var body: some View {
        HStack(spacing: 7) {
            // 引擎色点（代替图标 —— 等 P7 有封面后换成缩略图）
            Circle()
                .fill(engineTint)
                .frame(width: 7, height: 7)

            Text(game.gameTitle)
                .lineLimit(1)
                .truncationMode(.tail)

            Spacer(minLength: 4)

            if isRunning {
                // 「运行中」徽标：绿点 + 文字。
                // ⚠️ 与「已装引擎」是两件事 —— 这是**游戏进程在跑**（D50 的内存状态）
                HStack(spacing: 3) {
                    Circle().fill(.green).frame(width: 5, height: 5)
                    Text("运行中")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        // ⚠️ **行距要收紧**（用户截图反馈：5 个游戏占了大半屏高，游戏多了会很难受）。
        //    负垂直 padding 把 List 的默认行高压下来 ——
        //    mac 侧边栏的行高本来就比 iOS 紧，这是对齐系统观感。
        .padding(.vertical, -2)
        .help(game.gamePath)
    }

    /// 引擎配色（**同一个引擎永远同一个色**，否则每次刷新都变，用户以为游戏换了）。
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

// MARK: - 空选择时的欢迎页

struct WelcomeView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "gamecontroller")
                .font(.system(size: 54))
                .foregroundStyle(.tertiary)

            if store.games.isEmpty {
                Text("游戏库还是空的")
                    .font(.title2.weight(.medium))
                Text("把游戏文件夹拖进来，或者点左上角的「+」添加。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            } else {
                Text("从左侧选一个游戏")
                    .font(.title2.weight(.medium))
                Text("共 \(store.games.count) 个游戏")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .textBackgroundColor))
    }
}
