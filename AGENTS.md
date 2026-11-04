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

- **阶段**：**M2（DLsite 元数据）S1–S5 已完成**；M1 全绿保留
- **已完成**：
  - M1 全套（游戏库 / 自动识别 / 一键安装引擎 / 启动），v0.1.4 已在 Mac 上实测可启动 NW.js 游戏
  - **M2 全套**：`src/main/dlsite.ts`（RJ 识别 + `var contents` 解析 + TTL 缓存 + 4 类错误）、
    `src/main/library-meta.ts`（旁挂存储）、5 条 IPC 命令（`dlsiteDetectRJ` / `dlsiteLookup` /
    `saveGameMeta` / `refreshGameMeta` / `clearGameMeta`）、`OFF_QUEUE_METHODS` 常量、
    CSP `img-src` 白名单、session `adultchecked` cookie、编辑页 DLsite 面板、GameCard 封面三级降级
  - `src/shared/bridge-error.ts`：修掉「contextBridge 跨边界丢 `error.key`」导致中文文案退化成英文的老 bug
  - **测试 165 个全绿 / 9 个文件**（M1 的 76 个 + M2 新增 89 个）
- **M2 端到端实测（Windows 本机，`node scripts/probe-m2.cjs`）**：
  - `dlsiteLookup` 走系统代理**真拿到数据**：`純愛おま○こ当番【アップデート版】` / `青春×フェティシズム` /
    `2020/08/30`，**约 260ms**
  - 封面 `<img>` 真的加载成功：`naturalWidth = 560, complete = true`
    → **方案 §11 的 R3（防盗链）与 R4（R18 二次拦截）实测解除，不需要「主进程下载封面」的备选**
  - `snapshot.games[0]` 的键只有 `gameEngine/gamePath/gameTitle/id` → **D18（GameRecord 零改动）实测验证**
  - 编辑页 `htmlLen = 6411`、`consoleErrors = []` → 组件没白屏
- **验证基线（Windows 本机实测）**：
  - `npm run typecheck` ✅ exit 0
  - `npm test` ✅ 165 passed / 9 files
  - `npm run build` ✅ exit 0
  - `node scripts/probe-m2.cjs` ✅ 全链路通过（见上）
- **仍未验证（必须在有桌面会话的机器上做）**：
  - **视觉观感**：暗色主题配色、封面卡片裁切比例、进度浮层动效需人眼验收
  - **系统文件对话框的返回值**（M1 遗留，已加手输路径兜底）
  - **安装引擎 / 其他引擎类型**（需 mac）
  - **M2 编辑页交互手感**：RJ 候选多选、预览保存按钮的可见性
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
│   │   └── ipc.ts          #   IPC 命令表 + 串行队列 + 取消 + 对话框桥 + OFF_QUEUE_METHODS
│   ├── shared/
│   │   └── bridge-error.ts #   ★ 跨 contextBridge 的 error.key 编解码（preload 与渲染层共享）
│   ├── preload/index.ts    # contextBridge 白名单桥（window.tsumi）
│   └── renderer/src/       # Vue3 前端
│       ├── pages/          #   Library / GameEdit / Engines / Settings
│       ├── components/     #   AddGameWizard / DynamicArgsForm / GameCard / VersionManagerDialog / ...
│       ├── stores/         #   Pinia: library / engines / settings / task / coreDialogs
│       ├── api/client.ts   #   IPC 调用封装（全部类型定义，唯一类型来源）
│       └── locales/        #   zh-CN.json（所有 UI 文案集中在此）
├── scripts/
│   ├── dev.cjs             #   开发启动包装（文件入口 + 清环境变量 + NO_SANDBOX）
│   └── probe-m2.cjs        #   M2 端到端验收探针（+ probe-m2-inner.cjs）
└── test/
    ├── fixtures/           # 假游戏目录（MV/VX Ace/2000/Ren'Py）+ dlsite/RJ294126.html
    └── *.test.ts           # vitest 单测（165 个，9 个文件，不依赖网络与 GUI）
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
| **`.vue` 里 `watch(..., { immediate: true })` 会立刻调用 fill()** | 被调用的函数若引用了**后面才声明**的 ref，会撞 TDZ：`ReferenceError: Cannot access 'rjInput' before initialization`，**组件整块白屏**。实测在 `GameEditPage` 踩到。规矩：所有 ref/computed 声明必须在任何 `immediate: true` 的 watch 之前 |
| **Vite 打包后 `out/main` 的 stdout 在 Windows 会丢** | Electron 是 GUI 子系统，`console.log` 常常什么都不打印（表现为「脚本像没跑」）。验收脚本必须**同时写结果文件**；而且 `%TEMP%` 在受限会话下整体 EPERM（见上一条），结果文件要写到**项目目录内** |
| 跑 Electron 验收脚本必须带 `--no-sandbox` | 受限桌面会话下裸跑 `electron script.cjs` 直接 **exit 3 且零输出**。`scripts/dev.cjs` 与 `scripts/probe-m2.cjs` 都处理了这条；手动跑时记得加 `--no-sandbox` + `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS` |

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
- **M3（下一个）**：故障自愈（RTP 缺失、字体/乱码修复、一键修复启动）
  - 【新增】**加密发行检测与引导**（用户 2026-11-04 拍板）：识别「只有 `Game.rgss3a`/`Game.rgssad`、
    没有 `Data/Scripts.rvdata2`」的游戏，给出可操作的中文提示。
    **只做检测 + 提示 + 引导，不实现解包算法**（理由见下）。
    - `.rgss3a`/`.rgss2a`/`.rgssad` 的存在本身是强信号，可直接判为对应 RGSS 版本
    - 现在用户只会看到英文 `No script file has been specified. Check the game's INI`，
      完全不知道该怎么办——这是最低成本、最高收益的一步
    - **不代劳的原因**：rgss3a 是作者的加密发行（DRM），自动解包涉及规避技术保护措施的法律风险；
      产品应「告诉用户怎么自己处理」，把责任边界留在用户一侧
- **M4**：存档管理（集中查看/备份/导出）+ 增强（Cheat 注入/变速）
- **M5**：手柄、无边框全屏、像素缩放、dmg 公证分发

## 上游参考

- 仓库：https://github.com/m5kro/Xenolauncher ；模块仓库：https://github.com/m5kro/Xenolauncher-Modules
- 本地 clone：`_xeno_probe/`（module.js 在 `app/module.js`，IPC 范本在 `native/Backend/worker.cjs`）
- 技术分析：`docs/技术选型-三方案对比.md`
