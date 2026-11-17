import AppKit
import Foundation
import SwiftUI
import Testing
import Vision
@testable import TsumigeyaCore
@testable import TsumigeyaApp

@Suite("隐私呈现规则")
struct LibraryPrivacyTests {
    private let game = GameRecord(id: "17", gameTitle: "敏感作品标题", gamePath: "/作品/Game.exe", gameEngine: "nwjs")
    private let cover = "https://img.dlsite.jp/modpub/images2/work/doujin/RJ123000/RJ123456_img_main.jpg"

    @Test("开关组合：只在隐私模式生效时隐藏标题，封面不依赖分级", arguments: [false, true], [false, true])
    func combinations(enabled: Bool, titles: Bool) {
        let privacy = LibraryPrivacy(settings: ["privacyMode": .bool(enabled), "privacyHideTitles": .bool(titles)])
        #expect(privacy.isEnabled == enabled)
        #expect(privacy.hidesTitles == (enabled && titles))
        #expect(privacy.title(for: game) == (enabled && titles ? "游戏 17" : game.gameTitle))
        #expect(privacy.text(game.gamePath) == (enabled && titles ? "已隐藏" : game.gamePath))
        #expect(privacy.coverURL(cover) == (enabled ? nil : URL(string: cover)))
        #expect(privacy.coverURL(nil) == nil)
    }

    @Test("缺省保持原有显示，非法类型不意外开启标题隐藏")
    func defaultsAndInvalidTypes() {
        for settings: [String: JSONValue] in [[:], ["privacyMode": .string("true"), "privacyHideTitles": .int(1)]] {
            let privacy = LibraryPrivacy(settings: settings)
            #expect(!privacy.isEnabled)
            #expect(!privacy.hidesTitles)
            #expect(privacy.title(for: game) == game.gameTitle)
        }
    }

    @Test("兼容旧隐藏封面选择，新开关明确覆盖旧选择")
    func legacyPreference() {
        #expect(LibraryPrivacy(settings: ["showAdultCovers": .bool(false)]).isEnabled)
        #expect(!LibraryPrivacy(settings: ["showAdultCovers": .bool(true)]).isEnabled)
        #expect(!LibraryPrivacy(settings: ["showAdultCovers": .bool(false), "privacyMode": .bool(false)]).isEnabled)
        #expect(LibraryPrivacy(settings: ["showAdultCovers": .bool(true), "privacyMode": .bool(true)]).isEnabled)
    }

    @Test("封面请求入口继续执行 host 白名单")
    func coverWhitelist() {
        let privacy = LibraryPrivacy(settings: [:])
        #expect(privacy.coverURL("https://example.com/private.png") == nil)
        #expect(privacy.coverURL("file:///tmp/private.png") == nil)
        #expect(privacy.coverURL("//img.dlsite.jp/cover.jpg")?.scheme == "https")
    }
}

@MainActor
private final class PrivacyFixture {
    let directory: URL
    let store = AppStore()
    let game: GameRecord
    let marker = "PRIVATE GAME TITLE"
    let cover = "https://img.dlsite.jp/cover-before.jpg"

    init() throws {
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("tsmg-privacy-" + UUID().uuidString)
        game = GameRecord(id: "17", gameTitle: marker, gamePath: "/私人作品/PRIVATE GAME TITLE/Game.exe", gameEngine: "nwjs")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try #require(JSONStore.save(GameMap(games: [game.id: game]), to: directory.appendingPathComponent("games.json")) == nil)
    }

    func setMeta(cover: String?) throws {
        let meta = GameDlsiteMeta(work: DlsiteWork(
            rj: "RJ123456", title: marker, circle: marker, coverUrl: cover,
            description: marker, fetchedAt: "2026-11-16"))
        try #require(store.updateMeta(gameId: game.id, meta: meta))
    }

    func cleanup() { try? FileManager.default.removeItem(at: directory) }
}

