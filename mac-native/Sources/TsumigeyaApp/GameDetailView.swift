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
        case overview, saves, translation, assistance, runtime
        var id: String { rawValue }
        var title: String {
            switch self {
            case .overview: return L("作品介绍")
            case .saves: return L("存档")
            case .translation: return L("翻译")
            case .assistance: return L("辅助")
            case .runtime: return L("引擎管理")
            }
        }
    }

    @State private var showsRelocation = false
    @State private var showsDiagnostics = false
    @State private var tab: DetailTab
    @StateObject private var lookup = GameDetailLookup()

    init(game: GameRecord, onEdit: (() -> Void)? = nil,
         onManageEngines: (() -> Void)? = nil, initialTab: DetailTab = .overview) {
        self.game = game
        self.onEdit = onEdit
        self.onManageEngines = onManageEngines
        _tab = State(initialValue: initialTab)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header
                if tab != .overview {
                    Text(store.displayTitle(for: game))
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundStyle(Color(nsColor: .labelColor))
                        .textSelection(.enabled)
                        .padding(.horizontal, 24)
                        .padding(.top, 18)
                }
                HStack(alignment: .center, spacing: 16) {
                    Picker(L("游戏信息"), selection: $tab) {
                        ForEach(DetailTab.allCases) { item in Text(item.title).tag(item) }
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    .frame(maxWidth: 480)

                    Spacer(minLength: 16)
                    launchControls
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 16)

                launchFailure
                    .padding(.horizontal, 24)

                Divider()
                bodyContent(for: tab)
                    .frame(maxWidth: 860, alignment: .leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(24)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task(id: game) {
            guard store.meta(for: game.id) == nil else { return }
            await lookup.load(game: game)
        }
        .scrollIndicators(.automatic)
        .background(Color(nsColor: .windowBackgroundColor))
        .sheet(isPresented: $showsDiagnostics) {
            LaunchDiagnosticsView(game: game, onManageEngines: onManageEngines)
                .environmentObject(store)
        }
    }

    private var header: some View {
        return GameArtwork(game: game, contentMode: .fit, preferPreview: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .aspectRatio(16 / 9, contentMode: .fit)
            .background(Color(nsColor: .controlBackgroundColor))
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .padding(.horizontal, 24)
            .padding(.top, 24)
    }

    // MARK: - DLsite 元数据

    /// 更新和错误提示独立于已保存内容，失败时仍能阅读原信息。
    private var dlsiteSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(L("作品信息"))
                    .font(.system(size: 15, weight: .semibold))
                if let rj = store.meta(for: game.id)?.work.rj ?? lookup.rj, !rj.isEmpty {
                    Text(rj)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }
                Spacer()
                dlsiteActions
            }

            if store.fetchingMeta.contains(game.id) {
                HStack {
                    ProgressView().controlSize(.small)
                    Text(L("正在更新作品信息…")).font(.caption).foregroundStyle(.secondary)
                    Button(L("取消")) { store.cancelLookup(gameId: game.id) }.controlSize(.small)
                }
            }
            if let error = store.metaError[game.id] {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.orange)
                Text(L("原有作品信息未更改，可重试刷新或重新查找作品。"))
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let notice = store.metaNotice[game.id] {
                Label(notice, systemImage: "checkmark.circle").font(.caption).foregroundStyle(.secondary)
            }
            if let meta = store.meta(for: game.id) {
                DLsiteWorkInfo(work: meta.work)
            } else {
                Text(noMetaHint).font(.callout).foregroundStyle(.secondary)
            }
        }
    }

    /// 没有元数据时的提示（走决策链）。
    ///
    /// ⚠️ **决策链是用户明确要求的**（2026-11-06）：
    ///    「自动识别如果有直接能找到 rj 号就用 rj 号，不能就按名字来」
    private var noMetaHint: String {
        guard let step = lookup.step else {
            return L("可通过「查找作品」关联作品信息。")
        }
        switch step {
        case .byRJ(let rj):
            return "检测到 RJ 号 \(rj)。点「查找作品」可预览并关联作品信息。"
        case .byKeyword(let keyword):
            return "路径里没有 RJ 号，可以按名字搜索「\(keyword)」，"
                + L("从结果里选一个作品。")
        case .manual:
            return L("路径里没有 RJ 号，标题也没法当关键词。请手动输入 RJ（")
                + L("从 DLsite 作品页地址里找 product_id/RJ…）。")
        }
    }

    @ViewBuilder
    private var dlsiteActions: some View {
        let busy = store.fetchingMeta.contains(game.id)
        if let meta = store.meta(for: game.id) {
            if !meta.work.isExternal {
            Button(L("刷新信息")) {
                store.fetchMeta(gameId: game.id, rj: meta.work.rj, refresh: true, category: meta.work.category)
            }.controlSize(.small).disabled(busy)
            }
            Button(meta.work.isExternal ? L("补全／更换资料…") : L("更换关联…")) { store.beginManualRJ(gameId: game.id) }
                .controlSize(.small).disabled(busy)
        } else {
            Button(L("查找作品…")) { store.beginManualRJ(gameId: game.id) }
                .controlSize(.small).disabled(busy)
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
            dlsiteSection
        case .saves:
            SaveSection(game: game)
        case .translation:
            if tab == .translation { GameAssistanceView(game: game, mode: .translation) }
        case .assistance:
            // 只有打开辅助页才读取接口凭据，浏览其他页面不应触发钥匙串授权。
            if tab == .assistance { GameAssistanceView(game: game, mode: .assistance) }
        case .runtime:
            runtimeContent
        }
    }

    private var runtimeContent: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack {
                VStack(alignment: .leading, spacing: 6) {
                    Text(L("引擎信息")).font(.headline)
                    Text("此游戏使用 \(engineDisplayName)。如果启动异常，可以检查下方的启动参数。")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 12)
                if let onManageEngines {
                    Button(L("管理引擎"), action: onManageEngines)
                }
            }
            if game.gameEngine == "wine" {
                HStack {
                    Button(L("Windows 环境设置…")) { store.configureWine(game: game) }
                        .disabled(store.runningGames[game.id] != nil)
                    Text(L("可调整 Windows 版本、显示、音频及 DLL 设置。"))
                        .font(.caption).foregroundStyle(.secondary)
                }
                Text(L("Wine 不是安全沙盒，只运行可信来源的程序。游戏可能把存档保存在游戏目录或独立 Windows 环境中；无法自动定位时请手动指定。"))
                    .font(.caption).foregroundStyle(.secondary)
            }
            Divider()
            infoRows
            engineArgsSection
        }
    }

    // MARK: 启动

    private var launchControls: some View {
        HStack(spacing: 10) {
            let isRunning = store.runningGames[game.id] != nil
            let isStopping = store.stoppingGames.contains(game.id)
            Button {
                if isRunning { store.stop(game: game) }
                else { store.launch(game: game) }
            } label: {
                Label(isStopping ? L("正在停止…") : (isRunning ? L("停止游戏") : L("开始游戏")),
                      systemImage: isRunning ? "stop.fill" : "play.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(minWidth: 108)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 11)
                    .background(isRunning ? Color.red : Color.tsumigeyaAccent,
                                in: RoundedRectangle(cornerRadius: 9))
                    .opacity(isStopping ? 0.55 : 1)
            }
            .buttonStyle(.plain)
            .disabled(isStopping)
            .keyboardShortcut(.defaultAction)

            if let onEdit {
                Button(action: onEdit) { Label(L("编辑游戏"), systemImage: "slider.horizontal.3") }
            }
            Menu {
                Button(L("检查启动条件…")) { showsDiagnostics = true }
                Divider()
                Button(L("重新定位游戏目录…")) { showsRelocation = true }
                    .disabled(store.runningGames[game.id] != nil)
                Button(L("在访达中显示")) { store.revealInFinder(game: game) }
                Button(L("查找并关联作品…")) { store.beginManualRJ(gameId: game.id) }
                Divider()
                Button(L("从游戏库移除…"), role: .destructive) { store.confirmDelete(game: game) }
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
            .accessibilityLabel(L("更多游戏操作"))
            .help(L("更多游戏操作"))
        }
    }

    @ViewBuilder
    private var launchFailure: some View {
        if let failure = store.lastLaunchFailure[game.id] {
            HStack(alignment: .top, spacing: 10) {
                Label(failure, systemImage: "exclamationmark.triangle.fill")
                    .font(.callout)
                    .foregroundStyle(.orange)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 8)
                Button(L("检查启动条件")) { showsDiagnostics = true }
                    .buttonStyle(.bordered)
            }
            .padding(.bottom, 8)
        }
    }

    // MARK: 信息行

    private var infoRows: some View {
        VStack(alignment: .leading, spacing: 10) {
            infoRow(L("路径"), game.gamePath, mono: true)
            if !store.gameFolderExists(game) {
                Label(L("游戏目录不存在，请从更多菜单重新定位。"), systemImage: "folder.badge.questionmark")
                    .foregroundStyle(.orange)
            }
            if let pid = store.runningGames[game.id] {
                infoRow(L("进程"), "运行中（pid \(pid)）")
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
                Text(L("引擎参数"))
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
        case .null: return L("（空）")
        case .bool(let b): return b ? L("开") : L("关")
        case .int(let i): return "\(i)"
        case .double(let d): return "\(d)"
        case .string(let s): return s.isEmpty ? L("（空）") : s
        case .array(let items):
            if items.isEmpty { return L("（空）") }
            return items.compactMap { $0.stringValue }.joined(separator: ", ")
        case .object:
            return L("（对象）")
        }
    }

    private var engineDisplayName: String {
        EngineRegistry.find(folder: game.gameEngine)?.name ?? game.gameEngine
    }
}
