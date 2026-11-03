// core 单例宿主：数据目录策略、module.js 装载（不用裸 require，见 §3.6）、
// getUi / getGames 桥、detectFolder 实现、模块路径安全工具。
//
// ⚠️ 本文件**不在顶层 import electron**：detectFolder / loadScript / 路径校验这些纯逻辑要能在
//    vitest 里直接跑（§8「单测里 import electron」已知坑）。需要 electron 的地方走 electronModule() 懒加载。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createGameStore, component, failure, type GameStore } from './games-store'
import { extractArchive } from './extract'

// ===== 类型 =====

export interface ManifestAutodetect {
  extensions?: string[]
  extension?: string
  files?: string[]
  all_required?: boolean
}

export interface ManifestRaw {
  name?: string
  version?: string
  author?: string
  description?: string
  autodetect?: ManifestAutodetect
  gameArgs?: Record<string, GameArgDef>
  [key: string]: unknown
}

export interface GameArgDef {
  type: 'boolean' | 'text' | 'int' | 'float' | 'dropdown' | 'select' | 'multi-version' | 'array'
  label?: string
  default?: unknown
  options?: Array<{ label?: string; value?: string | number }> | string[]
  'version-script'?: string
}

export interface DialogBridge {
  alert(message: string, title?: string): Promise<boolean>
  confirm(message: string, title?: string): Promise<boolean>
}

export interface CoreEvent {
  event: 'progress' | 'log' | 'dialog' | 'ready'
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
}

/** core 的公开 API（只声明本项目用到的部分，其余按需 as any）。 */
export interface CoreApi {
  DEFAULT_REPO: { owner: string; repo: string; branch: string }
  getModulesDir(): string
  getInstalledModuleFolders(): Set<string>
  readLocalManifests(): Record<string, ManifestRaw>
  fetchRemoteManifestsList(repo?: unknown, opts?: unknown): Promise<RemoteManifest[]>
  hasUpdate(localVersion?: string, remoteVersion?: string): boolean
  compareVersions(a?: string, b?: string): number
  installModuleWithProgress(folder: string, repo: unknown, progress: ProgressBridge, opts?: unknown): Promise<void>
  uninstallModule(folder: string): void
  updateModulePreservingMultiversionsWithProgress(
    folder: string,
    progress: ProgressBridge,
    opts?: unknown
  ): Promise<void>
  updateDependenciesTaskWithProgress(folder: string, progress: ProgressBridge, opts?: unknown): Promise<void>
  checkDependencyUpdatesForFolders(folders: string[], opts?: unknown): Promise<Set<string>>
  invalidateDepUpdatesCache(): void
  detectEngineForPath(exe: string, manifests: Record<string, ManifestRaw>): string | null
  detectEngineFromAutodetectMap(exe: string, defsMap: Record<string, unknown>): string | null
  fetchModulesForAutodetect(
    repo?: unknown,
    installedSet?: Set<string>
  ): Promise<Record<string, unknown>>
  deleteWithEngine(game: unknown): Promise<boolean>
  reconcileAndPersistGameArgs(gameId: string): unknown
  mergeGameArgsWithSchema(current: unknown, schema: unknown): { merged: unknown; changed: boolean }
  hasDependencyUpdates(folder: string): boolean
  getDependencyUpdates(folder: string): unknown
  clearDepUpdateFlag(folder: string): void
  isAppBundlePath(p?: string): boolean
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
  readonly corePath: string
  readonly store: GameStore
  readonly core: CoreApi
  /** 注入的 fetch（生产是 net.fetch，走系统代理；D9）。 */
  readonly fetch: (input: string, init?: unknown) => Promise<Response>
  readonly onEvent: (listener: (event: CoreEvent) => void) => () => void
  readonly emit: (event: CoreEvent) => void
  readonly runInContext: <T>(context: RequestContext, run: () => Promise<T>) => Promise<T>
  readonly currentContext: () => RequestContext | undefined
  readonly dialogs: DialogBridge
  replyDialog(dialogID: string, accepted: boolean): void
  modulesDir(): string
  modulePath(folder: string): string
  scriptPath(root: string, relative: string): string
  loadScript(folder: string, relative: string): Record<string, unknown>
  progress(): ProgressBridge
  detectFolder(input: { path: string; includeRemote?: boolean }): Promise<DetectFolderResult>
}

