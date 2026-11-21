import SwiftUI
import TsumigeyaCore

/// 只展示 DLsite 资料中的封面或预览图；不从游戏目录猜测图片，避免把素材误当作品图。
struct GameArtwork: View {
    let game: GameRecord
    var contentMode: ContentMode = .fit
    var preferPreview = false
    @EnvironmentObject private var store: AppStore

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                placeholder
                if let url = store.artworkURL(for: game, preferPreview: preferPreview) {
                    CachedRemoteImage(url: url, contentMode: contentMode, external: store.meta(for: game.id)?.work.isExternal == true, retryLabel: L("重试封面"), maxPixelSize: preferPreview ? 2048 : 96).id(url)
                }
            }
            .frame(width: geometry.size.width, height: geometry.size.height)
            .clipped()
        }
        .accessibilityLabel(String(format: L("%@的封面"), "\(store.displayTitle(for: game))"))
    }

    private var placeholder: some View {
        ZStack {
            LinearGradient(
                colors: [Color.tsumigeyaAccent.opacity(0.22), Color.tsumigeyaAccentSoft.opacity(0.08)],
                startPoint: .topLeading, endPoint: .bottomTrailing)
            Image(systemName: "gamecontroller")
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(.secondary.opacity(0.5))
        }
    }
}
