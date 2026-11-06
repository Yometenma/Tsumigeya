// 设置标注与真实状态一致：判据测试。
//
// ===== 这个文件守的是什么 =====
//
// 本鱼在设置页给未生效的项标了「未启用」+ 原因。那是可证伪的自我披露：
// 用户能区分「坏了」和「还没做」。
//
// 但标注会过时，而且标注本身也会说谎。本鱼实际踩到过两次：
//
// 1. deletionConfirmation 标着「还没有删除游戏的界面」，而同一轮刚做完删除。
// 2. saveSyncMode 标着「只有手动模式能用」，但一律渲染成「未启用」胶囊 ——
//    用户直接问「开关开着的时候为什么还是显示未启用」。
//
// 第 2 个的根因更根本：只有一个字符串，两种语义被混成一个标签。
// 「功能没做」和「能用但有须知」被同一句「未启用」否定了。
//
// 修法：Note 带 isNotImplemented 标记，.caveat 不挂胶囊。
import Foundation
import Testing

@testable import TsumigeyaCore

@Suite("设置标注与实际状态一致")
struct SettingsAnnotationConsistencyTests {

    func source(_ relative: String) -> String? {
        let thisFile = URL(fileURLWithPath: #filePath)
        let packageRoot = thisFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return try? String(contentsOf: packageRoot.appendingPathComponent(relative),
                           encoding: .utf8)
    }

    /// pendingNote 里被当成「能用」的项。
    ///
    /// 「能用」= return nil（无需说明）或 return .caveat(...)（有须知但能用）。
    func annotatedAsWorking() throws -> Set<String> {
        let src = try #require(source("Sources/TsumigeyaApp/SettingsPage.swift"),
                               "读不到 SettingsPage.swift")
        let lines = src.components(separatedBy: .newlines)
        guard let start = lines.firstIndex(where: { $0.contains("var pendingNote") }) else {
            throw TestError.notFound
        }
        // ⚠️ **终止条件不能用 `// MARK:`**（本鱼实测踩到）。
        //
        //    那条 MARK 注释本身可能被清理脚本删掉（它属于「历史型」块），
        //    删了之后扫描会跑出整个文件 → 收集到后面无关的 `case` →
        //    测试假失败。
        //
        //    改用「**函数体的右括号**」作为终止条件：数花括号深度，
        //    回到 0 就停。这才是不依赖注释的结构判据。
        var body: [String] = []
        var depth = 0
        for idx in (start + 1)..<lines.count {
            let line = lines[idx]
            body.append(line)
            for ch in line {
                if ch == "{" { depth += 1 }
                else if ch == "}" {
                    depth -= 1
                    if depth <= 0 { break }
                }
            }
            if depth <= 0 && body.count > 1 { break }
        }
        let text = body.joined(separator: "\n")

        var working: Set<String> = []
        var currentCases: [String] = []

        for line in text.components(separatedBy: .newlines) {
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("case ") {
                let namesPart = t
                    .replacingOccurrences(of: "case ", with: "")
                    .components(separatedBy: ":")[0]
                let names = namesPart
                    .components(separatedBy: ",")
                    .map {
                        $0.trimmingCharacters(in: .whitespaces)
                            .replacingOccurrences(of: ".", with: "")
                    }
                    .filter { !$0.isEmpty }
                currentCases = names
            } else if t == "return nil" {
                working.formUnion(currentCases)
                currentCases = []
            } else if t.hasPrefix("return .caveat") || t.hasPrefix("return Note.caveat") {
                // .caveat 也算能用 —— 那只是「有个须知」。
                // 用户报的「开关开着还显示未启用」就是把它误判成未实现的后果。
                working.formUnion(currentCases)
                currentCases = []
            } else if t.hasPrefix("return .notImplemented")
                        || t.hasPrefix("return Note.notImplemented")
                        || t.hasPrefix("return ") {
                currentCases = []
            }
        }
        return working
    }

    /// deletionConfirmation 必须被标成「已生效」（P6 已实现删除）。
    @Test("删除确认已生效")
    func deletionConfirmationIsWorking() throws {
        let working = try annotatedAsWorking()
        let ok = working.contains("deletionConfirmation")
        #expect(ok, "deletionConfirmation 被标成未启用但功能已做好")
    }

    /// listView / appearance 必须被标成「已生效」。
    @Test("外观与列表视图已生效")
    func appearanceAndListViewWorking() throws {
        let working = try annotatedAsWorking()
        let a = working.contains("appearance")
        let l = working.contains("listView")
        #expect(a, "appearance 被标成未启用但主题切换已生效")
        #expect(l, "listView 被标成未启用但列表卡片切换已生效")
    }

    /// saveSyncMode 必须被算成「能用」（用户报的那个 bug）。
    ///
    /// 它用 .caveat（「只有手动模式能用；不接任何云」）——
    /// 那是事实披露，不是「未启用」。
    @Test("存档同步算能用")
    func saveSyncModeIsWorking() throws {
        let working = try annotatedAsWorking()
        let ok = working.contains("saveSyncMode")
        #expect(ok, "saveSyncMode 被标成未启用但 P6 之后 manual 模式真能用")
    }

    /// 还没做的那几个必须标成未实现。
    @Test("未实现的项有标注")
    func unimplementedAreAnnotated() throws {
        let working = try annotatedAsWorking()
        let notReady = [
            "language",
            "preferredLanguage",
            "fallbackLanguage",
            "languageSwitchPrompt",
            "showAdultCovers",
            "diagnoseBeforeLaunch",
            "checkModuleUpdatesOnStartup",
            "nonInstalledAutodetect",
        ]
        for key in notReady {
            let marked = working.contains(key)
            #expect(!marked, "该项被标成能用但功能还没实现")
        }
    }

    /// 两种语义必须用不同的渲染方式（胶囊只给「未启用」）。
    @Test("胶囊只给未实现")
    func capsuleOnlyForUnimplemented() throws {
        let src = try #require(source("Sources/TsumigeyaApp/SettingsPage.swift"))
        let conditional = src.contains("if note.isNotImplemented")
        #expect(conditional)
    }

    /// saveSyncMode 的说明必须写明「不接任何云」（D83）。
    @Test("存档同步说明不接云")
    func saveSyncNoteMentionsNoCloud() throws {
        let src = try #require(source("Sources/TsumigeyaApp/SettingsPage.swift"))
        let ok = src.contains("不接任何云")
        #expect(ok, "saveSyncMode 的说明必须写明不接任何云（D83）")
    }

    enum TestError: Error { case notFound }
}
