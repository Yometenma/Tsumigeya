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

        store.searchText = "__tsumigeya_no_matching_game__"
        failures += captureWindow(
            RootViewRepresentable(store: store, selectFirst: false),
            size: CGSize(width: 1280, height: 800),
            name: "07-library-no-results",
            dir: directory, appearance: appearance)
        store.searchText = ""

        // 渲染**有封面**的那个游戏（P7）：优先挑有 DLsite 元数据的。
        let detailGame = store.games.first { game in
            store.meta(for: game.id)?.work.coverUrl != nil
        } ?? store.games.first
        if let detailGame {
            failures += captureWindow(
                GameDetailRepresentable(game: detailGame, store: store),
                size: CGSize(width: 900, height: 760),
                name: "04-detail-\(detailGame.id)",
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
        // ⚠️ **优先挑「既有元数据、参数又多」的游戏** ——
        //    这样编辑页快照能同时验到元数据编辑字段与引擎参数。
        let richestGame = store.games.max { a, b in
            let aMeta = store.meta(for: a.id) != nil ? 1 : 0
            let bMeta = store.meta(for: b.id) != nil ? 1 : 0
            if aMeta != bMeta { return aMeta < bMeta }
            return (store.manifest(for: a.gameEngine)?.gameArgs.count ?? 0)
                < (store.manifest(for: b.gameEngine)?.gameArgs.count ?? 0)
        }
        if let first = richestGame {
            let m = store.manifest(for: first.gameEngine)
            print("编辑页引擎参数: \(m?.orderedGameArgs.count ?? 0) 项"
                  + "（游戏 \(first.gameTitle)，引擎 \(first.gameEngine)）")
            if let m {
                for (name, def) in m.orderedGameArgs {
                    let versions = store.availableVersions(for: def, engine: first.gameEngine)
                    let ctrl = EngineArgs.control(
                        for: def, engine: first.gameEngine, key: name,
                        availableVersions: versions)
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

        // 新入口必须纳入快照；使用临时设置副本，不能为验 UI 改写用户的显示偏好。
        let previewDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("tsmg-ui-preview-" + UUID().uuidString)
        do {
            try FileManager.default.createDirectory(at: previewDirectory, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: previewDirectory) }
            for name in ["games.json", "library-meta.json", "global-settings.json"] {
                let source = URL(fileURLWithPath: store.dataDir).appendingPathComponent(name)
                if FileManager.default.fileExists(atPath: source.path) {
                    try FileManager.default.copyItem(at: source, to: previewDirectory.appendingPathComponent(name))
                }
            }
            let previewStore = AppStore()
            await previewStore.load(dataDirectory: previewDirectory.path)
            previewStore.setSetting(.listView, .bool(false))
            failures += captureWindow(
                RootView(selection: nil, loadsOnAppear: false).environmentObject(previewStore),
                size: CGSize(width: 1280, height: 800), name: "08-library-grid",
                dir: directory, appearance: appearance)
            if let game = store.games.first {
                for (tab, name) in [(GameDetailView.DetailTab.saves, "09-detail-saves"),
                                    (.runtime, "10-detail-runtime")] {
                    failures += captureWindow(
                        GameDetailView(game: game, initialTab: tab).environmentObject(store),
                        size: CGSize(width: 600, height: 620), name: name,
                        dir: directory, appearance: appearance)
                }
            }
            // 手动指定存档目录的三种关键状态：未知、有效空目录，以及隐私模式。
            let savePreviewRoot = previewDirectory.appendingPathComponent("manual-save")
            try FileManager.default.createDirectory(at: savePreviewRoot, withIntermediateDirectories: true)
            let unknownSaveGame = GameRecord(
                id: "__save-preview__", gameTitle: "存档位置未知示例",
                gamePath: previewDirectory.appendingPathComponent("Game.exe").path,
                gameEngine: "tyrano", gameArgs: [:])
            // 存档会话校验当前库记录，预览也必须使用已登记的独立测试库。
            let saveData = previewDirectory.appendingPathComponent("save-state")
            try FileManager.default.createDirectory(at: saveData, withIntermediateDirectories: true)
            try JSONStore.defaultEncoder.encode(GameMap(games: [unknownSaveGame.id: unknownSaveGame]))
                .write(to: saveData.appendingPathComponent("games.json"), options: .atomic)
            let saveStore = AppStore()
            await saveStore.load(dataDirectory: saveData.path)
            failures += captureWindow(
                SaveSection(game: unknownSaveGame).environmentObject(saveStore)
                    .padding(16).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .background(Color(nsColor: .windowBackgroundColor)),
                size: CGSize(width: 600, height: 470), name: "22-save-unknown",
                dir: directory, appearance: appearance)

            guard saveStore.setSaveDirectoryOverride(gameId: unknownSaveGame.id, path: savePreviewRoot.path),
                  let manualSaveGame = saveStore.game(id: unknownSaveGame.id) else {
                throw CocoaError(.fileWriteUnknown)
            }
            failures += captureWindow(
                SaveSection(game: manualSaveGame).environmentObject(saveStore)
                    .padding(16).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .background(Color(nsColor: .windowBackgroundColor)),
                size: CGSize(width: 600, height: 520), name: "23-save-manual-directory",
                dir: directory, appearance: appearance)

            saveStore.setSetting(.privacyMode, .bool(true))
            saveStore.setSetting(.privacyHideTitles, .bool(true))
            failures += captureWindow(
                SaveSection(game: manualSaveGame).environmentObject(saveStore)
                    .padding(16).frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .background(Color(nsColor: .windowBackgroundColor)),
                size: CGSize(width: 600, height: 300), name: "24-save-privacy",
                dir: directory, appearance: appearance)
            if var game = store.games.first {
                game.gameTitle = "超长标题布局验收：遠い星の物語・異世界の冒険と約束の記憶 — 完全版 "
                    + "追加章节与多语言游戏名称的显示检查"
                failures += captureWindow(
                    GameDetailView(game: game, onEdit: {}, onManageEngines: {}, initialTab: .runtime)
                        .environmentObject(store),
                    size: CGSize(width: 480, height: 500), name: "14-detail-long-title",
                    dir: directory, appearance: appearance)
            }
            previewStore.setSetting(.listView, .bool(true))
            failures += captureWindow(
                RootView(selection: previewStore.games.first?.id, loadsOnAppear: false)
                    .environmentObject(previewStore),
                size: CGSize(width: 900, height: 600), name: "11-library-minimum",
                dir: directory, appearance: appearance)
            failures += captureWindow(
                RootView(selection: previewStore.games.first?.id, loadsOnAppear: false)
                    .environmentObject(previewStore),
                size: CGSize(width: 1100, height: 760), name: "12-library-light",
                dir: directory, appearance: NSAppearance(named: .aqua))
            previewStore.setSetting(.privacyMode, .bool(true))
            previewStore.setSetting(.privacyHideTitles, .bool(false))
            failures += captureWindow(
                RootView(selection: previewStore.games.first?.id, loadsOnAppear: false)
                    .environmentObject(previewStore),
                size: CGSize(width: 1100, height: 760), name: "15-privacy-covers",
                dir: directory, appearance: appearance)
            previewStore.setSetting(.privacyHideTitles, .bool(true))
            failures += captureWindow(
                RootView(selection: previewStore.games.first?.id, loadsOnAppear: false)
                    .environmentObject(previewStore),
                size: CGSize(width: 1100, height: 760), name: "16-privacy-titles",
                dir: directory, appearance: appearance)
            previewStore.setSetting(.listView, .bool(false))
            failures += captureWindow(
                RootView(selection: nil, loadsOnAppear: false).environmentObject(previewStore),
                size: CGSize(width: 1100, height: 760), name: "17-privacy-grid",
                dir: directory, appearance: appearance)
            if let game = previewStore.games.first {
                failures += captureWindow(
                    GameEditView(game: game).environmentObject(previewStore),
                    size: CGSize(width: 900, height: 650), name: "18-privacy-edit",
                    dir: directory, appearance: appearance)
            }
            let intakeCandidates = [
                LibraryIntake.Candidate(folder: "/示例游戏/很长的目录名称与中文路径/魔女的故事 完整版", title: "魔女的故事 完整版", engine: "kirikiri"),
                LibraryIntake.Candidate(folder: "/示例游戏/另一部游戏", title: "另一部游戏", engine: "unity")
            ]
            previewStore.setSetting(.privacyMode, .bool(false))
            failures += captureWindow(
                BatchImportView(previewCandidates: intakeCandidates).environmentObject(previewStore),
                size: CGSize(width: 780, height: 590), name: "19-batch-import",
                dir: directory, appearance: appearance)
            if let game = previewStore.games.first {
                failures += captureWindow(
                    RelocateGameView(game: game).environmentObject(previewStore),
                    size: CGSize(width: 600, height: 410), name: "20-relocate-game",
                    dir: directory, appearance: appearance)
            }
            previewStore.setSetting(.privacyMode, .bool(true))
            failures += captureWindow(
                BatchImportView(previewCandidates: intakeCandidates).environmentObject(previewStore),
                size: CGSize(width: 780, height: 590), name: "21-batch-privacy",
                dir: directory, appearance: appearance)
            if let game = previewStore.games.first {
                previewStore.setSetting(.privacyMode, .bool(false))
                failures += captureWindow(
                    LaunchDiagnosticsView(game: game).environmentObject(previewStore),
                    size: CGSize(width: 720, height: 590), name: "22-launch-diagnostics",
                    dir: directory, appearance: appearance)
                previewStore.setSetting(.privacyMode, .bool(true))
                previewStore.setSetting(.privacyHideTitles, .bool(true))
                failures += captureWindow(
                    LaunchDiagnosticsView(game: game).environmentObject(previewStore),
                    size: CGSize(width: 720, height: 590), name: "23-launch-diagnostics-privacy",
                    dir: directory, appearance: appearance)
            }
            for group in SettingsGroups.groups where group.id != .appearance {
                failures += captureWindow(
                    SettingsPage(initialGroup: group.id).environmentObject(store),
                    size: CGSize(width: 900, height: 650), name: "13-settings-" + group.id.rawValue,
                    dir: directory, appearance: appearance)
            }
        } catch {
            print("❌ 无法创建 UI 验收数据副本：\(error)")
            failures += 1
        }

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

        // ⚠️⚠️ **再等一会儿**：`AsyncImage` 下载网络封面是**异步**的。
        //
        //    P7 实测：详情页快照里封面是空的（显示回落渐变的蓝底），
        //    因为本鱼上面只等了 0.3 秒，而 DLsite 的封面要几百毫秒到几秒。
        //
        //    这里等 2.5 秒（够下载一张 200KB 的图），并让 RunLoop 真的转起来
        //    （`run(mode:)` 会让主线程处理事件，包括 URLSession 的回调）。
        //
        //    ⚠️ 代价：每张详情页快照慢 2.5 秒。但**不等的代价是快照永远看不到封面** ——
        //       那等于 P7 的视觉部分一直没验过。
        // 再转一圈，让 SwiftUI 完成第二次布局。
        //
        // ⚠️ **不再等 3 秒**：那是本鱼为了等 `AsyncImage` 下载封面加的，
        //    而实测**根本等不到** —— `AsyncImage` 在离屏窗口里不触发下载
        //    （它靠「视图真的上屏可见」判断）。
        //
        //    → 快照里封面缺席是**这个工具的限制**，不是产品 bug：
        //      用户在真窗口里看是正常的（2026-11-06 确认）。
        //      封面那一条**用真窗口验**，快照只管布局与文本。
        RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.3))
        hosting.layoutSubtreeIfNeeded()

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
    static func checkBlank(_ rep: NSBitmapImageRep) -> Bool {
        let w = rep.pixelsWide, h = rep.pixelsHigh
        guard w > 4, h > 4 else { return true }

        var first: NSColor?
        var distinct = 0
        // 空状态只有中央几行文字，12×12 网格会完全错过；覆盖全图的密集网格避免假阴性。
        for yi in stride(from: 0, to: h, by: max(1, h / 64)) {
            for xi in stride(from: 0, to: w, by: max(1, w / 64)) {
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

/// 快照直接使用生产视图，避免另写一套界面而漏验真实布局。
struct RootViewRepresentable: View {
    let store: AppStore
    var selectFirst: Bool = true

    var body: some View {
        RootView(selection: selectFirst ? store.games.first?.id : nil, loadsOnAppear: false)
            .environmentObject(store)
            .frame(width: 1280, height: 800)
    }
}

/// 引擎页的渲染包装（直接就是 EnginesPage，它已经自包含）。
struct EnginesPageRepresentable: View {
    let store: AppStore

    var body: some View {
        RootView(loadsOnAppear: false, initialPage: .engines)
            .environmentObject(store)
            .frame(width: 1000, height: 800)
    }
}

/// 设置页的渲染包装。
struct SettingsPageRepresentable: View {
    let store: AppStore

    var body: some View {
        RootView(loadsOnAppear: false, initialPage: .settings)
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
