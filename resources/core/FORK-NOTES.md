# FORK-NOTES — `resources/core/module.js` 与上游的差异

> ## ⚠️ 这份文件只保留作历史记录（M4.2 / D63）
>
> **`module.js` 已被删除。** M4.2 那个里程碑的目标就是「彻底零上游」，所以这一整份
> 补丁登记表现在描述的是一个**本仓库里已经不存在**的文件。
>
> 保留它的两个理由（都不是「懒得删」）：
> 1. **GPL 精神**：本仓库是 GPL-3.0，且历史上确实基于
>    [Xenolauncher](https://github.com/m5kro/Xenolauncher) 的 `app/module.js`。
>    分发时能查到「曾基于哪个上游、改了什么」，是这个许可证要求的透明度。
> 2. **考古价值**：18 个 API 的判决（自实现 7 / 替换 2 / 删除 4 / 已删 3）记在
>    `docs/M4.2-实施方案.md` §1.1。将来若有人问「为什么 `deps/RTP/RTP/` 有两层」
>    （补丁 #3 与 #7 的后果），追这段历史比读代码快。
>
> 现在的实现分布：`src/main/engines/`（registry / manifest / detect / semver / install /
> versions），启动在 `src/main/launchers/`。**这些代码是新写的，不是从下面这个文件搬过来的**
> （除了逐条照抄的语义，每条都注明了出处）。

本文件记录 `resources/core/module.js` 相对于上游
[Xenolauncher](https://github.com/m5kro/Xenolauncher) `app/module.js` 的**全部**改动。

- 上游许可：GPL-3.0（本仓库同为 GPL-3.0，见根目录 `LICENSE`）
- 本地只读参考：`_xeno_probe/app/module.js`
- **改动原则**：能不改就不改；每处改动必须打 `[Tsumigeya fork patch #N]` 注释并在此登记。
  上游升级时按本文件逐条重放补丁，而不是整体覆盖。

## 复用范围（先看这个）

- 本项目只复用上游**这一个文件**（`app/module.js` = 引擎模块系统），上游的 UI 页面、样式、NW.js 页面脚本、
  原生外壳 `worker.cjs`、翻译文件**一律没有包含**（明细见 `docs/M1-实施方案.md` §2.1）。
- 缺点（为什么不能直接覆盖更新）：本文件被改过（见下方补丁清单），所以上游升级必须**重放补丁**，不能整体拷贝覆盖。
- `module.js` 只依赖 Node 内置模块；注入 `services.extractArchive` 后，上游的可选解压依赖
  `unzipper` / `tar` / `lzma-native` 不会被 `require`，本项目无需安装它们。

## 补丁清单

### patch #1 — 允许注入自定义 `fetch`（走 Electron `net.fetch` / 系统代理）

- 位置：文件顶部 `services` 解构之后（约第 31 行）
- 新增：
  ```js
  // [Tsumigeya fork patch #1] allow injecting a custom fetch (e.g. Electron net.fetch,
  // which honors the system proxy). Falls back to the global fetch.
  const httpFetch = (...args) => (typeof services.fetch === "function" ? services.fetch(...args) : fetch(...args));
  ```
- 替换：把模块内 **5 处**裸 `fetch(` 调用改成 `httpFetch(`（其余逻辑一字未动）：
  1. `fetchRemoteManifest()` — 读单个远端 manifest
  2. `fetchRemoteManifestsListFromGitHub()` — 列 GitHub modules 目录
  3. `downloadUrlToFileWithProgress()` — 下载单个文件（带进度）
  4. `listRemoteFilesRecursive()` — 递归列远端目录
  5. `downloadDirectoryWithProgress()` — 下载整个目录（引擎安装主路径）
- 原因：国内网络环境必须走系统代理；`net.fetch` 继承 Chromium 代理设置，Node 原生 `fetch` 不继承。
  上游只在 NW.js 里跑，NW.js 的 `fetch` 本身走 Chromium 栈，所以上游没这个需求。
- 宿主注入方式（`src/main/core-host.ts`）：
  ```ts
  factory({ getUi, getGames, getAppSupportDir, extractArchive, fetch: (input, init) => net.fetch(input, init) })
  ```

### patch #2（非逻辑改动）— 行尾统一为 LF

- 上游 `app/module.js` 是 **CRLF**，本 fork 存为 **LF**（Git 友好、diff 干净）。
- 因此用普通 `diff` 对比会显示整个文件都变了，**必须**这样比较：
  ```bash
  diff -u --strip-trailing-cr _xeno_probe/app/module.js resources/core/module.js
  ```
  预期输出只有 patch #1 的 7 处增删。

## 没有改的东西（明确记录，避免"以为改过"）

- `installDependency()` 的已知上游 bug（参数错位，`module.js:1688` vs `:1646`）**保持原样不修**，
  但主进程**不暴露**该能力（见 AGENTS.md D6）。
- `launchWithEngine()` 保持原样，但主进程不用它（D5），原因是它 `void launch(...)` 吞掉 Promise，失败不可知。
- `services.extractArchive` 是**上游原有**的注入点（`module.js` 约 977 行），不是我们的补丁；
  我们只是实现了它（`src/main/extract.ts`），在 Windows/macOS 上统一用系统 `tar`（bsdtar）。
- 缓存、版本比较、autodetect 打分、依赖更新等逻辑全部未改。

## 补丁 #3 — 可选依赖失败不中断模块安装

- 位置：`installModuleDependenciesWithProgress()` 的依赖循环内部
- 新增常量（`DEFAULT_REPO` 下方）：
  ```js
  const OPTIONAL_DEP_NAMES = new Set(["soundfont"]);
  ```
- 循环体内原本是「下载 → 解压，任何错误直接抛」，现改为：
  ```js
  const isOptional =
      (builds && typeof builds === "object" && builds.optional === true) ||
      OPTIONAL_DEP_NAMES.has(String(depName).toLowerCase());
  try { /* 下载 + 解压 */ } catch (depError) {
      if (signal && signal.aborted) throw mkAbortError();
      if (!isOptional) throw depError;          // 必需依赖照旧失败
      /* 清掉半成品 + console.warn + 进度里留一条 warning，继续装下一个依赖 */
  }
  ```
- 原因：上游 `easyrpg` manifest 的 `soundfont` 依赖指向 `musical-artifacts.com`，
  该站点被 **Cloudflare 人机验证**保护，程序化请求（含 `net.fetch`、curl 带 UA）**恒定 403**，
  返回的是 "Just a moment..." 挑战页。上游因此直接 throw，导致 **EasyRPG 永远装不上**。
  而 soundfont 只是音源，缺失仅让部分音乐退化，不影响游戏运行。
- 注意：`OPTIONAL_DEP_NAMES` 是**保守白名单**，只放「已确认缺失不影响运行」的名字。
  不要为了"让安装成功"而随意扩充——那会把真正的失败掩盖掉。

## 上游同步步骤

1. 更新 `_xeno_probe`（`git -C _xeno_probe pull`，该目录不入库）。
2. `cp _xeno_probe/app/module.js resources/core/module.js`，然后把 CRLF 转成 LF。
3. 按本文件重新打 patch #1（6 处替换）。
4. `diff -u --strip-trailing-cr` 确认差异只剩补丁。
5. `npm run typecheck && npm test`（`test/detect.test.ts` 会直接 require 这份 core，能挡住语法/API 破坏）。
