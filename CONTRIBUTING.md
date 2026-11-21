# 参与贡献

欢迎通过 Issue 或 Pull Request 帮助改进 Tsumigeya。修复问题、补充真实游戏的兼容性记录、完善测试和文档都很有帮助。较大的功能或架构调整，请先开 Issue 讨论。

提交问题前可先查看 [常见问题](docs/常见问题.md)，再选择 [问题反馈、游戏兼容性或功能建议](https://github.com/Yometenma/Tsumigeya/issues/new/choose) 模板。

报告问题时，请提供应用版本、macOS 版本、芯片架构、游戏引擎、复现步骤，以及预期和实际结果。日志和截图请先去除个人信息；不要上传商业游戏本体、付费素材或私人存档。

## 搭建开发环境

原生应用使用 Swift 6.2+ / SwiftUI，最低支持 macOS 26。目前发布的安装包面向 Apple Silicon，需要在 Mac 上使用匹配的 macOS SDK 构建和验证。可以在其他系统上编辑源码，但这不能代替 Mac 上的编译、测试和界面验收。

在仓库根目录进入原生项目：

```bash
cd mac-native
swift build
swift test
```

开发时建议使用独立数据目录，避免调试过程改写日常游戏库：

```bash
# 以下命令仍在 mac-native/ 中执行。
mkdir -p ../.dev-scratch/data
export TSUMIGEYA_DATA_DIR="$PWD/../.dev-scratch/data"
swift run tsumigeya-cli data-dir
swift run Tsumigeya
```

先确认 `data-dir` 显示的路径是预期的开发目录。如果提示目录降级，先修复目录问题，再进行涉及数据写入的验证。独立目录不会自动包含日常游戏库或已安装的运行时，需要自行添加测试游戏和依赖。

## 目录与职责

| 位置 | 内容 |
|---|---|
| `mac-native/Sources/TsumigeyaCore/` | 业务逻辑、文件读写、进程及网络操作 |
| `mac-native/Sources/TsumigeyaCLI/` | 命令行入口，用于验证真实数据和运行流程 |
| `mac-native/Sources/TsumigeyaApp/` | SwiftUI 界面与应用状态 |
| `mac-native/Tests/` | 自动化测试及真实页面样本 |
| `assets/` | 图标源图与打包图标 |
| `scripts/` | 图标生成工具 |
| `mac-native/scripts/` | 打包与开发检查脚本 |

界面调用链为 **View → `AppStore`（`@MainActor`）→ Core → 文件 / 进程 / 网络**。尽量把可独立测试的逻辑放入 Core，不要在 View 中直接实现 IO。GUI 与 CLI 的可执行入口必须属于不同 target。

### 应用状态边界

`AppStore` 保留界面入口和跨功能协调，具体状态由功能对象独立持有，不在应用层重复保存一份：

| 对象 | 职责 |
|---|---|
| `GameLibraryState` | 游戏记录、分类、搜索索引与派生分组；通过 Core 的 `GameLibraryFile` 统一执行添加、编辑、批量、定位与目录修改，成功保存后才发布列表 |
| `SaveSession` | 单游戏存档列表、目录修改、导入导出结果及操作前检查；由 `AppStore` 创建，界面观察会话，不直接调用存档 IO |
| `LibraryMetadataStore` | 作品资料缓存、搜索、预览、保存及单项请求取消；通过游戏查询获取当前上下文，不依赖 View 或 `AppStore` 类型 |
| `BatchMetadataCoordinator` | 批量处理范围、进度、暂停和失败重试；委托资料模块执行单项请求，不直接访问其任务表 |

文件选择、访达和剪贴板等系统交互留在 View；数据校验与磁盘格式继续由 Core 管理。`AppStore+Metadata` 只负责转发入口与跨功能协调，不拥有另一份资料状态。

子对象的 `ObservableObject` 通知不会自动上传，`AppStore` 显式转发游戏库、资料与队列通知；存档界面直接观察它取得的会话。新增状态必须检查实际观察链，避免业务已完成但界面不更新。

旧视图使用过期记录再次索取会话时，不能替换或使当前会话失效。重新加载时取消旧队列和请求、清空资料缓存并使旧存档会话失效；删除和重新定位后也要使对应请求与会话失效。资料响应同时核对请求标识和发起时的游戏记录，文件选择返回后的存档操作重新检查身份和真实运行状态。不要用另一个可变标志复制已有派生状态。

分类默认从已保存资料的游戏作品类型派生，不使用站点分区或题材标签；人工添加和移除分别保存在单游戏 `classification` 扩展中，有效归属仍写回 `assignments`。接管旧库时把已有归属视为人工选择；资料与自动分类在共享锁内一次原子写入，预览不保存。类型分类的 `sourceWorkType` 不随重命名变化；删除后用 `classificationSettings.disabledTypes` 防止刷新重建，同名重建明确重新启用。恢复自动分类需要确认，会清除该游戏的人工调整，但不恢复全局删除的分类。未知字段仍须保留。

删除由 `AppStore` 先撤销该游戏的旧请求、存档和辅助会话，再交给 Core 预检与按步骤清理。`RemovalReport` 返回完成范围和失败原因；跨文件仍不是事务，游戏记录最后删除，失败保留编号供重试。即使部分失败，游戏库分类与资料缓存也必须刷新到已保存的范围，不能让界面显示不存在的数据。`GameLibraryFile` 的锁只协调本进程，不宣称能锁住外部编辑器。

临时截图、日志、探针和开发数据统一放入已忽略的 `.dev-scratch/`，不要提交构建产物或阶段性验收报告。个人连接信息和本机专用配置不应写入公共文档。

### 开发文件与测试维护

- 测试按 `App`、`CoreData`、`Engines`、`Library`、`Metadata`、`Saves`、`Settings` 和 `Assist` 分组，不再以迁移阶段命名。新增回归先检查现有判据，优先补充同一行为的边界，不重复建立一套测试。
- 窗口渲染回归与逻辑测试都由默认测试执行；测试和快照必须沿用实际入口可达的生产视图，不能为维持旧测试保留已废弃界面。窗口可能短暂显示，不代表旧版应用在运行，详见 [测试维护](mac-native/Tests/README.md)。
- 旧设置兼容、损坏文件保护、未知字段保留、请求失效和存档备份失败仍是有效回归，不能因对应旧界面已移除而一并删除。带真实网络或外部运行时条件的测试默认跳过，跳过不等于验收通过。
- `.dev-scratch/` 中的截图、日志、一次性探针和源码传输包可以在验收后清理；先将唯一素材、未发布文案及数据备份迁出。私人资料放 `.local-assets/`，数据备份放 `.local-backups/`，两者均不提交。
- `mac-native/.build/` 是可再生成的编译缓存，清理前退出从该目录启动的实例；`mac-native/dist/` 只保留仍需使用的安装包。不要把应用数据目录、游戏目录或整个系统废纸篓当作项目缓存清理。

## 扩展翻译与作弊

引擎辅助模块位于 `mac-native/Sources/TsumigeyaCore/AssistanceModules/`。现有 MV/MZ、RGSS、Ren’Py 和 Tyrano 都实现 `AssistanceEngineModule`，由 `AssistanceModules` 统一选择。它们是 Core 内的逻辑模块，不是独立 Swift target 或可下载插件。

- 引擎模块持有识别与身份算法、文本提取、运行时脚本映射、进程匹配和能力说明；共用层负责安装备份、校验恢复、译文管理与通信，不能在模块中绕开安全检查。
- 新增引擎时补充 `AssistanceEngine` 与注册分发，明确翻译、作弊各自的能力和接入方式；未接入的能力用 `nil` 表示，不能先填文案伪装成可用。界面与运行时能力页从相同声明读取。
- 只有采用现有网页入口或文件桥约定的模块才能直接复用相应安装流程；新宿主、入口或编译文件格式需要补齐安全安装与恢复行为，不能仅注册名称。
- 保留旧身份算法、安装记录、配置未知字段和译文；变更前后验证提取、独立开关、资源映射、旧安装更新、运行中拒绝修改以及完整恢复。真实作品和封装兼容性仍需另外实测。
- 辅助资源继续由 `Resources/Assist` 随应用打包；新增资源须验证打包后与重定位时的选择，不要只在开发目录测试。

## 使用 CLI 验证真实流程

在 `mac-native/` 中执行 `swift run tsumigeya-cli <命令>`。可用命令以 `Sources/TsumigeyaCLI/main.swift` 为准：

| 命令 | 用途 |
|---|---|
| `data-dir` / `list-games` / `roundtrip-games` | 查看数据目录和游戏列表，验证游戏库读写保真 |
| `detect` / `deps` / `install <引擎> [--dry-run]` | 引擎识别、依赖检查与安装 |
| `plan` / `launch [id]` / `saves` | 检查启动计划、真实启动和存档位置 |
| `dlsite-fetch <RJ> [category] [locale]` / `dlsite-probe <html>` | 真实网络抓取与本地页面解析 |
| `dlsite-search <关键词> [category]` | 真实网络搜索，核对成人向／一般向候选与失败提示 |
| `metadata-page <HTTPS地址>` | 真实外部页面读取，仅输出正文长度与封面有无，不写游戏库 |
| `metadata-ai <HTTPS地址>` / `metadata-search <名称>` | AI 页面整理／联网来源候选，只输出预览；必须显式配置接口与凭据 |
| `search-probe <html>` / `rj-probe <路径…>` | 搜索结果解析与 RJ 编号提取 |
| `meta-probe [目录]` / `zip-probe [目录]` | 元数据读写与 ZIP 格式检查 |
| `scan-games <目录>` | 受限批量扫描，只预览，不写入；不可读或达到范围上限时非零退出 |
| `relocate-probe <编号> <新目录>` | 按真实游戏记录校验定位并预览，不写入；实际保存需在应用确认 |

资料获取界面与兼容限制见 [作品信息获取](docs/作品信息获取.md)。CLI 的 `locale` 使用 `zh_CN`、`zh_TW`、`ja_JP`、`en_US` 或 `ko_KR`。外部 AI 验收通过 `TSUMIGEYA_METADATA_ENDPOINT`、`TSUMIGEYA_METADATA_MODEL`、`TSUMIGEYA_METADATA_MODE`（`chat`／`responses`）、`TSUMIGEYA_METADATA_LANGUAGE` 和 `TSUMIGEYA_METADATA_KEY` 显式提供配置；不要把密钥写入提交或日志。测试使用可注入传输覆盖协议、预览和取消，不能把模拟接口描述为真实模型联网验收。

真实游戏验收前，确认目标游戏没有正在运行；验收结束后只清理本次启动的测试进程，不要按引擎名称批量结束进程。验证读写时使用临时副本，不把测试结果写回用户的游戏库或存档。

## 修改时需要保留的行为

### 数据安全与兼容

默认数据目录为 `~/Library/Application Support/Tsumigeya/`，开发时可通过 `TSUMIGEYA_DATA_DIR` 指定独立目录。主要文件包括 `games.json`、`library-meta.json`、`global-settings.json`、`dlsite/<RJ>.json` 和 `modules/<引擎>/`。

- 保持旧版 `games.json` 的兼容性，读写时保留未知字段。
- `library-meta.json` 写回时保留 `categories`、`assignments` 等非数字键；刷新作品信息不能覆盖用户手动修改的元数据。
- 删除游戏时清理游戏记录、元数据、游玩统计及分类归属；旧异步请求不能回写已删除或编号复用的游戏。
- 损坏的原件不得覆盖；单文件采用原子写入，需要备份时，备份失败就停止写入。
- 跨文件保存目前不是事务；部分写入失败时，错误提示必须说明已保存的范围。

### 引擎、路径与文本

- `Game.ini` 按 Latin-1 读取 ASCII 结构，不使用 `Title=` 作为标题来源，原文件可能采用 GBK 或 Shift-JIS。RPG Maker XP 的 RTP 目录名为 `Standard`。
- CRLF 文本用 `components(separatedBy: .newlines)` 切行；需要剥离回车时使用 `.whitespacesAndNewlines`，不能只用 `.whitespaces`。
- `.sh` 和 `.py` 文件使用 LF 行尾。
- mkxp-z 配置写入应用包内的 `Contents/Game/mkxp.json`；非 ASCII 路径使用 ASCII 符号链接，并保留 kawariki 的 `preloadScript`。
- 游戏进程必须能够脱离启动器继续运行，标准 IO 指向空设备；退出启动器不能连带结束游戏。
- 路径、架构和配置键名的映射应有单一来源，不要在多个调用点各写一套。

### 存档与 DLsite

- NW.js 存档位置由 `package.json` 的 `main` 决定，不能根据残留存档猜测；未知位置（`nil`）和空存档必须分开显示。TyranoScript、吉里吉里尚未实现定位，应返回 `nil`。
- 导出覆盖整个存档目录，不能只导出已识别的存档槽；游戏运行时禁止导入和导出。
- 导入先校验 SHA-256、路径及文件名，再完成全部备份，最后写入；已有 `.tsumigeya-bak` 不能覆盖。
- DLsite 搜索不能自动选择第一条结果；封面 host 使用白名单，请求间隔至少 800ms。
- 解析作品页时精确查找 `var contents`，使用能识别字符串的括号配对扫描 JSON，不使用非贪婪正则截取对象。

### 独立搜索及本地模型验收

`metadata-search` 通过 `TSUMIGEYA_SEARCH_PROVIDER=native|tavily|searxng|custom|disabled` 选择搜索方式；独立搜索配置 `TSUMIGEYA_SEARCH_ENDPOINT`、`TSUMIGEYA_SEARCH_KEY` 和可选的 `TSUMIGEYA_SEARCH_LIMIT`。Tavily 地址留空使用官方接口。自定义方式支持 `TSUMIGEYA_SEARCH_METHOD`、`_QUERY_KEY`、`_RESULTS_PATH`、`_TITLE_PATH`、`_URL_PATH`、`_SUMMARY_PATH`、`_PARAMETERS`（均以 `TSUMIGEYA_SEARCH` 为前缀），认证仅支持 Bearer。密钥只通过环境或安全输入传递，不写入测试样本、脚本、日志或命令示例。

局域网 HTTP 接口需显式 `TSUMIGEYA_METADATA_ALLOW_LAN=1` 或 `TSUMIGEYA_SEARCH_ALLOW_LAN=1`，各自只授权本次完整地址，不放宽网页抓取规则。本地模型可选 `TSUMIGEYA_METADATA_TIMEOUT`、`_INPUT_LIMIT`、`_JSON=1`、`_NO_THINKING=1`。默认不要求结构化输出或额外模板参数，服务不兼容时不自动重试。真实验收须区分：搜索认证、候选来源、公开页面读取、模型整理、预览确认及落盘；一个环节成功不代表全链路通过。

## 界面文案与界面语言

界面支持简体中文、English、日本語，默认跟随系统语言，可在 **设置 → 语言 → 界面语言** 里改。

- **文案写在哪里**：中文原文直接写在代码里，英文与日文放在 `mac-native/Sources/TsumigeyaApp/Resources/{en,ja}.lproj` 和 `mac-native/Sources/TsumigeyaCore/Resources/Localization/{en,ja}.lproj`，**key 就是中文原文**。`zh-Hans.lproj` 是空表：中文是源语言，取不到译文就原样返回原文。新增或修改文案时，同一次改动补齐两条译文。
- **`Text("…")` 自动生效**，由 SwiftUI 按 `environment(\.locale)` 取表。**代码里拼装的字符串不会自动翻译**：状态提示、错误拼接、窗口标题、菜单项要显式走 `L()`（App 层）或 `L10n.string` / `L10n.format`（Core），否则切语言后仍是中文。
- **带插值的句子**写成格式串：`String(format: L("共 %lld 项"), count)`，key 用 `%lld` / `%@` 原样进表；不要写成 `L("共 \(count) 项")`（那样取不到译文）。
- **不要翻译持久化数据**：分类名、设置键、引擎标识、DLsite 页面解析用的原文都不是文案，翻译会破坏已有数据或解析。
- **打包路径**：SwiftUI 的 `Text` 只查 `Bundle.main`，所以 `scripts/package-macos.sh` 会把 App 资源 bundle 里的 `.lproj` 平铺到 `Contents/Resources/`。改动资源布局后必须打包一次并检查 `.app/Contents/Resources` 是否含 `en.lproj`、`ja.lproj`、`zh-Hans.lproj`；开发运行由仅 Debug 的 `DevLocalizationBridge` 复制同一份表，保持两边一致。
- **验收**：`swift test` 里的本地化用例覆盖设置值解析、取表、回落与占位符；界面改动还要用 `--snapshot` 渲染三种语言核对，离屏快照不能代替真实窗口交互。

## 多语言文档

用户文档有简体中文、英文、日文三个版本；界面文案仍只写中文（见上一节的 PR 检查项）。文件对应关系：

| 内容 | 简体中文（事实来源） | English（默认） | 日本語 |
|---|---|---|---|
| 项目说明 | `README.zh-CN.md` | `README.md` | `README.ja.md` |
| 常见问题 | `docs/常见问题.md` | `docs/en/faq.md` | `docs/ja/faq.md` |
| 作品信息获取 | `docs/作品信息获取.md` | `docs/en/game-info.md` | `docs/ja/game-info.md` |
| 翻译与作弊 | `docs/翻译与作弊.md` | `docs/en/translation-and-cheats.md` | `docs/ja/translation-and-cheats.md` |

- 简体中文是事实来源。改动功能、限制、界面入口或兼容性范围时，在同一次改动里同步对应译文；只改中文版而让译文停在旧行为，视为未完成。
- 译文不新增原文没有的承诺，也不弱化限制：“未实测”“实验性”“仅 ad-hoc 签名、未公证”必须原样保留。
- 应用界面目前只有简体中文。译文引用界面入口时保留原始标签「…」，并在首次出现时给出译名；不能因为文档有译文就声称界面已支持该语言。
- 每份文件顶部保留语言切换：README 用 shields 徽章（当前语言 `d4899b`，其余 `9a8f9c`），docs 用一行文本链接。新增语言时，同时补上其余语言入口。
- 译文内的链接指向同语言版本，跨语言用相对路径；不要指向中文文件被改名后的猜测路径。
- 开发向文档（`CONTRIBUTING.md`、`docs/UI验收方法.md`、`docs/打包与分发.md`、`更新日志.md`）目前只有中文，README 已注明；改这些文件不需要维护译文。

## 提交 Pull Request 前

- 尽量让一次改动只解决一个明确的问题，并在说明中写清改动目的。
- 修改用户文档时按上面的「多语言文档」同步英文与日文版本。
- 完成新功能、用户可感知的优化或问题修复时，同步更新根目录的 [更新日志](更新日志.md)，与对应改动一起提交。按日期倒序、同日合并，记录已完成内容及必要限制；未完成计划不写成成果，未发布改动不标为已发布，不包含密钥或私人测试资料。
- 新增函数、设置或辅助逻辑时，检查实际调用点，避免只有测试在使用它。能直接比较得到的派生状态不要再维护额外标志，例如另设 `isDirty`。
- 为行为变更补充能识别回归的测试；源码字符串扫描不能替代行为测试，单元测试也不能单独证明真实游戏或网络兼容性。
- 在 Mac 上运行 `swift build` 和 `swift test`，并说明验证环境、结果及未验证的范围。如果没有可用的 Mac，请如实注明，不要把静态检查当成编译通过。
- 涉及界面时按 [UI 验收方法](docs/UI验收方法.md) 检查真实窗口。离屏快照不能验证封面下载、材质效果或真实交互；界面文案保持中文。
- 涉及游戏启动或存档时，补充相应的真实流程验证，不要改动用户原有数据。
- 注释解释约束和原因；改动经过放在提交说明中。

## 打包与分发

打包步骤、安装包检查和签名限制见 [打包与分发](docs/打包与分发.md)。当前仅做 ad-hoc 签名，不做公证，不应把签名完整性检查描述为 Apple 已认可该应用的分发。

提交源码不等于发布新版本；新增安装包需要单独完成版本标记、打包和 Release 发布。
