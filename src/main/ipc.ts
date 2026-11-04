// IPC 命令表（§3.3 的 18 条）+ 串行队列 + 取消 + 对话框 + 事件推送。
// 契约：docs/M1-实施方案.md §3.3（命令表）、§3.4（事件）、§3.8（launch 自实现）。
// 范本：_xeno_probe/native/Backend/worker.cjs:373-404（队列骨架）。
//
// 设计要点（不要改）：
// - 除 pickPath / cancel / dialog 外全部走串行队列（queue = queue.then(...)）。
// - cancel 与 dialogReply **必须绕开队列**，否则 core 在队列里等应答会死锁（D12）。
// - 每个请求各自一个 AbortController，队列本身不持有取消权。
//
// ⚠️ 本文件不在顶层 import electron（与 core-host.ts 同理由）：dispatch 要在 vitest 里直接跑。
//    electron 能力通过 IpcDeps 注入（默认实现走懒加载），见 createDispatcher 的默认参数。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { component, failure, type GameDraft } from './games-store'
import { extractArchive } from './extract'
import { detectRjFromPath } from './dlsite'
import { mergeWork, normalizeEditedFields } from './library-meta'
import { diagnoseGame, type Diagnosis, type DiagnosisFix } from './diagnose'
import { groupByLanguage } from '../shared/language-group'
import type { CoreHost, CoreEvent, ProgressBridge, RemoteManifest } from './core-host'

const runFile = promisify(execFile)

/** 更新检查的整体超时（§3.3 #9 → error.updateCheckTimeout）。 */
const UPDATE_CHECK_TIMEOUT_MS = 60_000

/**
 * **绕开串行队列**的命令名单（D12 之外的正常旁路）。
 *
 * 准入标准只有两条，缺一不可：
 *   1. 只读，或只写自己的独立目录（不碰 games.json / library-meta.json / modules/）；
 *   2. 用户点一下就在等反馈——排在 60 秒的更新检查后面会表现为「界面卡死」。
 *
 * 导出的目的不是复用，是**让测试能锁死它**（test/ipc-offqueue.test.ts）。
 * 加新命令前先问自己：它写的东西和第 1 条冲突吗？冲突就老老实实进队列。
 */
export const OFF_QUEUE_METHODS: ReadonlySet<string> = new Set([
  'detect',
  'detectFolder',
  'snapshot',
  'versions',
  // M2：RJ 识别只读本地文件；DLsite 查询只写 <dataDir>/dlsite/ 自己的缓存目录（D21）。
  'dlsiteDetectRJ',
  'dlsiteLookup',
  // M2.5-A：按名字搜索——纯网络只读，**不写任何盘**，排在 60 秒更新检查后面就是「搜索按钮点了没反应」。
  'dlsiteSearch',
  // M2.5-C：多语言分组——纯本地计算，只读 games.json，毫秒级。
  'languageGroups',
  // M3：启动前诊断——纯本地文件扫描（读魔数 8 字节 / 读 Game.ini / 查目录），
  // 毫秒级、只读、不写盘。用户点「启动」就在等它，排到 60 秒更新检查后面就是「点了没反应」。
  // **repairGame 不在名单里**：它可能触发 244MB 的 RTP 下载，必须排队（§4.1）。
  'diagnoseGame'
])

/**
 * `launch` 的返回类型（M3 §4.2 扩展）。
 *
 * - 正常启动：`{ message }`
 * - 被 fatal 诊断拦下：`{ blocked: true, diagnoses }` —— UI 弹中文诊断框
 *
 * 用联合类型而不是 `{ blocked?: boolean }` 是为了让渲染层**必须**先判 `blocked`
 * 才去读 `message`（漏判会在 TS 里报错，而不是在用户面前变成 `undefined`）。
 */
export type LaunchResult = { message: string } | { blocked: true; diagnoses: Diagnosis[] }

export interface EngineUpdate {
  id: string
  localVersion: string
  remoteVersion: string
  moduleUpdate: boolean
  dependencyUpdate: boolean
  checkFailed: boolean
}

export interface EngineUpdateReport {
  checkedAt: string
  cachedRemote: boolean
  warnings: string[]
  remoteModules: RemoteManifest[]
  updates: EngineUpdate[]
}

/** IPC 层需要的宿主能力（electron 相关全部注入，便于无 GUI 测试）。 */
export interface IpcDeps {
  host: CoreHost
  /** 打开文件夹；返回空串表示成功（与 shell.openPath 语义一致）。 */
  openPath?: (target: string) => Promise<string>
  /** 打开外部链接。 */
  openExternal?: (url: string) => Promise<void>
  /** pickPath 的实际实现；默认返回 null（测试环境没有原生对话框）。 */
  pickPath?: (kind: 'file' | 'folder') => Promise<string | null>
}

function abortCheck(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}

/**
 * 模块更新的「事务」：先备份旧模块 → 执行 → 失败时整体还原（照 worker.cjs:201-225）。
 * 上游 update 会先删掉模块，所以必须还原完整原始模块（含已装的多版本）。
 */
