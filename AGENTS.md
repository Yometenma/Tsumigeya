# Tsumigeya 开发约定

macOS 中文 DLsite 游戏启动器；Swift 6.2+ / SwiftUI，最低 macOS 26。开发机为 Windows，编译和 UI 验证在 Mac 上完成。

## 结构与验证

- `mac-native/Sources/`：`TsumigeyaCore`（逻辑与 IO）、`TsumigeyaCLI`（真实流程验收）、`TsumigeyaApp`（SwiftUI）。两个可执行入口必须分属不同 target。
- 调用链：View → `AppStore`（`@MainActor`）→ Core → 文件 / 进程 / 网络。
- `mac-native/Tests/`：测试及真实页面样本；`assets/`：图标源图与打包图标；`scripts/`：图标生成工具。
- 临时截图、日志、探针统一放入已忽略的 `.dev-scratch/`，不提交生成物或阶段性验收报告。

```bash
ssh yometenma@192.168.1.86
cd ~/tsmg-swift/mac-native
swift build
swift test
swift run tsumigeya-cli <命令>
./scripts/package-macos.sh
```

改动收尾：`swift build`、`swift test`、commit。Mac 不可达时明确说明未验证，不以静态检查代替。

CLI 保留真实流程入口；命令以 `TsumigeyaCLI/main.swift` 为准：

| 命令 | 用途 |
|---|---|
| `data-dir` / `list-games` / `roundtrip-games` | 数据目录、游戏列表、读写保真 |
| `detect` / `deps` / `install <引擎> [--dry-run]` | 引擎识别、依赖及安装 |
| `plan` / `launch [id]` / `saves` | 启动计划、真启动、真实游戏存档位置 |
| `dlsite-fetch <RJ> [category]` / `dlsite-probe <html>` | 网络抓取与本地解析 |
| `search-probe <html>` / `rj-probe <路径…>` / `meta-probe [目录]` / `zip-probe [目录]` | 搜索解析、RJ 提取、元数据与 ZIP 检查 |

## 数据安全

数据根目录为 `~/Library/Application Support/Tsumigeya/`：
`games.json`（兼容旧 schema）、`library-meta.json`（元数据及分类）、`global-settings.json`、`dlsite/<RJ>.json`、`modules/<引擎>/`。

- 保留未知字段；`library-meta.json` 写回不能丢失 `categories` / `assignments` 等非数字键；刷新不覆盖手改元数据。
- 删除游戏清理 games、meta、play-stats、assignments；旧异步请求不能回写已删除或编号复用的游戏。
- 损坏原件不得覆盖；单文件原子写入，备份失败停止写入。跨文件提交目前不是事务，失败必须说明已保存范围。

## 引擎与文本

- `Game.ini` 按 Latin-1 读取 ASCII 结构，不使用 `Title=`（原文件可能是 GBK / Shift-JIS）；XP RTP 目录名是 `Standard`。
- CRLF 用 `components(separatedBy: .newlines)` 切行；需要剥回车时用 `.whitespacesAndNewlines`，不能只用 `.whitespaces`。
- `.sh` / `.py` 使用 LF。
- mkxp-z 配置写入 app 内 `Contents/Game/mkxp.json`；非 ASCII 路径使用 ASCII 符号链接；保留 kawariki `preloadScript`。
- 游戏进程必须脱离启动器，标准 IO 指向空设备，关闭启动器不能连带结束游戏。

## 存档与 DLsite

- NW.js 存档位置由 `package.json` 的 `main` 决定，不能靠残留存档猜；未知位置（nil）与空存档分开显示。Tyrano / 吉里吉里未实现定位，返回 nil。
- 导出整个存档目录；运行中禁止导入导出。导入先校验 SHA-256、路径及文件名，再完成全部备份，最后写入；已有 `.tsumigeya-bak` 不覆盖。
- DLsite 搜索不自动选首条；封面 host 用白名单；请求间隔至少 800ms。
- 精确查找 `var contents`，用识别字符串的括号配对扫描 JSON，不使用非贪婪正则截对象。

## 协作与验收

- 新函数和设置必须检查实际调用点；派生状态直接比较，不另设 `isDirty` 等标志。
- 测试要有能失败的判据；源码扫描不代替行为测试，真实游戏和网络兼容性不能仅靠单测证明。
- 注释只解释约束和原因，变更经过放 commit；UI 文案只写中文。
- [UI 验收](docs/UI验收方法.md)：离屏快照不能验证封面下载、材质和真实交互。
- [打包与分发](docs/打包与分发.md)：当前无 Developer 账号，仅 ad-hoc 签名，不公证。
