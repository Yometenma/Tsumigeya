// UI 快照工具（第三版实现）。
//
// ===== 为什么前两版都不行（记下来免得又走一遍）=====
//
// **v1：`ImageRenderer` 直接渲染 `RootView`**
//   → 渲染出**空白**。`NavigationSplitView` / `ScrollView` / `List` 这些容器
//     需要真实的窗口上下文（NSWindow、NSView 层级、布局系统），
//     `ImageRenderer` 只做离屏 SwiftUI 布局，拿不到它们。
//
// **v2：换成渲染「扁平化」的视图（不用 NavigationSplitView）**
//   → 输出一个**巨大的黄色禁止图标**。这是 `ImageRenderer` 遇到
//     它渲染不了的容器时的占位（不是错误、也不报 nil）。
//     ⚠️ **这一条最关键**：`ImageRenderer` 失败时**不返回 nil**，
//     它返回一张占位图 → 靠 `nsImage == nil` 判断失败是**判不出来**的。
//
// **v3（本版）：真开一个 NSWindow，把视图塞进去，等它布局完，再 `bitmapImageRepForCachingDisplay` 取像素**
//   → 这才是「截自己的人窗口」在 app 内部的正路，
//     因为窗口真的存在、布局真的跑过了。
//
// ===== 这仍然不能取代人眼 =====
//
// 它只能证明「视图树建起来了、布局有内容、没有严重错位」。
// **观感**（渐变是否好看、按钮够不够醒目、字体大小）还是要人看。
// 用户 2026-11-06 说过「观感相关的东西我之后慢慢微调」——
// 所以本鱼的角色是**把布局错误挡在自己这边**，别让他当人肉 lint。
import SwiftUI
import AppKit
import TsumigeyaCore

enum UISnapshot {

    /// 渲染一组界面到指定目录。
    @MainActor
    static func render(to directory: String, darkMode: Bool = true) async -> Int {
        let fm = FileManager.default
        do {
            try fm.createDirectory(atPath: directory, withIntermediateDirectories: true)
        } catch {
            print("❌ 建目录失败：\(error.localizedDescription)")
            return 1
        }

        // 真实数据（渲染用户真的会看到的界面）
        let store = AppStore()
        await store.load()

        print("数据目录: \(store.dataDir)")
        print("游戏数  : \(store.games.count)")
        for g in store.groups {
            print("  分组「\(g.title)」: \(g.games.count) 个")
        }
        print("")

        // ⚠️ 强制外观：渲染出来的图要能反映**用户实际的暗色模式**
        //    （他的截图是暗色）。不设的话跟随系统，SSH 会话下可能是亮色。
        let appearance = NSAppearance(named: darkMode ? .darkAqua : .aqua)

        var failures = 0

        failures += captureWindow(
            RootViewRepresentable(store: store),
            size: CGSize(width: 1280, height: 800),
            name: "01-root-with-selection",
            dir: directory, appearance: appearance)

        failures += captureWindow(
            RootViewRepresentable(store: store, selectFirst: false),
            size: CGSize(width: 1280, height: 800),
            name: "02-root-no-selection",
            dir: directory, appearance: appearance)

        if let first = store.games.first {
            failures += captureWindow(
                GameDetailRepresentable(game: first, store: store),
                size: CGSize(width: 900, height: 760),
                name: "03-detail-\(first.id)",
                dir: directory, appearance: appearance)
        }

        // 引擎页还写着 P5，但先渲染一个「未实现」占位以证明多页渲染通路通了
        print("")
        if failures == 0 {
            print("✅ 全部渲染成功 → \(directory)")
        } else {
            print("❌ \(failures) 张渲染失败")
        }
        return failures
    }

    // MARK: - 真窗口截图

