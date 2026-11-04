# AGENTS.md — Tsumigeya 多会话协作交接文档

> **给任何 AI 助手/开发者**：接手本项目前请通读本文档。本文档是**现状入口**（进度、环境、决策、规矩），
> 实施方案与接口契约在 [`docs/M1-实施方案.md`](./docs/M1-实施方案.md)（**开工前必读**）。
> 每次收尾（提交代码前）必须更新「当前项目状态」一节。用户会开多个 AI 会话在同一个工作区接力干活。

## 项目是什么

**Tsumigeya** — macOS 上的 DLsite 游戏启动器（RPG Maker 系为主），中文化、模块化。
基于开源项目 **Xenolauncher**（GPL-3.0）的核心逻辑二次开发。

> 注意复用范围：**只复用上游 `app/module.js` 一个文件**（引擎模块系统），上游的 UI 页面、样式、NW.js 脚本、
> 原生外壳与翻译**都没有包含**，界面与主进程全部自己重写。明细见 `docs/M1-实施方案.md` §2.1。

核心链路（最高优先级）：**添加游戏 → 按文件结构自动识别引擎 → 未装引擎一键安装 → 调原生播放器启动**。

- 技术栈：Electron + Vue3 + TypeScript（electron-vite）+ Pinia + Element Plus + vue-i18n（zh-CN）
- 开发机：Windows（全流程可本地验证，唯独"真实启动游戏"只能在 macOS 验证——引擎二进制是 mac 版）
- 目标平台：macOS（arm64/x86_64）

## 当前项目状态（每次收尾必须更新）

- **阶段**：**M1 / M2 / M2.5 / M3 / M2.6 / M2.7 / M3.5 已完成**（v0.3.2 已发布）；**M4.0（去掉上游 launcher）方案已冻结待实施**
  - M4.0 = 自实现启动（4 个引擎），收益：不改用户游戏文件 / 摆脱 xenolauncher 数据目录 / 清掉补丁式代码
  - 见 `docs/M4.0-实施方案.md`（D53–D56）
  - M3.5 = 「好用」地基：启动后进程追踪 + 关闭游戏 + 游玩记录（见 `docs/M3.5-实施方案.md`，D48–D52）
    ——**已实施完毕**（详见下方「M3.5 全套」）
  - M2.7 = 编辑页重构（见 `docs/M2.7-实施方案.md`）：保存 bug 修复 + 封面与标签合并 + 标题来源提示
  - M2.6 = 海报墙与详情页重构（见 `docs/M2.6-实施方案.md`，**D39–D43**）——**已实施完毕**（详见下方「M2.6 全套」）
  - ⚠️ 注意编号：M2.6 方案初稿写的是 D36–D38，但那三个号已被 **M3 实际占用**，
    所以 M2.6 落在 **D39–D41**，实施中又新增 **D42–D43**（见方案 §10）
  - M3 = 故障自愈（见 `docs/M3-实施方案.md`，D32–D38）——**已实施完毕**（详见下方「M3 全套」）
  - M2.5 = 用户 2026-11-04 提的三项改进：按名字搜索 DLsite + 候选列表 / 可编辑元数据 / 多语言版本偏好
  - **技术前提已实测完毕**（M3 的归档魔数 / RTP 结构 / `fontSub` 语义 / `Game.ini` 是 GBK；
    M2.5 的搜索 URL 格式 / 结果解析 / 噪音过滤 / 无法靠 lang_options 判断多语言版；
    M2.6 的可获取字段盘点 / `og:description` 清洗规则），写在各自文档的「已实测」一节，**新会话不要重复验证**
- **已完成**：
  - M1 全套（游戏库 / 自动识别 / 一键安装引擎 / 启动），v0.1.4 已在 Mac 上实测可启动 NW.js 游戏
  - **M2 全套**：`src/main/dlsite.ts`（RJ 识别 + `var contents` 解析 + TTL 缓存 + 4 类错误）、
    `src/main/library-meta.ts`（旁挂存储）、5 条 IPC 命令（`dlsiteDetectRJ` / `dlsiteLookup` /
    `saveGameMeta` / `refreshGameMeta` / `clearGameMeta`）、`OFF_QUEUE_METHODS` 常量、
    CSP `img-src` 白名单、session `adultchecked` cookie、编辑页 DLsite 面板、GameCard 封面三级降级
  - `src/shared/bridge-error.ts`：修掉「contextBridge 跨边界丢 `error.key`」导致中文文案退化成英文的老 bug
  - **R18 封面打码**（用户 2026-11-04 拍板）：设置项 `showAdultCovers` 默认 false，
    判定依据是 DLsite 的 section（`maniax`/`books` = R18；实测同一 R18 作品在 `homepro` 返回 404），
    **只影响渲染、不影响抓取与存储**。实现在 `src/shared/age-rating.ts`（零依赖纯函数）
  - **M2.5 / M3 / M2.6 / M2.7 / M3.5 的实现细节**：见各自 `docs/M*.md`（本文档只记状态与决策，不重复实现叙述）
- **测试 507 个全绿 / 20 个文件**（M1 的 76 + M2 的 89 + R18 打码 7 + M2.5 的 108 + M3 的 76 +
  M2.6 的 67：S1 数据层 18 + 卡片降级纯函数 40 + 落盘白名单与 mergeWork 回归 8 + GameCard 信息 1 +
  **M3.5 的 68**：S1 游玩记录 25 + S2 exec 注入 28 + S3/S4 进程表与关闭 15）
- **M3.5 实现**（`play-stats.ts` / `exec-inject.ts` / `process-registry.ts`）：细节见 `docs/M3.5-实施方案.md`
  探针结论：真拿到 PID、真落盘 play-stats、真杀进程（`kill(pid,0)` 复核）—— 详见该文档
- **M3.5 端到端实测（本机 `node scripts/probe-m35.cjs`）**：探针造一个**假 mkxpz 模块**，
  launcher.js 照上游真实形态写（`exec(cmd, cb)` 且**丢弃返回值**）—— 正是 M3.5 要修的那个形态：
  - `runningCount=1` / **`runningPid=21616`** / `hasRealPid=true` → **真的拿到 PID 了**（D48/D49 生效）
  - `execPathParsed="ping"` → 命令串正确解析（PID 复用复核的原料）
  - `playStatsExists=true` / `playCount=1` → `play-stats.json` 真落盘（D51）
  - `snapshotHasRunning=true` / `snapshotRunningHasNoCommand=true` → S4 字段如约下发
  - **详情页**：`hasRunningBar=true` / `runningText="正在运行（已 0 秒）"` / `hasCloseButton=true` / `hasLaunchButton=false`
  - **卡片**：`cardCount=1` / `runningDots=1` / `cardHasStopButton=false`
  - **重复启动**：`relaunchRejected=true`，key 解回 `error.gameAlreadyRunning`，`playCountStillOne=true`
  - **关闭**：`action="terminated"` + **`processReallyGone=true`**（用系统层 `kill(pid,0)` 复核，不只信自己的表）
  - **关闭后**：`runningCountAfterStop=0`、详情页回到「启动游戏」按钮
  - **停一个没在跑的**：`stopIdleRejected=true` + key 解回 `error.gameNotRunning`
  - `consoleErrors=[]` / `finalHtmlLen=2982` → 没白屏
  - 探针自身踩到的三个坑（已写进方案 §8.2）：①验收 UI **必须走 Pinia store**（直接 invoke 只改主进程的表，
    页面读的是 store 的 `running` 投影，DOM 会一动不动）；②假「游戏」不能用 `process.execPath -e`（那是 Electron 的
    execPath，立刻退出），要用系统自带 `ping -n 120`（win）/ `sleep 120`；③`executeJavaScript` 里不能写顶层 `await`，要包 `(async () => {...})()`
