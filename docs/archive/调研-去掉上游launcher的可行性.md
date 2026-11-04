# 调研：能否不依赖上游 launcher？

> **性质**：调研记录，不是实施方案。用户 2026-11-04 提出「是不是不一定非要用他这个上游」。
> **本文件不含代码改动**。用户已决定：**只砍 launcher，暂时不动 module.js**，
> 且 **M3.5 会话正在干活，先不实施**。

---

## 1. 用户的直觉是对的，数据可以证明

上游 `Xenolauncher-Modules` 的每个模块 = `manifest.json`（依赖与版本）+ `launcher.js`（启动脚本）。
**`launcher.js` 里 99% 是附加功能，真正启动只有 3–5 行。**

实测行数（2026-11-04，从 GitHub 拉取主分支）：

| 引擎 | launcher.js 总行数 | 真正启动所在行 |
|---|---|---|
| **nwjs** | **542** | **534** |
| mkxpz | 242 | 234 |
| easyrpg | 123 | ≈120 |
| renpy | 69 | 60 |

### 1.1 nwjs 的 542 行都在做什么（真正的启动在第 534 行）

| 函数 | 作用 | 属于 |
|---|---|---|
| `copyCheatFiles` / `removeCheatFiles` | 往游戏目录塞作弊文件 | **附加功能** |
| `modifyMVMainJs` / `unmodifyMVMainJs` | **改写游戏 `js/main.js`** | **附加功能** |
| `modifyMZMainJs` / `unmodifyMZMainJs` | 同上（MZ） | **附加功能** |
| `applyCheatMenu` / `removeCheatMenu` | 注入作弊菜单 | **附加功能** |
| `applyProtection` / `removeProtection` | DOM 保护 | **附加功能** |
| `addChromiumArg` / `ensureChromiumArgsField` / `removeChromiumArg` | 篡改 `package.json` 的 chromium-args | **附加功能** |
| `patchRpgmGetPixel` | 改取色函数 | **附加功能** |

### 1.2 各引擎的「必需逻辑」实际有多简单

```js
// renpy（全部必需逻辑）
exec(`"${renpyPath}" --savedir "${savedir}" "${gameFolder}"`)

// easyrpg
exec(`"${player}" --window --project-path "${gameFolder}"`)

// nwjs
exec(`"${nwjsPath}" "${gameFolder}"`)

// mkxpz（多一点：先写 mkxp.json 决定 RTP / rgssVersion，再启动）
exec(`"${mkxpzPath}"`)
```

---

## 2. 引擎二进制来自**第三方官方源**，不是上游托管

实测四个模块的 `manifest.json` 里 `dependencies.*.link` 的主机：

| 模块 | 依赖 | 下载源主机 |
|---|---|---|
| **nwjs** | `version/v0.106.1` | **`dl.nwjs.io`**（NW.js 官方） |
| nwjs | `cheat-js` / `cheat-css` / `bg` / `disable-child` / `disable-net` | `raw.githubusercontent.com`（作弊相关资源） |
| **easyrpg** | `player` | **`ci.easyrpg.org`**（EasyRPG 官方 CI） |
| easyrpg | `soundfont` | `musical-artifacts.com` |
| **mkxpz** | `mkxpz` / `RTP` / `kawariki` / `soundfont` | `github.com`（mkxp-z fork 仓库） |

**结论**：上游只是「薄封装 + 附加功能」，**引擎本体确实来自官方源**。

---

## 3. 但要分清两个东西（容易被混为一谈）

| 东西 | 内容 | 现在用没用 |
|---|---|---|
| **`module.js`**（1870 行，fork 到 `resources/core/`） | 核心模块系统：manifest 解析、依赖下载+解压+事务回滚、版本管理、模块仓库拉取 | ✅ 在用 |
| **`launcher.js`**（每模块一个） | 每个引擎的启动脚本（含作弊注入等） | ✅ 在用 |

**用户说的「上游 launcher」= 第二个。** 这两个可以独立取舍。

### 3.1 `module.js` 提供的价值 vs 自己实现的代价

