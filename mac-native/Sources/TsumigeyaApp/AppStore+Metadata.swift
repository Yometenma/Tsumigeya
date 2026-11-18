import Foundation
import TsumigeyaCore

// 保留统一界面入口，但不重复持有资料和队列的状态。
extension AppStore {
    var gameMeta: [String: GameDlsiteMeta] { library.metadataByGameID }
    var fetchingMeta: Set<String> { metadata.fetchingMeta }
    var metaError: [String: String] { metadata.metaError }
    var searchingGameIDs: Set<String> { metadata.searchingGameIDs }
    var metaPreviews: [String: DlsiteWork] { metadata.metaPreviews }
    var metaNotice: [String: String] { metadata.metaNotice }
    var searchHits: [String: [DLsiteSearch.Hit]] { metadata.searchHits }
    var searchWarnings: [String: [String]] { metadata.searchWarnings }
    var searchKeywordsTried: [String: [String]] { metadata.searchKeywordsTried }
    var searchError: [String: String] { metadata.searchError }
    var lastKeyword: [String: String] { metadata.lastKeyword }
    var batchMetaItems: [BatchMetaItem] { batchMetadata.batchMetaItems }
    var batchMetaRunning: Bool { batchMetadata.batchMetaRunning }
    var batchMetaRefreshAssociated: Bool { batchMetadata.batchMetaRefreshAssociated }

    func meta(for gameId: String) -> GameDlsiteMeta? { library.metadata(for: gameId) }
    func detectRJ(for game: GameRecord) -> [String] { metadata.detectRJ(for: game) }
    func fetchMeta(gameId: String, rj: String, refresh: Bool = false, category: String? = nil, preview: Bool = false) {
        metadata.fetchMeta(gameId: gameId, rj: rj, refresh: refresh, category: category, preview: preview)
    }
    func editMetaField(gameId: String, field: String, value: String?) {
        metadata.editMetaField(gameId: gameId, field: field, value: value)
        if let error = metadata.metaError[gameId] { reportMetadataSaveFailure(error) }
    }
    @discardableResult
    func updateMeta(gameId: String, meta: GameDlsiteMeta) -> Bool {
        let saved = metadata.updateMeta(gameId: gameId, meta: meta)
        if !saved { reportMetadataSaveFailure(metadata.metaError[gameId]) }
        return saved
    }
    func searchMeta(gameId: String, keyword: String, category: String? = nil) {
        metadata.searchMeta(gameId: gameId, keyword: keyword, category: category)
    }
    func selectSearchHit(gameId: String, rj: String) { metadata.selectSearchHit(gameId: gameId, rj: rj) }
    func clearSearch(gameId: String) { metadata.clearSearch(gameId: gameId) }
    func beginManualRJ(gameId: String) { manualRJFor = gameId }
    func closeManualRJ() {
        if let id = manualRJFor { metadata.discardMetaPreview(gameId: id) }
        manualRJFor = nil
    }
    func cancelLookup(gameId: String) { metadata.cancelLookup(gameId: gameId) }
    func discardMetaPreview(gameId: String) { metadata.discardMetaPreview(gameId: gameId) }
    @discardableResult
    func applyMetaPreview(gameId: String) -> Bool {
        guard metadata.applyMetaPreview(gameId: gameId) else {
            if let error = metadata.metaError[gameId] { reportMetadataSaveFailure(error) }
            return false
        }
        batchMetadata.confirmSaved(gameId: gameId)
        return true
    }
    func prepareBatchMeta(refreshAssociated: Bool) {
        batchMetadata.prepareBatchMeta(games: filteredGames, refreshAssociated: refreshAssociated)
    }
    func startBatchMeta(retryFailures: Bool = false) { batchMetadata.startBatchMeta(retryFailures: retryFailures) }
    func cancelBatchMeta() { batchMetadata.cancelBatchMeta() }
    func closeBatchMeta() {
        cancelBatchMeta()
        closeManualRJ()
        isBatchMetaPresented = false
    }
}