- **端到端探针**：`probe-m2` / `probe-m25` / `probe-m3` / `probe-m26` / `probe-m27` / `probe-m35`，
  各自的实测结论见对应 `docs/M*.md` 的「端到端实测」一节（**别重复验证**）
- **仍未验证（必须在有桌面会话的机器上做）**：
  - **视觉观感**：暗色主题配色、封面卡片裁切比例、进度浮层动效需人眼验收
  - **M2.5 的新 UI 手感**：搜索候选列表的滚动与点击、字段编辑框的弹出位置、
    语言确认对话框的措辞（本机无画面，只能用 DOM 断言验证存在与文案）
  - **M3 的 RTP 真实下载**：单测用假 tar 验到了「下载→解压→落到 `deps/RTP/RTP/<版本>`」，
    但**真 244MB 包的耗时、进度条观感、取消是否及时**只能在 Mac 上用户量级验证（§9 R2）
  - **系统文件对话框的返回值**（M1 遗留，已加手输路径兜底）
  - **安装引擎 / 其他引擎类型**（需 mac）
  - **M2.6 的视觉验收**：卡片的 hover 抬升、三点菜单的浮出动画、简介 2 行截断的实际观感、
    详情页两栏在窄窗口下的塌陷（`@media (max-width: 860px)` 折成单栏，只做过 DOM 断言，
    没在真窗口里量过）、R18 详情页大图的模糊强度（`blur(22px)`）——**这些只能在有画面的机器上看**
  - **M2.6 的详情页启动全链路**：探针验到「点启动 → 弹 M3 诊断框」（假路径所以必然被拦），
    但「诊断通过后真的把 mac 引擎拉起来」仍属 M1 的待验证项
- **已知网络现实（本机）**：DLsite 与 `raw.githubusercontent.com` **都依赖系统代理**。
  产品侧靠 `net.fetch` + `session.setProxy({ mode: 'system' })` 走代理（D9）；
  纯 Node / vitest / curl 验收必须显式设代理，否则一律超时。
- **打包与分发（已就绪，待 CI 首次实跑验证）**：GitHub Actions 出 mac dmg（arm64/x64）+ win 安装包，
  打 `v*` tag 自动挂 draft Release。配置见 `.github/workflows/build.yml` 与 `electron-builder.yml`，
  使用说明见 `docs/打包与分发.md`。**无需证书**（ad-hoc 签名，首次打开需右键→打开）。
  本机因沙箱限制无法验证打包（electron-builder 解压 Electron 时卡在 default_app.asar 的 EPERM），
  配置正确性以 CI 首次运行结果为准。

## 本机准备（Windows 开发机）

| 项 | 值 / 做法 |
|---|---|
| Node / npm | 22.20 / 11.19（`electron-vite` 要求 node `^20.19 \|\| >=22.12`） |
| 依赖 | `npm install` 已执行；`electron-vite` 的 `@swc/core` 是 optional peer，**没装是正常的** |
| Electron 二进制 | 已下载（`node_modules/electron/dist/electron.exe`）。若换机器后 `dist/` 为空：`node node_modules/electron/install.js`；国内可设 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` |
| 系统 tar | Windows 自带 `C:\Windows\System32\tar.exe`（bsdtar），mac 用 `/usr/bin/tar` |
| 网络 | GitHub API 未认证限速 60 次/时；引擎列表刷新失败会回退 core 磁盘缓存 |

## 开发命令

```bash
npm install          # 安装依赖
npm run dev          # 启动开发（走 scripts/dev.cjs：文件入口 + 清 ELECTRON_RUN_AS_NODE + NO_SANDBOX）
npm run build        # electron-vite 构建（out/，不打包安装包）
npm run typecheck    # TS 类型检查（node 侧 + web 侧）
npm test             # vitest 单测（不需要网络、不需要 GUI）
npm run build:win    # 出 Windows 安装包（调试 UI 用）
npm run build:mac    # 出 mac 包（Windows 上只能出 zip/dir，签名需 Mac 或 CI）
```

调试数据目录隔离：`TSUMIGEYA_DATA_DIR=D:\YomeXProjects\Tsumigeya\.dev-data npm run dev`

## 目录结构（S2–S8 已全部落地）

```
├── AGENTS.md               ← 本文档（现状/决策/规矩）
├── docs/
│   ├── M1-实施方案.md      ← ★ 契约冻结稿（IPC 表/数据结构/文件清单/实施顺序/测试计划）
│   ├── M2-实施方案.md      ← M2 契约（D18–D22）
│   ├── M2.5-实施方案.md    ← ★ M2.5 交接稿（搜索/可编辑元数据/多语言偏好）
│   ├── M3-实施方案.md      ← ★ M3 交接稿（故障自愈：加密发行/RTP/字体/一键修复）
│   ├── M2.6-实施方案.md    ← ★ M2.6 交接稿（海报墙与详情页重构）
│   ├── 竞品功能对照表.md    ← MTool / RPGMakerUtils 功能面调研（判断哪些值得加）
│   ├── 需求-游戏内文本汉化.md ← 汉化需求记录（**暂不实现**，只沉淀格式与坑）
│   ├── M2.7-实施方案.md    ← ★ M2.7 交接稿（编辑页重构 + 保存 bug）
│   ├── M3.5-实施方案.md    ← ★ M3.5 交接稿（进程管理：追踪/关闭/游玩记录）——**已实施完毕**
│   ├── 调研-去掉上游launcher的可行性.md ← 上游 launcher 能否自实现（**已调研，待 M3.5 后实施**）
│   ├── M4.0-实施方案.md    ← ★ M4.0 交接稿（去掉上游 launcher，自实现启动）——**待实施**
│   └── 技术选型-三方案对比.md
├── _xeno_probe/            # 上游 Xenolauncher clone，只读参考，gitignore
├── resources/core/
│   ├── module.js           # ★ 核心引擎模块系统（GPL，fork 自上游 app/module.js）
│   └── FORK-NOTES.md       # 与上游的差异记录（改它之前必读）
├── src/
│   ├── main/               # Electron 主进程
│   │   ├── index.ts        #   窗口 / tsmg:// 协议 / CSP / 生命周期
│   │   ├── core-host.ts    #   core 单例（new Function 装载）+ 数据目录策略 + detectFolder
│   │   ├── games-store.ts  #   games.json / global-settings.json（原子写+.bak，不依赖 electron）
│   │   ├── extract.ts      #   解压服务（系统 bsdtar + 安全校验）
│   │   ├── dlsite.ts       #   M2：RJ 识别 + var contents 解析 + TTL 缓存（不 import electron）
│   │   ├── library-meta.ts #   M2：DLsite 元数据旁挂存储（library-meta.json）
│   │   ├── diagnose.ts    #   ★ M3：启动前诊断（五个检测器 + 汇总排序，不 import electron）
│   │   ├── exec-inject.ts #   ★ M3.5：launcher 加载时的 child_process 注入（只换 exec，D48/D49）
│   │   ├── process-registry.ts # ★ M3.5：进程表（只在内存，D50）+ 存活/复用/等待工具
│   │   ├── play-stats.ts  #   ★ M3.5：游玩记录旁挂存储（play-stats.json，D51）
│   │   └── ipc.ts          #   IPC 命令表 + 串行队列 + 取消 + 对话框桥 + OFF_QUEUE_METHODS
│   ├── shared/            #   零依赖纯函数（主进程 / 渲染层 / vitest 三处共用）
│   │   ├── bridge-error.ts#   ★ 跨 contextBridge 的 error.key 编解码（preload 与渲染层共享）
│   │   ├── age-rating.ts  #   R18 判定（只影响渲染）
│   │   ├── game-language.ts#  M2.5：语言标记剥离 + 标题归一化
│   │   ├── language-group.ts# M2.5：多语言版本分组（相似度 + 前缀防线 + 父目录推断）
│   │   ├── launch-language.ts# M2.5：启动时的语言切换决策
│   │   ├── gamecard-info.ts#  ★ M2.6：卡片/详情页取值降级（无值不画 vs 明说「暂无」）+ 作品类型代码表
│   │   └── plain.ts      #   ★ M2.7：toPlain() 递归剥 Vue 响应式 Proxy（过 contextBridge 前必用）
│   ├── preload/index.ts    # contextBridge 白名单桥（window.tsumi）
│   └── renderer/src/       # Vue3 前端
│       ├── pages/          #   Library / GameDetail（新） / GameEdit / Engines / Settings
│       ├── components/     #   AddGameWizard / DynamicArgsForm / GameCard / VersionManagerDialog / DiagnosisDialog / ...
│       ├── stores/         #   Pinia: library / engines / settings / task / coreDialogs
│       ├── api/client.ts   #   IPC 调用封装（全部类型定义，唯一类型来源）
│       └── locales/        #   zh-CN.json（所有 UI 文案集中在此）
├── scripts/
│   ├── dev.cjs             #   开发启动包装（文件入口 + 清环境变量 + NO_SANDBOX）
│   ├── probe-m2.cjs        #   M2 端到端验收探针（+ probe-m2-inner.cjs）
│   ├── probe-m25.cjs       #   M2.5 端到端验收探针（+ probe-m25-inner.cjs）
│   ├── probe-m3.cjs        #   M3 端到端验收探针（+ probe-m3-inner.cjs）
│   ├── probe-m26.cjs       #   M2.6 端到端验收探针（+ probe-m26-inner.cjs）
│   ├── probe-m27.cjs       #   M2.7 编辑页重构验收探针
│   ├── probe-m35.cjs       #   M3.5 进程管理验收探针（+ probe-m35-inner.cjs）
│   └── probe-save-fix.cjs  #   M2.7 保存 bug 修复验收探针（两阶段）
└── test/
    ├── fixtures/           # 假游戏目录（MV/VX Ace/2000/Ren'Py）+ dlsite/RJ294126.html
    │                       #   + dlsite/search-mercenary.html（M2.5 真搜索页裁切）
    │                       #   + encrypted-rgss3a/（M3：0x03 魔数 + GBK Game.ini，.gitattributes 锁住字节）
    └── *.test.ts           # vitest 单测（507 个，20 个文件，不依赖网络与 GUI）
