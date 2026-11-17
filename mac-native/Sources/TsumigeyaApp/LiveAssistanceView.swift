import SwiftUI
import TsumigeyaCore

struct LiveAssistanceView: View {
    @ObservedObject var session: AssistanceSession
    @State private var query = ""
    @State private var draft = ""
    @State private var chosen: AssistanceVariable?
    @State private var action = "set"
    @State private var confirm = false
    @State private var confirmReset = false
    @State private var booleanDraft = false
    @State private var baseline: [String: Double]?
    @State private var candidates: Set<String>?
    @State private var knownValue = ""
    private var variables: [AssistanceVariable] {
        (session.liveState?.variables ?? []).filter { row in
            (candidates == nil || candidates!.contains(row.key)) && (query.isEmpty || row.name.localizedCaseInsensitiveContains(query) || row.key.localizedCaseInsensitiveContains(query) || display(row.value).localizedCaseInsensitiveContains(query))
        }
    }
    private func display(_ value: JSONValue) -> String { (try? JSONEncoder().encode(value)).map { String(decoding: $0, as: UTF8.self) } ?? "" }
    private func number(_ value: JSONValue) -> Double? {
        switch value { case .int(let n): Double(n); case .double(let n): n; default: nil }
    }
    private func scan(_ mode: String) {
        let rows = session.liveState?.variables ?? []
        let current = Dictionary(uniqueKeysWithValues: rows.compactMap { row in number(row.value).map { (row.key, $0) } })
        if mode == "unknown" || mode == "exact" {
            let target = Double(knownValue)
            candidates = Set(current.filter { mode == "unknown" || $0.value == target }.keys)
        } else if let baseline {
            candidates = Set((candidates ?? Set(baseline.keys)).filter { key in
                guard let old = baseline[key], let now = current[key] else { return false }
                switch mode { case "increased": return now > old; case "decreased": return now < old; case "changed": return now != old; default: return now == old }
            })
        }
        baseline = current
    }
    private func commandValue(_ row: AssistanceVariable) -> String? {
        let value: JSONValue
        switch row.value {
        case .bool: value = .bool(booleanDraft)
        case .string: value = .string(draft)
        case .int, .double:
            guard let number = Double(draft), number.isFinite, abs(number) <= 1e12 else { return nil }
            if case .int = row.value, let integer = Int(draft) { value = .int(integer) }
            else { value = .double(number) }
        default: return nil
        }
        return (try? JSONEncoder().encode(value)).map { String(decoding: $0, as: UTF8.self) }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(session.project?.module.cheatInstructions ?? "")
            Text("锁定和搜索只在本次运行有效；新游戏／读档会解除锁定。数值修改本身仍可能写入游戏存档。").font(.caption).foregroundStyle(.secondary)
            Text(session.liveMessage).textSelection(.enabled)
            if session.installed && session.options.cheats {
                HStack {
                    Button("刷新状态") { session.refreshLive() }
                    Button("解除全部锁定") { chosen = nil; action = "reset"; confirmReset = true }.disabled(session.liveState?.ready != true || session.pendingCommand != nil)
                }
                TextField("搜索变量、名称或数值", text: $query)
                HStack {
                    TextField("已知数值", text: $knownValue).frame(maxWidth: 130)
                    Button("已知数值查找") { scan("exact") }.disabled(Double(knownValue) == nil)
                    Button("未知数值查找") { scan("unknown") }
                }.disabled(session.liveState?.ready != true)
                HStack {
                    Button("增加") { scan("increased") }; Button("减少") { scan("decreased") }
                    Button("变化") { scan("changed") }; Button("未变化") { scan("unchanged") }
                    Button("显示全部") { baseline = nil; candidates = nil }
                }.disabled(baseline == nil)
                Text("匹配 \(variables.count) 条，显示前 100 条；筛选依据每次查找时的数值快照。").font(.caption).foregroundStyle(.secondary)
                ForEach(Array(variables.prefix(100))) { row in
                    HStack {
                        VStack(alignment: .leading) { Text(row.name); Text("\(row.key) = \(display(row.value))\(row.locked ? "（锁定中）" : "")").font(.caption).textSelection(.enabled) }
                        Spacer()
                        Button("编辑") { chosen = row; draft = row.value.stringValue ?? display(row.value); booleanDraft = row.value.boolValue ?? false; action = "set" }
                        if row.locked { Button("解除锁定") { session.sendLive(action: "unlock", key: row.key, value: "null") } }
                    }.disabled(session.pendingCommand != nil || session.liveState?.ready != true)
                }
            }
        }
        .task(id: session.project?.identity) {
            var previous: String?
            while !Task.isCancelled {
                session.refreshLive()
                if previous != session.liveState?.session { baseline = nil; candidates = nil; chosen = nil; previous = session.liveState?.session }
                do { try await Task.sleep(for: .seconds(1)) } catch { break }
            }
        }
        .sheet(item: $chosen) { row in
            VStack(alignment: .leading, spacing: 16) {
                Text("修改游戏状态").font(.title2.bold())
                Text("\(row.name)（\(row.key)）").textSelection(.enabled)
                Text("原值：\(display(row.value))").textSelection(.enabled)
                if case .bool = row.value {
                    Toggle("目标状态：\(booleanDraft ? "开启" : "关闭")", isOn: $booleanDraft)
                } else {
                    TextField(row.value.stringValue == nil ? "输入目标数值" : "输入目标文字", text: $draft)
                }
                Text("只修改当前项目，不改变数值、开关或文字的类型。修改可能影响剧情或写入存档，请先备份。").font(.caption)
                HStack {
                    Button("取消") { chosen = nil }; Spacer()
                    Button("修改并锁定") { action = "lock"; confirm = true }.disabled(commandValue(row) == nil)
                    Button("修改") { action = "set"; confirm = true }.disabled(commandValue(row) == nil)
                }
            }.padding(24).frame(width: 520)
            .confirmationDialog("确认修改当前游戏状态？", isPresented: $confirm) {
                Button("确认修改", role: .destructive) { if let value = commandValue(row) { session.sendLive(action: action, key: row.key, value: value); chosen = nil } }
            } message: { Text("仅发送当前变量的新值。此操作可能改变游戏进度，移除辅助不能撤销已写入存档的修改。") }
        }
        .confirmationDialog("解除本次全部锁定？", isPresented: $confirmReset) {
            Button("解除全部锁定") { session.sendLive(action: "reset", key: "", value: "null") }
        }
    }
}
