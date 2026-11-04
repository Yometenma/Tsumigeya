// M4.2 S3：引擎安装 / 更新 / 卸载 + 依赖下载（D62 / D66）。
//
// ===== 这个文件替代了什么 =====
//
// 方案 §1.1 的判决：
//   · `installModuleWithProgress`              → **替换**：M4.1 已经自己写了 `installEngine`（搬进来）
//   · `updateDependenciesTaskWithProgress`     → **替换**：M3 已经自己写了 `installDependencies`（搬进来）
//   · `uninstallModule`                        → **自实现**（一个 rmSync）
//   · `updateModulePreservingMultiversions…`   → **自实现** 🔴 唯一有真实复杂度的一块（见下）
//
// 顺带把 `safeDependencyPath` 从 ipc.ts 搬来：它校验的是「依赖名 → deps 下的相对路径」，
// 属于安装链路的知识，留在 ipc 里会让「安装逻辑」被切成两半。
//
// ===== 为什么从 ipc.ts 搬走 =====
//
// 原来 `installEngine` / `installDependencies` 是 `createDispatcher()` 的**闭包**，
// 它们靠闭包拿到 `host`（modulePath / fetch / emit / dataDir）。闭包有三个代价：
//   ① 单测要造一整个 dispatcher + CoreHost 才能测一条下载逻辑（跑一遍 30 秒）
//   ② 装引擎链路无法在 `engines/` 内自洽 —— 下一个会话找 `installEngine` 会在 ipc.ts 里兜圈
//   ③ 方案 R5 要求「engines 不 import ipc」，闭包正好反过来依赖了 ipc 的上下文
//
// 所以这里改成**显式传参**：`root`（模块目录绝对路径，调用方用 `modulePath()` 拿，保留符号链接检查）
// + `definition` + `options{ fetch, signal, onProgress, arch }`。零闭包、零 import ipc。
//
// ===== 🔴 唯一真正复杂的一块：多版本保留更新（D66）=====
//
// **问题**：nwjs 的依赖是 `deps/version/v0.106.1/`（每个 NW.js 运行时一个版本目录）。
// 用户可能同时装了 v0.106.1 与 v0.119.2 给不同的游戏用。更新模块时**不能把旧版本删掉**，
// 否则用户其他 nwjs 游戏全坏。
//
// **上游做法**（`updateModulePreservingMultiversionsWithProgress`，约 80 行）：
// 读旧 manifest → 找出多版本依赖 → 建临时目录 → 装非多版本依赖 → 把旧的多版本目录 cp 过来
// → 事务替换。绕了三个目录。
//
// **我们的做法（D66 的简化）**：不绕临时目录，**原样搬回**：
//   ① 读旧 manifest，找出 `version/…` 这类多版本依赖
//   ② 把它们的 deps 子目录 **rename** 到 `<root>/.update-preserve/`（同一分区，瞬时）
//   ③ 写新 manifest（registry 生成）
//   ④ 只装**非多版本**的依赖（多版本的那些一个字节都不碰）
//   ⑤ finally 把保留的目录 rename 回原位（**成功也搬、失败也搬**）
//
// 为什么 finally 里也要搬回：失败时若不搬回，用户的运行时就被留在
// `.update-preserve/` 里 —— 目录还在但**启动路径对不上**，等于全坏。
// 外层 `moduleTransaction` 会整体还原，但它是「整目录覆盖」；把不可能出错的那一步
// 就地做完，比指望外层还原更稳。
//
// **三条不变量**（方案 §3，配测试）：
//   ① 更新后 `deps/version/v0.106.1/` **必须还在**，且内容（哈希）不变
//   ② 更新后 `deps/mkxpz/` 是**新版本**（被真的重下了一遍）
//   ③ manifest 里的 `dependencies` 键集与 registry 一致
//
// ⚠️ 关于「多版本依赖」的判据：**依赖名里含 `version/`**。
//    不要改成「deps 下有两层目录」或「名字里带 v」—— `version/v0.106.1` 是上游
//    manifest 里**唯一**的多版本形态（实测），名字形态就是最可靠的判据。
//    真出现第二种形态时，`isMultiVersionDependency` 是唯一要改的地方，且新形态
//    必须先在 registry 里出现（否则这段逻辑根本不会被触发）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { extractArchive } from '../extract'
import { component, failure } from '../games-store'
import { buildManifest } from './registry'
import { dependencyTableOf, readManifestAt } from './manifest'
import type { EngineDefinition } from './types'
import type { ManifestRaw } from './manifest'

