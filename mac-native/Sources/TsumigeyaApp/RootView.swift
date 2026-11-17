// 游戏库采用 macOS 原生侧边栏：分类在左侧，详情在右侧，空选择时只展示欢迎页。
import SwiftUI
import AppKit
import TsumigeyaCore

struct RootView: View {
    @EnvironmentObject private var store: AppStore
    @State private var selection: String?
    @State private var editingGameID: String?
    @State private var page: AppPage = .library
    @State private var sidebarVisible = true
    @State private var collapsedGroups: Set<String> = []
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
            case .engines: return "引擎管理"
            case .settings: return "设置"
            }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            Divider()
            dataDirectoryNotice
            HStack(spacing: 0) {
                // 保持侧边栏视图挂载，只收缩宽度；如果直接用 if 移除整个子树，
                // macOS 窗口在切换详情／欢迎页时偶尔会吞掉下一次“显示侧边栏”点击。
                // 侧边栏始终保留在层级中，但由外层容器真正收缩到 0；
                // 这样收起后不会留下窄条，也不会让内部固定宽度挤占内容区。
                ZStack(alignment: .leading) {
                    librarySidebar
                        .frame(width: 248)
                        .frame(maxHeight: .infinity)
                }
                .frame(width: sidebarVisible ? 248 : 0)
                .frame(maxHeight: .infinity)
                .clipped()
                .opacity(sidebarVisible ? 1 : 0)
                .allowsHitTesting(sidebarVisible)

                Divider()
                    .frame(width: sidebarVisible ? 1 : 0)
                    .opacity(sidebarVisible ? 1 : 0)
                content
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(minWidth: 980, maxWidth: .infinity, minHeight: 660, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
        .tint(Color.tsumigeyaAccent)
        .task {
            guard loadsOnAppear else { return }
            await store.load()
            store.refreshInstalledEngines()
            store.refreshEngineEntries()
            if !store.runningGames.isEmpty { store.startRunningPoll() }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
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

    private var topBar: some View {
        HStack(spacing: 12) {
            Button {
                withAnimation(.easeInOut(duration: 0.18)) {
                    sidebarVisible.toggle()
                }
            } label: {
                Image(systemName: sidebarVisible ? "sidebar.leading" : "sidebar.trailing")
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .keyboardShortcut("s", modifiers: [.command, .option])
            .accessibilityLabel(sidebarVisible ? "收起侧边栏" : "显示侧边栏")
            .help(sidebarVisible ? "收起侧边栏（⌘⌥S）" : "显示侧边栏（⌘⌥S）")

            Label("Tsumigeya", systemImage: "gamecontroller.fill")
                .font(.system(size: 15, weight: .bold))

            Spacer(minLength: 12)

            if page == .library {
                SearchField(text: $store.searchText)
                    .frame(width: 240)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }

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
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private var librarySidebar: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Text("游戏库")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 4)
                libraryMenu
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)

            Divider()

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 5) {
                    ForEach(store.groups) { group in
                        DisclosureGroup(isExpanded: groupExpansion(for: group.id)) {
                            VStack(spacing: 2) {
                                ForEach(group.games, id: \.id) { game in
                                    SidebarGameRow(
                                        game: game,
                                        isSelected: selection == game.id,
                                        isRunning: store.runningGames[game.id] != nil
                                    ) {
                                        page = .library
                                        selection = game.id
                                    }
                                }
                            }
                            .padding(.top, 2)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        } label: {
                            HStack(spacing: 6) {
                                Text(group.title)
                                Spacer(minLength: 4)
                                Text("\(group.games.count)")
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.secondary)
                        }
                        .padding(.horizontal, 8)
                    }

                    if store.groups.isEmpty && !store.games.isEmpty {
                        Text("没有匹配的作品")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(12)
                    }
                }
                .padding(.vertical, 10)
            }

            Spacer(minLength: 8)
            Divider()
            VStack(spacing: 2) {
                sidebarNavigationButton(.engines, systemImage: "gearshape", title: "引擎管理")
                sidebarNavigationButton(.settings, systemImage: "slider.horizontal.3", title: "设置")
            }
            .padding(8)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .controlBackgroundColor))
    }

    private var libraryMenu: some View {
        Menu {
            Button("全部作品") { store.activeCategory = nil }
            if !store.categories.isEmpty {
                Divider()
                ForEach(Categories.ordered(store.categories), id: \.id) { pair in
                    Button {
                        store.activeCategory = store.activeCategory == pair.id ? nil : pair.id
                    } label: {
                        HStack {
                            Text(pair.def.name)
                            if store.activeCategory == pair.id { Image(systemName: "checkmark") }
                        }
                    }
                }
            }
            Divider()
            Button("收起所有分类") { collapsedGroups = Set(store.groups.map(\.id)) }
            Button("展开所有分类") { collapsedGroups.removeAll() }
            Button("新建分类…") { store.beginCreateCategory() }
            Divider()
            Button("批量补全作品信息") { store.isBatchMetaPresented = true }
                .disabled(store.games.isEmpty || store.privacy.hidesTitles)
            Button("批量入库") { store.isBatchAdding = true }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 12, weight: .semibold))
                .frame(width: 24, height: 24)
        }
        .menuStyle(.borderlessButton)
        .menuIndicator(.hidden)
        .accessibilityLabel("游戏库菜单")
        .help("游戏库菜单")
    }

    private func groupExpansion(for id: String) -> Binding<Bool> {
        Binding(
            get: { !collapsedGroups.contains(id) },
            set: { expanded in
                if expanded { collapsedGroups.remove(id) }
                else { collapsedGroups.insert(id) }
            }
        )
    }

    private func sidebarNavigationButton(_ target: AppPage, systemImage: String, title: String) -> some View {
        Button {
            page = target
        } label: {
            Label(title, systemImage: systemImage)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 9)
                .padding(.vertical, 7)
                .background(page == target ? Color.secondary.opacity(0.12) : .clear,
                            in: RoundedRectangle(cornerRadius: 7))
        }
        .buttonStyle(.plain)
        .foregroundStyle(page == target ? .primary : .secondary)
    }

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
            } else if store.filteredGames.isEmpty {
                LibraryNoResultsView()
            } else if let id = selection, let game = store.game(id: id) {
                GameDetailView(game: game, onEdit: { editingGameID = game.id }, onManageEngines: { page = .engines })
                    .id(game.id)
            } else {
                WelcomeView()
            }
        case .engines:
            EnginesPage()
        case .settings:
            SettingsPage()
        }
    }
}