    /// 把 SwiftUI 视图塞进一个**真实的 NSWindow**，等布局完成，再取像素。
    ///
    /// 为什么必须这样：`ImageRenderer` 渲染不了 `NavigationSplitView` / `ScrollView`
    /// （见文件头）。只有真窗口才有完整的布局上下文。
    @MainActor
    private static func captureWindow<V: View>(
        _ view: V, size: CGSize, name: String, dir: String,
        appearance: NSAppearance?
    ) -> Int {
        let hosting = NSHostingView(rootView: view)
        hosting.frame = CGRect(origin: .zero, size: size)

        // 窗口必须**真的在屏幕上**（`orderFront`）：
        // 离屏窗口（`orderOut`）不会做完整布局，取到的还是空白。
        //
        // ⚠️ 但也不能让它抢用户焦点 —— 用 `.borderless` + 小尺寸移到屏幕角落。
        //    在本鱼这个 SSH 场景下用户看不到它，但真实机器上会闪一下，
        //    所以位置放在屏幕外（负坐标）。
        let window = NSWindow(
            contentRect: CGRect(origin: CGPoint(x: -3000, y: -3000), size: size),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.contentView = hosting
        if let appearance { window.appearance = appearance }
        window.isReleasedWhenClosed = false
        // ⚠️ alphaValue = 1 但位置在屏幕外 → 不干扰用户，但布局是真的
        window.orderFrontRegardless()

        // 等布局跑完（RunLoop 转两圈 + 给一点时间给 SwiftUI 的 diff）
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.15))
        hosting.layoutSubtreeIfNeeded()
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.15))

        // 取像素
        guard let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds) else {
            print("❌ \(name): 无法创建 bitmap")
            window.orderOut(nil)
            return 1
        }
        hosting.cacheDisplay(in: hosting.bounds, to: rep)

        guard let png = rep.representation(using: .png, properties: [:]) else {
            print("❌ \(name): 转 PNG 失败")
            window.orderOut(nil)
            return 1
        }

        // ⚠️ **自检：不能只看「写成功了」**。ImageRenderer 的教训（文件头 v2）
        //    是「失败也返回一张图」。这里虽然走的是 NSView 路径，
        //    仍要检查图里**有没有非背景色的像素** —— 纯色图说明布局没跑。
        let isBlank = checkBlank(rep)
        if isBlank {
            print("❌ \(name): 渲染结果是纯色（布局没跑起来）")
            _ = try? png.write(to: URL(fileURLWithPath:
                (dir as NSString).appendingPathComponent("\(name)-BLANK.png")))
            window.orderOut(nil)
            return 1
        }

        let path = (dir as NSString).appendingPathComponent("\(name).png")
        do {
            try png.write(to: URL(fileURLWithPath: path))
            print("✅ \(name).png  (\(png.count) 字节)")
            window.orderOut(nil)
            return 0
        } catch {
            print("❌ \(name): 写文件失败 \(error.localizedDescription)")
            window.orderOut(nil)
            return 1
        }
    }

    /// 检查位图是否是「纯色」（= 布局没跑）。
    ///
    /// 判据：采样若干点，如果**所有采样点颜色都一样** → 判空白。
    /// 这比「有没有 alpha 0」更可靠（纯色图也可能全不透明）。
    private static func checkBlank(_ rep: NSBitmapImageRep) -> Bool {
        let w = rep.pixelsWide, h = rep.pixelsHigh
        guard w > 4, h > 4 else { return true }

        var first: NSColor?
        var distinct = 0
        // 采一个网格（不是全量遍历 —— 1920×1080 全扫太慢）
        for yi in stride(from: h / 10, to: h, by: max(1, h / 10)) {
            for xi in stride(from: w / 10, to: w, by: max(1, w / 10)) {
                guard let color = rep.colorAt(x: xi, y: yi) else { continue }
                let rgb = color.usingColorSpace(.deviceRGB) ?? color
                if let f = first {
                    let dr = abs(rgb.redComponent - f.redComponent)
                    let dg = abs(rgb.greenComponent - f.greenComponent)
                    let db = abs(rgb.blueComponent - f.blueComponent)
                    if dr + dg + db > 0.06 { distinct += 1 }
                } else {
                    first = rgb
                }
            }
        }
        return distinct == 0
    }
}

// MARK: - 渲染用的包装视图

/// 让 `RootView` 能指定「选中第一个游戏」的状态。
struct RootViewRepresentable: View {
    let store: AppStore
    var selectFirst: Bool = true

    var body: some View {
        NavigationSplitView {
            List(selection: .constant(selectFirst ? store.games.first?.id : nil)) {
                ForEach(store.groups, id: \.id) { group in
                    Section {
                        ForEach(group.games, id: \.id) { game in
                            GameListRow(
                                game: game,
                                isRunning: store.runningGames[game.id] != nil
                            )
                            .tag(game.id)
                        }
                    } header: {
                        HStack(spacing: 6) {
                            Text(group.title)
                            Text("\(group.games.count)")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
            }
            .listStyle(.sidebar)
            .navigationSplitViewColumnWidth(min: 200, ideal: 240, max: 320)
            .searchable(text: .constant(""), placement: .sidebar,
                        prompt: "搜索游戏名、路径或引擎")
        } detail: {
            if let id = store.games.first?.id, selectFirst, let game = store.game(id: id) {
                GameDetailView(game: game).environmentObject(store)
            } else {
                WelcomeView().environmentObject(store)
            }
        }
        .environmentObject(store)
        .frame(width: 1280, height: 800)
    }
}

struct GameDetailRepresentable: View {
    let game: GameRecord
    let store: AppStore

    var body: some View {
        GameDetailView(game: game)
            .environmentObject(store)
            .frame(width: 900, height: 760)
    }
}