```

## 架构与数据流（30 秒版）

```
Vue 组件 → Pinia store → api/client → preload(window.tsumi.invoke)
  → ipcMain('tsumi:invoke') → 串行队列(带 AbortController)
    → core(module.js 工厂实例, 注入 services) 或 games-store
  → 结果返回；进度/对话框经 'tsumi:event' 推回渲染进程
```

- **core 单例**：`src/main/core-host.ts` 在 app ready 后创建一次，全进程复用
- **module.js 工厂**：Node 下装载返回**工厂**，需自己调用：
  `factory({ getAppSupportDir, getGames, getUi, extractArchive, fetch })`
  （**不要用裸 `require`**，用 `new Function` + `createRequire` 手工执行，理由见 `docs/M1-实施方案.md` §3.6）
- **引擎 = 模块**：manifest.json（autodetect 规则 / gameArgs 表单 schema / dependencies 依赖下载）+ launcher.js（启动逻辑），
  装在 `<数据目录>/modules/<引擎名>/`，来自 GitHub 仓库 m5kro/Xenolauncher-Modules。加新引擎不需要改主程序。

## 已定决策（不要翻案，除非用户要求）

| # | 决策 | 原因 |
|---|------|------|
| D1 | Electron + Vue3，不用 nw.js/SwiftUI | Windows 本机可开发调试；module.js 95% 复用 |
| D2 | 接受 GPL-3.0，直接复用上游代码 | 工作量减半；将来发布衍生版必须开源 |
| D3 | macOS 数据目录 = `~/Library/Application Support/Xenolauncher`（与上游共享） | 上游模块 launcher.js/manifest 硬编码该路径，不共享则引擎无法启动；老用户游戏库零迁移 |
| D4 | Windows 开发时数据目录 = `%APPDATA%/tsumigeya`；`TSUMIGEYA_DATA_DIR` 环境变量优先 | 干净隔离 |
| D5 | 不用 module.js 的 `launchWithEngine`（吞 Promise，成败不可知），IPC 层自实现 launch | 参考 worker.cjs:316-325 |
| D6 | 不暴露 `installDependency`（上游 bug：参数错位，module.js:1688 vs :1646） | — |
| D7 | IPC 移植自 `_xeno_probe/native/Backend/worker.cjs`（原子写/队列/回滚/路径安全） | 该文件质量高，是现成范本 |
| D8 | 图片用 `tsmg://` 自定义协议（扩展名白名单），不用 file:// | contextIsolation 下的安全实践 |
| D9 | fetch 注入 Electron `net.fetch`，**并显式 `session.setProxy({ mode: 'system' })`** | `net.fetch` 用的是 session 的代理设置，而 session **默认不读系统代理**（不是"继承 Chromium 代理"，那是浏览器 window 的行为）。不显式设置的话，用户开着系统代理引擎却下载失败 |
| D10 | 游戏记录 schema 与上游完全一致：`{gameTitle,gamePath,iconPath,tags,gameEngine,gameArgs}` → games.json | 双向兼容 |
| D11 | core 用「读源码 + `new Function` + `createRequire`」装载，不用 `require(corePath)` | 裸 require 会被 Vite/rollup 改写或外置，打包后必炸 |
| D12 | 取消（`tsumi:cancel`）与对话框应答（`tsumi:dialog`）**绕开串行队列** | 进队列会死锁（core 在队列里等应答） |
| D13 | git 基线只提交 配置 + 文档 + core，`src/` 由下一会话从零写 | 交接时工作区必须反映真实状态，不提交空壳 |
| D14 | **只复用上游 `module.js` 一个文件**，不复用其 UI/外壳/样式/翻译；manifest 格式、模块仓库、数据目录属于"兼容约定"而非代码复制 | 用户只要核心功能，不要整体搬运；同时也是 GPL 边界的最小化 |
| D15 | `defaultFetch` 保留 `net.fetch` 优先，但要**兜底到全局 `fetch`**（无 electron 的 `net` 时） | 纯 Node / vitest 里 `require('electron')` 返回的是可执行文件路径字符串，没有 `net`；不兜底会直接崩在 fetch 调用上 |
| D16 | 拖拽取路径用 **`webUtils.getPathForFile`**（preload 暴露 `pathForFile`），**不用 `File.path`** | Electron 32+ 已移除 `File.path`，在 Electron 45 上它恒为 `undefined`，拖拽会静默失败 |
| D17 | **不给纯 Node 侧加代理回退**（用户 2026-11-04 决定） | 代理交给主进程的 `session.setProxy({ mode: 'system' })`（D9）处理，纯 Node 测试按 §6 必须不依赖网络。**修正**：原写"生产注入的 net.fetch 天然继承系统代理"是错的，详见「已知坑」 |
| D18 | DLsite 元数据**旁挂** `library-meta.json` + `dlsite/<RJ>.json`，`GameRecord` 零改动（`Snapshot` 只**新增** `meta` 字段） | 守 D10；删掉 `library-meta.json` 游戏照样能启动，上游读 games.json 完全无感。**实测已验证**：`snapshot.games[0]` 的键只有 `gameEngine/gamePath/gameTitle/id` |
| D19 | 只解析页面末尾 `var contents` 的 JSON，**不解析 HTML 表格**；**标签/genre 不做** | 调研实测：`product/info/ajax` 返回 `[]`、`api/product` 404、JSON-LD 无 Product。多请求方案不可行，不承诺 |
| D20 | 元数据抓取**只在主进程**做（渲染层不发网络请求），CSP 只加 `img-src https://img.dlsite.jp` | 最小攻击面；`<img>` 不受 `connect-src` 约束，所以不动 `connect-src`/`script-src` |
| D21 | `dlsiteLookup` / `dlsiteDetectRJ` 进 `OFF_QUEUE_METHODS`（绕串行队列） | 只写自己独立的 `<dataDir>/dlsite/` 缓存目录，与队列内写操作无共享资源；防重演"更新检查堵死队列"。**名单用测试锁死**（`test/ipc-offqueue.test.ts`） |
| D22 | 封面 URL 必须 host ∈ `img.dlsite.jp`，否则丢弃 | 外部数据不可信，禁止任意远程图进渲染层 |
| D23 | DLsite 搜索结果解析**优先用结构化锚点** `data-list_item_product_id`，无锚点时退回 `product_id/(RJ…).html` 宽松匹配；两条路径共用噪音过滤 + 按 RJ 去重 | 实测真实结果页每条记录里 RJ 重复出现 5 次（缩略图/链接/购物车按钮各一次），纯 href 正则会把按钮文案当成标题；结构化锚点是最稳的边界 |
| D24 | 搜索**只取第一页**，上限 20 条，**绝不自动选第一条** | §1.3 实测：搜「傭兵」首条是「即ハメ王女」而非目标作品。自动选中会让用户以为搜到了对的、实际存进错的 RJ |
| D25 | 可编辑字段白名单**不含 `rj`**（title/circle/coverUrl/registDate/price） | 改 RJ 等于换作品，会产生「标题属于 A、RJ 属于 B」的错位数据；换作品应走「搜索/填 RJ」流程 |
| D26 | 可编辑元数据用 `editedFields` 标记 + `mergeWork` 合并：**被编辑的字段刷新不覆盖** | 用户手改过的值属于用户数据；不标记的话一次「重新获取」就把用户劳动冲掉了 |
| D27 | **多语言偏好与 DLsite 无关**，纯本地文件层面判断（§1.5 实测 `lang_options` 是作品单值） | 不同语言版是独立 RJ，不能靠 DLsite 字段判断；本地按目录名/标题的语言标记 + 相似度判 |
| D28 | 多语言分组**必须**加 `isSuffixExtension` 前缀防线，不能只靠相似度阈值 | 实测 `similarity("傭兵の冒険","傭兵の冒険2") = 0.833 > 0.8`：光靠阈值会把续作判成原作的多语言版，用户点启动会被引到错的游戏。归一化后真正的多语言版应当**完全相同**，还差尾巴的是另一个商品 |
| D29 | 多语言分组允许**父目录推断为 ja**（极保守）：某游戏无任何语言标记、且它正好是另一个「已识别出非 ja 语言」游戏的祖先目录 | 用户真实布局是「日文原版在父目录、中文版在内层带 `_CHN`」，父目录本身无标记；不推断则这条最常见的样本永远成不了组。自己标了 `_EN` 时以显式为准，不被覆盖 |
| D30 | 语言切换确认的「不再询问」做成**设置页开关**，不做对话框勾选框 | 勾选框一旦勾上就再也找不到入口重开；设置页随时能改回来 |
| D31 | 语言偏好（§C）**绝不自动删除/隐藏**其他语言版 | 那是用户数据，§C.5 明令不代删；只做标记与提示 |
| D32 | 诊断**只用本地文件特征**，不调 mkxp-z、不解析它的英文报错 | 报错文本不稳定且是英文（"No script file has been specified…"）；本地特征（归档魔数、目录结构、`Game.ini` 的 ASCII 结构行）是确定的 |
| D33 | `.rgss3a`/`.rgss2a`/`.rgssad` 的魔数版本号**优先于** launcher 的 DLL 扫描推断（魔数缺失时才退回扩展名） | 魔数是归档自身的声明，比扫 `RGSS3xx.dll` 可靠（用户可能删了 dll、也可能放错位置）。实测 `傭兵の冒険` 的 `Game.rgss3a` 魔数 = 0x03 → VX Ace |
| D34 | **加密发行不自动解包**，只检测 + 提示 + 引导（`fix` 只给 `openFolder`） | DRM 破解的法律风险；产品只负责告诉用户「去用 RGSS 解包工具」，不提供工具名、更不代劳 |
| D35 | `fontSub` **不做自动修复**，只做「自带字体存在」的 info 提示 | 实测 `fontSub` 是字体**替换映射**（`"Arial>Open Sans"`），**不是**目录加载器；游戏自带 `Fonts/` 本就被 mkxp-z 自动加载。自动改会猜错反而添乱 |
| D36 | `launch` 的返回类型扩成联合类型 `{message} \| {blocked, diagnoses}`，**有 fatal 诊断时返回结构化结果而不抛错** | 抛错会走 `translateError` 通用路径，而诊断框需要「多条 + 每条带 level/fix」的结构化数据；也躲开 contextBridge 跨边界丢属性的老坑 |
| D37 | 「还是启动试试」只对**非 fatal**可见，且点它时 `launch` 带 `diagnose:false` 重走一次 | fatal 绕过只会让用户多撞一次英文报错（§9 R5）；而不传 `diagnose:false` 会被同一个诊断框再拦一次，绕过按钮等于摆设 |
| D38 | `missingRtp` 是 **warning 不是 fatal**；补装 RTP **不走 core 的 `updateDependenciesTaskWithProgress`** | 缺 RTP 的游戏常常仍能跑（只缺素材），拦死它会把能玩的游戏变成不能玩；而那个 core API **只更新已安装的依赖**——RTP 从没装过时实测它一个字节都不下却报「完成」。改走自实现的 `installDependencies(folder, wanted, signal)`（按 manifest 只下指定依赖，**core 零改动**） |
| D39 | 卡片封面**保持 4:3 横版**（`aspect-ratio: 4/3`），不套 Jellyfin 的 2:3 竖版 | DLsite 源图实测是横向（560×420）；2:3 + `object-fit: cover` 会左右各裁约 40%，常切掉人物或标题文字。形状跟随源图，信息密度靠简介/类型标签补（用户拍板） |
| D40 | 标签与制作人员**不建空字段**（不加 `genres: []` / `credits: {}`），UI **明说「DLsite 不提供」** | 加空字段会让下个会话误以为「实现了但没数据」；实测 `work_genre` 区块在详情页与搜索页都是空的、作品情報表格不在返回的 HTML 里（D19 已判死）。卡片空间有限所以**整行不画**，详情页是信息页所以**必须交代** |
| D41 | **启动按钮只在详情页**，卡片与列表行只有三点菜单 | 用户明确要求，且「点卡片 = 查看详情」才能避免误点启动（卡片是浏览入口，不是操作面） |
| D42 | `mergeWork` 刷新时，**只在搜索结果页才有的字段**（`author` / `salesCount` / `rating`）在 `incoming` 缺失时**沿用旧值** | 这三项从详情页重拉天然拿不到（§3.1 `contents` JSON 不含）。原来 `{...incoming}` 直接覆盖，实测会让用户已经搜到并存下的作者/销量在一次「重新获取」后**凭空消失**。`summary` 不在此列（详情页拿得到，该被新值覆盖） |
| D43 | 卡片/详情页的取值降级抽成 `src/shared/gamecard-info.ts`（零依赖纯函数），**不写在 .vue 里** | 全是「有就显示、没有就不画」的判断，画错了不报错、只是界面缺一块，端到端探针很难发现；抽出来能用单测钉死（40 条）。同一份逻辑同时服务卡片（无值不画）与详情页（无值明说「暂无」）两种取向 |
| D44 | 过 contextBridge 的响应式数据**一律走通用 `toPlain()`**，且**在 store 层统一施加**，不做逐字段拷贝 | 逐字段方案踩了两次（M2.5 的 `plainWork` 只覆盖元数据路径；M2.7 保存基本信息时 `gameArgs` 又漏）。放 store 层 = 新加路径也不会漏。回归测试 `test/plain-bridge.test.ts` 直接钉死 |
| D45 | 图标**不删除，折叠为「高级」**；封面与图标合并成一个「封面预览」区块并标明来源 | 图标在没有 DLsite 信息时是唯一兜底（用户拍板「保留手动改」）；合并是为了让用户看清「卡片到底显示哪张」，而不是面对两个独立区块猜 |
| D46 | 标题**不改存储**，只做来源提示（manual/dlsite/dirname 三态）+ 「用 DLsite 标题」快捷按钮 | 自动改 `gameTitle` 会写进 `games.json`（上游 schema，D10）；显示层回落更安全，且 M2.6 卡片/详情页本来就有回落逻辑 |
| D47 | 标签**必须保留**，并在 UI 上说明「DLsite 不提供分类标签」 | D19/D40 已实测 DLsite 的 genre 拿不到（`work_genre` 区块为空）；删了标签就没有任何标签来源 |
| D48 | 进程追踪用**「加载 launcher 时注入 `child_process`」**，不改上游 modules 仓库 | 上游一更新就会冲掉我们的改动，且要改 4 个模块（nwjs/mkxpz/easyrpg/renpy 全用 exec）。注入方案零上游改动，launcher 以为自己调的是原生 exec。可行性已用最小实验验证 |
| D49 | 注入**只替换 `exec`**，其余 `child_process` 方法原样透传 | 上游可能改实现；透传保证「最坏失去追踪」而不是崩溃 |
| D50 | 进程状态**只在内存**，不落盘 | 进程是运行时事实；落盘会产生「显示在运行但进程早没了」的假象 |
| D51 | 游玩记录（`lastPlayedAt`/`playCount`/`totalSeconds`）落**独立的 `play-stats.json`** | 不放 `GameRecord`（守 D10）；不放 `library-meta.json`（语义不同，那是 DLsite 元数据）。独立文件可单独删 |
| D52 | `stopGame` 走 **SIGTERM → 等 5 秒 → SIGKILL** 两段式 | 温和优先（游戏可能要保存），但卡死时也要能救 |