// ===== 类型 =====

/**
 * 进度回调（形状与 `core-host.progress()` 产出的 `ProgressBridge` 对齐）。
 *
 * 这里用「回调」而不是 EventEmitter：install 是纯函数式的（不持有宿主状态），
 * 事件出口由调用方接线（ipc.ts 注入 `host.emit`，单测注入数组收集器）。
 */
export interface InstallProgressEvent {
  /** `onStep`（阶段切换）或 `onDownloadProgress`（字节进度）。 */
  name: 'onStep' | 'onDownloadProgress'
  /** i18n key（`progress.prepare` / `progress.extracting` / `progress.done` / `progress.download`）。 */
  key?: string
  detail: Record<string, unknown>
}

export interface InstallOptions {
  /** 下载器（生产是 `host.fetch`，即 `net.fetch` + 系统代理，D9）。 */
  fetch: (input: string, init?: unknown) => Promise<Response>
  signal?: AbortSignal
  onProgress?: (event: InstallProgressEvent) => void
  /**
   * 目标架构（`arm64` / `x86_64`）。默认 `os.arch()`。
   * 可注入的理由：单测要能在任意平台上验「按架构挑构建」这条分支
   * （CI 是 Linux x64，而产品目标是 mac arm64）。
   */
  arch?: string
}

/** 依赖名 → `<module>/deps/<rel>` 的相对路径（`/` 分隔）。 */
export interface DependencyEntry {
  name: string
  relative: string
  spec: { link: string; unzip?: boolean }
  optional: boolean
}

// ===== 路径与校验 =====

/** 模块目录（`<dataDir>/modules/<folder>`）。**不**做符号链接检查（那是调用方 modulePath 的责任）。 */
export function moduleRoot(dataDir: string, folder: string): string {
  return path.join(dataDir, 'modules', component(folder, 'module'))
}

/**
 * 校验并归一化「依赖名 → deps 下的相对路径」。
 *
 * 为什么不用 `component()`：`component` 的设计目的是**单个**文件/目录名，
 * 它禁止斜杠；而上游 manifest 里真实存在 `version/v0.106.1` 这种**带斜杠**的依赖名
 * （斜杠就是子目录，落地成 `deps/version/v0.106.1/`）。用 `component` 会把它们全判成非法，
 * 表现是「NW.js 装不上」—— 而且报的是一句让人摸不着头脑的 `Invalid dependency`。
 *
 * 这里放行的同时仍然挡住一切越界写法：
 *   · 绝对路径 / 盘符（`/x`、`C:`）
 *   · `..` 段（往 deps 外面爬）
 *   · 空段（`a//b`、结尾斜杠）
 *   · 反斜杠（Windows 分隔符，归一化前先拒绝，避免同一份清单在 win/mac 上跳向不同目录）
 *   · 控制字符
 *
 * 返回的是**用 `/` 分隔的相对路径**，调用方自己 `path.join` 拼（这样在两边平台都对）。
 */
export function safeDependencyPath(name: string): string {
  if (typeof name !== 'string' || !name) {
    throw failure('error.invalidComponent', 'Invalid dependency', { label: 'dependency' })
  }
  // 0x5C 是反斜杠；这里不从字符串字面量里取，免得看起来像路径拼接
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || name.includes(String.fromCharCode(92))) {
    throw failure('error.invalidComponent', `Invalid dependency "${name}"`, { dependency: name })
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) {
    throw failure('error.invalidComponent', `Invalid dependency "${name}"`, { dependency: name })
  }
  const segments = name.split('/')
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      throw failure('error.invalidComponent', `Invalid dependency "${name}"`, { dependency: name })
    }
  }
  return segments.join('/')
}