@Suite("应用隐私状态与真实视图", .serialized)
@MainActor
struct AppPrivacyTests {
    @Test("开关持久化且不改写游戏与元数据，未知设置保留")
    func persistenceAndDataPreservation() async throws {
        let fixture = try PrivacyFixture()
        defer { fixture.cleanup() }
        let url = fixture.directory.appendingPathComponent("global-settings.json")
        try #require(JSONStore.save(["future": JSONValue.object(["keep": .int(7)])], to: url) == nil)
        await fixture.store.load(dataDirectory: fixture.directory.path)
        try fixture.setMeta(cover: fixture.cover)
        let gamesURL = fixture.directory.appendingPathComponent("games.json")
        let metaURL = fixture.directory.appendingPathComponent("library-meta.json")
        let gamesBefore = try Data(contentsOf: gamesURL)
        let metaBefore = try Data(contentsOf: metaURL)
        fixture.store.setSetting(.privacyHideTitles, .bool(true))
        fixture.store.togglePrivacyMode()
        #expect(fixture.store.displayTitle(for: fixture.game) == "游戏 17")
        #expect(fixture.store.artworkURL(for: fixture.game) == nil)
        let restarted = AppStore()
        await restarted.load(dataDirectory: fixture.directory.path)
        #expect(restarted.privacy.isEnabled)
        #expect(restarted.privacy.hidesTitles)
        #expect(restarted.settings["future"] == .object(["keep": .int(7)]))
        restarted.togglePrivacyMode()
        #expect(restarted.displayTitle(for: fixture.game) == fixture.marker)
        #expect(restarted.settingBool(.privacyHideTitles))
        #expect(restarted.artworkURL(for: fixture.game)?.absoluteString == fixture.cover)
        #expect(try Data(contentsOf: gamesURL) == gamesBefore)
        #expect(try Data(contentsOf: metaURL) == metaBefore)
    }

    @Test("隐私开启后的晚到元数据不能重新提供封面地址")
    func lateMetadataRemainsHidden() async throws {
        let fixture = try PrivacyFixture()
        defer { fixture.cleanup() }
        await fixture.store.load(dataDirectory: fixture.directory.path)
        try fixture.setMeta(cover: fixture.cover)
        #expect(fixture.store.artworkURL(for: fixture.game)?.absoluteString == fixture.cover)
        fixture.store.togglePrivacyMode()
        try fixture.setMeta(cover: "https://img.dlsite.jp/late-cover.jpg")
        #expect(fixture.store.artworkURL(for: fixture.game) == nil)
        fixture.store.togglePrivacyMode()
        #expect(fixture.store.artworkURL(for: fixture.game)?.absoluteString == "https://img.dlsite.jp/late-cover.jpg")
    }

    @Test("损坏设置不覆盖原件，也不发布已保存的假状态")
    func failedSave() async throws {
        let fixture = try PrivacyFixture()
        defer { fixture.cleanup() }
        await fixture.store.load(dataDirectory: fixture.directory.path)
        let url = fixture.directory.appendingPathComponent("global-settings.json")
        let corrupt = Data("{broken".utf8)
        try corrupt.write(to: url)
        fixture.store.togglePrivacyMode()
        #expect(!fixture.store.privacy.isEnabled)
        #expect(fixture.store.operationError != nil)
        #expect(try Data(contentsOf: url) == corrupt)
    }

    @Test("旧版隐藏偏好可通过新开关关闭，重启后不反弹")
    func legacyToggle() async throws {
        let fixture = try PrivacyFixture()
        defer { fixture.cleanup() }
        let url = fixture.directory.appendingPathComponent("global-settings.json")
        try #require(JSONStore.save(["showAdultCovers": JSONValue.bool(false)], to: url) == nil)
        await fixture.store.load(dataDirectory: fixture.directory.path)
        #expect(fixture.store.privacy.isEnabled)
        fixture.store.togglePrivacyMode()
        let restarted = AppStore()
        await restarted.load(dataDirectory: fixture.directory.path)
        #expect(!restarted.privacy.isEnabled)
        #expect(restarted.settings["showAdultCovers"] == .bool(false))
    }

