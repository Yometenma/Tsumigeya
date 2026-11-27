import SwiftUI
import AppKit
import UniformTypeIdentifiers
import TsumigeyaCore

struct GameAssistanceView: View {
    enum Mode { case all, translation, assistance }

    let game: GameRecord
    let mode: Mode
    @EnvironmentObject private var store: AppStore

    init(game: GameRecord, mode: Mode = .all) {
        self.game = game
        self.mode = mode
    }
    @State private var session: AssistanceSession?
    @State private var offline: OfflineSession?
    var body: some View {
        Group {
            if let offline, mode == .assistance {
                // 这个引擎注入不了运行时，只给文件改写入口。
                ScrollView { OfflineAssistanceView(session: offline).padding(22) }
            } else if let session { AssistanceContent(session: session, mode: mode) }
            else { ProgressView(L("读取辅助配置……")) }
        }
        .task(id: "\(store.dataDir)\0\(game.id)\0\(game.gamePath)") {
            guard OfflineTarget.supports(game.gameEngine) else {
                offline = nil; session = store.assistanceSession(for: game); return
            }
            session = nil
            offline = store.offlineSession(for: game)
        }
    }
}

private struct AssistanceContent: View {
    @ObservedObject var session: AssistanceSession
    let mode: GameAssistanceView.Mode
    @EnvironmentObject private var store: AppStore
    private var running: Bool { store.runningGames[session.game.id] != nil }
    private var restoreTitle: String { session.project?.usesFileBridge == true ? L("移除辅助功能") : L("恢复原始入口") }
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
            Text(title).font(.title2.bold())
            if let error = session.error { Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(.red).textSelection(.enabled) }
            if !session.message.isEmpty { Text(session.message).foregroundStyle(.secondary).textSelection(.enabled) }
            if let project = session.project {
                Label(String(format: L("已识别 %@"), "\(project.displayName)"), systemImage: "checkmark.circle")
                Text(L("已接入内置辅助模块，翻译与作弊分别启用；具体兼容范围以模块说明和作品实测为准。")).font(.caption).foregroundStyle(.secondary)
                installation
                if project.module.translation != nil && mode != .assistance { translation }
                if project.module.cheats != nil && mode != .translation { cheats }
            }
        }
        .sheet(item: $selected) { entry in
            VStack(alignment: .leading, spacing: 14) {
                Text(L("修订译文")).font(.title2.bold())
                Text(entry.source).textSelection(.enabled).frame(maxHeight: 150).padding().background(.quaternary)
                TextEditor(text: $draft).frame(minHeight: 130)
                Text(L("控制符和占位符必须原样保留。清空译文后会重新纳入待翻译范围。")).font(.caption).foregroundStyle(.secondary)
                HStack { Button(L("取消")) { selected = nil }; Spacer(); Button(L("保存修订")) { session.edit(source: entry.source, target: draft); if session.error == nil { selected = nil } }.keyboardShortcut(.defaultAction) }
                if let error = session.error { Text(error).foregroundStyle(.red) }
            }.padding(24).frame(width: 620)
        }
        .confirmationDialog(L("开始自动翻译？"), isPresented: $confirmTranslate) {
            Button(L("发送文本并开始翻译")) { session.translate(onlyFailures: onlyFailures, followGame: followGame) }
        } message: { Text(L("待翻译游戏文本将发送到你填写的接口，可能产生费用。已完成的译文不会重复请求；可随时暂停。游戏文本仅作为数据处理，不执行其中的指令。")) }
        .confirmationDialog(String(format: L("确认%@？"), "\(restoreTitle)"), isPresented: $confirmRestore) {
            Button(restoreTitle, role: .destructive) { session.restore() }
        } message: { Text(L("移除辅助入口和辅助文件，保留启动器中的译文，不修改原始剧本或数据库。此操作不会撤销已写入存档的作弊修改。")) }
    }
    private var title: String {
        switch mode {
        case .all: return L("翻译与辅助")
        case .translation: return L("翻译")
        case .assistance: return L("辅助")
        }
    }

    private var installation: some View {
        GroupBox(L("游戏接入")) {
            VStack(alignment: .leading, spacing: 12) {
                if mode != .assistance, session.project?.module.translation != nil { Toggle(L("启用游戏文字翻译"), isOn: $session.options.translation) }
                if mode != .translation, session.project?.module.cheats != nil { Toggle(session.project?.usesFileBridge == true ? L("启用游戏状态编辑") : L("启用游戏内作弊面板"), isOn: $session.options.cheats) }
                Text(session.project?.module.installationNote ?? "").font(.callout).foregroundStyle(.secondary)
                HStack {
                    Button(L("应用到游戏")) { session.apply() }.buttonStyle(.borderedProminent)
                    if session.installed { Button(restoreTitle) { confirmRestore = true } }
                    Button(L("重新读取配置")) { session.reload() }
                }.disabled(running || session.busy)
                if running { Text(L("游戏正在运行，不能修改辅助安装；已启用的作弊工具仍可操作。")).foregroundStyle(.orange) }
            }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
        }
    }
    private var translation: some View {
        GroupBox(L("游戏翻译")) {
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Picker(L("译文字号"), selection: $session.options.fontScale) {
                        Text(L("标准（1.0）")).tag(1.0)
                        Text(L("略小（0.94）")).tag(0.94)
                        Text(L("推荐（0.92）")).tag(0.92)
                        Text(L("更小（0.88）")).tag(0.88)
                    }.pickerStyle(.menu).frame(maxWidth: 220)
                    Text(L("按中文行高补偿游戏字号；改动需重新「应用到游戏」。")).font(.caption).foregroundStyle(.secondary)
                }
                DisclosureGroup(L("翻译服务设置")) {
                    VStack(alignment: .leading, spacing: 10) {
                        TextField(L("兼容聊天补全接口的完整地址"), text: $session.service.endpoint)
                            .onChange(of: session.service.endpoint) { _, _ in session.endpointChanged() }
                        Text(L("填写完整请求地址，不自动拼接路径。远程服务必须使用 HTTPS；本机服务允许 HTTP。")).font(.caption).foregroundStyle(.secondary)
                        TextField(L("模型名称"), text: $session.service.model)
                        TextField(L("目标语言"), text: $session.service.targetLanguage)
                        SecureField(L("接口密钥（本机免密服务可留空）"), text: $session.key)
                        Button(L("保存接口与密钥")) { session.saveService() }
                        Text(L("密钥保存在系统钥匙串，不写进游戏。接口设置供所有游戏共用；开始翻译前会提示数据发送与费用。")).font(.caption).foregroundStyle(.secondary)
                    }.padding(.vertical, 8).disabled(session.busy)
                }
                HStack {
                    Button(L("提取游戏文本")) { session.extract() }
                    Button(L("导入译文")) { importFile() }
                    Button(L("导出译文")) { exportFile() }.disabled((session.catalog?.completed ?? 0) == 0)
                }.disabled(session.busy)
                Text(L("导入支持原文→译文的 JSON 字典（包括采用此结构的 MTool 译文）；不把所有 JSON 文件都视作兼容。提取只读取文字字段，不修改原始数据库。")).font(.caption).foregroundStyle(.secondary)
                HStack {
                    if session.busy { ProgressView().controlSize(.small); Button(L("暂停")) { session.pause() } }
                    else {
                        Button(L("翻译未完成条目／继续")) { followGame = false; onlyFailures = false; confirmTranslate = true }.disabled((session.catalog?.entries.isEmpty ?? true))
                        Button(L("跟随游戏补译")) { followGame = true; onlyFailures = false; confirmTranslate = true }.disabled(!session.installed || !session.options.translation)
                        Button(L("仅重试失败条目")) { followGame = false; onlyFailures = true; confirmTranslate = true }.disabled(!(session.catalog?.entries.contains { $0.failure != nil } ?? false))
                    }
                }
                Text(L("跟随补译会读取游戏捕获的新文本并更新译文缓存，需要启动器保持开启。关闭或暂停后，游戏继续使用已有译文和原文，不阻止游玩。")).font(.caption).foregroundStyle(.secondary)
                let completed = session.catalog?.completed ?? 0
                let total = session.catalog?.entries.count ?? 0
                ProgressView(value: Double(completed), total: Double(max(total, 1)))
                Text(String(format: L("共 %@ 条，已翻译 %@ 条；未命中译文时显示原文。已翻译的游戏无需保持联网或保持启动器开启。"), "\(total)", "\(completed)")).font(.callout).foregroundStyle(.secondary)
                TextField(L("搜索原文或译文"), text: $query)
                Toggle(L("只看未完成条目"), isOn: $onlyMissing)
                Text(String(format: L("匹配 %@ 条，显示前 100 条；搜索可缩小范围。"), "\(matches.count)")).font(.caption).foregroundStyle(.secondary)
                ForEach(Array(matches.prefix(100))) { entry in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(entry.source).lineLimit(3).textSelection(.enabled)
                        Text(entry.target.isEmpty ? L("尚未翻译") : entry.target).foregroundStyle(.secondary).lineLimit(3).textSelection(.enabled)
                        if let failure = entry.failure { Text(failure).font(.caption).foregroundStyle(.red) }
                        HStack { Text(entry.contexts.prefix(2).joined(separator: "；")).font(.caption).foregroundStyle(.secondary); Spacer(); Button(L("修订")) { draft = entry.target; selected = entry }.disabled(session.busy) }
                    }.padding(.vertical, 6)
                    Divider()
                }
            }.padding(8)
        }
    }
    private var cheats: some View {
        GroupBox(L("作弊工具")) {
            VStack(alignment: .leading, spacing: 10) {
                if session.project?.usesFileBridge == true {
                    LiveAssistanceView(session: session)
                } else {
                    Text(session.project?.module.cheatInstructions ?? "")
                }
                Label(L("作弊修改可能写入存档并破坏剧情；移除辅助功能不能撤销，请先备份存档。"), systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                Text(L("数值搜索针对引擎公开的变量与角色状态，不是任意进程内存扫描。游戏自定义插件可能改变这些行为，不能保证所有作品完全兼容。")).font(.caption).foregroundStyle(.secondary)
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
