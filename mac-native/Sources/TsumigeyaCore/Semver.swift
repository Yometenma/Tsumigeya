// 版本号比较（正式的、完整的那一份）。
//
// 对应 Electron 版：src/main/engines/semver.ts（169 行）
// 单测：test/engines-semver.test.ts（26 条）+ mac-native 的 P3SemverTests.swift
//
// ===== 这个文件替代了什么 =====
//
// `LaunchCheck.swift` 里原来有一个 15 行的 `compareVersions`（只支持「剥 v 前缀 +
// 按 `.` 切数字段 + 缺段补 0」）。它够用来排序 nwjs 的版本目录（`v0.106.1` 这种），
// 但**不是** Electron 版的那份语义：
//
//   · 它把非数字段整段当 0（`1.2.3-beta` 会变成 1.2.3）→ 与正式版相等
//   · 它没有预发布段的概念 → `1.0.0-beta.1` == `1.0.0`，而 semver 要求前者更小
//   · 它不处理 build metadata（`1.0.0+build.5` 会被 `Int("0+build")` 判成 0）
//
// 所以抽到这里，按 semver.ts **逐条对齐**实现；`LaunchCheck` 改成用这份。
// nwjs 的版本目录名全是 `v0.106.1` 这种纯数字形态，新实现给它们的排序结果**与该旧实现
// 完全一致**（有测试专门钉住这条：`dirs.max { compareVersions($0,$1) < 0 }` 的行为不能变）。
//
// ===== 必须保留的三条语义（改了用户的既有行为就变）=====
//
//   ① **剥前导 v**：`v0.106.1` 与 `0.106.1` 相等。
//      依据：nwjs 的依赖名就叫 `version/v0.106.1`，而 manifest 的 version 字段是
//      `1.4.4` 这种不带 v 的写法，两边混着比是常态。
//
//   ② **位数不等时补 0**：`1.2` == `1.2.0`，`1.2` < `1.2.1`。
//      依据：上游 manifest 里出现过 `8.5` 与 `8.5.2` 两种写法。
//
//   ③ **数字段排在字符串段之上**（不是「忽略非数字段」）。
//      这就是「1.0.0 > 1.0.0-beta.1」成立的原因：pre 段被解析成字符串段，
//      而数字段永远更大 → 正式版压过预发布版。这条**正是 semver 的排序**。
//
// ===== 边界：不做什么 =====
//
//   · **不比较 build metadata**（`1.0.0+build.5` 的 `+` 之后一律忽略）。
//     semver 规定它不参与排序；上游也没处理，忽略不会变坏。
//   · **不做版本号合法性校验**。传进来 `"garbage"` 不抛错，会被当成「一个没有数字段的
//     版本」比大小。理由：本地 manifest 的 version 可能是用户从旧版升级上来的任意字符串，
//     比大小是**尽力而为** —— 抛错会让整个更新检查因为「某个旧引擎的 version 字段脏了」
//     而失败，那比「比错」更糟。（脏值的提示由调用方按 `N/A` 兜底，见 `hasUpdate`。）
//
// ===== 一处**有意**与上游字面实现不同，但结果相同 =====
//
// 上游把 `1.0.0-beta.1` 按 `.` 拆成 `["1","0","0-beta","1"]`（`-` 留在段里），
// 靠「`0-beta` 是字符串段」这个巧合得到正确结果。这里按 semver §11 显式拆成
// core / pre 两段 —— 同一条规则，但读代码的人看得出「这是在比预发布」。
// 在 prüfung 用到的输入上两者结果**完全一致**（26 条 Electron 测试全部等价通过）。
import Foundation

// MARK: - 解析

/// 拆开后的版本号：核心段 + 预发布段。
///
/// `pre == nil` 表示这是**正式版** —— 这个区别是「正式版 vs 预发布版」的唯一信号，
/// 不能省（省了 `1.0.0` 与 `1.0.0-beta` 就分不开了）。
public struct ParsedVersion: Sendable, Equatable {
    /// 核心段（`.` 分隔），每段是「数字或字符串」。空串按 0。
    public var core: [VersionIdentifier]
    public var pre: [VersionIdentifier]?

