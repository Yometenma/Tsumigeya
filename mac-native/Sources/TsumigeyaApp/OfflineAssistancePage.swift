import SwiftUI
import AppKit
import TsumigeyaCore

/// 「辅助」页里的离线改写块：只在引擎无法注入运行时时出现。
struct OfflineAssistanceView: View {
    @ObservedObject var session: OfflineSession
    @EnvironmentObject private var store: AppStore

    @State private var query = ""
    @State private var confirmApply = false

    private var running: Bool { store.runningGames[session.game.id] != nil }
    private var matches: [OfflineScriptEntry] {
        guard !query.isEmpty else { return session.scriptEntries }
        return session.scriptEntries.filter { $0.source.localizedCaseInsensitiveContains(query) }
    }
    private var visibleTexts: [RPG2000Text] {
        guard !query.isEmpty else { return session.databaseTexts }
        return session.databaseTexts.filter { $0.name.localizedCaseInsensitiveContains(query) || $0.description.localizedCaseInsensitiveContains(query) }
    }

    var body: some View {
        GroupBox(L("离线改写")) {
            VStack(alignment: .leading, spacing: 10) {
                Text(L("这个引擎没有可注入的脚本层，游戏内不会出现辅助面板；只能改文件。改动直接写入磁盘，游戏不需要运行。"))
                    .font(.caption).foregroundStyle(.secondary)
                if let error = session.error { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red).textSelection(.enabled) }
                if !session.message.isEmpty { Text(session.message).foregroundStyle(.secondary).textSelection(.enabled) }
                if let target = session.target {
                    Label(String(format: L("目标：%@"), "\(target.fileName)"), systemImage: "doc.text")
                    switch target {
                    case .nscripter:
                        TextField(L("搜索原文"), text: $query)
                        Text(String(format: L("匹配 %@ 条，显示前 100 条。"), "\(matches.count)")).font(.caption).foregroundStyle(.secondary)
                        ForEach(matches.prefix(100)) { entry in
                            HStack(alignment: .top) {
                                Text("\(entry.index)").font(.caption.monospacedDigit()).foregroundStyle(.secondary).frame(width: 44, alignment: .trailing)
                                Text(entry.source).textSelection(.enabled).lineLimit(2)
                            }
                        }
                        HStack {
                            Button(L("导出待译字典")) { exportDictionary() }
                            Button(L("导入译文并写回")) { confirmApply = true }.disabled(running)
                            Button(L("重新读取")) { session.reload() }.disabled(session.busy)
                        }
                        if running { Text(L("游戏正在运行，先退出再写回，避免改动被覆盖。")).foregroundStyle(.orange) }
                    case .rpg2000:
                        TextField(L("搜索名称或说明"), text: $query)
                        Text(String(format: L("匹配 %@ 条，显示前 100 条。"), "\(visibleTexts.count)")).font(.caption).foregroundStyle(.secondary)
                        ForEach(Array(visibleTexts.prefix(100).enumerated()), id: \.offset) { _, row in
                            VStack(alignment: .leading, spacing: 2) {
                                Text("\(row.label)　\(row.name)").textSelection(.enabled)
                                if !row.description.isEmpty { Text(row.description).font(.caption).foregroundStyle(.secondary).lineLimit(2) }
                            }
                        }
                        HStack {
                            Button(L("导出待译字典")) { exportDictionary() }
                            Button(L("重新读取")) { session.reload() }.disabled(session.busy)
                        }
                        Text(L("当前只读：写回需要重建整棵数据块树并逐层重算长度，尚未实现。")).font(.caption).foregroundStyle(.secondary)
                    }
                } else if session.error == nil {
                    ProgressView(L("读取目标……"))
                }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
        }
        .task(id: "\(store.dataDir)\0\(session.game.id)\0\(session.game.gamePath)") { session.reload() }
        .confirmationDialog(L("写回译文？"), isPresented: $confirmApply) {
            Button(L("选择字典并写回")) { importDictionary() }
        } message: {
            Text(L("脚本会被直接修改，同目录留一份 .tsumigeya-bak 备份。已有备份不会覆盖。"))
        }
    }

    private func exportDictionary() {
        guard let data = session.exportDictionary() else { return }
        let panel = NSSavePanel()
        panel.allowedContentTypes = [.json]
        panel.nameFieldStringValue = "offline-dictionary.json"
        if panel.runModal() == .OK, let url = panel.url {
            do { try data.write(to: url, options: .atomic) }
            catch let failure { session.error = failure.localizedDescription }
        }
    }

    private func importDictionary() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.json]
        panel.canChooseDirectories = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        do {
            let decoded = try JSONDecoder().decode([String: String].self, from: Data(contentsOf: url))
            session.apply(decoded.filter { !$0.value.isEmpty })
        } catch let failure {
            session.error = failure.localizedDescription
        }
    }
}
