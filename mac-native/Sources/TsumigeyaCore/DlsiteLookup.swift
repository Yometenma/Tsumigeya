// 「怎样才能找到这个作品的 DLsite 元数据」—— 决策链。
//
// 对应 Electron 版：`src/shared/gameinfo-form.ts` 的 `dlsiteDetect` 那部分 + M2.5 §A
//
// ===== ⚠️ 决策链（用户 2026-11-06 明确要求）=====
//
//   「自动识别如果有直接能找到rj号就用rj号，不能就按名字来」
//
//   ① 路径里能提取到 RJ      → **直接用 RJ 抓详情**（最可靠）
//   ② 提取不到 → 用**游戏标题**作关键词搜索
//   ③ 搜索返回候选列表 → **让用户点选**（绝不自动选，D24）
//   ④ 都没有 → 提示手动输入 RJ
//
// ===== ⚠️ 为什么第 ②③ 步不能合并成「搜到了就用第一个」=====
//
// 实测（搜 `Karryn`）：返回 4 条 —— 正片 + 3 个 DLC。
// 首条碰巧是正片，但**别的关键词经常不是**（同名续作 / DLC / 合集）。
// 自动选第一条 = 拿错的封面 + 错的简介，而用户不会意识到。
//
// ===== ⚠️ 搜索关键词怎么选 =====
//
// 用**游戏标题**（`gameTitle`）而不是路径名：标题是用户能改的、
// 也是他认知中的名字。路径名可能是 `Unholy_maiden_Ver.1.0.10` 这种带版本号的。
//
// ⚠️ 但标题里常有**版本后缀**（`Ver.1.0.10` / `【アップデート版】`），
//    带着搜会搜不到。所以清洗：去掉版本号、括号副标题。
//    清洗规则保守 —— **宁可搜到更多候选，也不要搜不到**。
import Foundation

public enum DlsiteLookup {

    /// 找到元数据的下一步。
    public enum Step: Sendable, Equatable {
        /// 路径里有 RJ → 直接抓这个 RJ。
        case byRJ(String)
        /// 没有 RJ → 用这个关键词搜索。
        case byKeyword(String)
        /// 连关键词都没有（标题和路径都洗空了）→ 让用户手动输入。
        case manual
    }

    /// 决定下一步怎么查。
    ///
    /// - Parameters:
    ///   - gamePath: 游戏的 gamePath
    ///   - gameTitle: 游戏标题（用户可改的显示名）
    ///   - fileManager: 注入用
    public static func plan(
        gamePath: String, gameTitle: String,
        fileManager: FileManager = .default
    ) -> Step {
        // ① RJ 优先（用户明确要求：「如果能直接找到 rj 号就用 rj 号」）
        let detected = RJNumber.detectFromPath(
            gamePath: gamePath, fileManager: fileManager)
        if let rj = detected.first {
            return .byRJ(rj)
        }

        // ② 没有 RJ → 用清洗过的标题搜
        let keyword = searchKeyword(from: gameTitle)
        if !keyword.isEmpty {
            return .byKeyword(keyword)
        }

        // ③ 标题也洗空了 → 手动
        return .manual
    }

    /// 把游戏标题洗成**适合搜索的关键词**。
    ///
    /// 清洗规则（每条都有理由）：
    ///   · 去掉版本号后缀（`Ver.1.0.10` / `v1.2` / `Ver1.0`）
    ///   · 去掉**末尾**的括号副标题（`【…】` / `（…）` / `[…]`）
    ///     —— 但**只在副标题看起来像版本说明时**（`アップデート版` / `DL版` 之类）
    ///   · 去掉多余空白
    ///
    /// ⚠️ **保守原则**：宁可搜到更多候选（用户在候选里挑），
    ///    也不要洗过头导致**一条都搜不到**。
    ///
    ///    所以：**不删主标题里的括号**（`□■魔法少女□■` 这种是标题的一部分），
    ///    只删「末尾且像版本标注」的那一个。
    public static func searchKeyword(from title: String) -> String {
        var value = title.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { return "" }

        // ① 去掉纯版本号（`Ver.1.0.10` / `v1.2.3` / `Ver1.0`）
        //    模式：`Ver` / `v` + 可选点号 + 数字串（可带多段）
        if let regex = try? NSRegularExpression(
            pattern: #"\s*(?:[Vv]er\.?|[Vv])\s*\d+(?:\.\d+)*\s*$"#) {
            let ns = value as NSString
            if let m = regex.firstMatch(
                in: value, range: NSRange(location: 0, length: ns.length)) {
                value = ns.replacingCharacters(in: m.range, with: "")
            }
        }

        // ② 去掉末尾「像版本标注」的括号块
        let versionMarkers = ["アップデート版", "更新版", "DL版", "完全版", "体験版",
                              "ver", "Ver", "版本", "汉化版", "重制版"]
        for open in ["【", "（", "(", "["] {
            let close: String
            switch open {
            case "【": close = "】"
            case "（": close = "）"
            case "(": close = ")"
            default: close = "]"
            }
            guard value.hasSuffix(close) else { continue }
            // 找配对的 open（从末尾往前）
            guard let range = value.range(of: open, options: .backwards) else { continue }
            let inner = String(value[range.upperBound..<value.index(before: value.endIndex)])
            // ⚠️ **只在内部含版本标记时才删**（否则它是标题的一部分）
            if versionMarkers.contains(where: { inner.contains($0) }) {
                value = String(value[..<range.lowerBound])
                    .trimmingCharacters(in: .whitespaces)
            }
        }

        // ③ 压缩多余空白
        if let regex = try? NSRegularExpression(pattern: #"\s{2,}"#) {
            let ns = value as NSString
            value = regex.stringByReplacingMatches(
                in: value, range: NSRange(location: 0, length: ns.length),
                withTemplate: " ")
        }

        return value.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// 从路径推断一个「可能是游戏名」的目录名（标题为空时的兜底）。
    ///
    /// ⚠️ 只在 `gameTitle` 为空时用。它比标题脏（带版本号 / 下划线），
    ///    但**总比搜不到好**。
    public static func fallbackKeyword(fromPath gamePath: String) -> String {
        let dir = DetectPath.gameDirForFiles(gamePath)
        let name = (dir as NSString).lastPathComponent
        // 下划线 / 连字符 → 空格（`Unholy_maiden` → `Unholy maiden`）
        let cleaned = name
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
        return searchKeyword(from: cleaned)
    }
}
