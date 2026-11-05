// 主界面。
//
// ===== 布局演进（两版，第一版是错的）=====
//
// **v1（错）：外层 NavigationSplitView 放「页面导航」，库页内部再 HSplitView 放「列表+详情」**
//
// 用户 2026-11-06 截图报「引擎页有问题」：**外层侧边栏是个空白浅蓝色条**。
// 根因有两条，而且两条都是本鱼的设计错误：
//
//   ① `List(selection: $page)` 里 `page` 是**非 Optional** 的 `AppPage`，
//      mac 的侧边栏选择语义要求 `Optional` → 整行渲染成空白
//   ② 更根本的是：**两层侧边栏在 mac 上就是挤的**。
//      外层「游戏库/引擎」+ 内层「游戏列表」，实际可用宽度被吃掉两块。
//
// ===== v2（当前）：顶部分段控件切页，只保留一层侧边栏 =====
//
// ```
// ┌─────────────────────────────────────────────┐
// │  [游戏库|引擎]        搜索…              [＋] │  ← 顶部工具条（分段控件）
// ├───────────┬─────────────────────────────────┤
// │ 游戏列表   │  详情（大图 + 信息 + 启动）      │  ← 一层 HSplitView
// └───────────┴─────────────────────────────────┘
// ```
//
// 为什么这样更好：
//   · **少一层侧边栏** → 内容区宽了 180px
//   · 分段控件是 mac 的标准做法（Xcode / Finder 都用顶部切视图）
//   · 引擎页没有「列表」这一层，直接铺满 —— 与库页共用同一个容器不会别扭
//
// ⚠️ 分类**不在侧边栏**（D84：分类是库页的筛选器，不是导航）。
import SwiftUI
import TsumigeyaCore

struct RootView: View {
    @EnvironmentObject private var store: AppStore
    @State private var selection: String?
    @State private var page: AppPage = .library

    enum AppPage: String, CaseIterable, Identifiable {
        case library, engines, settings
        var id: String { rawValue }
        var title: String {
            switch self {
            case .library: return "游戏库"
            case .engines: return "引擎"
            case .settings: return "设置"
            }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            Divider()
            content
        }
        .task {
            await store.load()
            store.refreshInstalledEngines()
            store.refreshEngineEntries()
        }
        .sheet(isPresented: $store.isAddingGame) {
            AddGameWizard()
                .environmentObject(store)
        }
    }

    // MARK: - 顶部工具条

    private var topBar: some View {
        HStack(spacing: 12) {
            // ⚠️ **分段控件切页**（不是侧边栏）。
            //    这样只有一层列表，内容区不会被两块东西吃掉宽度。
            Picker("", selection: $page) {
                ForEach(AppPage.allCases) { p in
                    Text(p.title).tag(p)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 180)

            Spacer()

            // 搜索只在库页出现
            if page == .library {
                SearchField(text: $store.searchText)
                    .frame(maxWidth: 280)
            }

            if page == .library {
                Button {
                    store.openAddGame()
                } label: {
                    Label("添加游戏", systemImage: "plus")
                }
                .help("添加游戏")
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    // MARK: - 内容

    @ViewBuilder
    private var content: some View {
        switch page {
        case .library:
            // ⚠️ **一层 HSplitView**：左边游戏列表、右边详情。
            //    这是 mac 的「侧边栏 + 内容」惯例（Finder / Mail 都是这样）。
            HSplitView {
                GameListView(selection: $selection)
                    .frame(minWidth: 190, idealWidth: 230, maxWidth: 320)

                Group {
                    if let id = selection, let game = store.game(id: id) {
                        GameDetailView(game: game)
                    } else {
                        WelcomeView()
                    }
                }
                .frame(minWidth: 400, maxWidth: .infinity, maxHeight: .infinity)
            }
        case .engines:
            EnginesPage()
        case .settings:
            SettingsPage()
        }
    }
}

// MARK: - 搜索框

/// 自绘搜索框。
///
/// ⚠️ 不用 `.searchable(placement:)`：那是**给工具栏/侧边栏**挂搜索的标准 API，
///    在自定义顶栏里用会因为「没有原生容器」而位置错乱（本鱼实测过）。
///    自绘一个小的更好控制，而且样式与 mac 一致（圆角 + 放大镜 + 清除按钮）。
struct SearchField: View {
    @Binding var text: String

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
            TextField("搜索游戏名、路径或引擎", text: $text)
                .textFieldStyle(.plain)
                .font(.system(size: 12))
            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 7))
    }
}

// MARK: - 库页列表

struct GameListView: View {
    @EnvironmentObject private var store: AppStore
    @Binding var selection: String?

    var body: some View {
        List(selection: $selection) {
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
    }
}

// MARK: - 列表行

struct GameListRow: View {
    let game: GameRecord
    let isRunning: Bool

    var body: some View {
        HStack(spacing: 7) {
            Circle()
                .fill(engineTint)
                .frame(width: 7, height: 7)

            Text(game.gameTitle)
                .lineLimit(1)
                .truncationMode(.tail)

            Spacer(minLength: 4)

            if isRunning {
                HStack(spacing: 3) {
                    Circle().fill(.green).frame(width: 5, height: 5)
                    Text("运行中")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, -2)
        .help(game.gamePath)
    }

    /// 引擎配色（**同一个引擎永远同一个色**）。
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
                Text("点右上角的「＋」添加游戏。")
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
    }
}
