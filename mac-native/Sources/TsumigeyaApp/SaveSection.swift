// 详情页的「存档」区块。
//
// 对应 Electron 版：`components/SaveSection.vue`（191 行 / S2+S3+S4）
// 契约：M4 S2/S3/S4，D81 / D82 / D85
//
// ===== 三态必须分开（这是 S1 的核心判据）=====
//
// | 状态 | 含义 | 用户该做什么 |
// |---|---|---|
// | **unknown** | **不知道存档在哪** | 去排障 / 这个引擎不支持 |
// | **empty** | 知道在哪，但目录是空的 | **先去游戏里存一次档**（正常状态） |
// | **list** | 有存档 | 正常 |
//
// ⚠️ 把前两者糊成一句「没有存档」，用户会**永远查不出问题** ——
//    前者是故障，后者是正常，他要做的事完全不同。
//
// ===== 运行中禁用导出（D82）=====
//
// 游戏正在写存档时导出的包是**半截文件**（头对、尾缺）。
// 用户带着它换机，导入后游戏报存档损坏 —— 而他想不到问题出在「当初没关游戏」。
//
// ⚠️ **UI 禁用只是提前告知，不是判据**：真正的拦截在 `SaveArchiveIO.export`
//    （主进程那一层）。UI 拦不住所有路径（比如用户刚点完导出游戏就启动了）。
import SwiftUI
import TsumigeyaCore

struct SaveSection: View {
    let game: GameRecord
    @EnvironmentObject private var store: AppStore

    /// 当前列表（`nil` = 还没加载）。
    @State private var listing: SaveListing?
    /// 导出/导入进行中。
    @State private var isWorking = false
    /// 结果提示（成功/失败）。
    @State private var message: (text: String, isError: Bool)?

    private var isRunning: Bool {
        store.runningGames[game.id] != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text("存档")
                    .font(.system(size: 13, weight: .semibold))
                Spacer()
                actionButtons
            }

            content

