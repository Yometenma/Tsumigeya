# Tsumigeya — 交接说明

> **给接手的 AI / 开发者**：读完这一页就够开工了。
> 更细的两份文档在 `docs/`（UI 验收方法 / 打包分发）。

---

## 这是什么

**macOS 上的 DLsite 游戏启动器**（RPG Maker 系为主），中文化。

- **技术栈：Swift 6.2 + SwiftUI**，SwiftPM 三 target
- 开发机 Windows，**目标机器 macOS**（只能 ssh 到 Mac 上编译）
- 核心链路：添加游戏 → 按文件结构识别引擎 → 装运行时 → 启动

⚠️ **曾是 Electron 版**，2026-11 全部重写为原生。旧代码已删除，历史在 git log。

---

## 目录结构

```
mac-native/
├── Package.swift          # 三 target：Core(逻辑) / CLI(验收) / App(SwiftUI)
├── Sources/
│   ├── TsumigeyaCore/     # 纯逻辑，无 UI 依赖
│   ├── TsumigeyaCLI/      # 命令行验收工具
│   └── TsumigeyaApp/      # SwiftUI
├── Tests/TsumigeyaTests/  # 测试
├── scripts/               # 打包、清理工具
└── docs/                  # 见仓库根 docs/
```

**为什么三个 target**：SwiftUI 的 `@main` 与 `main.swift` 的顶层代码**互斥**，
不能放在同一个 module 里。

---

## 开发命令

```bash
# ⚠️ Windows 上编译不了，只能 ssh 到 Mac
ssh yometenma@192.168.1.86

cd ~/tsmg-swift/mac-native
swift build                    # 编译
swift test                     # 全部测试
swift run tsumigeya-cli <cmd>  # 验收工具（见下）
scripts/package-macos.sh       # 打 dmg
```

### CLI 验收命令

| 命令 | 用途 |
|---|---|
| `data-dir` / `list-games` | 看数据目录与游戏列表 |
| `detect` / `deps` | 引擎识别 / 依赖解析 |
| `plan` / `launch` | 启动计划预览 / **真启动游戏** |
| `saves` | 存档位置探测（**用真实游戏验**）|
| `dlsite-fetch <RJ>` | 真实抓取 DLsite（验限速与缓存）|
| `dlsite-probe <html>` | 用本地 HTML 验解析器 |
| `search-fetch <关键词>` | 真实搜索 |
| `meta-fetch-all` | 给所有游戏抓元数据 |

⚠️ **CLI 不是玩具**：没有它，「真启动游戏」「真装引擎」「真抓 DLsite」
只能靠点 UI 验证，出问题无从定位。

---

## 架构（30 秒）

```
SwiftUI View → AppStore(@MainActor, ObservableObject)
             → TsumigeyaCore（纯函数/IO 层）
             → 文件系统 / 子进程 / 网络
```

**数据目录**：`~/Library/Application Support/Tsumigeya/`

| 文件 | 内容 |
|---|---|
| `games.json` | 游戏库（**上游 schema 兼容**）|
| `library-meta.json` | 分类 + DLsite 元数据（**同一文件两样东西**）|
| `global-settings.json` | 设置 |
| `dlsite/<RJ>.json` | 元数据缓存 |
| `modules/<引擎>/` | 引擎运行时 |

---

## 必须知道的约束（违反会出真 bug）

### 文本与换行

| 约束 | 原因 |
|---|---|
| **`Game.ini` 是 GBK/Shift-JIS，不是 UTF-8** | 只按 latin1 读 `[Game]` 的 ASCII 结构行，**绝不用 `Title=`** |
| **XP 的 RTP 目录名是 `Standard` 不是 `RPGXP`** | 实测为真，错映射导致 XP 永久缺 RTP |
| **CRLF 文件用 `components(separatedBy: .newlines)` 切行** | `split(separator: 换行符)` 对 CRLF 文件切不出任何行（CRLF 在 Swift 里是 1 个 Character）|
| **`trimmingCharacters(in: .whitespaces)` 不剥回车符** | 回车符属于 `.newlines` 不属于 `.whitespaces`。用普通换行符切 CRLF 文件时每行末尾会留回车符 → 字符串比较**永远 false**，且不报错 |
| **仓库里的 `.sh` 和 `.py` 必须是 LF** | CRLF 会报 `bad interpreter: /bin/bash^M` |