async function moduleTransaction(host: CoreHost, folder: string, operation: () => Promise<void>): Promise<void> {
  const target = host.modulePath(folder)
  const backup = path.join(host.dataDir, '.native-backups', `${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const existed = fs.existsSync(target)
  let removeBackup = true
  if (existed) {
    fs.mkdirSync(path.dirname(backup), { recursive: true })
    fs.cpSync(target, backup, { recursive: true })
  }
  try {
    await operation()
  } catch (error) {
    fs.rmSync(target, { recursive: true, force: true })
    if (existed) {
      try {
        fs.cpSync(backup, target, { recursive: true })
      } catch (restoreError) {
        removeBackup = false
        const original = error as Error
        const restore = restoreError as Error
        throw failure(
          'error.restoreFailed',
          `${original.message}. Automatic restore failed: ${restore.message}. Original module retained at ${backup}`,
          { reason: original.message, restore: restore.message, backup }
        )
      }
    }
    throw error
  } finally {
    if (removeBackup) fs.rmSync(backup, { recursive: true, force: true })
  }
}

/**
 * openFolder 的允许范围（§3.3 #17）：数据目录内，或某个已登记游戏的目录内。
 */
export function isPathAllowed(host: Pick<CoreHost, 'dataDir' | 'store'>, target: string): boolean {
  const resolved = path.resolve(target)
  const root = path.resolve(host.dataDir)
  if (resolved === root || resolved.startsWith(root + path.sep)) return true
  for (const game of Object.values(host.store.loadGames())) {
    if (!game?.gamePath) continue
    const gamePath = path.resolve(game.gamePath)
    let gameDir = gamePath
    try {
      if (fs.statSync(gamePath).isFile()) gameDir = path.dirname(gamePath)
    } catch {
      continue
    }
    if (resolved === gameDir || resolved.startsWith(gameDir + path.sep)) return true
  }
  return false
}

export interface Dispatcher {
  dispatch(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  snapshot(): unknown
  /** 上一次 checkEngineUpdates 的报告（updateAllEngines 依赖）。 */
  engineUpdateReport(): EngineUpdateReport | null
}

/** 造一个可测试的分派器（不含任何 ipcMain 绑定）。 */
export function createDispatcher(deps: IpcDeps): Dispatcher {
  const { host } = deps
  let report: EngineUpdateReport | null = null

  function snapshot(): unknown {
    const manifests = host.core.readLocalManifests()
    return host.store.snapshot({
      modules: Object.entries(manifests).map(([id, value]) => ({ ...value, id })),
      nodeVersion: process.version,
      engineUpdates: report,
      dataDirWarning: host.dataDirWarning,
      // M2：旁挂元数据随 snapshot 一起下发（只增字段，GameRecord 不动，D18）。
      // 读失败不能让整页崩——meta 是附属品，读不出来就当没有。
      meta: readMetaSafely()
    })
  }

  function readMetaSafely(): Record<string, unknown> {
    try {
      return host.meta.load()
    } catch (error) {
      console.warn(`[tsumigeya] 读取 library-meta.json 失败（已按空处理）：${(error as Error).message}`)
      return {}
    }
  }

  // ===== 引擎更新检查（照 worker.cjs:112-152）=====

  async function checkEngineUpdates(requestSignal: AbortSignal, forceRefresh: boolean): Promise<EngineUpdateReport> {
    host.emit({ event: 'progress', requestID: host.currentContext()?.id, key: 'updates.checking', detail: {} })
    const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS)])
    const local = host.core.readLocalManifests()
    const folders = Object.keys(local)
    const warnings: string[] = []
    const failedManifests = new Set<string>()
    const failedDependencies = new Set<string>()

    let remote: RemoteManifest[] = []
    let cachedRemote = !forceRefresh
    let remoteFailed = false
    try {
      remote = await host.core.fetchRemoteManifestsList(undefined, {
        forceRefresh,
        signal,
        onFallback: (error: Error) => {
          cachedRemote = true
          warnings.push(error.message)
        },
        onManifestError: (folder: string, error: Error) => {
          failedManifests.add(folder)
          warnings.push(`${folder}: ${error.message}`)
        }
      })
    } catch (error) {
      signal.throwIfAborted()
      remoteFailed = true
      warnings.push((error as Error).message)
    }
    signal.throwIfAborted()

    const dependencyFolders = await host.core.checkDependencyUpdatesForFolders(folders, {
      forceRefresh,
      signal,
      strict: true,
      onError: (folder: string, error: Error) => {
        failedDependencies.add(folder)
        warnings.push(`${folder}: ${error.message}`)
      }
    })
    signal.throwIfAborted()

    report = {
      checkedAt: new Date().toISOString(),
      cachedRemote,
      warnings,
      remoteModules: remote.map((module) => ({ ...module, id: module.folder })),
      updates: folders.map((id) => {
        const latest = remote.find((module) => module.folder === id)
        return {
          id,
          localVersion: local[id].version || 'N/A',
          remoteVersion: latest?.version || 'N/A',
          moduleUpdate: !!latest && host.core.hasUpdate(local[id].version, latest.version),
          dependencyUpdate: dependencyFolders.has(id) && !failedDependencies.has(id),
          checkFailed: remoteFailed || failedManifests.has(id) || failedDependencies.has(id)
        }
      })
    }
    return report
  }

  // ===== 模块任务（照 worker.cjs:154-170）=====

  async function runModuleTask(folder: string, action: string, signal: AbortSignal): Promise<void> {
    host.modulePath(folder)
    const progress: ProgressBridge = host.progress()
    await moduleTransaction(host, folder, async () => {
      switch (action) {
        case 'install':
          await host.core.installModuleWithProgress(folder, host.core.DEFAULT_REPO, progress, { signal })
          break
        case 'update':
          await host.core.updateModulePreservingMultiversionsWithProgress(folder, progress, { signal, strict: true })
          break
        case 'dependencies':
          await host.core.updateDependenciesTaskWithProgress(folder, progress, { signal, strict: true })
          break
        case 'uninstall':
          host.core.uninstallModule(folder)
          break
        default:
          throw failure('error.moduleAction', 'Unknown module action', { action })
      }
      abortCheck(signal)
    })
    host.core.invalidateDepUpdatesCache()
    if (report) report.updates = report.updates.filter((item) => item.id !== folder)
  }

  // ===== 多版本引擎 =====

  function installedVersions(folder: string, argKey: string): string[] {
    const root = path.join(host.modulePath(folder), 'deps', component(argKey, 'argument'))
    if (!fs.existsSync(root)) return []
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  }

  async function versions(
    folder: string,
    argKey: string
  ): Promise<{ installed: string[]; available: Record<string, unknown> }> {
    const root = host.modulePath(folder)
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')) as {
      gameArgs?: Record<string, { type?: string; 'version-script'?: string }>
    }
    const key = component(argKey, 'argument')
    const definition = manifest.gameArgs?.[key]
    if (definition?.type !== 'multi-version') {
      throw failure('error.notMultiVersion', 'Not a multi-version parameter', { argument: key })
    }
    const provider = definition['version-script']
      ? (host.loadScript(folder, definition['version-script']) as {
          getAvailable?: (input: Record<string, unknown>, ui: unknown) => Promise<Record<string, unknown>>
        })
      : null
    const available =
      (await provider?.getAvailable?.(
        { engine: folder, argKey: key, modulesDir: host.core.getModulesDir() },
        host.dialogs
      )) ?? {}
    return { installed: installedVersions(folder, key), available: available || {} }
  }

  async function installVersion(
    folder: string,
    argKey: string,
    version: string,
    signal?: AbortSignal
  ): Promise<{ installed: string[]; available: Record<string, unknown> }> {
    component(version, 'version')
    const { available } = await versions(folder, argKey)
    const builds = available[version] as Record<string, { link?: string; unzip?: boolean }> | undefined
    const arch = os.arch() === 'x64' ? 'x86_64' : os.arch()
    const spec = builds?.universal ?? builds?.[arch]
    if (!spec?.link) throw failure('error.buildMissing', `No ${arch} build for this version`, { arch })

    const root = path.join(host.modulePath(folder), 'deps', component(argKey, 'argument'))
    const destination = path.join(root, version)
    if (fs.existsSync(destination)) throw failure('error.alreadyInstalled', 'This version is already installed', {})
    fs.mkdirSync(root, { recursive: true })

    const staging = fs.mkdtempSync(path.join(root, '.install-'))
    try {
      const response = await host.fetch(spec.link, { signal })
      if (!response.ok || !response.body) {
        throw failure('error.download', `Download failed: HTTP ${response.status}`, { status: response.status })
      }
      const name = component(path.basename(new URL(spec.link).pathname), 'archive')
      const archive = path.join(staging, name)
      const totalBytes = Number(response.headers.get('content-length')) || 0
      const file = fs.openSync(archive, 'wx')
      let downloadedBytes = 0
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          abortCheck(signal)
          fs.writeSync(file, chunk)
          downloadedBytes += chunk.length
          host.emit({
            event: 'progress',
            requestID: host.currentContext()?.id,
            name: 'onDownloadProgress',
            key: 'progress.download',
            detail: { label: version, downloadedBytes, totalBytes }
          })
        }
      } finally {
        fs.closeSync(file)
      }
      if (spec.unzip) {
        const extracted = path.join(staging, 'contents')
        await extractArchive(archive, extracted, { signal })
        fs.renameSync(extracted, destination)
      } else {
        fs.mkdirSync(destination)
        fs.renameSync(archive, path.join(destination, name))
      }
    } finally {
      fs.rmSync(staging, { recursive: true, force: true })
    }
    return { installed: installedVersions(folder, argKey), available }
  }

  // ===== launch 自实现（D5，§3.8）=====

  /**
   * 启动（D5 自实现 + M3 §4.2 启动前诊断）。
   *
   * **返回值契约扩展**（M3 引入，三处同步：ipc.ts / api/client.ts）：
   * - 正常：`{ message }`
   * - 有 fatal 诊断：`{ blocked: true, diagnoses }` —— UI 弹中文诊断框，**不抛英文错误**
   *
   * 为什么用返回值而不是抛错：抛错会走 translateError 的通用路径，
   * 而诊断需要「多条 + 每条带 fix」的结构化数据，错误对象扛不住（也会被 contextBridge 截断）。
   */
  async function launch(params: Record<string, unknown>): Promise<LaunchResult> {
    const id = String(params.id ?? '')
    const all = host.store.loadGames()
    const game = all[id]
    if (!game) throw failure('error.gameNotFound', 'Game not found', { id })

    // ---- M3 §4.2：启动前自动诊断 ----
    // 用户可关（settings.diagnoseBeforeLaunch=false → 直接按老路径走）。
    const shouldDiagnose = host.store.settings().diagnoseBeforeLaunch !== false
    if (shouldDiagnose) {
      let diagnoses: Diagnosis[] = []
      try {
        diagnoses = runDiagnose(id)
      } catch (error) {
        // 诊断自己出错绝不能拦住启动——它只是辅助（§9 R4 的精神）
        console.warn(`[tsumigeya] 启动前诊断失败（已忽略，继续启动）：${(error as Error).message}`)
      }
      if (diagnoses.some((item) => item.level === 'fatal')) {
        return { blocked: true, diagnoses }
      }
    }

    if (!fs.existsSync(game.gamePath)) {
      throw failure('error.gamePath', 'The game path no longer exists.', { path: game.gamePath })
    }
    // 按 manifest.gameArgs 合并缺省值并落盘（上游同名 API）
    host.core.reconcileAndPersistGameArgs(id)

    const launcher = host.loadScript(game.gameEngine, 'launcher.js')
    if (typeof launcher.launch !== 'function') {
      throw failure('error.launchExport', 'Module does not export launch()', { module: game.gameEngine })
    }
    const folder = fs.statSync(game.gamePath).isFile() ? path.dirname(game.gamePath) : game.gamePath

    // 修正 multi-version 参数（典型是 nwjs 的 version）：
    // 上游 launcher 在用户没选版本时兜底 "0.106.1"，但真实目录是 "v0.106.1"，
    // 拼出的路径不存在 → exec 静默失败 → 用户点启动「没反应」。
    // 见 core-host.ts 的 reconcileVersionArgs 注释。
    const gameArgs = host.reconcileVersionArgs(game.gameEngine, game.gameArgs ?? {})

    // nwjs 特殊处理：上游 launcher 用 `exec` 启动，失败只在控制台 console.error，
    // **不会把错误抛回来** → 用户看到的是「点启动一点反应都没有」。
    // 这里在调用前先确认目标可执行文件存在，不存在就给出可读的失败原因。
    if (game.gameEngine === 'nwjs') {
      const version = String(gameArgs.version ?? '')
      const arch = process.arch === 'x64' ? 'x64' : process.arch
      const nwjsBinary = path.join(
        host.modulesDir(),
        'nwjs',
        'deps',
        'version',
        version,
        `nwjs-sdk-${version}-osx-${arch}`,
        'nwjs.app',
        'Contents',
        'MacOS',
        'nwjs'
      )
      if (!fs.existsSync(nwjsBinary)) {
        throw failure(
          'error.launchFailed',
          `找不到 NW.js 运行时：${nwjsBinary}\n` +
            `请在「引擎管理」里为 NW.js 安装一个版本（当前记录的版本是 "${version || '未设置'}"）。`,
          { path: nwjsBinary, version }
        )
      }
    }

    // macOS 才补 quarantine 属性；失败只记日志、不阻塞（§3.8 第 6 步）
    if (process.platform === 'darwin') {
      void runFile('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', folder]).catch(() => undefined)
    }

    try {
      await (launcher.launch as (...args: unknown[]) => Promise<void>)(
        game.gamePath,
        folder,
        gameArgs,
        game.gameTitle ?? '',
        host.dialogs
      )
    } catch (error) {
      abortCheck(host.currentContext()?.signal)
      throw failure('error.launchFailed', (error as Error).message, { reason: (error as Error).message })
    }
    return { message: '已发送启动请求' }
  }

  // ===== M3：启动前诊断（§3 / §4.1）=====

  /**
   * 对某个游戏跑全套诊断。**只读**、不写盘，所以能进 OFF_QUEUE_METHODS。
   *
   * 依赖的输入全部来自本地：
   * - `host.store.loadGames()` → gamePath / gameEngine
   * - `host.modulesDir()` → `deps/RTP/RTP/<版本>` 的检查根
   * - `host.core.getInstalledModuleFolders()` → 到底装没装引擎模块
   *
   * 任一依赖读失败都**不能**让诊断整体抛错：诊断的价值在于「告诉用户怎么修」，
   * 它自己崩掉就又退化成「点启动没反应」。
   */
  function runDiagnose(gameId: string): Diagnosis[] {
    const game = host.store.loadGames()[gameId]
    if (!game) throw failure('error.gameNotFound', 'Game not found', { id: gameId })
    let installed: string[] = []
    try {
      installed = [...host.core.getInstalledModuleFolders()]
    } catch (error) {
      console.warn(`[tsumigeya] 读取已装引擎列表失败（按空处理）：${(error as Error).message}`)
    }
    return diagnoseGame({
      game: { gamePath: game.gamePath ?? '', gameEngine: game.gameEngine ?? '', gameArgs: game.gameArgs },
      modulesDir: host.modulesDir(),
      installedModules: installed
    })
  }

  /**
   * 执行一条修复动作（§4.1 的 repairGame）。
   *
   * 刻意**只做「有 fix 的第一条」**（§11-③ 用户确定的暂定值）：多条一起做会让用户
   * 不知道进度条在干什么，而且第一条修完可能让后面的诊断失效（例如重选路径后目录变了）。
   *
   * 每个动作的安全边界：
   * - `installRtp` / `installModule` → 复用已有的 `runModuleTask`（同一个事务与回滚，D7）
   * - `openFolder` → 走 `isPathAllowed` 白名单，**绝不开任意路径**（§3.3 #17）
   * - `repoint` → 只是告诉 UI「去编辑页重选」，主进程不猜新路径
   */
  async function repairGame(
    params: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<{ ok: boolean; action: string; message: string; diagnoses: Diagnosis[] }> {
    const gameId = String(params.gameId ?? '')
    const fix = params.fix as DiagnosisFix | undefined
    const game = host.store.loadGames()[gameId]
    if (!game) throw failure('error.gameNotFound', 'Game not found', { id: gameId })
    if (!fix || typeof fix.kind !== 'string') {
      throw failure('error.repairFixMissing', 'Missing fix action', { gameId })
    }

    abortCheck(signal)
    let message = ''
    switch (fix.kind) {
      case 'installRtp': {
        const folder = component(fix.engine, 'module')
        await runModuleTask(folder, 'dependencies', signal)
        message = 'RTP 补装完成'
        break
      }
      case 'installModule': {
        if (!fix.engine) throw failure('error.moduleMissing', 'No engine specified', { module: '' })
        const folder = component(fix.engine, 'module')
        await runModuleTask(folder, 'install', signal)
        message = '引擎安装完成'
        break
      }
      case 'openFolder': {
        const target = path.resolve(fix.path)
        if (!isPathAllowed(host, target)) {
          throw failure('error.pathNotAllowed', 'Path is not allowed to open', { path: target })
        }
        const openPath = deps.openPath ?? defaultOpenPath
        const error = await openPath(target)
        if (error) throw failure('error.pathNotAllowed', error, { path: target })
        message = '已打开游戏目录'
        break
      }
      case 'repoint':
        // 不改任何东西：让 UI 把用户带到编辑页重选路径（主进程不猜新路径）
        message = '请在编辑页重新选择游戏路径'
        break
      default:
        // 理论到不了（四个 kind 已穷尽）。留着是为了防「渲染层传来一个我们不认识的新 kind」——
        // 那种情况必须明确报错，不能静默成功（否则用户以为修好了、启动还是失败）。
        throw failure('error.repairUnknownFix', 'Unknown fix action', {
          action: String((fix as { kind: string }).kind)
        })
    }

    abortCheck(signal)
    // 修完立刻重诊断，让 UI 用最新结果刷新对话框（而不是让用户自己再点一次）
    return { ok: true, action: fix.kind, message, diagnoses: runDiagnose(gameId) }
  }

  // ===== 命令分派（§3.3 全表）=====

  async function dispatch(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<unknown> {
    switch (method) {
      case 'snapshot':
        return snapshot()

      case 'saveGame':
        host.store.saveGame({ id: params.id as string | undefined, game: params.game as GameDraft })
        return snapshot()

      case 'saveSettings':
        host.store.saveSettings(params)
        return snapshot()

      case 'deleteGame': {
        const id = String(params.id ?? '')
        const all = host.store.loadGames()
        if (!Object.hasOwn(all, id)) throw failure('error.gameNotFound', 'Game not found', { id })
        if (!(await host.core.deleteWithEngine(all[id]))) {
          throw failure('error.cleanup', 'Module cleanup failed; game was retained.', { id })
        }
        host.store.removeGame(id)
        // M2 §3.2：删游戏时同步清旁挂元数据（`dlsite/<RJ>.json` 缓存保留，可跨游戏共享）。
        // 清理失败不能让删游戏失败：games.json 才是用户数据，meta 只是附属品。
        try {
          host.meta.remove(id)
        } catch (error) {
          console.warn(`[tsumigeya] 清理 DLsite 元数据失败（已忽略）：${(error as Error).message}`)
        }
        return snapshot()
      }

      case 'launch':
        return await launch(params)

      case 'detect': {
        const target = String(params.path ?? '')
        const installed = host.core.detectEngineForPath(target, host.core.readLocalManifests())
        if (installed) return { engine: installed, installed: true }
        if (!params.includeRemote) return { engine: null, installed: false }
        const definitions = await host.core.fetchModulesForAutodetect()
        return { engine: host.core.detectEngineFromAutodetectMap(target, definitions) ?? null, installed: false }
      }

      case 'detectFolder':
        return await host.detectFolder({
          path: String(params.path ?? ''),
          includeRemote: params.includeRemote as boolean | undefined
        })

      case 'remoteModules':
        return await host.core.fetchRemoteManifestsList(undefined, { forceRefresh: true })

      case 'checkEngineUpdates': {
        try {
          return await checkEngineUpdates(signal, params.forceRefresh !== false)
        } catch (error) {
          if ((error as Error).name === 'TimeoutError') {
            throw failure('error.updateCheckTimeout', 'Engine update check timed out. Try again later.')
          }
          throw error
        }
      }

      case 'updateAllEngines': {
        if (!report) throw failure('error.checkUpdatesFirst', 'Check for engine updates first')
        const pending = report.updates.filter((item) => item.moduleUpdate || item.dependencyUpdate)
        for (const item of pending) {
          abortCheck(signal)
          host.emit({
            event: 'progress',
            requestID: host.currentContext()?.id,
            key: 'updates.updatingEngine',
            detail: {},
            arguments: { module: item.id }
          })
          try {
            await runModuleTask(item.id, item.moduleUpdate ? 'update' : 'dependencies', signal)
          } catch (error) {
            abortCheck(signal)
            throw failure('error.engineUpdateFailed', `Update failed for ${item.id}: ${(error as Error).message}`, {
              module: item.id,
              reason: (error as Error).message
            })
          }
        }
        return snapshot()
      }

      case 'moduleTask': {
        const folder = String(params.folder ?? '')
        await runModuleTask(folder, String(params.action ?? ''), signal)
        return snapshot()
      }

      case 'installedVersions':
        return installedVersions(String(params.folder ?? ''), String(params.argKey ?? ''))

      case 'versions':
        return await versions(String(params.folder ?? ''), String(params.argKey ?? ''))

      case 'installVersion':
        return await installVersion(
          String(params.folder ?? ''),
          String(params.argKey ?? ''),
          String(params.version ?? ''),
          signal
        )

      case 'removeVersion': {
        const folder = String(params.folder ?? '')
        const argKey = component(String(params.argKey ?? ''), 'argument')
        const version = component(String(params.version ?? ''), 'version')
        const root = host.modulePath(folder)
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')) as {
          gameArgs?: Record<string, { type?: string }>
        }
        if (manifest.gameArgs?.[argKey]?.type !== 'multi-version') {
          throw failure('error.notMultiVersion', 'Not a multi-version parameter', { argument: argKey })
        }
        fs.rmSync(path.join(root, 'deps', argKey, version), { recursive: true, force: true })
        return { installed: installedVersions(folder, argKey) }
      }

      case 'openFolder': {
        const target = path.resolve(String(params.path ?? ''))
        if (!isPathAllowed(host, target)) {
          throw failure('error.pathNotAllowed', 'Path is not allowed to open', { path: target })
        }
        const openPath = deps.openPath ?? defaultOpenPath
        const error = await openPath(target)
        if (error) throw failure('error.pathNotAllowed', error, { path: target })
        return { ok: true }
      }

      case 'openExternal': {
        const url = String(params.url ?? '')
        let parsed: URL
        try {
          parsed = new URL(url)
        } catch {
          throw failure('error.unsupportedProtocol', 'Unsupported URL', { url })
        }
        if (parsed.protocol !== 'https:') {
          throw failure('error.unsupportedProtocol', 'Only https: links are allowed', { url })
        }
        const openExternal = deps.openExternal ?? defaultOpenExternal
        await openExternal(parsed.toString())
        return { ok: true }
      }

      case 'pickPath': {
        const pick = deps.pickPath ?? (async () => null)
        return await pick(params.kind === 'folder' ? 'folder' : 'file')
      }

      // ===== M2：DLsite 元数据（契约 docs/M2-实施方案.md §5）=====

      case 'dlsiteDetectRJ':
        return { candidates: detectRjFromPath(String(params.path ?? '')) }

      /**
       * 只查不存：查失败绝不污染库（§5.1）。调用方拿到 work 后自己再调 saveGameMeta。
       * 这个命令写 `dlsite/<RJ>.json` 缓存，但那是**独立目录**，与队列内的写操作无共享资源（D21）。
       */
      case 'dlsiteLookup':
        return await host.dlsite.fetchWork({
          rj: String(params.rj ?? ''),
          refresh: params.refresh === true,
          signal
        })

      /**
       * M2.5-A：按名字搜索（§A.1）。
       * **只读网络、不写盘**——搜索结果只回给渲染层做候选列表，用户点选后才走 dlsiteLookup + saveGameMeta。
       * 所以它进 OFF_QUEUE_METHODS（只读且用户要立刻看到结果）。
       */
      case 'dlsiteSearch': {
        const keyword = String(params.keyword ?? '')
        const category = typeof params.category === 'string' ? params.category : undefined
        const result = await host.dlsite.searchWorks({ keyword, category, signal })
        return result
      }

      case 'saveGameMeta': {
        const gameId = String(params.gameId ?? '')
        if (!Object.hasOwn(host.store.loadGames(), gameId)) {
          throw failure('error.gameNotFound', 'Game not found', { id: gameId })
        }
        const work = params.work
        // 没传 work 但给了 rj：只存 RJ（用户先认了号、还没拉详情）
        if (work == null) {
          const rj = String(params.rj ?? '')
          if (!rj) throw failure('error.dlsiteGameRequired', 'Missing RJ number')
          const fetched = await host.dlsite.fetchWork({ rj, signal })
          host.meta.save(gameId, fetched)
        } else {
          // M2.5-B：editedFields 由渲染层显式传入（用户改了哪几个字段）。
          // 不传 → 沿用磁盘已有标记（见 library-meta 的 save 注释）。
          const editedFields =
            params.editedFields === undefined ? undefined : normalizeEditedFields(params.editedFields)
          host.meta.save(gameId, work as never, editedFields)
        }
        return snapshot()
      }

      case 'refreshGameMeta': {
        const gameId = String(params.gameId ?? '')
        if (!Object.hasOwn(host.store.loadGames(), gameId)) {
          throw failure('error.gameNotFound', 'Game not found', { id: gameId })
        }
        const current = host.meta.load()[gameId]
        if (!current?.rj) throw failure('error.dlsiteGameRequired', 'No RJ number saved for this game')
        const work = await host.dlsite.fetchWork({
          rj: current.rj,
          refresh: params.refresh !== false,
          signal
        })
        // M2.5-B（§B.2）：用户改过的字段不被新数据覆盖；其余字段全部更新。
        // force=true（「强制覆盖全部」）→ 丢掉编辑标记，整体用 DLsite 值。
        const force = params.force === true
        const merged = force ? work : mergeWork(current, work)
        host.meta.save(gameId, merged, force ? [] : undefined)
        return snapshot()
      }

      case 'clearGameMeta': {
        host.meta.remove(String(params.gameId ?? ''))
        return snapshot()
      }

      /**
       * M2.5-C：多语言版本分组（§C.2）。
       *
       * 纯本地计算：只读 games.json + DLsite 元数据（用于取标题），**不写盘、不发网络**。
       * 算法在 src/shared/language-group.ts（主进程 / 渲染层 / 测试共用一份）。
       *
       * 标题来源优先级：DLsite 元数据的 title（日文原名）→ GameRecord.gameTitle。
       * 用元数据优先是因为用户在库里存的常是中文译名，而"是不是同一款"最好按原名判断；
       * 但元数据可能不存在，所以必须有 gameTitle 兜底。
       */
      case 'languageGroups': {
        const games = host.store.loadGames()
        const metaMap = host.meta.load()
        const candidates = Object.entries(games).map(([id, record]) => ({
          id,
          // 元数据里的 title 是作者写的原名，比用户改过的库标题更适合做相似度比较；
          // 但若用户手动编辑过标题（editedFields 含 title），那应该以用户意志为准
          title: (() => {
            const meta = metaMap[id] as { title?: string; editedFields?: string[] } | undefined
            if (meta?.title && !(meta.editedFields ?? []).includes('title')) return meta.title
            return record.gameTitle
          })(),
          path: record.gamePath
        }))
        const groups = groupByLanguage(candidates, {
          threshold:
            typeof params.threshold === 'number' && Number.isFinite(params.threshold)
              ? params.threshold
              : undefined
        })
        return { groups }
      }

      /**
       * M3：启动前诊断（§4.1）。**绕队列**（纯本地只读、毫秒级）。
       * 返回结构化诊断数组；调用方（渲染层）按 `level` 决定能不能启动。
       */
      case 'diagnoseGame':
        return runDiagnose(String(params.gameId ?? ''))

      /**
       * M3：一键修复（§4.1）。**进队列**——可能触发 244MB 的 RTP 下载，
       * 与 installVersion / moduleTask 是同一类长任务（也复用同一套事务回滚）。
       */
      case 'repairGame':
        return await repairGame(params, signal)

      default:
        throw failure('error.unknownMethod', `Unknown method: ${method}`, { method })
    }
  }

  return { dispatch, snapshot, engineUpdateReport: () => report }
}

// ===== electron 默认实现（懒加载，测试环境不会走到）=====

function electronModule(): typeof import('electron') {
  return require('electron') as typeof import('electron')
}

async function defaultOpenPath(target: string): Promise<string> {
  return electronModule().shell.openPath(target)
}

async function defaultOpenExternal(url: string): Promise<void> {
  await electronModule().shell.openExternal(url)
}

export interface QueueOptions {
  /** 事件出口（默认推给所有窗口的 webContents）。 */
  sendEvent?: (event: CoreEvent) => void
}

/**
 * 把分派器接到 Electron IPC 上：串行队列 + 直连通道（cancel / dialog）+ pickPath。
 * 队列骨架照 worker.cjs:375-404。
 */
export function registerIpc(deps: IpcDeps & QueueOptions): () => void {
  const { ipcMain, dialog, BrowserWindow, shell } = electronModule()
  const pickPathImpl =
    deps.pickPath ??
    (async (kind: 'file' | 'folder') => {
      const parent = BrowserWindow.getAllWindows()[0]
      const options: Electron.OpenDialogOptions =
        kind === 'folder' ? { properties: ['openDirectory', 'createDirectory'] } : { properties: ['openFile'] }
      const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
      if (result.canceled || result.filePaths.length === 0) return null
      return result.filePaths[0]
    })

  const dispatcher = createDispatcher({
    ...deps,
    openPath: deps.openPath ?? ((target) => shell.openPath(target)),
    openExternal: deps.openExternal ?? ((url) => shell.openExternal(url)),
    pickPath: pickPathImpl
  })

  const requests = new Map<string, AbortController>()
  let queue: Promise<unknown> = Promise.resolve()

  // pickPath 直连（不进队列：它是模态对话框，进队列会卡住后面所有请求）。
  // preload 调的是 ipcRenderer.invoke('tsumi:pick')，必须在这里注册，否则 Promise 永远挂起（点击无反应）。
  ipcMain.handle('tsumi:pick', async (_event, payload: { kind?: string }) => {
    try {
      return await pickPathImpl(payload?.kind === 'folder' ? 'folder' : 'file')
    } catch {
      return null
    }
  })

  ipcMain.handle('tsumi:invoke', async (_event, request: { method?: string; params?: unknown; requestId?: string }) => {
    const method = typeof request?.method === 'string' ? request.method : ''
    const params = (request?.params ?? {}) as Record<string, unknown>
    const requestId = typeof request?.requestId === 'string' ? request.requestId : `${Date.now()}-${Math.random()}`
    if (!method) return { ok: false, error: { message: 'Missing method', key: 'error.unknownMethod' } }

    const controller = new AbortController()
    requests.set(requestId, controller)

    const runRequest = (): Promise<unknown> =>
      deps.host.runInContext({ id: requestId, signal: controller.signal }, async () => {
        try {
          controller.signal.throwIfAborted()
          const result = await dispatcher.dispatch(method, params, controller.signal)
          return { ok: true, result }
        } catch (error) {
          const aborted = controller.signal.aborted
          return {
            ok: false,
            error: {
              message: aborted ? 'Operation cancelled' : ((error as Error)?.message ?? 'Unknown error'),
              key: aborted ? 'error.cancelled' : (error as { translationKey?: string }).translationKey,
              arguments: (error as { translationArguments?: unknown }).translationArguments
            }
          }
        } finally {
          requests.delete(requestId)
        }
      })

    // **只读且用户正在等反馈**的命令不进队列：它们不写磁盘，不会与队列里的写操作冲突，
    // 但排在一个可能跑 60 秒的 checkEngineUpdates 后面，界面就表现为「永远卡住」
    // （用户实测：拖入游戏后一直停在「正在识别引擎…」，根因就是启动自动检查更新占着队列）。
    //
    // 抽成导出常量而不是内联比较，是为了让 test/ipc-offqueue.test.ts 能**锁死名单**：
    // 以后谁手滑把网络命令塞回队列，测试会先红。
    const task = OFF_QUEUE_METHODS.has(method) ? runRequest() : queue.then(runRequest)

    // 队列不能因为某个请求失败而断掉
    if (!OFF_QUEUE_METHODS.has(method)) {
      queue = task.then(
        () => undefined,
        () => undefined
      )
    }
    try {
      return await task
    } catch {
      return { ok: false, error: { message: 'Operation failed' } }
    }
  })

  // 直连：不进队列（D12）
  const onCancel = (_event: unknown, payload: { requestId?: string }): void => {
    if (typeof payload?.requestId === 'string') requests.get(payload.requestId)?.abort()
  }
  const onDialog = (_event: unknown, payload: { dialogID?: string; accepted?: boolean }): void => {
    if (typeof payload?.dialogID === 'string') deps.host.replyDialog(payload.dialogID, payload.accepted === true)
  }
  ipcMain.on('tsumi:cancel', onCancel)
  ipcMain.on('tsumi:dialog', onDialog)

  // 取消订阅函数（窗口销毁 / 热重载时用）
  return () => {
    ipcMain.removeHandler('tsumi:invoke')
    ipcMain.removeHandler('tsumi:pick')
    ipcMain.removeListener('tsumi:cancel', onCancel)
    ipcMain.removeListener('tsumi:dialog', onDialog)
    for (const controller of requests.values()) controller.abort()
  }
}
