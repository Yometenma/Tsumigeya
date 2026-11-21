// 设置页。
//
// 对应 Electron 版：`pages/SettingsPage.vue`（325 行）
// 契约：M5.0 S9（U9 分组化）/ D30（不再询问做设置开关）/ D83（存档同步只有 none/manual）
//
// ===== 分组是「数据」，不是 13 个并排的 Form =====
//
// 分组定义在 `SettingsGroups.swift`（纯数据 + 「没漏项」判据）。
// 本文件只负责**按分组渲染**，不判断「某项该属于哪组」——
// 那个判断一旦写进 UI 就变成「谁也不知道全不全」。
//
// ===== ⚠️ 为什么用 `Form` + `Section` 而不是 `List` =====
//
// mac 的设置面板惯例是「可折叠的分组盒子」（系统偏好设置就是这个样子）。
// `Form` + `Section` 是 SwiftUI 里最接近的：
//   · 自带分组背景与圆角
//    · 标签左对齐、控件右对齐（这是 mac 表单的标准布局）
//
// 折叠态用 `DisclosureGroup` —— 它自带展开箭头和平滑动画。
import SwiftUI
import TsumigeyaCore

struct SettingsPage: View {
    @EnvironmentObject private var store: AppStore
    @State private var selectedGroup: SettingsGroups.GroupId