## 已知坑

| 坑 | 对策 |
|---|---|
| **用「目录」入口启动 Electron 必 segfault**（`0xc0000005` / exit 139）。判定依据（本机反复验证）：同一最小项目 `electron <文件>` **100% 正常**（连续 3 次 `exit=0` + `LOAD_OK`），`electron <目录>` **100% 崩**。与是否注册协议、是否 sandbox、是否 CSP 无关；`--disable-crash-reporter / --disable-gpu-compositing / --in-process-gpu / --single-process` 全部无效。**注意：上一会话把这条误判为"环境限制、无解"，是错的** | `npm run dev` 已改为走 `scripts/dev.cjs`：强制 `ELECTRON_ENTRY=out/main/index.js`（文件入口）+ 清掉 `ELECTRON_RUN_AS_NODE`/`NODE_OPTIONS` + win32 下 `NO_SANDBOX=1`。**不要把它改回 `electron-vite dev`** |
| `electron --version` 直接崩 | 本机 shell 继承了 `ELECTRON_RUN_AS_NODE=1` 与 `NODE_OPTIONS`（指向 DSH 的 compat 注入），会让 electron.exe 以纯 Node 模式跑或直接崩。`scripts/dev.cjs` 已统一清除；手动排查时用 `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS` |
| **文件入口时 `app.getAppPath()` = `out/main`**，不是项目根 | `resolveCorePath` 不能只拼一层。已改为从 appPath + cwd 出发**向上探测 6 级**找含 `resources/core/module.js` 的根，并有 4 条回归测试锁住（`test/detect.test.ts`） |
| `env.d.ts` 里写顶层 `import` → 所有 `.vue` 报 `TS2307` | 顶层 import 让文件变成模块，`declare module '*.vue'` 不再全局。用内联 `import('./api/client').TsumiBridge` |
| Node 原生 `fetch` 不读 WinINET 系统代理 | 本机 raw.githubusercontent.com 直连 DNS 失败、走代理 200。纯 Node 验收看不到远程 manifest 属正常 |
| **`net.fetch` 不会自动走系统代理**（macOS 实测踩坑） | Electron 的 `net.fetch` 用 session 的代理设置，session 默认 `mode: direct`。必须 `session.defaultSession.setProxy({ mode: 'system' })`。实测：设置后同一请求 1083ms → 346ms，`resolveProxy` 返回 `PROXY 127.0.0.1:7897`。症状是「浏览器能上网、引擎下载报网络连接关闭」 |
| 主进程没注入 `fetchImpl` 时静默降级到全局 fetch | `index.ts` 必须显式传 `fetchImpl: (i, init) => net.fetch(i, init)`。否则 core-host 的兜底会用全局 fetch，更不可能走代理，且不会报错、只会「下载失败」 |
| 上游 `fetchRemoteManifest` 失败时**静默降级**成 `raw: {}` | 这不是 bug：它会调 `onManifestError` 产生 warning，`checkEngineUpdates` 里表现为 `checkFailed: true` + `remoteVersion: 'N/A'`。UI 用 `el-alert` 展示 warning，不崩 |
| `settings-row` 里塞 `array` 类型的编辑块 → 布局错乱 | `DynamicArgsForm` 把 array 编辑块放在 `settings-row` **外面**，独立成 `.args-array` |
| 测试里 `as const` 的 manifest 与 `ManifestRaw` 不兼容 | `as const` 产生 readonly 数组，`extensions: readonly ["exe"]` 不能赋给 `string[]`。测试里用 `Record<string, Record<string, unknown>>` |
| `createCoreHost` 未注入 fetch 时在测试里崩 | 测试必须显式传 `fetchImpl`（建议传会抛错的，顺带断言"断网不崩"） |
| GPU 缓存目录被拒（`GPUPersistentCache ... 拒绝访问`）刷屏 | 无害噪音，不是崩溃。判据看 **exit code 与窗口是否渲染**，别被这行 ERROR 误导 |
| **顶层调用 `app.setName()` 会让 Electron 直接 segfault** | 实测可稳定复现（加一行就崩、去掉就好）。不要用 setName 控制数据目录；数据目录由 `resolveDataDirWithFallback()` 显式决定（首选 `%APPDATA%\tsumigeya`） |
| **`tsumi:pick` 忘记注册 handler → 点「选择文件夹/文件」永久无反应** | preload 走 `ipcRenderer.invoke('tsumi:pick')`，而 `registerIpc` 只注册了 `tsumi:invoke`。已在 `registerIpc` 内补 `ipcMain.handle('tsumi:pick')`（直连，不进队列）并加入注销。**新增 preload channel 时务必同步注册 handler** |
| 文件入口下 `app.getPath('userData')` = `%APPDATA%\Electron` | 因读不到 package.json 的 name。不要把它传给 `resolveDataDir`（会与其它 Electron 应用撞目录 + 撞权限）。用 `resolveDataDirWithFallback()` |
| Windows 上 `%APPDATA%` / `%TEMP%` 可能整体 EPERM | 沙箱/受限账户下很常见。`resolveDataDirWithFallback` 会按 `%APPDATA%\tsumigeya` → `%TEMP%\tsumigeya-data` → `<cwd>\.dev-data` 依次降级，并弹 dialog 告知；`TSUMIGEYA_DATA_DIR` 可强制指定 |
| **`failure()` 返回的 Error 没有 `code`** | 它只挂 `translationKey`/`translationArguments`。任何要靠 `err.code` 做分支的地方（如降级判断）都会被误导成 `undefined`。要么显式补 `code`（`ensureDataDir` 已这么做），要么用别的方式判定 |
| **whenReady 里抛错 = 窗口永不出现，且用户看不到原因** | 曾经 `createCoreHost` 抛 EPERM，用户只看到「软件没弹出来」。主进程启动链上的可预期失败必须降级 + 告知，不能直接 throw |
| **串行队列会被启动自动更新检查堵死**（实测根因） | `checkEngineUpdates` 最长 60s 且排在队列里，期间任何命令（含「识别引擎」）都在后面干等，UI 表现为永远卡住。已把 `detect` / `detectFolder` / `snapshot` / `versions` 改为**绕开队列**（只读、不写盘，不会与写操作冲突）。**新增只读且用户要等反馈的命令时，考虑加入这个旁路名单** |
| 端到端验证队列是否真的没堵 | 起应用后用 `webContents.executeJavaScript` 从渲染层真调 `window.tsumi.invoke('detectFolder', ...)` 并计时。实测修复后 **2ms** 返回（修复前会等到 60s 更新检查结束） |
| **i18n 文案里写 ICU 语法会让整个组件白屏**（本项目最隐蔽的坑） | 项目只装了 `vue-i18n`、**没有** `@intlify/unplugin-vue-i18n` 编译器，所以 `{count, plural, =0 {} other {…}}` 会在运行时抛 `SyntaxError: 2`，而**报错只在 console，界面表现为整块组件消失**（只剩侧边栏）。**文案里只允许 `{simpleIdentifier}` 形式占位符**，复数/格式化请改用普通拼接或 computed |
| **Vue 模板表达式里不能写 TS 类型断言** | `@click="step = (step - 1) as Step"` 同样导致组件渲染失败白屏。模板里只写运行时代码，类型断言放进 `<script setup>` 的具名函数 |
| 排查「组件突然消失」的姿势 | 在页面里挂 `window.addEventListener('error')` + 包装 `console.error` 收 `stack`；再对比 `document.querySelector('#app').innerHTML.length` 在操作前后的变化（本例：4198 → 544 即组件被卸载） |
| **contextBridge 跨边界 throw 会丢 `error.key`**（M2 端到端探针实测踩到） | Electron 跨隔离边界抛错时**只保留 message/stack**，自定义属性（`error.key`/`arguments`）被静默丢弃 → `translateError()` 永远查不到 key，**所有中文错误文案退化成英文原文，且不报任何错**，看起来只是「提示语没翻译」。已修：preload 把 key 编进 message 尾部的 `\u0000tsumi-key:` 标记，渲染层 `decodeBridgeError()` 解回来。实现在 `src/shared/bridge-error.ts`（preload 与渲染层共享一份，标记常量只有一处定义） |
| **Vue 响应式 Proxy 直接传给 IPC → `An object could not be cloned.`**（M2.5 的 S4 端到端探针实测踩到） | 症状最恶劣：用户点「保存」后**字段看起来没动**，控制台只有一行英文，界面上什么提示都没有（`ElMessage.error` 在 `catch` 里，但错误对象过桥时已被截断）。根因是 contextBridge 用**结构化克隆**，而 Vue 的 `reactive`/`ref` 包出来的是 Proxy，克隆不了。**`{ ...meta }` 浅拷贝也救不了**——深层的数组（如 `editedFields`）仍是 Proxy。对策：写一个 `plainWork()` 逐字段取值 + 复制数组，保证传出去的只有普通值；`saveMeta` / `resetField` / `commitEdit` 三处都要过它。回归测试 `test/edit-plain-object.test.ts` 用 Proxy + `structuredClone` 钉住这条 |
| **`.vue` 里 `watch(..., { immediate: true })` 会立刻调用 fill()** | 被调用的函数若引用了**后面才声明**的 ref，会撞 TDZ：`ReferenceError: Cannot access 'rjInput' before initialization`，**组件整块白屏**。实测在 `GameEditPage` 踩到。规矩：所有 ref/computed 声明必须在任何 `immediate: true` 的 watch 之前 |
| **Vite 打包后 `out/main` 的 stdout 在 Windows 会丢** | Electron 是 GUI 子系统，`console.log` 常常什么都不打印（表现为「脚本像没跑」）。验收脚本必须**同时写结果文件**；而且 `%TEMP%` 在受限会话下整体 EPERM（见上一条），结果文件要写到**项目目录内** |
| 跑 Electron 验收脚本必须带 `--no-sandbox` | 受限桌面会话下裸跑 `electron script.cjs` 直接 **exit 3 且零输出**。`scripts/dev.cjs` 与 `scripts/probe-m2.cjs` 都处理了这条；手动跑时记得加 `--no-sandbox` + `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS` |
| **`Game.ini` 是 GBK / Shift-JIS，不是 UTF-8**（M3 §2.5 实测） | 按 UTF-8 读 `Title=` 得到的是乱码（真实样本 `傭兵の冒険` 的 `Title` 是 GBK 字节 `d3b6 b1f8 …`）。`readGameIni()` **只按 `latin1` 读 `[Game]` 段的 ASCII 结构行**（`RTP=` / `Scripts=` / `Library=`），**绝不用 `Title=` 做任何判断或展示** |
| **core 的 `updateDependenciesTaskWithProgress` 只更新「已安装」的依赖** | RTP 从没装过时它只打一句 `No dependency updates found.` 就返回，**一个字节都不下**，却让调用方以为成功了（用户点「一键补装」→ 进度条跑完 → RTP 仍然缺失，比不修更糟）。要用「按名字装指定依赖」得自己走 manifest，见 D38 与 `ipc.ts` 的 `installDependencies` |
| **core 的 `installDependency` 参数错位（D6 的老 bug仍在）** | `installDependency(folder, depName, builds)` 内部调 `installOneDependency(depName, builds, depsRoot, opts)`（**4 个参数**）时只传了 3 个 → folder 被当成 depName、depName 被当成 builds、builds 被当成 depsRoot。**永远不要用它**，也不要「修一修 core」——那是 GPL fork，改动要最小化（FORK-NOTES） |
| **解压依赖时的「拍平」不要盲目剥单层目录** | M3 单测抓到：只判断「解压结果是否为唯一单层目录」就剥掉，会把 `deps/RTP/RPGVXace` 里的版本目录也当成包裹层吞掉，导致诊断查 `deps/RTP/RTP/<版本>` **永远判缺失**。正确做法：**只剥与依赖名同名**的那一层（`RTP.zip` 内部顶层就叫 `RTP/`） |
| **`tarBinary()` 原来没有 Linux 分支 → CI 首次发版直接炸**（2026-11-04 v0.3.0 实测） | 原实现只判 `darwin`，否则一律拼 `%SystemRoot%/System32/tar.exe`；而 Linux 上 `SystemRoot` 是 undefined → 回落到 `C:/Windows/System32/tar.exe` → **spawn ENOENT**，CI 的 `npm test` 挂在 `installRtp 真的下载并落地` 那条上（本机 Windows 测不出来）。已改为显式三分支：darwin→`/usr/bin/tar`、win32→`%SystemRoot%/System32/tar.exe`、**其余→PATH 上的 `tar`** |
| **`installDependencies` 的「拍平包裹层」方向写反 → RTP 落地层级错位**（v0.3.0 CI 炸出来） | 原写 `wrap = entries[0].name === name`（与依赖名同名就拍平），而真实 `RTP.zip` 顶层**就是** `RTP/`、`depDir` 本身已叫 `deps/RTP`，于是那层被拍掉 → 落地 `deps/RTP/RPGVXace` → `detectMissingRtp` 查 `deps/RTP/RTP/<版本>` **永远判缺失**（用户点「一键补装」后问题依旧）。已改为 `entries[0].name !== name`（只剥**无关**包裹层；同名的必须保留），并新增回归测试「与依赖名同名的顶层目录必须保留」+ 目标已存在时先删再 rename |
| **RTP 目录名大小写不敏感问题 → Linux 上永远判「RTP 缺失」**（v0.3.0 CI 第三次失败实测） | 真实目录名是 `RPGVXace`（小写 a），而不少 `Game.ini` 写 `RPGVXAce`（大写 A）。Windows/macOS 文件系统**默认大小写不敏感**，两种写法都能 stat 成功 → 本机永远测不出来；**Linux 大小写敏感** → 找不到目录 → `missingRtp` 一直存在。已加 `normalizeRtpName()`（忽略大小写匹配三个已知目录名）+ `detectMissingRtp` 精确查不到时再 `findCaseInsensitive()` 扫实际目录（兜住用户手改过的名字）。**教训**：任何「按文件系统路径存在性判断」的逻辑，都要假设 CI 是 Linux（大小写敏感） |
| **同一个 contextBridge Proxy 坑踩了第二次**（2026-11-04 用户实测） | M2.5 修 `saveGameMeta` 时写的是**逐字段**的 `plainWork()`，只覆盖了「DLsite 元数据」那一条路径；这次**保存基本游戏信息**时把 `gameArgs`（DynamicArgsForm 双向绑定的 reactive 对象）直接传过去 → 同样抛 `An object could not be cloned.`，用户看到「点保存没反应，只弹一句英文」。**逐字段方案天生会漏**——已改成通用 `toPlain()`（`src/shared/plain.ts`，递归剥对象/数组/嵌套/Date/循环引用）并**在 store 层统一使用**（`library.ts` 的 `saveGame` / `saveGameMeta`）：页面不用记得叫它，走 store 就一定被剥干净。回归测试 `test/plain-bridge.test.ts` 直接钉死：`structuredClone(reactive)` 抛、`structuredClone(toPlain(reactive))` 不抛 |
| **PATH 上的 `tar` 在 Windows 是 GNU tar，不是 bsdtar** | 单测里造压缩包时 `execFileSync('tar', ...)` 拿到的是 `/usr/bin/tar`（GNU 版），它把 `C:\...` 当成远程主机名报 `tar: Cannot connect to C: resolve failed`（exit 128）。用 **`C:\Windows\System32\tar.exe`**（bsdtar，也是 `src/main/extract.ts` 生产环境用的那个） |
| **给 `GameMeta` 加字段时必须同步改 `library-meta.ts` 的 `sanitize()`**（M2.6 S1 端到端探针实测踩到） | `sanitize()` 是**落盘的字段白名单**：它只挑自己认识的字段重建对象，所以 `DlsiteWork` 里新加了 `summary`/`author`/`salesCount`/`rating` 之后，`saveGameMeta` **回执的 keys 里根本没有它们**——不报错、不警告，界面表现是「解析到了但详情页全是暂无」。判定方法：改完解析层后先看 `saveGameMeta` 的返回键集。回归测试 `test/library-meta.test.ts` 的「M2.6 新增字段必须能落盘」8 条锁住这条 |
| **`el-dropdown-item` 的 `aria-disabled` 是字符串 `"false"`**（M2.6 探针自己踩到） | `!!el.getAttribute(...)` 恒为 true（非空字符串都是真值），会把「三项菜单全 disabled」当成真实现象去查。判据写成 `el.getAttribute("aria-disabled") === "true"` 或 `el.classList.contains("is-disabled")` |
| **模板里别写复杂表达式**（M2.6 顺手确认的边界） | 卡片「也有 xx 版」用 `[...new Set(langs)].sort(...)` 在 **computed 里**完成，模板只读一个字符串——模板里写复杂表达式既容易白屏也难断言（AGENTS.md 的「模板禁 TS 断言」是同一条精神） |

