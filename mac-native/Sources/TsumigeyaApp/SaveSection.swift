// 存档展示及系统文件选择；列表、结果和业务操作由 AppStore 创建的 SaveSession 管理。
// 位置未知、有效空目录和已有存档必须分开显示，按钮禁用不能代替操作入口的安全检查。
import AppKit
import SwiftUI
import TsumigeyaCore

struct SaveSection: View {
    let game: GameRecord
    @EnvironmentObject private var store: AppStore

    var body: some View {
        let session = store.saveSession(for: game)
        SaveSessionContent(session: session).id(session.id)
    }
}

private struct SaveSessionContent: View {
    @EnvironmentObject private var store: AppStore
    @ObservedObject var session: SaveSession

    private var game: GameRecord { session.game }
    private var listing: SaveListing? { session.listing }
    private var isWorking: Bool { session.isWorking }
    private var message: (text: String, isError: Bool)? { session.message }
    private var overridePath: String? { session.overridePath }

    private var isRunning: Bool {
        store.runningGames[game.id] != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(L("存档"))
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
        .onAppear { session.reload() }
        .onChange(of: store.runningGames[game.id]) { _, _ in session.reload() }
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
                Label(L("导出"), systemImage: "square.and.arrow.up")
                    .font(.system(size: 11))
            }
            .controlSize(.small)
            .disabled(isRunning || !canExport)
            .help(isRunning
                  ? L("游戏正在运行，先关掉它再导出（运行中的存档可能正在写）")
                  : (canExport ? L("把存档打包成一个 zip") : L("没有可导出的存档")))

            Button {
                doImport()
            } label: {
                Label(L("导入"), systemImage: "square.and.arrow.down")
                    .font(.system(size: 11))
            }
            .controlSize(.small)
            .disabled(isRunning || listing?.dir == nil)
            .help(isRunning
                  ? L("游戏正在运行，先关掉它再导入")
                  : L("从 zip 恢复存档（会先备份现有存档）"))
        }
    }

    /// 能不能导出（运行中一律不能）。
    private var canExport: Bool {
        session.canExport
    }

    // MARK: - 内容（三态）

    @ViewBuilder
    private var content: some View {
        if let listing {
            if listing.dir == nil {
                // ⚠️ **unknown**（不知道在哪）—— 与空目录必须区分。
                stateRow(
                    icon: "questionmark.circle",
                    tint: .orange,
                    title: overridePath == nil ? L("不知道这个游戏的存档在哪") : L("手动指定的存档目录不可用"),
                    detail: overridePath == nil
                        ? L("这个引擎的存档位置可能还没实现，或者游戏目录结构不常见。")
                        : L("目录可能已被移动、删除或无法读取；请选择一个仍然存在的目录。"))
            } else if listing.items.isEmpty {
                // **empty**（还没存过档）—— 正常状态
                stateRow(
                    icon: "tray",
                    tint: .secondary,
                    title: L("还没有存档"),
                    detail: L("先去游戏里存一次档，回来这里就能看到。"))
            } else {
                saveList(listing)
            }
            saveDirectoryControls
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

    // MARK: - 存档目录

    private var saveDirectoryControls: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: overridePath == nil ? "wand.and.stars" : "folder.badge.gearshape")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .padding(.top, 2)
                VStack(alignment: .leading, spacing: 2) {
                    Text(overridePath == nil ? L("自动探测存档目录") : L("使用手动指定目录"))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    if let directory = listing?.dir {
                        Text(displayPath(directory))
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .help(directory)
                    } else if let overridePath {
                        Text(displayPath(overridePath))
                            .font(.system(size: 10, design: .monospaced))
                            .foregroundStyle(.orange)
                            .lineLimit(1)
                            .truncationMode(.middle)
                            .help(overridePath)
                    } else {
                        Text(L("尚未确定目录"))
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                    }
                }
                Spacer(minLength: 4)
                if let directory = listing?.dir {
                    Button {
                        revealDirectory(directory)
                    } label: {
                        Label(L("在访达中显示"), systemImage: "folder")
                    }
                    .controlSize(.small)
                    .help(L("在访达中打开这个存档目录"))

                    Button {
                        copyDirectoryPath(directory)
                    } label: {
                        Image(systemName: "doc.on.doc")
                    }
                    .controlSize(.small)
                    .help(L("复制存档目录路径"))
                    .accessibilityLabel(L("复制存档目录路径"))
                }
                Button(overridePath == nil ? L("选择存档目录…") : L("更改目录…")) {
                    chooseSaveDirectory()
                }
                .controlSize(.small)
                .disabled(isRunning || isWorking)
                .help(isRunning ? L("游戏正在运行，不能更改存档目录") : L("只记录目录位置，不会移动存档文件"))
            }
            if overridePath != nil {
                Button(L("恢复自动探测")) {
                    clearSaveDirectoryOverride()
                }
                .controlSize(.small)
                .disabled(isRunning || isWorking)
            }
        }
        .padding(8)
        .background(Color(nsColor: .controlBackgroundColor),
                    in: RoundedRectangle(cornerRadius: 7))
    }

    private func displayPath(_ path: String) -> String {
        (path as NSString).abbreviatingWithTildeInPath
    }

    private func revealDirectory(_ path: String) {
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: path)
    }

    private func copyDirectoryPath(_ path: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(path, forType: .string)
        session.reportCopiedPath()
    }
    private func chooseSaveDirectory() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.prompt = L("选择目录")
        panel.message = L("选择存档目录（不会移动现有文件）")
        if let overridePath {
            panel.directoryURL = URL(fileURLWithPath: overridePath)
        }
        guard panel.runModal() == .OK, let url = panel.url else { return }
        session.setDirectory(url.path)
    }

    private func clearSaveDirectoryOverride() {
        session.setDirectory(nil)
    }

    private func doExport() {
        let downloads = (NSHomeDirectory() as NSString).appendingPathComponent("Downloads")
        session.exportArchive(outputDirectory: downloads)
    }

    private func doImport() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.zip]
        panel.message = L("选择要导入的存档包（现有存档会先备份）")
        guard panel.runModal() == .OK, let url = panel.url else { return }
        session.importArchive(at: url)
    }

    // MARK: - 格式化

    /// 1024 进制，实现见 `ByteFormat.human`（与引擎页共用同一份）。
    private func formatBytes(_ bytes: Int64) -> String { ByteFormat.human(bytes) }

    /// 存档时间。按界面语言格式化，不写死 `zh_CN` —— 英文/日文界面下也该显示本地习惯的日期。
    private func shortDate(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = InterfaceLanguageStore.shared.resolved.locale
        f.dateFormat = "MM-dd HH:mm"
        return f.string(from: date)
    }
}