export interface CoreHostOptions {
  dataDir: string
  corePath: string
  /** 注入 fetch（Electron 里传 net.fetch，测试里传全局 fetch），默认懒加载 electron 的 net.fetch。 */
  fetchImpl?: (input: string, init?: unknown) => Promise<Response>
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
 * 数据目录解析（§3.1）：
 * `TSUMIGEYA_DATA_DIR`（最高）> macOS 与上游共享目录（D3）> Windows `userData`（D4）。
 */
export function resolveDataDir(options: DataDirOptions = {}): string {
  const env = options.env ?? process.env
  const override = env.TSUMIGEYA_DATA_DIR
  if (override && override.trim()) return path.resolve(override.trim())
  const platform = options.platform ?? process.platform
  const home = options.homedir ?? os.homedir()
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Xenolauncher')
  }
  if (options.userData) return path.resolve(options.userData)
  return path.join(home, 'AppData', 'Roaming', 'tsumigeya')
}

export interface CorePathOptions {
  env?: NodeJS.ProcessEnv
  isPackaged?: boolean
  appPath?: string
  resourcesPath?: string
}

/**
 * core 脚本路径（§3.1 末行）：`TSUMIGEYA_CORE_PATH` > 打包 `resourcesPath/core/module.js` > dev 向上探测。
 *
 * 注意 dev 下 `app.getAppPath()` 并不可靠：用 `electron <目录>` 启动时它等于项目根，
 * 但用 `electron out/main/index.js`（文件入口，本机唯一不 segfault 的启动方式）启动时它等于 `out/main`。
 * 所以这里不只拼一层，而是从 appPath 与 cwd 出发逐级向上探测，找到含 `resources/core/module.js` 的根。
 */
