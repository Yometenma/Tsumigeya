import Foundation
import Combine
import TsumigeyaCore

/// 资料、请求及失效检查由同一对象管理，弹窗状态仍属于 AppStore。
@MainActor
final class LibraryMetadataStore: ObservableObject {
    private(set) var dataDir = ""
    var languagePreference: () -> MetadataLanguagePreference? = { nil }
    var externalPage: @Sendable (URL) async throws -> MetadataPage = { url in
        let (finalURL, html) = try await MetadataNetwork.page(url)
        return MetadataPage(url: finalURL, html: html)
    }
    var aiService: () throws -> MetadataAIService = { throw MetadataFailure(L("请先配置作品信息接口。")) }
    var searchProvider: () -> MetadataSearchSettings.Provider = { .native }
    var searchService: () throws -> MetadataSearchService = { throw MetadataFailure(L("请先配置独立搜索接口。")) }
    @Published private(set) var externalCandidates: [String: [MetadataCandidate]] = [:]
    private var previewGames: [String: GameRecord] = [:]
    var currentGame: (String) -> GameRecord? = { _ in nil }
    var readMeta: (String) -> GameDlsiteMeta? = { _ in nil }
    var didSave: (String, GameDlsiteMeta, [String: JSONValue]) -> Void = { _, _, _ in }
    private let injectedService: DLsiteService?
    private var metaTasks: [String: Task<Void, Never>] = [:]
    private var searchTasks: [String: Task<Void, Never>] = [:]
    private var metaTokens: [String: UUID] = [:]
    private var searchTokens: [String: UUID] = [:]

    init(service: DLsiteService? = nil) {
        injectedService = service
        dlsiteService = service
    }

    private func game(id: String) -> GameRecord? { currentGame(id) }

    func reset(dataDirectory: String) {
        cancelAll()
        // 同一数据目录重载时保留服务的请求间隔，不能因清缓存绕过限速。
        if dataDir != dataDirectory { dlsiteService = injectedService }
        dataDir = dataDirectory
        metaError = [:]
        metaNotice = [:]
        searchHits = [:]
        searchWarnings = [:]
        searchKeywordsTried = [:]
        searchError = [:]
        lastKeyword = [:]
    }

    func cancelAll() {
        for id in Set(metaTasks.keys).union(searchTasks.keys) { cancelLookup(gameId: id) }
        metaPreviews = [:]
        externalCandidates = [:]
        previewGames = [:]
    }

    /// 编号或路径复用前使旧请求及缓存失效；这里不删除磁盘数据。
    func forget(gameId: String) {
        externalCandidates.removeValue(forKey: gameId)
        clearSearch(gameId: gameId)
        metaPreviews.removeValue(forKey: gameId)
        previewGames.removeValue(forKey: gameId)
        metaNotice.removeValue(forKey: gameId)
        metaError.removeValue(forKey: gameId)
    }

    func waitForFetch(gameId: String) async { await metaTasks[gameId]?.value }
    func waitForSearch(gameId: String) async { await searchTasks[gameId]?.value }

    /// 正在抓取元数据的游戏（防重复点击）。
    @Published private(set) var fetchingMeta: Set<String> = []

    /// 抓取失败的原因（gameId → 说明）。
    @Published private(set) var metaError: [String: String] = [:]

    /// DLsite 服务（懒加载，首次用到才建）。
    private var dlsiteService: DLsiteService?

    /// 取启动／重载时一次性读入内存的元数据，不在 View 更新期间访问磁盘。
    func meta(for gameId: String) -> GameDlsiteMeta? {
        readMeta(gameId)
    }

    /// 从游戏路径自动检测 RJ（不联网）。
    func detectRJ(for game: GameRecord) -> [String] {
        RJNumber.detectFromPath(gamePath: game.gamePath)
    }