    public init(core: [VersionIdentifier], pre: [VersionIdentifier]? = nil) {
        self.core = core
        self.pre = pre
    }
}

/// 一个版本段：要么是数字（`1`），要么是字符串（`beta`）。
///
/// ⚠️ 必须保持这个区分：`compareIdentifier` 的三条规则全靠它 ——
/// 「数字 > 字符串」就是「正式版 > 预发布版」的实现方式。
public enum VersionIdentifier: Sendable, Equatable {
    case number(Int)
    case text(String)

    /// 纯数字（且非空）→ 数字；其余原样保留成字符串。
    ///
    /// 空串 → 数字 0（`1..2` 这种脏值不炸）。
    /// 前导零按数值（`01` == `1`）—— 与上游 `Number(raw)` 一致。
    public init(_ raw: String) {
        if raw.isEmpty {
            self = .number(0)
        } else if raw.allSatisfy({ $0.isASCII && $0.isNumber }) {
            // ⚠️ 用 `Int(raw)` 而不是 `Double`：版本号段不会有小数，Int 不会丢精度；
            //    Int 装不下的超长数字（20 位以上）退化成 0 —— 那种输入本身不是版本号。
            self = .number(Int(raw) ?? 0)
        } else {
            self = .text(raw)
        }
    }

    /// 给测试与排障看的原样描述。
    public var displayValue: String {
        switch self {
        case .number(let n): return "\(n)"
        case .text(let t): return t
        }
    }
}

public enum Semver {

