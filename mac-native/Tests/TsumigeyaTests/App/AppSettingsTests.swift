import AppKit
import Foundation
import Testing
@testable import TsumigeyaApp
@testable import TsumigeyaCore

@Suite("应用设置读写", .serialized)
@MainActor
struct AppSettingsTests {
    private func directory() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-app-settings-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    @Test("修改设置后新实例读回用户选择，嵌套未知字段原样保留")
    func changesSurviveRestartWithoutLosingUnknownFields() async throws {
        let dir = try directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("global-settings.json")
        let extensionValue = JSONValue.object([
            "enabled": .bool(false), "options": .array([.string("保留"), .int(3)])
        ])
        let original: [String: JSONValue] = [
            "appearance": .string("system"), "listView": .bool(true),
            "darkTheme": .bool(false), "future": extensionValue
        ]
        try #require(JSONStore.save(original, to: url) == nil)
        let store = AppStore()
        await store.load(dataDirectory: dir.path)
        #expect(store.settingBool(.listView))
        store.setSetting(.listView, .bool(false))
        #expect(store.operationError == nil)
        #expect(!store.settingBool(.listView))
        var expected = original
        expected["listView"] = .bool(false)
        #expect(JSONStore.load([String: JSONValue].self, from: url).value == expected)

        let restarted = AppStore()
        await restarted.load(dataDirectory: dir.path)
        #expect(!restarted.settingBool(.listView))
        #expect(restarted.settings == expected)
    }

    @Test("缺失与损坏设置通过真实加载回落默认值，损坏原件不改写")
    func missingAndCorruptSettingsUseDefaults() async throws {
        let dir = try directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("global-settings.json")
        let store = AppStore()
        await store.load(dataDirectory: dir.path)
        #expect(store.settingBool(.listView))
        #expect(store.settingString(.appearance) == "system")
        #expect(!FileManager.default.fileExists(atPath: url.path))

        // 先装入非默认值，再重读坏文件，才能发现残留的旧内存设置。
        try #require(JSONStore.save(["listView": JSONValue.bool(false)], to: url) == nil)
        await store.load(dataDirectory: dir.path)
        try #require(!store.settingBool(.listView))
        let original = Data("{broken".utf8)
        try original.write(to: url)
        await store.load(dataDirectory: dir.path)
        #expect(store.settings.isEmpty)
        #expect(store.settingBool(.listView))
        #expect(store.settingString(.appearance) == "system")
        #expect(try Data(contentsOf: url) == original)
    }

    @Test("启动立即应用深色、浅色和跟随系统，不依赖打开设置页")
    func startupAppliesAppearance() async throws {
        let dir = try directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let app = NSApplication.shared
        let previous = app.appearance
        defer { app.appearance = previous }
        let url = dir.appendingPathComponent("global-settings.json")
        let cases: [(String, NSAppearance.Name?)] = [
            ("dark", .darkAqua), ("light", .aqua), ("system", nil)
        ]
        for (mode, expected) in cases {
            // 每次先设成不同的外观，省掉启动副作用时必须失败。
            app.appearance = NSAppearance(named: expected == .aqua ? .darkAqua : .aqua)
            try #require(JSONStore.save(["appearance": JSONValue.string(mode)], to: url) == nil)
            let store = AppStore()
            await store.load(dataDirectory: dir.path)
            #expect(store.settingString(.appearance) == mode)
            #expect(app.appearance?.name == expected)
        }
    }

    @Test("常用设置可操作，未实现的选项不伪装成可用")
    func availableSettingsMatchWorkingFeatures() {
        let available = Set(SettingsGroups.Key.allCases.filter { SettingRow(key: $0).isAvailable })
        #expect(available == Set([SettingsGroups.Key.appearance, .listView, .deletionConfirmation, .saveSyncMode]).union(SettingsGroups.group(.metadata)?.keys ?? []))
    }
}
