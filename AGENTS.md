# AGENTS.md — Tsumigeya 交接文档

> **给接手的 AI/开发者**：开工前读这份就够了。契约级细节在 `docs/M1-实施方案.md`。
> **本文档只写「现在是什么」**——历史过程在 `docs/M*.md`，不在这里复述。

## 项目是什么

**Tsumigeya** — macOS 上的 DLsite 游戏启动器（RPG Maker 系为主），中文化。

- 技术栈：Electron 45 + Vue3 + TS（electron-vite）+ Pinia + Element Plus + vue-i18n（zh-CN 单语言）
- 开发机 Windows，**目标平台 macOS（arm64/x86_64）**
- 核心链路：添加游戏 → 按文件结构自动识别引擎 → 未装引擎一键安装 → 调原生播放器启动

**零上游**：M4.2 删掉了最后一处上游代码（`resources/core/module.js`，D63）。
`resources/core/` 只剩 `FORK-NOTES.md`（GPL 来源说明 + 历史补丁登记）。
有测试守着它不会偷偷回来（`test/no-upstream-module.test.ts`）。

## 当前状态

- **已完成**：M1（游戏库/识别/装引擎/启动）、M2（DLsite 元数据）、M2.5（搜索/可编辑元数据/多语言）、
  M3（故障自愈）、M2.6（海报墙与详情页）、M2.7（编辑页重构）、M3.5（进程管理）、M4.0（自实现启动）、
  M4.1（引擎清单自己维护）、**M4.2（彻底零上游）**、**M5.5（动态图标 / Lucide 图标体系）**、
  **M6.5（引擎范围扩展：4 → 9 个）**
- **已发布**：**v1.1.0** —— 引擎 4 → 9 个（见 `docs/release-v1.1.0.md`）；
  上一版 v1.0.0 是第一个正式版。GitHub `Yometenma/Tsumigeya`
- **测试**：**1592 个 / 79 文件**全绿；`typecheck` / `test` / `build` 三绿
  - 新增 `test/icon-assets.test.ts`（6 条）：应用图标资产守卫
- **Swift 原生版（P0–P2 已完成，见 `docs/M7-P0P2-实施记录.md`）**：`mac-native/` SwiftPM 包，**84→112 条 Swift 测试**全绿
  - 在 Mac 上 `open ~/Tsumigeya-Native/Package.swift` 就能用 Xcode 打开看
  - ⚠️ **Windows 上编译不了**，只能 ssh 到 Mac 跑
  - ⚠️ **已在 mac 真机验证**（`YomedeMacBook-Neo` / macOS 26.6.2 / arm64）：
    故意 `env -u LANG` 复现故障条件后 1587 条全绿；GUI 探针（`scripts/probe-engine-page.cjs`）
    9 张卡片 / 两种警告标签 / 零 console 错误全部通过
  - ⚠️ **5 个新引擎仍未在任何真实游戏上验证启动**（tyrano/nscripter/siglus/godot
    + 吉里吉里另有上游限制）→ 引擎页标「未验证」/「上游限制」（D91/D92）
- **M5.0 已完成**（`docs/M5.0-实施方案.md`）：12 项体验优化 + **S12 分类迁移**，逐条提交（用户拍板）
  - 顺序见方案 §12：B1 版本号 → U3+U4 筛选 → U5 选文件 → U6 去跳过 → N1 游玩时间
    → U1 批量 → U2 分类 → U10 全部安装 → U9 设置页 → U7 抽组件 → U8 编辑页重构
  - **B2（VX Ace 打不开）已在 v0.5.3 修复**，不在本轮范围
  - ✅ **S1 / B1 已提交**：版本号改为构建期 `define` 注入（`__APP_VERSION__`）
  - ✅ **S2 / U3+U4 已提交**：删「按标签筛选」；「只看有封面」→「只看未绑定」
    （判据抽到 `shared/library-filter.ts`，24 条单测）
  - ✅ **S3 / U5 已提交**：去掉「选择文件夹」，只留选文件 + 逐层上退兜底
    （判据抽到 `shared/import-target.ts`，29 条单测）
  - ✅ **S4 / U6 已提交**：删「跳过，稍后安装」；识别成功后也能手动改引擎
    （判据抽到 `shared/wizard-engine.ts`，14 条单测）
  - ✅ **S5 / N1 已提交**：详情页启动按钮下方加游玩时间统计
    （判据抽到 `shared/play-time.ts`，17 条单测 + snapshot 端到端 4 条）
  - ✅ **S6 / U1 已提交**：库页批量模式（多选 + 批量删除 + 逐个进度）
    （判据抽到 `shared/bulk-select.ts`，22 条单测；**顺带修掉删游戏不清 play-stats 的真 bug**）
  - ✅ **S7 / U2 已提交**：自定义分类（多归属 / 扁平）：数据层 + 批量归入
    （判据抽到 `shared/categories.ts`，46 条单测；**修掉删游戏不清分类归属的真 bug**）
    ⚠️ 当时分类放在**侧边栏**，S12 已搬到库页顶部（见下条 / D84）
  - ✅ **S8 / U10 已提交**：引擎页「可安装」加「全部安装」（与「全部更新」对称）
    （判据抽到 `shared/install-all.ts`，20 条单测）
  - ✅ **S9 / U9 已提交**：设置页分组化（5 组可折叠）
    （分组定义抽到 `shared/settings-groups.ts`，24 条单测含**源码级核对**「每个 Settings 字段恰好归一次」）
  - ✅ **S10 / U7 已提交**：抽 `GameInfoForm.vue`，向导第 3 步**复用编辑页组件**
    （bound/staged 双模式判据抽到 `shared/gameinfo-form.ts`，26 条单测）
  - ✅ **S11 / U8 已提交**：编辑页重构（保存合一 + 区块重排 + 折叠 + **拆 5 文件**）
    （`GameEditPage.vue` 1109 → 295 行；新增 `test/vue-handler-exists.test.ts` 守模板-脚本一致性）
  - ✅ **S12 / U2 迁移已提交**：分类**从侧边栏搬到库页顶部**的横向筛选栏（用户 2026-11-05 拍板）
    （新组件 `components/CategoryFilterBar.vue`；侧边栏只留导航；`sidebar-collapse.ts` 的
    `'categories'` 已删，有反向判据守着；判据 `test/category-filter-bar.test.ts`）
  - **M5.0 全部 12 步已完成**（S1–S12），随 v0.6.2 发布

### 各模块在哪（一句话）

