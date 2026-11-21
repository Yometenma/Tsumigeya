import SwiftUI
import TsumigeyaCore

struct ManualRJSheet: View {
    @EnvironmentObject private var store: AppStore
    let gameId: String
    @State private var text = ""
    @State private var external = false
    @State private var inputError: String?
    @FocusState private var focused: Bool

    private var busy: Bool {
        store.fetchingMeta.contains(gameId) || store.searchingGameIDs.contains(gameId)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(L("查找并关联作品")).font(.title2.weight(.semibold))
                Spacer()
                Button(L("关闭")) { store.closeManualRJ() }.keyboardShortcut(.cancelAction)
            }
            Picker(L("作品信息来源"), selection: $external) {
                Text("DLsite").tag(false)
                Text(L("其他游戏 · AI／手动")).tag(true)
            }.pickerStyle(.segmented).disabled(busy)
                .onChange(of: external) { _, _ in store.discardMetaPreview(gameId: gameId) }
            if external {
                ExternalMetadataView(gameId: gameId)
            } else if let preview = store.metaPreviews[gameId] {
                previewContent(preview)
            } else {
                searchContent
            }
        }
        .padding(24)
        .frame(width: 700, height: 640)
        .onAppear {
            external = store.meta(for: gameId)?.work.isExternal == true
            if let game = store.game(id: gameId) {
                text = store.lastKeyword[gameId] ?? store.meta(for: gameId)?.work.rj
                    ?? store.detectRJ(for: game).first ?? DlsiteLookup.searchKeyword(from: game.gameTitle)
                if text.isEmpty { text = DlsiteLookup.fallbackKeyword(fromPath: game.gamePath) }
            }
            focused = true
        }
    }

    private var searchContent: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L("输入作品名、RJ 编号或 DLsite 作品链接，自动查找成人向与全年龄作品；搜索不会修改游戏名称。"))
                .font(.callout).foregroundStyle(.secondary)
            HStack {
                TextField(L("作品名 / RJ 编号 / 作品链接"), text: $text)
                    .textFieldStyle(.roundedBorder).focused($focused)
                    .onSubmit { lookup() }.disabled(busy)
                Button(L("查找")) { lookup() }.buttonStyle(.borderedProminent)
                    .disabled(busy || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if busy {
                HStack {
                    ProgressView().controlSize(.small)
                    Text(store.fetchingMeta.contains(gameId) ? L("正在获取作品详情…") : L("正在搜索；必要时尝试清理后的标题…"))
                        .font(.callout).foregroundStyle(.secondary)
                    Spacer()
                    Button(L("取消任务")) { store.cancelLookup(gameId: gameId) }
                }
            }
            if let error = inputError ?? store.metaError[gameId] ?? store.searchError[gameId] {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.callout).foregroundStyle(.orange).textSelection(.enabled)
                if !busy { Button(L("重试当前查找")) { lookup() } }
            }
            if let keywords = store.searchKeywordsTried[gameId], !keywords.isEmpty {
                Text(String(format: L("已搜索：%@"), "\(keywords.joined(separator: " → "))")).font(.caption).foregroundStyle(.secondary)
            }
            ForEach(store.searchWarnings[gameId] ?? [], id: \.self) { warning in
                Label(warning, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.orange)
            }
            ScrollView {
                if let hits = store.searchHits[gameId], !hits.isEmpty {
                    DLsiteSearchResults(hits: hits, onSelect: { rj in
                        store.selectSearchHit(gameId: gameId, rj: rj)
                    }, onCancel: { store.clearSearch(gameId: gameId) })
                    .disabled(busy)
                } else if !busy && store.searchError[gameId] == nil {
                    ContentUnavailableView(L("查找你的作品"), systemImage: "magnifyingglass",
                                           description: Text(L("中文译名找不到时，可尝试日文原名、英文名或粘贴作品链接。")))
                }
            }
            Text(L("更换关联前会先预览并确认；取消或获取失败不会改动原有信息。"))
                .font(.caption).foregroundStyle(.secondary)
        }
    }

    private func previewContent(_ work: DlsiteWork) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    WorkRemoteImage(address: work.coverUrl).frame(height: 170)
                    DLsiteWorkInfo(work: work)
                }
            }
            if let existing = store.meta(for: gameId), existing.work.identity != work.identity {
                Label(L("将更换已关联的作品，旧作品的手改信息不会混入新作品；游戏名称、分类和存档不变。"),
                      systemImage: "arrow.triangle.2.circlepath")
                    .font(.caption).foregroundStyle(.orange)
            } else {
                Text(L("确认后保存作品信息；游戏库名称不变，同一作品的手动修改会保留。"))
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let error = store.metaError[gameId] {
                Text(error).font(.caption).foregroundStyle(.orange)
            }
            HStack {
                Button(L("返回查找")) { store.discardMetaPreview(gameId: gameId) }
                Spacer()
                Button(L("确认关联此作品")) {
                    if store.applyMetaPreview(gameId: gameId) { store.closeManualRJ() }
                }.buttonStyle(.borderedProminent)
            }
        }
    }

    private func lookup() {
        guard !busy else { return }
        inputError = nil
        store.discardMetaPreview(gameId: gameId)
        let input = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if let reference = DlsiteLookup.workReference(input) {
            store.fetchMeta(gameId: gameId, rj: reference.rj,
                            category: reference.category, preview: true)
        } else if input.contains("://") || input.range(of: #"(?i)^rj[-_\s]*\d"#, options: .regularExpression) != nil {
            inputError = L("请输入有效的 RJ 编号、DLsite 作品链接，或改用作品名搜索。")
        } else if !input.isEmpty {
            store.searchMeta(gameId: gameId, keyword: input)
        }
    }
}
