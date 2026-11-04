// core 宿主：数据目录策略、游戏库 / 元数据 / DLsite 服务接线、detectFolder、模块路径安全工具。
//
// ===== M4.2 S4：这个文件不再装载 module.js（D63）=====
//
// 收缩前它有 752 行、装着一个 1911 行的上游 GPL 脚本（`resources/core/module.js`），
// 通过 `loadCoreFactory()` + `new Function` 手工执行。M4.2 把那个脚本整个删了，
// 于是这里的 `core` 字段、`loadCoreFactory`、`resolveCorePath`、`CoreApi` 的 18 个
// 声明全部消失。
//
// 活都去哪了（方案 §4 的改动清单是「谁接手」的权威版本）：
//   · 引擎定义          → `engines/registry.ts`（M4.1 就有）
//   · 引擎 / 依赖安装   → `engines/install.ts`
//   · 引擎识别          → `engines/detect.ts`
//   · 读写 manifest     → `engines/manifest.ts`
//   · 版本比较          → `engines/semver.ts`
//   · 启动              → `launchers/`（M4.0 就是）
//
// 这里**只留宿主自己的职责**：数据目录（含降级）、games-store / library-meta / dlsite 接线、
// 对话框桥、事件出口、请求上下文、模块路径校验、detectFolder 的候选扫描与排序。
//
// ⚠️ 本文件**不在顶层 import electron**：detectFolder / 数据目录策略 / 路径校验这些纯逻辑要能在
//    vitest 里直接跑（§8「单测里 import electron」已知坑）。需要 electron 的地方走懒加载。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { createGameStore, component, failure, type GameStore } from './games-store'
import { createDlsiteService, type DlsiteService } from './dlsite'
import { createLibraryMetaStore, type LibraryMetaStore } from './library-meta'
import { createCategoryStore, type CategoryStore } from './category-store'
import { ENGINES } from './engines/registry'
import {
  definitionsFromRegistry,
  detectEngineForPath,
  detectEngineFromDefinitions,
  getInstalledModuleFolders,
  type DetectRule
} from './engines/detect'
import { readLocalManifests, readManifest, modulesDirOf, type ManifestRaw } from './engines/manifest'

// ===== 类型 =====

// 这两个类型的**定义**在 engines/manifest.ts（磁盘 manifest 的形状归那边管），
// 这里重新导出是为了不破坏既有 import（渲染层契约、测试、ipc 都在用 `core-host` 的名字）。
export type { ManifestAutodetect, GameArgDef, ManifestRaw } from './engines/manifest'

export interface DialogBridge {
  alert(message: string, title?: string): Promise<boolean>
  confirm(message: string, title?: string): Promise<boolean>
}

export interface CoreEvent {
  event: 'progress' | 'log' | 'dialog' | 'ready' | 'gameStarted' | 'gameExited'
  requestID?: string
  name?: string
  key?: string
  detail?: unknown
  arguments?: Record<string, string>
  message?: string
  dialogID?: string
  kind?: 'alert' | 'confirm'
  title?: string
  nodeVersion?: string
  /** M3.5：进程事件带的字段（gameStarted / gameExited）。 */
  gameId?: string
  pid?: number
  engine?: string
  startedAt?: string
  exitCode?: number | null
  signal?: NodeJS.Signals | null
}

export interface RemoteManifest {
  folder: string
  name?: string
  version?: string
  author?: string
  description?: string
  raw?: ManifestRaw
  [key: string]: unknown
}

export interface ProgressBridge {
  [name: string]: (value: unknown) => void
}

export interface DetectCandidate {
  path: string
  engine: string | null
  installed: boolean
}

export interface DetectFolderResult {
  path: string
  isFile: boolean
  best: DetectCandidate | null
  candidates: DetectCandidate[]
}

export interface RequestContext {
  id?: string
  signal?: AbortSignal
}