| 模块 | 文件 | 关键点 |
|---|---|---|
| 引擎定义 | `src/main/engines/registry.ts` | **9 个引擎唯一来源**（D60/D87/D91）；另有 `DETECT_ONLY`（**只认不跑**，D88）；ruffle/wine/macos 不存在 |
| 引擎清单读写 | `src/main/engines/manifest.ts` | 读本地 manifest + 合并 gameArgs 缺省值（M4.2） |
| 引擎识别 | `src/main/engines/detect.ts` | 打分算法**只有一份**；R1：`.app` 包与子目录；`definitionsWithDetectOnly()` 合并两张表 |
| 版本比较 | `src/main/engines/semver.ts` | `compareVersions` / `hasUpdate`（M4.2 自实现） |
| 装/更新/卸载 | `src/main/engines/install.ts` | `updateEngine` 保住多版本依赖（D66） |
| 启动 | `src/main/launchers/` | `buildLaunchPlan` + `spawn.ts`（唯一起进程处，D55 三件套） |
| 诊断 | `src/main/diagnose.ts` | 纯本地特征，不调 mkxp-z（D32） |
| 进程表 | `src/main/process-registry.ts` | 只在内存（D50）；`stopGame` 两段式（D52） |
| 游玩记录 | `src/main/play-stats.ts` | 独立 `play-stats.json`（D51） |
| IPC | `src/main/ipc.ts` | 单 channel + 串行队列；只读命令走 `OFF_QUEUE_METHODS` |
| 库页筛选 | `src/shared/library-filter.ts` | 纯函数（搜索 + 只看未绑定）；判据有单测，别在 store 里重写 |
| 选文件反推目录 | `src/shared/import-target.ts` | 只选文件后逐层上退（上限 2 层）；向导与编辑页**共用**这一份判据 |
| 向导改引擎 | `src/shared/wizard-engine.ts` | 下拉选项来源 + 第 2 步放行判据；装失败也放行（断网不能卡死） |
| 游玩时间展示 | `src/shared/play-time.ts` | 时长分级 + 「无记录」vs「0 秒」的区分；`snapshot.playStats` 供详情页读 |
| 批量选择/确认 | `src/shared/bulk-select.ts` | 选中集∩可见集（防误删）；确认弹窗列前 3 + 等 N；三态全选 |
| 自定义分类 | `src/main/category-store.ts` + `src/shared/categories.ts` | **分离式存储**（顶层 categories/assignments，不改条目形状）；删分类绝不删游戏 |
| **分类筛选栏** | `src/renderer/src/components/CategoryFilterBar.vue` | **M5.0 S12 从侧边栏搬来**（用户拍板）：横向 chip「全部 / 未分类 / 动作类…」，分类多了换行不横向滚动。侧边栏只留导航 |
| 全部安装编排 | `src/shared/install-all.ts` | **失败不中断**（与 `updateAllEngines` 的 throw 策略刻意不同）；逐个 + 进度 |
| 设置页分组 | `src/shared/settings-groups.ts` | 分组是**数据**；`SETTINGS_KEYS` + 源码级核对防「搬家漏项」；`BOOL_DEFAULTS` 是主进程镜像（有测试对齐） |
| 游戏信息表单 | `src/renderer/src/components/GameInfoForm.vue` + `src/shared/gameinfo-form.ts` | **编辑页与向导共用**；`bound`（有 id，立刻落盘）/ `staged`（没 id，暂存到游戏保存后提交）。编辑页用 staged 实现「全页一个保存」 |
| 编辑页容器 | `src/renderer/src/pages/GameEditPage.vue`（295 行） | 只做路由/保存/表单状态；区块拆成 `GameLocalSection` / `GameTagsSection` / `GameEngineArgsSection` / `GameDiagnosisSection` /（`GameInfoForm`） |
| **图标数据**（M5.5） | `src/shared/icon-nodes.ts` | **图标几何的唯一来源**（12 个图标）。`ICON_NODES` + `MORPH_PAIRS` + `morphIcon()`。手抄 Lucide 常量，有测试与包内真实数据**逐字节**比对（包一升级就红） |
| **图标渲染**（M5.5） | `src/renderer/src/components/AppIcon.vue` | 收口所有图标渲染。`<AppIcon name="Ellipsis" />` = 静态；`<AppIcon :icon="数据" />` = 走 morph。**弹簧与 stroke 默认值在这里**（`SPRING` / `strokeWidth`） |
| **侧边栏折叠**（M5.5） | `src/shared/sidebar-collapse.ts` + `SidebarToggle.vue` | 折叠态**只在内存**（不落盘）；判据是「折叠时哪些块收起」（漏一个会溢出且不报错）；宽度 208↔56 |
| **存档探测**（M4 S1） | `src/shared/save-locate.ts` + `src/main/save-store.ts` | 判据是纯函数（**按后缀判，不按目录名猜**）；**nwjs 的存档位置由 `package.json` 的 `main` 决定**（D85）：`main` 在 `www/index.html` → `www/save/`，在根 → `save/`。**绝不按「哪个目录有 `.rpgsave`」判**（作者塞进包里的残留档会骗过它）。`location:null`（不知道在哪）与 `empty:true`（还没存档）是两件事 |
| **存档展示**（M4 S2） | `src/shared/save-view.ts` + `SaveSection.vue` | `saveSectionView()` → `unknown` / `empty` / `list` 三态（前两者**必须分开**）；`formatByteSize` 是 1024 进制确定性输出；槽与配置分开列 |
| **存档导出/导入**（M4 S3/S4） | `src/shared/save-archive.ts` + `src/main/save-archive-io.ts` | 打**整个目录**（含 `lastsave.autobak` 这类插件文件）；导入顺序**先校验 sha256 → 再备份 → 才写**；`exportBlocked()` 运行中禁止导出。zip 用 `fflate`（纯 JS，零原生依赖） |
| **同步占位**（M4 S5） | `src/shared/save-sync.ts` | **只留接口不实现**（`SaveSyncProvider` 无实现类）；源码里**禁止出现任何网络能力**（有源码级测试守着）；模式只有 `none` / `manual` |
| **应用图标**（App 图标，非 UI 图标） | `build/` + `scripts/make-icon.py` | 从 `build/icon-source.jpg` **像素复刻**（不是缩放）→ `icon_1024.png` 母版 → 生成 icns(11档)/ico(7档)/png。**换图标 = 换源图重跑脚本**，别手改生成物。`test/icon-assets.test.ts` 守资产存在与 icns 档位 |

## 开发命令

```bash
npm run dev        # 走 scripts/dev.cjs（文件入口 + 清 ELECTRON_RUN_AS_NODE + NO_SANDBOX）
npm run typecheck  # TS 检查（node 侧 + web 侧）
npm test           # vitest（不依赖网络、不需要 GUI）
npm run build      # 构建 out/，不打包安装包
npm run build:mac  # 出 mac 包（Windows 上只能 zip/dir；正式包走 CI）
```

数据目录隔离：`TSUMIGEYA_DATA_DIR=D:\YomeXProjects\Tsumigeya\.dev-data npm run dev`

**目录卫生**（2026-11-05 清过第二轮，本轮清理记在下面）：
- `scripts/` 只剩 `dev.cjs`（`npm run dev` 用）与 `after-pack.cjs`（electron-builder 用）。
  **历史里程碑的 `probe-*.cjs` 已全删** —— 验收都做过，留着是纯历史包袱。
- `docs/archive/` 放已失效的历史材料。**别删**：完成里程碑的文档还在引用它们。
- `.gitignore` 用通配 `.dev-data-*/` 与 `.dev-*probe.json`，不再一个里程碑加一条。
- **删过 `backend/`（61 文件）**：整份 `src/` 的旧副本，在 `8fcf00f` 被误提交，零引用。
  教训：**提交前看 `git status` 里有没有不该在的大块新增**；一次"只改 AGENTS.md"的提交
  带进了 61 个文件，两个月没人发现。
- **删过 `_xeno_probe/`（2.0M）**：上游考古 clone，未追踪。需要时从两个 GitHub URL 重新 clone。
- **删过 15 个零引用 i18n key** + 立了守卫 `test/i18n-keys.test.ts`（双向：
  死 key 不许堆积 / 动态拼接的 key 不许被当垃圾删 —— 后者本鱼差点误删）。
- 本机目录（`.dev-data*` / `.dev-scratch` / `.verify-dist` / `dist` / `*.tsbuildinfo`）
  都在 `.gitignore` 里，不入库；`dist/` 是打包产物，`*.tsbuildinfo` 是构建缓存，删了会重生成。
- **docs 精简过一轮**（2026-11-05，5421 → 4300 行）：
  · 删掉「纯流水账」章节：`实施顺序` / `文件清单`（**个别除外，见下**）/ `测试计划` /
    `风险与待实测` / `待用户确认` / `确认清单` / `实施结果` / `与计划的偏差` / `变更记录`。
    这些的共同点：**写完就失效**（步骤早执行完、测试数早变了、拍板早拍过了）。
  · 删掉两份零引用调研文档（`竞品功能对照表` / `技术选型-三方案对比`）——
    结论已落成 D1 / D60，留着是决策过程的复读。
  · ⚠️ **`M1-实施方案.md §4`（文件清单）是个例外，不许删**：它的每行都带「关键点」，
    而且 `src/main/extract.ts` / `index.ts` 的注释把 `§4` 当契约索引引用。
    本鱼删过一次 → 断链 → 已恢复。
  · 守卫：`test/docs-references.test.ts`（18 处「文档 + §章节号」引用必须真实存在，
    反向后删任何被引用的章节会当场红）。

## 架构（30 秒）

```
Vue → Pinia → api/client → preload(window.tsumi.invoke)
  → ipcMain('tsumi:invoke') → 串行队列 → ipc 处理器或 games-store
  → 结果返回；进度/对话框经 'tsumi:event' 推回渲染进程
```

> M4.2 之前这里是「→ core（module.js）或 games-store」。`core` 那层已经不存在了：
> 引擎相关的一切现在在 `src/main/engines/`（见上表）。

- **数据目录**：macOS `~/Library/Application Support/Tsumigeya`（D58；**不迁移旧 `Xenolauncher`**）
- **引擎 = 目录**：`<数据目录>/modules/<引擎>/`（`manifest.json` 由我们生成，D62）
- **旁挂存储**：`games.json`（上游 schema，D10）/ `library-meta.json` / `play-stats.json` 各自独立

## 已知坑（全踩过，按命中率排序）

### Vue / i18n（最容易白屏）

| 坑 | 对策 |
|---|---|
| **i18n 写 ICU 语法 → 整块组件消失**（只报 `SyntaxError: 2` 到 console） | 只允许 `{simpleIdentifier}`；复数用 computed 拼 |
| **模板里写 TS 类型断言 → 白屏** | 模板只写运行时代码，断言进 `<script setup>` |
| **模板里写复杂表达式 → 难断言也易白屏** | 复杂逻辑放 computed，模板只读一个值 |
| **`.vue` 的 `watch({immediate:true})` 引用了后声明的 ref → TDZ 白屏** | 所有 ref/computed 必须在 immediate watch 之前 |
| **SFC 里 `</template>` 不止一个**（`<template #title>` 具名插槽） | 用 `lastIndexOf` 取最后一个闭合；用 match 取第一个会提前截断 → 扫模板的测试**假绿**（S11 实测踩到） |
| **响应式 Proxy 传给 IPC → `An object could not be cloned.`** | 走 store 层统一 `toPlain()`（D44）；**逐字段拷贝会漏** |
| `el-dropdown-item` 的 `aria-disabled` 是**字符串** `"false"` | 判据用 `=== 'true'`，别用 `!!getAttribute()` |
| `settings-row` 塞 array 编辑块 → 布局错乱 | `DynamicArgsForm` 把它放 `settings-row` 外面 |
| **`v-if`/`v-else` 两个容器各放一个 morph 图标 → 变形静默失效** | 状态一变就销毁旧组件、新建新的，MorphIcon 的实例没了 → 只看到硬切（**不报错、不警告**）。必须**合成一个实例**：一个 button、只换 `:type`/`:size`/`@click`，或外层 div 常驻只换 class。M5.5 踩了两次（侧边栏折叠按钮、详情页启动/停止），探针实测 `d` 属性不变才发现 |
| **探针用 `show:false` 的窗口验 morph → 永远读到"没变"** | Chromium 在隐藏窗口里**暂停 rAF**，而 morphicons 全靠 1 个 rAF 驱动。探针要 `show:true` + `backgroundThrottling:false`，并先自检 `rafAlive`（M5.5 被这个假阴性坑过一次） |

