import SwiftUI
import TsumigeyaCore

struct BatchMetadataView: View {
    @EnvironmentObject private var store: AppStore

    private var savedCount: Int { store.batchMetaItems.filter { $0.state == .saved }.count }
    private var failedCount: Int { store.batchMetaItems.filter { $0.state == .failed }.count }
    private var waitingCount: Int { store.batchMetaItems.filter { $0.state == .pending }.count }
    private var confirmationCount: Int { store.batchMetaItems.filter { $0.state == .needsConfirmation }.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text(L("批量补全作品信息")).font(.title2.bold())
                Spacer()
                Button(L("关闭")) { store.closeBatchMeta() }.keyboardShortcut(.cancelAction)
            }
            controls
            Text(L("范围为游戏库当前筛选结果。唯一编号会自动获取并保存；名称搜索只准备候选，必须逐项预览确认。已保存的结果不会因暂停或关闭而撤销。"))
                .font(.callout).foregroundStyle(.secondary)
            Text(String(format: L("已保存 %@ · 待确认 %@ · 失败 %@ · 等待 %@"), "\(savedCount)", "\(confirmationCount)", "\(failedCount)", "\(waitingCount)"))
                .font(.callout.monospacedDigit())
            if store.batchMetaRunning {
                HStack {
                    ProgressView().controlSize(.small)
                    Text(L("正在逐项处理，请求自动间隔至少 800 毫秒…")).font(.callout)
                }
            }
            itemList
            HStack {
                if store.batchMetaRunning {
                    Button(L("暂停任务")) { store.cancelBatchMeta() }
                } else {
                    Button(savedCount == 0 ? L("开始补全") : L("继续补全")) { store.startBatchMeta() }
                        .buttonStyle(.borderedProminent).disabled(waitingCount == 0)
                    Button(L("重试失败项")) { store.startBatchMeta(retryFailures: true) }
                        .disabled(failedCount == 0)
                }
                Spacer()
                Text(L("按作品类型自动归类并保留手动调整；不改游戏名称和存档。"))
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
        .padding(24)
        .frame(width: 800, height: 650)
        .onAppear {
            if store.batchMetaItems.isEmpty { store.prepareBatchMeta(refreshAssociated: store.batchMetaRefreshAssociated) }
        }
        .onDisappear { store.cancelBatchMeta() }
        .sheet(item: Binding(
            get: { store.manualRJFor.map(GameSheetTarget.init(id:)) },
            set: { if $0 == nil { store.closeManualRJ() } }
        )) { target in
            ManualRJSheet(gameId: target.id).environmentObject(store)
        }
    }

    private var controls: some View {
        HStack {
            Picker(L("处理方式"), selection: Binding(
                get: { store.batchMetaRefreshAssociated },
                set: { store.prepareBatchMeta(refreshAssociated: $0) }
            )) {
                Text(L("仅补全未关联游戏")).tag(false)
                Text(L("补全并刷新已有信息")).tag(true)
            }.pickerStyle(.menu).disabled(store.batchMetaRunning)
            Spacer()
            Button(L("重新准备列表")) { store.prepareBatchMeta(refreshAssociated: store.batchMetaRefreshAssociated) }
                .disabled(store.batchMetaRunning)
        }
    }

    private var itemList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 12) {
                if store.batchMetaItems.isEmpty {
                    Text(L("当前范围没有需要处理的游戏。可切换处理方式，或关闭后调整游戏库筛选。"))
                        .foregroundStyle(.secondary).padding(.vertical, 24)
                }
                ForEach(store.batchMetaItems) { item in
                    HStack(alignment: .top, spacing: 14) {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(store.displayTitle(for: item.game)).font(.headline)
                            Text(item.state.title)
                                .foregroundStyle(item.state == .failed ? Color.orange : Color.secondary)
                            if let message = item.message {
                                Text(message).font(.callout).foregroundStyle(.secondary).textSelection(.enabled)
                            }
                        }
                        Spacer(minLength: 8)
                        if item.state == .needsConfirmation || item.state == .failed {
                            Button(L("查找并确认")) { store.beginManualRJ(gameId: item.id) }
                                .fixedSize()
                                .disabled(store.batchMetaRunning || store.game(id: item.id) != item.game)
                        }
                    }.frame(maxWidth: .infinity, alignment: .leading)
                    Divider()
                }
            }.padding(12)
        }
        .background(.quaternary.opacity(0.25), in: RoundedRectangle(cornerRadius: 10))
    }
}
