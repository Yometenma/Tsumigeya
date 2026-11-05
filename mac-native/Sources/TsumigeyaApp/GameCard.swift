// 游戏卡片与列表行。
//
// 对应 Electron 版：`components/GameCard.vue`（283 行）
//
// ===== ⚠️ 封面图这件事先说清楚 =====
//
// Electron 版有海报墙（DLsite 封面）。但 **P4 阶段还没有 DLsite 集成**（那是 P7）。
// 所以现在卡片上的「封面」位是**占位图**（按引擎配色 + 游戏名首字）。
//
// ⚠️ **本鱼不伪造封面**：不做「从游戏目录里随便挖一张图片当封面」那种事
// —— 那会挖到游戏素材（可能是 R18 内容或无关图），而用户会以为那是封面。
// 没有封面就显示占位，等 P7 真接上 DLsite。
import SwiftUI
import TsumigeyaCore

// MARK: - 卡片

struct GameCard: View {
    let game: GameRecord
    let isRunning: Bool
    let onSelect: () -> Void

    /// 悬停高亮。
    ///
    /// ⚠️ mac 的悬停反馈很重要：没有 hover 的卡片看起来是「死的」，
    ///    用户不知道能不能点。这是 mac 的交互惯例。
    @State private var isHovering = false

    var body: some View {
        Button(action: onSelect) {
            VStack(alignment: .leading, spacing: 0) {
                cover
                info
            }
        }
        .buttonStyle(.plain)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color(nsColor: .controlBackgroundColor))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(isHovering ? Color.accentColor.opacity(0.5) : Color.clear,
                              lineWidth: 1.5)
        )
        .onHover { isHovering = $0 }
        // ⚠️ 悬停高亮用动画而不是瞬变：瞬间变会让鼠标划过时闪一下（mac 的观感是柔和）
        .animation(.easeOut(duration: 0.15), value: isHovering)
        .help("\(game.gameTitle)\n\(game.gamePath)")
    }

    // MARK: 封面位

    private var cover: some View {
        ZStack {
            // 占位底色：按引擎给不同色调（让用户扫一眼就知道「这堆是 mv、那几个是 ace」）
            Rectangle()
                .fill(engineTint.opacity(0.18))

            VStack(spacing: 6) {
                Image(systemName: "photo")
                    .font(.system(size: 26))
                    .foregroundStyle(engineTint.opacity(0.55))
                Text(engineLabel)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(engineTint)
            }
        }
        // 4:3 横版（D39：DLsite 源图是横向，2:3 会裁掉 40%）
        .aspectRatio(4.0 / 3.0, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .clipShape(UnevenRoundedRectangle(
            topLeadingRadius: 10, bottomLeadingRadius: 0,
            bottomTrailingRadius: 0, topTrailingRadius: 10))
        .overlay(alignment: .topTrailing) {
            if isRunning {
                runningBadge.padding(8)
            }
        }
    }

    /// 「运行中」徽标。
    ///
    /// ⚠️ 与「已安装引擎」是两件事：**这是游戏进程在跑**（D50 的内存状态）。
    private var runningBadge: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(.green)
                .frame(width: 7, height: 7)
            Text("运行中")
                .font(.caption2.weight(.medium))
                .foregroundStyle(.white)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(.black.opacity(0.55), in: Capsule())
    }

    // MARK: 信息

    private var info: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(game.gameTitle)
                // ⚠️ 两行截断：日文游戏名可以很长（「～馬蹄通りの小聖女～」那种），
                //    不截断会把卡片撑得很高，网格参差不齐。
                .font(.system(size: 13, weight: .medium))
                .lineLimit(2)
                .truncationMode(.tail)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)

            Text(engineLabel)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
    }

    // MARK: 引擎显示

    /// 引擎的人话名（`mkxpz` → `mkxp-z`）。
    private var engineLabel: String {
        EngineRegistry.find(folder: game.gameEngine)?.name ?? game.gameEngine
    }

    /// 引擎配色。
    ///
    /// ⚠️ **不用随机色**：同一个引擎必须永远是同一个色，
    ///    否则每次刷新卡片颜色都变，用户会以为「游戏换了」。
    private var engineTint: Color {
        switch game.gameEngine {
        case "nwjs": return .blue
        case "mkxpz": return .orange
        case "easyrpg": return .green
        case "renpy": return .pink
        case "tyrano": return .purple
        case "kirikiri": return .teal
        case "nscripter": return .indigo
        case "siglus": return .brown
        case "godot": return .cyan
        default: return .gray
        }
    }
}

// MARK: - 列表行

struct GameRow: View {
    let game: GameRecord
    let isRunning: Bool
    let onSelect: () -> Void

    @State private var isHovering = false

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 10) {
                Image(systemName: "gamecontroller.fill")
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .frame(width: 18)

                VStack(alignment: .leading, spacing: 1) {
                    Text(game.gameTitle)
                        .font(.system(size: 13))
                        .lineLimit(1)
                    Text(game.gamePath)
                        .font(.system(size: 11))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }

                Spacer()

                if isRunning {
                    HStack(spacing: 4) {
                        Circle().fill(.green).frame(width: 6, height: 6)
                        Text("运行中").font(.caption2)
                    }
                    .foregroundStyle(.secondary)
                }

                Text(engineLabel)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 2)
                    .background(Color(nsColor: .quaternaryLabelColor).opacity(0.12), in: Capsule())
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(isHovering ? Color.accentColor.opacity(0.10) : Color.clear)
        )
        .onHover { isHovering = $0 }
        .animation(.easeOut(duration: 0.12), value: isHovering)
    }

    private var engineLabel: String {
        EngineRegistry.find(folder: game.gameEngine)?.name ?? game.gameEngine
    }
}
