// 「选文件 → 反推游戏目录」的判据（纯函数，唯一来源）。
//
// 对应 Electron 版：`src/shared/import-target.ts`（154 行 / 29 条单测）
// 契约：M5.0 S3（U5）
//
// ===== 为什么需要「反推」这一层 =====
//
// 去掉「选择文件夹」后，用户只能选**文件**。而引擎识别看的是「目录里有哪些文件」，
// 所以选任何一个标志性文件都能反推目录 —— 但有两个例外：
//
//   ① **用户选错文件**（`readme.txt`、`www/package.json` 之类）
//      文件本身认不出引擎，但它的**目录或上一层**就是游戏根。
//   ② **Ren'Py 的入口常在子目录**（`游戏名/game/script.rpy`）
//      直接取父目录得到 `游戏名/game`，而 `renpy/` 在 `游戏名/` 里 → 认不出来。
//
// 两例外都是同一个解法：**这一层认不出来就往上退一层再认**。
//
// ⚠️ **退几层必须有上限** —— 否则一路退到 `/Users` 甚至 `/`，
//    可能撞上完全无关目录里的残骸文件，认出一个「看起来对」的引擎。
//    上限 2 层的依据：
//      · Ren'Py 的 `game/xx.rpy` 只差 1 层
//      · mac 的 `Xxx.app/Contents/MacOS/xxx` 差 2 层
//    再深就不是「游戏目录」而是别的目录结构了。
import Foundation

public enum ImportTarget {

    /// 往上最多退几层。
    public static let maxAscend = 2

    /// 一次待识别的尝试：`level` 0 = 用户选的那个文件本身。
    public struct Attempt: Sendable, Equatable {
        /// 要交给识别器的路径（绝对路径）。
        public let path: String
        /// 0 = 选中的文件；1 = 它的目录；2 = 再上一层。
        public let level: Int

        public init(path: String, level: Int) {
            self.path = path
            self.level = level
        }
    }

    /// 去掉尾部分隔符（`/x/y/` → `/x/y`）。
    ///
    /// ⚠️ 根 `/` 这类保持原样 —— 全剥掉会变成空串，后续拼路径会出错。
    public static func stripTrailingSep(_ input: String?) -> String {
        guard var result = input?.trimmingCharacters(in: .whitespacesAndNewlines),
              !result.isEmpty else { return "" }
        while result.count > 1 {
            guard let last = result.last, last == "/" || last == "\\" else { break }
            result.removeLast()
        }
        return result
    }

    /// 生成要依次尝试的路径（从选中文件本身，逐层上退）。
    ///
    /// - Parameters:
    ///   - selectedPath: 用户选的文件（或目录）的绝对路径
    ///   - maxAscend: 最多退几层（注入用，测试可以传 0 验「不退」）
    ///
    /// - Returns: 尝试序列。**顺序有意义**：先试最具体的，再逐层上退。
    public static func attempts(
        selectedPath: String, maxAscend: Int = ImportTarget.maxAscend
    ) -> [Attempt] {
        let base = stripTrailingSep(selectedPath)
        guard !base.isEmpty else { return [] }

        var out: [Attempt] = [Attempt(path: base, level: 0)]
        var current = base

        // ⚠️ **`maxAscend <= 0` 必须直接返回**（不能写 `1...(max(maxAscend,0))`）：
        //    Swift 的 `1...0` 会**运行时 crash**（`Range requires lowerBound <= upperBound`），
        //    不是静默跳过。这个坑本鱼实测踩到过一次。
        guard maxAscend > 0 else { return out }

        for level in 1...maxAscend {
            let parent = (current as NSString).deletingLastPathComponent
            // 到根了（父目录等于自己）→ 停止，别再往上退
            if parent == current || parent.isEmpty || parent == "/" { break }
            out.append(Attempt(path: parent, level: level))
            current = parent
        }
        return out
    }

    /// 从「尝试序列」里挑出**第一个识别成功**的结果。
    ///
    /// - Parameter detect: 识别器。传进来是纯的，便于测试传假实现。
    ///
    /// - Returns: 成功的那次尝试；全失败返回 nil。
    ///
    /// ⚠️ **必须按顺序取第一个成功的**，不能「全都试一遍然后挑某个」——
    ///    越具体的路径越可能是用户真正的意图。比如用户选了
    ///    `游戏名/www/package.json`：level 0 认不出（package.json 本身不是判据），
    ///    level 1 是 `www/`（可能认不出），level 2 是 `游戏名/`（这里才对）。
    ///    如果先从 level 2 试，用户选了个子目录深一点的路径就可能认错。
    public static func resolve<T>(
        selectedPath: String,
        maxAscend: Int = ImportTarget.maxAscend,
        detect: (String) -> T?
    ) -> (attempt: Attempt, value: T)? {
        for attempt in attempts(selectedPath: selectedPath, maxAscend: maxAscend) {
            if let value = detect(attempt.path) {
                return (attempt, value)
            }
        }
        return nil
    }
}
