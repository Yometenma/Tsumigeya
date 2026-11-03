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

- **阶段**：M1（中文游戏库 + 自动识别 + 一键启动）— **S2–S8 已完成并提交**（S1 由上一会话完成）
- **已完成**：
  - 仓库初始化（`git init`，首个基线提交）+ 脚手架配置（electron-vite / tsconfig / electron-builder / vitest）
  - `resources/core/module.js`（上游 fork，唯一补丁 = `services.fetch` 注入，详见 `resources/core/FORK-NOTES.md`）
  - 文档：`README.md`、`docs/技术选型-三方案对比.md`、**`docs/M1-实施方案.md`（契约冻结稿）**、`LICENSE`(GPL-3.0)
  - 本机环境：依赖已装、Electron 45.2.1 二进制已下载
  - **`src/main/` 五件套全部落地**：`index.ts`（窗口 / `tsmg://` / CSP / 生命周期）、`core-host.ts`（数据目录 + core 装载 + 对话框桥 + detectFolder）、`games-store.ts`（原子写 + `.bak` + 校验）、`extract.ts`（系统 bsdtar + 安全校验）、`ipc.ts`（18 条命令全表 + 串行队列 + 取消）
  - **`src/preload/index.ts`**：`window.tsumi` 全量桥（invoke / startTask / cancel / dialogReply / pickPath / pathForFile / onEvent）
  - **`src/renderer/`**：i18n + hash 路由 + App 布局 + 4 个 store（library / engines / settings / task / coreDialogs）+ 9 个组件 + 4 个页面 + `locales/zh-CN.json`（含 §3.9 全部 `error.*` 键）
  - **`test/`**：4 个 fixtures + 3 个测试文件，**67 个测试全绿**（不依赖网络、不依赖 GUI）
- **验证基线（Windows 本机实测）**：
  - `npm run typecheck` ✅ exit 0
  - `npm test` ✅ 67 passed / 3 files，~3.4 s
  - `npm run build` ✅ exit 0，产出 `out/{main,preload,renderer}`
  - **`npm run dev` ✅ 已在本机跑通**：窗口真实渲染出来（标题 `Tsumigeya`、路由 `#/library`、
    游戏库中文界面与空状态、`window.tsumi` 为 object、数据目录生成 `cache/`）。
    启动入口由 `scripts/dev.cjs` 包装，原因见「已知坑」第一条。
  - **添加游戏向导 ✅ 端到端实测通过**：手输路径框填真实 fixture 路径 → 点「识别此路径」
    → **1 秒内**显示「识别到引擎：wine（尚未安装）」+ 候选列表 + 安装按钮，组件无崩溃。
    四个路由（/library、/library/new、/engines、/settings）渲染均正常（htmlLen 3522–5307）。
- **仍未验证（必须在有桌面会话的机器上做）**：
  - 五个页面的**视觉观感**：DOM 结构与文本已验证，但暗色主题配色、间距、进度浮层动效需人眼验收。
  - **系统文件对话框的返回值**：`tsumi:pick` handler 已确认注册且被调用（实测调用后挂起＝正在等对话框），
    但「对话框真的弹出并把路径交回」需真实桌面会话确认。已加**手输路径**兜底。
  - **安装引擎**：需 mac（引擎二进制是 mac 版）。Windows 上到这一步会失败，属预期。
  - **真实启动游戏**：需 macOS。