| 能力 | 能否自己实现 | 代价 |
|---|---|---|
| manifest 解析（autodetect 规则） | ✅ 就是读 JSON | 低 |
| **依赖下载 + 解压 + 事务回滚** | ✅ 已自己实现过（M3 的 `installDependencies`） | 低（有现成代码） |
| **版本管理**（multi-version 参数） | ✅ | 低 |
| 模块仓库拉取 | ✅ 读 GitHub raw | 低 |
| **引擎目录 / 数据目录约定** | ⚠️ **兼容性问题**，不是技术问题 | **高** |

**真正值钱的是最后一条**：
- 老用户的 `~/Library/Application Support/xenolauncher/modules/<引擎>/` 目录结构由它定义
- 砍掉 = **老用户要重装引擎**
- 且上游模块仓库更新时要跟着改代码（而不是「装个新模块就支持」）

---

## 4. 用户决策（2026-11-04）

> **「只砍 launcher 吧，暂时先不动，m3.5 的会话正在干活呢，我怕影响到了」**

| 项 | 决定 |
|---|---|
| 砍 `launcher.js`（自己实现启动） | ✅ **要做，但等 M3.5 完成后** |
| 砍 `module.js` | ❌ 不做（兼容代价高、收益不明显） |
| 现在动代码 | ❌ **不动**（M3.5 正在同一工作区干活） |

---

## 5. 顺带发现：现在会**改写用户的游戏文件**

nwjs 的 `modifyMVMainJs` / `modifyMZMainJs` **会改写游戏目录里的 `js/main.js`**
（为注入作弊菜单）。`applyProtection` 还会改 `package.json` 的 `chromium-args`。

**这与本项目「不修改游戏文件」的定位冲突**（D34 只对 DRM 做过类似表态）。

**用户 2026-11-04 表态**：「作弊注入我们还没进行到那一步，暂时不管」。

**但注意**：一旦自己实现启动，**默认就不会改 `main.js` 了**——
这等于顺手修掉。届时要在方案里写明：

> **自实现启动 = 默认不修改游戏文件；作弊注入作为可选功能，以后单独评估。**

---

## 6. 如果以后要实施（留给下一个会话的信息）

### 6.1 推荐路线：只砍 launcher，保留 module.js

```
IPC 层自己拼启动命令（每引擎 3–5 行）
  ↓ 用 spawn（不是 exec），拿到 PID
仍从 module.js 拿：引擎目录、manifest、依赖下载、版本参数
```

**收益**：
- ✅ 拿到进程句柄（M3.5 的进程追踪/关闭游戏能落地）
- ✅ **不再改用户游戏文件**
- ✅ 不改引擎目录约定（老用户零迁移）

**成本**：4 个引擎各写 3–5 行；需自己维护「引擎 → 二进制路径」的拼法。

### 6.2 每个引擎自实现启动需要的参数

| 引擎 | 需要的数据 | 来源 |
|---|---|---|
| **nwjs** | `nwjs` 可执行文件路径（含版本） + 游戏目录 | deps 目录 + `gameArgs.version` |
| **mkxpz** | `mkxp.json` 路径（写 gameFolder/RTP/rgssVersion）+ 可执行路径 | deps + `gameArgs.RTP`/`rgssVersion` |
| **easyrpg** | `player` 路径 + `--window --project-path` | deps |
| **renpy** | `renpy` 路径 + `--savedir <存档目录>` + 游戏目录 | deps + 存档目录约定 |

**注意 mkxpz 的 RTP 推断逻辑**：上游有 `getRtpValue()`（读 `Game.ini` 的 `RTP=`，
扫 `System/RGSS*.dll` 推断）。**我们 M3 的 `diagnose.ts` 里已有等价实现**
（`decideWantedRtp` + `normalizeRtpName`），可以直接复用，不用重写。

### 6.3 风险

| # | 风险 | 处置 |
|---|---|---|
| R1 | 自己拼的命令与上游行为不一致（如路径含空格没转义） | 参考各 launcher 的 `quote()` 函数；加单测覆盖含空格/中文路径 |
| R2 | nwjs 的 `package.json` 被上游改过（chromium-args），我们不改可能行为不同 | 实测对比；若确有差异，评估是否值得手动加那一个参数 |
| R3 | 用户已装的模块是上游版本，deps 布局要匹配 | 只读 deps，不假设布局；用 manifest 的依赖名 |
| R4 | 上游未来改了 binary 路径 | 我们的路径拼法要集中在**一处**（一个 `engineBinaryPath()` 函数），便于修 |

