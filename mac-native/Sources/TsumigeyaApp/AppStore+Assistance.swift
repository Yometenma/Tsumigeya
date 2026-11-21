import AppKit
import Security
import SwiftUI
import TsumigeyaCore

@MainActor
final class AssistanceSession: ObservableObject {
    let game: GameRecord
    let dataDirectory: String
    weak var store: AppStore?
    @Published var project: RPGMakerProject?
    @Published var catalog: TranslationCatalog?
    @Published var options = AssistanceOptions()
    @Published var service = TranslationServiceSettings()
    @Published var key = ""
    @Published var installed = false
    @Published var busy = false
    @Published var message = ""
    @Published var error: String?
    @Published var liveState: AssistanceSnapshot?
    @Published var liveMessage = L("请应用辅助后通过启动器进入游戏。")
    @Published var pendingCommand: String?
    private var sentAt: Date?

    private var task: Task<Void, Never>?
    private var valid = true
    private var serviceRaw: [String: JSONValue] = [:]

    init(game: GameRecord, store: AppStore) { self.game = game; self.store = store; dataDirectory = store.dataDir; reload() }
    var running: Bool { store?.runningGames[game.id] != nil }
    var isCurrent: Bool {
        valid && store?.dataDir == dataDirectory && store?.game(id: game.id)?.gamePath == game.gamePath && store?.game(id: game.id)?.gameEngine == game.gameEngine && store?.assistanceSessions[game.id] === self
    }
    func invalidate() { liveState = nil; pendingCommand = nil; valid = false; task?.cancel(); task = nil; busy = false }
    private func operation(_ body: () throws -> Void) { error = nil; do { try body() } catch { self.error = error.localizedDescription } }
    func reload() {
        guard !busy else { return }
        project = nil; catalog = nil
        operation {
            guard ["nwjs", "mkxpz", "renpy", "tyrano"].contains(game.gameEngine) else { throw AssistanceError.invalid(L("当前引擎尚未接入翻译与作弊；可启动不代表可修改游戏状态。")) }
            let project = try RPGMakerProject.detect(folder: DetectPath.gameDirForFiles(game.gamePath))
            let loaded = try TranslationFiles.load(project: project, dataDir: store?.dataDir ?? "")
            let installedOptions = try AssistanceInstaller.options(project)
            self.project = project; catalog = loaded
            if let options = installedOptions { self.options = options; installed = true }
            else { installed = false; options = .init() }
            let url = serviceURL
            if FileManager.default.fileExists(atPath: url.path) {
                serviceRaw = try JSONDecoder().decode([String: JSONValue].self, from: Data(contentsOf: url))
                service.endpoint = serviceRaw["endpoint"]?.stringValue ?? ""
                service.model = serviceRaw["model"]?.stringValue ?? ""
                service.targetLanguage = serviceRaw["targetLanguage"]?.stringValue ?? L("简体中文")
            }
            key = try TranslationCredential.read(account: service.endpoint)
        }
    }
    func refreshLive() {
        guard isCurrent, let project, project.usesFileBridge, installed, options.cheats else { liveState = nil; pendingCommand = nil; return }
        do {
            let snapshot = try AssistanceBridge.read(project)
            liveState = snapshot
            if let pendingCommand, snapshot.ack == pendingCommand {
                self.pendingCommand = nil
                liveMessage = snapshot.error ?? L("游戏已确认操作。")
            } else if pendingCommand != nil, let sentAt, Date.now.timeIntervalSince(sentAt) > 6 {
                pendingCommand = nil; liveMessage = L("游戏未确认操作，请刷新数值后核对，勿直接重复修改。")
            } else if pendingCommand == nil { liveMessage = snapshot.ready ? (snapshot.error ?? L("已连接当前游戏。")) : L("请先进入游戏或读取存档。") }
        } catch {
            liveState = nil; liveMessage = error.localizedDescription
            if pendingCommand != nil, let sentAt, Date.now.timeIntervalSince(sentAt) > 6 {
                pendingCommand = nil
                liveMessage = L("连接已中断，无法确认刚才的操作；重连后请先核对数值。")
            }
        }
    }
    func sendLive(action: String, key: String, value: String) {
        guard isCurrent, let project, let liveState, pendingCommand == nil else { return }
        do {
            let parsed = action == "reset" || action == "unlock" ? JSONValue.null : try JSONDecoder().decode(JSONValue.self, from: Data(value.utf8))
            pendingCommand = try AssistanceBridge.send(project, snapshot: liveState, action: action, key: key, value: parsed)
            sentAt = .now; liveMessage = L("等待游戏确认……")
        } catch { liveMessage = error.localizedDescription }
    }
    private var serviceURL: URL { URL(fileURLWithPath: store?.dataDir ?? "").appendingPathComponent("translation-service.json") }
    func endpointChanged() {
        key = ""
        do { key = try TranslationCredential.read(account: service.endpoint) }
        catch { self.error = error.localizedDescription }
    }
    func saveService() {
        operation {
            guard isCurrent, service.url != nil, !service.model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                  !service.targetLanguage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw AssistanceError.invalid(L("请填写完整接口地址、模型和目标语言；只允许 HTTPS 或本机 HTTP。")) }
            let url = serviceURL
            if FileManager.default.fileExists(atPath: url.path) { serviceRaw = try JSONDecoder().decode([String: JSONValue].self, from: Data(contentsOf: url)) }
            serviceRaw["endpoint"] = .string(service.endpoint); serviceRaw["model"] = .string(service.model)
            serviceRaw["targetLanguage"] = .string(service.targetLanguage)
            try TranslationCredential.save(key, account: service.endpoint)
            if let error = JSONStore.save(serviceRaw, to: url) { throw AssistanceError.invalid(String(format: L("密钥已保存在钥匙串，但接口设置未保存：%@"), "\(error)")) }
            message = L("翻译接口已保存；密钥只存放在系统钥匙串。")
        }
    }
    func extract() {
        guard !busy, let project else { return }
        busy = true; error = nil; message = L("正在提取对话、选项和数据库文字……")
        task = Task { [weak self] in
            do {
                let entries = try await Task.detached(priority: .userInitiated) { try AssistanceModules.extract(project) }.value
                guard let self, self.isCurrent, !Task.isCancelled else { self?.busy = false; return }
                var next = self.catalog ?? TranslationCatalog(identity: project.identity)
                next.merge(entries); try self.persist(next)
                self.message = String(format: L("已提取并保存 %@ 条去重文本；已有译文和手动修订均保留。"), "\(entries.count)")
            } catch { if let self, self.isCurrent { self.error = error.localizedDescription } }
            self?.busy = false
        }
    }
    private func persist(_ next: TranslationCatalog) throws {
        guard isCurrent, let store, let project else { throw AssistanceError.invalid(L("游戏已移除或路径已改变，已停止写入。")) }
        let gameURL = URL(fileURLWithPath: store.dataDir).appendingPathComponent("games.json")
        guard case .loaded(let map) = JSONStore.load(GameMap.self, from: gameURL, quarantineCorrupt: false),
              map.games[game.id]?.gamePath == game.gamePath, map.games[game.id]?.gameEngine == game.gameEngine else {
            throw AssistanceError.invalid(L("磁盘上的游戏记录已改变，已停止保存译文。"))
        }
        try TranslationFiles.save(next, project: project, dataDir: store.dataDir)
        catalog = next
    }
    func importFile(_ url: URL) {
        guard !busy else { return }
        operation {
            guard let project else { return }
            let entries = try TranslationFiles.imported(Data(contentsOf: url))
            var next = catalog ?? .init(identity: project.identity); next.merge(entries)
            try persist(next); message = String(format: L("已导入 %@ 条译文。关闭游戏后点击「应用到游戏」生效。"), "\(entries.count)")
        }
    }
    func exportFile(_ url: URL) {
        operation { guard let catalog else { return }; try JSONStore.defaultEncoder.encode(catalog.dictionary).write(to: url, options: .atomic); message = L("译文字典已导出。") }
    }
    func edit(source: String, target: String) {
        operation {
            guard !busy, var next = catalog, let i = next.entries.firstIndex(where: { $0.source == source }) else { return }
            if !target.isEmpty { try TranslationTokens.validate(source: source, target: target) }
            next.entries[i].target = target; next.entries[i].failure = nil
            try persist(next); message = L("修订已保存。点击「应用到游戏」更新游戏中的译文。")
        }
    }
    func pause() { task?.cancel(); message = L("正在暂停；已保存的译文会保留。") }
    func translate(onlyFailures: Bool = false, followGame: Bool = false) {
        guard !busy, let catalog, (!catalog.entries.isEmpty || followGame) else { return }
        guard service.url != nil, !service.model.isEmpty,
              serviceRaw["endpoint"]?.stringValue == service.endpoint,
              serviceRaw["model"]?.stringValue == service.model,
              serviceRaw["targetLanguage"]?.stringValue == service.targetLanguage else { error = L("请先保存翻译接口；更改服务地址后需重新核对密钥。"); return }
        if followGame && (!installed || !options.translation) { error = L("请先启用文字翻译并应用到游戏。"); return }
        let service = TranslationService(settings: service, key: key)
        let translateText = store?.translateAssistanceText ?? { service, source in try await service.translate(source) }
        var pending = catalog.entries.filter { $0.target.isEmpty && (!onlyFailures || $0.failure != nil) }.map(\.source)
        guard !pending.isEmpty || followGame else { message = L("没有需要翻译的条目。"); return }
        busy = true; error = nil
        task = Task { [weak self] in
            var position = 0
            var attempted = Set<String>()
            while !Task.isCancelled {
                guard let self, self.isCurrent else { break }
                if position >= pending.count {
                    guard followGame, let project = self.project else { break }
                    do {
                        let captured = try AssistanceInstaller.capturedText(project)
                        var next = self.catalog ?? TranslationCatalog(identity: project.identity)
                        let count = next.entries.count; next.merge(captured)
                        if count != next.entries.count { try self.persist(next) }
                        pending = next.entries.filter { $0.target.isEmpty && !attempted.contains($0.source) }.map(\.source)
                        position = 0
                        if pending.isEmpty {
                            self.message = L("正在等待游戏中的新文本；已缓存译文可离线使用。可点击暂停结束跟随补译。")
                            try await Task.sleep(for: .seconds(2)); continue
                        }
                    } catch {
                        if !Task.isCancelled { self.error = error.localizedDescription }
                        break
                    }
                }
                let source = pending[position]; position += 1; attempted.insert(source)
                self.message = String(format: L("正在翻译 %@ / %@；每条成功后立即保存。"), "\(position)", "\(pending.count)")
                var result: String?, failure: String?, stopForService = false
                for attempt in 0..<3 {
                    do { result = try await translateText(service, source); failure = nil; break }
                    catch {
                        failure = error.localizedDescription
                        if let http = error as? TranslationHTTPFailure, !http.retryable { stopForService = true; break }
                        if Task.isCancelled { break }
                        if attempt < 2 { try? await Task.sleep(for: .seconds(attempt + 1)) }
                    }
                }
                guard self.isCurrent, !Task.isCancelled else { break }
                guard var next = self.catalog, let index = next.entries.firstIndex(where: { $0.source == source }) else { break }
                next.entries[index].target = result ?? ""; next.entries[index].failure = failure
                do {
                    try self.persist(next)
                    if followGame, let project = self.project { try AssistanceInstaller.updateTranslations(project, translations: next.dictionary) }
                } catch { self.error = String(format: L("已停止翻译：%@"), "\(error.localizedDescription)"); break }
                if stopForService { self.error = L("翻译服务拒绝请求，已停止队列。请检查地址、模型、余额或密钥后重试。"); break }
                try? await Task.sleep(for: .milliseconds(800))
            }
            guard let self, self.isCurrent else { return }
            self.busy = false
            if Task.isCancelled { self.message = L("已暂停，继续时只处理未完成的条目。") }
            else if self.error == nil { self.message = String(format: L("翻译任务结束。已完成 %@ 条，失败 %@ 条。点击「应用到游戏」生效。"), "\(self.catalog?.completed ?? 0)", "\(self.catalog?.entries.filter { $0.failure != nil }.count ?? 0)") }
        }
    }
    func apply() {
        operation {
            guard isCurrent, let project, let store else { return }
            store.refreshRunning()
            try AssistanceInstaller.configure(project, options: options, translations: catalog?.dictionary ?? [:], running: running)
            installed = true
            message = project.usesFileBridge ? L("辅助功能已应用，下次启动游戏生效。进入游戏后，在下方作弊工具中搜索和编辑数值。") : L("辅助功能已应用，下次启动游戏生效。作弊面板可在游戏右上角或按 ⇧F8 打开。")
        }
    }
    func restore() {
        operation {
            guard isCurrent, let project, let store else { return }
            store.refreshRunning(); try AssistanceInstaller.restore(project, running: running)
            installed = false; options = .init(); liveState = nil; pendingCommand = nil
            message = L("辅助功能已移除；译文目录仍保留。存档里的修改不会因此撤销。")
        }
    }
}

