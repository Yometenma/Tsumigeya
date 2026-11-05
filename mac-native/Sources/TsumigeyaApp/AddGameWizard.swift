// 添加游戏向导。
//
// 对应 Electron 版：`components/AddGameWizard.vue`（603 行 / U5+U6）
// 契约：M5.0 S3（只选文件 + 上退兜底）/ S4（去跳过 + 可改引擎）
//
// ===== 三步流程（与 Electron 版一致）=====
//
//   ① 选文件 → 反推目录 → 识别引擎
//   ② 确认引擎（**认错了可以手动改** —— 这是 U6 的核心）
//   ③ 填游戏信息（游戏名）→ 保存
//
// ===== ⚠️ 两个「不做」的选择 =====
//
// ① **不做「跳过，稍后安装」**（U6 删掉的）。
//    理由：跳过后用户存进去的是一个「跑不起来的配置」，而他以为是游戏的问题。
//    现在只有两条路：引擎已装 → 直接保存；没装 → 去装（或手动选别的引擎）。
//    但**装失败也放行**（断网不能卡死用户）—— 这是 S4 的判据。
//
// ② **不自动选引擎**。识别出来了**也要用户点一下确认**。
//    理由：识别是基于文件特征的推测，可能错（比如 Unity 那种）。
//    让用户确认一次，错了能改；自动保存就只能在启动失败时才发现。
import SwiftUI
import TsumigeyaCore

struct AddGameWizard: View {
    @EnvironmentObject private var store: AppStore

    /// 当前步骤。
    enum Step: Int {
        case pickFile = 0
        case confirmEngine = 1
        case nameAndSave = 2
    }