---

## 6.4 砍 launcher 的**牵连面**（2026-11-04 实测查全）

用户问：「砍 launcher.js 之后，很多地方是不是要跟着一起改动？」

**好消息：直接冲突的只有 1 处。**

### 直接受影响（必须改）

| 位置 | 现状 | 改成 |
|---|---|---|
| `src/main/ipc.ts` 的 `launch()`（**第 425–477 行**） | `host.loadScript(engine, 'launcher.js')` → `launcher.launch(...)` | 自己拼命令 + `spawn` |

**全项目只有这一处**调用 launcher（grep 实测）。

### 会失效 / 需要调整的

| # | 位置 | 影响 | 处置 |
|---|---|---|---|
| 1 | `src/main/exec-inject.ts`（M3.5 新增，193 行） | **整个文件作废**——它的唯一目的就是「劫持 launcher 的 exec 拿 PID」，而自己 spawn 天然有 PID | 砍 launcher 后删除 |
| 2 | `core-host.ts` 的 `loadScript`（若为注入加了 hook） | hook 参数变成死代码 | 保留无 hook 路径（仍用于 `version-script`） |
| 3 | `core-host.ts` 的 `reconcileVersionArgs` | **仍需保留**——版本号拼 deps 路径的逻辑不变 | 不动 |
| 4 | `core-host.ts` 的 `reconcileAndPersistGameArgs` | 仍需（manifest 缺省值合并落盘） | 不动 |
| 5 | `diagnose.ts` 的 RTP 推断 | 上游 `getRtpValue()` 不再调用；我们的 `decideWantedRtp`/`normalizeRtpName` **已存在**，直接复用 | 不动（本来就没依赖上游） |
| 6 | 进程追踪（M3.5） | **反而更简单**：`spawn` 直接拿 `child.pid`，不用劫持 | 简化 |

### 隐性牵连：引擎参数（`DynamicArgsForm` 的 gameArgs）

`gameArgs` 的 schema 来自 `manifest.json`，但**消费它的是 `launcher.js`**。自己实现后要保证：

| 引擎 | 关键参数 | 自己实现时的用法 |
|---|---|---|
| **nwjs** | `version` | 拼 deps 路径 → 可执行文件（已有 `reconcileVersionArgs`） |
| **mkxpz** | `RTP` / `rgssVersion` / 其余透传 | 全部写进 `mkxp.json` |
| **easyrpg** | 基本无 | 命令行 `--window --project-path` |
| **renpy** | `command` | 拼进命令行尾部 |

**其余参数**（`fullscreen` 之类）上游是**原样透传**（塞 mkxp.json 或命令行），我们照做。

### ⚠️ 与 M3.5 的顺序冲突（**已决策：M3.5 照常做完**）

M3.5 在做的「劫持 `exec` 拿 PID」与本调研的「自己 `spawn` 拿 PID」**目的相同**：

```
M3.5 方案：  劫持 launcher 的 exec  → 拿 PID
砍 launcher：不用 launcher 了      → 直接 spawn → 拿 PID
```

**用户 2026-11-04 决定：让 M3.5 照常做完，之后再砍 launcher**（接受 `exec-inject.ts` 将作废）。

> 砍 launcher 时记得：**删掉 `src/main/exec-inject.ts`**，并把 `core-host.ts` 里为它加
> 的 `loadScript` hook 参数一并清掉（否则是死代码，且下一个会话会以为它还在用）。

## 7. 待确认

| # | 问题 | 本文件假设 |
|---|---|---|
| 1 | 自实现后是否保留「作弊注入」作为可选功能 | 默认**不做**，以后单独评估 |
| 2 | 是否要顺便统一 4 个引擎的「存档目录」约定（renpy 有 `--savedir`） | M4 存档管理时一起做 |
| 3 | 实施时机 | **M3.5 完成后再排**（用户明确） |
