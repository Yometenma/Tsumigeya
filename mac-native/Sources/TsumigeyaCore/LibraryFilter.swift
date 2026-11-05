// 库页的筛选判据（**纯函数，唯一来源**）。
//
// 对应 Electron 版：`src/shared/library-filter.ts`（100 行 / 24 条单测）
//
// ===== 为什么必须抽成纯函数 =====
//
// Electron 版踩过一次：筛选逻辑写在 store 里，改错时**界面只是少显示几个游戏**，
// 不报错、不崩 —— 用户会以为「游戏丢了」。
// 抽成纯函数 + 单测，是唯一能让这类错误变红的方法（D43 的同一取向）。
import Foundation

public enum LibraryFilter {

    /// 应用筛选。
    ///
    /// - Parameters:
    ///   - games: 全部游戏（已按 id 排序）
    ///   - searchText: 搜索关键词（匹配标题 / 路径，**大小写不敏感**）
    ///   - onlyUnbound: 只看未绑定引擎的游戏
    ///   - hasBinding: 判断一个游戏是否「已绑定」（由调用方给判据，见下）
    ///
    /// - Returns: 过滤后的列表（**保持传入顺序**）
    public static func apply(
        games: [GameRecord],
        searchText: String,
        onlyUnbound: Bool,
        hasBinding: (GameRecord) -> Bool
    ) -> [GameRecord] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = query.lowercased()

        return games.filter { game in
            // 「只看未绑定」优先
            if onlyUnbound && hasBinding(game) { return false }
            // 空搜索 = 不过滤
            if lower.isEmpty { return true }
            // 标题或路径命中
            //
            // ⚠️ 用 `localizedCaseInsensitiveContains` 而不是 `contains`：
            //    日文游戏名的用户会搜中文/罗马字，大小写与全半角都该容忍。
            if game.gameTitle.localizedCaseInsensitiveContains(lower) { return true }
            if game.gamePath.localizedCaseInsensitiveContains(lower) { return true }
            // 引擎名也参与搜索（用户可能想找「mkxpz 的游戏」）
            if game.gameEngine.localizedCaseInsensitiveContains(lower) { return true }
            return false
        }
    }
}
