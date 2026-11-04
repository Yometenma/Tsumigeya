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
  M4.1（引擎清单自己维护）、**M4.2（彻底零上游）**
- **已发布**：**v0.5.3**（含 M4.2 + 两个启动修复；GitHub `Yometenma/Tsumigeya`）
- **测试**：**885 个 / 37 文件**全绿；`typecheck` / `test` / `build` 三绿
- **M5.0 进行中**（`docs/M5.0-实施方案.md`）：12 项体验优化，**逐条提交**（用户拍板）
  - 顺序见方案 §12：B1 版本号 → U3+U4 筛选 → U5 选文件 → U6 去跳过 → N1 游玩时间
    → U1 批量 → U2 分类 → U10 全部安装 → U9 设置页 → U7 抽组件 → U8 编辑页重构
  - **B2（VX Ace 打不开）已在 v0.5.3 修复**，不在本轮范围
  - ✅ **S1 / B1 已提交**：版本号改为构建期 `define` 注入（`__APP_VERSION__`）
  - ✅ **S2 / U3+U4 已提交**：删「按标签筛选」；「只看有封面」→「只看未绑定」
    （判据抽到 `shared/library-filter.ts`，24 条单测）

### 各模块在哪（一句话）

| 模块 | 文件 | 关键点 |
|---|---|---|
| 引擎定义 | `src/main/engines/registry.ts` | **4 个引擎唯一来源**（D60）；ruffle/wine/macos 不存在 |
| 引擎清单读写 | `src/main/engines/manifest.ts` | 读本地 manifest + 合并 gameArgs 缺省值（M4.2） |
| 引擎识别 | `src/main/engines/detect.ts` | 打分算法**只有一份**；R1：`.app` 包与子目录 |
| 版本比较 | `src/main/engines/semver.ts` | `compareVersions` / `hasUpdate`（M4.2 自实现） |
| 装/更新/卸载 | `src/main/engines/install.ts` | `updateEngine` 保住多版本依赖（D66） |
| 启动 | `src/main/launchers/` | `buildLaunchPlan` + `spawn.ts`（唯一起进程处，D55 三件套） |
| 诊断 | `src/main/diagnose.ts` | 纯本地特征，不调 mkxp-z（D32） |
| 进程表 | `src/main/process-registry.ts` | 只在内存（D50）；`stopGame` 两段式（D52） |
| 游玩记录 | `src/main/play-stats.ts` | 独立 `play-stats.json`（D51） |
| IPC | `src/main/ipc.ts` | 单 channel + 串行队列；只读命令走 `OFF_QUEUE_METHODS` |
| 库页筛选 | `src/shared/library-filter.ts` | 纯函数（搜索 + 只看未绑定）；判据有单测，别在 store 里重写 |

## 开发命令

```bash
npm run dev        # 走 scripts/dev.cjs（文件入口 + 清 ELECTRON_RUN_AS_NODE + NO_SANDBOX）
npm run typecheck  # TS 检查（node 侧 + web 侧）
npm test           # vitest（不依赖网络、不需要 GUI）
npm run build      # 构建 out/，不打包安装包
npm run build:mac  # 出 mac 包（Windows 上只能 zip/dir；正式包走 CI）
```

数据目录隔离：`TSUMIGEYA_DATA_DIR=D:\YomeXProjects\Tsumigeya\.dev-data npm run dev`

**目录卫生**（2026-11-04 清过一轮）：
- `scripts/` 只剩 `dev.cjs`（`npm run dev` 用）与 `after-pack.cjs`（electron-builder 用）。
  **历史里程碑的 `probe-*.cjs` 已全删** —— 验收都做过，留着是纯历史包袱。
- `docs/archive/` 放已失效的历史材料。**别删**：完成里程碑的文档还在引用它们。
- `.gitignore` 用通配 `.dev-data-*/` 与 `.dev-*probe.json`，不再一个里程碑加一条。

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
| **响应式 Proxy 传给 IPC → `An object could not be cloned.`** | 走 store 层统一 `toPlain()`（D44）；**逐字段拷贝会漏** |
| `el-dropdown-item` 的 `aria-disabled` 是**字符串** `"false"` | 判据用 `=== 'true'`，别用 `!!getAttribute()` |
| `settings-row` 塞 array 编辑块 → 布局错乱 | `DynamicArgsForm` 把它放 `settings-row` 外面 |

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

### 落盘白名单（改字段必看）

| 坑 | 对策 |
|---|---|
| **给 `GameMeta` 加字段必须同步改 `library-meta.ts` 的 `sanitize()`** | 它是落盘白名单，漏了会**静默丢弃**；改完先看 `saveGameMeta` 的返回键集 |

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
6. **不提交** `node_modules/ out/ dist/ *.tsbuildinfo`；不动 `_xeno_probe/`
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

## 里程碑路线图

> **用户 2026-11-05 确认的里程碑顺序（别擅自调整）**：
> `M5.0 体验优化` → `M5.5 动态图标` → `M4 存档管理` → `M5 手柄/全屏/缩放/公证`
>
> M5.5 排在 M5.0 之后是有实际原因的：M5.0 正在改库页/编辑页/设置页布局，
> 这期间换图标体系（Element Plus → Lucide）会和布局改动互相干扰。

- **M1–M4.2（已完成）**：见「当前状态」。实现细节与探针结论在 `docs/M*.md`
- **M5.0（进行中）**：体验优化 —— 见 `docs/M5.0-实施方案.md`
  - **B1 版本号永久 v0.0.0**（preload 用了 `npm_package_version`，打包后不存在 → 构建时注入）
  - ~~B2 VX Ace 放了 Data 仍报错~~ ✅ **已修（v0.5.3：中文路径 + GBK Game.ini，D71/D72）**
  - **U8 编辑页重构**（用户最不满意）：两种保存合一 + DLsite 从附录提到主数据 + 拆 4 个组件
  - **U7 完善信息复用编辑页组件**（抽 `GameInfoForm.vue`，不复制第二份）
  - U1 批量管理 / U2 自定义分类 / U3 去标签筛选 / U4「只看未绑定」/ U5 只留选文件 / U6 去跳过+可改引擎
  - U9 设置页分组 / U10 引擎页「全部安装」
  - N1 详情页游玩时间 / N2 存档管理 / N3 汉化作弊（参考 RPGMakerUtils）
- **M5.5 动态图标**（`docs/M5.5-动态图标.md`，方案已就绪，**M5.0 完成后做**）：
  接入 [Morphicons](https://www.morphicons.com/)（**MIT**，gzip 10 KB，零依赖）做状态切换的图标变形。
  - 用户已拍板：**图标体系换成 Lucide**（Morphicons 原生支持它的 IconNode 格式）
  - 现状成本很低：Element Plus 图标只有 **2 个文件 5 个图标**；侧边栏用的是 emoji（顺带换掉）
  - **只在「同一按钮有两种状态」处用 morph**（菜单←→X、播放←→停止、展开←→收起）；
    一次性动作按钮（添加/删除）不该变形 —— 硬塞是滥用
- **M4**：存档管理（查看/备份/导出）+ 增强（Cheat 注入/变速）
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

## 上游参考（仅历史）

- https://github.com/m5kro/Xenolauncher ；模块仓库 `m5kro/Xenolauncher-Modules`
- 本地 clone `_xeno_probe/`（只读参考，gitignore）
- M4.2 已完成，只剩考古价值（`_xeno_probe/` 里那份 `module.js` 仍是理解
  `deps/RTP/RTP/` 双层目录、`version/v0.106.1` 命名等历史形态的最快入口）
