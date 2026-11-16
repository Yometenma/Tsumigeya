// 导航与游戏浏览分开：列表用于快速切换，卡片用于整库浏览。
import SwiftUI
import TsumigeyaCore

struct RootView: View {
    @EnvironmentObject private var store: AppStore
    @State private var selection: String?
    @State private var editingGameID: String?
    @State private var page: AppPage = .library
    private let loadsOnAppear: Bool

    init(selection: String? = nil, loadsOnAppear: Bool = true, initialPage: AppPage = .library) {
        _page = State(initialValue: initialPage)
        _selection = State(initialValue: selection)
        self.loadsOnAppear = loadsOnAppear
    }

    enum AppPage: String, CaseIterable, Identifiable {
        case library, engines, settings
        var id: String { rawValue }
        var title: String {
            switch self {
            case .library: return "游戏库"
            case .engines: return "运行时"
            case .settings: return "设置"
            }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            Divider()
            dataDirectoryNotice
            content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
        .tint(.indigo)
        .task {
            guard loadsOnAppear else { return }
            await store.load()
            store.refreshInstalledEngines()
            store.refreshEngineEntries()
            // ⚠️ 启动时若已有游戏在跑（上次没关干净），要开始轮询
            if !store.runningGames.isEmpty {
                store.startRunningPoll()
            }
        }
        .onReceive(
            NotificationCenter.default.publisher(
                for: NSApplication.didBecomeActiveNotification)
        ) { _ in
            store.refreshRunningFromAppActivation()
        }
        .modifier(AppPresentations(editingGameID: $editingGameID))
        .onChange(of: store.editRequest, initial: true) { _, id in
            guard let id else { return }
            editingGameID = id
            _ = store.consumeEditRequest()
        }
        .onChange(of: store.filteredGames.map(\.id)) { _, ids in
            if let selection, !ids.contains(selection) { self.selection = nil }
        }
    }

    @ViewBuilder
    private var dataDirectoryNotice: some View {
        if let warning = store.dataDirWarning {
            Label("原数据目录不可用，当前使用：\(warning.switchedTo)", systemImage: "exclamationmark.triangle")
                .font(.callout)
                .foregroundStyle(.orange)
                .textSelection(.enabled)
                .padding(10)
        }
    }

    // MARK: - 顶部导航

    private var topBar: some View {
        HStack(spacing: 20) {
            Label("Tsumigeya", systemImage: "gamecontroller.fill")
                .font(.system(size: 15, weight: .bold))
                .foregroundStyle(.primary)

            Picker("页面", selection: $page) {
                ForEach(AppPage.allCases) { p in Text(p.title).tag(p) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 240)

            Spacer(minLength: 12)

            Button { store.togglePrivacyMode() } label: {
                Label(store.privacy.isEnabled ? "隐私已开启" : "隐私模式",
                      systemImage: store.privacy.isEnabled ? "eye.slash.fill" : "eye")
            }
            .help("切换隐私模式（⇧⌘P）")

            if page == .library {
                Button { store.openAddGame() } label: {
                    Label("添加游戏", systemImage: "plus")
                }
                .keyboardShortcut("o", modifiers: .command)
                .help("添加游戏（⌘O）")
                Button { store.isBatchAdding = true } label: {
                    Label("批量入库", systemImage: "folder.badge.plus")
                }
                .disabled(store.privacy.hidesTitles)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }

    // MARK: - 分类栏（库页顶部）

    /// 分类筛选栏 + 新建入口。
    ///
    /// ⚠️ **分类在库页顶部，不在侧边栏**（D84 —— 用户 2026-11-05 拍板）：
    ///    侧边栏同时装着导航，分类越攒越多会把导航挤远。
    ///
    /// ⚠️ **必须有「新建分类」入口**（用户 2026-11-06 报的第 3 个问题：
    ///    「没有地方创建分类」）。本鱼第一版只做了筛选，忘了新建。
    private var categoryBar: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 7) {
                categoryChip(title: "全部", isActive: store.activeCategory == nil) {
                    store.activeCategory = nil
                }

                ForEach(Categories.ordered(store.categories), id: \.id) { pair in
                    categoryChip(
                        title: pair.def.name,
                        isActive: store.activeCategory == pair.id
                    ) {
                        store.activeCategory = (store.activeCategory == pair.id) ? nil : pair.id
                    }
                    .contextMenu {
                        Button("删除分类「\(pair.def.name)」", role: .destructive) {
                            store.confirmDeleteCategory(id: pair.id, name: pair.def.name)
                        }
                    }
                }

                // 新建分类
                Button {
                    store.beginCreateCategory()
                } label: {
                    Label("新建分类", systemImage: "plus")
                        .font(.system(size: 11))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Color.secondary.opacity(0.08), in: Capsule())

                Spacer()
            }
            .padding(.vertical, 4)
        }
        .frame(height: 32)
    }

