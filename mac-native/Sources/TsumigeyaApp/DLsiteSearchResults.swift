import SwiftUI
import TsumigeyaCore

struct DLsiteSearchResults: View {
    let hits: [DLsiteSearch.Hit]
    let onSelect: (String) -> Void
    let onCancel: () -> Void
    @EnvironmentObject private var store: AppStore

    var body: some View {
        if store.privacy.hidesTitles {
            Text("搜索结果已隐藏，关闭标题隐藏后可核对作品。")
                .foregroundStyle(.secondary)
        } else {
            results
        }
    }

    private var results: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text("搜到 \(hits.count) 个结果，选一个：")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("取消", action: onCancel)
                .controlSize(.small)
            }
            .padding(.bottom, 6)

            ForEach(Array(hits.enumerated()), id: \.element.rj) { idx, hit in
                if idx > 0 { Divider().padding(.leading, 8) }
                Button {
                    onSelect(hit.rj)
                } label: {
                    HStack(alignment: .top, spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(hit.title)
                                .font(.system(size: 11))
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                            HStack(spacing: 8) {
                                Text(hit.rj)
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundStyle(.tertiary)
                                if let circle = hit.circle {
                                    Text(circle)
                                        .font(.system(size: 10))
                                        .foregroundStyle(.tertiary)
                                        .lineLimit(1)
                                }
                            }
                        }
                        Spacer()
                        Image(systemName: "chevron.right")
                            .font(.system(size: 9))
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(6)
        .background(Color(nsColor: .controlBackgroundColor),
                    in: RoundedRectangle(cornerRadius: 7))
    }
}
