// IPC 命令表（§3.3 的 18 条）+ 串行队列 + 取消 + 对话框 + 事件推送。
// 契约：docs/M1-实施方案.md §3.3（命令表）、§3.4（事件）、§3.8（launch 自实现）。
// 范本：_xeno_probe/native/Backend/worker.cjs:373-404（队列骨架）。
//
// 设计要点（不要改）：
// - 除 pickPath / cancel / dialog 外全部走串行队列（queue = queue.then(...)）。
// - cancel 与 dialogReply **必须绕开队列**，否则 core 在队列里等应答会死锁（D12）。
// - 每个请求各自一个 AbortController，队列本身不持有取消权。
//
// ===== M4.2 S4：不再有 `host.core`（D63）=====
//
// 原来这个文件的安装 / 识别 / 版本比较 / 删除全部走 `host.core.<API>`（装载的是
// `resources/core/module.js`）。M4.2 把那个脚本删了，所以这里的每一处调用都换成了
// `engines/` 里的自实现：
//
//   readLocalManifests        → engines/manifest.ts
//   reconcileAndPersistGameArgs（合并那半）→ engines/manifest.ts 的 reconcileGameArgs
//   hasUpdate                 → engines/semver.ts
//   detectEngineForPath       → engines/detect.ts
//   detectEngineFromAutodetectMap → engines/detect.ts
//   getInstalledModuleFolders → engines/detect.ts
//   installModuleWithProgress → engines/install.ts 的 installEngine（M4.1 起就是我们的）
//   updateModulePreserving…   → engines/install.ts 的 updateEngine（D66简化实现）
//   updateDependenciesTask…   → engines/install.ts 的 installDependencies（M3 起就是我们的）
//   uninstallModule           → engines/install.ts 的 uninstallEngine
//   invalidateDepUpdatesCache / checkDependencyUpdatesForFolders → **删除**（D64）
//   deleteWithEngine          → **删除**（D65，删游戏直接走 store.removeGame）
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
import {
  isDuplicateName,
  nextCategoryOrder,
  normalizeAssignments,
  normalizeCategoryName,
  uniqueCategoryId,
  validateCategoryName,
  withoutCategory
} from '../shared/categories'
import { diagnoseGame, type Diagnosis, type DiagnosisFix } from './diagnose'
import { listSaves } from './save-store'
import { exportBlocked } from '../shared/save-archive'
import {
  defaultExportDir,
  exportSaveArchive,
  importSaveArchive,
  type ExportSaveResult,
  type ImportSaveResult
} from './save-archive-io'

/**
 * 用户在系统目录框点「取消」时的导出结果。
 *
 * 为什么要单独一个类型：`ExportSaveResult`（save-archive-io 那边）描述的是
 * **"打包成功"**这件事 —— file 是 string，manifest 一定有。而取消时这两样都没有。
 * 硬塞进同一个 interface 会让消费方到处判 `file` 是不是 null，
 * 用联合类型（`ExportSaveResult | CancelledExport`）才能让 TS 在类型层把两条路分开。
 *
 * `cancelled: true` 是那条**唯一**的判别字段（别用 `!file` 判 —— 成功时 file 也可能假值？不会，
 * 但要一个显式标记，语义才读得懂）。
 */
export interface CancelledExport {
  cancelled: true
  file: null
  fileCount: 0
  size: 0
  manifest: null
}
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
// M4.2 S4（D63）：原来 `host.core.*` 的 18 个 API 全部落到这几个文件。
import { readLocalManifests, reconcileGameArgs, schemaFromDefinition } from './engines/manifest'
import { detectEngineForPath, detectEngineFromDefinitions, getInstalledModuleFolders } from './engines/detect'
import { hasUpdate } from './engines/semver'
import {
  installDependencies,
  installEngine,
  safeDependencyPath,
  uninstallEngine,
  updateEngine
} from './engines/install'
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
  // M4：列存档——纯本地只读（readdirSync + statSync），毫秒级
  'listSaves',
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
 * `safeDependencyPath` 的**定义**已搬到 `engines/install.ts`（M4.2 S3）——
 * 它校验的是「依赖名 → deps 下的相对路径」，属于安装链路的知识，留在 ipc 里会把
 * 「安装逻辑」切成两半。
 *
 * 这里重新导出是为了不破坏既有 import（`test/engines-install.test.ts` 直接从这里拿）。
 * ⚠️ **不要再在本文件里另写一份**：两份分叉的表现是
 *    「同一个依赖名在安装时合法、在别处非法」。
 */
