// 引擎页：管理 9 个引擎的运行时。
//
// 对应 Electron 版：`pages/EnginesPage.vue`（490 行）
// 契约：D60 / D88 / D90 / D91
//
// ===== 页面要回答的三件事（与 EngineStatus 一一对应）=====
//
//   ① 哪些装了、哪些能装
//   ② 装了但**装坏了**（目录在、二进制缺）→ 要能修
//   ③ 哪个不能跑 / 没验证过（D88 只识别、D90 上游限制、D91 未验证）
//
// ===== ⚠️ 一条交互判据：安装是**异步长任务**，UI 必须反映进度 =====
//
// RTP 有 244MB，用户会盯着进度条看。没有进度 = 他会以为卡死了、然后强杀。
//
// 进度来自 `EngineInstaller.install(onProgress:)`：
//   · `.step` —— 阶段切换（下载 / 解压）
//   · `.download` —— 字节进度（**可能没有 total** —— 服务器不给 content-length）
//     ⚠️ total 为 nil 时**不能显示 0%**，要显示「已下 X MB」的不确定进度条
import SwiftUI
import TsumigeyaCore

struct EnginesPage: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        List {
            Section {
                ForEach(store.engineEntries) { entry in
                    EngineRow(entry: entry)
                }
            } header: {
                HStack {
                    Text("引擎运行时")
                    Spacer()
                    Text("已装 \(EngineStatus.installedCount(store.engineEntries)) / \(EngineRegistry.launchable.count)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } footer: {
                Text("引擎运行时是启动游戏的必需品。装好对应的运行时之后，游戏就能用你自己的 Mac 跑起来。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .listStyle(.inset)
        .navigationTitle("引擎")
        .task {
            store.refreshInstalledEngines()
        }
    }
}

// MARK: - 一行

struct EngineRow: View {
    let entry: EngineStatus.Entry
    @EnvironmentObject private var store: AppStore

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                // 状态点
                Circle()
                    .fill(statusColor)
                    .frame(width: 7, height: 7)

                Text(entry.definition.name)
                    .font(.system(size: 13, weight: .medium))

                if !entry.definition.launchable {
                    Text("仅识别")
                        .font(.caption2)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Color.secondary.opacity(0.15), in: Capsule())
                        .foregroundStyle(.secondary)
                }

                Spacer()

                actionArea
            }

            // 警告（两种语义分开显示，见 EngineStatus.Warning 的注释）
            if let warning = entry.warning {
                warningView(warning)
            }

            // 进度（安装中）
            if let progress = store.engineProgress[entry.id] {
                progressView(progress)
            }
        }
        .padding(.vertical, 4)
    }

    // MARK: 状态色

    private var statusColor: Color {
        if !entry.definition.launchable { return .gray }
        if entry.installed { return .green }
        return .orange
    }

    // MARK: 操作区

    @ViewBuilder
    private var actionArea: some View {
        // 只识别引擎（D88）：没有运行时可装，只给一句说明
        if !entry.definition.launchable {
            Text("需要 Windows 兼容层")
                .font(.caption)
                .foregroundStyle(.secondary)
        } else if store.engineProgress[entry.id] != nil {
            // 安装中：显示取消
            Button("取消") {
                store.cancelEngineInstall(entry.id)
            }
            .controlSize(.small)
        } else if entry.installed {
            HStack(spacing: 6) {
                Text("已装")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Button("重装") {
                    store.installEngine(entry.id, force: true)
                }
                .controlSize(.small)
                Button("卸载") {
                    store.uninstallEngine(entry.id)
                }
                .controlSize(.small)
                .tint(.red)
            }
        } else {
            Button("安装") {
                store.installEngine(entry.id, force: false)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.small)
        }
    }

    // MARK: 警告

    private func warningView(_ warning: EngineStatus.Warning) -> some View {
        HStack(alignment: .top, spacing: 5) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.caption)
                .foregroundStyle(.orange)
            VStack(alignment: .leading, spacing: 1) {
                switch warning {
                case .unverified:
                    // ⚠️ 这条是**自我披露**（D91）：路径是从真下载包实测的，
                    //    但启动参数没在真实游戏上验过。说清楚，别让用户以为是「坏了」。
                    Text("未在真实游戏上验证过启动")
                        .font(.caption)
                    Text("运行时的安装路径已实测；启动参数沿用通用约定，还没有真实游戏样本。")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                case .upstreamGate(let reason):
                    Text(reason)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.leading, 15)
    }

    // MARK: 进度

    private func progressView(_ progress: AppStore.EngineProgress) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            switch progress {
            case .step(let label):
                Text(label)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                // 阶段切换时用不确定进度条（无法预知要多久）
                ProgressView()
                    .progressViewStyle(.linear)

            case .downloading(let name, let received, let total):
                if let total, total > 0 {
                    // ✅ 有总字节 → 确定进度
                    let fraction = min(1.0, Double(received) / Double(total))
                    ProgressView(value: fraction) {
                        Text("\(name)  \(Int(fraction * 100))%")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .progressViewStyle(.linear)
                } else {
                    // ⚠️ **没有总字节时不能用 0%**（服务器不给 content-length 会出现）
                    //    显示「已下 X MB」+ 不确定进度条 —— 让用户知道它在动
                    Text("\(name)  已下载 \(formatBytes(received))")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    ProgressView()
                        .progressViewStyle(.linear)
                }
            }
        }
        .padding(.leading, 15)
    }

    /// 1024 进制（与 `shared/save-view.ts` 的 `formatByteSize` 同一取向）。
    private func formatBytes(_ bytes: Int64) -> String {
        if bytes < 1024 { return "\(bytes) B" }
        let kb = Double(bytes) / 1024
        if kb < 1024 { return String(format: "%.0f KB", kb) }
        let mb = kb / 1024
        if mb < 1024 { return String(format: "%.1f MB", mb) }
        return String(format: "%.2f GB", mb / 1024)
    }
}