> **验收 `npm run dev` 的正确姿势**（本机无画面可看时）：启动后用 `BrowserWindow.getAllWindows()` +
> `webContents.executeJavaScript('document.body.innerText')` 抓 DOM 文本，确认标题/路由/`typeof window.tsumi`。

## 协作规矩（多 AI 接力）

1. **开工前必读**：`AGENTS.md`（本文）→ `docs/M1-实施方案.md`（契约）→ `resources/core/FORK-NOTES.md`（core 规矩）。
2. **动 core 之前读 `FORK-NOTES.md`**——那是 GPL fork，改动要最小化并逐条登记。
3. **UI 文案一律进 `src/renderer/src/locales/zh-CN.json`**，不要硬编码中文字符串（为将来加英文）。
4. **不要改已冻结的契约**（IPC 表 / 事件协议 / 数据结构 / 文件清单）。确需改：先改 `docs/M1-实施方案.md` 并说明理由，再改代码。
5. **新决策写进本文档「已定决策」表**，必要时在 `docs/` 落一篇决策记录。
6. **收尾三件事**：`npm run typecheck && npm test && npm run build` 全绿 → 更新本文档「当前项目状态」→ git commit（提交信息中文，说清改了什么为什么）。
7. 不要动 `_xeno_probe/`（只读参考）；不要提交 `node_modules/ out/ dist/ *.tsbuildinfo`。
8. 修改 IPC 命令时：`src/main/ipc.ts`（实现）、`src/preload/index.ts`（桥）、`src/renderer/src/api/client.ts`（类型）三处同步改。
9. Windows 上无法验证"真实启动游戏"（mac 二进制），启动链路的修改要在本文档状态里标注"待 Mac 验证"。
10. **不要在本文档里提前写「已完成」**：状态只记录实际提交过的东西（上一会话就是因为提前写完成，导致下一个会话拿到假前提）。

