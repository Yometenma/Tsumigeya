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
            case .overview: return "作品介绍"
            case .saves: return "存档"
            case .translation: return "翻译"
            case .assistance: return "辅助"
            case .runtime: return "引擎管理"
            }
        }
    }

    @State private var showsRelocation = false
    @State private var showsDiagnostics = false
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
            .frame(maxWidth: 480)
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
        .sheet(isPresented: $showsDiagnostics) {
            LaunchDiagnosticsView(game: game, onManageEngines: onManageEngines)
                .environmentObject(store)
        }
    }

    private var header: some View {
        let work = store.meta(for: game.id)?.work
        let tags = Array((work?.tags ?? []).prefix(3))
        return ZStack(alignment: .bottomLeading) {
            GameArtwork(game: game, contentMode: .fill)
                .frame(maxWidth: .infinity, minHeight: 250, maxHeight: 280)
                .overlay(
                    LinearGradient(
                        colors: [Color.black.opacity(0.82), Color.black.opacity(0.38), .clear],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )

            VStack(alignment: .leading, spacing: 10) {
                Text("DLsite · 作品详情")
                    .font(.system(size: 11, weight: .semibold))
                    .tracking(1.1)
                    .foregroundStyle(.white.opacity(0.72))
                Text(store.displayTitle(for: game))
                    .font(.system(size: 28, weight: .bold))
                    .foregroundStyle(.white)
                    .lineLimit(2)
                if !store.privacy.hidesTitles, let description = work?.description, !description.isEmpty {
                    Text(description)
                        .font(.system(size: 13))
                        .foregroundStyle(.white.opacity(0.78))
                        .lineLimit(2)
                        .frame(maxWidth: 460, alignment: .leading)
                }
                HStack(spacing: 7) {
                    if store.runningGames[game.id] != nil {
                        heroPill("正在游玩", tint: .green)
                    }
                    ForEach(tags, id: \.self) { tag in
                        heroPill(tag)
                    }
                }
            }
            .padding(28)
        }
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .padding(.horizontal, 24)
        .padding(.top, 24)
    }

    private func heroPill(_ title: String, tint: Color? = nil) -> some View {
        Text(title)
            .font(.system(size: 11, weight: .medium))
            .foregroundStyle(tint ?? .white.opacity(0.9))
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(.white.opacity(0.12), in: Capsule())
            .overlay(Capsule().stroke(.white.opacity(0.24), lineWidth: 1))
    }

    // MARK: - DLsite 元数据

    /// 更新和错误提示独立于已保存内容，失败时仍能阅读原信息。
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

            if store.fetchingMeta.contains(game.id) {
                HStack {
                    ProgressView().controlSize(.small)
                    Text("正在更新作品信息…").font(.caption).foregroundStyle(.secondary)
                    Button("取消") { store.cancelLookup(gameId: game.id) }.controlSize(.small)
                }
            }
            if let error = store.metaError[game.id] {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption).foregroundStyle(.orange)
                Text("原有作品信息未更改，可重试刷新或重新查找作品。")
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
        switch lookupStep {
        case .byRJ(let rj):
            return "检测到 RJ 号 \(rj)。点「查找作品」可预览并关联作品信息。"
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
        let busy = store.fetchingMeta.contains(game.id)
        if let meta = store.meta(for: game.id) {
            Button("刷新信息") {
                store.fetchMeta(gameId: game.id, rj: meta.work.rj, refresh: true, category: meta.work.category)
            }.controlSize(.small).disabled(busy)
            Button("更换关联…") { store.beginManualRJ(gameId: game.id) }
                .controlSize(.small).disabled(busy)
        } else {
            Button("查找作品…") { store.beginManualRJ(gameId: game.id) }
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
            if store.privacy.hidesTitles {
                privacyNotice
            } else {
                dlsiteSection
            }
        case .saves:
            SaveSection(game: game)
        case .translation:
            if tab == .translation { GameAssistanceView(game: game, mode: .translation) }
        case .assistance:
            // 只有打开辅助页才读取接口凭据，浏览其他页面不应触发钥匙串授权。
            if tab == .assistance { GameAssistanceView(game: game, mode: .assistance) }
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
                    Text("引擎信息").font(.headline)
                    Text("此游戏使用 \(engineDisplayName)。如果启动异常，可以检查下方的启动参数。")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 12)
                if let onManageEngines {
                    Button("管理引擎", action: onManageEngines)
                }
            }
            if game.gameEngine == "wine" {
                HStack {
                    Button("Windows 环境设置…") { store.configureWine(game: game) }
                        .disabled(store.runningGames[game.id] != nil)
                    Text("可调整 Windows 版本、显示、音频及 DLL 设置。")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Text("Wine 不是安全沙盒，只运行可信来源的程序。游戏可能把存档保存在游戏目录或独立 Windows 环境中；无法自动定位时请手动指定。")
                    .font(.caption).foregroundStyle(.secondary)
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
                    Button("检查启动条件…") { showsDiagnostics = true }
                    Divider()
                    Button("重新定位游戏目录…") { showsRelocation = true }
                        .disabled(store.privacy.hidesTitles || store.runningGames[game.id] != nil)
                    Button("在访达中显示") { store.revealInFinder(game: game) }
                    Button("查找并关联作品…") { store.beginManualRJ(gameId: game.id) }
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
                HStack(alignment: .top, spacing: 10) {
                    Label(store.privacy.text(failure, replacement: "启动未完成，详细信息已隐藏。"), systemImage: "exclamationmark.triangle.fill")
                        .font(.callout)
                        .foregroundStyle(.orange)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    Button("检查启动条件") { showsDiagnostics = true }
                        .buttonStyle(.bordered)
                        .disabled(store.privacy.hidesTitles)
                }
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