export interface CoreHost {
  readonly dataDir: string
  /** 数据目录被降级时非 null（透传到 snapshot，设置页展示）。 */
  readonly dataDirWarning: { requested: string; switchedTo: string; code: string } | null
  readonly store: GameStore
  /** DLsite 元数据的旁挂存储（M2 §3.2；删掉它不影响启动）。 */
  readonly meta: LibraryMetaStore
  /** M5.0 S7：自定义分类（定义表 + 归属表，同在 library-meta.json 里）。 */
  readonly categories: CategoryStore
  /** DLsite 抓取服务（M2 §4；复用注入的 fetch，即 net.fetch + 系统代理）。 */
  readonly dlsite: DlsiteService
  /** 注入的 fetch（生产是 net.fetch，走系统代理；D9）。 */
  readonly fetch: (input: string, init?: unknown) => Promise<Response>
  readonly onEvent: (listener: (event: CoreEvent) => void) => () => void
  readonly emit: (event: CoreEvent) => void
  readonly runInContext: <T>(context: RequestContext, run: () => Promise<T>) => Promise<T>
  readonly currentContext: () => RequestContext | undefined
  readonly dialogs: DialogBridge
  replyDialog(dialogID: string, accepted: boolean): void
  modulesDir(): string
  /** 模块目录；符号链接模块直接拒绝（照 worker.cjs:56-61）。 */
  modulePath(folder: string): string
  /** 已安装引擎目录名（列表，不是 Set —— 渲染层 / 测试用起来更直白）。 */
  installedModules(): string[]
  /** 修正 multi-version 参数，使其与 deps 下真实安装目录一致（见函数注释）。 */
  reconcileVersionArgs(folder: string, gameArgs: Record<string, unknown>): Record<string, unknown>
  progress(): ProgressBridge
  detectFolder(input: { path: string; includeRemote?: boolean }): Promise<DetectFolderResult>
}

export interface CoreHostOptions {
  dataDir: string
  /** 数据目录被降级时的信息（resolveDataDirWithFallback 返回），透传到 snapshot 供设置页展示。 */
  dataDirWarning?: { requested: string; switchedTo: string; code: string }
  /** 注入 fetch（Electron 里传 net.fetch，测试里传全局 fetch），默认懒加载 electron 的 net.fetch。 */
  fetchImpl?: (input: string, init?: unknown) => Promise<Response>
  /**
   * 写 DLsite 需要的 `adultchecked=1` cookie（§4.2）。生产走 session.defaultSession.cookies.set；
   * 纯 Node / vitest 不传（不传就跳过，拿不到 cookie 最多是抓到年龄确认页，报 dlsiteParse）。
   */
  setAdultCookie?: () => Promise<void>
  /** DLsite 抓取的时间源 / 节流 / 超时（测试用，生产不传即默认值）。 */
  dlsiteOptions?: { now?: () => number; minIntervalMs?: number; timeoutMs?: number }
  /** 事件出口；默认什么都不做（测试用）。 */
  onEvent?: (event: CoreEvent) => void
}

// ===== 纯函数：目录 / 路径 =====

export interface DataDirOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  homedir?: string
  /** Windows 开发机上 app.getPath('userData') 的值。 */
  userData?: string
}

/**
 * 数据目录解析（§3.1 / D58）：
 * `TSUMIGEYA_DATA_DIR`（最高）> macOS 自有目录 > Windows `userData`（D4）。
 *
 * macOS 上用 `~/Library/Application Support/Tsumigeya`。
 *
 * ⚠️ D58 的历史：早期（D3）这里是 `Xenolauncher`——那是为了与上游启动器共享
 * 引擎模块目录，因为上游的 `launcher.js` 硬编码了那个路径。
 * M4.0 之后我们不再加载 `launcher.js`（启动走 `src/main/launchers/`），
 * 那条约束消失，于是换成自己的名字。
 *
 * **不做迁移**（用户 2026-11-04 拍板）：不探测旧目录、不 rename、不复制。
 * 从旧版本升级上来的用户会发现引擎与游戏库是空的，需要重新安装 / 重新添加。
 * 这是有意的取舍——详 `docs/M4.0-实施方案.md` §5。首启会给一次中文说明（见 ipc 的 `dataDirNotice`）。
 */