    init(initialGroup: SettingsGroups.GroupId = .appearance) {
        _selectedGroup = State(initialValue: initialGroup)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                Text("设置").font(.system(size: 24, weight: .bold))
                Text(selectedGroup == .metadata ? "语言与接口选项自动保存；密钥和自定义参数需单独确认。" : "更改后自动保存，无需另外确认。")
                    .font(.callout).foregroundStyle(.secondary)
                Picker("设置分组", selection: $selectedGroup) {
                    ForEach(SettingsGroups.groups, id: \.id) { group in
                        Text(group.id.title).tag(group.id)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .padding(.top, 12)
            }
            .padding(24)

            Form {
                ForEach(SettingsGroups.groups.filter { $0.id == selectedGroup }, id: \.id) { group in
                    if group.id == .metadata {
                        MetadataSettingsForm()
                    } else {
                        Section {
                            if group.keys.isEmpty {
                                InfoRows()
                            } else {
                                ForEach(group.keys.filter { SettingRow(key: $0).isAvailable }, id: \.self) { key in
                                    SettingRow(key: key)
                                }
                                // 界面语言由 SettingRow 的 .language 分支渲染（唯一一处），
                                // 这里不再重复放一行只读文案。
                                let unavailable = group.keys.filter { !SettingRow(key: $0).isAvailable }
                                if !unavailable.isEmpty {
                                    DisclosureGroup(String(format: L("尚未提供的选项（%lld）"), unavailable.count)) {
                                        ForEach(unavailable, id: \.self) { key in
                                            SettingRow(key: key).disabled(true)
                                        }
                                    }
                                }
                            }
                        } header: {
                            GroupLabel(id: group.id)
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .id(selectedGroup)
        }
        .frame(maxWidth: 900, maxHeight: .infinity, alignment: .topLeading)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

// MARK: - 分组标题

struct GroupLabel: View {
    let id: SettingsGroups.GroupId

    var body: some View {
        HStack(spacing: 6) {
            Text(id.title)
                .font(.system(size: 12, weight: .semibold))
            Text(id.footnote)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
        }
    }
}

// MARK: - 一行设置

struct SettingRow: View {
    let key: SettingsGroups.Key
    @EnvironmentObject private var store: AppStore

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            // ⚠️ **还没接上的设置要标出来**。
            //
            //    这是本鱼自己查出来的问题：设置页 12 项里**只有 1 项真的生效**。
            //    「能改、能存、但不生效」比「改不了」更糟 ——
            //    用户改了主题看不出变化，会怀疑软件坏了，而不会想到「这功能还没做完」。
            //
            //    所以：**没实现的前面挂一个「未启用」标记**，说清它现在没作用。
            //    这不是甩锅，是让用户能区分「坏了」和「还没做」。
            // ⚠️⚠️ **标注的两种语义必须分开**（用户 2026-11-06 报：
            //    「开关开着的时候为什么还是显示未启用」）。
            //
            //    本鱼原来只有一个 `pendingNote` 字符串，**一律渲染成「未启用」胶囊**。
            //    于是 `saveSyncMode`（manual 模式**明明能用**）也挂上了「未启用」——
            //    自己写的说明「只有手动模式能用」被自己的标签否定掉了。
            //
            //    ⚠️ 这与审计发现的「过时标注」是同一类问题：
            //       **标签在替内容判断**，而标签是硬编码的。
            //
            //    现在分开：
            //      · 功能没做      → 「未启用」胶囊 + 灰字说明
            //      · 能用但有须知  → **只有**灰字说明（不挂胶囊）
            if let note = pendingNote {
                HStack(spacing: 6) {
                    if note.isNotImplemented {
                        Text("尚未实现")
                            .font(.system(size: 9, weight: .medium))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Color.secondary.opacity(0.15), in: Capsule())
                            .foregroundStyle(.secondary)
                    }
                    Text(note.text)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }

            switch key {
            case .metadataPreferredLanguage, .metadataFallbackLanguage:
                Picker(key == .metadataPreferredLanguage ? "作品信息优先语言" : "缺失时回退语言", selection: Binding(
                    get: { store.settingString(key) }, set: { store.setSetting(key, .string($0)) }
                )) {
                    if key == .metadataFallbackLanguage { Text("不回退").tag("none") }
                    ForEach(MetadataLanguage.allCases, id: \.rawValue) { Text($0.name).tag($0.rawValue) }
                }
                Text("只选择商品页面语言，不代表游戏支持该语言；未翻译的字段可能保留原文。已有资料请手动刷新。")
                    .font(.caption).foregroundStyle(.secondary)
            case .metadataEndpoint, .metadataModel:
                TextField(key == .metadataEndpoint ? "AI 接口完整地址" : "模型名称", text: Binding(
                    get: { store.settingString(key) }, set: { store.setSetting(key, .string($0)) }
                ))
            case .metadataMode:
                Picker("AI 接口协议", selection: Binding(get: { store.settingString(key) }, set: { store.setSetting(key, .string($0)) })) {
                    Text("兼容聊天接口 · 可配独立搜索").tag("chat")
                    Text("Responses · 支持原生或独立搜索").tag("responses")
                }
            case .metadataLANEndpoint, .metadataSearchLANEndpoint:
                MetadataLANPermissionView(search: key == .metadataSearchLANEndpoint)
            case .metadataTimeout, .metadataInputLimit, .metadataSearchLimit:
                Picker(key == .metadataTimeout ? "模型等待上限" : key == .metadataInputLimit ? "单次正文长度上限" : "搜索候选数量上限", selection: Binding(get: { store.settingString(key) }, set: { store.setSetting(key, .string($0)) })) {
                    if key == .metadataTimeout {
                        Text("九十秒").tag("90"); Text("三分钟").tag("180"); Text("五分钟").tag("300"); Text("十分钟").tag("600")
                    } else if key == .metadataInputLimit {
                        Text("八千字").tag("8000"); Text("一万六千字").tag("16000"); Text("三万字").tag("30000"); Text("四万五千字").tag("45000")
                    } else {
                        Text("三条").tag("3"); Text("五条").tag("5"); Text("十条").tag("10")
                    }
                }
            case .metadataJSONOutput:
                Toggle("请求模型输出 JSON 对象", isOn: boolBinding(key))
                Text("仅在服务支持结构化输出时启用；不支持时请关闭，不会自动重试产生额外调用。") .font(.caption).foregroundStyle(.secondary)
            case .metadataDisableThinking:
                Toggle("关闭兼容模型的思考模式", isOn: boolBinding(key))
                Text("仅聊天协议发送模板参数；需服务支持 enable_thinking。默认不发送，避免与其他服务不兼容。") .font(.caption).foregroundStyle(.secondary)
            case .metadataSearchProvider:
                Picker("按名称搜索的方式", selection: stringBinding(key)) {
                    Text("关闭联网搜索").tag("disabled"); Text("模型原生联网").tag("native")
                    Text("独立搜索 · Tavily").tag("tavily"); Text("独立搜索 · SearXNG").tag("searxng"); Text("独立搜索 · 自定义接口").tag("custom")
                }
                Text("独立搜索不要求模型支持联网或工具调用。先搜索并选来源，再由模型读取正文整理。搜索失败不切换其他收费服务。") .font(.caption).foregroundStyle(.secondary)
            case .metadataSearchEndpoint:
                if !["disabled", "native"].contains(store.settingString(.metadataSearchProvider)) {
                    TextField("搜索接口完整地址（Tavily 留空使用官方地址）", text: stringBinding(key))
                    Text("SearXNG 请填完整搜索路径并在服务端启用 JSON；自定义接口仅支持 JSON 响应和 Bearer 认证。") .font(.caption).foregroundStyle(.secondary)
                }
            case .metadataSearchMethod:
                if store.settingString(.metadataSearchProvider) == "custom" {
                    Picker("自定义搜索请求方式", selection: stringBinding(key)) { Text("GET · 查询参数").tag("GET"); Text("POST · JSON 正文").tag("POST") }
                }
            case .metadataSearchParameters:
                if store.settingString(.metadataSearchProvider) == "custom" { MetadataSearchParametersEditor() }
            case .metadataSearchQueryKey, .metadataSearchResultsPath, .metadataSearchTitlePath, .metadataSearchURLPath, .metadataSearchSummaryPath:
                if store.settingString(.metadataSearchProvider) == "custom" {
                    TextField(searchFieldLabel, text: stringBinding(key))
                    if key == .metadataSearchResultsPath { Text("字段路径使用点号分隔，结果路径留空表示根数组。") .font(.caption).foregroundStyle(.secondary) }
                }
            case .appearance:
                Picker("外观", selection: Binding(
                    get: { store.settingString(.appearance) },
                    set: { store.setSetting(.appearance, .string($0)) }
                )) {
                    Text("跟随系统").tag("system")
                    Text("浅色").tag("light")
                    Text("深色").tag("dark")
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 260)

            case .language:
                Picker("界面语言", selection: Binding(
                    get: { store.interfaceLanguage.settingValue },
                    set: { store.setInterfaceLanguage(InterfaceLanguage.fromSetting($0)) }
                )) {
                    Text("跟随系统").tag(InterfaceLanguage.system.settingValue)
                    Text("简体中文").tag(InterfaceLanguage.simplifiedChinese.settingValue)
                    Text("English").tag(InterfaceLanguage.english.settingValue)
                    Text("日本語").tag(InterfaceLanguage.japanese.settingValue)
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 420)
                Text("默认跟随系统语言；系统语言不是中文、英文或日文时显示英文。切换后界面立即更新。")
                    .font(.caption2)
                    .foregroundStyle(.secondary)

            case .deletionConfirmation:
                Toggle("删除游戏前弹确认", isOn: Binding(
                    get: { store.settingBool(.deletionConfirmation) },
                    set: { store.setSetting(.deletionConfirmation, .bool($0)) }
                ))

            case .saveSyncMode:
                LabeledContent("存档备份", value: "手动导入导出")
                Text("在游戏详情的「存档」页操作，无需另外启用。备份文件只保存在你选择的位置。")
                    .font(.caption2)
                    .foregroundStyle(.secondary)

            case .preferredLanguage:
                Picker("首选语言版本", selection: Binding(
                    get: { store.settingString(.preferredLanguage) },
                    set: { store.setSetting(.preferredLanguage, .string($0)) }
                )) {
                    Text("不启用").tag("none")
                    Text("中文").tag("zh")
                    Text("日文").tag("ja")
                    Text("英文").tag("en")
                    Text("韩文").tag("ko")
                }

            case .fallbackLanguage:
                Picker("次选语言版本", selection: Binding(
                    get: { store.settingString(.fallbackLanguage) },
                    set: { store.setSetting(.fallbackLanguage, .string($0)) }
                )) {
                    Text("不启用").tag("none")
                    Text("中文").tag("zh")
                    Text("日文").tag("ja")
                    Text("英文").tag("en")
                    Text("韩文").tag("ko")
                }

            case .languageSwitchPrompt:
                Toggle("启动非偏好语言版时提示", isOn: Binding(
                    get: { store.settingBool(.languageSwitchPrompt) },
                    set: { store.setSetting(.languageSwitchPrompt, .bool($0)) }
                ))

            case .nonInstalledAutodetect:
                Toggle("自动识别未装引擎的游戏", isOn: Binding(
                    get: { store.settingBool(.nonInstalledAutodetect) },
                    set: { store.setSetting(.nonInstalledAutodetect, .bool($0)) }
                ))

            case .diagnoseBeforeLaunch:
                Toggle("启动前自动诊断", isOn: Binding(
                    get: { store.settingBool(.diagnoseBeforeLaunch) },
                    set: { store.setSetting(.diagnoseBeforeLaunch, .bool($0)) }
                ))
                Text("诊断是纯本地文件扫描，毫秒级。关掉它启动会略快一点。")
                    .font(.caption2)
                    .foregroundStyle(.secondary)

            case .checkModuleUpdatesOnStartup:
                Toggle("启动时检查引擎更新", isOn: Binding(
                    get: { store.settingBool(.checkModuleUpdatesOnStartup) },
                    set: { store.setSetting(.checkModuleUpdatesOnStartup, .bool($0)) }
                ))
            }
        }
        }

    /// 未实现的选项与已实现但有使用限制的选项分开标识，避免误导用户。
    struct Note {
        /// 这句说明是「功能没做」还是「能用但有须知」。
        ///
        /// ⚠️ 这个区分**必须显式**，不能让渲染层去猜：
        ///    猜错的表现就是 `saveSyncMode`（能用）被标成「未启用」，
        ///    而它自己的说明却写着「只有手动模式能用」—— 自相矛盾。
        let isNotImplemented: Bool
        let text: String

        static func notImplemented(_ text: String) -> Note {
            Note(isNotImplemented: true, text: text)
        }

        /// 能用，但有件事用户需要知道（**不挂「未启用」胶囊**）。
        static func caveat(_ text: String) -> Note {
            Note(isNotImplemented: false, text: text)
        }
    }

    private func stringBinding(_ key: SettingsGroups.Key) -> Binding<String> {
        Binding(get: { store.settingString(key) }, set: { store.setSetting(key, .string($0)) })
    }
    private func boolBinding(_ key: SettingsGroups.Key) -> Binding<Bool> {
        Binding(get: { store.settingBool(key) }, set: { store.setSetting(key, .bool($0)) })
    }
    private var searchFieldLabel: String {
        switch key {
        case .metadataSearchQueryKey: "关键词参数名"
        case .metadataSearchResultsPath: "结果数组路径"
        case .metadataSearchTitlePath: "结果标题路径"
        case .metadataSearchURLPath: "结果链接路径"
        case .metadataSearchSummaryPath: "结果摘要路径"
        default: "附加参数（JSON，不含密钥）"
        }
    }
    var isAvailable: Bool { pendingNote?.isNotImplemented != true }

    private var pendingNote: Note? {
        switch key {
        case .appearance, .language, .deletionConfirmation, .metadataPreferredLanguage, .metadataFallbackLanguage, .metadataEndpoint, .metadataModel, .metadataMode, .metadataLANEndpoint, .metadataTimeout, .metadataInputLimit, .metadataJSONOutput, .metadataDisableThinking, .metadataSearchProvider, .metadataSearchEndpoint, .metadataSearchLANEndpoint, .metadataSearchLimit, .metadataSearchMethod, .metadataSearchQueryKey, .metadataSearchResultsPath, .metadataSearchTitlePath, .metadataSearchURLPath, .metadataSearchSummaryPath, .metadataSearchParameters:
            return nil
        case .saveSyncMode:
            // ⚠️ **P6 做完后 manual 模式真的能用** → caveat 而不是 notImplemented。
            //    「不接任何云」是用户**需要知道的事实**（D83：半成品云比没有更糟，
            //    用户会以为存档在云上从而不再手动备份）。
            return .caveat(L("只提供手动导入导出；不接任何云，存档不会上传。"))
        case .preferredLanguage, .fallbackLanguage, .languageSwitchPrompt:
            return .notImplemented(L("多语言版本检测还没做"))
        case .nonInstalledAutodetect:
            return .notImplemented(L("自动识别走的是引擎页，还没接这个开关"))
        case .diagnoseBeforeLaunch:
            return .notImplemented(L("启动诊断还没做"))
        case .checkModuleUpdatesOnStartup:
            return .notImplemented(L("启动更新检查还没做"))
        }
    }
}

struct InfoRows: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            InfoRow("数据目录", store.dataDir, mono: true)
            Button("在访达中打开数据目录") {
                NSWorkspace.shared.open(URL(fileURLWithPath: store.dataDir))
            }
            InfoRow("版本", appVersion)
            InfoRow("平台", "macOS \(platformString)")
        }
    }

    /// 安装包使用 Info.plist；SwiftPM 开发入口没有版本信息，回退值与打包脚本同步。
    private var appVersion: String {
        if let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
           !v.isEmpty {
            return v
        }
        return "3.0.0（开发构建，未打包）"
    }

    private var platformString: String {
        "\(ProcessInfo.processInfo.operatingSystemVersion.majorVersion)"
            + ".\(ProcessInfo.processInfo.operatingSystemVersion.minorVersion) · "
            + (Arch.current() == .arm64 ? "arm64" : "x64")
    }
}

struct InfoRow: View {
    let label: String
    let value: String
    var mono: Bool = false

    init(_ label: String, _ value: String, mono: Bool = false) {
        self.label = label
        self.value = value
        self.mono = mono
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(label)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .frame(width: 120, alignment: .leading)
            Text(value)
                .font(mono ? .system(size: 11, design: .monospaced) : .system(size: 12))
                .textSelection(.enabled)
                .lineLimit(2)
                .truncationMode(.middle)
            Spacer()
        }
    }
}
