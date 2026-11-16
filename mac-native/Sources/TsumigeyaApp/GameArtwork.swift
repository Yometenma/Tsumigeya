import SwiftUI
import TsumigeyaCore

/// 只展示作品元数据中的封面；不从游戏目录猜测图片，避免把素材误当封面。
struct GameArtwork: View {
    let game: GameRecord
    @EnvironmentObject private var store: AppStore

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                placeholder
                // 隐私模式移除图片子树；晚到的下载结果不能重新显示原图。
                if let url = store.artworkURL(for: game) {
                    AsyncImage(url: url) { phase in
                        if case .success(let image) = phase {
                            image.resizable().scaledToFit()
                        }
                    }
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
                colors: [.indigo.opacity(0.22), .purple.opacity(0.08)],
                startPoint: .topLeading, endPoint: .bottomTrailing)
            Image(systemName: store.privacy.isEnabled ? "eye.slash" : "gamecontroller")
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(.secondary.opacity(0.5))
        }
    }
}