    /// 抓取 DLsite 元数据（**联网**）。
    ///
    /// - Parameters:
    ///   - gameId: 游戏 id
    ///   - rj: RJ 号
    ///   - refresh: 强制重抓（忽略缓存）
    ///
    /// ⚠️ **异步**：网络请求不能阻塞主线程。
    func fetchMeta(gameId: String, rj: String, refresh: Bool = false, category: String? = nil, preview: Bool = false) {
        guard let expected = game(id: gameId) else { return }
        guard !fetchingMeta.contains(gameId) else { return }
        fetchingMeta.insert(gameId)
        if preview { searchError.removeValue(forKey: gameId) }
        metaError.removeValue(forKey: gameId)
        metaNotice.removeValue(forKey: gameId)

        let token = UUID()
        metaTokens[gameId] = token
        metaTasks[gameId] = Task { @MainActor in
            defer {
                if metaTokens[gameId] == token {
                    metaTasks.removeValue(forKey: gameId)
                    fetchingMeta.remove(gameId)
                    metaTokens.removeValue(forKey: gameId)
                }
            }

            // 懒建服务
            if dlsiteService == nil {
                dlsiteService = DLsiteService(dataDir: dataDir)
            }
            guard let service = dlsiteService else { return }

            let result = await service.fetchResolved(rj: rj, category: category, refresh: refresh, preference: languagePreference())
            guard metaTokens[gameId] == token, game(id: gameId) == expected else { return }

            switch result {
            case .success(let work):
                if preview {
                    metaPreviews[gameId] = work
                    previewGames[gameId] = expected
                    return
                }
                // ⚠️ **合并时保护用户改过的字段**（D26）
                let existing = meta(for: gameId)
                let fields = existing?.work.identity == work.identity ? (existing?.editedFields ?? []) : []
                let edited = Set(fields)
                let merged = EditedFields.merge(
                    old: existing?.work, incoming: work, edited: edited)

                let meta = GameDlsiteMeta(
                    work: merged, editedFields: fields)
                guard updateMeta(gameId: gameId, meta: meta) else { return }
                metaNotice[gameId] = L("作品信息已更新；手动修改的字段已保留。")
            case .failure(let error):
                // ⚠️ 结构化错误 → 直接显示它的 message（每种错误说不同的话）
                metaError[gameId] = error.message
            }
        }
    }

    /// 用户手动编辑一个元数据字段（**标记为已编辑，刷新时不覆盖**，D26）。
    func editMetaField(gameId: String, field: String, value: String?) {
        guard var meta = meta(for: gameId) else { return }

        var work = meta.work
        switch field {
        case "title": work.title = value
        case "titleSub": work.titleSub = value
        case "circle": work.circle = value
        case "description": work.description = value
        default: return
        }
        meta.work = work

        // ⚠️ **必须记进 editedFields**，否则下次刷新会被 DLsite 的值覆盖
        if !meta.editedFields.contains(field) {
            meta.editedFields.append(field)
        }
        _ = updateMeta(gameId: gameId, meta: meta)
    }

    @discardableResult
    func updateMeta(gameId: String, meta: GameDlsiteMeta) -> Bool {
        var meta = meta
        meta.removeEditedEvidence()
        guard game(id: gameId) != nil else {
            metaError[gameId] = L("游戏已移除或发生变化，未保存作品信息。")
            return false
        }
        if let error = GameMetaStore.save(dataDir: dataDir, gameId: gameId, meta: meta,
                                       didWrite: { [self] in didSave(gameId, meta, $0) }) {
            metaError[gameId] = String(format: L("保存作品信息失败：%@"), "\(error)")
            return false
        }
        metaError.removeValue(forKey: gameId)
        return true
    }

    // MARK: - DLsite 搜索（P7）

    /// 搜索进行中（gameId → 是否在搜）。
    @Published private(set) var searchingGameIDs: Set<String> = []
    @Published private(set) var metaPreviews: [String: DlsiteWork] = [:]
    @Published private(set) var metaNotice: [String: String] = [:]
    /// 搜索结果（gameId → 候选列表）。
    @Published private(set) var searchHits: [String: [DLsiteSearch.Hit]] = [:]
    /// 搜索错误（gameId → 说明）。
    @Published private(set) var searchWarnings: [String: [String]] = [:]
    @Published private(set) var searchKeywordsTried: [String: [String]] = [:]
    @Published private(set) var searchError: [String: String] = [:]
    /// 上次搜索用的关键词（用于界面显示「搜了什么」）。
    @Published private(set) var lastKeyword: [String: String] = [:]

