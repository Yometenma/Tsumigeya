import Foundation
import Combine
import TsumigeyaCore

struct BatchMetaItem: Identifiable {
    enum State: String {
        case pending = "等待处理"
        case running = "正在处理"
        case saved = "已保存"
        case needsConfirmation = "待确认"
        case failed = "失败"
        case skipped = "已跳过"
    }
    let game: GameRecord
    var id: String { game.id }
    var state: State = .pending
    var message: String?
}

/// 队列负责进度和暂停，单项网络请求仍由资料模块管理。
@MainActor
final class BatchMetadataCoordinator: ObservableObject {
    private let metadata: LibraryMetadataStore

    init(metadata: LibraryMetadataStore) { self.metadata = metadata }

    func confirmSaved(gameId: String) {
        if batchMetaItems.first(where: { $0.id == gameId })?.game == metadata.currentGame(gameId) {
            setBatchMeta(gameId, state: .saved, message: "已确认关联并保存。")
        }
    }

    /// 游戏管理可以在删除部分失败前撤销队列快照，防止尚未开始的旧任务重新补回资料。
    func invalidateGame(gameId: String) {
        guard batchMetaItems.contains(where: { $0.id == gameId }) else { return }
        setBatchMeta(gameId, state: .skipped, message: "游戏记录正在变更，该项已取消；请重新准备列表。")
    }

    @Published private(set) var batchMetaItems: [BatchMetaItem] = []
    @Published private(set) var batchMetaRunning = false
    @Published private(set) var batchMetaRefreshAssociated = false
    private var batchMetaTask: Task<Void, Never>?
    private var batchMetaToken: UUID?
    private var batchMetaCurrentID: String?

    func prepareBatchMeta(games: [GameRecord], refreshAssociated: Bool) {
        guard !batchMetaRunning else { return }
        batchMetaRefreshAssociated = refreshAssociated
        batchMetaItems = games.compactMap { game in
            if !refreshAssociated && metadata.meta(for: game.id) != nil { return nil }
            return BatchMetaItem(game: game)
        }
    }