    private func categoryChip(
        title: String, isActive: Bool, action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 12, weight: isActive ? .semibold : .regular))
                .padding(.horizontal, 9)
                .padding(.vertical, 3)
                .background(
                    isActive ? Color.accentColor.opacity(0.18) : Color.secondary.opacity(0.08),
                    in: Capsule())
                .foregroundStyle(isActive ? Color.accentColor : Color.secondary)
        }
        .buttonStyle(.plain)
    }

    // MARK: - 内容

    @ViewBuilder
    private var content: some View {
        switch page {
        case .library:
            if store.isLoading {
                ProgressView("正在加载游戏库…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error = store.loadError {
                ContentUnavailableView {
                    Label("游戏库读取失败", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(error).textSelection(.enabled)
                } actions: {
                    Button("重新加载") { Task { await store.load() } }
                    Button("打开数据目录") {
                        NSWorkspace.shared.open(URL(fileURLWithPath: store.dataDir))
                    }
                }
            } else if store.games.isEmpty {
                WelcomeView()
            } else {
                VStack(spacing: 0) {
                    libraryToolbar
                    Divider()
                    if store.filteredGames.isEmpty {
                        LibraryNoResultsView()
                    } else if store.settingBool(.listView) {
                        HSplitView {
                            GameListView(selection: $selection)
                                .frame(minWidth: 260, idealWidth: 300, maxWidth: 380)
                            selectedGamePane
                                .frame(minWidth: 480, maxWidth: .infinity, maxHeight: .infinity)
                        }
                    } else if selection != nil {
                        selectedGamePane
                    } else {
                        GameListView(selection: $selection)
                    }
                }
            }
        case .engines:
            EnginesPage()
        case .settings:
            SettingsPage()
        }
    }

    private var libraryToolbar: some View {
        HStack(spacing: 12) {
            if !store.settingBool(.listView), selection != nil {
                Button { selection = nil } label: {
                    Label("返回游戏库", systemImage: "chevron.left")
                }
                .keyboardShortcut(.cancelAction)
            } else {
                Text("\(store.filteredGames.count) 个游戏")
                    .font(.callout.weight(.medium))
                    .foregroundStyle(.secondary)
                    .fixedSize()
            }
            categoryBar
                .frame(maxWidth: .infinity)
            SearchField(text: $store.searchText)
                .frame(width: 250)
            Picker("显示方式", selection: Binding(
                get: { store.settingBool(.listView) },
                set: { value in
                    store.setSetting(.listView, .bool(value))
                    if !value { selection = nil }
                }
            )) {
                Image(systemName: "list.bullet").tag(true)
                Image(systemName: "square.grid.2x2").tag(false)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(width: 76)
            .help("切换列表或卡片视图")
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 10)
    }

    @ViewBuilder
    private var selectedGamePane: some View {
        if let id = selection, let game = store.game(id: id) {
            GameDetailView(game: game, onEdit: { editingGameID = game.id },
                           onManageEngines: { page = .engines })
                .id(game.id)
        } else {
            WelcomeView()
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
    @EnvironmentObject private var store: AppStore
    @Binding var text: String
    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: 5) {
            Button { isFocused = true } label: {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
            .keyboardShortcut("f", modifiers: .command)
            .accessibilityLabel("搜索游戏")
            .help("搜索游戏（⌘F）")
            Group {
                if store.privacy.hidesTitles {
                    SecureField("搜索内容已隐藏", text: $text)
                } else {
                    TextField("搜索游戏名、路径或引擎", text: $text)
                }
            }
            .focused($isFocused)
            .textFieldStyle(.plain)
            .font(.system(size: 13))
            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("清除搜索")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 7))
    }
}

// MARK: - 库页列表

struct GameListView: View {
    @EnvironmentObject private var store: AppStore
    @Binding var selection: String?

    var body: some View {
        if !store.games.isEmpty && store.filteredGames.isEmpty {
            LibraryNoResultsView()
        } else if store.settingBool(.listView) {
            listBody
        } else {
            cardBody
        }
    }

    /// 列表视图（mac 侧边栏样式）。
    private var listBody: some View {
        List(selection: $selection) {
            ForEach(store.groups, id: \.id) { group in
                Section {
                    ForEach(group.games, id: \.id) { game in
                        GameListRow(
                            game: game,
                            isRunning: store.runningGames[game.id] != nil
                        )
                        .tag(game.id)
                        .contextMenu {
                            Button("编辑") {
                                selection = game.id
                                store.requestEdit(gameId: game.id)
                            }
                            Button("在访达中显示") {
                                store.revealInFinder(game: game)
                            }
                            Divider()
                            Button("从游戏库移除", role: .destructive) {
                                store.confirmDelete(game: game)
                            }
                        }
                    }
                } header: {
                    groupHeader(group)
                }
            }
        }
        .listStyle(.sidebar)
    }

    /// 卡片整库浏览，封面来源与详情页一致。
    private var cardBody: some View {
        ScrollView {
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 210, maximum: 300), spacing: 12)],
                alignment: .leading, spacing: 12
            ) {
                ForEach(store.filteredGames, id: \.id) { game in
                    GameCardTile(
                        game: game,
                        isRunning: store.runningGames[game.id] != nil,
                        isSelected: selection == game.id,
                        onSelect: { selection = game.id }
                    )
                    .contextMenu {
                        Button("编辑游戏") {
                            selection = game.id
                            store.requestEdit(gameId: game.id)
                        }
                        Button("在访达中显示") { store.revealInFinder(game: game) }
                        Divider()
                        Button("从游戏库移除", role: .destructive) { store.confirmDelete(game: game) }
                    }
                }
            }
            .padding(24)
        }
    }

    private func groupHeader(_ group: AppStore.Group) -> some View {
        HStack(spacing: 6) {
            Text(group.title)
            Text("\(group.games.count)")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }
}