    @State private var step: Step = .pickFile
    @State private var pickedPath: String = ""
    @State private var outcome: GameImport.Outcome?
    @State private var selectedEngine: String = ""
    @State private var gameTitle: String = ""
    @State private var errorMessage: String?

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            content
            Divider()
            footer
        }
        .frame(width: 560, height: 460)
    }

    // MARK: - 头部（步骤指示）

    private var header: some View {
        HStack(spacing: 8) {
            Text("添加游戏")
                .font(.title3.weight(.semibold))
            Spacer()
            ForEach([Step.pickFile, .confirmEngine, .nameAndSave], id: \.rawValue) { s in
                HStack(spacing: 4) {
                    Circle()
                        .fill(step.rawValue >= s.rawValue ? Color.accentColor : Color.secondary.opacity(0.3))
                        .frame(width: 7, height: 7)
                    Text(stepLabel(s))
                        .font(.caption)
                        .foregroundStyle(step == s ? .primary : .secondary)
                }
                if s != .nameAndSave {
                    Rectangle()
                        .fill(Color.secondary.opacity(0.2))
                        .frame(width: 14, height: 1)
                }
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
    }

    private func stepLabel(_ s: Step) -> String {
        switch s {
        case .pickFile: return "选文件"
        case .confirmEngine: return "确认引擎"
        case .nameAndSave: return "命名"
        }
    }

    // MARK: - 内容

    @ViewBuilder
    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                switch step {
                case .pickFile: pickFileStep
                case .confirmEngine: confirmEngineStep
                case .nameAndSave: nameStep
                }
                if let errorMessage {
                    Label(errorMessage, systemImage: "exclamationmark.triangle.fill")
                        .font(.callout)
                        .foregroundStyle(.orange)
                        .textSelection(.enabled)
                }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    // MARK: 步骤 1：选文件

    private var pickFileStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("选择游戏里的任意一个文件")
                .font(.headline)
            Text("不用非得是可执行文件 —— 引擎会按「这个目录里有什么」来认。\n选错文件也没关系，会自动往上找一层。")
                .font(.callout)
                .foregroundStyle(.secondary)

            Button {
                pickFile()
            } label: {
                Label("选择文件…", systemImage: "folder")
            }
            .controlSize(.large)

            if !pickedPath.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("已选")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(pickedPath)
                        .font(.system(size: 11, design: .monospaced))
                        .textSelection(.enabled)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(nsColor: .controlBackgroundColor),
                            in: RoundedRectangle(cornerRadius: 6))
            }
        }
    }

    // MARK: 步骤 2：确认引擎

    private var confirmEngineStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let outcome {
                // 识别结果
                if let engine = outcome.engine {
                    Label("识别为 \(engine.name)", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                        .font(.headline)
                    if outcome.ascendLevel > 0 {
                        // ⚠️ **必须告诉用户「往上找了一层」**：
                        //    否则他选的 `/x/y/z/Game.exe` 被存成 `/x/y`，
                        //    以后想改都不知道为什么。
                        Text("你选的文件在子目录里，游戏目录定为它的上 \(outcome.ascendLevel) 层：\n\(outcome.resolvedFolder)")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }
                } else {
                    Label("没认出来", systemImage: "questionmark.circle.fill")
                        .foregroundStyle(.orange)
                        .font(.headline)
                    Text("这个目录的文件特征不匹配任何已知引擎。可以手动选一个 —— 或者点「取消」去看看是不是选错目录了。")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }

                Divider()

                // ⚠️ **引擎下拉永远可改**（U6 的核心）。
                //
                //    即使识别对了也让用户能改 —— 因为识别是推测，可能错。
                //    这比「识别错了就卡住」好得多。
                HStack(spacing: 10) {
                    Text("引擎")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .frame(width: 44, alignment: .leading)
                    Picker("", selection: $selectedEngine) {
                        ForEach(EngineRegistry.all, id: \.folder) { e in
                            Text(e.launchable ? e.name : "\(e.name)（仅识别）")
                                .tag(e.folder)
                        }
                    }
                    .labelsHidden()
                    .frame(maxWidth: 240)
                }

                // 引擎是否已装
                engineStatus
            }
        }
    }

    @ViewBuilder
    private var engineStatus: some View {
        let folder = selectedEngine
        let installed = store.isEngineInstalled(folder)

        if selectedEngine.isEmpty {
            EmptyView()
        } else if let e = EngineRegistry.find(folder: folder), !e.launchable {
            // ⚠️ **只识别的引擎要明确说「跑不了」**（D88）
            Label("这个引擎 Tsumigeya 只能识别，不能启动（需要 Windows 兼容层）",
                  systemImage: "exclamationmark.triangle.fill")
                .font(.callout)
                .foregroundStyle(.orange)
        } else if installed {
            Label("运行时已装好，可以直接保存", systemImage: "checkmark.circle.fill")
                .font(.callout)
                .foregroundStyle(.secondary)
        } else {
            // ⚠️ **没装也要能继续**（断网不能卡死用户）—— 这是 S4 的判据。
            //    但要说清「现在存进去还跑不起来」。
            VStack(alignment: .leading, spacing: 8) {
                Label("这个引擎的运行时还没装", systemImage: "exclamationmark.circle.fill")
                    .font(.callout)
                    .foregroundStyle(.orange)
                Text("可以先保存游戏 —— 之后到「引擎」页装好运行时再启动。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: 步骤 3：命名

    private var nameStep: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("给这个游戏起个名字")
                .font(.headline)

            TextField("游戏名", text: $gameTitle)
                .textFieldStyle(.roundedBorder)
                .font(.system(size: 14))

            VStack(alignment: .leading, spacing: 4) {
                Text("游戏目录")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(outcome?.resolvedFolder ?? "")
                    .font(.system(size: 11, design: .monospaced))
                    .textSelection(.enabled)
            }

            HStack(spacing: 6) {
                Text("引擎")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(EngineRegistry.find(folder: selectedEngine)?.name ?? selectedEngine)
                    .font(.caption)
            }
        }
    }

    // MARK: - 底部按钮

    private var footer: some View {
        HStack {
            Button("取消") {
                store.closeAddGame()
            }
            .keyboardShortcut(.cancelAction)

            Spacer()

            switch step {
            case .pickFile:
                Button("下一步") { moveToConfirm() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(pickedPath.isEmpty)

            case .confirmEngine:
                Button("上一步") { step = .pickFile }
                Button("下一步") { moveToName() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(selectedEngine.isEmpty)

            case .nameAndSave:
                Button("上一步") { step = .confirmEngine }
                Button("保存") { save() }
                    .buttonStyle(.borderedProminent)
                    .keyboardShortcut(.defaultAction)
                    .disabled(gameTitle.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
    }

    // MARK: - 动作

    private func pickFile() {
        errorMessage = nil
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.message = "选游戏目录里的任意一个文件（.app 包也行）"

        guard panel.runModal() == .OK, let url = panel.url else { return }
        pickedPath = url.path
        outcome = GameImport.inspect(selectedPath: pickedPath)
        // 识别出来了就预填（但**仍然让用户确认**）
        if let engine = outcome?.engine {
            selectedEngine = engine.folder
        }
        // 用目录名预填游戏名（用户可以改）
        gameTitle = (outcome?.resolvedFolder as NSString?)?.lastPathComponent ?? ""
    }

    private func moveToConfirm() {
        errorMessage = nil
        guard outcome != nil else {
            errorMessage = "还没选文件"
            return
        }
        step = .confirmEngine
    }

    private func moveToName() {
        errorMessage = nil
        guard !selectedEngine.isEmpty else {
            errorMessage = "请选择一个引擎"
            return
        }
        step = .nameAndSave
    }

    private func save() {
        errorMessage = nil
        guard let outcome else { return }

        let ok = store.addGame(
            title: gameTitle,
            folder: outcome.resolvedFolder,
            engine: selectedEngine
        )
        if ok {
            store.closeAddGame()
        } else {
            errorMessage = store.lastAddGameError ?? "保存失败"
        }
    }
}