    func startBatchMeta(retryFailures: Bool = false) {
        guard !batchMetaRunning else { return }
        let retryIDs = Set(batchMetaItems.filter { $0.state == .failed }.map(\.id))
        if retryFailures {
            for i in batchMetaItems.indices where batchMetaItems[i].state == .failed {
                batchMetaItems[i].state = .pending
                batchMetaItems[i].message = nil
            }
        }
        let pending = batchMetaItems.filter { $0.state == .pending && (!retryFailures || retryIDs.contains($0.id)) }
        guard !pending.isEmpty else { return }
        let token = UUID()
        batchMetaToken = token
        batchMetaRunning = true
        batchMetaTask = Task { @MainActor in
            defer {
                if batchMetaToken == token {
                    batchMetaRunning = false
                    batchMetaCurrentID = nil
                    batchMetaTask = nil
                    batchMetaToken = nil
                }
            }
            for item in pending {
                guard batchMetaItems.first(where: { $0.id == item.id })?.state == .pending else { continue }
                guard !Task.isCancelled, batchMetaToken == token else { break }
                let id = item.id
                guard metadata.currentGame(id) == item.game else {
                    setBatchMeta(id, state: .skipped, message: "游戏已移除或发生变化，请重新准备列表。")
                    continue
                }
                guard !metadata.fetchingMeta.contains(id), !metadata.searchingGameIDs.contains(id), metadata.metaPreviews[id] == nil else {
                    setBatchMeta(id, state: .skipped, message: "该游戏有未完成的查找或预览，请先处理。")
                    continue
                }
                batchMetaCurrentID = id
                setBatchMeta(id, state: .running)
                if let associated = metadata.meta(for: id) {
                    metadata.fetchMeta(gameId: id, rj: associated.work.rj, refresh: true, category: associated.work.category)
                    await metadata.waitForFetch(gameId: id)
                    guard !Task.isCancelled, batchMetaToken == token else { break }
                    finishBatchFetch(item)
                } else {
                    let numbers = metadata.detectRJ(for: item.game)
                    if numbers.count == 1, let rj = numbers.first {
                        metadata.fetchMeta(gameId: id, rj: rj)
                        await metadata.waitForFetch(gameId: id)
                        guard !Task.isCancelled, batchMetaToken == token else { break }
                        finishBatchFetch(item)
                    } else if numbers.count > 1 {
                        setBatchMeta(id, state: .needsConfirmation, message: "检测到多个编号，请核对后关联：" + numbers.joined(separator: "、"))
                    } else {
                        let keyword = item.game.gameTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                            ? DlsiteLookup.fallbackKeyword(fromPath: item.game.gamePath)
                            : DlsiteLookup.searchKeyword(from: item.game.gameTitle)
                        guard !keyword.isEmpty else {
                            setBatchMeta(id, state: .needsConfirmation, message: "没有可用的名称或编号，请手动查找。")
                            continue
                        }
                        metadata.searchMeta(gameId: id, keyword: keyword)
                        await metadata.waitForSearch(gameId: id)
                        guard !Task.isCancelled, batchMetaToken == token else { break }
                        guard batchMetaItems.first(where: { $0.id == id })?.state == .running else { continue }
                        guard metadata.currentGame(id) == item.game else {
                            setBatchMeta(id, state: .skipped, message: "游戏已移除或发生变化。")
                            continue
                        }
                        let hits = metadata.searchHits[id] ?? []
                        if !hits.isEmpty {
                            setBatchMeta(id, state: .needsConfirmation, message: "找到 \(hits.count) 个候选，请预览确认；尚未写入作品信息。")
                        } else {
                            setBatchMeta(id, state: .failed, message: metadata.searchError[id] ?? "查找已中断，请重试。")
                        }
                    }
                }
                batchMetaCurrentID = nil
            }
        }
    }

    private func finishBatchFetch(_ item: BatchMetaItem) {
        guard batchMetaItems.first(where: { $0.id == item.id })?.state == .running else { return }
        guard metadata.currentGame(item.id) == item.game else {
            setBatchMeta(item.id, state: .skipped, message: "游戏已移除或发生变化。")
            return
        }
        if let error = metadata.metaError[item.id] {
            setBatchMeta(item.id, state: .failed, message: error)
        } else if metadata.metaNotice[item.id] != nil {
            setBatchMeta(item.id, state: .saved, message: "已保存，手动修改已保留。")
        } else {
            setBatchMeta(item.id, state: .failed, message: "获取已中断，请重试。")
        }
    }

    private func setBatchMeta(_ id: String, state: BatchMetaItem.State, message: String? = nil) {
        guard let index = batchMetaItems.firstIndex(where: { $0.id == id }) else { return }
        batchMetaItems[index].state = state
        batchMetaItems[index].message = message
    }

    func cancelBatchMeta() {
        batchMetaToken = nil
        batchMetaTask?.cancel()
        batchMetaTask = nil
        if let id = batchMetaCurrentID {
            let finishedFetch = !metadata.fetchingMeta.contains(id) && metadata.metaNotice[id] != nil
            let finishedSearch = !metadata.searchingGameIDs.contains(id) && !(metadata.searchHits[id] ?? []).isEmpty
            metadata.cancelLookup(gameId: id)
            if batchMetaItems.first(where: { $0.id == id })?.state == .skipped {
                // 已撤销的游戏管理快照不能在暂停时重新排队。
            } else if finishedFetch, let item = batchMetaItems.first(where: { $0.id == id }) {
                finishBatchFetch(item)
            } else if finishedSearch {
                setBatchMeta(id, state: .needsConfirmation, message: "候选已准备好，请预览确认。")
            } else {
                setBatchMeta(id, state: .pending, message: "已暂停，尚未保存；可继续。")
            }
        }
        batchMetaCurrentID = nil
        batchMetaRunning = false
    }

}
