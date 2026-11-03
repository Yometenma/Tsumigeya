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

- **阶段**：M1（中文游戏库 + 自动识别 + 一键启动）— **源码未开工**，契约已冻结
- **已完成**：
  - 仓库初始化（`git init`，首个基线提交）+ 脚手架配置（electron-vite / tsconfig / electron-builder / vitest）
  - `resources/core/module.js`（上游 fork，唯一补丁 = `services.fetch` 注入，详见 `resources/core/FORK-NOTES.md`）
  - 文档：`README.md`、`docs/技术选型-三方案对比.md`、**`docs/M1-实施方案.md`（契约冻结稿）**、`LICENSE`(GPL-3.0)
  - 本机环境：依赖已装、Electron 45.2.1 二进制已下载
- **未完成（下一会话按 `docs/M1-实施方案.md` 的 S2–S8 执行）**：
  - `src/` 全部源码：主进程五件套（index / core-host / games-store / extract / ipc）、preload 桥、Vue3 全部页面与组件
  - `test/` 全部 fixtures 与单测
  - electron-builder 打 mac 包 + GitHub Actions 工作流（M1 末尾项）
  - macOS 真机验证「启动真实游戏」— 需用户在 Mac 上执行
- **当前基线不是全绿**：`src/` 为空，`npm run typecheck` 会报 `TS18003 无输入文件`（web 侧）、`npm test` 会报无测试文件。
  这是预期状态，S2 落地第一个文件后即恢复；不要为了"绿"去改脚本或塞占位文件。
- **验证方式**：`npm run typecheck && npm test && npm run build`（Windows 本机全绿即算通过）

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
npm run dev          # 启动开发（Electron + Vite HMR，会弹窗口）
npm run build        # electron-vite 构建（out/，不打包安装包）
npm run typecheck    # TS 类型检查（node 侧 + web 侧）
npm test             # vitest 单测（不需要网络、不需要 GUI）
npm run build:win    # 出 Windows 安装包（调试 UI 用）
npm run build:mac    # 出 mac 包（Windows 上只能出 zip/dir，签名需 Mac 或 CI）
```

调试数据目录隔离：`TSUMIGEYA_DATA_DIR=D:\YomeXProjects\Tsumigeya\.dev-data npm run dev`

## 目录结构（目标结构；`src/`、`test/` 待 S2–S8 落地）

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
