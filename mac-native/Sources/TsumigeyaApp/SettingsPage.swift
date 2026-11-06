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

    var body: some View {
        VStack(spacing: 0) {
            // 标题行（与引擎页同一视觉层级 —— v2 布局没有导航容器）
            HStack {
                Text("设置")
                    .font(.system(size: 15, weight: .semibold))
                Spacer()
            }
            .padding(.horizontal, 20)
            .padding(.top, 14)
            .padding(.bottom, 10)

            // ⚠️ **不用 ScrollView 包外层**（本鱼实测踩到：设置页渲染成全白）。
            //
            //    `ScrollView` + `GroupBox` 的组合在**离屏 NSWindow** 里
            //    拿不到完整布局（内容高度依赖滚动容器的提议尺寸，
            //    而离屏时那个提议尺寸可能是 0 → 内容高度算成 0 → 什么都不画）。
            //
            //    在真实窗口里它可能是正常的（窗口会给出确定的高度），
            //    但本鱼**没法在 SSH 会话里确认这一点** —— 而用户上次就报过
            //    「引擎页有问题」。宁可写一个**不依赖滚动容器**的版本：
            //    用 `Form`（它自己有滚动与分组语义）或者干脆不加滚动。
            //
            //    折中：设置项只有 12 条，900px 高度下放得下大部分；
            //    放不下时用 `LazyVStack` + 外层 `Form`。
            Form {
                ForEach(SettingsGroups.groups, id: \.id) { group in
                    Section {
                        if group.keys.isEmpty {
                            // ⚠️ `data` 组没有设置项 —— **只放只读信息**。
                            //    但它必须在页面上存在（否则用户找不到数据目录）。
                            InfoRows()
                        } else {
                            ForEach(group.keys, id: \.self) { key in
                                SettingRow(key: key)
                            }
                        }
                    } header: {
                        GroupLabel(id: group.id)
                    }
                }
            }
            .formStyle(.grouped)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        // ⚠️ **不再在这里 loadSettings()**（P6 修）。
        //
        //    原来是 `.task { store.loadSettings() }` —— 那是**唯一的读取点**，
        //    于是「启动时不读设置」成了一个 bug（用户设了列表视图，
        //    重开 app 又是卡片，只有进一次设置页才对）。
        //
        //    现在读取移到 `AppStore.load()`（启动时），这里**只负责渲染**。
        //
        //    ⚠️ 而且留着它还有个坏处：每次进设置页都重读文件，
        //       如果那时内存里有未落盘的改动就会被覆盖
        //       （现在所有改动都立刻落盘，所以不会丢，但重复读是浪费）。
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
            if let pending = pendingNote {
                HStack(spacing: 6) {
                    Text("未启用")
                        .font(.system(size: 9, weight: .medium))
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Color.secondary.opacity(0.15), in: Capsule())
                        .foregroundStyle(.secondary)
                    Text(pending)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }

            switch key {
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
                Text("关掉就是卡片网格（等 P7 接上封面后更好看）。")
                    .font(.caption2)
                    .foregroundStyle(.secondary)

            case .deletionConfirmation:
                Toggle("删除游戏前弹确认", isOn: Binding(
                    get: { store.settingBool(.deletionConfirmation) },
                    set: { store.setSetting(.deletionConfirmation, .bool($0)) }
                ))

            case .showAdultCovers:
                Toggle("显示 R18 封面", isOn: Binding(
                    get: { store.settingBool(.showAdultCovers) },
                    set: { store.setSetting(.showAdultCovers, .bool($0)) }
                ))
                Text("关掉会把 R18 作品的封面模糊处理。")
                    .font(.caption2)
                    .foregroundStyle(.secondary)

            case .saveSyncMode:
                Picker("存档同步", selection: Binding(
                    get: { store.settingString(.saveSyncMode) },
                    set: { store.setSetting(.saveSyncMode, .string($0)) }
                )) {
                    Text("不启用").tag("none")
                    Text("手动导入导出").tag("manual")
                }
                .pickerStyle(.segmented)
                .frame(maxWidth: 260)
                // ⚠️ 必须说清「不接云」（D83）。用户看到「同步」两个字
                //    会以为存档在云上 —— 那个误解比没有这个功能更糟。
                Text("**不会上传任何数据到网络。** 手动模式就是详情页那两个导出/导入按钮。")
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
    private var pendingNote: String? {
        switch key {
        case .appearance, .listView:
            return nil
        case .deletionConfirmation:
            // ⚠️ **这条已从「未启用」移除了**（P6 修的）。
            //
            //    本鱼原来写的是「还没有删除游戏的界面」—— 那是**过时的标注**：
            //    同一轮里本鱼已经加上了删除（列表右键 + 详情页「更多」菜单），
            //    而 `AppStore.confirmDelete` **真的读这个开关**。
            //
            //    ⚠️ 过时的「未启用」标注比不标更糟：用户明明能用，
            //       却被告诉「未启用」，于是不会去用。
            return nil
        case .showAdultCovers:
            return "还没有封面（等 DLsite 集成）"
        case .saveSyncMode:
            // ⚠️ **这条也更新了**：P6 做完了存档导出/导入，
            //    所以 `manual`（手动导入导出）**现在真的能用**。
            //
            //    但它仍然标着提示，因为文案要说明「不接任何云」——
            //    那是个**用户需要知道的事实**，不是「未启用」。
            return "只有「手动」模式能用；不接任何云（D83）"
        case .language:
            return "目前只有简体中文界面"
        case .preferredLanguage, .fallbackLanguage, .languageSwitchPrompt:
            return "多语言版本检测还没做"
        case .nonInstalledAutodetect:
            return "自动识别走的是引擎页，还没接这个开关"
        case .diagnoseBeforeLaunch:
            return "启动诊断还没做"
        case .checkModuleUpdatesOnStartup:
            return "启动更新检查还没做"
        }
    }
}

struct InfoRows: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            InfoRow("数据目录", store.dataDir, mono: true)
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
