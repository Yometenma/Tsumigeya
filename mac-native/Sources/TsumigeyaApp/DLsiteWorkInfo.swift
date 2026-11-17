import SwiftUI
import TsumigeyaCore

struct WorkRemoteImage: View {
    let address: String?
    @EnvironmentObject private var store: AppStore
    @State private var attempt = 0

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 7).fill(.quaternary)
            if let url = store.privacy.coverURL(address) {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .empty: ProgressView().controlSize(.small)
                    case .success(let image):
                        image.resizable().scaledToFit()
                            .accessibilityLabel("作品图片已加载")
                    case .failure:
                        Button { attempt += 1 } label: {
                            Label("重试图片", systemImage: "arrow.clockwise")
                                .font(.caption)
                        }.buttonStyle(.plain)
                    @unknown default: EmptyView()
                    }
                }.id(attempt)
            } else {
                Image(systemName: store.privacy.isEnabled ? "eye.slash" : "photo")
                    .foregroundStyle(.secondary)
            }
        }
        .clipped()
    }
}

struct DLsiteWorkInfo: View {
    let work: DlsiteWork
    @EnvironmentObject private var store: AppStore
    @State private var expanded = false
    @State private var selectedImage: String?

    var body: some View {
        if store.privacy.hidesTitles {
            Text("作品信息已隐藏").foregroundStyle(.secondary)
        } else {
            VStack(alignment: .leading, spacing: 14) {
                if let title = work.title { Text(title).font(.headline).textSelection(.enabled) }
                Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 8) {
                    row("社团", work.circle)
                    row("发售日期", work.releaseDate)
                    row("系列", work.series)
                    row("作品类型", work.workType.map(typeName))
                    row("语言", work.languages.isEmpty ? nil : work.languages.map(languageName).joined(separator: "、"))
                    row("制作", work.creators.isEmpty ? nil : work.creators.joined(separator: "、"))
                    row("配音", work.voiceActors.isEmpty ? nil : work.voiceActors.joined(separator: "、"))
                    row("原版支持系统", work.supportedSystems)
                }.font(.callout)
                if !work.tags.isEmpty {
                    Text("题材标签").font(.subheadline.weight(.medium))
                    Text(work.tags.joined(separator: " · "))
                        .font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                }
                if let description = work.description, !description.isEmpty {
                    Text("作品介绍").font(.subheadline.weight(.medium))
                    Text(description).font(.callout).foregroundStyle(.secondary)
                        .lineSpacing(5).lineLimit(expanded ? nil : 12).textSelection(.enabled)
                    if description.count > 350 || description.components(separatedBy: .newlines).count > 12 {
                        Button(expanded ? "收起介绍" : "展开完整介绍") { expanded.toggle() }
                            .buttonStyle(.link)
                    }
                }
                if !work.sampleImageURLs.isEmpty && !store.privacy.isEnabled {
                    Text("预览截图").font(.subheadline.weight(.medium))
                    ScrollView(.horizontal) {
                        HStack(spacing: 10) {
                            ForEach(work.sampleImageURLs, id: \.self) { address in
                                Button { selectedImage = address } label: {
                                    WorkRemoteImage(address: address).frame(width: 180, height: 126)
                                }.buttonStyle(.plain).accessibilityLabel("放大预览截图")
                            }
                        }
                    }
                }
                HStack {
                    Text(work.rj).font(.caption.monospaced()).foregroundStyle(.secondary)
                    if let url = URL(string: DLsiteService.pageURL(category: work.category ?? "maniax", rj: work.rj)) {
                        Link("查看作品页", destination: url).font(.caption)
                    }
                    Spacer()
                }
                Text("信息获取时间：\(work.fetchedAt)")
                    .font(.caption2).foregroundStyle(.tertiary)
            }
            .sheet(isPresented: Binding(get: { selectedImage != nil }, set: { if !$0 { selectedImage = nil } })) {
                VStack(spacing: 12) {
                    WorkRemoteImage(address: selectedImage).frame(minWidth: 640, minHeight: 440)
                    Button("关闭") { selectedImage = nil }.keyboardShortcut(.cancelAction)
                }.padding(20)
            }
            .onChange(of: work.rj) { _, _ in expanded = false; selectedImage = nil }
            .onChange(of: store.privacy.isEnabled) { _, enabled in if enabled { selectedImage = nil } }
        }
    }

    @ViewBuilder private func row(_ title: String, _ value: String?) -> some View {
        if let value, !value.isEmpty {
            GridRow {
                Text(title).foregroundStyle(.secondary)
                Text(value).textSelection(.enabled)
            }
        }
    }

    private func typeName(_ code: String) -> String {
        if let normalized = GameWorkType.code(code), let name = GameWorkType.names[normalized] { return name }
        return code == "SOU" ? "音声作品" : code
    }

    private func languageName(_ code: String) -> String {
        ["JPN": "日语", "ENG": "英语", "CHI_HANS": "简体中文", "CHI_HANT": "繁体中文",
         "CHI": "中文", "KO_KR": "韩语", "SPA": "西班牙语", "GER": "德语", "FRE": "法语"][code] ?? code
    }
}