    @Test("筛选条件与当前游戏不因隐藏标题而变化")
    func filteringDoesNotUseAliases() async throws {
        let fixture = try PrivacyFixture()
        defer { fixture.cleanup() }
        await fixture.store.load(dataDirectory: fixture.directory.path)
        fixture.store.searchText = fixture.marker
        let before = fixture.store.filteredGames
        fixture.store.setSetting(.privacyHideTitles, .bool(true))
        fixture.store.togglePrivacyMode()
        #expect(fixture.store.filteredGames == before)
        #expect(fixture.store.searchText == fixture.marker)
        #expect(fixture.store.game(id: fixture.game.id) == fixture.game)
    }

    @Test("实际窗口在切换后移除敏感文字，关闭后恢复", arguments: ["列表", "卡片", "详情", "编辑", "搜索结果", "辅助"])
    func renderedTextRespectsPrivacy(surface: String) async throws {
        let fixture = try PrivacyFixture()
        defer { fixture.cleanup() }
        await fixture.store.load(dataDirectory: fixture.directory.path)
        try fixture.setMeta(cover: nil)
        let store = fixture.store
        let game = fixture.game
        let view: AnyView
        switch surface {
        case "列表": view = AnyView(GameListRow(game: game, isRunning: false))
        case "卡片": view = AnyView(GameCardTile(game: game, isRunning: false, isSelected: false, onSelect: {}))
        case "编辑": view = AnyView(GameEditView(game: game))
        case "辅助": view = AnyView(GameDetailView(game: game, initialTab: .assistance))
        case "搜索结果": view = AnyView(DLsiteSearchResults(hits: [DLsiteSearch.Hit(
            rj: "RJ123456", title: fixture.marker, circle: fixture.marker, coverUrl: nil, order: 0)],
            onSelect: { _ in }, onCancel: {}))
        default: view = AnyView(GameDetailView(game: game))
        }
        _ = NSApplication.shared
        // NSView 缓存不包含 NSWindow 底色，透明底上的文字不能直接交给 OCR。
        let hosting = NSHostingView(rootView: view.environmentObject(store)
            .background(Color(nsColor: .windowBackgroundColor)))
        let window = NSWindow(contentRect: NSRect(x: -10000, y: -10000, width: 900, height: 760),
                              styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        window.orderFrontRegardless()
        defer { window.close() }
        try await waitForText(hosting, contains: fixture.marker)
        store.togglePrivacyMode()
        try await waitForText(hosting, contains: fixture.marker)
        store.setSetting(.privacyHideTitles, .bool(true))
        try await waitForText(hosting, contains: fixture.marker, present: false)
        let hidden = try renderedText(hosting)
        #expect(!normalized(hidden).contains(normalized(fixture.marker)), "\(surface) 泄漏原始标题或路径：\(hidden)")
        #expect(!hidden.isEmpty, "隐藏敏感内容后仍应显示占位提示或游戏编号，不能用空白页面假通过")
        store.togglePrivacyMode()
        try await waitForText(hosting, contains: fixture.marker)
    }

    private func waitForText(_ view: NSView, contains text: String, present: Bool = true) async throws {
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        var rendered = ""
        repeat {
            try await Task.sleep(for: .milliseconds(80))
            rendered = try renderedText(view)
            if normalized(rendered).contains(normalized(text)) == present { return }
        } while ContinuousClock.now < deadline
        try #require(normalized(rendered).contains(normalized(text)) == present,
                     "窗口文字不符合隐藏状态：\(text)；应存在：\(present)；实际：\(rendered)")
    }

    private func normalized(_ text: String) -> String {
        text.lowercased().components(separatedBy: CharacterSet.alphanumerics.inverted).joined()
    }

    // 未启用辅助功能的测试进程可能得到空树；读取实际像素，并用正常显示和恢复显示作对照。
    private func renderedText(_ view: NSView) throws -> String {
        view.layoutSubtreeIfNeeded()
        let bitmap = try #require(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: bitmap)
        try #require(!UISnapshot.checkBlank(bitmap), "窗口渲染为空白")
        let image = try #require(bitmap.cgImage)
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }
}