export function resolveDataDir(options: DataDirOptions = {}): string {
  const env = options.env ?? process.env
  const override = env.TSUMIGEYA_DATA_DIR
  if (override && override.trim()) return path.resolve(override.trim())
  const platform = options.platform ?? process.platform
  const home = options.homedir ?? os.homedir()
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Tsumigeya')
  }
  if (options.userData) return path.resolve(options.userData)
  return path.join(home, 'AppData', 'Roaming', 'tsumigeya')
}

/**
 * 建目录并 realpath 规范化（macOS /var → /private/var，也让 require 缓存失效可靠）。
 *
 * EPERM/EACCES 在 Windows 上很常见（受限账户、被安全软件锁目录、AppData 被重定向），
 * 原始错误只有一句 "operation not permitted, mkdir '...'"，用户完全不知道怎么办，
 * 所以这里改写成可操作的提示，并附上 TSUMIGEYA_DATA_DIR 的绕开办法。
 */
export function ensureDataDir(dir: string): string {
  try {
    fs.mkdirSync(dir, { recursive: true })
    return fs.realpathSync(dir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES') {
      const wrapped = failure(
        'error.dataDirPermission',
        `没有权限创建数据目录：${dir}\n` +
          `该目录被拒绝写入（${code}）。可以：\n` +
          `  1. 换一个可写目录，启动前设置环境变量 TSUMIGEYA_DATA_DIR（例如 D:\\TsumigeyaData）；\n` +
          `  2. 或检查该目录是否被安全软件/同步工具占用。`,
        { path: dir, code }
      )
      // failure() 只挂 translationKey/translationArguments，不保留 errno；降级判断要用到它，
      // 这里显式补上（否则调用方拿到的 code 是 undefined，会误判成不可降级的错误）。
      ;(wrapped as NodeJS.ErrnoException).code = code
      throw wrapped
    }
    throw error
  }
}

export interface DataDirFallback {
  /** 实际可用的数据目录。 */
  dataDir: string
  /** 首选目录不可写时的降级信息；一切正常则 undefined。 */
  warning?: { requested: string; switchedTo: string; code: string }
}

/**
 * 解析数据目录并**保证可用**：首选目录建不起来（Windows 上 AppData 被锁 / 受限账户很常见）
 * 就退到系统临时目录，并返回降级信息供 UI 提示。
 *
 * 为什么不在主进程直接抛错：whenReady 里抛错会让窗口永远不出现，用户只看到
 * 「程序没反应」，连原因都看不到。宁可降级运行 + 明确告知。
 */
export function resolveDataDirWithFallback(options: DataDirOptions = {}): DataDirFallback {
  const requested = resolveDataDir(options)
  try {
    return { dataDir: ensureDataDir(requested) }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EPERM' && code !== 'EACCES') throw error
    // 临时目录也可能不可写（本机沙箱就是这样），那就再试项目目录，最后才认输。
    const candidates = [path.join(os.tmpdir(), 'tsumigeya-data'), path.join(process.cwd(), '.dev-data')]
    for (const candidate of candidates) {
      try {
        fs.mkdirSync(candidate, { recursive: true })
        return {
          dataDir: fs.realpathSync(candidate),
          warning: { requested, switchedTo: candidate, code }
        }
      } catch {
        // 换下一个候选
      }
    }
    throw error
  }
}

// ===== detectFolder 的候选扫描（纯函数，可单测）=====

const SCAN_EXTENSIONS = ['exe', 'app', 'msi', 'bat', 'sh', 'command']
const EXT_WEIGHT: Record<string, number> = {
  app: 6,
  exe: 5,
  command: 4,
  sh: 3,
  bat: 2,
  msi: 1
}
const MAX_CANDIDATES = 200
const SKIP_DIRS = new Set(['node_modules'])