### 主进程 / Electron

| 坑 | 对策 |
|---|---|
| **用「目录」入口启动 Electron 必 segfault**（exit 139） | `npm run dev` 走 `scripts/dev.cjs`（文件入口）。**别改回 `electron-vite dev`** |
| `electron --version` 直接崩 | 清 `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS` |
| **顶层 `app.setName()` → 直接 segfault** | 数据目录用 `resolveDataDirWithFallback()` 显式决定 |
| 文件入口下 `getPath('userData')` = `%APPDATA%\Electron` | 不要传给 `resolveDataDir` |
| **`net.fetch` 不自动走系统代理** | 必须 `session.setProxy({ mode:'system' })`（D9）。症状：浏览器能上网、引擎下载报连接关闭 |
| 主进程没注入 `fetchImpl` → 静默降级全局 fetch | `index.ts` 必须显式传 `net.fetch` |
| **whenReady 里抛错 = 窗口永不出现，用户看不到原因** | 启动链上的可预期失败必须降级 + 告知 |
| **`process.env.npm_package_version` 只在 `npm run` 起的进程里存在** | 打包成 .app 由 Finder 启动时消失 → 版本号恒 `v0.0.0`（B1）。版本号一律走构建期 `define`：`electron.vite.config.ts` 注入 `__APP_VERSION__`，preload 从 `src/preload/app-version.ts` 读。**preload 是同步暴露的，拿不到 `app.getVersion()`**（有测试守着，见 `test/app-version.test.ts`） |
| **`failure()` 返回的 Error 没有 `code`** | 要分支就显式补 `code`，别靠 `err.code` 猜 |
| **mkxp-z 的两个非 ASCII 陷阱**（mac 实测） | ① `mkxp.json` 里含非 ASCII 路径 → 编码嗅探判失败 → 回落 XP → 弹「No script file」；② `Game.ini` 的 `Title=` 是 GBK → **整份 ini 读不出**。处置见 D71/D72。**别写 \uXXXX 转义** —— 它会 crash |
| **这份 mkxp-z 只读 app 包内那份 mkxp.json，不看 cwd** | 别再把配置改到游戏目录（v0.5.2 错了）。判据：删掉 Game.ini、cwd 换纯 ASCII 目录，它照旧报同一句 → 证明没读 cwd |
| **解压后拍平单层目录会打掉 nwjs 的版本目录** | 默认**保留**单层（与上游一致）；只有 `keepSingleDir:false` 才拍。**别用「目录名 ≠ 依赖名」当判据** —— D69 |
| **`spawn` 对「文件不存在」是异步报错** | 同步返回 child（`pid=undefined`），`error` 事件才到。**必须挂 `error` 监听**，否则崩主进程 |
| `fs.accessSync('ping')` 对裸命令名必失败 | 预检只在 `path.isAbsolute()` 时做 |
| Windows `%APPDATA%`/`%TEMP%` 可能整体 EPERM | `resolveDataDirWithFallback` 三级降级 + dialog 告知 |

### 队列 / 性能

| 坑 | 对策 |
|---|---|
| **串行队列被启动更新检查堵死**（最长 60s） | `detect`/`detectFolder`/`snapshot`/`versions` 走旁路；新增只读命令考虑加 `OFF_QUEUE_METHODS` |

### 文件格式 / 编码

| 坑 | 对策 |
|---|---|
| **`Game.ini` 是 GBK/Shift-JIS，不是 UTF-8** | `readGameIni()` 只按 `latin1` 读 `[Game]` 的 ASCII 结构行；**绝不用 `Title=`** |
| **XP 的 RTP 目录名是 `Standard` 不是 `RPGXP`** | 实测 `RTP.zip` 只有 `Standard`/`RPGVX`/`RPGVXAce`（D59）。错映射 → XP 永久判「RTP 缺失」 |
| RTP 名大小写：`RPGVXace` vs `Game.ini` 的 `RPGVXAce` | `normalizeRtpName()` + 查不到时 `findCaseInsensitive()`。**CI 是 Linux（大小写敏感）** |
| 解压依赖时**默认保留**单层目录（别拍平） | 盲目拍平会吞掉 `nwjs-sdk-…/` 版本目录 → 二进制路径差一层 → 启动失败（D69） |
| 路径上的 `tar` 在 Windows 是 GNU tar | 单测用 `C:\Windows\System32\tar.exe`（bsdtar） |
| `tarBinary()` 必须有 Linux 分支 | darwin→`/usr/bin/tar`、win32→System32、其余→PATH |
| **⚠️ mac 的 bsdtar 在 `LANG` 为空时把非 ASCII 文件名输出成八进制转义** | `./\344\270\255...txt` 而不是 `./中文.txt`，于是被 `assertSafeEntry` 的「拒绝反斜杠」判成路径穿越 → **含中文名的包整包被拒**。**触发条件极隐蔽**：SSH / launchctl / Finder 启动的 .app 里 `LANG` 常常为空（终端手跑反而正常）。处置：`extract.ts` 的 `tarEnv()` 在 darwin 上显式给 `LANG/LC_ALL=en_US.UTF-8`。**别去放行那条反斜杠规则**（那是安全判据）。mac 真机 `env -u LANG` 复现过，修复后全绿 |
| **⚠️ `LC_ALL` 优先级高于 `LANG`，所以「尊重用户 locale」是错的** | 实测（2026-11-06，同一台 mac / 同一个含中文名的 tar）：`LANG=en_US.UTF-8`（无 LC_ALL）→ `中文.txt` ✅；`LANG=en_US.UTF-8` + **`LC_ALL=C`** → `ä¸­...` ❌；`LANG=en_US.UTF-8` + **`LC_CTYPE=C`** → 同样 ❌。原实现写的是 `LC_ALL: process.env.LC_ALL || 'en_US.UTF-8'`（**尊重外部值**）→ 被外部 `C` 盖掉 → 八进制转义 → 被「拒绝反斜杠」判成路径穿越 → **整包被拒**。而 `LC_ALL=C` 在 SSH / launchctl / Finder 启动的 .app 里都会出现。处置：`LANG` / `LC_ALL` / `LC_CTYPE` **三个一律无条件覆盖**（这是给我们自己解析的中间结果，不是给用户读的文本）。**发现途径值得记**：是写 Swift 版时子代理查 POSIX 规范才回头看见 Electron 版也有这个洞 —— 典型的「两套并存的代价」（D95） |

### 落盘白名单（改字段必看）

| 坑 | 对策 |
|---|---|
| **给 `GameMeta` 加字段必须同步改 `library-meta.ts` 的 `sanitize()`** | 它是落盘白名单，漏了会**静默丢弃**；改完先看 `saveGameMeta` 的返回键集 |
| **向导里 DLsite 元数据没有 gameId 可挂** | 原实现只能弹 `error.dlsiteGameRequired`（"先保存游戏"）—— 那正是 U7 要消灭的割裂。`GameInfoForm` 的 **staged 模式**把动作收在内存，`finish()` 在 `saveGame` 之后一起提交。**顺序不能反** |
| **模板里的 `@click="xxx"` 指向不存在的函数 → 点了没反应** | tsc / build / 单测**全部放过**（模板里的标识符是字符串）。S10 曾因此把 `save`/`goBack` 删掉、保存按钮变死键。`test/vue-handler-exists.test.ts` 会红 |
| **设置页的分组漏项不报错** | 只看"页面能渲染"永远发现不了；`shared/settings-groups.ts` 的 `missingSettings()` + 一条扫 `client.ts` 的源码级测试会红 |
| **`DEFAULT_SETTINGS` 不是全部默认值的来源** | `languageSwitchPrompt` / `diagnoseBeforeLaunch` 用的是 `saved.x === false ? false : true`（不在那个常量里）。渲染层的 `BOOL_DEFAULTS` 是镜像，有测试逐项对齐 |
| **`library-meta.json` 现在有非游戏顶层键**（`categories` / `assignments`） | ① `load()` 必须按「键是纯数字」过滤，否则 `categories` 会被当成一个游戏；② `save()`/`remove()` 是**整体覆写**，写回前必须把非数字键带回去，否则一次改 DLsite 信息就把分类全抹了 |
| **删游戏要清四处旁挂数据**：`games.json` / `library-meta` / `play-stats` / **`assignments`（分类归属）** | 漏掉后两项会在 id 复用时**把上一个游戏的游玩历史/分类安到新游戏头上**（saveGame 的 `Math.max(...)+1` 容易落回刚删的号）。回归：`test/delete-cleanup.test.ts` / `test/category-ipc.test.ts` |

