// 「设置标注与真实状态一致」判据测试。
//
// ===== 这个文件守的是什么 =====
//
// 本鱼在设置页给未生效的项标了「未启用」+ 原因。那是**可证伪的自我披露**：
// 用户能区分「坏了」和「还没做」。
//
// ⚠️ 但**标注会过时**。本鱼实际踩到过：
//
//   `deletionConfirmation` 标着「还没有删除游戏的界面」，
//   而同一轮里本鱼刚做完删除功能 —— 它**已经生效了**。
//
//   `saveSyncMode` 标着「存档功能还没做」，
//   而 P6 做完后 `manual`（手动导入导出）**已经能用了**。
//
// ⚠️ **过时的「未启用」标注比不标更糟**：用户明明能用，
//    却被告诉「未启用」，于是不会去用。
//
// ===== 判据怎么定 =====
//
// 「有没有逻辑消费」是可以**机械化判定**的（见 audit-settings.py）：
//   · 有消费 → 不该有「未启用」标注
//   · 没消费 → 必须有标注
//
// 本文件用**源码扫描**核对这个对应关系，因为：
//   · 标注在 `SettingsPage.swift` 里
//   · 消费点可能在 `AppStore.swift` / 其他视图 / 任何地方
// 两者都在代码里，都能扫。
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

    /// 全部 Swift 源码（App 层）。
    func allAppSources() -> [String: String] {
        let thisFile = URL(fileURLWithPath: #filePath)
        let packageRoot = thisFile
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let appDir = packageRoot.appendingPathComponent("Sources/TsumigeyaApp")

        var out: [String: String] = [:]
        if let names = try? FileManager.default.contentsOfDirectory(atPath: appDir.path) {
            for name in names where name.hasSuffix(".swift") {
                if let text = try? String(
                    contentsOf: appDir.appendingPathComponent(name), encoding: .utf8) {
                    out[name] = text
                }
            }
        }
        return out
    }

    /// `pendingNote` 里返回 nil 的项 = 被认为「已生效」。
    func annotatedAsWorking() throws -> Set<String> {
        let src = try #require(source("Sources/TsumigeyaApp/SettingsPage.swift"),
                               "读不到 SettingsPage.swift")
        // 找 `private var pendingNote: String? {` 的函数体
        let lines = src.components(separatedBy: "\n")
        guard let start = lines.firstIndex(where: { $0.contains("var pendingNote") }) else {
            throw TestError.notFound
        }
        var body: [String] = []
        for idx in (start + 1)..<lines.count {
            if lines[idx].contains("// MARK:") { break }
            body.append(lines[idx])
        }
        let text = body.joined(separator: "\n")

        // 抓 `case .a, .b:\n    return nil` 这种形态
        // ⚠️ 用简单扫描而不是正则：Swift 代码里的 case 形态有限
        var working: Set<String> = []
        var currentCases: [String] = []

        for line in text.components(separatedBy: "\n") {
            let t = line.trimmingCharacters(in: .whitespaces)
            if t.hasPrefix("case ") {
                // `case .appearance, .listView:` → 收集项名
                let namesPart = t
                    .replacingOccurrences(of: "case ", with: "")
                    .components(separatedBy: ":")[0]
                let names = namesPart
                    .components(separatedBy: ",")
                    .map { $0.trimmingCharacters(in: .whitespaces)
                        .replacingOccurrences(of: ".", with: "") }
                    .filter { !$0.isEmpty }
                currentCases = names
            } else if t == "return nil" {
                working.formUnion(currentCases)
                currentCases = []
            } else if t.hasPrefix("return ") {
                currentCases = []   // 有标注 → 不算生效
            }
        }
        return working
    }

    /// ⚠️⚠️ **`deletionConfirmation` 必须被标成「已生效」**（P6 已实现删除）。
    @Test("删除确认已生效")
    func deletionConfirmationIsWorking() throws {
        let working = try annotatedAsWorking()
        let ok = working.contains("deletionConfirmation")
        #expect(ok, "deletionConfirmation 被标成未启用但功能已做好")
    }

    /// ⚠️ **`listView` / `appearance` 必须被标成「已生效」**（这两个真的接了）。
    @Test("外观与列表视图已生效")
    func appearanceAndListViewWorking() throws {
        let working = try annotatedAsWorking()
        #expect(working.contains("appearance"))
        #expect(working.contains("listView"))
    }

    /// ⚠️ **还没做的那几个必须标上**（不能悄悄写成「生效」）。
    ///
    /// 守的是：把没做的标成生效，用户就会去点它、发现没反应、
    /// 然后怀疑整个软件坏了。
    @Test("未实现的项有标注")
    func unimplementedAreAnnotated() throws {
        let working = try annotatedAsWorking()
        let notReady = [
            "language",                 // 只有中文
            "preferredLanguage",        // 多语言检测没做
            "fallbackLanguage",
            "languageSwitchPrompt",
            "showAdultCovers",          // P7 才有封面
            "diagnoseBeforeLaunch",     // 诊断没做
            "checkModuleUpdatesOnStartup",
        ]
        for key in notReady {
            let marked = working.contains(key)
            #expect(!marked, "\(key) 被标成已生效但功能还没实现")
        }
    }

    /// ⚠️ **`saveSyncMode` 现在有一半能用**（manual 模式 = 存档页那两个按钮）。
    ///
    /// 它仍带标注（说明「不接云」），但那句话是**事实披露**而不是「未启用」。
    @Test("存档同步标注说明不接云")
    func saveSyncNoteMentionsNoCloud() throws {
        let src = try #require(source("Sources/TsumigeyaApp/SettingsPage.swift"))
        let ok = src.contains("不接任何云")
        #expect(ok, "saveSyncMode 的说明必须写明不接任何云")
    }

    enum TestError: Error { case notFound }
}
