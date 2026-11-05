// 编辑页：改一个游戏的本地信息、引擎参数、分类归属。
//
// 对应 Electron 版：`pages/GameEditPage.vue`（295 行）+ 5 个区块组件
// 契约：M5.0 S11（保存合一 + 区块重排）/ D61（参数表单精简）/ D26（手改值不被覆盖）
//
// ===== ⚠️ 「保存合一」是这一页的核心（U8）=====
//
// Electron 版原来有**两套保存**：本地信息一套、DLsite 元数据一套，
// 用户改了三处要点两次保存 —— 那是用户最不满意的地方。
//
// 本鱼的做法：**全页一个保存按钮**。
// 所有改动先收在内存（staged），点保存时一次性写盘。
//
// ⚠️ 但有一个**例外**：分类归属**立刻落盘**。
//    因为它不属于「这个游戏的记录」（它在 library-meta.json 的 assignments 里，
//    是跨游戏的共享数据）。攒着等保存会让「取消编辑」时它已经被改了 ——
//    那比「改完不生效」更糟。
//
// ===== DLsite 元数据留给 P7 =====
//
// 游戏身份（封面 / 标题 / RJ / 搜索）需要 DLsite 集成。
// P5 只做**本地信息**（路径 / 引擎 / 参数 / 分类）。
// 那时编辑页会多一个「游戏信息」区块 —— 现在先不留空壳
// （留一个灰掉的区块比没有更让人困惑）。
import SwiftUI
import TsumigeyaCore

struct GameEditView: View {
    let game: GameRecord
    @EnvironmentObject private var store: AppStore

    // ===== 展开状态（哪些区块是打开的）=====
    //
    // ⚠️ 默认只展开「本地信息」与「引擎参数」——
    //    用户改得最多的就是这两个。分类与诊断默认收起。
    @State private var localOpen = true
    @State private var argsOpen = true
    @State private var categoriesOpen = false

    // ===== 暂存的编辑值（**点保存才落盘**）=====
    @State private var title: String = ""
    @State private var engine: String = ""
    @State private var gameArgs: [String: JSONValue] = [:]