    /// 按名字搜索（用户要求：「不能（找到 RJ）就按名字来」）。
    ///
    /// ⚠️ **只返回候选，绝不自动选**（D24 —— 实测搜 Karryn 返回正片 + 3 个 DLC）。
    func searchMeta(gameId: String, keyword: String, category: String? = nil) {
        guard let expected = game(id: gameId), !searchingGameIDs.contains(gameId) else { return }
        searchingGameIDs.insert(gameId)
        searchError.removeValue(forKey: gameId)
        searchHits.removeValue(forKey: gameId)
        searchWarnings.removeValue(forKey: gameId)
        searchKeywordsTried.removeValue(forKey: gameId)
        lastKeyword[gameId] = keyword
        let token = UUID()
        searchTokens[gameId] = token

        searchTasks[gameId] = Task { @MainActor in
            defer {
                if searchTokens[gameId] == token {
                    searchingGameIDs.remove(gameId)
                    searchTokens.removeValue(forKey: gameId)
                    searchTasks.removeValue(forKey: gameId)
                }
            }

            if dlsiteService == nil {
                dlsiteService = DLsiteService(dataDir: dataDir)
            }
            guard let service = dlsiteService else { return }

            let result = await service.searchReport(keyword: keyword, category: category, preference: languagePreference())
            guard searchTokens[gameId] == token, game(id: gameId) == expected else { return }

            switch result {
            case .success(let report):
                let hits = report.hits
                searchHits[gameId] = hits
                searchWarnings[gameId] = report.warnings
                searchKeywordsTried[gameId] = report.keywordsTried
                if hits.isEmpty {
                    searchError[gameId] = String(format: L("没搜到「%@」。试试更短的词，或者手动输入 RJ。"), "\(keyword)")
                }
            case .failure(let error):
                searchError[gameId] = error.message
            }
        }
    }

    /// 候选只进入预览，确认成功落盘后才改变游戏关联。
    func selectSearchHit(gameId: String, rj: String) {
        searchError.removeValue(forKey: gameId)
        let category = searchHits[gameId]?.first(where: { $0.rj == rj })?.category
        fetchMeta(gameId: gameId, rj: rj, category: category, preview: true)
    }

    func clearSearch(gameId: String) {
        cancelLookup(gameId: gameId)
        searchTokens.removeValue(forKey: gameId)
        searchHits.removeValue(forKey: gameId)
        searchError.removeValue(forKey: gameId)
        lastKeyword.removeValue(forKey: gameId)
        searchWarnings.removeValue(forKey: gameId)
        searchKeywordsTried.removeValue(forKey: gameId)
    }

    func cancelLookup(gameId: String) {
        metaTokens.removeValue(forKey: gameId)
        searchTokens.removeValue(forKey: gameId)
        metaTasks.removeValue(forKey: gameId)?.cancel()
        searchTasks.removeValue(forKey: gameId)?.cancel()
        fetchingMeta.remove(gameId)
        searchingGameIDs.remove(gameId)
    }

    func discardMetaPreview(gameId: String) {
        cancelLookup(gameId: gameId)
        metaPreviews.removeValue(forKey: gameId)
        previewGames.removeValue(forKey: gameId)
        metaError.removeValue(forKey: gameId)
    }

    @discardableResult
    func applyMetaPreview(gameId: String) -> Bool {
        guard let incoming = metaPreviews[gameId] else { return false }
        return applyExternalOrDLsitePreview(gameId: gameId, incoming: incoming)
    }

    func applyExternalOrDLsitePreview(gameId: String, incoming: DlsiteWork, draftEdited: Set<String> = []) -> Bool {
        guard let expected = previewGames[gameId], game(id: gameId) == expected,
              metaPreviews[gameId]?.identity == incoming.identity else {
            metaError[gameId] = L("游戏已移除或发生变化，请重新准备资料；本次未保存。")
            return false
        }
        let old = meta(for: gameId)
        var edited = old?.work.identity == incoming.identity ? (old?.editedFields ?? []) : []
        let merged = EditedFields.merge(old: old?.work, incoming: incoming, edited: Set(edited).subtracting(draftEdited))
        for field in draftEdited where !edited.contains(field) { edited.append(field) }
        guard updateMeta(gameId: gameId, meta: GameDlsiteMeta(work: merged, editedFields: edited)) else { return false }
        metaPreviews.removeValue(forKey: gameId)
        previewGames.removeValue(forKey: gameId)
        clearSearch(gameId: gameId)
        metaNotice[gameId] = L("已关联作品信息。")
        return true
    }