### 存档（M4，四条全是"看起来成功了"）

| 坑 | 对策 |
|---|---|
| **`location:null` 与 `empty:true` 被糊成一句** | 前者是**故障**（不知道在哪，用户该去排障），后者是**正常**（还没存过档，该去玩到存档点）。糊了不会崩溃，只会让用户**永远查不出问题**。判据 `shared/save-view.ts` 的 `saveSectionView()`（18 条单测），别在模板里判 |
| **导出只打槽 → 用户换机后少东西** | 真机实测存档目录里有 `lastsave.autobak` / `sync_data.rpgsave`（**插件写的**）。必须打**整个目录**（D81）。判断"够了没"的标准不是"槽都在"，而是"目录里每一个文件都在" |
| **导入先写后备份**（或忘了备份） | 顺序**必须**是「校验 sha256 → 备份 `<原名>.tsumigeya-bak` → 才写」。写与备份的交界处出事（磁盘满/断电），先备份的最坏结果只是"没导进来"；先写的最坏结果是**半新半旧，既不能玩也不能回退**。**备份幂等**：已有备份不覆盖（否则第二次导入会把真存档盖成"导入后的版本"） |
| **"判据写了、测了、但没人调用"** | S5 实测踩到：`showsManualButtons` 写完 + 3 条单测全绿，`SaveSection.vue` 里根本没接 —— **测试全绿，功能等于没写**。判据的价值只在被调用时存在。补源码级测试：组件必须引用它、两个按钮都要带 `v-if="showManualButtons"` |
| **i18n 键既是标题又是命名空间** | 第一版写 `settings.saveSync.<mode>`，而 `saveSync` 本身是那一行的**标题**（字符串）→ JSON 重复键 → 渲染出 `[object Object]`。改成 `saveSyncModes.<mode>` + 一条**逐个核对键真的存在于 locales** 的测试（vue-i18n 查不到时会**原样画出 key 原文**，不报错） |

### 验收探针（本机无画面时）

| 坑 | 对策 |
|---|---|
| **Vite 打包后 `out/main` 的 stdout 在 Windows 会丢** | 结果必须写**项目目录内**的文件（`%TEMP%` 可能 EPERM） |
| 跑 Electron 探针必须 `--no-sandbox` | 否则 exit 3 且零输出 |
| **验收 UI 必须走 Pinia store** | 直接 `invoke` 只改主进程的表，DOM 一动不动 |
| 假「游戏进程」不能用 `process.execPath -e` | 那是 Electron 的 execPath，立刻退出。用 `ping -n 120`（win）/ `sleep 120` |
| `executeJavaScript` 里不能写顶层 `await` | 包成 `(async () => {...})()` |
| heredoc 写含反斜杠的文件会把 `\\` 吃掉一层 | 用 write 工具写，别用 `bash << 'EOF'` |
| 注释里写出块注释定界符的字面形式 → 提前闭合 | 用「行注释与块注释」这种措辞描述 |

## 协作规矩

1. **开工前读**：本文 → `docs/M1-实施方案.md`（契约）→ 对应里程碑的 `docs/M*.md`
2. **UI 文案进 `locales/zh-CN.json`**，不硬编码中文
3. **改 IPC 三处同步**：`ipc.ts`（实现）/ `preload/index.ts`（桥）/ `api/client.ts`（类型）
4. **新决策写进下节表**，并在 `docs/` 落记录
5. **收尾三件事**：typecheck + test + build 全绿 → 更新本文档 → 中文 commit
6. **不提交** `node_modules/ out/ dist/ *.tsbuildinfo`
7. **不要提前写「已完成」**：只记录实际提交过的东西

## 已定决策（只列仍有效的）

> 作废的（D2 GPL 复用、D3 共享数据目录、D5/D11/D14 module.js 相关、D13 git 基线、D48/D49 exec 注入）
> 已随 M4.0/M4.1 删掉实现，不再列——需要考古去 `docs/M*.md`。

