import SwiftUI
import TsumigeyaCore

/// 分类立即保存，不加入编辑表单的暂存草稿。
struct GameClassificationEditor: View {
    let gameID: String
    @EnvironmentObject private var store: AppStore
    @State private var confirmsRestore = false

    var body: some View {
        Group {
            Text(L("按已保存的作品类型自动归类；手动勾选或移除会保留，不受资料刷新影响。题材标签不参与主分类。"))
                .font(.caption)
                .foregroundStyle(.secondary)
            if store.categories.isEmpty {
                Text(L("暂无分类。保存作品资料后可自动归类，也可以在游戏库中新建分类。"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Categories.ordered(store.categories), id: \.id) { pair in
                    Toggle(pair.def.sourceWorkType == nil ? pair.def.name : pair.def.name + L("（作品类型）"), isOn: Binding(
                        get: { (store.assignments[gameID] ?? []).contains(pair.id) },
                        set: { store.setCategoryMembership(gameId: gameID, categoryId: pair.id, member: $0) }
                    ))
                }
            }
            Button(L("恢复自动分类")) { confirmsRestore = true }
                .disabled(!store.library.manualClassificationGameIDs.contains(gameID))
                .alert(L("恢复自动分类？"), isPresented: $confirmsRestore) {
                    Button(L("恢复自动分类"), role: .destructive) { store.restoreAutomaticClassification(gameId: gameID) }
                    Button(L("取消"), role: .cancel) {}
                } message: {
                    Text(L("将清除这个游戏的手动分类调整，按已保存的作品类型重新归类。已删除的分类不会恢复。此操作立刻保存。"))
                }
            if let error = store.operationError {
                Text(error).font(.caption).foregroundStyle(.red)
            }
        }
    }
}
