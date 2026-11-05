// 引擎自动识别。
//
// 对应 Electron 版：src/main/engines/detect.ts（352 行）
// 契约：docs/M1-实施方案.md §2.2（R1 是头号风险），D57 / D88
//
// ===== 这个算法必须逐条照搬，不要"简化" =====
//
// 打分语义来自上游 module.js（两处一模一样的代码，Electron 版合成了一份）。
// 它是「引擎识别对不对」的全部依据。四条规则：
//
//   ① `all_required: true` —— **硬门槛**
//      有扩展名规则就必须命中，有文件规则就必须**全部**在场。
//      通过的进强命中集合，**不参与分数竞争**。
//
//   ② `all_required: false` —— **打分**
//      `score = (扩展名命中 ? 1 : 0) + 命中文件数 / 文件总数`
//
//   ③ 多个强命中时：文件命中数多的优先 → 扩展名命中的优先 → 先出现的（注册顺序）
//
//   ④ **强命中永远压过打分命中**
//      这就是「easyrpg 的 RPG_RT.ini 只命中 1/3，但 mkxpz 的四个文件全在场」时
//      必须选 mkxpz 的原因。
//
// ⚠️ 打分段的 `bestStart.fileMatches` 初值是 **-1**（不是 0）：
//    这样「第一个 score > 0 的规则」一定被选上，不会因为同分且 fileMatches 都是 0
//    而永远返回 nil。**上游就是这个初值，别改。**
//
// ===== ⚠️ R1：`.app` 包与「文件在子目录里」（三处细节，每处都有测试钉着）=====
//
//   ① **`.app` 是目录，探测点就是它本身，不是它的父目录**
//      `/x/Game.app` → 探测点 `/x/Game.app`
//      `/x/Game.exe` → 探测点 `/x`
//      漏掉的话：mac 的 Ren'Py / NW.js 包内文件探测会全落在父目录 → 一个都探不到。
//
//   ② **路径可能以斜杠结尾**：`/x/Game.app/` 也是 .app
//      取扩展名之前**必须先剥尾分隔符**，否则 `path.extname('/x/Game.app/')` = ""。
//      mac 上从 Finder 拖进来的路径**经常带尾斜杠**。
//
//   ③ 剥尾斜杠要正反斜杠都剥（Windows 上粘贴的路径可能是反斜杠）。
import Foundation

// MARK: - 路径工具

public enum DetectPath {

    /// 归一化扩展名：**不带点、小写**。
    ///
    /// 剥**任意多个**前导点：`.py` / `py` / `..py` 都是 `py`。
    /// **不剥中间的点**：`tar.gz` 保持 `gz`（取最后一段）。
    public static func normalizeExt(_ ext: String?) -> String {
        guard let ext, !ext.isEmpty else { return "" }
        var result = ext
        while result.hasPrefix(".") {
            result.removeFirst()
        }
        return result.lowercased()
    }

    /// 取路径扩展名（不带点、小写），**先剥尾分隔符**（R1 第 ② 条）。
    public static func pathExtLower(_ input: String?) -> String {
        guard let input else { return "" }
        var trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        // 剥正反斜杠尾缀
        while let last = trimmed.last, last == "/" || last == "\\" {
            trimmed.removeLast()
        }
        guard let dotIndex = trimmed.lastIndex(of: ".") else { return "" }
        return String(trimmed[trimmed.index(after: dotIndex)...]).lowercased()
    }

    /// 是不是 macOS 的 `.app` 包（**只看扩展名，不碰文件系统**）。
    ///
    /// 「不碰 fs」是有意的（上游注释就是 "by extension only"）：
    /// 好处是单测不依赖真实目录；坏处是 `MyFiles.app` 这种普通目录也会被判成 .app
    /// —— 那种名字在游戏库里不会出现，可接受。
    public static func isAppBundle(_ input: String?) -> Bool {
        normalizeExt(pathExtLower(input)) == "app"
    }

    /// 「探测 autodetect 的 files 时该看哪个目录」（R1 第 ① 条）。
    ///
    /// · `.app` 包 → **它自己**（包里才该有 `renpy/` / `package.json`）
    /// · 普通可执行文件 → 它的**父目录**
    public static func gameDirForFiles(_ exe: String) -> String {
        if isAppBundle(exe) {
            var trimmed = exe.trimmingCharacters(in: .whitespacesAndNewlines)
            while let last = trimmed.last, last == "/" || last == "\\" {
                trimmed.removeLast()
            }
            return trimmed
        }
        return (exe as NSString).deletingLastPathComponent
    }
}

// MARK: - 规则