/**
 * 这个依赖是不是「多版本」形态（D66 的判据）。
 *
 * 实测：上游四个引擎里只有 nwjs 有这个形态，名字是 `version/<版本号>`。
 * 判据用**名字里含 `version/`**，而不是「有两层目录」——后者会把
 * `deps/version/` 本身也算进来，也不认 `versionX/` 这种脏名。
 */
export function isMultiVersionDependency(name: string): boolean {
  return typeof name === 'string' && name.includes('version/')
}

/**
 * `readManifestAt` / `dependencyTableOf` 都定义在 `manifest.ts`（读磁盘 manifest 是那一家的职责），
 * 这里重新导出只是让安装链路的调用方一个 import 就够（升级/更新/卸载都要读 manifest）。
 */
export { readManifestAt, dependencyTableOf }

/** 目标架构名（`x64` → `x86_64`，与 manifest 的键一致；其余原样）。 */
function resolveArch(options: InstallOptions): string {
  const raw = options.arch ?? os.arch()
  return raw === 'x64' ? 'x86_64' : raw
}

/**
 * 从一条依赖定义里挑出**本机架构**的下载描述。
 *
 * 顺序：`universal` 优先（不区分架构的依赖），否则按架构名。
 * 找不到就抛 `error.buildMissing` —— **不静默跳过**：静默跳过会让用户看到「安装完成」
 * 而引擎其实没有二进制（M3 的老坑）。
 */
function pickBuild(builds: Record<string, unknown>, arch: string, context: string): { link: string; unzip?: boolean } {
  const spec = (builds.universal ?? builds[arch]) as { link?: string; unzip?: boolean } | undefined
  if (!spec || typeof spec.link !== 'string' || !spec.link) {
    throw failure(
      'error.buildMissing',
      `No ${arch} build for ${context}`,
      context.startsWith('dependency') ? { arch } : { arch, context }
    )
  }
  // 收窄成必填（上面的 if 已经证明了，TS 不跨函数理解 `spec.link` 非空）
  return { link: spec.link, unzip: spec.unzip }
}

function abortCheck(options: InstallOptions): void {
  options.signal?.throwIfAborted()
}

function emitProgress(options: InstallOptions, event: InstallProgressEvent): void {
  try {
    options.onProgress?.(event)
  } catch {
    // 进度回调抛错不能打断安装（它与 core 的 safeCall 是同一条规矩）
  }
}

// ===== 依赖安装 =====

/**
 * 装指定的若干依赖（M3 的「一键补装 RTP」与 installEngine 都用它）。
 *
 * **为什么不用上游的** `updateDependenciesTaskWithProgress`（D38 的原始理由，保留在这里）：
 *   它走 `getDependencyUpdates`（模块自己的 updates provider），**只更新已安装的依赖**；
 *   我们在的场景恰恰是「RTP 从来没装过」—— 实测它在 entries 为空时只打一句
 *   "No dependency updates found." 就返回，**什么都不下载**。
 *   用户点「一键补装」会看到「完成」但 RTP 仍然缺失，这比不修更糟。
 *
 * **为什么不用上游的** `installModuleWithProgress`：
 *   那会把整个模块（含引擎二进制与其它依赖）全部重下一遍，只为了补一个 RTP，代价太大。
 *
 * 返回**真正装完**的依赖名列表。调用方可以据此断言「RTP 到底装上了没有」——
 * 这是 M3 修的 bug（点了修复但没装上，却报成功）。
 */