## 里程碑路线图

- **M1（已完成）**：中文游戏库 + 自动识别 + 一键安装引擎 + 启动
- **M2（已完成）**：DLsite 元数据（RJ 号 → 标题 / 社团 / 封面 / 发售日 / 价格，封面墙）
  - 方案与决策见 [`docs/M2-实施方案.md`](./docs/M2-实施方案.md)（D18–D22）
  - **标签（genre）明确不做** —— 调研实测接口不可用，不承诺（D19）
- **M2.5（已完成）**：搜索 / 可编辑元数据 / 多语言偏好
  - 方案见 [`docs/M2.5-实施方案.md`](./docs/M2.5-实施方案.md)（D23–D31）
- **M3（已完成）**：故障自愈
  - 方案与实测前提见 [`docs/M3-实施方案.md`](./docs/M3-实施方案.md)（D32–D35；实施中新增 D36–D38）
  - 四项：①加密发行检测（`.rgss3a`/`.rgss2a`/`.rgssad` 魔数 → RGSS 版本）
    ②RTP 缺失检测（读 `Game.ini` 的 `RTP=`，检查 `deps/RTP/RTP/<版本>`）
    ③字体提示（**只提示不修**，理由见 D35）④一键修复
  - **诊断在启动前自动跑**（用户拍板）；fatal 不给绕过，warning 才给「还是启动试试」
  - **不做**：自动解包加密发行（D34，DRM 法律风险）
  - 实测前提（已在 M3 文档 §2 记录，**别重复验证**）：
    `RGSSAD` + 第 8 字节 0x01/0x02/0x03 = XP/VX/VX Ace；RTP 包 244MB；
    `fontSub` 是字体替换映射不是目录加载器；**`Game.ini` 是 GBK 非 UTF-8，只按 latin1 读 ASCII 结构行**
  - 端到端验收：`node scripts/probe-m3.cjs`（真实样本 傭兵の冒険_CHN）
