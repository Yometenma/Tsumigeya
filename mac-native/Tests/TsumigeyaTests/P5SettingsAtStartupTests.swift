// 「启动时必须读设置」的判据测试。
//
// ===== 用户 2026-11-06 报的 bug =====
//
// 「我在设置里设置过了以列表形式呈现，每次软件重新打开的还是卡片形式，
//   只有进一下设置再出来才正常」
//
// ===== 根因（与「关掉游戏还显示运行中」是同一类）=====
//
// `loadSettings()` **只在设置页的 `.task` 里被调用**。
// 启动时 `settings` 是空字典 → `settingBool(.listView)` 返回默认值
// → 卡片视图。进了一次设置页才顺带读一次，那时才对。
//
// ⚠️ `loadSettings()` 本身写得**完全正确** —— 问题是**调用点漏了**。
//    本鱼这已经是**第二次**犯（第一次是 refreshRunning）。
//
// ===== 所以本文件用源码扫描 =====
//
// 因为「某函数有没有被调用」在单元测试层面**完全不可见**：
// 编译通过、所有纯函数测试全绿，但功能就是不生效。
import Foundation
import Testing

@testable import TsumigeyaCore

@Suite("启动时必须读设置")
struct SettingsLoadedAtStartupTests {

    /// 读一个源文件。
    func source(_ relative: String) -> String? {
        let thisFile = URL(fileURLWithPath: #filePath)
        let packageRoot = thisFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let target = packageRoot.appendingPathComponent(relative)
        return try? String(contentsOf: target, encoding: .utf8)
    }

    /// 取出某个函数的**可执行代码**（跳过注释行）。
    func functionBody(_ source: String, signature: String) -> String? {
        let lines = source.components(separatedBy: .newlines)
        guard let start = lines.firstIndex(where: { $0.contains(signature) }) else {
            return nil
        }
        var body: [String] = []
        for idx in (start + 1)..<lines.count {
            let line = lines[idx]
            // 函数体结束：遇到下一个方法定义或 MARK
            if line.contains("// MARK:") || line.hasPrefix("    func ") { break }
            body.append(line)
        }
        // 去掉注释行
        let codeOnly = body.filter { line in
            let t = line.trimmingCharacters(in: .whitespaces)
            return !t.hasPrefix("//") && !t.hasPrefix("///") && !t.hasPrefix("*")
        }
        return codeOnly.joined(separator: "\n")
    }

    /// ⚠️⚠️ **`load()` 里必须调用 `loadSettings()`**。
    ///
    /// 守的是：只把它放在设置页里，启动时就不会读 —— 于是用户的设置
    /// 「只有进一次设置页才生效」。
    @Test("load 里读了设置")
    func loadReadsSettings() throws {
        let src = try #require(source("Sources/TsumigeyaApp/AppStore.swift"),
                               "读不到 AppStore.swift")
        let body = try #require(functionBody(src, signature: "func load() async"),
                                "找不到 func load() async")
        #expect(body.contains("loadSettings()"),
                "AppStore.load() 没有调用 loadSettings() —— 启动时读不到用户的设置")
    }

    /// ⚠️ **`load()` 里必须应用外观**（否则用户选了深色，重开还是跟随系统）。
    @Test("load 里应用了外观")
    func loadAppliesAppearance() throws {
        let src = try #require(source("Sources/TsumigeyaApp/AppStore.swift"),
                               "读不到 AppStore.swift")
        let body = try #require(functionBody(src, signature: "func load() async"),
                                "找不到 func load() async")
        #expect(body.contains("applyAppearance()"),
                "AppStore.load() 没有调用 applyAppearance() —— 主题在重启后不生效")
    }

    /// ⚠️ **设置页不应该再自己读设置**（读点只该有一个）。
    @Test("设置页不再是读取点")
    func settingsPageDoesNotReload() throws {
        let src = try #require(source("Sources/TsumigeyaApp/SettingsPage.swift"),
                               "读不到 SettingsPage.swift")
        let codeLines = src.components(separatedBy: .newlines).filter { line in
            let t = line.trimmingCharacters(in: .whitespaces)
            return !t.hasPrefix("//") && !t.hasPrefix("///")
        }
        let offenders = codeLines.filter { $0.contains("loadSettings()") }
        #expect(offenders.isEmpty,
                "SettingsPage 里还在调用 loadSettings() —— 读取点应该只在 AppStore.load()")
    }
}

// MARK: - 列表视图设置的默认值

@Suite("列表视图默认值")
struct ListViewDefaultTests {

    /// ⚠️ **`listView` 的默认值现在是「列表」**。
    ///
    /// 依据：卡片视图现在**没有封面**（P7 才接 DLsite），是半个空壳；
    /// 列表信息密度更高，也更适合用户的日文长标题
    /// （「～馬蹄通りの小聖女～」那种在卡片里两行截断很难看）。
    ///
    /// ⚠️ 这个默认值**不弥补读取失败** —— 那个 bug 必须靠 `load()` 里读设置修。
    ///    默认值只是决定「用户从未设置过时看到什么」。
    @Test("默认是列表")
    func defaultsToList() {
        #expect(SettingsDefaults.booleans[.listView] == true)
    }

    /// 用户显式设成 false（想用卡片）时要生效。
    @Test("显式 false 生效")
    func explicitFalse() {
        let settings: [String: JSONValue] = ["listView": .bool(false)]
        #expect(SettingsDefaults.boolean(.listView, from: settings) == false)
    }

    /// 显式 true 也生效。
    @Test("显式 true 生效")
    func explicitTrue() {
        let settings: [String: JSONValue] = ["listView": .bool(true)]
        #expect(SettingsDefaults.boolean(.listView, from: settings) == true)
    }
}
