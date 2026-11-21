import Foundation
import Combine
import TsumigeyaCore

/// 存档界面只负责交互；会话统一维护列表、结果及操作前的安全检查。
@MainActor
final class SaveSession: ObservableObject {
    let id = UUID()
    @Published private(set) var game: GameRecord
    private weak var store: AppStore?
    private var valid = true
    @Published private(set) var listing: SaveListing?
    @Published private(set) var isWorking = false
    @Published private(set) var message: (text: String, isError: Bool)?

    init(game: GameRecord, store: AppStore) {
        self.game = game
        self.store = store
    }

    var overridePath: String? { game.saveDirectoryOverride }
    var canExport: Bool { listing?.dir != nil && listing?.hasSaves == true }

    func invalidate() { valid = false }

    private var isCurrent: Bool { valid && store?.game(id: game.id) == game }

    func reload() {
        guard isCurrent else { return }
        listing = SaveStore.list(
            gamePath: game.gamePath, engine: game.gameEngine,
            overrideDirectory: overridePath)
    }

    func reportCopiedPath() { message = (L("已复制存档目录路径。"), false) }

    /// 文件选择窗口会让出事件循环，返回后必须重新核对游戏身份及运行状态。
    private func allowMutation() -> Bool {
        guard isCurrent else {
            message = (L("游戏已移除或发生变化，请重新打开存档页。"), true)
            return false
        }
        guard let store else { return false }
        guard !isWorking else { return false }
        store.refreshRunning()
        guard store.runningGames[game.id] == nil else {
            message = (L("游戏正在运行，先关掉它再操作存档。"), true)
            return false
        }
        return true
    }

    func setDirectory(_ path: String?) {
        guard allowMutation(), let store else { return }
        guard store.setSaveDirectoryOverride(gameId: game.id, path: path),
              let updated = store.game(id: game.id) else {
            message = (store.lastAddGameError ?? L("保存存档目录失败。"), true)
            return
        }
        game = updated
        message = (path == nil ? L("已恢复自动探测。") : L("已指定存档目录。"), false)
        reload()
    }

    func exportArchive(outputDirectory: String) {
        guard allowMutation() else { return }
        isWorking = true
        message = nil
        defer { isWorking = false }
        let result = SaveArchiveIO.export(
            gamePath: game.gamePath, engine: game.gameEngine,
            gameTitle: game.gameTitle, outputDir: outputDirectory,
            isRunning: false, overrideDirectory: overridePath)
        switch result {
        case .success(let exported):
            message = ("已导出 \(exported.fileCount) 个文件 → \(exported.archivePath)", false)
        case .failure(let error):
            message = (error.message, true)
        }
    }

    func importArchive(at url: URL) {
        guard allowMutation() else { return }
        isWorking = true
        message = nil
        defer { isWorking = false }
        let result = SaveArchiveIO.importArchive(
            archivePath: url.path, gamePath: game.gamePath, engine: game.gameEngine,
            overrideDirectory: overridePath)
        switch result {
        case .success(let imported):
            let backupNote = imported.backups.isEmpty
                ? "" : "（\(imported.backups.count) 个原文件已备份为 .tsumigeya-bak）"
            message = ("已恢复 \(imported.files.count) 个文件\(backupNote)", false)
            reload()
        case .failure(let error):
            message = (error.message, true)
        }
    }
}