### 存档（每条都来自真实故障）

| 约束 | 原因 |
|---|---|
| **nwjs 的存档位置由 `package.json` 的 `main` 决定** | 绝不按「哪个目录有 `.rpgsave`」判 —— 作者塞进包里的残留档会骗过它 |
| **`location == nil`（不知道在哪）≠ `empty`（还没存档）** | 前者是故障要去排障，后者是正常要去玩。糊成一句用户永远查不出问题 |
| **导出打整个目录，不是只打槽** | 插件写的 `lastsave.autobak` / `sync_data.rpgsave` 也是存档数据 |
| **导入顺序：先校验 sha256 → 再备份 → 才写** | 先写的最坏结果是「半新半旧，既不能玩也不能回退」 |
| **备份幂等**（已有 `.tsumigeya-bak` 不覆盖） | 覆盖会让「备份」变成「导入后的版本」，失去回退意义 |
| **运行中禁止导出** | 导出的包是半截文件 |

### 启动

| 约束 | 原因 |
|---|---|
| **mkxp-z 的配置写 app 包内，不写游戏目录** | 它**只读** `Contents/Game/mkxp.json`，不看 cwd |
| **mkxp-z 遇到非 ASCII 路径要建 ASCII 符号链接** | 它的 JSON 读取器先做编码嗅探，见非 ASCII 就判失败 |
| **`preloadScript` 是必需的**（kawariki 兼容层） | 没有它 Ruby 加载 `kernel32` 失败 |
| **spawn 必须 `detached` + `stdio` 到 nullDevice** | 缺一个，关掉启动器会把游戏一起杀掉 |

### DLsite

| 约束 | 原因 |
|---|---|
| **搜索绝不自动选第一条** | 实测搜 `Karryn` 返回正片 + 3 个 DLC |
| **封面的 host 必须白名单** | URL 来自外部页面，不校验就是 SSRF 面 |
| **限速 800ms** | 对 DLsite 的基本礼貌，也是防封手段 |
| **`var contents` 要用字符串感知的括号配对扫描** | 正则 `(\{[\s\S]*?\})` 遇到简介里的 `};` 会提前截断 |
| **找 `var contents` 不是找 `contents`** | 页面里有 6 处 HTML class 名 `type_contents` |

### 数据文件

| 约束 | 原因 |
|---|---|
| **`library-meta.json` 保存时必须带回非数字键** | 它同时装游戏元数据（数字键）与分类（`categories`/`assignments`）。漏了 = 改元数据把分类全抹了 |
| **删游戏要清四处** | games / meta / play-stats / **assignments**。漏了后两项，id 复用会把旧数据安到新游戏 |
| **未知字段必须保留** | 用户从旧版带来的字段不能抹掉 |
| **手改的元数据字段刷新时不覆盖** | 用户手改的值属于用户 |

---

## 协作规矩

1. **写完 ≠ 接上**：定义了一个函数/属性，要确认它**被调用**
   （本鱼犯过三次：`refreshRunning` / `loadSettings` / `applyAppearance` 都漏了调用点）
2. **判据必须能真的失败**：写测试时问自己「失败时它会不会也通过」
   （本鱼犯过四次：黄图当成功、全白当成功、`contains` 当精确匹配、`spctl` 当能跑）
3. **不用标志位表示派生状态**：`isDirty` 这类要直接比较当前值与原始值
4. **注释写「为什么不能那样」，不写「我今天试了什么」** —— 后者属于 commit message
5. **UI 文案只写中文**（目前单语言，未接 i18n）
6. **收尾三件事**：`swift build` + `swift test` + commit

---

## 已知缺口

- **公证做不了**（用户无 Apple Developer 账号）→ 见 `docs/打包与分发.md`
- **多语言界面** 未做（只有简体中文）
- **Tyrano / 吉里吉里 的存档位置未实现**（返回 nil，不猜）

---

## 验证方法

**本机（Windows）不可能验 UI** —— 只能 ssh 到 Mac。
SSH 会话里 `screencapture` 恒失败（需要屏幕录制权限），
所以验 UI 走 `--snapshot`（见 `docs/UI验收方法.md`）。

⚠️ **快照有已知限制**：`AsyncImage` 在离屏窗口里不下载（封面看不到）。
**封面那一条用真窗口验。**
