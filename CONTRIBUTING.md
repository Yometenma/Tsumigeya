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

临时截图、日志、探针和开发数据统一放入已忽略的 `.dev-scratch/`，不要提交构建产物或阶段性验收报告。个人连接信息和本机专用配置不应写入公共文档。

## 使用 CLI 验证真实流程

在 `mac-native/` 中执行 `swift run tsumigeya-cli <命令>`。可用命令以 `Sources/TsumigeyaCLI/main.swift` 为准：

| 命令 | 用途 |
|---|---|
| `data-dir` / `list-games` / `roundtrip-games` | 查看数据目录和游戏列表，验证游戏库读写保真 |
| `detect` / `deps` / `install <引擎> [--dry-run]` | 引擎识别、依赖检查与安装 |
| `plan` / `launch [id]` / `saves` | 检查启动计划、真实启动和存档位置 |
| `dlsite-fetch <RJ> [category]` / `dlsite-probe <html>` | 真实网络抓取与本地页面解析 |
| `search-probe <html>` / `rj-probe <路径…>` | 搜索结果解析与 RJ 编号提取 |
| `meta-probe [目录]` / `zip-probe [目录]` | 元数据读写与 ZIP 格式检查 |

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

## 提交 Pull Request 前

- 尽量让一次改动只解决一个明确的问题，并在说明中写清改动目的。
- 新增函数、设置或辅助逻辑时，检查实际调用点，避免只有测试在使用它。能直接比较得到的派生状态不要再维护额外标志，例如另设 `isDirty`。
- 为行为变更补充能识别回归的测试；源码字符串扫描不能替代行为测试，单元测试也不能单独证明真实游戏或网络兼容性。
- 在 Mac 上运行 `swift build` 和 `swift test`，并说明验证环境、结果及未验证的范围。如果没有可用的 Mac，请如实注明，不要把静态检查当成编译通过。
- 涉及界面时按 [UI 验收方法](docs/UI验收方法.md) 检查真实窗口。离屏快照不能验证封面下载、材质效果或真实交互；界面文案保持中文。
- 涉及游戏启动或存档时，补充相应的真实流程验证，不要改动用户原有数据。
- 注释解释约束和原因；改动经过放在提交说明中。

## 打包与分发

打包步骤、安装包检查和签名限制见 [打包与分发](docs/打包与分发.md)。当前仅做 ad-hoc 签名，不做公证，不应把签名完整性检查描述为 Apple 已认可该应用的分发。

提交源码不等于发布新版本；新增安装包需要单独完成版本标记、打包和 Release 发布。
