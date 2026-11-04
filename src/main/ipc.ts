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
import { execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { component, failure, type GameDraft } from './games-store'
import { extractArchive } from './extract'
import { detectRjFromPath } from './dlsite'
import { mergeWork, normalizeEditedFields } from './library-meta'
import { diagnoseGame, type Diagnosis, type DiagnosisFix } from './diagnose'
import { DATA_DIR_NOTICE_KEY, DATA_DIR_NOTICE_TEXT, shouldShowDataDirNotice } from './data-dir-notice'
import { createPlayStatsStore, sessionSeconds, type PlayStatsStore } from './play-stats'
import { engineDefinitionsFromRegistry } from './core-host'
import {
  createProcessRegistry,
  describeLaunch,
  isProcessAlive,
  looksLikeSameExecutable,
  processCommand,
  sendSignal,
  waitForExit,
  type ProcessRegistry,
  type RunningGame
} from './process-registry'
import { buildLaunchPlan } from './launchers'
import { describeSpawnFailure, spawnGame } from './launchers/spawn'
import type { LaunchPlan } from './launchers/types'
import { groupByLanguage } from '../shared/language-group'
// M4.1 S2（D60）：引擎清单的唯一来源。这里**不再 import core 的远端拉取能力**。
import { ENGINES, ENGINE_FOLDERS, GENERATED_MANIFEST_AUTHOR, buildManifest, findEngine } from './engines/registry'
import { fetchNwjsVersions } from './engines/versions'
import type { CoreHost, CoreEvent, ProgressBridge, RemoteManifest } from './core-host'

const runFile = promisify(execFile)

/**
 * 更新检查的整体超时（§3.3 #9 → error.updateCheckTimeout）。
 *
 * ⚠️ M4.1 S2 之后这条**不再被 checkEngineUpdates 使用**：那次检查已经不联网了，
 * 毫秒级返回，没有需要超时护栏的东西。
 *
 * 保留它的两个理由：
 *   1. `checkEngineUpdates` 的**调用方**（渲染层的 task store / App.vue 的启动自检）
 *      仍然按「这是个长任务、可能超时」的契约在跑，错误分支里的
 *      `error.updateCheckTimeout` 文案也还在 locales 里；
 *   2. 它把「更新检查最多该花多久」这个**约束**写在了代码里。
 *      将来若有人给检查加了网络步骤（例如校验下载地址可达性），必须重新套上这个护栏，
 *      而不是先跑起来再说 —— 那正是 M1 时代「启动自检堵死队列」的老坑。
 */
export const UPDATE_CHECK_TIMEOUT_MS = 60_000

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
  'diagnoseGame',
  // M3.5：进程表只在内存里（D50），读它是 O(n) 的内存遍历，连盘都不碰。
  // 详情页一进去就要知道「在不在跑」，排在更新检查后面就是「进来先转圈 60 秒」。
  // **stopGame 不在名单里**：它要等进程退出（最多 5 秒），必须排队。
  'runningGames'
])

/**
 * `launch` 的返回类型（M3 §4.2 扩展；M3.5 再加 running 信息）。
 *
 * - 正常启动：`{ message }`
 * - 被 fatal 诊断拦下：`{ blocked: true, diagnoses }` —— UI 弹中文诊断框
 *
 * 用联合类型而不是 `{ blocked?: boolean }` 是为了让渲染层**必须**先判 `blocked`
 * 才去读 `message`（漏判会在 TS 里报错，而不是在用户面前变成 `undefined`）。
 */
export type LaunchResult = { message: string } | { blocked: true; diagnoses: Diagnosis[] }

/** `stopGame` 的返回（M3.5 §6）。 */
export interface StopGameResult {
  ok: boolean
  /** `terminated` = SIGTERM 就退了；`killed` = 等到 5 秒没退，走了 SIGKILL。 */
  action: 'terminated' | 'killed'
  /** i18n key（不是原文，渲染层自己查 locales —— §3.9 的老规矩）。 */
  messageKey: string
}

/** 进程表 / 游玩记录的接线（注入以便单测替身，生产用默认实现）。 */
export interface ProcessDeps {
  registry?: ProcessRegistry
  playStats?: PlayStatsStore
  /** 存活判定（单测可替换成假的，免得依赖真实进程）。 */
  isAlive?: (pid: number) => boolean
  /** 等待退出（单测可替换，避免真的等 5 秒）。 */
  waitExit?: (pid: number, timeoutMs: number) => Promise<boolean>
  /** 发信号（单测可替换，避免真的 kill）。 */
  signal?: (pid: number, name: NodeJS.Signals) => boolean
  /** 取 PID 当前的可执行文件名（PID 复用复核）。 */
  probeCommand?: (pid: number) => Promise<string | null>
  /** SIGTERM 之后等多久再 SIGKILL（D52：5 秒）。 */
  terminateGraceMs?: number
  /** SIGKILL 之后等多久确认退出（不阻塞用户太久）。 */
  killGraceMs?: number
  /**
   * 启动过程的注入点（M4.0 S5）。
   *
   * 为什么需要：单测要验「进程表 / 游玩记录 / 事件」的接线，而那些是**决策**；
   * 真起子进程会让单测变慢且依赖平台（本机 Windows、CI Linux、目标是 mac）。
   * 默认用真的 `spawnGame`，测试传假的替身即可。
   *
   * `stopGame` 只碰进程表，与这里无关。
   */
  spawn?: typeof spawnGame
}

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
  /** M3.5：进程表 / 游玩记录的替身（不传即用默认实现，真实进程 + play-stats.json）。 */
  process?: ProcessDeps
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
 * 校验并归一化「依赖名 → deps 下的相对路径」（M4.1 S3）。
 *
 * 为什么不用 `component()`：`component` 的设计目的是**单个**文件/目录名，
 * 它禁止斜杠；而上游 manifest 里真实存在 `version/v0.106.1` 这种**带斜杠**的依赖名
 * （斜杠就是子目录，落地成 `deps/version/v0.106.1/`）。用 `component` 会把它们全判成非法，
 * 表现是「NW.js 装不上」——而且报的是一句让人摸不着头脑的 `Invalid dependency`。
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
  /** M3.5：进程表的只读视图（测试与内部使用；IPC 走 `runningGames` 命令）。 */
  runningGames(): RunningGame[]
}

