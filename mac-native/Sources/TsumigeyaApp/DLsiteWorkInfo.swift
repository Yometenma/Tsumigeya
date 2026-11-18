import AppKit
import SwiftUI
import TsumigeyaCore

struct WorkRemoteImage: View {
    let address: String?
    var external = false
    var maxPixelSize = 2048

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 7).fill(.quaternary)
            if let url = (external ? address.flatMap(MetadataNetwork.publicURL) : address.flatMap(DLsiteParser.normalizeCoverUrl).flatMap(URL.init(string:))) {
                CachedRemoteImage(url: url, external: external, maxPixelSize: maxPixelSize).id(url)
            } else {
                Image(systemName: "photo")
                    .foregroundStyle(.secondary)
            }
        }
        .clipped()
    }
}

/// 长正文使用 AppKit 原生文本布局，避免 SwiftUI 在详情切换时反复执行昂贵的最优换行计算。
private struct LongDescriptionView: NSViewRepresentable {
    let text: String

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.hasVerticalScroller = true
        scrollView.hasHorizontalScroller = false
        scrollView.autohidesScrollers = true
        scrollView.scrollerStyle = .overlay

        let textView = NSTextView()
        textView.isEditable = false
        textView.isSelectable = true
        textView.isRichText = false
        textView.importsGraphics = false
        textView.drawsBackground = false
        textView.textColor = .secondaryLabelColor
        textView.font = .systemFont(ofSize: NSFont.systemFontSize)
        textView.textContainerInset = NSSize(width: 0, height: 6)
        textView.textContainer?.lineFragmentPadding = 0
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.minSize = NSSize(width: 0, height: 0)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.string = text
        scrollView.documentView = textView
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? NSTextView, textView.string != text else { return }
        textView.string = text
        textView.scrollToBeginningOfDocument(nil)
    }
}

struct DLsiteWorkInfo: View {
    let work: DlsiteWork
    @State private var selectedImage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if let title = work.title { Text(title).font(.headline).textSelection(.enabled) }
            Grid(alignment: .leading, horizontalSpacing: 18, verticalSpacing: 8) {
                row(work.isExternal ? "开发商／发行商" : "社团", work.circle)
                row("资料来源", work.sourceLabel)
                row("页面／整理语言", work.metadataLanguage.flatMap(MetadataLanguage.init(rawValue:))?.name ?? "未标明")
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
                LongDescriptionView(text: description)
                    .frame(maxWidth: .infinity, minHeight: 180, idealHeight: 300, maxHeight: 360)
                    .accessibilityLabel("作品介绍正文")
            }
            if !work.sampleImageURLs.isEmpty {
                Text("预览截图").font(.subheadline.weight(.medium))
                ScrollView(.horizontal) {
                    HStack(spacing: 10) {
                        ForEach(work.sampleImageURLs, id: \.self) { address in
                            Button { selectedImage = address } label: {
                                WorkRemoteImage(address: address, external: work.isExternal, maxPixelSize: 360).frame(width: 180, height: 126)
                            }.buttonStyle(.plain).accessibilityLabel("放大预览截图")
                        }
                    }
                }
            }
            HStack {
                if !work.rj.isEmpty { Text(work.rj).font(.caption.monospaced()).foregroundStyle(.secondary) }
                if let address = work.pageURL, let url = URL(string: address) {
                    Link("查看作品页", destination: url).font(.caption)
                }
                Spacer()
            }
            if !work.isExternal {
                Text("页面语言不等于游戏语言；未翻译的字段可能保留原文。")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            if !work.fieldEvidence.isEmpty {
                DisclosureGroup("核对资料来源引文") {
                    ForEach(work.fieldEvidence.keys.sorted(), id: \.self) { key in
                        Text(work.fieldEvidence[key] ?? "").font(.caption).textSelection(.enabled)
                    }
                }
            }
            Text("信息获取时间：\(work.fetchedAt)")
                .font(.caption2).foregroundStyle(.tertiary)
        }
        .sheet(isPresented: Binding(get: { selectedImage != nil }, set: { if !$0 { selectedImage = nil } })) {
            VStack(spacing: 12) {
                WorkRemoteImage(address: selectedImage, external: work.isExternal).frame(minWidth: 640, minHeight: 440)
                Button("关闭") { selectedImage = nil }.keyboardShortcut(.cancelAction)
            }.padding(20)
        }
        .onChange(of: work.identity) { _, _ in selectedImage = nil }
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