| # | 决策 | 原因 |
|---|---|---|
| D1 | Electron + Vue3 | Windows 本机可开发调试 |
| D4 | Windows 数据目录 `%APPDATA%/tsumigeya`；`TSUMIGEYA_DATA_DIR` 优先 | 干净隔离 |
| D7 | IPC 队列/原子写/回滚参考上游 `worker.cjs`（**只参考设计，非复制代码**） | 那份设计质量高 |
| D8 | 图片走 `tsmg://` 自定义协议（扩展名白名单） | contextIsolation 安全实践 |
| D9 | `session.setProxy({ mode:'system' })` | `net.fetch` 不自动读系统代理 |
| D10 | `GameRecord` schema 与上游兼容 | 双向兼容 |
| D12 | 取消与对话框应答**绕开队列** | 进队列会死锁 |
| D15 | `defaultFetch` 兜底到全局 `fetch` | 纯 Node 里 electron 无 `net` |
| D16 | 拖拽用 `webUtils.getPathForFile` | Electron 32+ 已移除 `File.path` |
| D17 | 不给纯 Node 侧加代理回退 | 代理交给主进程 session |
| D18 | DLsite 元数据**旁挂** `library-meta.json` | 删了游戏照样能启动 |
| D19 | 只解析 `var contents` JSON；**标签/genre 不做** | 实测接口不可用 |
| D20 | 元数据只在主进程抓；CSP 只加 `img-src` | 最小攻击面 |
| D21 | `dlsiteLookup`/`dlsiteDetectRJ` 绕队列（名单有测试锁） | 防堵队列 |
| D22 | 封面 host 必须 ∈ `img.dlsite.jp` | 外部数据不可信 |
| D23 | 搜索解析优先结构化锚点 `data-list_item_product_id` | 纯 href 正则会把按钮文案当标题 |
| D24 | 搜索只取第一页 20 条，**绝不自动选第一条** | 实测首条常不是目标作品 |
| D25 | 可编辑字段**不含 `rj`** | 改 RJ 等于换作品 |
| D26 | `editedFields` + `mergeWork`：被编辑字段刷新不覆盖 | 用户手改的值属于用户 |
| D27 | 多语言偏好与 DLsite 无关，纯本地判断 | 不同语言版是独立 RJ |
| D28 | 多语言分组**必须**加 `isSuffixExtension` 防线 | 实测续作相似度 0.833 > 阈值 |
| D29 | 允许父目录推断为 ja（极保守） | 用户真实布局如此 |
| D30 | 「不再询问」做设置页开关，不做对话框勾选 | 勾了就找不回来 |
| D31 | 绝不自动删/隐藏其他语言版 | 那是用户数据 |
| D32 | 诊断只用本地文件特征 | 报错文本不稳定且英文 |
| D33 | 归档魔数版本优先于 DLL 扫描 | 魔数是归档自己的声明 |
| D34 | **加密发行不自动解包**，只提示+引导 | DRM 法律风险 |
| D35 | `fontSub` 只提示不修 | 它是替换映射，不是目录加载器 |
| D36 | `launch` 有 fatal 诊断时返回结构化结果**不抛错** | 诊断框要多条带 level/fix；也躲开跨边界丢属性 |
| D37 | 「还是启动试试」只对非 fatal 可见，且带 `diagnose:false` | 否则绕过按钮等于摆设 |
| D38 | `missingRtp` 是 warning；补装走自实现 `installDependencies` | 核心 API 只更新已装依赖，从没装过的它不下却报成功 |
| D39 | 卡片封面 4:3 横版 | DLsite 源图是横向，2:3 会裁掉 40% |
| D40 | 标签/制作人员不建空字段，UI 明说「DLsite 不提供」 | 空字段会让下个会话误判「实现了没数据」 |
| D41 | 启动按钮只在详情页 | 卡片是浏览入口，不是操作面 |
| D42 | `mergeWork`：搜索页专有字段（author/salesCount/rating）incoming 缺失时沿用旧值 | 详情页重拉天然拿不到 |
| D43 | 卡片/详情页取值降级抽到 `shared/gamecard-info.ts` | 画错不报错，只能靠单测钉 |
| D44 | 过 contextBridge 一律走 store 层 `toPlain()` | 逐字段拷贝踩了两次 |
| D45 | 图标折叠为「高级」，与封面合并成「封面预览」 | 让用户看清卡片究竟显示哪张 |
| D46 | 标题不改存储，只做来源提示 + 快捷按钮 | 自动改会写进上游 schema |
| D47 | 标签必须保留，并说明「DLsite 不提供」 | DLsite 拿不到 genre，这是唯一来源 |
| D50 | 进程状态只在内存 | 落盘会产生「显示在跑其实早没了」 |
| D51 | 游玩记录独立 `play-stats.json` | 不放 GameRecord（守 D10），语义也不同于元数据 |
| D52 | `stopGame` SIGTERM → 5s → SIGKILL | 温和优先，卡死也能救 |
| D53 | 自实现启动，不用上游 launcher | 上游 99% 是附加功能（含**改写用户游戏文件**） |
| D54 | `spawn(binary, args[])` 而非拼命令行字符串 | args 数组天然免转义 |
| D55 | spawn 必须 `detached` + `stdio:'ignore'` + `unref()` | 缺一个，关掉 Tsumigeya 会把游戏一起杀掉（有测试锁） |
| D56 | 引擎路径集中在 `launchers/binary-paths.ts` | 上游改路径只改一处 |
| D57 | **未知引擎不回退上游 launcher**，明确报错 | ruffle/wine/macos 用户不需要；回退那条路会改游戏文件 |
| D58 | 数据目录切到 `Tsumigeya`，**不迁移旧目录** | 迁移要写旧目录名（与「摆脱上游」冲突），且搬不动存档本体 |
| D59 | XP 的 RTP 目录名是 `Standard` 不是 `RPGXP` | 实测为真，错映射导致 XP 永久缺 RTP |
| D60 | 引擎清单自己维护（4 个硬编码），**不再拉上游 manifest** | 过滤/隐藏是障眼法，从源头删才是真删 |
| D61 | 参数表单大幅精简（nwjs 1 / mkxpz 10 / easyrpg 6 / renpy 2） | 砍的是渲染微调与调试参数，不写就用引擎默认值 |
| D62 | 安装时从 registry **生成** `manifest.json`（字段名兼容上游） | 没有远程 manifest 后必须自己写 |
| D63 | **删 `resources/core/module.js`**，18 个 API 全自实现或删除；`FORK-NOTES.md` 保留作历史记录 | 用户明确要「彻底摆脱」。M4.0/M4.1 已砍一半，留着 1911 行等于半途而废 |
| D64 | 「检查依赖更新」**删除**；「检查引擎更新」降级为「本地 vs registry 版本」 | 不再有远端清单，依赖更新检查没有比较对象 |
| D65 | `deleteWithEngine` **删除**，删游戏直接走 `store.removeGame` | 它调模块里的 `postdelete.js`，而我们生成的 manifest 不含该文件 → 现在等于空操作，且钩子抛错会拦住删游戏（是 bug） |
| D66 | `updateEngine` 的多版本保留用「识别 `version/` 前缀 + 原样搬回」，不重写上游那套临时目录流转 | 引擎只有 4 个，多版本只有 nwjs 一种形态；简化实现 + 3 条不变量测试足够 |
| D67 | `dependencyUpdate` 字段**保留但恒 false**；渲染层的「依赖可更新」徽标与「更新依赖」按钮**删除** | 一个恒 false 的字段配一套永远不出现的 UI，正是 D63 说的「偷偷藏着」。字段留着是为了不破坏跨边界契约（主进程仍在返回它） |
| D68 | 删掉的东西**必须有测试守着**（`test/no-upstream-module.test.ts`） | 只删不守 = 迟早复发：下个会话遇到「这里缺个能力」会顺手从 `_xeno_probe/` 抄回来，而测试全绿 |
| D69 | 解压后**默认保留单层目录**，只有显式 `keepSingleDir: false` 才拍平；**绝不靠「目录名 ≠ 依赖名」猜** | M4.2 曾用「顶层目录名 ≠ 依赖名就拍平」的启发式：RTP 碰巧对了（目录名==依赖名），nwjs 错了（`version/v0.106.1` vs `nwjs-sdk-…`）→ 二进制路径少一层 → **mac 上 NW.js 游戏启动失败**。Windows 上无法复现，所以必须有单测覆盖两种形态 |
| D70 | ⚠️ **已作废（被 D72 取代）**：曾把 mkxp.json 写到游戏目录 | 那次方向是错的 —— 实测那份 mkxp-z **根本不看 cwd**，只读 app 包内 `Contents/Game/mkxp.json`。判据：把 Game.ini 删掉、cwd 换成纯 ASCII 临时目录，它照旧报同一句错 |
| D71 | **`Game.ini` 的 `Title=` 是 GBK 时，启动前自动改成纯 ASCII**（先备份 `.tsumigeya-bak`，幂等） | 实测日志：`Could not read Game.ini` + `Game.ini: Could not determine encoding of Game.Title` → **整份 ini 都读不出来** → 回落到 RGSS 1 (XP) → 找不到 `Scripts.rxdata` → mkxp-z 弹「No script file has been specified」。改完 Title 后 ini 能正常读、版本判对。`Title` 只是显示用，不参与启动逻辑 |
| D72 | **mkxp-z 的 `gameFolder` 遇到非 ASCII 路径时用 ASCII 符号链接**（`/tmp/tsumigeya-<base>-<sha1前12>`）；配置仍写 app 包内、**不传 cwd** | 实测对照：`/tmp/mkxp-ascii-test` → ✅ `RGSS version 3`；中文路径 → ❌ `Failed to parse mkxp.json : Unknown encoding`（它的 JSON 读取器先做编码嗅探，见到非 ASCII 字节就判失败，即使文件是合法 UTF-8）。写成 \uXXXX 转义更糟 —— 直接 crash（`-[NSURL initFileURLWithPath:]: nil string parameter`）。符号链接让 mkxp-z 全程只见 ASCII |
| D73 | **图标体系换 Lucide，图标几何「手抄常量 + 与包内数据逐字节比对的测试」**（`shared/icon-nodes.ts`）；不用 `lucide`（数据包，要第二份依赖），也不从组件里运行时抠 `iconNode`（赌内部结构，坏了**静默不画**） | morphicons 要**数据**（IconNode），而 `lucide-vue-next` 只导出**组件**。三种取法里，手抄 + 漂移测试是唯一"坏了会红"的：包升级改了路径，`test/icon-nodes.test.ts` 当场报出「该抄成什么」。实测这条判据抓到了本鱼抄错的两个图标（Gamepad2 / Settings） |
| D74 | **只在「同一个按钮有两种状态」处用 morph**；一次性动作（添加/删除/导航跳转）用普通 Lucide | 变形是**状态信息**，不是装饰。给"点一下就走"的按钮加变形，用户得到的是噪音（方案 §5 的使用原则）。判据落到 `MORPH_PAIRS` 数据 + 单测核对「morph 图标集与静态图标集不重不漏」 |
| D75 | **morph 的宿主必须是一个实例**：不用 `v-if`/`v-else` 两个容器各放一个图标 | 两个容器 = 状态一变就销毁旧组件重建新的，MorphIcon 实例没了 → 只看到硬切，而且**不报错、不警告**。M5.5 踩了两次（侧边栏折叠、详情页启动/停止） |
| D76 | **侧边栏折叠态只在内存**，不落盘 | 它是"我现在想多看点内容区"的临时视图选择，不是用户配置。落盘会让"打开就是收着的"变成需要解释的谜（用户忘了自己折过）。与 D50 同一取向 |
| D77 | morph 弹簧用**显式 `{stiffness:400, damping:40}`**，不用官方 `smooth` 预设 | 用户要"无回弹"，但官方 `smooth`(k=170,c=26) 实测 **0.72s** 太慢 —— 面板宽度过渡都收完了，图标还在飞。保持 ζ=1（`c=2√k`，零回弹）只提刚度 → **0.48s**。实测表在 `AppIcon.vue` 注释里 |
| D78 | **手柄不做**：四个引擎（MV/MZ/RPG Maker 系列/Ren'Py）**各自原生支持**手柄，插上即用。启动器不接管手柄输入 | 实测用户 Mac 上的**引擎核心文件**：`rpg_core.js` 的 `Input._pollGamepads()` 每帧读手柄、`gamepadMapper` 是标准 Xbox 布局；`rmmz_core.js` 同样；MKXP-Z 二进制里 290 处 gamepad 字符串。**这是引擎能力，不是游戏作者加的**（所以任何该引擎的游戏默认都支持）。Tsumigeya 是独立 Electron 窗口，Gamepad API 读到的输入送不进游戏进程 —— 「接管手柄」技术不成立，且无收益 |
| D79 | **无边框窗口不做**，只用引擎原生全屏 | mac 的真全屏本来就没有窗口装饰（边框是 Windows 全屏才有的问题）。要在 mac 上控制**别人的窗口**需辅助功能权限（实测用户机上 0 个应用有） |
| D80 | **全屏/缩放只接引擎已有的能力，不改用户游戏文件** | NW.js 用命令行 `--start-fullscreen`（**不是** `package.json` 的 `chromium-args`——那是 D53 拒绝的改文件）；EasyRPG 用官方 man page 的 `--fullscreen` / `--scaling`；MKXP-Z 用 mkxp.json 的 `integerScalingActive` |
| D81 | **存档导出打「整个存档目录」，不是只打槽** | 用户真机 `Karryn's Prison/www/save/` 里有 `lastsave.autobak` / `sync_data.rpgsave` —— 那是**游戏插件写的文件**，也是存档数据。只打 `file*.rpgsave` 会让用户换机后少东西（插件数据丢了，游戏行为就不一样），而他不会怀疑"包少了东西"。与 S1 判据「宁可多认，不能漏」同一取向 |
| D82 | **游戏运行中禁止导出/导入**，判据在主进程（`exportBlocked` + `registry.has`），UI 只是提前禁用 | 运行中的存档可能正在写：导出的包会是**半截文件**（头对、尾缺）。用户带着它换机，导入后游戏报存档损坏 —— 而他完全想不到问题出在"当初导出时游戏没关"。这类故障**没有自愈余地**（我们不解析也不修存档，方案 §6），所以必须在源头拦住。UI 拦不住所有路径，主进程那一层不能省 |
| D83 | **存档同步只留接口，不接任何云**；设置里只有 `none` / `manual` | 方案 §3.5 + D31 的精神（绝不动用户的东西）。云要账号、要冲突处理、要把存档传上去（里面可能有用户不想上传的东西）；而手动导入导出已能解决"换机防丢档"。一个半成品云比没有更糟 —— 用户会以为存档在云上，从而**不再手动备份**。判据是**结构性**的：`save-sync.ts` 里不许出现任何网络能力（源码级测试守），不许有实现类 |
| D84 | **分类是库页的筛选器，不是侧边栏的导航**（推翻了 S7 的初始位置） | S7 把分类放侧边栏的出发点是「它是用户的整理体系」（与标签相对的语义区分），那个语义仍然成立。但**位置错了**：侧边栏同时装着「游戏库 / 引擎 / 设置」三个真正的导航，分类越攒越多，导航就被挤得越远；更糟的是在引擎页/设置页时，那一长条分类**点不动也没意义**。用户 2026-11-05 实测后拍板改成库页顶部的横向 chip 栏。判据落在 `shared/sidebar-collapse.ts` 的 `SIDEBAR_PARTS`（**不许再有 'categories'**，有反向单测）+ `test/category-filter-bar.test.ts`（库页必须渲染、App.vue 不许残留分类代码） |
| D85 | **nwjs 的存档位置由 `package.json` 的 `main` 决定，不是「哪个目录有 `.rpgsave`」**：MV 的 `StorageManager.localFileDirectoryPath()` = `dirname(process.mainModule.filename) + '/save'`。`main` 在 `www/index.html` → **`www/save/`**；`main` 就在根 → `save/`。读不到 `main` 才退回目录启发式 | ⚠️ **这条是本鱼判断错误的更正**：2026-11-05 在 Mac 真机上看到 `苍蓝星/save/` 里有 5 个 `.rpgsave`，就断言「MV 也可能把存档放根 `save/`」并据此加了判据。用户一句「我没存过档」把整条推翻。核实事实：`save/` 目录**出生时间 = 解压那一刻**、里面文件内容时间戳是 **2022 年**、`debug.log` 是 **2021 年**、而 `main = www/index.html` —— 那几个是**作者打包时塞进去的残留档**，游戏运行时根本不读它们。后果比"列表为空"更糟：用户真存了档（写到 `www/save`）之后，详情页仍显示别人的 2022 年旧档，他自己的一个都看不到 —— **空列表只是没有，错的列表会让人以为档丢了**。判据 `test/save-locate.test.ts` 4 条（残留档不被误认 / main 在根时确实在 `save/` / 读不到 main 退回启发式 / www/save 不存在也指向它） |
| D86 | **存档目录里的点开头文件一律跳过**（`isNoiseFile`：`._*` AppleDouble / `.DS_Store`），列表与导出**两条路径都要过** | 逻辑上"整个目录都打"（D81），但那只针对**用户看得见的存档数据**。`._file1.rpgsave` 是 macOS 资源分叉镜像（163B），跨机后是垃圾且让包体积翻倍。⚠️ 更关键的是**列表这条**：MV 的槽判据是「任意 `.rpgsave` 但排除 config/global」，所以 `._file1.rpgsave` **会命中槽判据** → 用户看到一个点「在访达中显示」指向 163 字节元数据的幽灵存档。判据**只排除"点开头"**，绝不按扩展名白名单收窄（那正是 D81 拒绝的做法）。实测记录：Mac 的 `readdirSync` 不返回 `._*`（那些是 tar 传输途中生成的），所以这是**防御性**判据，不是当前故障 |
| D87 | **引擎从 4 个扩到 6 个**（加 `tyrano` / `kirikiri`），判据是**「资源跨平台 + 有 macOS 运行时」**，**不是「DLsite 标没标支持 Mac」** | ⚠️ **这条修正了本鱼的一个判断错误**：最初拿「DLsite 标注支持 Mac 的 695 部里只有 19 部 RPG Maker」当论据，得出「加引擎救不了 Mac」。**整个反了**——这个启动器的存在理由恰恰是「游戏只发 Windows 包、我们用自己装的 mac 运行时跑它的资源」（用户当场指出：他自己在玩的几个没标 mac 的游戏就是这么跑的）。正确判据只有一个：资源是不是数据（跨平台）+ 有没有能自己实现的运行时。**跟作者发不发 mac 版完全无关**。据此：TyranoScript（HTML5，复用 NW.js，**零新运行时**）、吉里吉里（`data.xp3` + krkrsdl2）满足；Unity（IL2CPP 平台锁定）、RPGBakin（官方 FAQ 明写只有 Windows 版）、ウディタ（Windows 专属）不满足 |
| D88 | **识别范围 > 启动范围**：新增 `DETECT_ONLY`（Unity / RPGBakin / ウディタ），**只认不跑**；可启动引擎与仅识别引擎**分两张表** | 用户要「范围尽可能广」，但**「认得出」和「跑得动」是两件事**。塞进 `ENGINES` → 引擎页列成「可安装」但下载地址空 → 点了必失败（D60 的「不起作用的开关」教训）。完全不认 → 用户得到「未知引擎」，而「未知」与「需要 Windows 兼容层」是**两种不同处境**（前者像程序坏了）。所以合并参与打分、但仅识别条目**一律 `all_required:false`（走打分）**，靠 `pickBestRule` 的「强命中永远压过打分命中」保证**绝不抢走可启动引擎的游戏**（`test/detect-priority.test.ts` 12 条钉死）。⚠️ **实测抓到过一个真 bug**：给 Unity 规则加了 `extensions:['exe']` 后，一个只有 readme 的空目录都被判成 Unity —— 判据只能靠**专有文件名**，宁可认不出也不能乱认 |
| D89 | **不做 Windows 兼容层（Wine/CrossOver 一类）**，跑不动的引擎交给用户在 CrossOver 里跑（用户 2026-11-05 拍板：「windows兼容的游戏有CrossOver嘛，不做也可以的」） | 技术诱因之外还有**政策风险**：Apple 官方文档（support.apple.com/en-us/102527，2026-09）写明 Rosetta 只在 **macOS 27 及更早**可用，**macOS 28 起只对「某些老旧无人维护的游戏」保留**；而 CrossOver 官方承认「其他基于 Wine 的模拟器**一直依赖 Rosetta 2** 跑 x86 Windows 游戏」。DLsite 的 Windows 游戏几乎全是 x86/32 位 → 那条路铺在一条会变短的政策上。**但识别仍要做**（D88）：用户添加这类游戏时应得到「需要 Windows 兼容层，Tsumigeya 不代跑」，而不是「未知引擎」 |
| D90 | 吉里吉里**标「实验性」**（`EngineDefinition.experimental`），但它**照常可用**；不因上游声明做任何检测或拒绝 | 运行时 krkrsdl2（MIT，有 macOS 预编译包）官方页**明写**：「Running **unmodified commercial games** using this project is **not supported**. Please use Wine or GameNative instead.」（krkrsdl2.github.io/krkrsdl2/en/）。用户 2026-11-05 接受这条限制，所以我们做它。但那是**上游的立场声明，不是技术闸门**（它并不会真的拦住）——所以我们**如实转达**（引擎页标「实验性」+ 卡片写明是上游限制），**不替用户挡**，也不让用户以为这是本项目官方承诺的能力 |
| D91 | **引擎扩到 9 个**：新增 `nscripter`（ONScripter）/ `siglus`（siglus_rs）/ `godot`。判据仍是 D87 的「资源跨平台 + 有 macOS 运行时」 | **NScripter**：`nscript.dat`/`arc.nsa` 是数据；ONScripter 是本体的开源兼容实现。⚠️ **许可证已核到源头**：Debian 官方版权文件写的是 **`GPL-2+`**（「or (at your option) any later version」），**不是 `GPL-2.0-only`** → 允许按 GPL-3.0 使用，**与本项目兼容**。（研究员按普通法理判「GPLv2-only 与 GPLv3 不兼容」是对的，但这个包带 `+`，结论反过来；本鱼起初也按 2.0-only 判，同样错。）**Siglus**：siglus_rs（MPL-2.0）**一个引擎覆盖 UK2/AVG32/RealLive/SiglusEngine 四种格式**，macOS 有官方预编译 → 性价比最高。**Godot**：pck 跨平台**只对 GDScript 项目成立**（C# 与 GDExtension 不行，见 D92） |
| D92 | **Godot 用「编辑器二进制」当运行时，不用 export template**；且**存档位置不实现**（返回 null） | ① **4.6 起 `--main-pack` 在 export template 里被默认禁用**（PR #111909，实测 issue #119376 报 `compiled without support for path overrides. Aborting.`；4.5.2 正常）。而**编辑器二进制仍支持** → 用它可以**避免要求每个用户自己编译 Godot**，代价是 154 MiB 运行时。② **pck 跨平台有三个前提**：GDScript 项目（C# 在 mac 上加载不了，issue #72159 实测 `class could not be found`）+ 不用 GDExtension（含平台专用 dylib）+ **引擎版本匹配**。③ **存档改不了**：官方明确「导出的工程不支持 self-contained mode」，而默认路径依赖要从 pck 里读的 `project_name` → **不自己解析 pck**（格式有 v0–v4 五个版本、Godot 又每年升级，自己解析等于赌它不变），直接返回 null（与 tyrano/kirikiri 同一取向，**宁可显示「不知道」也不猜**） |
| D94 | **应用图标走「像素复刻」而不是缩放**：从源图反推原始像素画分辨率（**30×32**），每格取中位色 → 调色板聚类 → **最近邻整数倍放大**（k=25）。**图标里不写应用名** | ⚠️ **这张图标换了三版才定**（用户三次改主意：先是带剑穿像素鱼+文字的浅色瓦片版、再是白底像素画版、最终是灰底剑穿心版）。真正的技术难点是**源图已被放大过且被 JPEG 压过**（每格 ~8.5px 非整数、边缘有振铃伪影），直接 LANCZOS 放大 3 倍会得到"糊掉的像素画"。四版试错的**具体错在哪**（这四条别再重走）：① `dist>TOL` 直接判透明 → 反锯齿边留成不透明浅色，放大后一圈**白毛**；② 除以 alpha 反解前景色 → 低 alpha 分母趋零**数值爆炸，边缘提亮成白圈**（比①更糟）；③ 形态学腐蚀 2px → 白圈没了但**心形被挖洞**（尖角只有 1~2px 宽，直接磨断）；④ 按面积过滤连通块 → **心形内部的高光被当噪点删掉**（那些高光是小连通块）。像素复刻一次解决全部：**颜色是纯的、边是硬的、洞不存在**。⚠️ **不写应用名的理由**：mac 图标下方系统会自动显示应用名，图标内再写一遍是重复；且 16px 下文字必糊成灰块（实测截图过）。**判据**：`test/icon-assets.test.ts` 6 条守资产存在 + icns 11 档（含 Pillow 不写的 icp4/icp5 两个小档——缺了 Finder 列表和菜单栏会糊或回落通用文档图标） |
| D95 | **原生版做完之后弃用 Electron 版**（用户 2026-11-06 拍板） | 保留 Electron 版只是 P0–P3 阶段的 fallback：那时 Swift 版还不能替代它，出问题要有退路。**原生版 P4（UI）可用后**就只保留一套实现 —— 两套并存的代价是「改一个 bug 要改两处，或者明知旧栈有洞也懒得修」（tarEnv 的 LC_ALL 漏洞就是这么发现的：修了 Swift 版才回头看见 Electron 版也有）。弃用后 **`src/` 与 `mac-native/` 只留后者**，`docs/M*.md` 的历史记录保留（那是判据来源，不是代码）。⚠️ 弃用前必须：① P4–P8 全部完成 ② 数据目录同址（已同址）③ 旧版用户有迁移路径（数据本来就是同一份，不用搬） |

