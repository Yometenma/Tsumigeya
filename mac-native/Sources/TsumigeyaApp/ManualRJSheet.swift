// 手动输入 RJ 号的弹窗。
//
// ⚠️ 为什么需要它（本鱼实测发现的关键缺口）：
//
//   用户的 5 个真实游戏**全部检测不到 RJ**：
//     · 目录名不带 RJ
//     · KARRYN'S PRISON / 苍蓝星 连 readme 都没有
//     · Unholy maiden 的 readme 里也没有 RJ 号
//
//   → 没有手动入口的话，P7 对这个用户完全没用。
//
// ⚠️ 而**不能自动去搜**（D24）：搜索绝不自动选第一条
//   （实测首条常不是目标作品），自动选错了就是拿错的封面。
import SwiftUI
import TsumigeyaCore

struct ManualRJSheet: View {
    @EnvironmentObject private var store: AppStore
    let gameId: String
    @State private var text = ""
    @State private var errorMessage: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("输入 RJ 号")
                .font(.title3.weight(.semibold))

            TextField("RJ294126", text: $text)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 14, design: .monospaced))
                .focused($focused)
                .onSubmit { fetch() }

            if let errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
            } else {
                Text("从 DLsite 的作品页地址里能找到（如 product_id/RJ294126.html）。")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }

            HStack {
                Spacer()
                Button("取消") {
                    store.closeManualRJ()
                }
                .keyboardShortcut(.cancelAction)

                Button("获取") {
                    fetch()
                }
                .buttonStyle(.borderedProminent)
                .keyboardShortcut(.defaultAction)
                .disabled(text.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 380)
        .onAppear { focused = true }
    }

    private func fetch() {
        errorMessage = nil
        // ⚠️ 判据来自 `RJNumber.normalize`（纯函数，有单测），不在这里重写。
        //    用户可能输 `294126` / `rj294126` / `RJ-294126` —— 都接受。
        guard let rj = RJNumber.normalize(text) else {
            errorMessage = "不是有效的 RJ 号（应该是 6~8 位数字，可带 RJ 前缀）"
            return
        }
        store.closeManualRJ()
        store.fetchMeta(gameId: gameId, rj: rj)
    }
}