struct LibraryNoResultsView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        VStack(spacing: 14) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 36))
                .foregroundStyle(.secondary)
            Text("没有匹配的游戏").font(.title2)
            Text("试试其他关键词，或清除筛选。")
                .foregroundStyle(.secondary)
            Button("清除筛选") {
                store.searchText = ""
                store.activeCategory = nil
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - 卡片

struct GameCardTile: View {
    let game: GameRecord
    let isRunning: Bool
    let isSelected: Bool
    let onSelect: () -> Void

    @EnvironmentObject private var store: AppStore
    @State private var isHovering = false

    var body: some View {
        Button(action: onSelect) {
            VStack(alignment: .leading, spacing: 0) {
                GameArtwork(game: game)
                    .frame(height: 148)
                    .clipped()
                    .overlay(alignment: .topTrailing) {
                        if isRunning {
                            Label("运行中", systemImage: "circle.fill")
                                .font(.caption2.weight(.medium))
                                .padding(6)
                                .background(.regularMaterial, in: Capsule())
                                .padding(8)
                        }
                    }

                VStack(alignment: .leading, spacing: 2) {
                    Text(store.displayTitle(for: game))
                        .font(.system(size: 12, weight: .medium))
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                    Text(EngineRegistry.find(folder: game.gameEngine)?.name ?? game.gameEngine)
                        .font(.system(size: 10))
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 9)
                .padding(.vertical, 12)
            }
        }
        .buttonStyle(.plain)
        .background(RoundedRectangle(cornerRadius: 8)
            .fill(Color(nsColor: .controlBackgroundColor)))
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .strokeBorder(
                    isSelected ? Color.accentColor : (isHovering ? Color.accentColor.opacity(0.4) : .clear),
                    lineWidth: isSelected ? 2 : 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .onHover { isHovering = $0 }
        .animation(.easeOut(duration: 0.12), value: isHovering)
        .help(store.privacy.text(game.gamePath, replacement: "游戏路径已隐藏"))
    }


}

// MARK: - 列表行

struct GameListRow: View {
    @EnvironmentObject private var store: AppStore
    let game: GameRecord
    let isRunning: Bool

    var body: some View {
        HStack(spacing: 10) {
            GameArtwork(game: game)
                .frame(width: 44, height: 36)
                .clipShape(RoundedRectangle(cornerRadius: 6))
            VStack(alignment: .leading, spacing: 4) {
                Text(store.displayTitle(for: game))
                    .font(.system(size: 13, weight: .medium))
                    .lineLimit(2)
                Text(EngineRegistry.find(folder: game.gameEngine)?.name ?? game.gameEngine)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            if isRunning {
                Image(systemName: "play.circle.fill")
                    .foregroundStyle(.green)
                    .accessibilityLabel("运行中")
            }
        }
        .padding(.vertical, 6)
        .help(store.privacy.text(game.gamePath, replacement: "游戏路径已隐藏"))
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
                Text("添加游戏文件或文件夹，自动识别引擎后即可开始。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                Button("添加第一个游戏") { store.openAddGame() }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
            } else {
                Text("选一个游戏，开始游玩")
                    .font(.title2.weight(.medium))
                Text("从左侧选择游戏，查看作品信息、管理存档或调整启动设置。")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// 游戏 id 是字符串，而模态表单需要稳定的 Identifiable 目标。
struct GameSheetTarget: Identifiable {
    let id: String
}

/// 弹窗与导航拆开，避免根视图的泛型链过长、拖慢 Swift 的类型检查。
private struct AppPresentations: ViewModifier {
    @EnvironmentObject private var store: AppStore
    @Binding var editingGameID: String?

    func body(content: Content) -> some View {
        content
        // 编辑目标独立于列表筛选；保存标题后即使不再匹配搜索，也不能关闭尚未保存完的表单。
        .sheet(item: Binding(
            get: { editingGameID.map(GameSheetTarget.init(id:)) },
            set: { if $0 == nil { editingGameID = nil } }
        )) { target in
            if let game = store.game(id: target.id) {
                GameEditView(game: game, onDone: { editingGameID = nil })
                    .environmentObject(store)
                    .frame(minWidth: 720, idealWidth: 800, minHeight: 600, idealHeight: 720)
            }
        }
        .sheet(isPresented: $store.isAddingGame) {
            AddGameWizard()
                .environmentObject(store)
        }
        .sheet(isPresented: $store.isBatchAdding) {
            BatchImportView().environmentObject(store)
        }
        // 新建分类（输入名字的小弹窗）
        .sheet(isPresented: $store.isCreatingCategory) {
            CreateCategorySheet()
                .environmentObject(store)
        }
        // 手动输入 RJ 号（P7）
        //
        // ⚠️ 为什么需要：用户的真实游戏**全部检测不到 RJ**，
        //    没有手动入口的话 P7 完全无法使用。
        .sheet(item: Binding(
            get: { store.manualRJFor.map(GameSheetTarget.init(id:)) },
            set: { if $0 == nil { store.closeManualRJ() } }
        )) { target in
            ManualRJSheet(gameId: target.id)
                .environmentObject(store)
        }
        .alert("操作未完成", isPresented: Binding(
            get: { store.operationError != nil },
            set: { if !$0 { store.operationError = nil } }
        )) {
            Button("好", role: .cancel) { store.operationError = nil }
        } message: {
            Text(store.privacy.text(store.operationError ?? "", replacement: "操作未完成。详细信息已隐藏，可关闭标题隐藏后查看。"))
        }
        // 删除游戏确认
        .alert("从游戏库移除？", isPresented: Binding(
            get: { store.pendingDelete != nil },
            set: { if !$0 { store.cancelPendingDelete() } }
        ), presenting: store.pendingDelete) { game in
            // ⚠️ **必须说清「不会删游戏文件」** ——
            //    用户最怕的是「点一下把游戏删没了」。
            //    实际只删库里的记录，游戏目录原样不动。
            Button("移除", role: .destructive) {
                store.confirmPendingDelete()
            }
            Button("取消", role: .cancel) {
                store.cancelPendingDelete()
            }
        } message: { game in
            Text("「\(store.displayTitle(for: game))」会从游戏库移除。\n\n"
                 + "**游戏文件不会被删除**，只是不再显示在列表里。"
                 + "游玩记录和分类归属也会一起清掉。")
        }
        // 删除分类确认
        .alert("删除分类？", isPresented: Binding(
            get: { store.pendingDeleteCategory != nil },
            set: { if !$0 { store.cancelDeleteCategory() } }
        ), presenting: store.pendingDeleteCategory) { pair in
            Button("删除", role: .destructive) {
                store.confirmPendingDeleteCategory()
            }
            Button("取消", role: .cancel) {
                store.cancelDeleteCategory()
            }
        } message: { pair in
            Text("分类「\(pair.name)」会被删除。\n\n"
                 + "**游戏不会被删除**，只是它们不再属于这个分类。")
        }
    }
}