    // ===== 状态 =====
    @State private var isDirty = false
    @State private var saveError: String?

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            Form {
                localSection
                argsSection
                categoriesSection
            }
            .formStyle(.grouped)
        }
        .onAppear {
            // 从游戏记录初始化暂存值
            title = game.gameTitle
            engine = game.gameEngine
            gameArgs = game.gameArgs ?? [:]
            isDirty = false
            saveError = nil
        }
    }

    // MARK: - 头部

    private var header: some View {
        HStack(spacing: 12) {
            Text("编辑")
                .font(.system(size: 15, weight: .semibold))
            Text(game.gameTitle)
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(1)

            Spacer()

            if isDirty {
                Text("有未保存的改动")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }

            if let saveError {
                Label(saveError, systemImage: "exclamationmark.triangle.fill")
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(2)
            }

            Button("还原") {
                title = game.gameTitle
                engine = game.gameEngine
                gameArgs = game.gameArgs ?? [:]
                isDirty = false
                saveError = nil
            }
            .disabled(!isDirty)

            Button("保存") {
                save()
            }
            .buttonStyle(.borderedProminent)
            .keyboardShortcut("s", modifiers: .command)
            .disabled(!isDirty)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
    }

    // MARK: - 本地信息

    private var localSection: some View {
        Section {
            TextField("游戏名", text: $title)
                .textFieldStyle(.roundedBorder)
                .onChange(of: title) { _, _ in isDirty = true }

            HStack(spacing: 10) {
                Text("引擎")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(width: 44, alignment: .leading)
                Picker("", selection: $engine) {
                    ForEach(EngineRegistry.all, id: \.folder) { e in
                        Text(e.launchable ? e.name : "\(e.name)（仅识别）")
                            .tag(e.folder)
                    }
                }
                .labelsHidden()
                .onChange(of: engine) { _, _ in isDirty = true }
            }

            HStack(spacing: 10) {
                Text("路径")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .frame(width: 44, alignment: .leading)
                Text(game.gamePath)
                    .font(.system(size: 11, design: .monospaced))
                    .textSelection(.enabled)
                    .lineLimit(2)
                    .truncationMode(.middle)
            }
            // ⚠️ **路径不可编辑**：改路径等于「这游戏搬走了」，
            //    那应该重新添加（会走识别流程），而不是在这里手打。
            Text("要换路径请重新添加这个游戏。")
                .font(.caption2)
                .foregroundStyle(.secondary)
        } header: {
            headerRow("本地信息", "游戏名、引擎、路径", isOpen: $localOpen)
        }
    }

    // MARK: - 引擎参数

    private var argsSection: some View {
        Section {
            if let manifest = store.manifest(for: game.gameEngine),
               !manifest.gameArgs.isEmpty {
                ForEach(manifest.orderedGameArgs, id: \.name) { pair in
                    EngineArgRow(
                        name: pair.name,
                        def: pair.def,
                        value: Binding(
                            get: { EngineArgs.value(for: pair.name, in: gameArgs, schema: pair.def) },
                            set: { newValue in
                                if let v = newValue {
                                    gameArgs[pair.name] = v
                                } else {
                                    gameArgs.removeValue(forKey: pair.name)
                                }
                                isDirty = true
                            }),
                        availableVersions: store.availableVersions(for: pair.def, engine: game.gameEngine)
                    )
                }
            } else if store.manifest(for: game.gameEngine) == nil {
                // ⚠️ **引擎没装时要明确说**，不是显示空白。
                //    用户会以为「这个引擎没有参数」，而实际是「还没装所以读不到 schema」。
                Label("这个引擎还没装，读不到参数定义。去「引擎」页装好后再回来。",
                      systemImage: "info.circle")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                Text("这个引擎没有可调参数。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        } header: {
            headerRow("引擎参数", "与启动方式相关的设置", isOpen: $argsOpen)
        }
    }

    // MARK: - 分类

    private var categoriesSection: some View {
        Section {
            if store.categories.isEmpty {
                Text("还没有建任何分类。")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Categories.ordered(store.categories), id: \.id) { pair in
                    let isMember = (store.assignments[game.id] ?? []).contains(pair.id)
                    Toggle(pair.def.name, isOn: Binding(
                        get: { isMember },
                        set: { member in
                            // ⚠️ **立刻落盘**（见文件头：分类归属不属于这个游戏的记录）
                            store.setCategoryMembership(
                                gameId: game.id, categoryId: pair.id, member: member)
                        }
                    ))
                }
            }
        } header: {
            headerRow("分类", "立刻生效，不需要点保存", isOpen: $categoriesOpen)
        }
    }

    // MARK: - 区块标题（可折叠）

    private func headerRow(
        _ title: String, _ subtitle: String, isOpen: Binding<Bool>
    ) -> some View {
        Button {
            withAnimation(.easeInOut(duration: 0.18)) { isOpen.wrappedValue.toggle() }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: isOpen.wrappedValue ? "chevron.down" : "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(.secondary)
                Text(title)
                    .font(.system(size: 12, weight: .semibold))
                Text(subtitle)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - 保存

    private func save() {
        saveError = nil
        let ok = store.updateGame(
            id: game.id, title: title, engine: engine, gameArgs: gameArgs)
        if ok {
            isDirty = false
        } else {
            saveError = store.lastAddGameError ?? "保存失败"
        }
    }
}

// MARK: - 一个引擎参数行

struct EngineArgRow: View {
    let name: String
    let def: GameArgDef
    @Binding var value: JSONValue?
    let availableVersions: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            switch EngineArgs.control(for: def, availableVersions: availableVersions) {
            case .boolean:
                Toggle(label, isOn: Binding(
                    get: { EngineArgs.booleanValue(for: name, in: [:], schema: def) },
                    set: { value = .bool($0) }
                ))
                .onAppear { /* 值由父 binding 提供 */ }

            case .text:
                HStack(spacing: 10) {
                    labelText
                    TextField("", text: Binding(
                        get: { value?.stringValue ?? "" },
                        set: { value = $0.isEmpty ? nil : .string($0) }
                    ))
                    .textFieldStyle(.roundedBorder)
                }

            case .integer:
                HStack(spacing: 10) {
                    labelText
                    TextField("", value: Binding(
                        get: { value?.intValue ?? 0 },
                        set: { value = .int($0) }
                    ), format: .number)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 120)
                }

            case .float:
                HStack(spacing: 10) {
                    labelText
                    TextField("", value: Binding(
                        get: { value?.doubleValue ?? 0 },
                        set: { value = .double($0) }
                    ), format: .number)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 120)
                }

            case .dropdown(let options):
                HStack(spacing: 10) {
                    labelText
                    Picker("", selection: Binding(
                        get: { value?.stringValue ?? options.first ?? "" },
                        set: { value = .string($0) }
                    )) {
                        ForEach(options, id: \.self) { Text($0).tag($0) }
                    }
                    .labelsHidden()
                }

            case .multiVersion(let versions):
                HStack(spacing: 10) {
                    labelText
                    if versions.isEmpty {
                        // ⚠️ **没有可选版本时明确说**，不是画一个空下拉
                        Text("磁盘上还没有可选版本")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    } else {
                        Picker("", selection: Binding(
                            get: { value?.stringValue ?? versions.last ?? "" },
                            set: { value = .string($0) }
                        )) {
                            ForEach(versions, id: \.self) { Text($0).tag($0) }
                        }
                        .labelsHidden()
                    }
                }

            case .array:
                HStack(spacing: 10) {
                    labelText
                    Text(EngineArgs.arrayValue(for: name, in: ["x": value ?? .null], schema: nil)
                        .joined(separator: ", "))
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Text("（在 P7 的配置文件里编辑）")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }

            case .unsupported(let type):
                // ⚠️ **不静默跳过**（跳过会让用户以为参数不存在）
                HStack(spacing: 8) {
                    labelText
                    Text("不支持的类型「\(type ?? "?")」（只读）")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
        }
    }

    private var label: String {
        def.label ?? name
    }

    private var labelText: some View {
        Text(label)
            .font(.system(size: 12))
            .frame(width: 150, alignment: .leading)
    }
}
