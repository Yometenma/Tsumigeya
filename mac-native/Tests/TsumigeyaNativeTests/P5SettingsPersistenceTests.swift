// 设置读写的端到端测试。
//
// 对应 Electron 版：settings 相关的 store 测试
//
// ===== 本文件要回答的问题 =====
//
// 「设置改了之后，真的存下来了吗？再读一遍能读到吗？」
//
// ⚠️ 这个问题必须用**真文件**测，不能用假实现：
//    设置的读写路径是 `AppStore`（在 App target，测试拿不到）→
//    但它的底层是 `JSONStore`（在 Core），那层可以测。
//
// → 本文件测的是「**读写往返 + 未知键保留**」这条底层契约。
//    `AppStore.setSetting` 的语义（立刻落盘）由这条契约保证。
import Foundation
import Testing

@testable import TsumigeyaCore

@Suite("设置读写")
struct SettingsPersistenceTests {

    func makeTempDir() throws -> String {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-settings-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.path
    }

    /// 基本往返：写进去、读回来。
    @Test("设置读写往返")
    func roundtrip() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(atPath: dir) }

        let url = URL(fileURLWithPath: dir)
            .appendingPathComponent("global-settings.json")

        let settings: [String: JSONValue] = [
            "appearance": .string("dark"),
            "listView": .bool(true),
            "showAdultCovers": .bool(false),
        ]
        #expect(JSONStore.save(JSONValue.object(settings), to: url) == nil)

        guard case .loaded(let back) = JSONStore.load(
            [String: JSONValue].self, from: url) else {
            Issue.record("读不出来"); return
        }
        #expect(back["appearance"]?.stringValue == "dark")
        #expect(back["listView"]?.boolValue == true)
        #expect(back["showAdultCovers"]?.boolValue == false)
    }

    /// ⚠️ **未知键必须保留**（D10 的取向）。
    ///
    /// 守的是：用户从 Electron 版带来的设置（比如 `darkTheme`、
    /// `dataDirNoticeShown`）不能在 Swift 版写一次设置后就消失。
    /// 实机数据里真的有这两个键（本鱼查过 `global-settings.json`）。
    @Test("未知键在读写后保留")
    func preservesUnknownKeys() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(atPath: dir) }

        let url = URL(fileURLWithPath: dir)
            .appendingPathComponent("global-settings.json")

        // 模拟真实文件（含 Swift 版不认识的键）
        let original: [String: JSONValue] = [
            "appearance": .string("system"),
            "darkTheme": .bool(false),          // ← 旧版遗留
            "dataDirNoticeShown": .bool(true),  // ← 旧版遗留
            "showAdultCovers": .bool(true),
        ]
        #expect(JSONStore.save(JSONValue.object(original), to: url) == nil)

        // 改一个认识的值，整体写回
        var updated = original
        updated["appearance"] = .string("dark")
        #expect(JSONStore.save(JSONValue.object(updated), to: url) == nil)

        guard case .loaded(let back) = JSONStore.load(
            [String: JSONValue].self, from: url) else {
            Issue.record("读不出来"); return
        }
        #expect(back["appearance"]?.stringValue == "dark")
        #expect(back["darkTheme"]?.boolValue == false, "旧版遗留的键不能丢")
        #expect(back["dataDirNoticeShown"]?.boolValue == true)
    }

    /// 设置读出来后，默认值解析要对。
    @Test("从真实设置文件解析默认值")
    func defaultsFromRealFile() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(atPath: dir) }

        let url = URL(fileURLWithPath: dir)
            .appendingPathComponent("global-settings.json")

        // 只写了两个键 —— 其余该回落到默认
        let partial: [String: JSONValue] = [
            "appearance": .string("light"),
            "showAdultCovers": .bool(false),
        ]
        #expect(JSONStore.save(JSONValue.object(partial), to: url) == nil)

        guard case .loaded(let settings) = JSONStore.load(
            [String: JSONValue].self, from: url) else {
            Issue.record("读不出来"); return
        }

        #expect(SettingsDefaults.string(.appearance, from: settings) == "light")
        // 没写的 → 默认
        #expect(SettingsDefaults.string(.saveSyncMode, from: settings) == "none")
        // 缺省当开的 → true
        #expect(SettingsDefaults.boolean(.diagnoseBeforeLaunch, from: settings) == true)
        // 普通布尔项 → 按表
        #expect(SettingsDefaults.boolean(.showAdultCovers, from: settings) == false)
        #expect(SettingsDefaults.boolean(.deletionConfirmation, from: settings) == true)
    }

    /// 文件损坏时回落到空（不能让设置页打不开）。
    @Test("损坏文件回落空")
    func corruptFallsBackToEmpty() throws {
        let dir = try makeTempDir()
        defer { try? FileManager.default.removeItem(atPath: dir) }

        let url = URL(fileURLWithPath: dir)
            .appendingPathComponent("global-settings.json")
        try "{ not json".write(to: url, atomically: true, encoding: .utf8)

        // 读失败 → 用空字典（所有项回落到默认值）
        let settings: [String: JSONValue] =
            if case .loaded(let m) = JSONStore.load([String: JSONValue].self, from: url) {
                m
            } else {
                [:]
            }
        #expect(settings.isEmpty)
        // 默认值仍然可用（页面不会崩）
        #expect(SettingsDefaults.string(.appearance, from: settings) == "system")
    }
}