    func searchExternal(gameId: String, name: String) {
        let provider = searchProvider()
        guard provider != .disabled else { metaError[gameId] = L("联网搜索已关闭，请指定页面或手动填写。"); return }
        if provider == .native {
            runExternal(gameId: gameId) { service, language in
                guard let service else { throw MetadataFailure(L("请先配置作品信息接口。")) }
                return .candidates(try await service.search(name: name, language: language))
            }
        } else {
            let service: MetadataSearchService
            do { service = try searchService() }
            catch { metaError[gameId] = L("无法读取搜索配置或密钥，请检查设置。"); return }
            runExternal(gameId: gameId, needsAI: false) { _, language in
                .candidates(try await service.search(name: name, language: language))
            }
        }
    }
    func extractExternal(gameId: String, address: String) {
        guard let url = MetadataNetwork.publicURL(address.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            metaError[gameId] = L("请输入公开的 HTTPS 商品页地址。"); return
        }
        let fetchPage = externalPage
        runExternal(gameId: gameId) { service, language in
            guard let service else { throw MetadataFailure(L("请先配置作品信息接口。")) }
            let page = try await fetchPage(url)
            let work = try await service.extract(page: page, language: language)
            return .work(work)
        }
    }
    private enum ExternalResult: Sendable { case candidates([MetadataCandidate]), work(DlsiteWork) }
    private func runExternal(gameId: String, needsAI: Bool = true, body: @escaping @Sendable (MetadataAIService?, MetadataLanguage) async throws -> ExternalResult) {
        guard let expected = game(id: gameId), !fetchingMeta.contains(gameId) else { return }
        cancelLookup(gameId: gameId)
        metaPreviews.removeValue(forKey: gameId); previewGames.removeValue(forKey: gameId)
        externalCandidates.removeValue(forKey: gameId)
        metaError.removeValue(forKey: gameId); metaNotice.removeValue(forKey: gameId)
        let service: MetadataAIService?
        do {
            service = needsAI ? try aiService() : nil
            if let service, service.settings.url == nil || service.settings.model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                throw MetadataFailure(L("请先在「设置 → 作品信息」填写有效接口地址和模型，并保存密钥。"))
            }
        } catch { metaError[gameId] = error.localizedDescription; return }
        let language = languagePreference()?.preferred ?? .simplifiedChinese
        let token = UUID(); metaTokens[gameId] = token; fetchingMeta.insert(gameId)
        metaTasks[gameId] = Task { @MainActor in
            defer {
                if metaTokens[gameId] == token {
                    fetchingMeta.remove(gameId); metaTokens.removeValue(forKey: gameId); metaTasks.removeValue(forKey: gameId)
                }
            }
            do {
                let result = try await body(service, language)
                guard !Task.isCancelled, metaTokens[gameId] == token, game(id: gameId) == expected else { return }
                switch result {
                case .candidates(let candidates): externalCandidates[gameId] = candidates
                case .work(let work): metaPreviews[gameId] = work; previewGames[gameId] = expected
                }
            } catch {
                guard !Task.isCancelled, metaTokens[gameId] == token, game(id: gameId) == expected else { return }
                metaError[gameId] = (error as? MetadataFailure)?.message ?? L("网络或接口请求未完成，请检查连接后重试。原有资料未更改。")
            }
        }
    }
    func prepareManualExternal(gameId: String) {
        guard let expected = game(id: gameId) else { return }
        discardMetaPreview(gameId: gameId)
        var work = DlsiteWork(rj: "", title: expected.gameTitle, fetchedAt: ISO8601DateFormatter().string(from: .now))
        work.source = "manual"; work.externalID = UUID().uuidString
        if let existing = meta(for: gameId), existing.work.isExternal { work = existing.work }
        metaPreviews[gameId] = work; previewGames[gameId] = expected
    }

}
