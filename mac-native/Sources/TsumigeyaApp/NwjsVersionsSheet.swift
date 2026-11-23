// NW.js 的版本选择面板：追加安装其它运行时版本。
//
// ===== 为什么用户会需要它 =====
//
// NW.js 的 Chromium 版本随运行时变化，老游戏可能在新版上跑不起来（JS/渲染行为变了）。
// 启动器本来就支持多版本共存（D66：`deps/version/<v>/`，更新时保留已装版本），
// 但在这之前用户**没有办法装第二个版本** —— 这个面板补的就是这个缺口。
//
// ⚠️ 面板要如实区分两件事：
//    · 已装 —— 磁盘上有这个版本（`NwjsVersion.availableVersions`）
//    · 已验证 —— 在 macOS 26 上真的开出过游戏窗口（`NwjsRuntimeChoice.verified`）
//    「能下载」不等于「能用」，没验过的版本要标出来，别让用户白装 150MB。
//
// ⚠️ 清单类问题（`name` 缺失、尾逗号）**不靠换版本解决**：
//    v0.90.0 实测对同样的清单照样报 “Required value 'name' is missing or invalid.”。
//    那类问题由 `NwjsAppShim` 在「引擎管理 → 编辑游戏」之外自动处理。
import SwiftUI
import TsumigeyaCore

struct NwjsVersionsSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    private var installed: [String] {
        NwjsVersion.availableVersions(dataDir: store.dataDir)
    }

    private var isInstallingAny: Bool {
        store.engineProgress["nwjs"] != nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text(L("安装其它 NW.js 版本"))
                    .font(.headline)
                Text(L("装好后在「编辑游戏 → 引擎参数 → 版本」里选这个版本。已装的版本不会被覆盖或删除。"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            List(EngineDependencies.nwjsRuntimeChoices, id: \.version) { choice in
                row(for: choice)
            }
            .listStyle(.inset)
            .frame(minHeight: 200)

            if let error = store.engineErrors["nwjs"] {
                Label(error, systemImage: "exclamationmark.triangle")
                    .font(.caption)
                    .foregroundStyle(.orange)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }

            HStack {
                Spacer()
                Button(L("完成")) { dismiss() }
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(18)
        .frame(width: 470)
    }

    @ViewBuilder
    private func row(for choice: EngineDependencies.NwjsRuntimeChoice) -> some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(choice.version)
                    .font(.system(size: 13, weight: .medium))
                HStack(spacing: 6) {
                    Text(L("Apple 芯片原生"))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    if !choice.verified {
                        // 只验证了「能下载」，没验证「窗口能出来」
                        Text(L("未在 macOS 26 上验证窗口"))
                            .font(.caption2)
                            .foregroundStyle(.orange)
                    }
                }
            }

            Spacer()

            if installed.contains(choice.version) {
                Label(L("已装"), systemImage: "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.green)
                    .labelStyle(.titleAndIcon)
            } else if isInstallingAny {
                Text(L("安装中…"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Button(L("安装")) {
                    store.installNwjsVersion(choice.version)
                }
                .controlSize(.small)
            }
        }
        .padding(.vertical, 2)
    }
}