/**
 * 「看着像主程序、其实是辅助程序」的 exe 名（不含扩展名，小写）。
 *
 * 典型来源：NW.js 发行包里除了 `nw.exe`，还会带 `notification_helper.exe`、
 * `chrome_crashpad_handler.exe` 等。它们同样与 `nw.dll`/`package.json` 同级，
 * 因此也会被 autodetect 判成 nwjs——**识别没错，但拿它当启动目标就错了**。
 * 排序时把这些降到最低优先级，避免用户点了启动却拉起一个辅助进程。
 */
const HELPER_EXE_NAMES = new Set([
  'notification_helper',
  'chrome_crashpad_handler',
  'crashpad_handler',
  'crashreporter',
  'nacl64',
  'nacl_helper',
  'uninstall',
  'unins000',
  'setup',
  'installer',
  'helper',
  'elevate',
  'elevation_service'
])

/**
 * registry 的 autodetect 规则 → 「规则表」形状（`{ <folder>: {extensions?, files?, all_required?} }`）。
 *
 * ⚠️ 形状必须与旧 core 的 `fetchModulesForAutodetect()` 返回值**完全一致**：
 *     { <folder>: { extensions?: string[], files?: string[], all_required?: boolean } }
 *
 * 三个字段的语义（照抄 `module.js`，不要自己发明）：
 *   · extensions 必须**不带点号且小写** —— `normalizeExt` 会再剥一次，
 *     但双写 ".py" 会让它剥成 "" 然后被 filter 掉 → 这个扩展名规则静默失效
 *   · files 是**相对游戏目录**的路径（`.app` 包则相对包本身，见 detect.ts 的 R1 注释）
 *   · all_required 是布尔，**不要省**：省了等于 false，会让「必须全都在」的引擎
 *     （nwjs / mkxpz / renpy）变成「命中一个就算」，识别会张冠李戴
 *
 * 保留这个导出（而不是让调用方直接 `definitionsFromRegistry(ENGINES)`）的理由：
 * 它是**本文件与 ipc 的唯一共同入口**，两处各拼一次规则表迟早分叉 ——
 * 而分叉的表现是「添加游戏时认不出引擎」。
 */
export function engineDefinitionsFromRegistry(): Record<string, DetectRule> {
  return definitionsFromRegistry(ENGINES)
}

function extensionOf(p: string): string {
  return path.extname(p).replace(/^\./, '').toLowerCase()
}

function isCandidateEntry(absolutePath: string, dirent: fs.Dirent): boolean {
  const ext = extensionOf(dirent.name)
  if (!SCAN_EXTENSIONS.includes(ext)) return false
  if (ext === 'app') return dirent.isDirectory() || dirent.isSymbolicLink()
  return dirent.isFile() || dirent.isSymbolicLink() || absolutePath.length > 0
}

/** 排序：文件名含 game → 扩展名权重 → 浅层 → 字典序（§3.3 第 3 条）。 */
export function compareCandidates(a: string, b: string): number {
  const base = (s: string): string => path.basename(s).toLowerCase()
  const stem = (s: string): string => {
    const name = base(s)
    const dot = name.lastIndexOf('.')
    return dot >= 0 ? name.slice(0, dot) : name
  }

  // 辅助程序永远排最后（见 HELPER_EXE_NAMES 的注释：识别对，但启动目标不对）
  const aHelper = HELPER_EXE_NAMES.has(stem(a)) ? 1 : 0
  const bHelper = HELPER_EXE_NAMES.has(stem(b)) ? 1 : 0
  if (aHelper !== bHelper) return aHelper - bHelper

  const aGame = base(a).includes('game') ? 0 : 1
  const bGame = base(b).includes('game') ? 0 : 1
  if (aGame !== bGame) return aGame - bGame
  const aWeight = EXT_WEIGHT[extensionOf(a)] ?? 0
  const bWeight = EXT_WEIGHT[extensionOf(b)] ?? 0
  if (aWeight !== bWeight) return bWeight - aWeight
  const aDepth = a.split(/[\\/]/).length
  const bDepth = b.split(/[\\/]/).length
  if (aDepth !== bDepth) return aDepth - bDepth
  return a.localeCompare(b)
}