struct SidebarGameRow: View {
    let game: GameRecord
    let isSelected: Bool
    let isRunning: Bool
    let action: () -> Void
    @EnvironmentObject private var store: AppStore

    var body: some View {
        Button(action: action) {
            HStack(spacing: 9) {
                GameArtwork(game: game)
                    .frame(width: 34, height: 34)
                    .clipShape(RoundedRectangle(cornerRadius: 7))
                VStack(alignment: .leading, spacing: 2) {
                    Text(store.displayTitle(for: game))
                        .font(.system(size: 11.5, weight: .medium))
                        .lineLimit(1)
                    HStack(spacing: 4) {
                        Circle()
                            .fill(isRunning ? Color.green : Color.secondary.opacity(0.35))
                            .frame(width: 5, height: 5)
                        Text(isRunning ? "正在游玩" : (EngineRegistry.find(folder: game.gameEngine)?.name ?? game.gameEngine))
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(isSelected ? Color.secondary.opacity(0.16) : .clear,
                        in: RoundedRectangle(cornerRadius: 9))
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .buttonStyle(.plain)
        .help(store.privacy.text(game.gamePath, replacement: "游戏路径已隐藏"))
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
                    TextField("搜索名称、社团、标签或路径", text: $text)
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
        GeometryReader { proxy in
            let compact = proxy.size.width < 680

            HStack(spacing: 0) {
                welcomeCopy(compact: compact)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
                    .padding(.leading, compact ? 28 : 44)
                    .padding(.trailing, compact ? 18 : 32)

                welcomePlaceholder(compact: compact)
                    .frame(width: compact ? proxy.size.width * 0.42 : proxy.size.width * 0.52)
                    .frame(maxHeight: .infinity)
                    .clipped()
            }
            .frame(width: proxy.size.width, height: proxy.size.height)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .textBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .padding(22)
    }

    @ViewBuilder
    private func welcomeCopy(compact: Bool) -> some View {
        VStack(alignment: .leading, spacing: compact ? 12 : 16) {
            Text("Tsumigeya")
                .font(.system(size: 13, weight: .semibold, design: .rounded))
                .tracking(2.4)
                .foregroundStyle(Color.tsumigeyaAccent.opacity(0.78))
                .textCase(.uppercase)

            Text("今天想玩哪一部？")
                .font(.system(size: compact ? 26 : 30, weight: .bold, design: .rounded))
                .foregroundStyle(Color(nsColor: .labelColor))
                .fixedSize(horizontal: false, vertical: true)

            Text("你的作品，都在这里。")
                .font(.system(size: 14, weight: .regular))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            if store.games.isEmpty {
                Button {
                    store.openAddGame()
                } label: {
                    Label("添加第一部作品", systemImage: "plus")
                        .font(.system(size: 13, weight: .semibold))
                        .padding(.horizontal, 16)
                        .padding(.vertical, 9)
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.tsumigeyaAccent)
                .controlSize(.large)
            }
        }
        .frame(maxWidth: compact ? 300 : 380, alignment: .leading)
    }

    // 正式看板娘素材准备好前使用中性占位，不再把带底色的临时原图放进欢迎页。
    @ViewBuilder
    private func welcomePlaceholder(compact: Bool) -> some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color.tsumigeyaAccent.opacity(0.08),
                    Color(nsColor: .windowBackgroundColor).opacity(0.04),
                    Color.tsumigeyaAccent.opacity(0.16)
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )

            Circle()
                .fill(Color.tsumigeyaAccent.opacity(0.12))
                .frame(width: compact ? 170 : 260, height: compact ? 170 : 260)
                .blur(radius: 2)
                .offset(x: compact ? 36 : 60, y: compact ? -46 : -72)

            Circle()
                .stroke(Color.tsumigeyaAccent.opacity(0.18), lineWidth: 1)
                .frame(width: compact ? 130 : 190, height: compact ? 130 : 190)
                .offset(x: compact ? -28 : -44, y: compact ? 48 : 72)

            Image(systemName: "sparkles")
                .font(.system(size: compact ? 48 : 72, weight: .light))
                .foregroundStyle(Color.tsumigeyaAccent.opacity(0.48))
                .symbolRenderingMode(.hierarchical)
        }
        .overlay(alignment: .topTrailing) {
            Image(systemName: "gamecontroller.fill")
                .font(.system(size: compact ? 18 : 24, weight: .medium))
                .foregroundStyle(Color.tsumigeyaAccent.opacity(0.32))
                .padding(compact ? 22 : 34)
        }
        .accessibilityLabel("欢迎页插画占位")
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
        .sheet(isPresented: Binding(
            get: { store.isBatchMetaPresented },
            set: { if !$0 { store.closeBatchMeta() } }
        )) {
            BatchMetadataView().environmentObject(store)
        }
        // 新建分类（输入名字的小弹窗）
        .sheet(isPresented: $store.isCreatingCategory) {
            CreateCategorySheet()
                .environmentObject(store)
        }
        // 查找弹窗独立于当前筛选；关闭时取消任务，防止晚到结果被误确认。
        .sheet(item: Binding(
            get: { store.isBatchMetaPresented ? nil : store.manualRJFor.map(GameSheetTarget.init(id:)) },
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
                 + "**游戏不会被删除**，只是它们不再属于这个分类。作品类型分类删除后不会在刷新资料时自动重建；新建同名类型分类可重新启用。")
        }
    }
}
