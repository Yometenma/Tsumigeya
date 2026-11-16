import SwiftUI
import AppKit
import UniformTypeIdentifiers
import TsumigeyaCore

struct GameAssistanceView: View {
    let game: GameRecord
    @EnvironmentObject private var store: AppStore
    @State private var session: AssistanceSession?
    var body: some View {
        Group {
            if store.privacy.hidesTitles {
                Label("辅助功能已隐藏，关闭标题隐藏后可查看。", systemImage: "eye.slash")
            } else if let session { AssistanceContent(session: session) }
            else { ProgressView("读取辅助配置……") }
        }
        .task(id: "\(store.dataDir)\0\(game.id)\0\(game.gamePath)") { session = store.assistanceSession(for: game) }
    }
}

private struct AssistanceContent: View {
    @ObservedObject var session: AssistanceSession
    @EnvironmentObject private var store: AppStore
    private var running: Bool { store.runningGames[session.game.id] != nil }
    @State private var query = ""
    @State private var onlyMissing = false
    @State private var selected: TranslationEntry?
    @State private var draft = ""
    @State private var confirmTranslate = false
    @State private var followGame = false
    @State private var onlyFailures = false
    @State private var confirmRestore = false
    private var matches: [TranslationEntry] {
        (session.catalog?.entries ?? []).filter { entry in
            (!onlyMissing || entry.target.isEmpty) && (query.isEmpty || entry.source.localizedCaseInsensitiveContains(query) || entry.target.localizedCaseInsensitiveContains(query))
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            Text("翻译与作弊").font(.title2.bold())
            if let error = session.error { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red).textSelection(.enabled) }
            if !session.message.isEmpty { Text(session.message).foregroundStyle(.secondary).textSelection(.enabled) }
            if let project = session.project {
                Label("已识别 RPG Maker \(project.edition)", systemImage: "checkmark.circle")
                installation
                translation
                cheats
            }
        }
        .sheet(item: $selected) { entry in
            VStack(alignment: .leading, spacing: 14) {
                Text("修订译文").font(.title2.bold())
                Text(entry.source).textSelection(.enabled).frame(maxHeight: 150).padding().background(.quaternary)
                TextEditor(text: $draft).frame(minHeight: 130)
                Text("控制符和占位符必须原样保留。清空译文后会重新纳入待翻译范围。").font(.caption).foregroundStyle(.secondary)
                HStack { Button("取消") { selected = nil }; Spacer(); Button("保存修订") { session.edit(source: entry.source, target: draft); if session.error == nil { selected = nil } }.keyboardShortcut(.defaultAction) }
                if let error = session.error { Text(error).foregroundStyle(.red) }
            }.padding(24).frame(width: 620)
        }
        .confirmationDialog("开始自动翻译？", isPresented: $confirmTranslate) {
            Button("发送文本并开始翻译") { session.translate(onlyFailures: onlyFailures, followGame: followGame) }
        } message: { Text("待翻译游戏文本将发送到你填写的接口，可能产生费用。已完成的译文不会重复请求；可随时暂停。游戏文本仅作为数据处理，不执行其中的指令。") }
        .confirmationDialog("恢复游戏原始入口？", isPresented: $confirmRestore) {
            Button("恢复原始入口", role: .destructive) { session.restore() }
        } message: { Text("移除辅助加载入口和辅助文件，保留启动器中的译文。此操作不会撤销已写入存档的作弊修改。") }
    }
    private var installation: some View {
        GroupBox("游戏接入") {
            VStack(alignment: .leading, spacing: 12) {
                Toggle("启用游戏文字翻译", isOn: $session.options.translation)
                Toggle("启用游戏内作弊面板", isOn: $session.options.cheats)
                Text("两项独立启用。应用前需退出游戏；会备份原始页面，仅添加辅助加载入口，不替换 main.js。译文修订完成后也需重新应用。").font(.callout).foregroundStyle(.secondary)
                HStack {
                    Button("应用到游戏") { session.apply() }.buttonStyle(.borderedProminent)
                    if session.installed { Button("恢复原始入口") { confirmRestore = true } }
                    Button("重新读取配置") { session.reload() }
                }.disabled(running || session.busy)
                if running { Text("游戏正在运行，不能修改辅助安装。游戏内作弊仍可操作。").foregroundStyle(.orange) }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
        }
    }
    private var translation: some View {
        GroupBox("游戏翻译") {
            VStack(alignment: .leading, spacing: 14) {
                DisclosureGroup("翻译服务设置") {
                    VStack(alignment: .leading, spacing: 10) {
                        TextField("兼容聊天补全接口的完整地址", text: $session.service.endpoint)
                            .onChange(of: session.service.endpoint) { _, _ in session.endpointChanged() }
                        Text("填写完整请求地址，不自动拼接路径。远程服务必须使用 HTTPS；本机服务允许 HTTP。").font(.caption).foregroundStyle(.secondary)
                        TextField("模型名称", text: $session.service.model)
                        TextField("目标语言", text: $session.service.targetLanguage)
                        SecureField("接口密钥（本机免密服务可留空）", text: $session.key)
                        Button("保存接口与密钥") { session.saveService() }
                        Text("密钥保存在系统钥匙串，不写进游戏。接口设置供所有游戏共用；开始翻译前会提示数据发送与费用。").font(.caption).foregroundStyle(.secondary)
                    }.padding(.vertical, 8).disabled(session.busy)
                }
                HStack {
                    Button("提取游戏文本") { session.extract() }
                    Button("导入译文") { importFile() }
                    Button("导出译文") { exportFile() }.disabled((session.catalog?.completed ?? 0) == 0)
                }.disabled(session.busy)
                Text("导入支持原文→译文的 JSON 字典（包括采用此结构的 MTool 译文）；不把所有 JSON 文件都视作兼容。提取只读取文字字段，不修改原始数据库。").font(.caption).foregroundStyle(.secondary)
                HStack {
                    if session.busy { ProgressView().controlSize(.small); Button("暂停") { session.pause() } }
                    else {
                        Button("翻译未完成条目／继续") { followGame = false; onlyFailures = false; confirmTranslate = true }.disabled((session.catalog?.entries.isEmpty ?? true))
                        Button("跟随游戏补译") { followGame = true; onlyFailures = false; confirmTranslate = true }.disabled(!session.installed || !session.options.translation)
                        Button("仅重试失败条目") { followGame = false; onlyFailures = true; confirmTranslate = true }.disabled(!(session.catalog?.entries.contains { $0.failure != nil } ?? false))
                    }
                }
                Text("跟随补译会读取游戏捕获的新文本并更新译文缓存，需要启动器保持开启。关闭或暂停后，游戏继续使用已有译文和原文，不阻止游玩。").font(.caption).foregroundStyle(.secondary)
                let completed = session.catalog?.completed ?? 0
                let total = session.catalog?.entries.count ?? 0
                ProgressView(value: Double(completed), total: Double(max(total, 1)))
                Text("共 \(total) 条，已翻译 \(completed) 条；未命中译文时显示原文。已翻译的游戏无需保持联网或保持启动器开启。").font(.callout).foregroundStyle(.secondary)
                TextField("搜索原文或译文", text: $query)
                Toggle("只看未完成条目", isOn: $onlyMissing)
                Text("匹配 \(matches.count) 条，显示前 100 条；搜索可缩小范围。").font(.caption).foregroundStyle(.secondary)
                ForEach(Array(matches.prefix(100))) { entry in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(entry.source).lineLimit(3).textSelection(.enabled)
                        Text(entry.target.isEmpty ? "尚未翻译" : entry.target).foregroundStyle(.secondary).lineLimit(3).textSelection(.enabled)
                        if let failure = entry.failure { Text(failure).font(.caption).foregroundStyle(.red) }
                        HStack { Text(entry.contexts.prefix(2).joined(separator: "；")).font(.caption).foregroundStyle(.secondary); Spacer(); Button("修订") { draft = entry.target; selected = entry }.disabled(session.busy) }
                    }.padding(.vertical, 6)
                    Divider()
                }
            }.padding(8)
        }
    }
    private var cheats: some View {
        GroupBox("作弊工具") {
            VStack(alignment: .leading, spacing: 10) {
                Text("启用后启动游戏，在游戏右上角点击「游戏辅助」或按 ⇧F8。进入游戏或读档后可操作，不需要启动器保持开启。")
                Text("• 金钱、物品、防具、武器、角色属性和恢复\n• 变量／开关搜索与编辑、持续锁定与解除\n• 已知／未知数值查找，按增加、减少、改变和未改变逐次筛选\n• 游戏／移动速度、随机遇敌控制、穿墙\n• 地图搜索与坐标传送、地图事件和公共事件查看及执行")
                Label("作弊修改可能写入存档；移除辅助功能不能撤销。地图传送和事件执行可能破坏剧情，请先备份存档。", systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                Text("数值搜索针对引擎公开的变量与角色状态，不是任意进程内存扫描。游戏自定义插件可能改变这些行为，不能保证所有作品完全兼容。").font(.caption).foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
        }
    }
    private func importFile() {
        let panel = NSOpenPanel(); panel.allowedContentTypes = [.json]; panel.canChooseDirectories = false
        if panel.runModal() == .OK, let url = panel.url { session.importFile(url) }
    }
    private func exportFile() {
        let panel = NSSavePanel(); panel.allowedContentTypes = [.json]; panel.nameFieldStringValue = "translations.json"
        if panel.runModal() == .OK, let url = panel.url { session.exportFile(url) }
    }
}