            if let message {
                Label(message.text, systemImage: message.isError
                        ? "exclamationmark.triangle.fill"
                        : "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(message.isError ? .orange : .secondary)
                    .lineLimit(3)
                    .textSelection(.enabled)
            }
        }
        .onAppear {
            reload()
        }
        .onChange(of: store.runningGames[game.id]) { _, _ in
            // ⚠️ 运行状态变化时重新探测（游戏跑起来可能创建了存档目录）
            reload()
        }
    }

    // MARK: - 操作按钮

    @ViewBuilder
    private var actionButtons: some View {
        if isWorking {
            ProgressView().controlSize(.small)
        } else {
            // ⚠️ **运行中时导出按钮要禁用 + 说明原因**（D82）。
            //    只禁用不说话会让用户以为「这功能坏了」。
            Button {
                doExport()
            } label: {
                Label("导出", systemImage: "square.and.arrow.up")
                    .font(.system(size: 11))
            }
            .controlSize(.small)
            .disabled(isRunning || !canExport)
            .help(isRunning
                  ? "游戏正在运行，先关掉它再导出（运行中的存档可能正在写）"
                  : (canExport ? "把存档打包成一个 zip" : "没有可导出的存档"))

            Button {
                doImport()
            } label: {
                Label("导入", systemImage: "square.and.arrow.down")
                    .font(.system(size: 11))
            }
            .controlSize(.small)
            .disabled(isRunning || listing?.dir == nil)
            .help(isRunning
                  ? "游戏正在运行，先关掉它再导入"
                  : "从 zip 恢复存档（会先备份现有存档）")
        }
    }

    /// 能不能导出（运行中一律不能）。
    private var canExport: Bool {
        guard let listing, let _ = listing.dir else { return false }
        return listing.hasSaves
    }

    // MARK: - 内容（三态）

    @ViewBuilder
    private var content: some View {
        if let listing {
            if listing.dir == nil {
                // ⚠️ **unknown**（不知道在哪）—— 与前一条必须区分
                stateRow(
                    icon: "questionmark.circle",
                    tint: .orange,
                    title: "不知道这个游戏的存档在哪",
                    detail: "这个引擎的存档位置可能还没实现，或者游戏目录结构不常见。")
            } else if listing.items.isEmpty {
                // **empty**（还没存过档）—— 正常状态
                stateRow(
                    icon: "tray",
                    tint: .secondary,
                    title: "还没有存档",
                    detail: "先去游戏里存一次档，回来这里就能看到。")
            } else {
                saveList(listing)
            }
        } else {
            ProgressView().controlSize(.small)
        }
    }

    private func stateRow(
        icon: String, tint: Color, title: String, detail: String
    ) -> some View {
        HStack(alignment: .top, spacing: 7) {
            Image(systemName: icon)
                .font(.system(size: 12))
                .foregroundStyle(tint)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 12))
                Text(detail)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
        }
        .padding(9)
        .background(Color(nsColor: .controlBackgroundColor),
                    in: RoundedRectangle(cornerRadius: 7))
    }

    /// 存档列表（槽 + 配置分开）。
    ///
    /// ⚠️ **配置要压暗**：`config.rpgsave` / `global.rpgsave` 是游戏的设置，
    ///    不是玩家进度。与槽同等显示会让用户以为它们是第 0 号档。
    private func saveList(_ listing: SaveListing) -> some View {
        VStack(spacing: 0) {
            let slots = listing.items.filter { !$0.isConfig }
            let configs = listing.items.filter { $0.isConfig }

            ForEach(Array(slots.enumerated()), id: \.element.id) { idx, item in
                if idx > 0 { Divider().padding(.leading, 10) }
                saveRow(item, dimmed: false)
            }
            if !configs.isEmpty {
                Divider()
                ForEach(configs, id: \.id) { item in
                    saveRow(item, dimmed: true)
                }
            }
        }
        .background(Color(nsColor: .controlBackgroundColor),
                    in: RoundedRectangle(cornerRadius: 7))
    }

    private func saveRow(_ item: SaveItem, dimmed: Bool) -> some View {
        HStack(spacing: 8) {
            Image(systemName: dimmed ? "gearshape" : "doc")
                .font(.system(size: 10))
                .foregroundStyle(.secondary)
            Text(item.name)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(dimmed ? .secondary : .primary)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            if let size = item.size {
                Text(formatBytes(size))
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
            }
            if let modified = item.modified {
                Text(shortDate(modified))
                    .font(.system(size: 10))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
    }

    // MARK: - 动作

    private func reload() {
        listing = SaveStore.list(gamePath: game.gamePath, engine: game.gameEngine)
    }

    private func doExport() {
        isWorking = true
        message = nil
        defer { isWorking = false }

        // 输出到 ~/Downloads（用户找得到的地方）
        let downloads = (NSHomeDirectory() as NSString)
            .appendingPathComponent("Downloads")

        let result = SaveArchiveIO.export(
            gamePath: game.gamePath, engine: game.gameEngine,
            gameTitle: game.gameTitle, outputDir: downloads,
            isRunning: isRunning)

        switch result {
        case .success(let exported):
            message = ("已导出 \(exported.fileCount) 个文件 → \(exported.archivePath)", false)
        case .failure(let error):
            message = (error.message, true)
        }
    }

    private func doImport() {
        // 选 zip
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.zip]
        panel.message = "选择要导入的存档包（现有存档会先备份）"

        guard panel.runModal() == .OK, let url = panel.url else { return }

        isWorking = true
        message = nil
        defer { isWorking = false }

        let result = SaveArchiveIO.importArchive(
            archivePath: url.path, gamePath: game.gamePath, engine: game.gameEngine)

        switch result {
        case .success(let imported):
            let backupNote = imported.backups.isEmpty
                ? ""
                : "（\(imported.backups.count) 个原文件已备份为 .tsumigeya-bak）"
            message = ("已恢复 \(imported.files.count) 个文件\(backupNote)", false)
            reload()
        case .failure(let error):
            message = (error.message, true)
        }
    }

    // MARK: - 格式化

    /// 1024 进制字节（与 `SaveSection.vue` 的 `formatByteSize` 同一取向）。
    private func formatBytes(_ bytes: Int64) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        let kb = Double(bytes) / 1024
        if kb < 1024 { return String(format: "%.0f KB", kb) }
        let mb = kb / 1024
        if mb < 1024 { return String(format: "%.1f MB", mb) }
        return String(format: "%.2f GB", mb / 1024)
    }

    private func shortDate(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "zh_CN")
        f.dateFormat = "MM-dd HH:mm"
        return f.string(from: date)
    }
}