    /// 剥前导 `v` / `V`，并 trim（上游 `normalizeVer` 的等价物）。
    ///
    /// ⚠️ **只剥开头一个**：`vv1.0` → `v1.0`（上游用 `^[vV]`，不是 `^[vV]+`）。
    ///    有了这条，`vv1.0` 会被当成「字符串段 v1」参与比较，而不是被剥成 `1.0`。
    public static func normalize(_ value: String?) -> String {
        var text = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasPrefix("v") || text.hasPrefix("V") {
            text.removeFirst()
            // 上游剥完还会 trim 一次（`' v 1.4.4 '` 这种脏输入）
            text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return text
    }

    /// 把一个 `.` 分隔的部分拆成标识符数组。
    static func splitIdentifiers(_ part: String) -> [VersionIdentifier] {
        part.split(separator: ".", omittingEmptySubsequences: false).map { VersionIdentifier(String($0)) }
    }

    /// 解析版本号：`[v]core[-pre][+build]`。
    ///
    /// - Parameter value: 任意字符串（`nil` / 空串都会被当成「空版本」= 全 0）。
    /// - Returns: 核心段 + 可选预发布段；`+build` 已被截掉。
    public static func parse(_ value: String?) -> ParsedVersion {
        let normalized = normalize(value)
        // 先截 build metadata（它在 `+` 之后，可能出现在 pre 之后）
        let withoutBuild: String
        if let plus = normalized.firstIndex(of: "+") {
            withoutBuild = String(normalized[normalized.startIndex..<plus])
        } else {
            withoutBuild = normalized
        }
        if let dash = withoutBuild.firstIndex(of: "-") {
            return ParsedVersion(
                core: splitIdentifiers(String(withoutBuild[withoutBuild.startIndex..<dash])),
                pre: splitIdentifiers(String(withoutBuild[withoutBuild.index(after: dash)...]))
            )
        }
        return ParsedVersion(core: splitIdentifiers(withoutBuild))
    }

    /// 比较两个标识符（数字 / 字符串混合）。
    ///
    /// 三条规则，缺一不可：
    ///   · 两个都是数字 → 比数值
    ///   · 两个都是字符串 → 按码位比（`beta` < `rc`，与 semver 的 ASCII 排序一致）
    ///   · 混合 → **数字更大**（这就是「正式版 > 预发布版」的实现方式）
    static func compareIdentifier(_ a: VersionIdentifier, _ b: VersionIdentifier) -> Int {
        switch (a, b) {
        case (.number(let x), .number(let y)):
            return x == y ? 0 : (x > y ? 1 : -1)
        case (.text(let x), .text(let y)):
            if x == y { return 0 }
            // ⚠️ 用 `<` 而不是 `compare(_:)`：Swift 的 String `<` 是 Unicode 标量序，
            //    与 JS 的 `a > b`（UTF-16 码位序）在纯 ASCII 上完全一致。
            //    版本标识符只可能是 ASCII 字母数字，不需要处理代理对。
            return x < y ? -1 : 1
        case (.number, .text):
            return 1
        case (.text, .number):
            return -1
        }
    }

    /// 比较两个版本号：`a > b` → 1，`a < b` → -1，相等 → 0。
    ///
    /// 三级比较，前一级相等才看下一级：
    ///   ① 核心段（缺段补 0，所以 `1.2` == `1.2.0`）
    ///   ② 预发布段：**没有预发布段的那一方更大**（`1.0.0` > `1.0.0-beta.1`）
    ///   ③ 预发布标识符逐个比；全部相同则段数少的更小
    ///
    /// - Parameters:
    ///   - a: 左边版本（`nil` / 空串 = 空版本，按全 0 处理，**不抛错**）
    ///   - b: 右边版本
    public static func compare(_ a: String?, _ b: String?) -> Int {
        let left = parse(a)
        let right = parse(b)

        let length = max(left.core.count, right.core.count)
        for index in 0..<length {
            // 缺段补 0：这是「位数不等」那条语义的落点
            let leftPart = index < left.core.count ? left.core[index] : .number(0)
            let rightPart = index < right.core.count ? right.core[index] : .number(0)
            let compared = compareIdentifier(leftPart, rightPart)
            if compared != 0 { return compared }
        }

        // 核心段相等 → 正式版（无 pre）大于预发布版
        switch (left.pre, right.pre) {
        case (nil, nil): return 0
        case (nil, _): return 1
        case (_, nil): return -1
        case (let l?, let r?):
            let preLength = max(l.count, r.count)
            for index in 0..<preLength {
                // 段数不同：前缀全部相等时，**段数少的更小**（semver §11.4.4）
                guard index < l.count else { return -1 }
                guard index < r.count else { return 1 }
                let compared = compareIdentifier(l[index], r[index])
                if compared != 0 { return compared }
            }
            return 0
        }
    }

    /// 「有更新吗」—— `remote` 是否比 `current` 新。
    ///
    /// ⚠️ **两个 `N/A` 兜底必须保留**（上游 `hasUpdate` 的前两行）：
    ///   · 本地没装 / 没版本 → 谈不上「有更新」
    ///   · 期望版本未知 → 不能报「有更新」（否则引擎页会挂一个永远消不掉的红点）
    ///
    /// 传 `nil` / 空串 / `"N/A"` 都返回 `false`，而不是把空串当 0 去比 ——
    /// 后者会让「本地版本丢了」被误判成「有更新」。
    ///
    /// - Parameters:
    ///   - current: 本地已装的版本（`nil` = 没装）
    ///   - remote: 期望版本（`nil` = 不知道期望什么）
    public static func hasUpdate(current: String?, remote: String?) -> Bool {
        let local = normalize(current)
        let target = normalize(remote)
        if local.isEmpty || local == "N/A" { return false }
        if target.isEmpty || target == "N/A" { return false }
        return compare(target, local) > 0
    }
}

// MARK: - 顶层便捷函数（与 Electron 版的导出名对齐）

/// 比较两个版本号（`compareVersions(a, b)`，与 Electron 版同名同义）。
///
/// `- Returns:` `a > b` 返回 1，`a < b` 返回 -1，相等返回 0。
public func compareVersions(_ a: String, _ b: String) -> Int {
    Semver.compare(a, b)
}

/// 「有更新吗」的顶层便捷版（`hasUpdate(current:remote:)`）。
public func hasUpdate(current: String?, remote: String?) -> Bool {
    Semver.hasUpdate(current: current, remote: remote)
}