export async function installDependencies(
  root: string,
  wanted: readonly string[],
  options: InstallOptions
): Promise<string[]> {
  const target = path.join(root, 'manifest.json')
  if (!fs.existsSync(target)) {
    throw failure('error.moduleMissing', 'Module manifest not found', { module: path.basename(root) })
  }
  let manifest: ManifestRaw
  try {
    manifest = JSON.parse(fs.readFileSync(target, 'utf8')) as ManifestRaw
  } catch (error) {
    throw failure('error.invalidObject', `Invalid manifest: ${path.basename(root)}`, {
      file: `${path.basename(root)}/manifest.json`,
      reason: (error as Error).message
    })
  }

  const table = dependencyTableOf(manifest)
  const arch = resolveArch(options)
  const depsRoot = path.join(root, 'deps')
  const installed: string[] = []

  for (const name of wanted) {
    abortCheck(options)
    const builds = table[name]
    if (!builds || typeof builds !== 'object') {
      throw failure('error.dependencyMissing', `Manifest has no dependency "${name}"`, {
        dependency: name,
        module: path.basename(root)
      })
    }
    const optional = (builds as { optional?: boolean }).optional === true
    const spec = pickBuild(builds as Record<string, unknown>, arch, `dependency "${name}"`)

    // ⚠️ 依赖名**可以带斜杠**（`version/v0.106.1`，斜杠 = 子目录，
    //    落地成 `deps/version/v0.106.1/`）。校验放在 safeDependencyPath，
    //    并再用 resolve 后的前缀判断挡一次「爬出 deps」。
    const depRelative = safeDependencyPath(name)
    const depDir = path.join(depsRoot, depRelative)
    if (!depDir.startsWith(path.resolve(depsRoot) + path.sep)) {
      throw failure('error.invalidComponent', 'Invalid dependency', { dependency: name })
    }
    fs.mkdirSync(depDir, { recursive: true })

    const archiveName = component(path.basename(new URL(spec.link).pathname), 'archive')
    const archivePath = path.join(depDir, archiveName)

    let response: Response
    try {
      response = await options.fetch(spec.link, { signal: options.signal })
    } catch (error) {
      abortCheck(options)
      if (optional) {
        // 见 types.ts 的 `optional` 注释：easyrpg 的音源站有 Cloudflare 人机验证，
        // 程序化请求恒 403。可容忍失败的依赖不该让整个安装失败。
        console.warn(`[tsumigeya] 可选依赖 ${name} 下载失败（已跳过）：${(error as Error).message}`)
        continue
      }
      throw failure('error.download', `Download failed: ${(error as Error).message}`, {
        dependency: name,
        url: spec.link,
        reason: (error as Error).message
      })
    }
    if (!response.ok || !response.body) {
      if (optional) {
        console.warn(`[tsumigeya] 可选依赖 ${name} 下载失败（HTTP ${response.status}，已跳过）`)
        continue
      }
      throw failure('error.download', `Download failed: HTTP ${response.status}`, {
        status: response.status,
        url: spec.link,
        dependency: name
      })
    }

    const totalBytes = Number(response.headers.get('content-length')) || 0
    const file = fs.openSync(archivePath, 'w')
    let downloadedBytes = 0
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        abortCheck(options)
        fs.writeSync(file, chunk)
        downloadedBytes += chunk.length
        emitProgress(options, {
          name: 'onDownloadProgress',
          key: 'progress.download',
          detail: { label: name, downloadedBytes, totalBytes }
        })
      }
    } finally {
      fs.closeSync(file)
    }

    if (spec.unzip) {
      const extracted = path.join(depDir, '.extract')
      await extractArchive(archivePath, extracted, { signal: options.signal })
      // ⚠️ 这里的「拍平」只针对**无关的包裹层**，绝不针对与依赖名同名的那一层。
      //
      // §2.3 实测：RTP.zip 内部顶层就是 `RTP/<版本>/…`，而 depDir 本身已经叫
      // `deps/RTP`，所以**必须保留那层 `RTP/`**，最终才是 `deps/RTP/RTP/RPGVXace`
      // （`detectMissingRtp` 查的就是这个路径）。
      //
      // 原来写 `entries[0].name === name` 反而把 `RTP/` 拍平掉了 → 落地成
      // `deps/RTP/RPGVXace` → 诊断永远判「缺失」，用户点修复后问题依旧
      // （Windows 上恰好没暴露，Linux CI 才炸出来）。
      //
      // 规则：解压结果**有且只有一个目录**且它 **≠** 依赖名时，才当包裹层剥掉。
      const entries = fs.readdirSync(extracted, { withFileTypes: true })
      const wrap = entries.length === 1 && entries[0].isDirectory() && entries[0].name !== name
      const source = wrap ? path.join(extracted, entries[0].name) : extracted
      for (const entry of fs.readdirSync(source)) {
        const from = path.join(source, entry)
        const to = path.join(depDir, entry)
        // 目标已存在时 rename 会抛 EEXIST/ENOTEMPTY，先删再搬
        if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true })
        fs.renameSync(from, to)
      }
      fs.rmSync(extracted, { recursive: true, force: true })
      fs.rmSync(archivePath, { force: true })
    }
    installed.push(name)
  }

  return installed
}

