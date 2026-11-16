// 主操作保持可见；作品、存档和排障信息分层，避免所有功能挤在一条长页面中。
import SwiftUI
import TsumigeyaCore

struct GameDetailView: View {
    let game: GameRecord
    /// 编辑入口由根视图提供，弹窗不依附于当前筛选结果。
    var onEdit: (() -> Void)? = nil
    @EnvironmentObject private var store: AppStore

    var onManageEngines: (() -> Void)? = nil

    enum DetailTab: String, CaseIterable, Identifiable {
        case overview, saves, runtime
        var id: String { rawValue }
        var title: String {
            switch self {
            case .overview: return "概览"
            case .saves: return "存档"
            case .runtime: return "运行信息"
            }
        }
    }

    @State private var showsRelocation = false
    @State private var tab: DetailTab

    init(game: GameRecord, onEdit: (() -> Void)? = nil,
         onManageEngines: (() -> Void)? = nil, initialTab: DetailTab = .overview) {
        self.game = game
        self.onEdit = onEdit
        self.onManageEngines = onManageEngines
        _tab = State(initialValue: initialTab)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            launchSection
                .padding(.horizontal, 24)
                .padding(.bottom, 20)

            Picker("游戏信息", selection: $tab) {
                ForEach(DetailTab.allCases) { item in Text(item.title).tag(item) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .frame(maxWidth: 320)
            .padding(.horizontal, 24)
            .padding(.bottom, 16)

            Divider()
            // 保持标签内容挂载，切页不能丢掉进行中的存档任务状态而允许重复操作。
            ZStack(alignment: .topLeading) {
                ForEach(DetailTab.allCases) { item in
                    ScrollView {
                        bodyContent(for: item)
                            .frame(maxWidth: 860, alignment: .leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(24)
                    }
                    .opacity(tab == item ? 1 : 0)
                    .allowsHitTesting(tab == item)
                    .disabled(tab != item)
                    .accessibilityHidden(tab != item)
                }
            }
        }
        .background(Color(nsColor: .textBackgroundColor))
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 20) {
            GameArtwork(game: game)
                .frame(width: 160, height: 120)
                .clipShape(RoundedRectangle(cornerRadius: 10))

            VStack(alignment: .leading, spacing: 10) {
                Text(store.displayTitle(for: game))
                    .font(.system(size: 23, weight: .bold))
                    .lineLimit(3)
                    .textSelection(.enabled)
                HStack(spacing: 8) {
                    Text(engineDisplayName)
                        .font(.caption.weight(.medium))
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(.indigo.opacity(0.12), in: Capsule())
                    if store.runningGames[game.id] != nil {
                        Label("运行中", systemImage: "play.circle.fill")
                            .font(.caption)
                            .foregroundStyle(.green)
                    }
                }
                Text(store.privacy.text(folderHint, replacement: "游戏目录已隐藏"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(24)
    }

    // MARK: - DLsite 元数据

    /// DLsite 元数据区块（P7）。
    ///
    /// 三种状态：
    ///   · 没有元数据 → 「获取作品信息」按钮（自动从路径检测 RJ）
    ///   · 正在抓 → 进度
    ///   · 有元数据 → 社团/作品类型/简介 + 刷新按钮
    private var dlsiteSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("作品信息")
                    .font(.system(size: 15, weight: .semibold))
                if let rj = store.meta(for: game.id)?.work.rj
                    ?? store.detectRJ(for: game).first {
                    Text(rj)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }
                Spacer()
                dlsiteActions
            }

            if store.searchingFor == game.id {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("正在搜索「\(store.lastKeyword[game.id] ?? "")」…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else if let hits = store.searchHits[game.id], !hits.isEmpty {
                // ⚠️ **搜索结果必须让用户点选**（D24：绝不自动选第一条）
                //
                //    实测搜 `Karryn` 返回正片 + 3 个 DLC。
                //    自动选第一条 = 可能拿错的封面，而用户不会意识到。
                DLsiteSearchResults(hits: hits, onSelect: { rj in
                    store.selectSearchHit(gameId: game.id, rj: rj)
                }, onCancel: { store.clearSearch(gameId: game.id) })
            } else if let error = store.searchError[game.id] {
                Label(error, systemImage: "magnifyingglass")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            } else if store.fetchingMeta.contains(game.id) {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("正在从 DLsite 抓取…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } else if let error = store.metaError[game.id] {
                // ⚠️ **错误必须是可读的**（`DLsiteError.message` 每种说不同的话）
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            } else if let meta = store.meta(for: game.id) {
                dlsiteInfo(meta)
            } else {
                // 还没有元数据
                Text(noMetaHint)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// 没有元数据时的提示（走决策链）。
    ///
    /// ⚠️ **决策链是用户明确要求的**（2026-11-06）：
    ///    「自动识别如果有直接能找到 rj 号就用 rj 号，不能就按名字来」
    private var noMetaHint: String {
        switch lookupStep {
        case .byRJ(let rj):
            return "检测到 RJ 号 \(rj)。点「获取作品信息」会从 DLsite 拉封面与简介。"
        case .byKeyword(let keyword):
            return "路径里没有 RJ 号，可以按名字搜索「\(keyword)」，"
                + "从结果里选一个作品。"
        case .manual:
            return "路径里没有 RJ 号，标题也没法当关键词。请手动输入 RJ（"
                + "从 DLsite 作品页地址里找 product_id/RJ…）。"
        }
    }

    /// 这个游戏该怎么查（决策链）。
    private var lookupStep: DlsiteLookup.Step {
        DlsiteLookup.plan(
            gamePath: game.gamePath, gameTitle: game.gameTitle)
    }

    @ViewBuilder
    private var dlsiteActions: some View {
        if store.fetchingMeta.contains(game.id) || store.searchingFor == game.id {
            EmptyView()
        } else if store.meta(for: game.id) != nil {
            Button("刷新") {
                if let rj = store.meta(for: game.id)?.work.rj {
                    store.fetchMeta(gameId: game.id, rj: rj, refresh: true)
                }
            }
            .controlSize(.small)
        } else {
            switch lookupStep {
            case .byRJ(let rj):
                Button("获取作品信息") {
                    store.fetchMeta(gameId: game.id, rj: rj)
                }
                .controlSize(.small)
            case .byKeyword(let keyword):
                Button(store.searchingFor == nil ? "按名字搜索" : "正在搜索其他游戏…") {
                    store.searchMeta(gameId: game.id, keyword: keyword)
                }
                .controlSize(.small)
                .disabled(store.searchingFor != nil)
            case .manual:
                EmptyView()
            }
            // ⚠️ **永远保留手动入口**（自动识别失败时的兜底）
            Button("手动输入 RJ") {
                store.beginManualRJ(gameId: game.id)
            }
            .controlSize(.small)
        }
    }

    /// 有元数据时的信息行。
    private func dlsiteInfo(_ meta: GameDlsiteMeta) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 14) {
                if let circle = meta.work.circle, !circle.isEmpty {
                    HStack(spacing: 4) {
                        Text("社团").font(.caption2).foregroundStyle(.secondary)
                        Text(circle).font(.caption2)
                    }
                }
                if let workType = meta.work.workType, !workType.isEmpty {
                    HStack(spacing: 4) {
                        Text("类型").font(.caption2).foregroundStyle(.secondary)
                        // ⚠️ 作品类型码是 DLsite 内部的（SOU / RPG / ADV），
                        //    这里**原样显示**（翻译表留到有需要时）
                        Text(workType).font(.caption2)
                    }
                }
                if meta.editedFields.contains("title") {
                    Text("标题已手改")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                Spacer()
            }

            if let desc = meta.work.description, !desc.isEmpty {
                Text(desc)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineSpacing(5)
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
        }
    }

    /// 游戏目录名（父目录的最后一段）。
    private var folderHint: String {
        let dir = DetectPath.gameDirForFiles(game.gamePath)
        return (dir as NSString).lastPathComponent
    }

    // MARK: - 信息区

    @ViewBuilder
    private func bodyContent(for section: DetailTab) -> some View {
        switch section {
        case .overview:
            if store.privacy.hidesTitles {
                privacyNotice
            } else {
                dlsiteSection
            }
        case .saves:
            SaveSection(game: game)
        case .runtime:
            if store.privacy.hidesTitles {
                privacyNotice
            } else {
                runtimeContent
            }
        }
    }

    private var privacyNotice: some View {
        Label("作品详情已隐藏，关闭标题隐藏后可查看和核对搜索结果。", systemImage: "eye.slash")
            .foregroundStyle(.secondary)
    }

    private var runtimeContent: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack {
                VStack(alignment: .leading, spacing: 6) {
                    Text("运行环境").font(.headline)
                    Text("此游戏使用 \(engineDisplayName)。启动异常时，可检查运行时和下方的启动参数。")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 12)
                if let onManageEngines {
                    Button("管理运行时", action: onManageEngines)
                }
            }
            Divider()
            infoRows
            engineArgsSection
        }
    }

    // MARK: 启动

    private var launchSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                let isRunning = store.runningGames[game.id] != nil
                let isStopping = store.stoppingGames.contains(game.id)
                Button {
                    if isRunning { store.stop(game: game) }
                    else { store.launch(game: game) }
                } label: {
                    Label(isStopping ? "正在停止…" : (isRunning ? "停止游戏" : "开始游戏"),
                          systemImage: isRunning ? "stop.fill" : "play.fill")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(minWidth: 108)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 11)
                        .background(isRunning ? Color.red : Color.indigo,
                                    in: RoundedRectangle(cornerRadius: 9))
                        .opacity(isStopping ? 0.55 : 1)
                }
                .buttonStyle(.plain)
                .disabled(isStopping)
                .keyboardShortcut(.defaultAction)

                Spacer(minLength: 8)
                if let onEdit {
                    Button(action: onEdit) { Label("编辑游戏", systemImage: "slider.horizontal.3") }
                }
                Menu {
                    Button("重新定位游戏目录…") { showsRelocation = true }
                        .disabled(store.privacy.hidesTitles || store.runningGames[game.id] != nil)
                    Button("在访达中显示") { store.revealInFinder(game: game) }
                    Button("手动关联作品信息…") { store.beginManualRJ(gameId: game.id) }
                    Divider()
                    Button("从游戏库移除…", role: .destructive) { store.confirmDelete(game: game) }
                } label: {
                    Image(systemName: "ellipsis")
                        .frame(width: 20, height: 20)
                }
                .sheet(isPresented: $showsRelocation) {
                    RelocateGameView(game: game).environmentObject(store)
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .fixedSize()
                .accessibilityLabel("更多游戏操作")
                .help("更多游戏操作")
            }
            if let failure = store.lastLaunchFailure[game.id] {
                Label(store.privacy.text(failure, replacement: "启动未完成，详细信息已隐藏。"), systemImage: "exclamationmark.triangle.fill")
                    .font(.callout)
                    .foregroundStyle(.orange)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    // MARK: 信息行

    private var infoRows: some View {
        VStack(alignment: .leading, spacing: 10) {
            infoRow("路径", game.gamePath, mono: true)
            if !store.gameFolderExists(game) {
                Label("游戏目录不存在，请从更多菜单重新定位。", systemImage: "folder.badge.questionmark")
                    .foregroundStyle(.orange)
            }
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

    private var engineDisplayName: String {
        EngineRegistry.find(folder: game.gameEngine)?.name ?? game.gameEngine
    }
}
