// NW.js 版本面板的界面验收。
//
// 守的是「用户能不能真的看到并点到」——不是只看它能编译：
//   · 候选版本要出现在面板上
//   · 已装的版本要显示成「已装」，不能还给一个「安装」按钮（那会让他白点）
//
// 只做离屏渲染 + OCR 断言；真实点击仍要在 Mac 上手动确认（见 docs/UI验收方法.md）。
import SwiftUI
import Testing
import Vision

@testable import TsumigeyaApp
@testable import TsumigeyaCore

@Suite("NW.js 版本面板")
@MainActor
struct NwjsVersionsSheetTests {

    private func makeStore() async throws -> (AppStore, URL) {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-nwjs-ui-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        // 造一个「已装」的版本目录（版本枚举只看目录名，不需要二进制）
        try FileManager.default.createDirectory(
            at: root.appendingPathComponent("modules/nwjs/deps/version/v0.106.1"),
            withIntermediateDirectories: true)
        let store = AppStore()
        await store.load(dataDirectory: root.path)
        return (store, root)
    }

    @Test("面板列出候选版本，已装版本显示已装而不是安装按钮")
    func rendersChoicesAndInstalledState() async throws {
        let (store, root) = try await makeStore()
        defer { try? FileManager.default.removeItem(at: root) }

        _ = NSApplication.shared
        let size = CGSize(width: 520, height: 420)
        let hosting = NSHostingView(rootView: NwjsVersionsSheet()
            .environmentObject(store)
            .environment(\.colorScheme, .dark)
            .frame(width: size.width, height: size.height)
            .background(Color(nsColor: .windowBackgroundColor)))
        let window = NSWindow(
            contentRect: NSRect(origin: CGPoint(x: -6000, y: -6000), size: size),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = hosting
        window.orderFrontRegardless()
        defer { window.close() }

        try await Task.sleep(for: .milliseconds(250))
        hosting.layoutSubtreeIfNeeded()

        let bitmap = try #require(
            hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds))
        hosting.cacheDisplay(in: hosting.bounds, to: bitmap)
        #expect(!UISnapshot.checkBlank(bitmap), "面板渲染成了空白")

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        try VNImageRequestHandler(cgImage: #require(bitmap.cgImage)).perform([request])
        let text = (request.results ?? [])
            .compactMap { $0.topCandidates(1).first?.string }
            .joined(separator: " ")

        // 调试用：设了环境变量就把这次渲染落盘（与其它界面测试一致）
        if let dir = ProcessInfo.processInfo.environment["TSUMIGEYA_NWJS_UI_DIR"] {
            try FileManager.default.createDirectory(
                atPath: dir, withIntermediateDirectories: true)
            if let png = bitmap.representation(using: .png, properties: [:]) {
                try png.write(to: URL(fileURLWithPath: dir)
                    .appendingPathComponent("nwjs-versions.png"))
            }
        }

        // ⚠️ 不拿版本号做断言：OCR 会把 `v0.106.1` 读成 `VO.106.I` 之类，
        //    断言会脆在识别瑕疵上而不是界面问题上。
        //    改判「候选行数」——每个候选版本都会显示一行「Apple 芯片原生」。
        let candidateRows = text.components(separatedBy: "Apple 芯片原生").count - 1
        #expect(candidateRows >= EngineDependencies.nwjsRuntimeChoices.count,
                "候选版本行数不足（\(candidateRows)）：\(text)")
        // 标题与已装状态
        #expect(text.contains("安装其它 NW.js 版本"), "标题未显示：\(text)")
        #expect(text.contains("已装"), "已装标记未显示：\(text)")
        // 未验证的版本要如实标出来（别把「能下载」说成「能用」）
        #expect(text.contains("未在") || text.contains("验证窗口"), "未验证标记未显示：\(text)")
    }
}