// ===== 安装 =====

/**
 * 装一个引擎：写我们生成的 manifest + 按它装全部依赖（D62）。
 *
 * 顺序的讲究：**先写 manifest 再装依赖**。因为 `installDependencies` 是读磁盘上的
 * manifest 干活的；反过来做就得把 manifest 内容当参数传进去，等于绕开它已有的校验。
 *
 * 为什么**不删**已有目录：用户已经装了 nwjs v0.106.1，点「安装」不该把他装好的运行时删掉。
 * 这与上游 install 的「先 rmSync 整个 localRoot」不同，是**有意**的（多版本引擎必须留着）。
 *
 * ⚠️ 本函数**不套事务**：回滚责任在调用方（`runModuleTask` 的 `moduleTransaction`）。
 * 两层事务会各自备份/还原同一个目录，失败时还原顺序反了会把备份互相覆盖
 * （M4.1 S3 踩过：两边都没事务时留下「manifest 在、依赖缺一半」的半成品）。
 */
export async function installEngine(
  root: string,
  definition: EngineDefinition,
  options: InstallOptions
): Promise<string[]> {
  abortCheck(options)
  fs.mkdirSync(root, { recursive: true })

  const manifest = buildManifest(definition)
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 4), 'utf8')
  emitProgress(options, {
    name: 'onStep',
    key: 'progress.prepare',
    detail: { label: definition.name, phase: 'prepare' }
  })

  // 依赖顺序 = registry 里 `dependencies` 的声明顺序（对象键序稳定）：
  // mkxpz 本体在前、RTP / kawariki / soundfont 在后 —— 用户看到进度条先动主二进制，
  // 心理上「它在装引擎」，而不是先下 244MB 的 RTP 却不知道在装什么。
  const wanted = Object.keys(definition.dependencies)
  const installed = await installDependencies(root, wanted, options)

  emitProgress(options, {
    name: 'onStep',
    key: 'progress.done',
    detail: { label: definition.name, phase: 'done' }
  })
  return installed
}

// ===== 更新（D66 的核心）=====

export interface UpdateEngineResult {
  /** 被原样保留的多版本依赖名（`version/v0.106.1` 这类）。 */
  kept: string[]
  /** 被重新下载安装的依赖名。 */
  installed: string[]
}

/**
 * 更新一个引擎，**保住多版本依赖**（D66）。
 *
 * 步骤见文件头的「唯一真正复杂的一块」。这里补充三个**实现细节的理由**：
 *
 *   ① 用 `rename` 而不是 `cp`：保留目录动辄 100+ MB（NW.js SDK 每个版本一份），
 *      `cp` 会多花几十秒并且中途失败会留下半份。`rename` 在同分区是瞬时的。
 *      （`.update-preserve` 建在 `root` 里面，保证同分区。）
 *
 *   ② 保留的依赖**不进** `installDependencies` 的 wanted 列表：不但要保住，
 *      还要**不重下**。否则 100+ MB × N 个版本每次更新都重来一遍，且会把用户
 *      选择的那个运行时的目录内容换成本次 registry 指定的版本（错的）。
 *
 *   ③ 搬回放在 `finally`：失败时也搬回（否则用户的运行时留在 `.update-preserve/`
 *      等于全坏）。外层事务会整体还原，但这一步就地做完更稳。
 *
 * 返回值带 `kept` / `installed` 是为了让**测试能断言不变量**（方案 §3 要求三条）。
 */