/** 造一个可测试的分派器（不含任何 ipcMain 绑定）。 */
export function createDispatcher(deps: IpcDeps): Dispatcher {
  const { host } = deps
  let report: EngineUpdateReport | null = null

  // ===== M3.5：进程追踪 + 游玩记录（D48–D52）=====
  //
  // 三个对象都是**每个 dispatcher 一份**：进程表是运行时事实（D50，不落盘），
  // 游玩记录落独立的 play-stats.json（D51）。
  const registry: ProcessRegistry = deps.process?.registry ?? createProcessRegistry()
  const playStats: PlayStatsStore = deps.process?.playStats ?? createPlayStatsStore(host.dataDir)
  const isAlive = deps.process?.isAlive ?? isProcessAlive
  const waitExit = deps.process?.waitExit ?? ((pid: number, ms: number) => waitForExit(pid, ms))
  const sendSignalImpl = deps.process?.signal ?? sendSignal
  const probeCommand = deps.process?.probeCommand ?? processCommand
  /** D52：温和优先（游戏可能要存档），卡死也要能救。 */
  const terminateGraceMs = deps.process?.terminateGraceMs ?? 5_000
  const killGraceMs = deps.process?.killGraceMs ?? 2_000
  /** 默认用真的 spawn；单测注入替身（见 ProcessDeps.spawn 的注释）。 */
  const spawnImpl = deps.process?.spawn ?? spawnGame

  /** M3.5：正在运行的游戏（只读内存快照，绕队列）。 */
  function runningGames(): RunningGame[] {
    return registry.list()
  }

  /**
   * 关闭游戏（M3.5 §6，D52）。
   *
   * 两段式：SIGTERM（给游戏存档机会）→ 等 5 秒 → SIGKILL（卡死也要能救）。
   *
   * PID 复用防护（§6 风险 / §9 R3）：
   * 退出监听会立刻 `registry.remove`，所以正常情况这里不会对着一个已死的 PID 动手。
   * 但万一退出回调丢了（上游杀法异常、或我们在退出的瞬间去点关闭），
   * `ps -p` 复核一次「这个号现在跑的是不是当初那个可执行文件」。
   * 复核结果是「明确不像」→ 拒绝并清掉脏记录；「不确定」→ 照常动手但记日志
   * （宁可让用户看到「已关闭」而它其实早就退出了，也不要完全失去关闭能力）。
   */
  async function stopGame(params: Record<string, unknown>): Promise<StopGameResult> {
    const gameId = String(params.gameId ?? params.id ?? '')
    if (!gameId) throw failure('error.gameNotFound', 'Game not found', { id: gameId })
    const entry = registry.get(gameId)
    if (!entry) throw failure('error.gameNotRunning', 'Game is not running.', { id: gameId })

    if (!isAlive(entry.pid)) {
      // 进程其实早就没了（退出回调没到）：清掉脏记录，别让 UI 一直显示「运行中」
      registry.remove(gameId, entry.pid)
      throw failure('error.gameNotRunning', 'Game is not running.', { id: gameId })
    }

    const actual = await probeCommand(entry.pid)
    const same = looksLikeSameExecutable(entry.execPath, actual)
    if (same === false) {
      registry.remove(gameId, entry.pid)
      throw failure('error.gameNotRunning', 'Game is not running.', { id: gameId })
    }
    if (same === null) {
      console.warn(
        `[tsumigeya] 无法复核 PID ${entry.pid} 的可执行文件（记录 ${entry.execPath ?? '未知'} / 实际 ${actual ?? '未知'}），仍按记录关闭`
      )
    }

    // ① 温和
    sendSignalImpl(entry.pid, 'SIGTERM')
    if (await waitExit(entry.pid, terminateGraceMs)) {
      return { ok: true, action: 'terminated', messageKey: 'library.stopGraceful' }
    }
    // ② 还在，强杀
    sendSignalImpl(entry.pid, 'SIGKILL')
    await waitExit(entry.pid, killGraceMs)
    return { ok: true, action: 'killed', messageKey: 'library.stopKilled' }
  }

  function snapshot(): unknown {
    const manifests = host.core.readLocalManifests()
    return host.store.snapshot({
      // ⚠️ M4.1 S4 修的真 bug（M1 时代就存在，被端到端探针抓到）：
      //
      // 原来这里只写 `{ ...value, id }` —— manifest 的内容**摊平在顶层**，
      // 于是 `modules[]` 里**没有 `raw` 字段**。而渲染层 `ModuleInfo` 的类型声明写的是
      // `raw: ManifestRaw`（M1 就这么声明的），`GameEditPage` 的
      // `manifest = module?.raw ?? null` 因此**永远是 null** →
      // 引擎参数表单对所有引擎都显示「该引擎没有可配置参数」。
      //
      // 这是一个**类型声明与真实数据不符**造成的静默失败：TS 检查通过、页面不报错、
      // 只是参数表单整块不见。单测抓不到（没人断言 snapshot 的 modules 形状），
      // 只有端到端探针能发现。
      //
      // 修法：**同时**给 `raw` 和摊平字段。
      //   · `raw` 给新代码用（`ModuleInfo` 的类型声明的就是这个）
      //   · 摊平字段保留，因为既有代码在读它们（引擎页的 displayName / moduleVersion /
      //     moduleDescription 都是 `module.raw` 缺失时回退到顶层 `module.name` 等）
      // 这样两种读法都能工作，不破坏任何既有行为。
      modules: Object.entries(manifests).map(([id, value]) => ({ ...value, id, raw: value })),
      nodeVersion: process.version,
      engineUpdates: report,
      dataDirWarning: host.dataDirWarning,
      // M2：旁挂元数据随 snapshot 一起下发（只增字段，GameRecord 不动，D18）。
      // 读失败不能让整页崩——meta 是附属品，读不出来就当没有。
      meta: readMetaSafely(),
      // M3.5：运行态（只读投影，D50 不落盘）。少带 command/execPath：UI 用不到，
      // 而且命令串里可能有用户的本地路径，没必要过桥。
      running: registry.list().map((item) => ({
        gameId: item.gameId,
        pid: item.pid,
        startedAt: item.startedAt
      })),
      // M4.0 S6.5（D58）：数据目录切换的一次性说明。
      // 判定在 data-dir-notice.ts（纯函数、有单测）；这里只负责「这次该不该给」。
      dataDirNotice: takeDataDirNotice()
    })
  }

  /**
   * 取「数据目录已切换」这条一次性说明（**取到即落标记**，保证只提示一次）。
   *
   * 为什么在 snapshot 里做：snapshot 是渲染层每次进主界面都会读的东西，
   * 是「首次运行」最自然的触发点，不需要额外加一条 IPC 命令。
   *
   * ⚠️ snapshot 是**绕队列**的只读命令（OFF_QUEUE_METHODS）。这里写了一次 settings
   * 标记——看起来违反「只读」准入标准。判断如下：
   *   · 写的是自己的 `global-settings.json`，且只在「首启且目录为空」时发生一次
   *   · 它读的 modules/games.json 也都是自己的
   *   · 反面代价（把这条提示挪进队列）是：首启时 snapshot 排在 60 秒更新检查后面，
   *     用户要在空白界面干等——那正是 M1 的老问题
   *   所以保留在 snapshot 里，但**标记写失败不抛**（提示丢了也不能让 snapshot 崩）。
   */
  function takeDataDirNotice(): string | null {
    let settings: Record<string, unknown> = {}
    try {
      settings = host.store.settings() as unknown as Record<string, unknown>
    } catch {
      return null
    }
    const should = shouldShowDataDirNotice({ dataDir: host.dataDir, settings, platform: process.platform })
    if (!should) return null
    try {
      host.store.saveSettings({ [DATA_DIR_NOTICE_KEY]: true })
    } catch (error) {
      console.warn(`[tsumigeya] 写数据目录提示标记失败（已忽略，下次还会提示）：${(error as Error).message}`)
    }
    return DATA_DIR_NOTICE_TEXT
  }

  function readMetaSafely(): Record<string, unknown> {
    try {
      return host.meta.load()
    } catch (error) {
      console.warn(`[tsumigeya] 读取 library-meta.json 失败（已按空处理）：${(error as Error).message}`)
      return {}
    }
  }

  // ===== 引擎更新检查（M4.1 S2：不再有「远端清单」）=====
  //
  // 改了什么（D60）：
  //
  //   之前：`core.fetchRemoteManifestsList()` 拉 7 个模块的 manifest → 拿它的 version 比对本地
  //   之后：**registry 的硬编码 version** 就是「远端版本」，一个网络请求都不发
  //
  // 语义变化（R5 已预告）：`remoteVersion` 现在是**我们维护的版本号**，不是上游此刻的版本。
  // 好处是「检查更新」从「等 GitHub」变成「毫秒级本地比对」；
  // 代价是上游发了新版我们不会知道 —— 那由我们手动改 registry（D60 显式接受）。
  //
  // `cachedRemote` 保留但**恒为 false**：它原来的含义是「这次用的是磁盘上的旧远端缓存」，
  // 现在没有远端也就没有缓存。保留字段是为了**不破坏 Snapshot/Report 的数据结构**
  // （渲染层还在读它，删字段会让老页面读到 undefined）。新会话看到它恒 false 是**正确的**，
  // 不是「忘了实现」。
  //
  // ===== 依赖更新检查：**明确停用**（不是漏写）=====
  //
  // 它原来是「上游模块的 `updates.js` 说某个依赖包有新版本了」。
  // 但 `updates.js` 是**模块文件的一部分**，而我们不再下载模块文件（S3 起只生成 manifest）：
  // `buildManifest()` 也就不写 `updates: true` 字段，于是 core 的 `loadUpdatesProvider`
  // 直接返回 null → `checkDependencyUpdatesForFolders` 对这四个引擎永远返回空集。
  //
  // 所以这里**不做那次调用**：留着它只会白扫一遍目录，还让人以为「依赖更新功能还在」。
  // `dependencyUpdate` 字段保留（恒 false）——理由同 `cachedRemote`：不破坏既有数据结构。
  //
  // ⚠️ 与 `moduleTask('dependencies')` 的关系：那条命令**保留**（见 runModuleTask 的注释），
  //    因为它对「用户目录里残留的旧版模块」仍然有效。只是我们的引擎不会再有新依赖可更。
  async function checkEngineUpdates(requestSignal: AbortSignal): Promise<EngineUpdateReport> {
    host.emit({ event: 'progress', requestID: host.currentContext()?.id, key: 'updates.checking', detail: {} })
    // 取消信号仍然要尊重（用户点了取消，跑完这一遍就该停）。
    // 原来那个 60 秒超时护栏是给**网络请求**准备的；现在这一步不发网络请求，
    // 但保留 signal 的取消语义：后面即使加了慢操作，也不会变成「取消无效」。
    requestSignal.throwIfAborted()
    const local = host.core.readLocalManifests()
    const folders = Object.keys(local)
    const warnings: string[] = []

    // 本地装了什么 vs registry 认什么。两头都列，才能回答三个问题：
    //   ① registry 里有但没装 → 「可安装」（列表已由 remoteModules 给出，这里不重复）
    //   ② 装了但 registry 里没有 → 「这个引擎我们不再维护」（旧版留下的 ruffle/wine/macos 就是这种）
    //   ③ 装了且 registry 里有 → 比版本号
    const stale: string[] = []
    for (const folder of folders) {
      if (!findEngine(folder)) stale.push(folder)
    }
    if (stale.length > 0) {
      // 这是一条**普通信息**，不是错误：用户装的旧引擎我们不再支持，不需要他做什么。
      // 用 warning 数组的通道传出去（渲染层已经会把它画成 el-alert）。
      warnings.push(`已安装但本程序不再维护的引擎：${stale.join(' / ')}（可以卸载，不影响其它引擎）`)
    }

    report = {
      checkedAt: new Date().toISOString(),
      // 见上面的注释：没有远端缓存了，恒 false
      cachedRemote: false,
      warnings,
      // 「可安装的引擎」= registry 里那四个（**天生只有四个**，不需要过滤）
      remoteModules: remoteModulesFromRegistry(),
      updates: folders.map((id) => {
        const expected = findEngine(id)
        return {
          id,
          localVersion: local[id].version || 'N/A',
          // 我们不再维护的引擎：不报「有更新」，也没有「远端版本」
          remoteVersion: expected?.version || 'N/A',
          moduleUpdate: !!expected && host.core.hasUpdate(local[id].version, expected.version),
          // 见上面的「依赖更新检查：明确停用」
          dependencyUpdate: false,
          checkFailed: false
        }
      })
    }
    return report
  }

  /**
   * registry → 渲染层要的 RemoteModule 形状。
   *
   * 为什么还要转一层：`RemoteModule` 是渲染层的既有类型（`{id, folder, name, version,
   * author, description, raw}`），`raw` 里装着完整 manifest。转成它**零成本**，而且：
   *   · 引擎页的「可安装」列表一行代码都不用改（它读的就是这个形状）
   *   · 装引擎时 `raw` 就是我们要写进磁盘的 manifest（S3 用它落盘）
   */
  function remoteModulesFromRegistry(): RemoteManifest[] {
    return ENGINES.map((engine) => {
      const raw = buildManifest(engine) as unknown as RemoteManifest['raw']
      return {
        folder: engine.folder,
        id: engine.folder,
        name: engine.name,
        version: engine.version,
        author: GENERATED_MANIFEST_AUTHOR,
        description: engine.description,
        raw
      }
    })
  }

  // ===== 模块任务（照 worker.cjs:154-170）=====

  async function runModuleTask(folder: string, action: string, signal: AbortSignal): Promise<void> {
    host.modulePath(folder)
    const progress: ProgressBridge = host.progress()

    switch (action) {
      // 安装 / 更新：两条路径**都走我们自己的安装**（M4.1 S3）。
      //
      // 为什么「更新」也走这里：上游的 update 是
      // 「备份多版本目录 → 删模块 → 重新下载整个模块目录 → 还原多版本目录」。
      // 我们不再下载模块目录了，所以「更新」本质上就是
      // 「换一份新的 manifest + 补齐缺的依赖」，而多版本目录本来就不会被删（见 installEngine 的注释）。
      // 所以 update 的语义从「重装模块」变成「刷新 manifest 到 registry 的版本」——
      // 这正是 R5 说的「版本对比用 registry 的 version」。
      //
      // 例外：如果 module 里有 `updates.js`（用户从旧版升级上来、还留着上游的文件），
      // 那 `dependencies` 动作仍然走 core（那些旧文件我们不该动，也不该假装没有）。
      case 'install':
      case 'update':
        // ⚠️ **必须套 moduleTransaction**（M4.1 S3 修的真 bug）：
        // 本鱼第一版写成 `await installEngine(folder, signal)` —— 而 installEngine 内部
        // 因为「不能嵌套两层事务」把事务删掉了，结果两边都没有事务 → **安装失败时
        // 磁盘上留下半个模块目录（manifest 在、依赖缺一半）**，比装不上更糟：
        // 它会显示「已安装」，启动时却找不到二进制。
        // 事务的责任留在这一层（installEngine 只管写 manifest + 装依赖）。
        await moduleTransaction(host, folder, async () => {
          await installEngine(folder, signal)
        })
        break
      case 'dependencies':
        // 只补依赖、不动 manifest。这对**旧版残留模块**仍有用（它们的 updates.js 还在）。
        await moduleTransaction(host, folder, async () => {
          await host.core.updateDependenciesTaskWithProgress(folder, progress, { signal, strict: true })
          abortCheck(signal)
        })
        break
      case 'uninstall':
        await moduleTransaction(host, folder, async () => {
          host.core.uninstallModule(folder)
          abortCheck(signal)
        })
        break
      default:
        throw failure('error.moduleAction', 'Unknown module action', { action })
    }
    host.core.invalidateDepUpdatesCache()
    if (report) report.updates = report.updates.filter((item) => item.id !== folder)
  }

  // ===== M4.1 S3：自己实现的引擎安装 / 更新（D62）=====
  //
  // 之前：`core.installModuleWithProgress(folder, ...)` 会
  //   ① 从 GitHub 拉 `modules/<folder>/` 整个目录（含 launcher.js / updates.js 等）
  //   ② 拉 manifest.json
  //   ③ 按 manifest 装依赖
  //
  // 现在：我们没有「模块文件」可下载了（启动逻辑是我们自己的 launchers/，不加载 launcher.js）。
  // 所以安装 = **写一份生成的 manifest + 按它装依赖**。三步全在我们手里：
  //
  //   ① 写 `<dataDir>/modules/<folder>/manifest.json`（来自 registry，D62）
  //   ② 按 manifest 的 `dependencies` 下载 + 解压（复用 `installDependencies`）
  //   ③ 失败时整体回滚（复用 `moduleTransaction` 的备份/还原）
  //
  // 顺序的讲究：**先写 manifest 再装依赖**。因为 `installDependencies` 是读磁盘上的
  // manifest 干活的；反过来做就得把 manifest 内容当参数传进去，等于绕开它已有的校验。
  //
  // 为什么不在事务里「先删目录」：`moduleTransaction` 已经把旧模块整体备份了，
  // 我们只需**覆盖 manifest**；旧版本残留在 `deps/` 里的东西保留（多版本引擎要留着，
  // 见 `updateModulePreservingMultiversionsWithProgress` 的 preserves 语义）。
  // 这与上游 install 的「先 rmSync 整个 localRoot」不同，是**有意**的：
  // 用户已经装了 nwjs v0.106.1，点「更新」不该把他装好的运行时删掉。
  async function installEngine(folder: string, signal: AbortSignal): Promise<void> {
    const definition = findEngine(folder)
    if (!definition) {
      // 绝不回退、绝不猜：registry 里没有就是没有
      throw failure('error.engineNotSupported', `Engine "${folder}" is not supported`, {
        engine: folder,
        supported: ENGINE_FOLDERS.join(', ')
      })
    }

    const root = host.modulePath(folder)
    const manifestFile = path.join(root, 'manifest.json')

    // ⚠️ 这里**不再套 moduleTransaction**：调用方（runModuleTask）已经套了一层。
    // 两层事务会各自备份/还原同一个目录，失败时还原顺序反了会把备份互相覆盖。
    // 所以本函数只做「写 manifest + 装依赖」，回滚责任留在调用方。
    abortCheck(signal)
    fs.mkdirSync(root, { recursive: true })

    // ① 写我们自己的 manifest（字段名与上游兼容，原版 Xenolauncher 也读得懂）
    const manifest = buildManifest(definition)
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 4), 'utf8')
    host.emit({
      event: 'progress',
      requestID: host.currentContext()?.id,
      name: 'onStep',
      key: 'progress.prepare',
      detail: { label: definition.name, phase: 'prepare' }
    })

    // ② 所有依赖装一遍。顺序 = registry 里 `dependencies` 的声明顺序（对象键序稳定）：
    //    mkxpz 本体在前、RTP / kawariki / soundfont 在后 —— 用户看到进度条先动主二进制，
    //    心理上「它在装引擎」，而不是先下 244MB 的 RTP 却不知道在装什么。
    const wanted = Object.keys(definition.dependencies)
    await installDependencies(folder, wanted, signal)

    // ③ 收尾：清掉依赖更新缓存（manifest 变了，旧的「有没有依赖更新」结论作废）
    abortCheck(signal)
    host.emit({
      event: 'progress',
      requestID: host.currentContext()?.id,
      name: 'onStep',
      key: 'progress.done',
      detail: { label: definition.name, phase: 'done' }
    })
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

  /**
   * 多版本参数的可下载列表（M4.1 S3：自己实现，不加载上游 `version-script`）。
   *
   * 之前：`host.loadScript(folder, 'nwjs.js')` 加载**模块目录里的脚本**再调它的 `getAvailable()`。
   * 现在我们不再下载模块文件（`buildManifest` 只写 manifest，`nwjs.js` 不存在），
   * 所以改走 `engines/versions.ts` 自己实现——**行为与上游一致**（都是拉 nwjs.io）。
   *
   * ⚠️ 方案 §3.3 说「扫 deps 目录下有哪些子目录」，那是错的：扫本地只能知道
   * 「装了什么」，拿不到「能装什么」。照方案做的话这个弹窗的「可下载」永远是空的。
   *
   * `available` 失败时返回 `{}` + `warning`，**不抛错**：弹窗照常开、已装列表照常显示。
   */
  async function versions(
    folder: string,
    argKey: string
  ): Promise<{ installed: string[]; available: Record<string, unknown>; warning?: string | null }> {
    const root = host.modulePath(folder)
    const manifestFile = path.join(root, 'manifest.json')
    if (!fs.existsSync(manifestFile)) {
      throw failure('error.moduleMissing', `Module "${folder}" is not installed.`, { module: folder })
    }
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as {
      gameArgs?: Record<string, { type?: string; 'version-script'?: string }>
    }
    const key = component(argKey, 'argument')
    const definition = manifest.gameArgs?.[key]
    if (definition?.type !== 'multi-version') {
      throw failure('error.notMultiVersion', 'Not a multi-version parameter', { argument: key })
    }

    const installed = installedVersions(folder, key)

    // 目前只有一个 multi-version 参数、只有一个引擎用它（nwjs 的 version）。
    // 不去猜「别的脚本名该调什么」——认不出来的就明确说「拿不到」，而不是装作空列表。
    let available: Record<string, unknown> = {}
    let warning: string | null = null
    if (folder === 'nwjs' && key === 'version') {
      const result = await fetchNwjsVersions(host.fetch)
      available = result.available
      warning = result.warning
    } else {
      warning = `不支持的多版本参数：${folder}.${key}`
    }
    return { installed, available, warning }
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
   * 启动（M4.0 D53–D55：自实现，不再加载上游 launcher.js）。
   *
   * **返回值契约扩展**（M3 引入，三处同步：ipc.ts / api/client.ts）：
   * - 正常：`{ message }`
   * - 有 fatal 诊断：`{ blocked: true, diagnoses }` —— UI 弹中文诊断框，**不抛英文错误**
   *
   * 为什么用返回值而不是抛错：抛错会走 translateError 的通用路径，
   * 而诊断需要「多条 + 每条带 fix」的结构化数据，错误对象扛不住（也会被 contextBridge 截断）。
   *
   * 这一次启动**必须依次做完**下面这些事（换实现时不能弄丢任何一步）：
   *   ① 启动前诊断（M3 D36/D37）—— 有 fatal 就返回 blocked
   *   ② 路径存在性 + reconcileAndPersistGameArgs（manifest 缺省值合并落盘）
   *   ③ 重复启动检查（M3.5）
   *   ④ reconcileVersionArgs（版本号 → deps 真实目录名）
   *   ⑤ macOS 去 quarantine 属性
   *   ⑥ buildLaunchPlan（未知引擎 → error.engineNotLaunchable，D57）
   *   ⑦ plan.prepare（mkxpz 写 mkxp.json；失败 = 不启动）
   *   ⑧ spawn（detached + stdio:ignore + unref，D55）
   *   ⑨ 进程登记 + play-stats + gameStarted 事件（M3.5）
   */
  async function launch(params: Record<string, unknown>): Promise<LaunchResult> {
    const id = String(params.id ?? '')
    const all = host.store.loadGames()
    const game = all[id]
    if (!game) throw failure('error.gameNotFound', 'Game not found', { id })

    // ---- ① M3 §4.2：启动前自动诊断 ----
    // 两个开关决定跑不跑：
    //   · settings.diagnoseBeforeLaunch=false → 用户彻底关掉了这个功能
    //   · params.diagnose=false → 渲染层说「诊断框已经看过了」（用户点了「还是启动试试」）
    // 后者是必须的：没有它，点绕过按钮会再次被拦，绕过等于不存在（§9 R5）。
    const shouldDiagnose = params.diagnose !== false && host.store.settings().diagnoseBeforeLaunch !== false
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

    // ---- ② 路径 + manifest 缺省值 ----
    if (!fs.existsSync(game.gamePath)) {
      throw failure('error.gamePath', 'The game path no longer exists.', { path: game.gamePath })
    }
    // 按 manifest.gameArgs 合并缺省值并落盘（上游同名 API）
    host.core.reconcileAndPersistGameArgs(id)

    // ---- ③ 重复启动检查（M3.5）----
    // 同一个游戏已经在跑就别再启一次（双份进程既浪费又会让 PID 记录打架）
    if (registry.has(id)) {
      throw failure('error.gameAlreadyRunning', 'Game is already running.', { id })
    }

    const folder = fs.statSync(game.gamePath).isFile() ? path.dirname(game.gamePath) : game.gamePath

    // ---- ④ 修正 multi-version 参数（典型是 nwjs 的 version）----
    // 用户没选版本时记录里可能是 "0.106.1"，而 deps 下的真实目录叫 "v0.106.1"，
    // 直接拼会得到不存在的路径 → 点启动「没反应」。见 core-host.ts 的注释。
    const gameArgs = host.reconcileVersionArgs(game.gameEngine, game.gameArgs ?? {})

    // ---- ⑤ macOS quarantine（失败只记日志、不阻塞）----
    if (process.platform === 'darwin') {
      void runFile('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', folder]).catch(() => undefined)
    }

    // ---- ⑥ 造启动方案（未知引擎 = 明确报错，D57：不回退）----
    const plan = buildLaunchPlan(game.gameEngine, {
      folder,
      gamePath: game.gamePath,
      gameArgs,
      gameTitle: game.gameTitle ?? '',
      dataDir: host.dataDir,
      platform: process.platform,
      // ⚠️ os.arch()：nwjs 的 deps 目录名按它拼（arm64 / x64）
      arch: os.arch()
    })
    if (!plan) {
      // 绝不能静默失败：装了 ruffle / wine / macos 的用户点启动必须知道「为什么不行」
      throw failure(
        'error.engineNotLaunchable',
        `引擎 "${game.gameEngine}" 暂不支持启动。\n` +
          '本版本支持：NW.js（MV/MZ）、mkxp-z（XP/VX/VX Ace）、EasyRPG（2000/2003）、Ren\'Py。',
        { engine: game.gameEngine }
      )
    }

    // ---- ⑦ 前置动作（mkxpz 写 mkxp.json 等）；失败 = 不启动 ----
    try {
      await plan.prepare?.()
    } catch (error) {
      abortCheck(host.currentContext()?.signal)
      throw failure(
        // 单独一个键（不是通用 launchFailed）：前置失败是「配置没写进去」，
        // 用户能做的事与「引擎根本没起来」不同，文案要能区分。
        'error.launchPrepareFailed',
        `启动前置失败（${plan.engine}）：${(error as Error).message}`,
        { engine: plan.engine, reason: (error as Error).message }
      )
    }

    // ---- ⑧ spawn ----
    const outcome = spawnImpl(plan, folder)
    if (!outcome.ok) {
      abortCheck(host.currentContext()?.signal)
      throw failure('error.launchFailed', describeSpawnFailure(outcome.code, plan.binary), {
        path: plan.binary,
        engine: plan.engine,
        reason: outcome.message
      })
    }

    // ---- ⑨ 进程登记 + 游玩记录 + gameStarted（M3.5）----
    // 注意顺序：**先登记再返回**。用户紧接着点「关闭游戏」时表里必须有记录，
    // 否则会得到一句「游戏没在运行」（M3.5 §3 的同一条要求）。
    registerRunning(id, game.gameEngine, plan, outcome.child, outcome.pid)

    return { message: '已发送启动请求' }
  }

  /**
   * 登记一次启动（进程表 + 游玩记录 + gameStarted 事件）。
   *
   * 与 M3.5 的拦截器版本语义一致，只是**不再等别人回调**：
   * 我们自己 spawn，PID 是现成的。
   *
   * 这里的任何失败都只写 console.warn —— 统计与事件不能影响「游戏已经起来了」这个事实。
   */
  function registerRunning(
    gameId: string,
    engine: string,
    plan: LaunchPlan,
    child: ChildProcess,
    pid: number
  ): void {
    const startedAt = new Date().toISOString()
    registry.add({
      gameId,
      pid,
      engine,
      command: describeLaunch(plan.binary, plan.args),
      execPath: plan.binary,
      startedAt
    })
    try {
      playStats.record(gameId, startedAt)
    } catch (error) {
      // 记录失败不能让游戏启动失败（那是统计，不是功能）
      console.warn(`[tsumigeya] 写游玩记录失败（已忽略）：${(error as Error).message}`)
    }
    host.emit({ event: 'gameStarted', gameId, pid, engine, startedAt })

    /** 退出时注销 + 累计时长 + gameExited。只记一次（exit 与 error 都可能来）。 */
    let settled = false
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return
      settled = true
      // pid 复核：老记录退出的迟到回调不能删掉**新一次启动**的记录
      const removed = registry.remove(gameId, pid)
      if (!removed) return
      try {
        playStats.finish(gameId, sessionSeconds(startedAt, Date.now()))
      } catch (error) {
        console.warn(`[tsumigeya] 退出时写游玩记录失败（已忽略）：${(error as Error).message}`)
      }
      host.emit({ event: 'gameExited', gameId, pid, engine, exitCode: code, signal })
    }
    child.once('exit', (code, signal) => finish(code ?? null, signal ?? null))
    child.once('error', () => finish(null, null))
  }


  /**
   * 只安装模块里**指定的若干依赖**（M3 的「一键补装 RTP」用它）。
   *
   * 为什么不能直接用 core 的 `installDependency`：
   *   上游有参数错位 bug —— `installDependency(folder, depName, builds)` 内部调用
   *   `installOneDependency(depName, builds, depsRoot, opts)`（**4 个参数**）时只传了 3 个，
   *   于是 folder 被当成 depName、depName 被当成 builds、builds 被当成 depsRoot。
   *   项目决策 D6 就是「不暴露 installDependency」，原因正是这条。
   *
   * 为什么不能直接用 `updateDependenciesTaskWithProgress`：
   *   它走 `getDependencyUpdates`（模块自己的 updates provider），**只更新已安装的依赖**；
   *   我们在的场景恰恰是「RTP 从来没装过」——实测它在 entries 为空时只打一句
   *   "No dependency updates found." 就返回，**什么都不下载**。
   *   用户点「一键补装」会看到「完成」但 RTP 仍然缺失，这比不修更糟。
   *
   * 为什么不能直接用 `installModuleWithProgress`：
   *   那会把整个模块（含引擎二进制与其它依赖）全部重下一遍，只为了补一个 RTP，代价太大。
   *
   * 所以这里按 manifest 的 `dependencies` 自己走一遍：只下需要的那些，并复用现有的
   * 下载+解压通路（`extractArchive`）与事务回滚（`moduleTransaction`）。
   */
  async function installDependencies(
    folder: string,
    wanted: readonly string[],
    signal: AbortSignal
  ): Promise<string[]> {
    const root = host.modulePath(folder)
    const target = path.join(root, 'manifest.json')
    if (!fs.existsSync(target)) {
      throw failure('error.moduleMissing', 'Module manifest not found', { module: folder })
    }
    let manifest: { dependencies?: Record<string, unknown>; deps?: Record<string, unknown> }
    try {
      manifest = JSON.parse(fs.readFileSync(target, 'utf8')) as typeof manifest
    } catch (error) {
      throw failure('error.invalidObject', `Invalid manifest: ${folder}`, {
        file: `${folder}/manifest.json`,
        reason: (error as Error).message
      })
    }
    const deps = (manifest.dependencies ?? manifest.deps ?? {}) as Record<
      string,
      Record<string, unknown>
    >

    const arch = os.arch() === 'x64' ? 'x86_64' : os.arch()
    const installed: string[] = []
    for (const name of wanted) {
      abortCheck(signal)
      const builds = deps[name]
      if (!builds || typeof builds !== 'object') {
        // manifest 里没有这个依赖：不猜、不静默成功，直接告诉用户
        throw failure('error.dependencyMissing', `Manifest has no dependency "${name}"`, {
          dependency: name,
          module: folder
        })
      }
      const spec = (builds.universal ?? builds[arch]) as { link?: string; unzip?: boolean } | undefined
      if (!spec?.link) {
        throw failure('error.buildMissing', `No ${arch} build for dependency "${name}"`, { arch })
      }

      // ⚠️ 依赖名**可以带斜杠**（上游就有一个叫 `version/v0.106.1` 的，斜杠 = 子目录，
      //    落地成 `deps/version/v0.106.1/`）。所以**不能**用 `component()` 校验 ——
      //    它禁止斜杠，会把上游合法的依赖名直接判成 error.invalidComponent。
      //
      //    这是 S3 把安装链路接到真实代码后才暴露的 bug：M3 写这个函数时只用
      //    `['RTP']` 这种单段名调它，斜杠那条路径从没跑过。
      //
      //    仍然要挡的是「跳出 deps 目录」：
      //      · 绝对路径、`..`、盘符、空段 → 拒绝
      //      · 结果必须落在 `<module>/deps/` 之内（用 resolve 后的前缀判断，不靠字符串匹配）
      const depRelative = safeDependencyPath(name)
      const depsRoot = path.join(root, 'deps')
      const depDir = path.join(depsRoot, depRelative)
      if (!depDir.startsWith(path.resolve(depsRoot) + path.sep)) {
        throw failure('error.invalidComponent', `Invalid dependency`, { dependency: name })
      }
      fs.mkdirSync(depDir, { recursive: true })
      const archiveName = component(path.basename(new URL(spec.link).pathname), 'archive')
      const archivePath = path.join(depDir, archiveName)

      const response = await host.fetch(spec.link, { signal })
      if (!response.ok || !response.body) {
        throw failure('error.download', `Download failed: HTTP ${response.status}`, {
          status: response.status,
          url: spec.link
        })
      }
      const totalBytes = Number(response.headers.get('content-length')) || 0
      const file = fs.openSync(archivePath, 'w')
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
            detail: { label: name, downloadedBytes, totalBytes }
          })
        }
      } finally {
        fs.closeSync(file)
      }

      if (spec.unzip) {
        const extracted = path.join(depDir, '.extract')
        await extractArchive(archivePath, extracted, { signal })
        // ⚠️ 这里的「拍平」只针对**无关的包裹层**，绝不针对与依赖名同名的那一层。
        //
        // §2.3 实测：RTP.zip 内部顶层就是 `RTP/<版本>/…`，而 depDir 本身已经叫
        // `deps/RTP`，所以**必须保留那层 `RTP/`**，最终才是 `deps/RTP/RTP/RPGVXace`
        // （`detectMissingRtp` 查的就是这个路径）。
        //
        // 原来写 `entries[0].name === name` 反而把 `RTP/` 拍平掉了 → 落地成
        // `deps/RTP/RPGVXace` → 诊断永远判「缺失」，用户点修复后问题依旧
        // （Windows 上恰好没暴露，Linux CI 才炸出来：断言 expected [...]
        //   to not include 'missingRtp'）。
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
        // RTP 在 mkxpz 的 manifest 里就叫 "RTP"（§2.3 实测的依赖名）。
        // 必须走「按名字装指定依赖」而不是 updateDependencies：后者只更新已装的，
        // 而我们的场景恰恰是「从来没装过」→ 实测它什么都不下（见 installDependencies 注释）。
        await moduleTransaction(host, folder, async () => {
          const installed = await installDependencies(folder, ['RTP'], signal)
          if (!installed.includes('RTP')) {
            throw failure('error.dependencyMissing', 'RTP dependency was not installed', {
              dependency: 'RTP',
              module: folder
            })
          }
        })
        host.core.invalidateDepUpdatesCache()
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

      // M3.5：只读内存里的进程表，毫秒级 → 绕队列（用户点开详情页就在等它）
      case 'runningGames':
        return runningGames()

      // M3.5：关闭游戏——要等进程退出（最多 5 秒），必须进队列
      case 'stopGame':
        return await stopGame(params)

      case 'detect': {
        const target = String(params.path ?? '')
        const installed = host.core.detectEngineForPath(target, host.core.readLocalManifests())
        if (installed) return { engine: installed, installed: true }

        // ===== M4.1 S5：两件事都改了（D60）=====
        //
        // ① **不再拉远端规则**：原来这里是 `await host.core.fetchModulesForAutodetect()`
        //    （拉 7 个模块的 autodetect）。现在规则来自 registry，本地就有，
        //    所以这个命令变成纯同步计算、零网络。
        //
        // ② **修了一个反向判断的 bug**（M1 时代就存在，S5 写测试时抓到）：
        //    原来是 `if (!params.includeRemote) return { engine: null, installed: false }` ——
        //    调用方**不传** `includeRemote` 时它是 `undefined`，`!undefined === true`，
        //    于是**直接返回 null，一条规则都不试**。
        //
        //    而渲染层 `client.ts` 的 `detect: (path, includeRemote?)` 在正常调用里
        //    **根本不传第二个参数** → 引擎识别在这些路径上从来没有生效过
        //    （表现是「添加游戏时认不出引擎」，但它不报错、只是返回 null，
        //     很容易被当成「这个游戏确实认不出来」）。
        //
        //    修法与 `detectFolder` 保持一致：**只有显式传 false 才跳过规则**
        //    （`detectFolder` 里写的就是 `input.includeRemote !== false`）。
        if (params.includeRemote === false) return { engine: null, installed: false }
        const definitions = engineDefinitionsFromRegistry()
        return { engine: host.core.detectEngineFromAutodetectMap(target, definitions) ?? null, installed: false }
      }

      case 'detectFolder':
        return await host.detectFolder({
          path: String(params.path ?? ''),
          includeRemote: params.includeRemote as boolean | undefined
        })

      // M4.1 S2（D60）：可安装的引擎**只有 registry 里那四个**，不再拉上游清单。
      // 返回值的形状没变（RemoteModule），所以引擎页一行都不用改。
      case 'remoteModules':
        return remoteModulesFromRegistry()

      case 'checkEngineUpdates': {
        try {
          // `forceRefresh` 参数保留但**不再有意义**（没有远端缓存可刷）。
          // 保留入参是为了不破坏 preload / client.ts 的既有签名（改契约要走 §协作规矩 4）。
          return await checkEngineUpdates(signal)
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

  return { dispatch, snapshot, engineUpdateReport: () => report, runningGames }
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