/**
 * 列出候选可执行文件（顶层 + 一层子目录，最多 200，跳过 node_modules 与点目录）。
 * path 若本身是文件，直接单元素返回。
 */
export function scanCandidates(target: string): { isFile: boolean; candidates: string[] } {
  const stat = fs.statSync(target)
  if (!stat.isDirectory()) return { isFile: true, candidates: [target] }

  const found: string[] = []
  const push = (dir: string, dirent: fs.Dirent): void => {
    if (found.length >= MAX_CANDIDATES) return
    const absolute = path.join(dir, dirent.name)
    if (isCandidateEntry(absolute, dirent)) found.push(absolute)
  }

  for (const dirent of fs.readdirSync(target, { withFileTypes: true })) {
    if (found.length >= MAX_CANDIDATES) break
    if (dirent.name.startsWith('.')) continue
    push(target, dirent)
    if (!dirent.isDirectory() || SKIP_DIRS.has(dirent.name)) continue
    // 只下探一层；点目录与 node_modules 跳过（.app 内部不扫，避免把 Contents/MacOS 当候选）
    if (extensionOf(dirent.name) === 'app') continue
    for (const child of fs.readdirSync(path.join(target, dirent.name), { withFileTypes: true })) {
      if (found.length >= MAX_CANDIDATES) break
      if (child.name.startsWith('.')) continue
      if (child.isDirectory() && SKIP_DIRS.has(child.name)) continue
      push(path.join(target, dirent.name), child)
    }
  }

  found.sort(compareCandidates)
  return { isFile: false, candidates: found.slice(0, MAX_CANDIDATES) }
}

// ===== 宿主 =====

const requestContext = new AsyncLocalStorage<RequestContext>()

/** 懒加载 electron：单测里不会走到这里（也就不需要 electron 模块）。 */
function electronModule(): typeof import('electron') {
  return require('electron') as typeof import('electron')
}

/**
 * 默认 fetch：生产环境走 Electron `net.fetch`（继承系统代理，D9）。
 * 纯 Node / vitest 里没有 electron 的 net，退回全局 fetch，避免"注入缺失就崩"。
 */
function defaultFetch(input: string, init?: unknown): Promise<Response> {
  try {
    const electron = electronModule() as typeof import('electron') | string
    if (typeof electron === 'object' && electron !== null && 'net' in electron && electron.net) {
      return electron.net.fetch(input, init as never) as unknown as Promise<Response>
    }
  } catch {
    // require('electron') 在纯 Node 下返回的是可执行文件路径字符串，或直接抛错
  }
  return fetch(input, init as RequestInit)
}