export { safeDependencyPath }

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
    const manifests = readLocalManifests(host.dataDir)
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
      // M5.0 S7（U2）：分类的定义表与归属表（与 meta 同一个文件，但各自独立的顶层键）。
      // 与 meta 同理：读失败不能让整页崩 —— 分类是整理工具，坏了不该让游戏库不可用。
      categories: readCategoriesSafely(),
      // M3.5：运行态（只读投影，D50 不落盘）。少带 command/execPath：UI 用不到，
      // 而且命令串里可能有用户的本地路径，没必要过桥。
      running: registry.list().map((item) => ({
        gameId: item.gameId,
        pid: item.pid,
        startedAt: item.startedAt
      })),
      // M5.0 N1：游玩记录随 snapshot 下发（详情页的「游玩时间」块直接读它）。
      // 与 meta 同理：读失败不能让整页崩 —— 统计是附属品，读不出来就当还没有记录。
      //
      // 为什么不单独加一条 IPC 命令：这份数据每次启动/退出才能变，
      // 而 snapshot 本来就是「所有状态一次给全」的那个入口，另开一条命令只会让
      // 渲染层多一条要自己记得刷新的路径（D44 那类"新路径没人记得套上"的老毛病）。
      playStats: readPlayStatsSafely(),
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

  /**
   * M5.0 S7：读分类数据，失败按空处理。
   *
   * 与 `readMetaSafely` 同一取向：library-meta.json 损坏时 readJSON 会抛
   * （它绝不静默覆盖用户数据，那是正确行为），但一份整理工具的数据坏了
   * 不该让用户连游戏库都看不见。
   */
  function readCategoriesSafely(): { defs: Record<string, unknown>; assignments: Record<string, unknown> } {
    try {
      const { defs, assignments } = host.categories.loadAll()
      return { defs, assignments }
    } catch (error) {
      console.warn(`[tsumigeya] 读取分类数据失败（已按空处理）：${(error as Error).message}`)
      return { defs: {}, assignments: {} }
    }
  }

  function readMetaSafely(): Record<string, unknown> {
    try {
      return host.meta.load()
    } catch (error) {
      console.warn(`[tsumigeya] 读取 library-meta.json 失败（已按空处理）：${(error as Error).message}`)
      return {}
    }
  }

  /**
   * M5.0 N1：读游玩记录，失败按「没有记录」处理。
   *
   * 为什么要这个 wrapper：`play-stats.json` 损坏时 `readJSON` 会**抛**（它绝不静默覆盖
   * 用户数据，见 play-stats.ts 的注释）。那是正确行为，但 snapshot 不能因此整个崩掉 ——
   * 一份统计文件坏了不该让用户连游戏库都看不见。
   *
   * 注意这里**不做归一化之外的修补**：单条记录的脏值由 `playStats.load()` 内部
   * 逐条处理（`normalizePlayStat`），只有「整个文件读不出来」才会走到 catch。
   */
  function readPlayStatsSafely(): Record<string, unknown> {
    try {
      return playStats.load()
    } catch (error) {
      console.warn(`[tsumigeya] 读取 play-stats.json 失败（已按空处理）：${(error as Error).message}`)
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
    const local = readLocalManifests(host.dataDir)
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
          moduleUpdate: !!expected && hasUpdate(local[id].version, expected.version),
          // 见上面的「依赖更新检查：明确停用」（D64）。
          // M4.2 S7 也随之砍掉了渲染层的「依赖可更新」徽标与「更新依赖」按钮 ——
          // 一个恒 false 的字段配一套永远不出现的 UI，正是 D63 说的「偷偷藏着」。
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
  //
  // M4.2 S4：三个动作全部走 engines/install.ts（D62 / D63 / D66）。
  //
  // 安装 / 更新为什么合并成一条路径、又为什么必须分开：
  //   · 「安装」= 首次装（用户可能已经手工装过运行时，所以 installEngine **不删**已有目录）
  //   · 「更新」= 刷新到 registry 版本（多版本依赖必须原样保留，普通依赖必须先清再装）
  //   两者语义现在真的不同了（M4.1 时是一条路径），所以按 action 分派（D66）。
  //
  // ⚠️ **必须套 moduleTransaction**（M4.1 S3 修的真 bug，注释保留）：
  // 本鱼第一版写成直接调用，而 install 内部因为「不能嵌套两层事务」没有事务，
  // 结果两边都没有事务 → 安装失败时磁盘上留下半个模块目录（manifest 在、依赖缺一半），
  // 比装不上更糟：界面显示「已安装」，启动时却找不到二进制。
  // 事务责任留在这一层（engines/install.ts 只管写文件，不备份）。
  async function runModuleTask(folder: string, action: string, signal: AbortSignal): Promise<void> {
    const root = host.modulePath(folder)
    const progress = host.progress()
    const definition = findEngine(folder)

    // registry 里没有就不猜、不回退（D57 的精神）
    const requireDefinition = (): typeof definition => {
      if (!definition) {
        throw failure('error.engineNotSupported', `Engine "${folder}" is not supported`, {
          engine: folder,
          supported: ENGINE_FOLDERS.join(', ')
        })
      }
      return definition
    }

    switch (action) {
      case 'install':
        await moduleTransaction(host, folder, async () => {
          await installEngine(root, requireDefinition()!, {
            fetch: host.fetch,
            signal,
            onProgress: progressAdapter(progress)
          })
        })
        break
      case 'update':
        await moduleTransaction(host, folder, async () => {
          await updateEngine(root, requireDefinition()!, {
            fetch: host.fetch,
            signal,
            onProgress: progressAdapter(progress)
          })
        })
        break
      case 'dependencies':
        // 只补依赖、不动 manifest（「一键补装 RTP」走的是 repairGame → installDependencies，
        // 这里是引擎页的「刷新依赖」入口）。wanted = registry 声明的全部依赖。
        await moduleTransaction(host, folder, async () => {
          const installed = await installDependencies(root, Object.keys(requireDefinition()!.dependencies), {
            fetch: host.fetch,
            signal,
            onProgress: progressAdapter(progress)
          })
          if (installed.length === 0) {
            // 一个都没装上时明确报错：静默成功会让用户以为「补完了」而引擎仍然缺文件
            throw failure('error.dependencyMissing', 'No dependency was installed', { module: folder })
          }
          abortCheck(signal)
        })
        break
      case 'uninstall':
        await moduleTransaction(host, folder, async () => {
          uninstallEngine(root)
          abortCheck(signal)
        })
        break
      default:
        throw failure('error.moduleAction', 'Unknown module action', { action })
    }
    // M4.1 的「依赖更新缓存」随 core 一起删掉了（D64：没有远端清单就没有依赖更新可查）。
    // 这里只剩「装完/更新完就把这条引擎从更新报告里摘掉」这一件事。
    if (report) report.updates = report.updates.filter((item) => item.id !== folder)
  }

  /**
   *  的 ProgressBridge → engines/install.ts 的 onProgress 回调。
   *
   * 为什么需要这层转换：ProgressBridge 是一张「按 core 的旧 API 名字索引的函数表」
   * （onStep / onDownloadProgress / …），而 install.ts 用的是结构化事件。
   * 转换放在这里而不是 install.ts：install 不该知道渲染层的进度浮层有哪几种名字，
   * 那是接线层的知识。
   */
  function progressAdapter(bridge: ProgressBridge) {
    return (event: { name: string; key?: string; detail: Record<string, unknown> }) => {
      const handler = bridge[event.name]
      if (!handler) return
      handler({ ...event.detail, key: event.key, phase: event.detail.phase })
    }
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

  /**
   * 按引擎 manifest 的 `gameArgs` 合并缺省值，**只在真的补了东西时落盘**
   * （M4.2 S4：原来调 core 的 `reconcileAndPersistGameArgs`，D63 之后自己实现）。
   *
   * 为什么只在 changed 时落盘：这条在**每次启动**时都会跑。无条件落盘等于
   * 「用户每启动一次游戏，games.json 就被重写一次」—— 一次多余的盘写入 + 一次
   * 可能打断手改的风险（`saveGame` 的备份/原子写会整份重写）。
   *
   * 为什么用 registry 的定义而不是磁盘上的 manifest：
   *   · 磁盘 manifest 可能是旧版本写的（缺了新加的参数）
   *   · registry 是我们**要**的形状，缺省值该按它补（D62 的生成物就是按它写的）
   *   两边理论上一致（manifest 由 buildManifest 生成），但磁盘那份可能被用户手改过；
   *   以 registry 为准，才能保证「参数表单里看得见的项，gameArgs 里都有值」。
   *
   * 失败只 warn 不抛：这条是启动链路上的**便利步骤**，补不上缺省值不该让用户
   * 连游戏都启动不了（引擎侧有默认值兜底）。
   */
  function reconcileGameArgsAndPersist(gameId: string): void {
    const game = host.store.loadGames()[gameId]
    if (!game) return
    const definition = findEngine(game.gameEngine)
    if (!definition) return

    const { merged, changed } = reconcileGameArgs(game.gameArgs ?? {}, schemaFromDefinition(definition))
    if (!changed) return

    try {
      host.store.saveGame({
        id: gameId,
        game: {
          gameTitle: game.gameTitle,
          gamePath: game.gamePath,
          iconPath: game.iconPath,
          tags: game.tags,
          gameEngine: game.gameEngine,
          gameArgs: merged
        }
      })
    } catch (error) {
      // 写不进去只是「这次没补上缺省值」，下次启动还会再试一遍
      const key = (error as { translationKey?: string }).translationKey
      console.warn(
        `[tsumigeya] 补写 gameArgs 缺省值失败（已忽略，下次启动再试）：${(error as Error).message}` +
          (key ? ` [${key}]` : '')
      )
    }
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
    // 按 manifest.gameArgs 合并缺省值并落盘（M4.2 S4：原来调 core 的同名 API）
    reconcileGameArgsAndPersist(id)

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
   * 兼容层：原来的本地 `installDependencies(folder, wanted, signal)` 改成
   * `engines/install.ts` 的 `installDependencies(root, wanted, options)`（M4.2 S3）。
   *
   * 为什么留这么一层：`repairGame`（M3 的「一键补装 RTP」）与几处调用点用的是
   * 「给 folder 名，自己算 root」的旧形态。转换集中在这里一处，
   * 而不是让每个调用点各写一遍 `host.modulePath(folder)` + options 对象。
   *
   * ⚠️ 这个东西的**实现**必须在 engines/install.ts 里，不要在 ipc 里再写一遍
   * （M3 时代写的那个版本已经在 S3 搬走了；两份分叉的表现是
   *   「某个依赖名在安装时合法、在补装时非法」这种极难查的错位）。
   */
  function installDependenciesFor(folder: string, wanted: readonly string[], signal: AbortSignal): Promise<string[]> {
    return installDependencies(host.modulePath(folder), wanted, {
      fetch: host.fetch,
      signal,
      onProgress: progressAdapter(host.progress())
    })
  }

  // ===== M3：启动前诊断（§3 / §4.1）=====

  /**
   * 对某个游戏跑全套诊断。**只读**、不写盘，所以能进 OFF_QUEUE_METHODS。
   *
   * 依赖的输入全部来自本地：
   * - `host.store.loadGames()` → gamePath / gameEngine
   * - `host.modulesDir()` → `deps/RTP/RTP/<版本>` 的检查根
   * - `getInstalledModuleFolders(host.dataDir)` → 到底装没装引擎模块
   *
   * 任一依赖读失败都**不能**让诊断整体抛错：诊断的价值在于「告诉用户怎么修」，
   * 它自己崩掉就又退化成「点启动没反应」。
   */
  function runDiagnose(gameId: string): Diagnosis[] {
    const game = host.store.loadGames()[gameId]
    if (!game) throw failure('error.gameNotFound', 'Game not found', { id: gameId })
    let installed: string[] = []
    try {
      installed = getInstalledModuleFolders(host.dataDir)
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
          const installed = await installDependenciesFor(folder, ['RTP'], signal)
          if (!installed.includes('RTP')) {
            throw failure('error.dependencyMissing', 'RTP dependency was not installed', {
              dependency: 'RTP',
              module: folder
            })
          }
        })
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
        // M4.2 S4（D65）：原来的 deleteWithEngine **已删除**，删游戏直接走 store.removeGame。
        //
        // 它原来是「让引擎模块里的 postdelete.js 清理一次再删」。但**我们生成的 manifest
        // 里没有 postdelete.js**（M4.1 起只写 manifest + deps），所以那次调用早就成了空操作；
        // 更糟的是它**失败时会拦住删游戏**（返回 false → 这里抛 error.cleanup）
        // —— 一个空操作把用户想删的游戏扣在库里，是 bug 不是保护。
        //
        // 删游戏要动的东西在下面：games.json（store.removeGame）+ library-meta（meta.remove）。
        // 引擎目录与游戏目录一个字节都不碰（那是用户的数据，D31 的精神）。
        host.store.removeGame(id)
        // M2 §3.2：删游戏时同步清旁挂元数据（`dlsite/<RJ>.json` 缓存保留，可跨游戏共享）。
        // 清理失败不能让删游戏失败：games.json 才是用户数据，meta 只是附属品。
        try {
          host.meta.remove(id)
        } catch (error) {
          console.warn(`[tsumigeya] 清理 DLsite 元数据失败（已忽略）：${(error as Error).message}`)
        }
        // M5.0 S6（U1）修的真 bug：**从来没清 play-stats.json**。
        //
        // `PlayStatsStore.remove()` 从 M3.5 就写好了，但**没有任何调用点**（死代码）。
        // 单条删除时它隐蔽（孤儿记录谁也看不到，只是文件慢慢变大）；
        // **批量删除会把它放大**：删掉一批之后新建游戏，id 是从
        // `Math.max(...)+1` 算的（games-store.ts 的 saveGame），很容易正好落回刚删掉的号。
        // 那时用户的**新游戏会显示上一个游戏的游玩历史** —— 数据串台，比丢数据更难查，
        // 因为界面一切正常、数字看起来也合理。回归测试见 test/delete-cleanup.test.ts。
        //
        // 与 meta 同理：清理失败不能让删游戏失败（统计是附属品，games.json 才是用户数据）。
        try {
          playStats.remove(id)
        } catch (error) {
          console.warn(`[tsumigeya] 清理游玩记录失败（已忽略）：${(error as Error).message}`)
        }
        // M5.0 S7（U2）：**第四处**旁挂数据 —— 分类归属。
        //
        // 漏掉它的后果与 play-stats 一样：id 会被复用（saveGame 的 Math.max(...)+1），
        // 于是新游戏继承上一个游戏的分类归属，侧边栏的「未分类」计数也会偏小
        // （assignments 里有个指向不存在游戏的键，永远不会被算进任何一边）。
        // 同样是"不报错、只是数字悄悄不对"，所以用测试钉住（test/category-ipc.test.ts）。
        try {
          host.categories.removeGame(id)
        } catch (error) {
          console.warn(`[tsumigeya] 清理分类归属失败（已忽略）：${(error as Error).message}`)
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
        const installed = detectEngineForPath(target, readLocalManifests(host.dataDir))
        if (installed) return { engine: installed, installed: true }

        // ===== M4.1 S5（D60）→ M4.2 S4（D63）：两件事都改了 =====
        //
        // ① **不再拉远端规则**：原来这里是「拉 7 个模块的 autodetect 再猜一轮」。
        //    现在规则来自 registry，本地就有，所以这个命令变成纯同步计算、零网络。
        //    M4.2 再把识别函数换成了 `engines/detect.ts`（与 detectFolder 共用一份打分算法）。
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
        return { engine: detectEngineFromDefinitions(target, definitions) ?? null, installed: false }
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

      // ===== M5.0 S7（U2）：自定义分类（多归属 / 扁平）=====
      //
      // 四条命令都在**队列内**（都写 library-meta.json，与 saveGameMeta 同一个文件）。
      // 分类操作全是批量改写（删一个要从所有游戏上摘），必须与其它写操作串行。

      /**
       * 新建分类。
       *
       * 校验三件事（都在 shared/categories.ts，有单测）：
       *  · 名字非空、不超长（`validateCategoryName`）
       *  · 名字查重（大小写不敏感）—— 两个同名分类在侧边栏里无法区分
       *  · id 唯一（`uniqueCategoryId`）—— 撞 id 会把两个分类静默合并
       */
      case 'createCategory': {
        const name = String(params.name ?? '')
        const nameError = validateCategoryName(name)
        if (nameError === 'empty') throw failure('error.categoryNameRequired', 'Category name is required')
        if (nameError === 'too-long') throw failure('error.categoryNameTooLong', 'Category name is too long')
        const defs = host.categories.loadDefs()
        if (isDuplicateName(defs, name)) {
          throw failure('error.categoryDuplicate', 'A category with this name already exists')
        }
        const id = uniqueCategoryId(defs, name)
        const next = { ...defs, [id]: { name: normalizeCategoryName(name), order: nextCategoryOrder(defs) } }
        host.categories.save(next, host.categories.loadAssignments())
        return snapshot()
      }

      /**
       * 重命名：**只改 name，id 不变** → 所有游戏的引用自动跟随（方案 §4.2.2）。
       *
       * 这一条是「用 slug 而不是自增数字」这个决定的全部收益所在。
       * 若改了 id，就得遍历所有游戏改引用 —— 那既是 O(n) 的批量写，又可能半途失败。
       */
      case 'renameCategory': {
        const id = String(params.id ?? '')
        const name = String(params.name ?? '')
        const defs = host.categories.loadDefs()
        if (!Object.hasOwn(defs, id)) throw failure('error.categoryNotFound', 'Category not found')
        const nameError = validateCategoryName(name)
        if (nameError === 'empty') throw failure('error.categoryNameRequired', 'Category name is required')
        if (nameError === 'too-long') throw failure('error.categoryNameTooLong', 'Category name is too long')
        // excludeId 传自己：改自己的名字不该和自己冲突
        if (isDuplicateName(defs, name, id)) {
          throw failure('error.categoryDuplicate', 'A category with this name already exists')
        }
        const next = { ...defs, [id]: { name: normalizeCategoryName(name), order: defs[id]!.order } }
        host.categories.save(next, host.categories.loadAssignments())
        return snapshot()
      }

      /**
       * 删分类：**只删定义 + 从所有游戏上移除该 id，绝不删游戏**（方案 §4.2.2 / D31）。
       * 实现见 `removeCategory()`（它同时会清掉摘成空的归属键）。
       */
      case 'deleteCategory': {
        const id = String(params.id ?? '')
        if (!Object.hasOwn(host.categories.loadDefs(), id)) {
          throw failure('error.categoryNotFound', 'Category not found')
        }
        host.categories.removeCategory(id)
        return snapshot()
      }

      /**
       * 批量归入 / 移出分类（复用 U1 的多选）。
       *
       * `assign` 里是 gameId 数组 —— 与批量删除同一套 id 来源，所以同样**逐个校验**：
       * 有一个不存在的游戏不该让整批失败（用户可能选中了已被别处删掉的游戏）。
       * 但这里选择**整体成功/失败**：分类归属不是"删了就没"的破坏性操作，
       * 用户重试一次即可；而逐条部分成功会让"哪些进去了哪些没进去"难以解释。
       */
      case 'assignCategory': {
        const categoryId = String(params.id ?? '')
        const ids = Array.isArray(params.gameIds) ? params.gameIds.map((item) => String(item)) : []
        if (!Object.hasOwn(host.categories.loadDefs(), categoryId)) {
          throw failure('error.categoryNotFound', 'Category not found')
        }
        const games = host.store.loadGames()
        for (const gameId of ids) {
          if (!Object.hasOwn(games, gameId)) throw failure('error.gameNotFound', 'Game not found', { id: gameId })
        }
        if (params.remove === true) {
          // 移出：从每个游戏的归属里摘掉这个分类
          const { defs, assignments } = host.categories.loadAll()
          const known = new Set(Object.keys(defs))
          const next: Record<string, string[]> = { ...assignments }
          for (const gameId of ids) {
            const current = normalizeAssignments(next[gameId], known)
            const remaining = withoutCategory(current, categoryId)
            if (remaining.length > 0) next[gameId] = remaining
            else delete next[gameId]
          }
          host.categories.save(defs, next)
        } else {
          host.categories.assignGames(ids, categoryId)
        }
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
       * M4：列出一个游戏的存档（S2）。**绕队列**（纯本地只读）。
       *
       * 返回 `location: null` 与 `empty: true` 是**两种不同的事**：
       *   · `location: null` → 我们不知道这个游戏的存档在哪（引擎未识别 / Ren'Py 在游戏目录外）
       *   · `empty: true`     → 位置找到了，但还没存过档（UI 可以说「玩到存档点后会出现」）
       * 混为一谈会让「找不到」被误当成「没有」，用户就永远查不出问题。
       */
      case 'listSaves': {
        const game = host.store.loadGames()[String(params.id ?? '')]
        if (!game) throw failure('error.gameNotFound', 'Game not found', { id: String(params.id ?? '') })
        return listSaves(game.gamePath ?? '', game.gameEngine ?? '', game.gameTitle ?? '')
      }
      /**
       * M4 S3：把一个游戏的**整个存档目录**导出成 zip。
       *
       * 拒绝路径（各有独立的 i18n 键，UI 才能给不同的下一步动作）：
       * ① 游戏运行中                → error.saveExportRunning（"请先关闭游戏"）
       * ② 不知道存档在哪            → error.saveExportNoLocation（"去查目录"）
       * ③ 位置在但还没存档          → error.saveArchiveEmpty（"没什么可导的"）
       * ④ 写盘失败                  → 原样抛（带 detail，用户可去查磁盘）
       *
       * ===== 为什么这条**必须**进队列 =====
       *
       * 它**写盘**（用户选一个目录，我们把 zip 写进去），并且可能很大
       * （整个存档目录，含插件写的 .autobak/.rpgsave）。这与
       * `listSaves` 的"只读、绕队列"是两回事 —— 准入标准的第一条就是
       * "只读，或只写自己的独立目录"：这里写的是**用户选的任意目录**，
       * 不在我们自己的目录范围里，必须与其它写操作排队。
       */
      case 'exportSaves': {
        const id = String(params.id ?? '')
        const game = host.store.loadGames()[id]
        if (!game) throw failure('error.gameNotFound', 'Game not found', { id })

        // ① 运行中禁止导出（S3 的硬要求，判据在 shared/save-archive.ts）
        const running = registry.has(id)
        // 找一次位置（与 listSaves 同一份判据，不另写一份）
        const listing = listSaves(game.gamePath ?? '', game.gameEngine ?? '', game.gameTitle ?? '')
        const blocked = exportBlocked({
          running,
          hasLocation: listing.location !== null,
          empty: listing.empty
        })
        if (blocked) {
          const key =
            blocked.kind === 'running'
              ? 'error.saveExportRunning'
              : blocked.kind === 'noLocation'
                ? 'error.saveExportNoLocation'
                : 'error.saveArchiveEmpty'
          throw failure(key, `Cannot export saves: ${blocked.kind}`, { title: game.gameTitle ?? '' })
        }
        if (!listing.dir || !listing.location) {
          // 上面的 blocked 已经覆盖了这些分支；这里只是让 TS 收窄
          throw failure('error.saveExportNoLocation', 'Cannot export saves: no location')
        }

        // ② 让用户选输出目录（导出就该带走 → 默认落到下载目录）
        //
        // ⚠️ **用户取消 ≠ 用默认目录**（这是个真 bug，2026-11-05 真机实测抓到）：
        //    原来写 `chosen ?? defaultExportDir()`，于是 pickPath 返回 null（用户点了取消）
        //    也照样把包装进 ~/Downloads。真机上点「取消」→ 下载目录里凭空多一个包，
        //    而**用户的意图是"我不想导出"**。
        //
        //    为什么之前没发现：本机探针总是显式传 `outDir` 旁路对话框，
        //    永远走不到「取消」那条分支。Mac 真机上点两次按钮 → Downloads 多出两个包才暴露。
        //
        //    现在的语义：
        //      · 显式给了 outDir（探针/API 调用）→ 用它
        //      · 弹框且用户**选了目录**          → 用它
        //      · 弹框且用户**取消**              → 什么都不做，返回 cancelled
        //
        //    `defaultExportDir()` 仍然保留 —— 但它只用于**没有交互对话框**的场景
        //    （比如将来做"一键导出到下载目录"）。不给用户"我取消了却还是导了"的体验。
        const explicitOutDir = typeof params.outDir === 'string' && params.outDir ? params.outDir : null
        const chosen = explicitOutDir ?? (await (deps.pickPath ?? (async () => defaultExportDir()))('folder'))
        if (!chosen) {
          // 用户取消：一个字节都不写，如实回报（UI 那边安静地结束，不弹"已导出"）
          return {
            cancelled: true,
            file: null,
            fileCount: 0,
            size: 0,
            manifest: null
          } satisfies CancelledExport
        }
        const outDir = chosen

        // ③ 打包**整个存档目录**（不是只打槽）
        const result: ExportSaveResult = exportSaveArchive({
          sourceDir: listing.dir,
          gameTitle: game.gameTitle ?? '',
          engine: game.gameEngine ?? '',
          layout: listing.location.layout,
          outDir
        })
        return result
      }

      /**
       * M4 S4：把一个导出包还原到探测到的存档目录。
       *
       * 顺序**不能变**（见 save-archive-io 的 importSaveArchive 头注释）：
       *   ① 校验 sha256（不过就一个字节都不写）
       *   ② 备份现有文件（`<原名>.tsumigeya-bak`）
       *   ③ 才写
       *
       * 运行中同样禁止导入：游戏正在写存档，我们同时覆盖同名文件，
       * 结果是**两边都不是完整的一档**。
       */
      case 'importSaves': {
        const id = String(params.id ?? '')
        const game = host.store.loadGames()[id]
        if (!game) throw failure('error.gameNotFound', 'Game not found', { id })
        if (registry.has(id)) {
          throw failure('error.saveImportRunning', 'Cannot import saves while running', {
            title: game.gameTitle ?? ''
          })
        }
        const file = String(params.file ?? '')
        if (!file) throw failure('error.saveArchiveMissing', 'Missing archive path')

        const listing = listSaves(game.gamePath ?? '', game.gameEngine ?? '', game.gameTitle ?? '')
        if (listing.location === null || !listing.dir) {
          // 导入要有个明确的目标目录：没探测到就不能导（不猜位置）
          throw failure('error.saveExportNoLocation', 'Cannot locate save directory', {
            title: game.gameTitle ?? ''
          })
        }

        const result: ImportSaveResult = importSaveArchive({ file, targetDir: listing.dir })
        return result
      }

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