## 里程碑路线图

> **用户 2026-11-05 确认的里程碑顺序（别擅自调整）**：
> `M5.0 体验优化` → `M5.5 动态图标` → `M4 存档管理` → `M5 手柄/全屏/缩放/公证`
>
> M5.5 排在 M5.0 之后是有实际原因的：M5.0 正在改库页/编辑页/设置页布局，
> 这期间换图标体系（Element Plus → Lucide）会和布局改动互相干扰。

- **M1–M4.2（已完成）**：见「当前状态」。实现细节与探针结论在 `docs/M*.md`
- **M5.0（已完成，S1–S12）**：体验优化 —— 见 `docs/M5.0-实施方案.md`
  - **B1 版本号永久 v0.0.0**（preload 用了 `npm_package_version`，打包后不存在 → 构建时注入）
  - ~~B2 VX Ace 放了 Data 仍报错~~ ✅ **已修（v0.5.3：中文路径 + GBK Game.ini，D71/D72）**
  - **U8 编辑页重构**（用户最不满意）：两种保存合一 + DLsite 从附录提到主数据 + 拆 4 个组件
  - **U7 完善信息复用编辑页组件**（抽 `GameInfoForm.vue`，不复制第二份）
  - U1 批量管理 / U2 自定义分类 / U3 去标签筛选 / U4「只看未绑定」/ U5 只留选文件 / U6 去跳过+可改引擎
  - U9 设置页分组 / U10 引擎页「全部安装」
  - N1 详情页游玩时间 / N2 存档管理 / N3 汉化作弊（参考 RPGMakerUtils）