extension AppStore {
    func assistanceSession(for game: GameRecord) -> AssistanceSession {
        if let session = assistanceSessions[game.id], session.game.gamePath == game.gamePath, session.game.gameEngine == game.gameEngine { return session }
        assistanceSessions[game.id]?.invalidate()
        let session = AssistanceSession(game: game, store: self)
        assistanceSessions[game.id] = session
        return session
    }
}

private enum TranslationCredential {
    static func query(_ account: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "Tsumigeya.Translation", kSecAttrAccount as String: account]
    }
    static func read(account: String) throws -> String {
        guard !account.isEmpty else { return "" }
        var q = query(account); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?; let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return "" }
        guard status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) else { throw AssistanceError.invalid(L("无法读取翻译密钥，请检查系统钥匙串权限。")) }
        return value
    }
    static func save(_ value: String, account: String) throws {
        let q = query(account)
        if value.isEmpty { let status = SecItemDelete(q as CFDictionary); guard status == errSecSuccess || status == errSecItemNotFound else { throw AssistanceError.invalid(L("无法删除钥匙串密钥。")) }; return }
        let attrs = [kSecValueData as String: Data(value.utf8)]
        var status = SecItemUpdate(q as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound { var item = q; item.merge(attrs) { _, new in new }; item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly; status = SecItemAdd(item as CFDictionary, nil) }
        guard status == errSecSuccess else { throw AssistanceError.invalid(String(format: L("无法把密钥保存到系统钥匙串（%@）。"), "\(status)")) }
    }
}