- **已知网络现实（本机）**：`api.github.com` 通，`raw.githubusercontent.com` 直连 DNS 失败，**走系统代理（127.0.0.1:7897）返回 200**。
  Node 原生 `fetch` 不读 WinINET 系统代理，因此纯 Node 下的验收看不到远程 manifest；
  生产环境注入的 Electron `net.fetch` 继承 Chromium/系统代理，**产品路径本身是正确的**（D9）。详见「已知坑」。
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
│   │   ├── index.ts        #   窗口 / tsmg:// 协议 / 生命周期
│   │   ├── core-host.ts    #   core 单例（new Function 装载）+ 数据目录策略 + detectFolder
│   │   ├── games-store.ts  #   games.json / global-settings.json（原子写+.bak，不依赖 electron）
│   │   ├── extract.ts      #   解压服务（系统 bsdtar + 安全校验）
│   │   └── ipc.ts          #   IPC 命令表 + 串行队列 + 取消 + 对话框桥
│   ├── preload/index.ts    # contextBridge 白名单桥（window.tsumi）
│   └── renderer/src/       # Vue3 前端
│       ├── pages/          #   Library / GameEdit / Engines / Settings
│       ├── components/     #   AddGameWizard / DynamicArgsForm / GameCard / VersionManagerDialog / ...
│       ├── stores/         #   Pinia: library / engines / settings / task / coreDialogs
│       ├── api/client.ts   #   IPC 调用封装（全部类型定义，唯一类型来源）
│       └── locales/        #   zh-CN.json（所有 UI 文案集中在此）
└── test/
    ├── fixtures/           # 假游戏目录（MV/VX Ace/2000/Ren'Py）
    └── *.test.ts           # vitest 单测（games-store / detect / extract）
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
| D9 | fetch 注入 Electron `net.fetch`（走系统代理） | 国内网络环境 |
| D10 | 游戏记录 schema 与上游完全一致：`{gameTitle,gamePath,iconPath,tags,gameEngine,gameArgs}` → games.json | 双向兼容 |
| D11 | core 用「读源码 + `new Function` + `createRequire`」装载，不用 `require(corePath)` | 裸 require 会被 Vite/rollup 改写或外置，打包后必炸 |
| D12 | 取消（`tsumi:cancel`）与对话框应答（`tsumi:dialog`）**绕开串行队列** | 进队列会死锁（core 在队列里等应答） |
| D13 | git 基线只提交 配置 + 文档 + core，`src/` 由下一会话从零写 | 交接时工作区必须反映真实状态，不提交空壳 |
| D14 | **只复用上游 `module.js` 一个文件**，不复用其 UI/外壳/样式/翻译；manifest 格式、模块仓库、数据目录属于"兼容约定"而非代码复制 | 用户只要核心功能，不要整体搬运；同时也是 GPL 边界的最小化 |
| D15 | `defaultFetch` 保留 `net.fetch` 优先，但要**兜底到全局 `fetch`**（无 electron 的 `net` 时） | 纯 Node / vitest 里 `require('electron')` 返回的是可执行文件路径字符串，没有 `net`；不兜底会直接崩在 fetch 调用上 |
| D16 | 拖拽取路径用 **`webUtils.getPathForFile`**（preload 暴露 `pathForFile`），**不用 `File.path`** | Electron 32+ 已移除 `File.path`，在 Electron 45 上它恒为 `undefined`，拖拽会静默失败 |
| D17 | **不给纯 Node 侧加代理回退**（用户 2026-11-04 决定） | 生产注入的 `net.fetch` 天然继承系统代理；测试按 §6 必须不依赖网络。加代理配置会动 Settings 契约 |

## 已知坑

| 坑 | 对策 |
|---|---|
| **用「目录」入口启动 Electron 必 segfault**（`0xc0000005` / exit 139）。判定依据（本机反复验证）：同一最小项目 `electron <文件>` **100% 正常**（连续 3 次 `exit=0` + `LOAD_OK`），`electron <目录>` **100% 崩**。与是否注册协议、是否 sandbox、是否 CSP 无关；`--disable-crash-reporter / --disable-gpu-compositing / --in-process-gpu / --single-process` 全部无效。**注意：上一会话把这条误判为"环境限制、无解"，是错的** | `npm run dev` 已改为走 `scripts/dev.cjs`：强制 `ELECTRON_ENTRY=out/main/index.js`（文件入口）+ 清掉 `ELECTRON_RUN_AS_NODE`/`NODE_OPTIONS` + win32 下 `NO_SANDBOX=1`。**不要把它改回 `electron-vite dev`** |
| `electron --version` 直接崩 | 本机 shell 继承了 `ELECTRON_RUN_AS_NODE=1` 与 `NODE_OPTIONS`（指向 DSH 的 compat 注入），会让 electron.exe 以纯 Node 模式跑或直接崩。`scripts/dev.cjs` 已统一清除；手动排查时用 `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS` |
| **文件入口时 `app.getAppPath()` = `out/main`**，不是项目根 | `resolveCorePath` 不能只拼一层。已改为从 appPath + cwd 出发**向上探测 6 级**找含 `resources/core/module.js` 的根，并有 4 条回归测试锁住（`test/detect.test.ts`） |
| `env.d.ts` 里写顶层 `import` → 所有 `.vue` 报 `TS2307` | 顶层 import 让文件变成模块，`declare module '*.vue'` 不再全局。用内联 `import('./api/client').TsumiBridge` |
| Node 原生 `fetch` 不读 WinINET 系统代理 | 本机 raw.githubusercontent.com 直连 DNS 失败、走代理 200。产品侧靠 `net.fetch`（D9）自动继承；纯 Node 验收看不到远程 manifest 属正常 |
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

- **M1（进行中）**：中文游戏库 + 自动识别 + 一键安装引擎 + 启动 ← 当前
- **M2**：DLsite 元数据（RJ 号→标题/社团/封面/标签，封面墙）
- **M3**：故障自愈（RTP 缺失、字体/乱码修复、一键修复启动）
- **M4**：存档管理（集中查看/备份/导出）+ 增强（Cheat 注入/变速）
- **M5**：手柄、无边框全屏、像素缩放、dmg 公证分发

## 上游参考

- 仓库：https://github.com/m5kro/Xenolauncher ；模块仓库：https://github.com/m5kro/Xenolauncher-Modules
- 本地 clone：`_xeno_probe/`（module.js 在 `app/module.js`，IPC 范本在 `native/Backend/worker.cjs`）
- 技术分析：`docs/技术选型-三方案对比.md`
