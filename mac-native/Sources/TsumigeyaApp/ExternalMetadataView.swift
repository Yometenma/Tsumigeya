import SwiftUI
import TsumigeyaCore

struct ExternalMetadataView: View {
    @EnvironmentObject private var store: AppStore
    let gameId: String
    @State private var input = ""
    @State private var consent = false
    @State private var draft: DlsiteWork?
    @State private var selected: Set<String> = []
    @State private var changed: Set<String> = []
    @State private var localError: String?
    private var busy: Bool { store.fetchingMeta.contains(gameId) }
    private let labels = ["title": "作品标题", "titleSub": "原文／副标题", "circle": "开发商／发行商", "description": "作品介绍", "coverUrl": "封面地址", "workType": "作品类型代码", "ageRating": "年龄分级", "releaseDate": "发售日期", "series": "系列", "tags": "标签", "languages": "游戏支持语言", "creators": "制作", "voiceActors": "配音", "supportedSystems": "原版支持系统"]

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let draft {
                preview(draft)
            } else {
                Text("粘贴公开商品页让 AI 整理，或输入游戏名联网查找。也可完全手动填写，不需要接口。")
                    .font(.callout).foregroundStyle(.secondary)
                TextField("官网／商店页 HTTPS 链接，或游戏名＋开发商／年份", text: $input)
                    .textFieldStyle(.roundedBorder).disabled(busy)
                Toggle("允许把输入内容和必要页面正文发给已配置的作品信息接口（可能收费）", isOn: $consent)
                    .font(.caption).disabled(busy)
                HStack {
                    Button(input.lowercased().hasPrefix("https://") ? "读取并整理页面" : "联网查找候选") { start() }
                        .buttonStyle(.borderedProminent).disabled(!consent || busy || input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("手动填写…") { store.prepareManualExternal(gameId: gameId); loadDraft() }.disabled(busy)
                    if busy { ProgressView().controlSize(.small); Button("取消任务") { store.cancelLookup(gameId: gameId) } }
                }
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        ForEach(store.externalCandidates[gameId] ?? []) { candidate in
                            VStack(alignment: .leading, spacing: 5) {
                                Text(candidate.title).font(.headline)
                                Text(candidate.url).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                                HStack {
                                    if let url = MetadataNetwork.publicURL(candidate.url) { Link("打开来源核对", destination: url) }
                                    Button("整理此页面并预览") { store.extractExternal(gameId: gameId, address: candidate.url) }
                                        .disabled(busy || !consent)
                                }
                            }.padding(12).frame(maxWidth: .infinity, alignment: .leading).background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
                Text("普通聊天接口只整理指定页面。联网查找需在「设置 → 作品信息」配置支持 web_search 的 Responses 接口。需登录、验证或动态加载的页面可能无法读取；来源中的内容也可能不准确，请核对后保存。不会自动关联搜索首条。")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let error = localError ?? store.metaError[gameId] {
                Label(error, systemImage: "exclamationmark.triangle").font(.callout).foregroundStyle(.orange).textSelection(.enabled)
            }
        }
        .onAppear {
            input = store.meta(for: gameId)?.work.pageURL ?? store.game(id: gameId)?.gameTitle ?? ""
            loadDraft()
        }
        .onChange(of: store.metaPreviews[gameId]) { _, _ in loadDraft() }
    }
    private func start() {
        localError = nil
        if input.lowercased().hasPrefix("https://") { store.extractExternal(gameId: gameId, address: input) }
        else { store.searchExternal(gameId: gameId, name: input) }
    }
    private func loadDraft() {
        guard let original = store.metaPreviews[gameId], original.isExternal else { draft = nil; return }
        let old = store.meta(for: gameId)
        let fields = old?.work.identity == original.identity ? Set(old?.editedFields ?? []) : []
        let work = EditedFields.merge(old: old?.work, incoming: original, edited: fields)
        draft = work
        selected = Set(EditedFields.editable.filter { !MetadataFields.text(work, field: $0).isEmpty })
        changed = []; localError = nil
    }
    private func preview(_ work: DlsiteWork) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if work.coverUrl != nil { WorkRemoteImage(address: work.coverUrl, external: true).frame(height: 150) }
                    Text("勾选要保存的字段，可直接修改。取消勾选不会清除同一作品的已有字段；更换作品则不继承旧资料。")
                        .font(.caption).foregroundStyle(.secondary)
                    ForEach(EditedFields.editable, id: \.self) { field in
                        VStack(alignment: .leading, spacing: 4) {
                            Toggle(labels[field] ?? field, isOn: Binding(
                                get: { selected.contains(field) }, set: { if $0 { selected.insert(field) } else { selected.remove(field) } }
                            )).font(.subheadline)
                            if selected.contains(field) {
                                TextField("留空表示未知", text: Binding(
                                    get: { draft.map { MetadataFields.text($0, field: field) } ?? "" },
                                    set: { value in
                                        guard var copy = draft else { return }
                                        MetadataFields.set(&copy, field: field, text: value); draft = copy; changed.insert(field)
                                    }
                                ), axis: .vertical).lineLimit(field == "description" ? 4...12 : 1...3).textFieldStyle(.roundedBorder)
                            }
                            let quotes = work.fieldEvidence.filter { $0.key == field || $0.key.hasPrefix(field + ".") }.sorted { $0.key < $1.key }
                            if !quotes.isEmpty {
                                DisclosureGroup("来源引文") {
                                    ForEach(quotes, id: \.key) { Text($0.value).font(.caption).foregroundStyle(.secondary).textSelection(.enabled).fixedSize(horizontal: false, vertical: true) }
                                }
                            }
                        }
                    }
                    if let address = work.pageURL, let url = MetadataNetwork.publicURL(address) {
                        Link("来源：" + address, destination: url).font(.caption)
                    }
                    if let old = store.meta(for: gameId), old.work.identity != work.identity {
                        Label("确认后将更换当前资料来源，不继承旧作品字段；游戏库名称、人工分类和存档不变。", systemImage: "arrow.triangle.2.circlepath")
                            .font(.caption).foregroundStyle(.orange)
                    }
                }
            }
            HStack {
                Button("返回查找") { store.discardMetaPreview(gameId: gameId); draft = nil }
                Spacer()
                Button("确认保存所选信息") { save() }.buttonStyle(.borderedProminent)
            }
        }
    }
    private func save() {
        guard let draft else { return }
        let selectedWork = MetadataFields.selecting(draft, existing: store.meta(for: gameId)?.work, fields: selected)
        guard let title = selectedWork.title, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            localError = "请至少填写并保留作品标题。"; return
        }
        if let cover = selectedWork.coverUrl, MetadataNetwork.publicURL(cover) == nil {
            localError = "封面必须使用公开 HTTPS 图片地址；不填写时不会生成封面。"; return
        }
        if store.applyExternalPreview(gameId: gameId, work: selectedWork, edited: changed.intersection(selected)) {
            store.closeManualRJ()
        } else {
            localError = store.metaError[gameId] ?? "资料未保存，请重新准备预览后再试。"
        }
    }
}