export function createCoreHost(options: CoreHostOptions): CoreHost {
  const dataDir = ensureDataDir(options.dataDir)
  const store = createGameStore(dataDir)
  const listeners = new Set<(event: CoreEvent) => void>()
  const pendingDialogs = new Map<
    string,
    { finish: (accepted: boolean, error?: Error) => void }
  >()

  const emit = (event: CoreEvent): void => {
    try {
      options.onEvent?.(event)
    } catch {
      /* 事件出口异常不能打断 core */
    }
    for (const listener of listeners) {
      try {
        listener(event)
      } catch {
        /* 同上 */
      }
    }
  }

  const onEvent = (listener: (event: CoreEvent) => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  const runInContext = <T>(context: RequestContext, run: () => Promise<T>): Promise<T> =>
    requestContext.run(context, run)

  const currentContext = (): RequestContext | undefined => requestContext.getStore()

  /** 对话框桥 → 事件 + 等待渲染层应答（§3.4）。 */
  function prompt(kind: 'alert' | 'confirm', message: string, title?: string): Promise<boolean> {
    const { id, signal } = currentContext() ?? {}
    signal?.throwIfAborted()
    const dialogID = randomUUID()
    return new Promise<boolean>((resolve, reject) => {
      const onAbort = (): void => finish(false, failure('error.cancelled', 'Operation cancelled'))
      const finish = (accepted: boolean, error?: Error): void => {
        pendingDialogs.delete(dialogID)
        signal?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve(accepted)
      }
      pendingDialogs.set(dialogID, { finish })
      signal?.addEventListener('abort', onAbort, { once: true })
      emit({
        event: 'dialog',
        requestID: id,
        dialogID,
        kind,
        title: String(title || 'Tsumigeya'),
        message: String(message ?? '')
      })
    })
  }

  const dialogs: DialogBridge = {
    alert: (message, title) => prompt('alert', message, title),
    confirm: (message, title) => prompt('confirm', message, title)
  }

  const replyDialog = (dialogID: string, accepted: boolean): void => {
    pendingDialogs.get(dialogID)?.finish(accepted)
  }

  const fetchImpl = options.fetchImpl ?? defaultFetch

  // M2：DLsite 旁挂存储 + 抓取服务。两者都不碰 games.json，删掉 library-meta.json 只是丢封面。
  const meta = createLibraryMetaStore(dataDir)
  // M5.0 S7（U2）：分类的读写句柄。它和 meta 共用**同一个文件**（library-meta.json），
  // 但经由不同的 store 类操作各自的顶层键 —— 分开是为了让两个模块的职责清晰，
  // 共用文件是为了让「删分类要同时动定义与归属」是一次原子写。
  const categories = createCategoryStore(dataDir)
  const dlsite = createDlsiteService({
    dataDir,
    fetch: fetchImpl,
    setAdultCookie: options.setAdultCookie,
    ...(options.dlsiteOptions ?? {})
  })

  const modulesDir = (): string => modulesDirOf(dataDir)

  /**
   * 模块目录；符号链接模块直接拒绝（照 worker.cjs:56-61）。
   *
   * 为什么必须拒绝：引擎目录是我们**会往里写文件**的地方（manifest、deps、临时解压）。
   * 一个指向 `/` 或用户重要目录的符号链接会让「安装引擎」变成「覆盖那些目录」。
   */
  function modulePath(folder: string): string {
    const target = path.join(modulesDir(), component(folder, 'module'))
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
      throw failure('error.linkedModule', 'Linked module directories are not supported.')
    }
    return target
  }

  /** 已安装引擎目录名（读的是 `modules/` 下的目录，不看 manifest，理由见 detect.ts）。 */
  const installedModules = (): string[] => getInstalledModuleFolders(dataDir)

  /**
   * 修正 gameArgs 里 multi-version 参数的值，使其与 deps 下真实安装目录一致。
   *
   * 为什么需要（实测踩坑）：上游 nwjs 在 user 没选版本时兜底
   * `gameArgs = { version: "0.106.1" }`，然后拼路径
   * `deps/version/<version>/nwjs-sdk-<version>-osx-<arch>/nwjs.app/...`。
   * 但依赖清单的 key 是 `version/v0.106.1`（**带 v**），真实目录叫 `v0.106.1`。
   * 于是兜底值拼出的路径不存在 → `exec` 找不到可执行文件 → **静默失败**，
   * 用户点启动就是「一点反应都没有」。
   *
   * 这里不改上游模块：启动前探测真实目录名，把它写进 gameArgs。
   * 目录带不带 v 都能对上；上游将来修了也不冲突。
   *
   * ⚠️ M4.2 S4：schema 的来源从 `core.readLocalManifests()` 换成
   * `readManifest(dataDir, folder)` —— 原来为了拿**一个**引擎的 gameArgs
   * 要把整个 modules 目录扫一遍并 JSON.parse 所有 manifest，启动路径上纯属浪费。
   */
  function reconcileVersionArgs(folder: string, gameArgs: Record<string, unknown>): Record<string, unknown> {
    const schema = readManifest(dataDir, folder)?.gameArgs
    if (!schema) return gameArgs

    const next: Record<string, unknown> = { ...gameArgs }
    for (const [key, def] of Object.entries(schema)) {
      if (!def || def.type !== 'multi-version') continue
      const depsDir = path.join(modulesDir(), folder, 'deps', key)
      if (!fs.existsSync(depsDir)) continue
      let installed: string | null = null
      try {
        installed =
          fs
            .readdirSync(depsDir, { withFileTypes: true })
            .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
            .map((d) => d.name)
            .sort()[0] ?? null
      } catch {
        installed = null
      }
      if (installed && next[key] !== installed) next[key] = installed
    }
    return next
  }

  /** 进度回调 → progress 事件（§3.4）。 */
  function progress(): ProgressBridge {
    const phases = ['listing', 'extracting', 'done', 'prepare', 'preserve', 'update', 'restore', 'cleanup', 'finalize']
    const bridge: ProgressBridge = {}
    for (const name of ['onStepTotal', 'onStep', 'onDownloadStart', 'onDownloadProgress', 'onDownloadEnd']) {
      bridge[name] = (value: unknown) => {
        const phase = (value as { phase?: string } | null)?.phase
        emit({
          event: 'progress',
          requestID: currentContext()?.id,
          name,
          detail: value,
          key: phase && phases.includes(phase)
            ? `progress.${phase}`
            : name.startsWith('onDownload')
              ? 'progress.download'
              : undefined
        })
      }
    }
    return bridge
  }

  async function detectFolder(input: {
    path: string
    includeRemote?: boolean
  }): Promise<DetectFolderResult> {
    if (typeof input?.path !== 'string' || !input.path.trim() || !fs.existsSync(input.path)) {
      throw failure('error.pathMissing', 'Path does not exist', { path: input?.path })
    }
    const target = path.resolve(input.path)
    const { isFile, candidates } = scanCandidates(target)
    const manifests = readLocalManifests(dataDir)
    const local: DetectCandidate[] = candidates.map((candidate) => {
      const engine = detectEngineForPath(candidate, manifests) ?? null
      return { path: candidate, engine, installed: engine !== null }
    })

    const pickBest = (list: DetectCandidate[]): DetectCandidate | null =>
      list.find((c) => c.installed && c.engine) ?? list.find((c) => c.engine) ?? null

    let best = pickBest(local)
    // M4.1 S3（D60）→ M4.2 S4（D63）：**没有「远端 autodetect」这回事了**。
    //
    // 之前：本地一个都没识别出来 → 拉 7 个模块的 autodetect 规则再猜一轮（带超时护栏）。
    // M4.1：规则来自 registry，零网络。
    // M4.2：识别函数从 `core.detectEngineFromAutodetectMap` 换成 `engines/detect.ts`，
    //       语义逐条搬过来（同一份打分算法，两个入口共用）。
    //
    // `includeRemote` 参数保留（契约不变，渲染层还在传），它现在只控制
    // 「未装引擎的规则要不要用」：
    //   includeRemote !== false → 用 registry 的规则（`installed: false`，提示「装引擎」）
    //   includeRemote === false → 只认已装模块的 manifest
    if (!best && input.includeRemote !== false) {
      const definitions = engineDefinitionsFromRegistry()
      const byRegistry = local.map((candidate) => {
        if (candidate.engine) return candidate
        const engine = detectEngineFromDefinitions(candidate.path, definitions)
        return { ...candidate, engine, installed: false }
      })
      for (let index = 0; index < byRegistry.length; index += 1) local[index] = byRegistry[index]
      best = pickBest(byRegistry)
    }

    return { path: target, isFile, best, candidates: local }
  }

  return {
    dataDir,
    dataDirWarning: options.dataDirWarning ?? null,
    store,
    meta,
    categories,
    dlsite,
    fetch: fetchImpl,
    emit,
    onEvent,
    runInContext,
    currentContext,
    dialogs,
    replyDialog,
    modulesDir,
    modulePath,
    installedModules,
    reconcileVersionArgs,
    progress,
    detectFolder
  }
}

// 这两个「读磁盘 manifest」的能力在这里重新导出：渲染层契约 / 测试 / ipc 都在
// `core-host` 这个名字下找它们（定义在 engines/manifest.ts）。
export { readLocalManifests, readManifest, modulesDirOf }
