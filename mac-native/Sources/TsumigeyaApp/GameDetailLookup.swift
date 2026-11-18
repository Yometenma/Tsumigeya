import Foundation
import Combine
import TsumigeyaCore

/// 目录和说明文件可能位于慢盘；详情绘制只读取结果，不执行文件扫描。
@MainActor
final class GameDetailLookup: ObservableObject {
    typealias Resolver = @Sendable (GameRecord) -> DlsiteLookup.Step
    @Published private(set) var step: DlsiteLookup.Step?
    private var resolvedGame: GameRecord?
    private var requestID: UUID?
    private let resolver: Resolver

    init(resolver: @escaping Resolver = { game in
        DlsiteLookup.plan(gamePath: game.gamePath, gameTitle: game.gameTitle)
    }) {
        self.resolver = resolver
    }

    var rj: String? {
        if case .byRJ(let number) = step { return number }
        return nil
    }

    func load(game: GameRecord) async {
        guard resolvedGame != game else { return }
        let token = UUID()
        requestID = token
        resolvedGame = nil
        step = nil
        let resolver = self.resolver
        let task = Task.detached(priority: .userInitiated) { resolver(game) }
        let result = await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            task.cancel()
        }
        // 切换游戏或销毁详情后，慢目录返回的旧结果不能串到新详情。
        guard !Task.isCancelled, requestID == token else { return }
        resolvedGame = game
        step = result
    }
}
