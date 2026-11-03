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
import type { CoreHost, CoreEvent, ProgressBridge, RemoteManifest } from './core-host'

const runFile = promisify(execFile)

/** 更新检查的整体超时（§3.3 #9 → error.updateCheckTimeout）。 */
const UPDATE_CHECK_TIMEOUT_MS = 60_000

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
      dataDirWarning: host.dataDirWarning
    })
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

  async function launch(params: Record<string, unknown>): Promise<{ message: string }> {
    const id = String(params.id ?? '')
    const all = host.store.loadGames()
    const game = all[id]
    if (!game) throw failure('error.gameNotFound', 'Game not found', { id })
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

    // macOS 才补 quarantine 属性；失败只记日志、不阻塞（§3.8 第 6 步）
    if (process.platform === 'darwin') {
      void runFile('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', folder]).catch(() => undefined)
    }

    try {
      await (launcher.launch as (...args: unknown[]) => Promise<void>)(
        game.gamePath,
        folder,
        game.gameArgs ?? {},
        game.gameTitle ?? '',
        host.dialogs
      )
    } catch (error) {
      abortCheck(host.currentContext()?.signal)
      throw failure('error.launchFailed', (error as Error).message, { reason: (error as Error).message })
    }
    return { message: '已发送启动请求' }
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
    const TASK = method === 'detect' || method === 'detectFolder' || method === 'snapshot' || method === 'versions'
    const task = TASK ? runRequest() : queue.then(runRequest)

    // 队列不能因为某个请求失败而断掉
    if (!TASK) {
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