export function resolveCorePath(options: CorePathOptions = {}): string {
  const env = options.env ?? process.env
  const override = env.TSUMIGEYA_CORE_PATH
  if (override && override.trim()) return path.resolve(override.trim())
  if (options.isPackaged && options.resourcesPath) {
    return path.join(options.resourcesPath, 'core', 'module.js')
  }

  const relative = path.join('resources', 'core', 'module.js')
  const starts = [options.appPath, process.cwd()].filter((dir): dir is string => !!dir)
  for (const start of starts) {
    let dir = path.resolve(start)
    for (let depth = 0; depth < 6; depth += 1) {
      const candidate = path.join(dir, relative)
      if (fs.existsSync(candidate)) return candidate
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  // 都没找到就退回旧行为，让调用方拿到明确的不存在路径（错误信息更有指向性）
  return path.join(options.appPath ?? process.cwd(), relative)
}

/** 建目录并 realpath 规范化（macOS /var → /private/var，也让 require 缓存失效可靠）。 */
export function ensureDataDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  return fs.realpathSync(dir)
}

/**
 * 装载 core 工厂（§3.6）：读源码 + new Function 手工执行。
 * 不能 `require(corePath)`——Vite/rollup 会改写或外置它。
 */
export function loadCoreFactory(corePath: string): (services: Record<string, unknown>) => CoreApi {
  const source = fs.readFileSync(corePath, 'utf8')
  const mod: { exports: unknown } = { exports: {} }
  const nodeRequire = createRequire(pathToFileURL(corePath))
  const run = new Function('module', 'exports', 'require', '__filename', '__dirname', source) as (
    module: { exports: unknown },
    exports: unknown,
    require: NodeRequire,
    filename: string,
    dirname: string
  ) => void
  run(mod, mod.exports, nodeRequire, corePath, path.dirname(corePath))
  return mod.exports as (services: Record<string, unknown>) => CoreApi
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
  const lower = (s: string): string => path.basename(s).toLowerCase()
  const aGame = lower(a).includes('game') ? 0 : 1
  const bGame = lower(b).includes('game') ? 0 : 1
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

  /** core 的 ui.alert / ui.confirm → 事件 + 等待渲染层应答（§3.4）。 */
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

  const factory = loadCoreFactory(options.corePath)
  const core = factory({
    getAppSupportDir: () => dataDir,
    getGames: () => ({ loadGames: store.loadGames, saveGames: store.saveGames }),
    getUi: () => dialogs,
    extractArchive: (archive: string, destination: string, opts?: { signal?: AbortSignal }) =>
      extractArchive(archive, destination, opts ?? {}),
    fetch: (input: string, init?: unknown) => fetchImpl(input, init)
  })

  const modulesDir = (): string => path.join(dataDir, 'modules')

  /** 模块目录；符号链接模块直接拒绝（照 worker.cjs:56-61）。 */
  function modulePath(folder: string): string {
    const target = path.join(modulesDir(), component(folder, 'module'))
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
      throw failure('error.linkedModule', 'Linked module directories are not supported.')
    }
    return target
  }

  /** 脚本路径必须落在模块根目录内（照 worker.cjs:62-67）。 */
  function scriptPath(root: string, relative: string): string {
    if (typeof relative !== 'string' || path.isAbsolute(relative)) {
      throw failure('error.scriptPath', 'Invalid module script path')
    }
    let file: string
    try {
      file = fs.realpathSync(path.resolve(root, relative))
    } catch {
      throw failure('error.scriptPath', `Module script not found: ${relative}`)
    }
    if (!file.startsWith(fs.realpathSync(root) + path.sep)) {
      throw failure('error.scriptEscape', 'Module script escapes its directory')
    }
    return file
  }

  /** 清 require 缓存后加载模块脚本（launcher.js / version-script）。 */
  function loadScript(folder: string, relative: string): Record<string, unknown> {
    const root = modulePath(folder)
    if (!fs.existsSync(root)) {
      throw failure('error.moduleMissing', `Module "${folder}" is not installed. Install it in Game Engines first.`, {
        module: folder
      })
    }
    const file = scriptPath(root, relative)
    const cache = createRequire(pathToFileURL(file)).cache
    for (const key of Object.keys(cache)) {
      if (key.startsWith(root + path.sep)) delete cache[key]
    }
    return createRequire(pathToFileURL(file))(file) as Record<string, unknown>
  }

  /** core 的进度回调 → progress 事件（§3.4）。 */
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
    const manifests = core.readLocalManifests()
    const local: DetectCandidate[] = candidates.map((candidate) => {
      const engine = core.detectEngineForPath(candidate, manifests) ?? null
      return { path: candidate, engine, installed: engine !== null }
    })

    const pickBest = (list: DetectCandidate[]): DetectCandidate | null =>
      list.find((c) => c.installed && c.engine) ?? list.find((c) => c.engine) ?? null

    let best = pickBest(local)
    if (!best && input.includeRemote !== false) {
      // 未装引擎时用远端 autodetect 规则再猜一轮，命中记为 installed: false（§3.3 第 6 条）
      try {
        const definitions = await core.fetchModulesForAutodetect()
        const remote = local.map((candidate) => {
          if (candidate.engine) return candidate
          const engine = core.detectEngineFromAutodetectMap(candidate.path, definitions) ?? null
          return { ...candidate, engine, installed: false }
        })
        for (let index = 0; index < remote.length; index += 1) local[index] = remote[index]
        best = pickBest(remote)
      } catch (error) {
        emit({ event: 'log', requestID: currentContext()?.id, message: String((error as Error)?.message ?? error) })
      }
    }

    return { path: target, isFile, best, candidates: local }
  }

  return {
    dataDir,
    corePath: options.corePath,
    store,
    core,
    fetch: fetchImpl,
    emit,
    onEvent,
    runInContext,
    currentContext,
    dialogs,
    replyDialog,
    modulesDir,
    modulePath,
    scriptPath,
    loadScript,
    progress,
    detectFolder
  }
}
