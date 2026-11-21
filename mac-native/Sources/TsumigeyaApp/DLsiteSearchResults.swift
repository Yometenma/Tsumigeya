import SwiftUI
import TsumigeyaCore

struct DLsiteSearchResults: View {
    let hits: [DLsiteSearch.Hit]
    let onSelect: (String) -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(String(format: L("找到 %@ 个候选，请核对作品和版本"), "\(hits.count)"))
                    .font(.subheadline).foregroundStyle(.secondary)
                Spacer()
                Button(L("清除结果"), action: onCancel).controlSize(.small)
            }
            ForEach(hits) { hit in
                HStack(alignment: .top, spacing: 12) {
                    WorkRemoteImage(address: hit.coverUrl).frame(width: 96, height: 72)
                    VStack(alignment: .leading, spacing: 5) {
                        Text(hit.title).font(.callout.weight(.medium)).lineLimit(3)
                            .fixedSize(horizontal: false, vertical: true)
                        if let circle = hit.circle { Text(circle).font(.caption).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true) }
                        HStack {
                            Text(hit.rj).font(.caption.monospaced()).foregroundStyle(.secondary)
                            if let url = URL(string: DLsiteService.pageURL(category: hit.category, rj: hit.rj)) {
                                Link(L("作品页"), destination: url).font(.caption)
                            }
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading).layoutPriority(1)
                    Button(L("预览")) { onSelect(hit.rj) }.controlSize(.small).fixedSize()
                }
                .padding(10)
                .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 9))
            }
        }
    }
}
