import SwiftUI
import AppKit
import TsumigeyaCore

struct BatchImportView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var candidates: [LibraryIntake.Candidate]
    @State private var selected: Set<String> = []
    @State private var scanTask: Task<Void, Never>?
    @State private var scanToken: UUID?
    @State private var summary = "选择存放游戏的目录，扫描后勾选确认，不会自动添加或联网关联作品。"
    @State private var warnings: [String] = []
    @State private var error: String?

    init(previewCandidates: [LibraryIntake.Candidate] = []) {
        _candidates = State(initialValue: previewCandidates)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Text("批量入库").font(.title2.bold())
                Spacer()
                if scanToken != nil {
                    ProgressView().controlSize(.small)
                    Button {
                        cancelScan()
                    } label: {
                        Text("取消扫描").foregroundStyle(.black)
                    }
                    .buttonStyle(.bordered)
                } else {
                    Button {
                        chooseRoot()
                    } label: {
                        Text("选择目录并扫描…").foregroundStyle(.black)
                    }
                    .buttonStyle(.bordered)
                    .disabled(store.privacy.hidesTitles)
                }
            }
            if store.privacy.hidesTitles {
                Text("入库内容已隐藏，关闭标题隐藏后可继续。").foregroundStyle(.secondary)
                Spacer()
            } else {
                Text(summary).font(.callout).foregroundStyle(.secondary)
                Text("最多向下扫描三层、2000 个目录、200 个候选；命中后不再深入。无法识别的游戏请使用单个添加。")
                    .font(.caption).foregroundStyle(.secondary)
                if !warnings.isEmpty {
                    DisclosureGroup("有 \(warnings.count) 处目录无法读取") {
                        ScrollView { Text(warnings.joined(separator: "\n")).font(.caption).textSelection(.enabled) }
                            .frame(maxHeight: 80)
                    }
                }
                List {
                    ForEach($candidates) { $candidate in
                        let conflict = store.intakeConflict(candidate)
                        HStack(alignment: .top, spacing: 12) {
                            Toggle("选择游戏", isOn: Binding(
                                get: { selected.contains(candidate.id) },
                                set: { if $0 { selected.insert(candidate.id) } else { selected.remove(candidate.id) } }
                            ))
                            .labelsHidden()
                            .disabled(conflict != nil || scanToken != nil)
                            VStack(alignment: .leading, spacing: 5) {
                                TextField("游戏名", text: $candidate.title).textFieldStyle(.roundedBorder)
                                    .disabled(scanToken != nil || conflict != nil)
                                Text(candidate.folder).font(.caption).foregroundStyle(.secondary)
                                    .lineLimit(2).textSelection(.enabled)
                                if candidate.engine == "wine" {
                                    Picker("Windows 启动文件", selection: $candidate.entryPath) {
                                        Text("请选择启动文件").tag("")
                                        ForEach(WineRuntime.executables(in: candidate.folder), id: \.self) { file in
                                            Text((file as NSString).lastPathComponent).tag(file)
                                        }
                                    }
                                    .disabled(scanToken != nil || conflict != nil)
                                }
                                if let conflict { Text(conflict).font(.caption).foregroundStyle(.orange) }
                            }
                            let definition = EngineRegistry.find(folder: candidate.engine)
                            VStack(alignment: .trailing, spacing: 4) {
                                Text(definition?.name ?? candidate.engine).font(.caption)
                                Text(definition?.launchable == false ? "仅识别，无法直接启动" :
                                     (store.isEngineInstalled(candidate.engine) ? "运行时已安装" : "入库后需安装运行时"))
                                    .font(.caption2).foregroundStyle(.secondary)
                            }.frame(width: 145, alignment: .trailing)
                        }.padding(.vertical, 6)
                    }
                }
                .overlay {
                    if candidates.isEmpty && scanToken == nil { Text("尚无候选游戏").foregroundStyle(.secondary) }
                }
                if let error { Text(error).font(.callout).foregroundStyle(.red).textSelection(.enabled) }
            }
            HStack {
                Button {
                    cancelScan(); dismiss()
                } label: {
                    Text("取消").foregroundStyle(.black)
                }
                .buttonStyle(.bordered)
                .keyboardShortcut(.cancelAction)
                Spacer()
                Button {
                    let chosen = candidates.filter { selected.contains($0.id) }
                    if store.addBatch(chosen) { dismiss() }
                    else { error = store.lastAddGameError }
                } label: {
                    Text("添加所选（\(selected.count)）").foregroundStyle(.black)
                }
                .buttonStyle(.borderedProminent)
                .disabled(selected.isEmpty || scanToken != nil || store.privacy.hidesTitles)
            }
        }
        .padding(22)
        .frame(width: 780, height: 590)
        .onDisappear { scanTask?.cancel() }
    }

    private func chooseRoot() {
        let panel = NSOpenPanel()
        panel.title = "选择游戏集合目录"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let root = panel.url else { return }
        selected.removeAll(); candidates.removeAll(); warnings.removeAll(); error = nil
        let token = UUID(); scanToken = token
        summary = "正在扫描…"
        scanTask = Task { @MainActor in
            do {
                let result = try await store.scanGames(folder: root.path)
                guard !Task.isCancelled, scanToken == token else { return }
                candidates = result.candidates; warnings = result.warnings
                summary = "已检查 \(result.visited) 个目录，找到 \(candidates.count) 个候选。" +
                    (result.limited ? "已达到扫描范围或数量上限，结果可能不完整，可选择更小的目录继续。" : "请核对引擎并逐项勾选。")
            } catch {
                guard !Task.isCancelled, scanToken == token else { return }
                self.error = "扫描失败：\(error)"
                summary = "扫描未完成，未添加任何游戏。"
            }
            scanToken = nil; scanTask = nil
        }
    }

    private func cancelScan() {
        scanTask?.cancel(); scanTask = nil; scanToken = nil
        summary = "扫描已取消，未添加任何游戏。"
    }
}

