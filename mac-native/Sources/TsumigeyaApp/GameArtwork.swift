import SwiftUI
import TsumigeyaCore

/// 只展示 DLsite 资料中的封面或预览图；不从游戏目录猜测图片，避免把素材误当作品图。
struct GameArtwork: View {
    let game: GameRecord
    var contentMode: ContentMode = .fit
    var preferPreview = false
    @EnvironmentObject private var store: AppStore
    @State private var imageAttempt = 0

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                placeholder
                // 隐私模式移除图片子树；晚到的下载结果不能重新显示原图。
                if let url = store.artworkURL(for: game, preferPreview: preferPreview) {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image):
                            image.resizable().aspectRatio(contentMode: contentMode)
                                .accessibilityLabel("作品封面已加载")
                        case .empty: ProgressView().controlSize(.small)
                        case .failure:
                            Button { imageAttempt += 1 } label: {
                                Label("重试封面", systemImage: "arrow.clockwise").font(.caption)
                            }.buttonStyle(.plain)
                        @unknown default: EmptyView()
                        }
                    }.id("\(url.absoluteString)#\(imageAttempt)")
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
            .clipped()
        }
        .accessibilityLabel(store.privacy.isEnabled ? "封面已隐藏" : "\(store.displayTitle(for: game))的封面")
    }

    private var placeholder: some View {
        ZStack {
            LinearGradient(
                colors: [Color.tsumigeyaAccent.opacity(0.22), Color.tsumigeyaAccentSoft.opacity(0.08)],
                startPoint: .topLeading, endPoint: .bottomTrailing)
            Image(systemName: store.privacy.isEnabled ? "eye.slash" : "gamecontroller")
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(.secondary.opacity(0.5))
        }
    }
}