/// 一条 autodetect 规则（manifest 与 registry 两个来源归一到这个形状）。
public struct DetectRule: Sendable, Equatable {
    public var extensions: [String]?
    /// 上游也支持单数 `extension`，两种都要认。
    public var extension_: String?
    /// **相对游戏目录**的路径列表。
    public var files: [String]?
    public var allRequired: Bool?

    public init(
        extensions: [String]? = nil,
        extension_: String? = nil,
        files: [String]? = nil,
        allRequired: Bool? = nil
    ) {
        self.extensions = extensions
        self.extension_ = extension_
        self.files = files
        self.allRequired = allRequired
    }

    /// 把扩展名统一成「不带点小写、去掉空项」的列表。
    var collectedExtensions: [String] {
        let raw: [String]
        if let extensions {
            raw = extensions
        } else if let extension_ {
            raw = [extension_]
        } else {
            raw = []
        }
        return raw.map { DetectPath.normalizeExt($0) }.filter { !$0.isEmpty }
    }
}

// MARK: - 识别器

public enum EngineDetector {

    /// 给所有规则打分，返回命中的最好的 key。
    ///
    /// - Parameters:
    ///   - exe: 可执行文件路径
    ///   - rules: 有序的 (key, rule) 列表。**顺序有意义**（同分时保持注册顺序）
    ///   - fileExists: 注入用（单测传假实现，生产传 FileManager）
    public static func pickBestRule(
        exe: String,
        rules: [(key: String, rule: DetectRule?)],
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) }
    ) -> String? {
        guard !exe.isEmpty else { return nil }

        let extOnPath = DetectPath.normalizeExt(DetectPath.pathExtLower(exe))
        let dir = DetectPath.gameDirForFiles(exe)

        var strongMatches: [(key: String, fileMatches: Int, extMatch: Bool)] = []
        var scored: [(key: String, score: Double, fileMatches: Int, extMatch: Bool, allRequired: Bool)] = []

        for (key, maybeRule) in rules {
            guard let rule = maybeRule else { continue }

            let extList = rule.collectedExtensions
            let hasExtRule = !extList.isEmpty
            let extMatch = hasExtRule ? extList.contains(extOnPath) : false

            // 文件探测：files 是**相对游戏目录**的路径
            let files = rule.files ?? []
            var fileMatches = 0
            for rel in files where !rel.isEmpty {
                let full = (dir as NSString).appendingPathComponent(rel)
                if fileExists(full) { fileMatches += 1 }
            }
            let fileTotal = files.count

            if rule.allRequired == true {
                // ① 硬门槛。空规则（既无扩展名也无文件）**通过** —— 上游两个 need 都是 true。
                let needExt = hasExtRule ? extMatch : true
                let needFiles = fileTotal > 0 ? (fileMatches == fileTotal) : true
                if needExt && needFiles {
                    scored.append((key, 0, fileMatches, extMatch, true))
                }
                continue
            }

            // ② 打分
            var score = 0.0
            if hasExtRule && extMatch { score += 1 }
            if fileTotal > 0 { score += Double(fileMatches) / Double(fileTotal) }
            if score > 0 {
                scored.append((key, score, fileMatches, extMatch, false))
            }
        }

        for item in scored where item.allRequired {
            strongMatches.append((item.key, item.fileMatches, item.extMatch))
        }

        // ③ 有强命中就只在强命中里挑（强命中永远压过打分命中）
        if !strongMatches.isEmpty {
            // 排序必须**稳定**：同分同扩展名时保持注册顺序（引擎页顺序）。
            // Swift 的 sort 不稳定，所以显式带原始 index。
            var indexed = strongMatches.enumerated().map { ($0.offset, $0.element) }
            indexed.sort { a, b in
                if b.1.fileMatches != a.1.fileMatches { return b.1.fileMatches < a.1.fileMatches }
                if a.1.extMatch != b.1.extMatch { return a.1.extMatch }
                return a.0 < b.0
            }
            return indexed.first?.1.key
        }

        // ④ 没强命中 → 打分取最高
        var best: (key: String, score: Double, fileMatches: Int, extMatch: Bool)?
        for item in scored {
            guard let current = best else {
                best = (item.key, item.score, item.fileMatches, item.extMatch)
                continue
            }
            if item.score > current.score {
                best = (item.key, item.score, item.fileMatches, item.extMatch)
                continue
            }
            if item.score == current.score {
                // 同分：文件命中数多优先，然后扩展名命中优先
                let better = item.fileMatches > current.fileMatches
                    || (item.fileMatches == current.fileMatches && item.extMatch && !current.extMatch)
                if better {
                    best = (item.key, item.score, item.fileMatches, item.extMatch)
                }
            }
        }
        return best?.key
    }
}
