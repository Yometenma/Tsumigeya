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
            name: "01-library",
            dir: directory, appearance: appearance)

        failures += captureWindow(
            RootViewRepresentable(store: store, selectFirst: false),
            size: CGSize(width: 1280, height: 800),
            name: "02-library-no-selection",
            dir: directory, appearance: appearance)

        // ⚠️ **引擎页必须单独渲染**（用户 2026-11-06 报「引擎页有问题」——
        //    那时它是空白侧边栏。加了这张图，下次改布局能直接看到）
        //
        // ⚠️ 渲染前**必须刷新引擎状态表**：`engineEntries` 是懒加载的，
        //    store 刚建时它是空的 → List 空 → 页面纯色（本鱼实测踩到）。
        store.refreshEngineEntries()
        print("引擎条目数: \(store.engineEntries.count)")
        for e in store.engineEntries {
            print("  \(e.definition.name.padding(toLength: 12, withPad: " ", startingAt: 0))"
                  + "\(e.installed ? "已装" : "未装")"
                  + (e.warning.map { w in
                      switch w {
                      case .unverified: return "  [未验证]"
                      case .unverifiedLaunchOnly: return "  [启动未验证]"
                      case .upstreamGate: return "  [上游限制]"
                      }
                  } ?? ""))
        }
        failures += captureWindow(
            EnginesPageRepresentable(store: store),
            size: CGSize(width: 1000, height: 800),
            name: "03-engines",
            dir: directory, appearance: appearance)

        if let first = store.games.first {
            failures += captureWindow(
                GameDetailRepresentable(game: first, store: store),
                size: CGSize(width: 900, height: 760),
                name: "04-detail-\(first.id)",
                dir: directory, appearance: appearance)
        }

        // ⚠️ 设置页也要渲染 —— 它是「分组漏项」这类 bug 的可视化检查入口
        store.loadSettings()
        print("设置项数: \(store.settings.count)  分组数: \(SettingsGroups.groups.count)")
        for g in SettingsGroups.groups {
            print("  分组「\(g.id.title)」: \(g.keys.count) 项")
        }
        failures += captureWindow(
            SettingsPageRepresentable(store: store),
            size: CGSize(width: 900, height: 900),
            name: "05-settings",
            dir: directory, appearance: appearance)

        // ⚠️ 编辑页 —— 参数表单最容易「某项静默消失」
        //
        // ⚠️ **必须挑一个有最多参数的游戏来渲染**（nwjs 只有 1 项，看不出表单效果）。
        //    挑 `gameArgs` 项最多的那个（通常是 mkxpz 或 easyrpg）。
        let richestGame = store.games.max { a, b in
            (store.manifest(for: a.gameEngine)?.gameArgs.count ?? 0)
                < (store.manifest(for: b.gameEngine)?.gameArgs.count ?? 0)
        }
        if let first = richestGame {
            let m = store.manifest(for: first.gameEngine)
            print("编辑页引擎参数: \(m?.orderedGameArgs.count ?? 0) 项"
                  + "（游戏 \(first.gameTitle)，引擎 \(first.gameEngine)）")
            if let m {
                for (name, def) in m.orderedGameArgs {
                    let versions = store.availableVersions(for: def, engine: first.gameEngine)
                    let ctrl = EngineArgs.control(for: def, availableVersions: versions)
                    print("  \(name.padding(toLength: 16, withPad: " ", startingAt: 0))"
                          + "type=\(def.type ?? "-")  ctrl=\(ctrl)")
                }
            }
            // ⚠️ 同时检查 nwjs 的版本列表（那是编辑页最容易空白的地方）
            let nwjsVersions = NwjsVersion.availableVersions(dataDir: store.dataDir)
            print("nwjs 可选版本: \(nwjsVersions)")

            failures += captureWindow(
                GameEditRepresentable(game: first, store: store),
                size: CGSize(width: 1000, height: 900),
                name: "06-edit",
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
    ///
    /// ⚠️ **阈值不能太松**。本鱼第一版用 `dr+dg+db > 0.06`，
    ///    结果设置页渲染出一张**全白**的图却**判过了** ——
    ///    因为纯白背景上的抗锯齿文字边缘产生了极小的色差（不到 0.06），
    ///    采样网格恰好扫到那些边缘，于是被判成「有内容」。
    ///
    ///    现在的判据更严：`0.02`（约 5 个灰阶值），并且**要求至少 3 个明显不同的点**
    ///    （单个边缘像素不够，要有实质内容）。
    private static func checkBlank(_ rep: NSBitmapImageRep) -> Bool {
        let w = rep.pixelsWide, h = rep.pixelsHigh
        guard w > 4, h > 4 else { return true }

        var first: NSColor?
        var distinct = 0
        // 采一个更密的网格（12×12 = 144 点）—— 太稀会漏掉小内容
        for yi in stride(from: h / 8, to: h, by: max(1, h / 12)) {
            for xi in stride(from: w / 8, to: w, by: max(1, w / 12)) {
                guard let color = rep.colorAt(x: xi, y: yi) else { continue }
                let rgb = color.usingColorSpace(.deviceRGB) ?? color
                if let f = first {
                    let dr = abs(rgb.redComponent - f.redComponent)
                    let dg = abs(rgb.greenComponent - f.greenComponent)
                    let db = abs(rgb.blueComponent - f.blueComponent)
                    if dr + dg + db > 0.02 { distinct += 1 }
                } else {
                    first = rgb
                }
            }
        }
        // 至少 3 个明显不同的采样点才算「有内容」
        return distinct < 3
    }
}

// MARK: - 渲染用的包装视图

/// 让 `RootView` 能指定「选中第一个游戏」的状态。
///
/// ⚠️ 与 v2 布局（顶部分段控件 + 一层 HSplitView）对齐。
///    不能直接复用 `RootView`：它的 `@State selection` 私有，渲染时无法从外部指定。
struct RootViewRepresentable: View {
    let store: AppStore
    var selectFirst: Bool = true

    var body: some View {
        VStack(spacing: 0) {
            // 模拟顶部工具条（渲染出来便于检查分段控件样子）
            HStack(spacing: 12) {
                Picker("", selection: .constant(RootView.AppPage.library)) {
                    Text("游戏库").tag(RootView.AppPage.library)
                    Text("引擎").tag(RootView.AppPage.engines)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 180)
                Spacer()
                SearchField(text: .constant(""))
                    .frame(width: 240)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            Divider()

            HSplitView {
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
                .frame(minWidth: 190, idealWidth: 230, maxWidth: 320)

                Group {
                    if let id = store.games.first?.id, selectFirst, let game = store.game(id: id) {
                        GameDetailView(game: game).environmentObject(store)
                    } else {
                        WelcomeView().environmentObject(store)
                    }
                }
                .frame(minWidth: 400, maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .environmentObject(store)
        .frame(width: 1280, height: 800)
    }
}

/// 引擎页的渲染包装（直接就是 EnginesPage，它已经自包含）。
struct EnginesPageRepresentable: View {
    let store: AppStore

    var body: some View {
        EnginesPage()
            .environmentObject(store)
            .frame(width: 1000, height: 800)
    }
}

/// 设置页的渲染包装。
struct SettingsPageRepresentable: View {
    let store: AppStore

    var body: some View {
        SettingsPage()
            .environmentObject(store)
            .frame(width: 900, height: 900)
    }
}

/// 编辑页的渲染包装。
struct GameEditRepresentable: View {
    let game: GameRecord
    let store: AppStore

    var body: some View {
        GameEditView(game: game)
            .environmentObject(store)
            .frame(width: 1000, height: 900)
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
