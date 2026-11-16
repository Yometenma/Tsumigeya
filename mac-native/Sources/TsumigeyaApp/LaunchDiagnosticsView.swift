import SwiftUI
import TsumigeyaCore

struct LaunchDiagnosticsView: View {
    let game: GameRecord
    var onManageEngines: (() -> Void)?
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var diagnosis: LaunchDiagnosis?
    @State private var checkedAt = Date()

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            Divider()
            if let diagnosis {
                diagnosisContent(diagnosis)
            } else {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("正在检查启动条件…").foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            Divider()
            HStack {
                Button {
                    dismiss()
                } label: {
                    Text("关闭").foregroundStyle(.black)
                }
                .buttonStyle(.bordered)
                .keyboardShortcut(.cancelAction)
                Spacer()
                if let diagnosis, diagnosis.items.contains(where: { $0.id == "runtime-binary" && $0.level == .blocking }),
                   let onManageEngines, !store.privacy.hidesTitles {
                    Button {
                        onManageEngines()
                    } label: {
                        Text("管理运行时").foregroundStyle(.black)
                    }
                    .buttonStyle(.bordered)
                }
                Button {
                    check()
                } label: {
                    Text("重新检查").foregroundStyle(.black)
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(22)
        .frame(width: 720, height: 590)
        .onAppear { check() }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "stethoscope")
                .foregroundStyle(.indigo)
            Text("启动诊断")
                .font(.title2.weight(.semibold))
            Text(store.privacy.hidesTitles ? "游戏 \(game.id)" : game.gameTitle)
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Spacer()
            Text(checkedAt, style: .time)
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }

    @ViewBuilder
    private func diagnosisContent(_ diagnosis: LaunchDiagnosis) -> some View {
        let blocking = diagnosis.items.filter { $0.level == .blocking }
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                Image(systemName: diagnosis.isReady ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
                    .foregroundStyle(diagnosis.isReady ? .green : .orange)
                Text(diagnosis.isReady ? "启动条件看起来正常" : "发现 \(blocking.count) 项需要处理的问题")
                    .font(.headline)
                Spacer()
                Text(EngineRegistry.find(folder: diagnosis.engine)?.name ?? diagnosis.engine)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if store.privacy.hidesTitles {
                Text("诊断详情已隐藏。关闭标题隐藏后可查看路径、运行时和处理建议。")
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(diagnosis.items) { item in
                            itemRow(item)
                        }
                        if let plan = diagnosis.plan {
                            planSection(plan)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func itemRow(_ item: LaunchDiagnosticItem) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon(for: item.level))
                .foregroundStyle(color(for: item.level))
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 4) {
                Text(item.title).font(.callout.weight(.medium))
                Text(item.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if let action = item.action {
                    Text("建议：\(action)")
                        .font(.caption)
                        .foregroundStyle(item.level == .blocking ? .orange : .secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
    }

    private func planSection(_ plan: LaunchPlanPreview) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("本次启动计划").font(.callout.weight(.medium))
            Text("运行时：\(plan.binary)")
            if let cwd = plan.workingDirectory { Text("工作目录：\(cwd)") }
            Text(plan.arguments.isEmpty ? "参数：无" : "参数：\(plan.arguments.joined(separator: "  "))")
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .textSelection(.enabled)
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.indigo.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
    }

    private func icon(for level: LaunchDiagnosticLevel) -> String {
        switch level {
        case .good: return "checkmark.circle.fill"
        case .notice: return "info.circle.fill"
        case .blocking: return "xmark.circle.fill"
        }
    }

    private func color(for level: LaunchDiagnosticLevel) -> Color {
        switch level {
        case .good: return .green
        case .notice: return .blue
        case .blocking: return .orange
        }
    }

    private func check() {
        diagnosis = nil
        checkedAt = Date()
        diagnosis = store.diagnoseLaunch(game: game)
    }
}
