// 库页（游戏列表）。
//
// 对应 Electron 版：`src/renderer/src/pages/LibraryPage.vue`（437 行）
// 布局与交互**照抄**，因为用户已经习惯了那些位置：
//   · 顶部标题 + 副标题（游戏数 / 筛选状态）
//   · 搜索框 + 视图切换（卡片 / 列表）
//   · 卡片网格（默认）或列表（compact）
//
// ===== SwiftUI 与 Vue 的差别（本鱼实际遇到的）=====
//
// ① **没有「自动响应式依赖追踪」**：Vue 里 `computed` 会自动知道依赖了哪个 ref；
//    SwiftUI 的 `@Published` + `@ObservedObject` 是显式声明。所以 `filteredGames`
//    放在 store 里（它自己在 store 里算，View 只读）。
//
// ② **List / ScrollView 的选择**：卡片网格用 `LazyVGrid`（不是 `List`）。
//    `List` 在 mac 上是**系统原生表格样式**（行、斑马纹、选中高亮），
//    那是「设置项列表」的感觉，不是「海报墙」。
import SwiftUI
import TsumigeyaCore

struct RootView: View {
    @EnvironmentObject private var store: AppStore
    @State private var selectedGameId: String?

    var body: some View {
        NavigationSplitView {
            // ===== 侧边栏（**只有导航**，分类栏在库页顶部 —— D84）=====
            Sidebar(selectedGameId: $selectedGameId)
                // 折叠态宽度 208 ↔ 56（与 Electron 版一致，D76）
                .navigationSplitViewColumnWidth(min: 56, ideal: 208, max: 260)
        } detail: {
            LibraryPage(selectedGameId: $selectedGameId)
        }
        .task {
            // 首次加载：`task` 在视图出现时跑一次，且能 await
            await store.load()
        }
    }
}

// MARK: - 侧边栏

struct Sidebar: View {
    @EnvironmentObject private var store: AppStore
    @Binding var selectedGameId: String?

    var body: some View {
        List {
            Section {
                // ⚠️ 这里**故意**用 `Label` 而不是自绘行：
                //    mac 侧边栏的系统样式（选中高亮、图标对齐、缩进）都是白送的。
                Label("游戏库", systemImage: "gamecontroller")
                    .tag("library")
                    .onTapGesture { selectedGameId = nil }
            }
            // TODO(P5)：引擎页 / 设置页的导航项
        }
        .listStyle(.sidebar)
    }
}

// MARK: - 库页

struct LibraryPage: View {
    @EnvironmentObject private var store: AppStore
    @Binding var selectedGameId: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            toolbar
            content
        }
        .padding(.horizontal, 20)
        .padding(.top, 16)
        .navigationTitle("游戏库")
    }

    // MARK: 标题

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Text("游戏库")
                    .font(.system(size: 26, weight: .semibold))
                Spacer()
            }
            Text(subtitle)
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .padding(.bottom, 12)
    }

    /// 副标题：游戏数 + 当前筛选状态。
    ///
    /// ⚠️ 与 Electron 版的措辞一致：用户看到「共 5 个 · 只看未绑定」时
    ///    能立刻明白「为什么列表里少了几个」。**不说明筛选状态**会让用户以为游戏丢了。
    private var subtitle: String {
        let visible = store.filteredGames.count
        let total = store.games.count
        var parts = ["共 \(visible) 个游戏"]
        if store.searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
            parts.append("搜索「\(store.searchText)」")
        }
        if store.onlyUnbound {
            parts.append("只看未绑定")
        }
        if visible != total {
            parts.append("（全部 \(total) 个）")
        }
        return parts.joined(separator: " · ")
    }

    // MARK: 工具栏

    private var toolbar: some View {
        HStack(spacing: 12) {
            // 搜索框
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                    .foregroundStyle(.secondary)
                TextField("搜索游戏名或路径", text: $store.searchText)
                    .textFieldStyle(.plain)
                if !store.searchText.isEmpty {
                    Button {
                        store.searchText = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 6))
            .frame(maxWidth: 320)

            Spacer()

            // 「只看未绑定」开关
            Toggle(isOn: $store.onlyUnbound) {
                Text("只看未绑定")
                    .font(.callout)
            }
            .toggleStyle(.checkbox)

            // 视图切换（卡片 / 列表）
            //
            // ⚠️ 用 Picker(.segmented) 而不是两个按钮：
            //    分段控件本身就表达「这两个是同一个东西的两种形态」。
            Picker("视图", selection: $store.listView) {
                Image(systemName: "square.grid.2x2").tag(false)
                Image(systemName: "list.bullet").tag(true)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 80)
        }
        .padding(.bottom, 12)
    }

    // MARK: 内容

    @ViewBuilder
    private var content: some View {
        if store.isLoading {
            ProgressView("正在加载游戏库…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if let error = store.loadError {
            // ⚠️ **故障态要明确**：库页不能静默空白。
            //    空白会让用户以为「游戏全丢了」，而这其实是文件格式问题。
            EmptyStateView(
                icon: "exclamationmark.triangle",
                title: "游戏库读不出来",
                message: error
            )
        } else if store.filteredGames.isEmpty {
            // 两种空态**必须分开**（与 Electron 版 save-view 的取向一致）：
            //   · 库是空的     → 该去「添加游戏」
            //   · 筛选后为空   → 该去清搜索 / 关筛选
            if store.games.isEmpty {
                EmptyStateView(
                    icon: "gamecontroller",
                    title: "游戏库还是空的",
                    message: "把游戏文件夹拖进来，或者从「添加游戏」开始。"
                )
            } else {
                EmptyStateView(
                    icon: "line.3.horizontal.decrease.circle",
                    title: "没有符合条件的游戏",
                    message: "试试清空搜索「\(store.searchText)」，或者关掉「只看未绑定」。"
                )
            }
        } else if store.listView {
            listContent
        } else {
            gridContent
        }
    }

    private var gridContent: some View {
        ScrollView {
            // ⚠️ `LazyVGrid` 而不是 `Grid`：游戏多了之后 `Grid` 会一次性建所有卡片，
        //    而 Lazy 只建可见的（滚动时才创建）。用户有 5 个游戏时无感，
            //    但库涨到 100 个时差别明显。
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 200, maximum: 320), spacing: 16)],
                alignment: .leading,
                spacing: 16
            ) {
                ForEach(store.filteredGames, id: \.id) { game in
                    GameCard(
                        game: game,
                        isRunning: store.runningGames[game.id] != nil,
                        onSelect: { selectedGameId = game.id }
                    )
                }
            }
            .padding(.bottom, 20)
        }
    }

    private var listContent: some View {
        ScrollView {
            LazyVStack(spacing: 2) {
                ForEach(store.filteredGames, id: \.id) { game in
                    GameRow(
                        game: game,
                        isRunning: store.runningGames[game.id] != nil,
                        onSelect: { selectedGameId = game.id }
                    )
                }
            }
            .padding(.bottom, 20)
        }
    }
}

// MARK: - 空态

struct EmptyStateView: View {
    let icon: String
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: icon)
                .font(.system(size: 42))
                .foregroundStyle(.tertiary)
            Text(title)
                .font(.title3.weight(.medium))
            Text(message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 420)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.bottom, 60)
    }
}
