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
    @State private var selectedGroup: SettingsGroups.GroupId

    init(initialGroup: SettingsGroups.GroupId = .appearance) {
        _selectedGroup = State(initialValue: initialGroup)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 8) {
                Text("设置").font(.system(size: 24, weight: .bold))
                Text(selectedGroup == .metadata ? "语言、地址和模型自动保存；接口密钥需单独保存。" : "更改后自动保存，无需另外确认。")
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
                    Section {
                        if group.keys.isEmpty {
                            InfoRows()
                        } else {
                            ForEach(group.keys.filter { SettingRow(key: $0).isAvailable }, id: \.self) { key in
                                SettingRow(key: key)
                            }
                            if group.id == .metadata { MetadataCredentialView() }
                            if group.id == .language {
                                LabeledContent("界面语言", value: "简体中文")
                                Text("目前仅提供简体中文，不会自动切换游戏的语言版本。")
                                    .font(.callout).foregroundStyle(.secondary)
                            }
                            let unavailable = group.keys.filter { !SettingRow(key: $0).isAvailable }
                            if !unavailable.isEmpty {
                                DisclosureGroup("尚未提供的选项（\(unavailable.count)）") {
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
                    Text("兼容聊天接口 · 页面整理").tag("chat")
                    Text("Responses · 联网查找与整理").tag("responses")
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
                // ⚠️ 目前只有中文一种界面语言（zh-CN 单语言）。
                //    这里**不做一个假的多选下拉** —— 一个只有一项的选择器
                //    比没有更困惑。显示为只读信息更诚实。
                InfoRow("界面语言", "简体中文", mono: false)
                Text("目前只提供简体中文界面。")
                    .font(.caption2)
                    .foregroundStyle(.secondary)

            case .listView:
                Toggle("游戏库用列表视图", isOn: Binding(
                    get: { store.settingBool(.listView) },
                    set: { store.setSetting(.listView, .bool($0)) }
                ))
                Text("也可以在游戏库右上角随时切换列表与卡片。")
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

    /// 这个设置项现在**是否真的生效**。返回 nil = 已生效。
    ///
    /// ⚠️ 判据是「有没有代码消费它」（本鱼用 grep 逐项查过）：
    ///    · `appearance` → 已接（改窗口外观）
    ///    · `listView`   → 已接（库页两种视图）
    ///    · 其余         → **还没接**（它们依赖 P6 存档 / P7 元数据 / 诊断等功能）
    /// 设置项下方的说明。
    ///
    /// ⚠️ **两种语义分开**（用户 2026-11-06 报「开关开着还显示未启用」）。
    ///
    /// 返回 nil = 无需说明。
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

    var isAvailable: Bool { pendingNote?.isNotImplemented != true }

    private var pendingNote: Note? {
        switch key {
        case .appearance, .listView, .deletionConfirmation, .metadataPreferredLanguage, .metadataFallbackLanguage, .metadataEndpoint, .metadataModel, .metadataMode:
            return nil
        case .saveSyncMode:
            // ⚠️ **P6 做完后 manual 模式真的能用** → caveat 而不是 notImplemented。
            //    「不接任何云」是用户**需要知道的事实**（D83：半成品云比没有更糟，
            //    用户会以为存档在云上从而不再手动备份）。
            return .caveat("只提供手动导入导出；不接任何云，存档不会上传。")
        case .language:
            return .notImplemented("目前只有简体中文界面")
        case .preferredLanguage, .fallbackLanguage, .languageSwitchPrompt:
            return .notImplemented("多语言版本检测还没做")
        case .nonInstalledAutodetect:
            return .notImplemented("自动识别走的是引擎页，还没接这个开关")
        case .diagnoseBeforeLaunch:
            return .notImplemented("启动诊断还没做")
        case .checkModuleUpdatesOnStartup:
            return .notImplemented("启动更新检查还没做")
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

    /// 应用版本。
    ///
    /// ⚠️ **不能从 `Bundle.main` 读**：SwiftPM 的 debug 可执行文件没有 Info.plist，
    ///    读出来是空的 —— 用户会看到「版本：」后面什么都没有。
    ///    Electron 版踩过类似的坑（B1：打包成 .app 后版本号恒 v0.0.0）。
    ///
    ///    这里用**硬编码的常量 + 注释提醒同步**，同时读 Bundle（有就用）。
    private var appVersion: String {
        if let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
           !v.isEmpty {
            return v
        }
        // TODO(P8)：打包 .app 时配 Info.plist，那时这里会自动读到。
        return "1.1.0（开发构建，未打包）"
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