- **M2.6（已完成）**：海报墙与详情页重构 —— 见 [`docs/M2.6-实施方案.md`](./docs/M2.6-实施方案.md)（D39–D43）
  - 卡片重写（4:3 封面 + 简介 2 行 + 类型标签 + 三点菜单，**无启动按钮**）
  - **新增详情页** `GameDetailPage.vue`（唯一启动入口 + 完整元数据 + 明说「DLsite 不提供」）
  - **路由拆分**：`/game/:id` = 详情页、`/game/:id/edit` = 编辑页
  - 数据层新增 `summary`/`author`/`salesCount`/`rating`（**只有搜索结果页有后三项**，见 D42）
  - 端到端验收：`node scripts/probe-m26.cjs`
  - **视觉观感仍未人眼验收**（卡片悬停、简介截断、窄窗口塌陷、R18 模糊强度）
- **M3.5（已完成，v0.3.2）**：进程管理 —— 见 [`docs/M3.5-实施方案.md`](./docs/M3.5-实施方案.md)（D48–D52）
  - 三项：①启动后**进程追踪**（`Snapshot.running`）②**关闭游戏**（SIGTERM→5s→SIGKILL）③**游玩记录**（`play-stats.json`）
  - **关键实现**：加载 launcher 时**注入 `child_process`**（不改上游 modules 仓库）——劫持的是
    `Module` 实例的 `require` 作用域，**只影响这一个模块**；`spawn`/`spawnSync` 等原样透传（D49）
  - 端到端验收：`node scripts/probe-m35.cjs`（假引擎 + 真进程 + 真 kill）
  - **未验证**：mac 上真引擎（nwjs/mkxpz/easyrpg/renpy）的 exec 命令串形态、NW.js 的子进程树
    （若一个 PID 杀不干净，后续要 `pkill -P <pid>` 整棵树，方案 §9 R4）
- **M4.0（方案已冻结，待实施）**：去掉上游 launcher —— 见 [`docs/M4.0-实施方案.md`](./docs/M4.0-实施方案.md)（D53–D56）
  - 新增 `src/main/launchers/`（4 个引擎 + 集中的 binary 路径），用 `spawn(binary, args[])` 替掉 `launcher.launch()`
  - 收益：**不改用户游戏文件**（上游 nwjs 会改 `js/main.js`）、摆脱 xenolauncher 数据目录、清补丁式代码
  - **关键待定**：未知引擎（第三方模块）是否回退上游 launcher（决定 `exec-inject.ts` 能否彻底删）
  - 见 `docs/M4.0-实施方案.md` §10
- **M4**：存档管理（集中查看/备份/导出）+ 增强（Cheat 注入/变速）
- **M5**：手柄、无边框全屏、像素缩放、dmg 公证分发

## 上游参考

- 仓库：https://github.com/m5kro/Xenolauncher ；模块仓库：https://github.com/m5kro/Xenolauncher-Modules
- 本地 clone：`_xeno_probe/`（module.js 在 `app/module.js`，IPC 范本在 `native/Backend/worker.cjs`）
- 技术分析：`docs/技术选型-三方案对比.md`
