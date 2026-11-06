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
    /// 点「返回」时调（由 `GamePane` 提供）。
    var onDone: () -> Void = {}
    @EnvironmentObject private var store: AppStore

    // ===== 展开状态（哪些区块是打开的）=====
    //
    // ⚠️ 默认只展开「本地信息」与「引擎参数」——
    //    用户改得最多的就是这两个。分类与诊断默认收起。
    @State private var localOpen = true
    @State private var argsOpen = true
    @State private var categoriesOpen = false
    /// 元数据区块默认**展开**。
    ///
    /// ⚠️ 本鱼原来设的是 `false`（理由是「有元数据之后才需要改」），
    ///    但那样用户进编辑页**看不到这个功能存在**（要自己点开才知道）。
    ///    有元数据时它是「你要改的东西」，没有时只显示一行提示 —— 都不占地方。
    @State private var metaOpen = true

    // ===== 暂存的编辑值（**点保存才落盘**）=====
    @State private var title: String = ""
    @State private var engine: String = ""
    @State private var gameArgs: [String: JSONValue] = [:]

    // ===== 状态 =====
    @State private var saveError: String?

    private var isDirty: Bool {
        if title != game.gameTitle { return true }
        if engine != game.gameEngine { return true }
        if gameArgs != (game.gameArgs ?? [:]) { return true }
        return false
    }

    var body: some View {
        Form {
            localSection
            metaSection
            argsSection
            categoriesSection
        }
        .formStyle(.grouped)
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                header
                Divider()
            }
            // ⚠️ 必须给背景色，否则 Form 的内容会透上来与 header 重叠
            .background(.bar)
        }
        .onAppear {
            title = game.gameTitle
            engine = game.gameEngine
            gameArgs = game.gameArgs ?? [:]
            saveError = nil
        }
    }

    // MARK: - 头部

    private var header: some View {
        HStack(spacing: 12) {
            Button {
                onDone()
            } label: {
                Label("返回", systemImage: "chevron.left")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)

            Divider().frame(height: 16)

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
            // ⚠️⚠️ **必须按 `localOpen` 显隐内容**（用户 2026-06 报：
            //    「三角点了图标是变了，但并没有展开或收起」）。
            //
            //    本鱼原来只把 `isOpen` 传给 `headerRow` 用来切换 iconName ——
            //    于是**图标变了、内容一直显示**。那不是折叠，那是个假的折叠按钮。
            //
            //    ⚠️ 这类「只改装饰不改行为」的错误很难被截图发现（
            //       静态图里图标和内容都"正常"），只能靠用户点一下才知道。
            if localOpen {
            TextField("游戏名", text: $title)
                .textFieldStyle(.roundedBorder)

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
            }
        } header: {
            headerRow("本地信息", "游戏名、引擎、路径", isOpen: $localOpen)
        }
    }

    // MARK: - DLsite 元数据编辑

    /// 元数据编辑区块（P7）。
    ///
    /// ⚠️ **只在有元数据时显示区块内容**（没抓过就没有可改的东西）。
    ///    但仍显示标题行 —— 让用户知道「这里能改元数据」，
    ///    并给一个「去详情页抓取」的提示。
    private var metaSection: some View {
        Section {
            if metaOpen {
                if let meta = store.meta(for: game.id) {
                    metaEditFields(meta)
                } else {
                    Label("还没有作品信息。先到详情页抓取 DLsite 元数据，回来才能改。",
                          systemImage: "info.circle")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        } header: {
            headerRow("作品信息", "标题 / 社团 / 简介（手改的值不会被刷新覆盖）",
                      isOpen: $metaOpen)
        }
    }

    /// 元数据编辑字段。
    ///
    /// ⚠️⚠️ **用户改过的字段必须记进 `editedFields`**（D26）：
    ///    否则下次「刷新」时会被 DLsite 的值覆盖 —— 用户手改的值属于用户。
    ///
    /// ⚠️ **`rj` 不在可编辑列表里**（D25）：改 RJ 等于换一部作品，
    ///    那应该重新搜索/重新添加，而不是在编辑页手打。
    @ViewBuilder
    private func metaEditFields(_ meta: GameDlsiteMeta) -> some View {
        // 标题
        HStack(spacing: 10) {
            Text("标题")
                .font(.callout).foregroundStyle(.secondary)
                .frame(width: 44, alignment: .leading)
            TextField("", text: Binding(
                get: { meta.work.title ?? "" },
                set: { store.editMetaField(gameId: game.id, field: "title", value: $0) }
            ))
            .textFieldStyle(.roundedBorder)
        }

        // 社团
        HStack(spacing: 10) {
            Text("社团")
                .font(.callout).foregroundStyle(.secondary)
                .frame(width: 44, alignment: .leading)
            TextField("", text: Binding(
                get: { meta.work.circle ?? "" },
                set: { store.editMetaField(gameId: game.id, field: "circle", value: $0) }
            ))
            .textFieldStyle(.roundedBorder)
        }

        // 简介（多行）
        VStack(alignment: .leading, spacing: 4) {
            Text("简介")
                .font(.callout).foregroundStyle(.secondary)
            TextEditor(text: Binding(
                get: { meta.work.description ?? "" },
                set: { store.editMetaField(gameId: game.id, field: "description", value: $0) }
            ))
            .font(.system(size: 12))
            .frame(height: 90)
            .padding(4)
            .background(Color(nsColor: .textBackgroundColor),
                        in: RoundedRectangle(cornerRadius: 5))
            .overlay(RoundedRectangle(cornerRadius: 5)
                .strokeBorder(Color.secondary.opacity(0.25)))
        }

        // RJ（只读 —— 不可编辑，D25）
        HStack(spacing: 10) {
            Text("RJ")
                .font(.callout).foregroundStyle(.secondary)
                .frame(width: 44, alignment: .leading)
            Text(meta.work.rj)
                .font(.system(size: 12, design: .monospaced))
                .textSelection(.enabled)
            Spacer()
            if !meta.editedFields.isEmpty {
                Text("已手改：\(meta.editedFields.joined(separator: "、"))")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        Text("改 RJ 等于换一部作品 —— 请用「添加游戏」重新识别。")
            .font(.caption2)
            .foregroundStyle(.secondary)
    }

    // MARK: - 引擎参数

    private var argsSection: some View {
        Section {
            // ⚠️ 按 `argsOpen` 显隐（同 `localSection` 的注释：只改图标不改内容 = 假折叠）
            if argsOpen {
            if let manifest = store.manifest(for: game.gameEngine),
               !manifest.gameArgs.isEmpty {
                ForEach(manifest.orderedGameArgs, id: \.name) { pair in
                    EngineArgRow(
                        name: pair.name,
                        def: pair.def,
                        engine: game.gameEngine,
                        value: Binding(
                            get: { EngineArgs.value(for: pair.name, in: gameArgs, schema: pair.def) },
                            set: { newValue in
                                if let v = newValue {
                                    gameArgs[pair.name] = v
                                } else {
                                    gameArgs.removeValue(forKey: pair.name)
                                }
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
            }
        } header: {
            headerRow("引擎参数", "与启动方式相关的设置", isOpen: $argsOpen)
        }
    }

    // MARK: - 分类

    private var categoriesSection: some View {
        Section {
            // ⚠️ 按 `categoriesOpen` 显隐（同上）
            if categoriesOpen {
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
        } else {
            saveError = store.lastAddGameError ?? "保存失败"
        }
    }
}

// MARK: - 一个引擎参数行

struct EngineArgRow: View {
    let name: String
    let def: GameArgDef
    /// 引擎 folder（翻译参数名要用）。
    let engine: String
    @Binding var value: JSONValue?
    let availableVersions: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // ⚠️ **必须传 engine 与 key** —— 否则内置选项表（rgssVersion 的下拉）
            //    完全不生效（`EngineArgs.control` 里查不到就回落成文本框）。
            switch EngineArgs.control(
                for: def, engine: engine, key: name,
                availableVersions: availableVersions) {
            case .boolean:
                // ⚠️⚠️ **`get` 必须读 `value`，不能传空字典**
                //    （用户 2026-11-06 报：开关点了生效、但显示还是关的、而且关不掉）。
                //
                //    本鱼原来写的是 `booleanValue(for: name, in: [:], schema: def)`
                //    —— 传了个**空字典**，于是 `get` 永远读不到用户改的值，
                //    只会返回 manifest 的 default（false）。
                //
                //    表现：点了之后 `set` 写进去了（真的生效），
                //    但界面重绘时 `get` 又读出 false → **显示还是关的**；
                //    而用户再点一下是想关掉，`set(false)` 与当前显示相同 → **关不掉**。
                //
                //    正确做法：直接读 `value`（父层传进来的那个 binding）。
                Toggle(label, isOn: Binding(
                    get: { booleanCurrentValue },
                    set: { value = .bool($0) }
                ))

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
                    if let rich = EngineArgsOptions.options(engine: engine, key: name) {
                        Picker("", selection: Binding(
                            // ⚠️ **必须用 normalizedValue 同时认 string 与 int**。
                            //    真机数据里 `rgssVersion` 存的是**数字 0**（不是 "0"），
                            //    而 JSONValue.int(0).stringValue 是 nil
                            //    → Picker 匹配不上任何 tag → 显示裸数字（用户截了图报过来）。
                            get: { EngineArgsOptions.normalizedValue(value)
                                    ?? rich.first?.value ?? "" },
                            // ⚠️ **写回时必须写 int**：mkxp-row 的
                            //    `MkxpzConfig.build` 用 `.int(rgssVersion)`，
                            //    而 `resolveRtp` 同时认 int 与 string。
                            //    但保持与 manifest 一致的 int 更安全（少一次转换）。
                            set: { value = Int($0).map { JSONValue.int($0) } ?? .string($0) }
                        )) {
                            ForEach(rich, id: \.value) { opt in
                                Text(opt.label).tag(opt.value)
                            }
                            if let v = EngineArgsOptions.normalizedValue(value),
                               !EngineArgsOptions.isKnown(v, options: rich) {
                                Text("未知值（\(v)）").tag(v)
                            }
                        }
                        .labelsHidden()
                    } else {
                        Picker("", selection: Binding(
                            get: { value?.stringValue ?? options.first ?? "" },
                            set: { value = .string($0) }
                        )) {
                            ForEach(options, id: \.self) { Text($0).tag($0) }
                        }
                        .labelsHidden()
                    }
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

    /// 布尔参数的**当前值**。
    ///
    /// ⚠️ 直接读 `value`（binding），**不查 schema**（见上面那个 bug 的注释）。
    /// 只有 `value` 为 nil（用户从没设过）时才用 schema 的 default。
    private var booleanCurrentValue: Bool {
        if let v = value?.boolValue { return v }
        if let d = def.defaultValue?.boolValue { return d }
        return false
    }

    private var label: String {
        // ⚠️ **必须走翻译层**，不能直接用 `def.label`（那是英文，
        //    快照实测看到 `Start in Fullscreen` / `RGSS Version`）。
        //
        //    退化顺序：我们的中文表 → manifest 的英文 label → 键名。
        //    判据在 `EngineArgsLabels.label(...)`（纯函数，可单测）。
        EngineArgsLabels.label(engine: engine, key: name, manifestLabel: def.label)
    }

    private var labelText: some View {
        Text(label)
            .font(.system(size: 12))
            .frame(width: 150, alignment: .leading)
    }
}