export async function updateEngine(
  root: string,
  definition: EngineDefinition,
  options: InstallOptions
): Promise<UpdateEngineResult> {
  abortCheck(options)
  const previous = readManifestAt(root)
  // ① 找出旧 manifest 里所有的多版本依赖（判据见 isMultiVersionDependency）
  const keepNames = Object.keys(dependencyTableOf(previous)).filter((name) => isMultiVersionDependency(name))

  const preserveRoot = path.join(root, '.update-preserve')
  const moved: Array<{ relative: string; from: string }> = []
  try {
    fs.mkdirSync(root, { recursive: true })
    for (const name of keepNames) {
      abortCheck(options)
      const relative = safeDependencyPath(name)
      const source = path.join(root, 'deps', relative)
      if (!fs.existsSync(source)) continue // 用户没装过这个版本：没什么可保留的
      const destination = path.join(preserveRoot, relative)
      fs.mkdirSync(path.dirname(destination), { recursive: true })
      fs.renameSync(source, destination)
      moved.push({ relative, from: destination })
    }

    // ② 写新 manifest（registry 生成，D62）
    const manifest = buildManifest(definition)
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 4), 'utf8')
    emitProgress(options, {
      name: 'onStep',
      key: 'progress.prepare',
      detail: { label: definition.name, phase: 'prepare' }
    })

    // ③ 只装非多版本依赖（多版本的那些一个字节都不碰）
    //
    // ⚠️ 装之前**先把这些依赖的 deps 子目录清空**（S3 实施时才发现的一条真语义）：
    // 不清理就会变成「新 manifest + 旧二进制叠加」——
    //   · 老版本的文件留在目录里（比如旧的 `.app`、旧的 `.dll`）
    //   · 新版解压出来的文件与旧版本**同名**时才被覆盖，不同名的两份都在
    //   · 结果是最糟的一种状态：界面显示「已更新到 1.4.4」，启动时加载的却可能是旧二进制
    //
    // 这与 `installEngine` **有意**不同：安装（首次）不删是因为用户可能已经装好了运行时；
    // 更新则是「这个依赖就该换成新的」，残留旧文件没有任何好处。
    // 多版本依赖不在这个循环里 —— 它们刚被搬到 `.update-preserve/`，正在等着搬回来。
    const wanted = Object.keys(definition.dependencies).filter((name) => !isMultiVersionDependency(name))
    for (const name of wanted) {
      abortCheck(options)
      const relative = safeDependencyPath(name)
      const depDir = path.join(root, 'deps', relative)
      if (fs.existsSync(depDir)) fs.rmSync(depDir, { recursive: true, force: true })
    }
    const installed = await installDependencies(root, wanted, options)

    emitProgress(options, {
      name: 'onStep',
      key: 'progress.done',
      detail: { label: definition.name, phase: 'done' }
    })
    const kept = moved.map((item) => item.relative)
    return { kept, installed }
  } finally {
    // ④ 原样搬回（成功也搬、失败也搬）
    for (const item of moved) {
      const target = path.join(root, 'deps', item.relative)
      if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true })
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.renameSync(item.from, target)
    }
    fs.rmSync(preserveRoot, { recursive: true, force: true })
  }
}

// ===== 卸载 =====

/**
 * 卸载引擎：删掉整个模块目录。
 *
 * 一个 rmSync 就够 —— **不需要**清理 `deps` 里的多版本运行时之外的任何东西：
 * 卸载的语义就是「这个引擎我不要了」，用户装过的运行时也一起删才是用户预期。
 * （对比 updateEngine：那里是「我还要用，只是刷新定义」，所以必须保住。）
 *
 * 回滚责任同样在调用方（`moduleTransaction` 已备份整目录）。
 * 目录不存在时静默成功 —— 卸载本来就该幂等。
 */
export function uninstallEngine(root: string): void {
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true })
}

// ===== 给测试用的最小导出 =====

/** 依赖名列表（测试断言「装了什么」用；不参与运行逻辑）。 */
export function dependencyNames(root: string): string[] {
  return Object.keys(dependencyTableOf(readManifestAt(root)))
}