- **M5.5 动态图标**（`docs/M5.5-动态图标.md`，**已实施**，待发布）：
  接入 [Morphicons](https://www.morphicons.com/)（**MIT**，零依赖）做状态切换的图标变形。
  - ✅ 图标体系已换成 **Lucide**（`lucide-vue-next@1.0.0`；`@element-plus/icons-vue` 已从直接依赖移除）
  - ✅ 5 个 Element 图标全换 + 侧边栏 emoji 换成 Gamepad2/Settings/Wrench
  - ✅ 三处 morph：侧边栏折叠 `Menu`←→`X`、启动/停止 `Play`←→`Square`、简介展开 `ChevronDown`←→`ChevronUp`
  - ✅ **侧边栏折叠是新建功能**（原计划以为它已存在，见 docs §9.3）
  - ✅ +33 条测试（`icon-nodes` 21 / `sidebar-collapse` 12）
  - ⚠️ **动效手感与暗色粗细待用户真机确认**（`AppIcon.vue` 的 `SPRING` / `strokeWidth` 可直接调）
  - **仍只在「同一按钮有两种状态」处用 morph**（D74）；一次性动作不变形 —— 硬塞是滥用
- **M4 存档管理（进行中）** —— 方案 `docs/M4-实施方案.md`
  - ✅ **S1 已提交**（`848af84`）：存档位置探测 + `listSaves` 只读命令
    - 判据 `shared/save-locate.ts`（纯函数，19 条单测）；IO `main/save-store.ts`
    - **MV/MZ 两种布局**：MV 在 `<游戏>/www/save/`、MZ 在 `<游戏>/save/`（实测，不能硬编码）
    - MKXP-Z 靠约定枚举（`Data/Save*` → 根目录 `Save*` → `Save/`），**不等真实样本**
    - ⚠️ `location:null`（不知道在哪）与 `empty:true`（还没存档）**必须区分**
  - ✅ **S2 已提交**（`81184ec`）：详情页存档区块（列表 + 三态分开 + 在访达中显示）
    - 判据 `shared/save-view.ts`（18 条单测）；组件 `SaveSection.vue`
  - ✅ **S3+S4 已提交**（`73bcd06`）：导出 zip + 导入
    - 判据 `shared/save-archive.ts`（39 条）；IO `main/save-archive-io.ts`（26 条读写真盘）
    - **打整个目录**（含 `lastsave.autobak` / `sync_data.rpgsave` 这类插件文件）
    - **运行中禁止导出**（`exportBlocked`）：半截文件带着换机会丢档
    - 导入顺序 **先校验 sha256 → 再备份 `.tsumigeya-bak` → 才写**；备份**幂等**
    - 两条命令都**进队列**（写盘）；`OFF_QUEUE_METHODS` 仍是 11
  - ✅ **S5 已提交**（`28369b0` + `154c835`）：同步占位（接口 + 设置页下拉，**不接任何云**）
    - 判据 `shared/save-sync.ts`（27 条，含「源码里禁止任何网络能力」的源码级判据）
    - ⚠️ 踩到一次「判据写了、测了、但没人调用」→ 补了源码级测试守住它必须被用
  - **M4 全部 5 步已完成**（S1–S5）。⚠️ **UI 未人眼验收**（列表样式/空态文案位置/设置页下拉）
  - **不做**：解析存档内容（改钱改道具）、云同步、自动备份、改游戏文件结构
  - ⚠️ 实施前必读：`docs/M4-实施方案.md` §2 的四条实测结论
- **M4 增强**：Cheat 注入 / 变速（未调研）
- **M5**：手柄、无边框全屏、像素缩放、dmg 公证分发

### M4.2 做了什么（归档，2026-11-04）

按 `docs/M4.2-实施方案.md` §5 的 S1–S7 顺序，每步一个 commit：

| 步 | 内容 | 落点 |
|---|---|---|
| S1 | 版本比较自实现 | `engines/semver.ts` + `test/engines-semver.test.ts`（26 条） |
| S2 | 读 manifest + 引擎识别 | `engines/manifest.ts` / `engines/detect.ts` + `test/engines-detect.test.ts`（38 条） |
| S3 | 装/更新/卸载 + 依赖下载 | `engines/install.ts` + `test/engines-install-update.test.ts`（35 条，含 3 条不变量） |
| S4 | ipc/core-host 全量换源 | `core-host.ts` 752 → 约 300 行；`host.core` 调用点归零 |
| S5 | 删 `module.js` | + `test/no-upstream-module.test.ts`（9 条守「不许偷偷回来」） |
| S6 | 端到端探针 | `scripts/probe-m42*.cjs`（30 条判据全绿） |
| S7 | i18n 收尾 + 本文档 | 砍掉 `dependencyUpdate` 那整套永不出现在 UI 里的空壳 |

**实施中发现并修掉的三个真 bug**（都有回归测试）：
1. `updateEngine` 更新普通依赖时不清理旧目录 → 旧文件残留，变成
   「新 manifest + 旧二进制叠加」（界面显示已更新、启动却加载旧二进制）
2. `updateEngine` 失败路径不把保留目录搬回 → 用户的多版本运行时留在 `.update-preserve/` 里等于全坏
3. `reconcileGameArgsAndPersist` 的 catch 只打 message、不打印 `translationKey`，
   而 `error.staleGame` 的真实原因（id 不是数字）藏在 key 里 → 排障看不出为什么没写进去

## 仍未人眼验收（只能在有画面的机器上做）

- 视觉观感：暗色配色、封面裁切、进度浮层动效
- M2.5 UI 手感：搜索候选滚动、字段编辑框位置、语言确认措辞
- M2.6：卡片 hover、菜单浮出、简介 2 行截断、窄窗口塌陷、R18 模糊强度
- **M3/M4.1 真实下载**：244MB RTP 与引擎依赖的耗时、进度条、取消是否及时
- **M4.2 引擎页 UI 改动**：更新按钮合并成一个（原来「更新 / 更新依赖 / 兜底更新」三个分支），
  需要在有画面的机器上确认按钮的显隐与配色仍然合理
- **mac 上真引擎能否 spawn 起来**（Windows 只验到错误路径与中文文案）
- 不做 chromium-args 篡改后，NW.js 行为是否与之前一致（待 mac 真机对比）
- **M5.5 图标动效手感**（本机已验「图标画出来了、变形确实在跑、落回规范形态、零 console 错误」，
  但**观感**只能在真机看）：
  ① 弹簧 0.48s 的快慢与阻尼是否舒服（`AppIcon.vue` 的 `SPRING = {stiffness:400, damping:40}`）
  ② 暗色 UI 上 `stroke 1.5` 是否偏细（`AppIcon.vue` 的 `strokeWidth` 默认值）
  ③ 折叠面板宽度过渡 0.42s 与图标变形 0.48s 是否协调
- **M4 存档 UI**（本机只验了逻辑与错误路径，**观感只能真机看**）：
  ① 详情页「存档」区块的三列布局（文件名长短差很多，grid 是否对齐）
  ② 两种空态文案的位置与措辞（`unknown` 那句明显更长，会不会挤）
  ③ 配置项压暗的程度（是否真的与存档槽拉开了距离）
  ④ 运行中时导出按钮变灰 + 下方那行说明（是否读得懂"请先关闭游戏"）
  ⑤ 设置页「游戏库」组里新增的存档同步下拉
  - ✅ 以上①③⑤ 已在本机（Electron 探针 + 截图）验过：三列对齐、配置压暗、下拉正常
  - ✅ **真实导出/导入端到端已跑过**（2026-11-05，两条路径都验）：
    · 本机探针：`_xeno` 假存档 5 文件 → 导出 → **zip 里每个 sha256 与源文件逐个一致** →
      破坏源档 → 导入 → **每个文件精确还原**、生成 5 个 `.tsumigeya-bak`、
      第二次导入 `backups: []`（**备份幂等**）
    · **mac 真机**（`ssh yometenma@192.168.1.86`，v0.6.1）：
      `苍蓝星`（`main=www/index.html`，`www/save/` 尚未创建 = 用户没存过档 →
      判据正确指向 `www/save/`，**不再把根 `save/` 里作者残留的 2022 年旧档当成用户的**）
      与 `Karryn's Prison`（`www/save/` + 插件文件，槽/配置正确分开）两种真实布局都验了
  - ⚠️ **仍没自动化的只有「弹目录选择框」这一步**：`dialog.showOpenDialog` 无法在无画面环境
    操作。它的两条分支（选到目录 / 取消落默认目录）靠 `outDir` / `file` 参数旁路验证，
    **真实点击**要在真机上手动点一次
  - ✅ **v0.6.2 已在 Mac 真机上装好并验证**（2026-11-05，**验的是 GitHub 发布的 dmg 本身**，
    不是本地构建）：见下方「Mac 真机验收方法」

## Mac 真机验收方法（v0.6.2 实测跑通，可复用）

> 本机无画面时只能做逻辑与探针验证；**发布包本身**的真实行为靠这套流程验。
> 全部通过 `ssh yometenma@192.168.1.86` 完成，无需人到 Mac 前。

### 装包（含代理加速）

```bash
# GitHub 直连很慢（131MB 下了 5 分钟只到 14MB）。用户 Mac 开着 Clash，
# 系统代理是 127.0.0.1:7897 —— 走它只要 14 秒。
curl -sSL --proxy http://127.0.0.1:7897 -o /tmp/Tsumigeya.dmg \
  "https://github.com/Yometenma/Tsumigeya/releases/download/v0.6.2/Tsumigeya-0.6.2-arm64.dmg"

hdiutil attach /tmp/Tsumigeya.dmg -quiet
rm -rf /Applications/Tsumigeya.app                      # 或先备份旧版
cp -R "/Volumes/Tsumigeya 0.6.2-arm64/Tsumigeya.app" /Applications/
xattr -dr com.apple.quarantine /Applications/Tsumigeya.app
```

### 启动（三个真机坑）

| 坑 | 现象 | 正解 |
|---|---|---|
| **`nohup ... &` 撑不住** | SSH 一断进程就被 SIGHUP 杀掉，日志只剩 `GPU process exited unexpectedly` / `Network service crashed` —— 看起来像应用崩了，其实是 shell 把子进程带走了 | 用 `launchctl submit -l tsmg-verify -- /bin/sh -c "..."`。**macOS 没有 `setsid`**（那是 util-linux） |
| **调试端口不认外部指定** | 传 `--remote-debugging-port=92299` 后实际端口是随机的 | 传 `0`，然后从日志读 `DevTools listening on ws://127.0.0.1:<port>/...` |
| **⚠️ 打包的 `.app` 会忽略脚本参数** | `Tsumigeya.app/Contents/MacOS/Tsumigeya <path/out/main/index.js>` —— 传了另一个入口也没用，它**照样跑 app.asar 里的旧代码**。本鱼因此把「v0.6.2 没有 D85 判据」误判成「新 bug」，白查两小时 | 验**本地构建**必须用**未打包**的 Electron 二进制（`node_modules/electron/dist/Electron.app`）当壳；验**发布包**就直接跑 `.app`。**先确认 app.asar 里有没有你刚加的代码**：`grep -c "<特征串>" Contents/Resources/app.asar` —— 是 0 就说明你在测旧代码 |

### 连 UI

用 CDP（`Runtime.evaluate`）操作真实 DOM —— 不重打包、不改应用，验的就是发出去的那个包。
极简客户端只用 `WebSocket` + `Runtime.evaluate`，无需第三方库。

**v0.6.2 实测结果**（全部通过）：

| 项 | 结果 |
|---|---|
| 版本号 | `0.6.2` ✓ |
| 分类栏 | 库页顶部 chip 栏（全部 / 未分类）+ 侧边栏**无分类** + 导航 3 个 ✓ |
| 存档区块（修过的克隆 bug） | Karryn 列出槽 2 个 + 配置 2 个，**零 console 错误** ✓ |
| 真实导出（点 UI 按钮） | 对话框回落 Downloads，包内 5 文件 **sha256 逐个一致** ✓ |
| 真实导入（破坏源档后） | **5/5 精确还原** + 5 个 `.tsumigeya-bak` ✓ |
| 存档位置判据（D85） | 苍蓝星 → `www/save`（用户确实没存过档）✓ |

### 系统对话框那条分支怎么验的

`dialog.showOpenDialog` 无法用 CDP 点。**但可以验「它确实弹了」**——
点按钮后观察三个独立信号（v0.6.2 实测全部成立）：

1. 旁路只读命令（`listSaves`）**仍响应** → 主进程活着，没崩
2. 再发一个 `exportSaves` **被串行队列挡住**（6s 内不返回）→ 模态框占着队列
3. 按钮变成 `el-button is-disabled is-loading` → UI 知道操作在进行中

⚠️ **但 SSH 后台会话里对话框会立即返回 null**（无真实用户会话），
于是代码正确地回落到 `defaultExportDir()`（`~/Downloads`）并导出成功 ——
这反而把「取消/无应答」这条分支端到端验了。**真正"选到某个目录"那条分支
仍需人在 Mac 前点一次**（目前只有 `outDir` 参数旁路验证）。

### 收尾纪律（改真实用户数据前必做）

- 动用户存档前先 `cp -R` 备份到 `/tmp/tsmg-save-backup/` 并记下 `shasum -a 256`
- 测完逐文件比对 sha256，**清理测试产生的 `.tsumigeya-bak`**
- 保留旧版 app 备份（`/tmp/Tsumigeya-backup-<old>.app`）便于回退

## 上游参考（仅历史）

- https://github.com/m5kro/Xenolauncher ；模块仓库 `m5kro/Xenolauncher-Modules`
- **本地 clone `_xeno_probe/` 已删**（2026-11-05 清理时按用户指示移除，2.0M 未追踪）。
  M4.2 完成后它只剩考古价值，而 D68 的守卫测试保证了「上游代码不会偷偷回来」。
  需要回溯时从上面两个 URL 重新 clone（在 `.gitignore` 里，不会进仓库）。
- 历史里程碑文档（`docs/M*.md`）里仍引用 `_xeno_probe/...` 的路径 —— 那是**当时的记录**，
  不需要跟着改；真要按它去查，先重新 clone。