struct RelocateGameView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var expected: GameRecord
    @State private var candidate: LibraryIntake.Candidate?
    @State private var confirmed = false
    @State private var error: String?

    init(game: GameRecord) { _expected = State(initialValue: game) }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("重新定位游戏目录").font(.title2.bold())
            if store.privacy.hidesTitles {
                Text("定位内容已隐藏，关闭标题隐藏后可继续。").foregroundStyle(.secondary)
            } else {
                Text(expected.gameTitle).font(.headline).lineLimit(2)
                Text("原路径：\(DetectPath.gameDirForFiles(expected.gamePath))")
                    .font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                Text("选择移动后的同一游戏目录。只更新路径，保留作品信息、分类、游玩记录和启动参数；不会移动游戏文件或存档。")
                Text("原引擎：\(EngineRegistry.find(folder: expected.gameEngine)?.name ?? expected.gameEngine)")
                    .font(.callout)
                Button {
                    chooseFolder()
                } label: {
                    Text("选择新目录…").foregroundStyle(.black)
                }
                .buttonStyle(.bordered)
                if let candidate {
                    Text(candidate.folder).font(.callout).textSelection(.enabled)
                    Text("识别引擎：\(EngineRegistry.find(folder: candidate.engine)?.name ?? candidate.engine)")
                        .font(.caption).foregroundStyle(.secondary)
                    Toggle("我已确认这是同一个游戏，而不只是相同引擎", isOn: $confirmed)
                }
                if let error { Text(error).foregroundStyle(.red).textSelection(.enabled) }
            }
            Spacer(minLength: 0)
            HStack {
                Button {
                    dismiss()
                } label: {
                    Text("取消").foregroundStyle(.black)
                }
                .buttonStyle(.bordered)
                .keyboardShortcut(.cancelAction)
                Spacer()
                Button {
                    guard let candidate else { return }
                    if store.relocateGame(expected, folder: candidate.folder) { dismiss() }
                    else { error = store.lastAddGameError }
                } label: {
                    Text("保存新路径").foregroundStyle(.black)
                }
                .buttonStyle(.borderedProminent)
                .disabled(candidate == nil || !confirmed || store.privacy.hidesTitles || store.runningGames[expected.id] != nil)
            }
        }
        .padding(24)
        .frame(width: 600, height: 410)
    }

    private func chooseFolder() {
        let panel = NSOpenPanel()
        panel.title = "选择移动后的游戏目录"
        panel.canChooseFiles = false; panel.canChooseDirectories = true
        panel.treatsFilePackagesAsDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return }
        confirmed = false; candidate = nil; error = nil
        do {
            let found = try store.inspectGameFolder(url.path)
            guard found.engine == expected.gameEngine else {
                error = "所选目录的引擎与原记录不同，请重新选择。"; return
            }
            candidate = found
        } catch { self.error = "无法使用此目录：\(error)" }
    }
}

