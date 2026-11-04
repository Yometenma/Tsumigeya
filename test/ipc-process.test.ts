// M3.5 S3/S4 + M4.0 S5 单测：进程追踪 / 关闭 / 游玩记录在 IPC 层的行为。
//
// ⚠️ M4.0 之后**不再造假 launcher.js**：启动路径换成了 buildLaunchPlan + spawn，
// 上游 launcher 那条链已删除。这里改为注入一个**假的 spawn 实现**，
// 于是单测仍然「不真起子进程、不真 kill、全程离线毫秒级」。
//
// 要钉死的仍然是**决策**而不是系统调用：
//   · 启动成功后进程表里有记录、游玩记录落盘、发 gameStarted 事件
//   · 退出后记录被清、时长累加、发 gameExited 事件
//   · 重复启动同一个游戏被拒（否则 PID 记录会打架）
//   · stopGame 两段式：能温和退出就不 kill；叫不退才 kill（D52）
//   · PID 复用：明确不像 → 拒绝并清脏记录
//   · 诊断拦下时**不**登记进程、**不**记游玩次数（被拦下的不算「启动成功」）
//   · M4.0 新增：未知引擎**不启动**且报 error.engineNotLaunchable（D57）
//   · M4.0 新增：prepare 失败 → 不 spawn、不登记
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createCoreHost, type CoreEvent } from '../src/main/core-host'
import { createDispatcher, type ProcessDeps } from '../src/main/ipc'
import { createPlayStatsStore } from '../src/main/play-stats'
import { createProcessRegistry, type ProcessRegistry } from '../src/main/process-registry'
import type { SpawnOutcome } from '../src/main/launchers/spawn'
import type { LaunchPlan } from '../src/main/launchers/types'

let dataDir: string
let host: ReturnType<typeof createCoreHost>
let events: CoreEvent[]

/** 引擎模块的 manifest（autodetect 让诊断把「缺引擎」判成已装）。 */
function installFakeModule(folder: string): void {
  const dir = path.join(dataDir, 'modules', folder)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      name: folder,
      version: '1.0.0',
      autodetect: { extensions: ['exe'] }
    })
  )
}

/**
 * 造一个可玩「假游戏」的最小目录。
 *
 * ⚠️ M4.0 起**不需要**给引擎造二进制文件：`spawn` 被替身接管，
 * 不会有真的 stat / 执行。这也是为什么这些测试能在 Windows 上跑（目标是 mac）。
 */
function makeGame(id: string, engine: 'mkxpz' | 'easyrpg' | 'ruffle' = 'mkxpz'): void {
  const dir = path.join(dataDir, `game-${id}`)
  fs.mkdirSync(path.join(dir, 'www'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'Game.exe'), 'MZ')
  fs.writeFileSync(path.join(dir, 'www', 'package.json'), '{}')
  // mkxpz 的 prepare 会写 mkxp.json 到**游戏目录**（M5.1）；Game.ini 决定 RTP 与 rgssVersion
  if (engine === 'mkxpz') fs.writeFileSync(path.join(dir, 'Game.ini'), '[Game]\r\nRTP=RPGVXace\r\n')
  installFakeModule(engine)
  host.store.saveGame({
    game: {
      gameTitle: `游戏 ${id}`,
      gamePath: dir,
      gameEngine: engine,
      gameArgs: {}
    }
  })
}

/** 假进程实现：PID 全由测试自己记账，不发真信号。 */
interface FakeProcess extends ProcessDeps {
  alive: Map<number, boolean>
  signals: Array<{ pid: number; name: NodeJS.Signals }>
  commands: Map<number, string>
  /** 最近一次交给 spawn 的 plan（断言「给了什么参数」用）。 */
  plans: LaunchPlan[]
}

/**
 * 造一个假的 `spawnGame`。
 *
 * 它返回一个**真的 EventEmitter** 当 ChildProcess（够 `once('exit'/'error')` 用），
 * 而 PID 由测试的 `nextPid` 递增给出 —— 于是整套进程表逻辑（登记/注销/PID 复核）
 * 都能被真实地走一遍，但一个真进程都不起。
 */
function fakeSpawn(options: { exitImmediately?: boolean } = {}) {
  const plans: LaunchPlan[] = []
  const children: Array<EventEmitter & { pid?: number }> = []
  let nextPid = 1000
  const api = {
    plans,
    children,
    spawn(plan: LaunchPlan): SpawnOutcome {
      plans.push(plan)
      const child = new EventEmitter() as ChildProcess
      const pid = (nextPid += 1)
      ;(child as unknown as { pid: number }).pid = pid
      children.push(child as EventEmitter & { pid?: number })
      if (options.exitImmediately) {
        // 立刻退出：模拟「游戏一启动就崩/秒退」
        setTimeout(() => child.emit('exit', 0, null), 0)
      }
      return { ok: true, child, pid }
    }
  }
  return api
}

function fakeProcess(options: { exitOnTerm?: boolean; commandNames?: Record<number, string> } = {}): FakeProcess {
  const alive = new Map<number, boolean>()
  const signals: Array<{ pid: number; name: NodeJS.Signals }> = []
  const commands = new Map<number, string>()
  for (const [pid, name] of Object.entries(options.commandNames ?? {})) commands.set(Number(pid), name)
  return {
    alive,
    signals,
    commands,
    plans: [],
    registry: createProcessRegistry(),
    isAlive: (pid) => alive.get(pid) ?? false,
    waitExit: async (pid) => !(alive.get(pid) ?? false),
    signal: (pid, name) => {
      signals.push({ pid, name })
      // SIGTERM 且配置成「会退」→ 标成已退出；SIGKILL 一律算退出
      if (name === 'SIGTERM' && options.exitOnTerm) alive.set(pid, false)
      if (name === 'SIGKILL') alive.set(pid, false)
      return true
    },
    probeCommand: async (pid) => commands.get(pid) ?? null,
    terminateGraceMs: 1,
    killGraceMs: 1
  }
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-proc-'))
  events = []
  host = createCoreHost({
    dataDir,
    fetchImpl: (async () => {
      throw new Error('offline')
    }) as never,
    onEvent: (event) => events.push(event)
  })
  host.store.saveSettings({ diagnoseBeforeLaunch: false })
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

/** 等一段时间，让退出事件等异步回调跑到。 */
function wait(ms = 200): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * M5.0 N1：Snapshot.playStats 的端到端判据。
 *
 * ===== 为什么必须在这个文件里测（不能只测纯函数）=====
 *
 * `shared/play-time.ts` 的单测只证明「给定一条记录，展示形态算得对」。
 * 它**完全覆盖不到**这条链路：play-stats.json → createPlayStatsStore → ipc
 * → games-store.snapshot(extra) → 渲染层。
 *
 * 而 M4.1 S4 踩过的正是这一段：**类型声明写了字段、真实数据里却没有**
 * （`ModuleInfo.raw` 永远 null，TS 通过、页面不报错、参数表单整块消失）。
 * 所以这里断言的是「snapshot 那个对象里**真的有** playStats」，不是类型。
 */
describe('N1：Snapshot.playStats（游玩记录的只读投影）', () => {
  test('没有记录时是空对象（不是 undefined，UI 不用判空）', () => {
    makeGame('1')
    const dispatcher = createDispatcher({ host })
    const snap = dispatcher.snapshot() as { playStats: Record<string, unknown> }
    expect(snap.playStats).toBeTypeOf('object')
    expect(snap.playStats).not.toBeNull()
    expect(Object.keys(snap.playStats)).toHaveLength(0)
  })

  test('★ 启动后 snapshot 里真的出现该游戏的记录（不是只写在类型里）', async () => {
    makeGame('1')
    const fake = fakeProcess()
    const spawned = fakeSpawn()
    const dispatcher = createDispatcher({ host, process: { ...fake, spawn: spawned.spawn } })
    await dispatcher.dispatch('launch', { id: '1', diagnose: false }, new AbortController().signal)

    const snap = dispatcher.snapshot() as {
      playStats: Record<string, { playCount: number; totalSeconds: number; lastPlayedAt: string }>
    }
    expect(Object.hasOwn(snap.playStats, '1')).toBe(true)
    expect(snap.playStats['1'].playCount).toBe(1)
    // 进程还活着 → 时长仍是 0（只有正常退出才累加）
    expect(snap.playStats['1'].totalSeconds).toBe(0)
    expect(snap.playStats['1'].lastPlayedAt).toBeTruthy()
  })

  test('进程退出后 snapshot 里的时长被累加', async () => {
    makeGame('1')
    const fake = fakeProcess()
    const spawned = fakeSpawn()
    const dispatcher = createDispatcher({ host, process: { ...fake, spawn: spawned.spawn } })
    await dispatcher.dispatch('launch', { id: '1', diagnose: false }, new AbortController().signal)
    // 直接让假进程报退出（而不是走 stopGame，那样要等两段式）
    spawned.children[0]?.emit('exit', 0, null)
    await wait()

    const snap = dispatcher.snapshot() as {
      playStats: Record<string, { totalSeconds: number; playCount: number }>
    }
    expect(snap.playStats['1'].playCount).toBe(1)
    expect(snap.playStats['1'].totalSeconds).toBeGreaterThanOrEqual(0)
  })

  test('⚠️ play-stats.json 坏掉时 snapshot 仍然可用（统计坏了不该让整页崩）', async () => {
    // readJSON 对损坏文件会抛（它绝不静默覆盖用户数据，见 play-stats.ts）。
    // 那是正确行为，但 snapshot 必须把它降级成「没有记录」——
    // 一份统计文件坏了不该让用户连游戏库都看不见。
    makeGame('1')
    fs.writeFileSync(path.join(dataDir, 'play-stats.json'), '{ this is not json')
    const dispatcher = createDispatcher({ host })
    const snap = dispatcher.snapshot() as { playStats: Record<string, unknown>; games: unknown[] }
    expect(snap.playStats).toEqual({})
    // 游戏库本身照常下发
    expect(snap.games.length).toBeGreaterThan(0)
  })
})

describe('S4：Snapshot.running（运行态的只读投影）', () => {  test('没有运行中的游戏时是空数组（不是 undefined，UI 不用判空）', () => {
    makeGame('1')
    const dispatcher = createDispatcher({ host })
    const snap = dispatcher.snapshot() as { running: unknown[] }
    expect(Array.isArray(snap.running)).toBe(true)
    expect(snap.running).toHaveLength(0)
  })

  test('启动后 snapshot 里出现该游戏（gameId / pid / startedAt）', async () => {
    makeGame('1')
    const fake = fakeProcess()
    const spawned = fakeSpawn()
    const dispatcher = createDispatcher({ host, process: { ...fake, spawn: spawned.spawn } })
    await dispatcher.dispatch('launch', { id: '1', diagnose: false }, new AbortController().signal)

    const snap = dispatcher.snapshot() as { running: Array<Record<string, unknown>> }
    expect(snap.running).toHaveLength(1)
    expect(snap.running[0].gameId).toBe('1')
    expect(typeof snap.running[0].pid).toBe('number')
    expect(typeof snap.running[0].startedAt).toBe('string')
    // 命令串与 execPath **不该**过桥（UI 用不到，还可能带本地路径）
    expect(snap.running[0].command).toBeUndefined()
    expect(snap.running[0].execPath).toBeUndefined()
  })

  test('snapshot 的 running 与 runningGames 命令是同一份数据', async () => {
    makeGame('1')
    const fake = fakeProcess()
    const spawned = fakeSpawn()
    const dispatcher = createDispatcher({ host, process: { ...fake, spawn: spawned.spawn } })
    await dispatcher.dispatch('launch', { id: '1', diagnose: false }, new AbortController().signal)
    const fromCommand = (await dispatcher.dispatch(
      'runningGames',
      {},
      new AbortController().signal
    )) as Array<{ gameId: string }>
    const snap = dispatcher.snapshot() as { running: Array<{ gameId: string }> }
    expect(fromCommand.map((x) => x.gameId)).toEqual(snap.running.map((x) => x.gameId))
  })
})

describe('S3：launch 接上进程表 + 游玩记录', () => {
  test('启动成功 → 进程表有登记 + gameStarted 事件 + play-stats.json 落盘', async () => {
    makeGame('1')
    const fake = fakeProcess()
    const spawned = fakeSpawn()
    const dispatcher = createDispatcher({ host, process: { ...fake, spawn: spawned.spawn } })
    const result = await dispatcher.dispatch('launch', { id: '1', diagnose: false }, new AbortController().signal)
    expect('message' in (result as object)).toBe(true)

    expect(dispatcher.runningGames()).toHaveLength(1)
    const started = events.filter((event) => event.event === 'gameStarted')
    expect(started).toHaveLength(1)
    expect(started[0].gameId).toBe('1')
    expect(started[0].engine).toBe('mkxpz')
    expect(typeof started[0].pid).toBe('number')

    // 游玩记录：playCount +1，lastPlayedAt 有值，时长还是 0（进程没退）
    const statsFile = path.join(dataDir, 'play-stats.json')
    expect(fs.existsSync(statsFile)).toBe(true)
    const stats = createPlayStatsStore(dataDir).load()
    expect(stats['1'].playCount).toBe(1)
    expect(stats['1'].totalSeconds).toBe(0)
    expect(stats['1'].lastPlayedAt).toBeTruthy()
  })

  test('★ 进程表里的 execPath 是我们 spawn 的那个 binary（PID 复用复核要用它）', async () => {
    makeGame('1')
    const fake = fakeProcess()
    const spawned = fakeSpawn()
    const dispatcher = createDispatcher({ host, process: { ...fake, spawn: spawned.spawn } })
    await dispatcher.dispatch('launch', { id: '1', diagnose: false }, new AbortController().signal)

    const entry = dispatcher.runningGames()[0] as unknown as { execPath: string; command: string }
    // mkxpz 的 binary 是我们自己拼出来的路径（不是从命令串里解析的）
    expect(entry.execPath).toContain('Z-Universal')
    expect(entry.command).toContain(entry.execPath)
  })

  test('进程退出 → 记录被清 + gameExited 事件 + 时长累加', async () => {
    makeGame('1')
    const fake = fakeProcess()
    const spawned = fakeSpawn({ exitImmediately: true })
    const dispatcher = createDispatcher({ host, process: { ...fake, spawn: spawned.spawn } })
    await dispatcher.dispatch('launch', { id: '1', diagnose: false }, new AbortController().signal)
    await wait()

    expect(dispatcher.runningGames()).toHaveLength(0)
    const exited = events.filter((event) => event.event === 'gameExited')
    expect(exited).toHaveLength(1)
    expect(exited[0].gameId).toBe('1')
    expect(exited[0].exitCode).toBe(0)

    const stats = createPlayStatsStore(dataDir).load()
    expect(stats['1'].playCount).toBe(1)
    // 立刻退出 → 时长通常 0（不足 1 秒按 0 记，见 sessionSeconds 的单测）
    expect(stats['1'].totalSeconds).toBeGreaterThanOrEqual(0)
  })

  test('同一个游戏重复启动被拒（否则 PID 记录会打架）', async () => {
    makeGame('1')
    const fake = fakeProcess()
    const spawned = fakeSpawn()
    const dispatcher = createDispatcher({ host, process: { ...fake, spawn: spawned.spawn } })
    await dispatcher.dispatch('launch', { id: '1', diagnose: false }, new AbortController().signal)

    await expect(
      dispatcher.dispatch('launch', { id: '1', diagnose: false }, new AbortController().signal)
    ).rejects.toThrow(/already running/i)
    // 表里仍只有一条
    expect(dispatcher.runningGames()).toHaveLength(1)
    // 游玩次数没有被第二次（失败的）启动污染
    expect(createPlayStatsStore(dataDir).load()['1'].playCount).toBe(1)
    // 也只 spawn 了一次（没起来第二个进程）
    expect(spawned.plans).toHaveLength(1)
  })

  test('被 fatal 诊断拦下时**不**登记进程、**不**记游玩次数（被拦下的不算启动）', async () => {
    const dir = path.join(dataDir, 'encrypted')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'Game.exe'), 'MZ')
    fs.writeFileSync(path.join(dir, 'Game.rgss3a'), Buffer.from([0x52, 0x47, 0x53, 0x53, 0x41, 0x44, 0x00, 0x03]))
    fs.writeFileSync(path.join(dir, 'Game.ini'), '[Game]\r\nRTP=RPGVXAce\r\n')
    installFakeModule('mkxpz')
    host.store.saveGame({
      game: { gameTitle: '加密游戏', gamePath: dir, gameEngine: 'mkxpz', gameArgs: {} }
    })
    // 打开诊断（beforeEach 里关掉了）
    host.store.saveSettings({ diagnoseBeforeLaunch: true })

    const fake = fakeProcess()
    const spawned = fakeSpawn()
    const dispatcher = createDispatcher({ host, process: { ...fake, spawn: spawned.spawn } })
    const result = (await dispatcher.dispatch('launch', { id: '1' }, new AbortController().signal)) as {
      blocked?: boolean
    }
    expect(result.blocked).toBe(true)
    expect(dispatcher.runningGames()).toHaveLength(0)
    expect(fs.existsSync(path.join(dataDir, 'play-stats.json'))).toBe(false)
    expect(events.filter((event) => event.event === 'gameStarted')).toHaveLength(0)
    // 关键：被拦下时**根本没 spawn**
    expect(spawned.plans).toHaveLength(0)
  })
})

describe('M4.0 S5：未知引擎不回退（D57）', () => {
  test('已装了 ruffle 的用户点启动 → 报 error.engineNotLaunchable，且不 spawn', async () => {
    makeGame('1', 'ruffle')
    const fake = fakeProcess()
    const spawned = fakeSpawn()
    const dispatcher = createDispatcher({ host, process: { ...fake, spawn: spawned.spawn } })

    await expect(
      dispatcher.dispatch('launch', { id: '1', diagnose: false }, new AbortController().signal)
    ).rejects.toMatchObject({ translationKey: 'error.engineNotLaunchable' })

    // 绝不回退到别的引擎，也绝不登记
    expect(spawned.plans).toHaveLength(0)
    expect(dispatcher.runningGames()).toHaveLength(0)
    // 也不记游玩次数（没启动成功）
    expect(fs.existsSync(path.join(dataDir, 'play-stats.json'))).toBe(false)
  })
})

describe('M4.0 S5：prepare 失败 → 不启动', () => {
  test('mkxp.json 写不进（app 包内位置被占）→ 报 launchPrepareFailed，且不 spawn', async () => {
    makeGame('1')
    // M5.2：配置写在 app 包内的 Contents/Game/mkxp.json（实测那份 mkxp-z 只读这里）。
    // 造一条写不进去的场景：把 Contents 这个位置占成**文件**，让 mkdirSync 必失败。
    const appRoot = path.join(dataDir, 'modules', 'mkxpz', 'deps', 'mkxpz', 'Z-Universal.app')
    fs.mkdirSync(appRoot, { recursive: true })
    fs.writeFileSync(path.join(appRoot, 'Contents'), 'blocker')

    const fake = fakeProcess()
    const spawned = fakeSpawn()
    const dispatcher = createDispatcher({ host, process: { ...fake, spawn: spawned.spawn } })

    await expect(
      dispatcher.dispatch('launch', { id: '1', diagnose: false }, new AbortController().signal)
    ).rejects.toMatchObject({ translationKey: 'error.launchPrepareFailed' })
    expect(spawned.plans).toHaveLength(0)
    expect(dispatcher.runningGames()).toHaveLength(0)
  })
})

describe('S3：stopGame（SIGTERM → 5s → SIGKILL，D52）', () => {
  test('未运行时给出可翻译的错误（不是静默成功）', async () => {
    makeGame('1')
    const dispatcher = createDispatcher({ host, process: fakeProcess() })
    await expect(dispatcher.dispatch('stopGame', { gameId: '1' }, new AbortController().signal)).rejects.toMatchObject({
      translationKey: 'error.gameNotRunning'
    })
  })

  test('温和退出：只发 SIGTERM，返回 terminated', async () => {
    makeGame('1')
    const fake = fakeProcess({ exitOnTerm: true })
    const spawned = fakeSpawn()
    const dispatcher = createDispatcher({ host, process: { ...fake, spawn: spawned.spawn } })
    await dispatcher.dispatch('launch', { id: '1', diagnose: false }, new AbortController().signal)
    const entry = dispatcher.runningGames()[0]
    fake.alive.set(entry.pid, true)

    const result = (await dispatcher.dispatch('stopGame', { gameId: '1' }, new AbortController().signal)) as {
      action: string
      messageKey: string
    }
    expect(result.action).toBe('terminated')
    expect(result.messageKey).toBe('library.stopGraceful')
    expect(fake.signals).toEqual([{ pid: entry.pid, name: 'SIGTERM' }])
    // 没有走到 SIGKILL
    expect(fake.signals.some((item) => item.name === 'SIGKILL')).toBe(false)
  })

  test('叫不退：SIGTERM 之后补 SIGKILL，返回 killed', async () => {
    makeGame('1')
    const fake = fakeProcess({ exitOnTerm: false })
    const spawned = fakeSpawn()
    const dispatcher = createDispatcher({ host, process: { ...fake, spawn: spawned.spawn } })
    await dispatcher.dispatch('launch', { id: '1', diagnose: false }, new AbortController().signal)
    const entry = dispatcher.runningGames()[0]
    fake.alive.set(entry.pid, true)

    const result = (await dispatcher.dispatch('stopGame', { gameId: '1' }, new AbortController().signal)) as {
      action: string
      messageKey: string
    }
    expect(result.action).toBe('killed')
    expect(result.messageKey).toBe('library.stopKilled')
    expect(fake.signals.map((item) => item.name)).toEqual(['SIGTERM', 'SIGKILL'])
  })

  test('进程其实早没了（退出回调没到）→ 清脏记录并报未运行', async () => {
    makeGame('1')
    const fake = fakeProcess()
    const spawned = fakeSpawn()
    const dispatcher = createDispatcher({ host, process: { ...fake, spawn: spawned.spawn } })
    await dispatcher.dispatch('launch', { id: '1', diagnose: false }, new AbortController().signal)
    const entry = dispatcher.runningGames()[0]
    fake.alive.set(entry.pid, false) // 假装它死了但回调没到

    await expect(dispatcher.dispatch('stopGame', { gameId: '1' }, new AbortController().signal)).rejects.toMatchObject({
      translationKey: 'error.gameNotRunning'
    })
    // 脏记录必须被清掉，否则 UI 永远显示「运行中」
    expect(dispatcher.runningGames()).toHaveLength(0)
  })

  test('PID 复用防护：读到的可执行文件明显不是同一个 → 拒绝并清记录', async () => {
    makeGame('1')
    const fake = fakeProcess()
    const spawned = fakeSpawn()
    const dispatcher = createDispatcher({ host, process: { ...fake, spawn: spawned.spawn } })
    await dispatcher.dispatch('launch', { id: '1', diagnose: false }, new AbortController().signal)
    const entry = dispatcher.runningGames()[0]
    fake.alive.set(entry.pid, true)
    // 那个号现在跑的是别的东西（记录里是 Z-Universal）
    fake.commands.set(entry.pid, 'finder')

    await expect(dispatcher.dispatch('stopGame', { gameId: '1' }, new AbortController().signal)).rejects.toMatchObject({
      translationKey: 'error.gameNotRunning'
    })
    expect(dispatcher.runningGames()).toHaveLength(0)
    // 关键：**没有**发出任何信号（绝不能杀掉无关进程）
    expect(fake.signals).toHaveLength(0)
  })
})

describe('进程表与游玩记录的接线细节', () => {
  test('registry.add 拒绝覆盖同 gameId（D50 的不可变语义）', () => {
    const registry: ProcessRegistry = createProcessRegistry()
    const entry = { gameId: '1', pid: 42, engine: 'mkxpz', command: 'x', execPath: 'mkxpz', startedAt: 't' }
    expect(registry.add(entry)).toBe(true)
    expect(registry.add({ ...entry, pid: 99 })).toBe(false)
    expect(registry.get('1')?.pid).toBe(42)
  })

  test('registry.remove 带 pid 复核：迟到的旧回调不会删掉新记录', () => {
    const registry: ProcessRegistry = createProcessRegistry()
    registry.add({ gameId: '1', pid: 42, engine: 'mkxpz', command: 'x', execPath: 'mkxpz', startedAt: 't' })
    expect(registry.remove('1', 99)).toBe(false)
    expect(registry.has('1')).toBe(true)
    expect(registry.remove('1', 42)).toBe(true)
    expect(registry.has('1')).toBe(false)
  })

  test('删除不存在的记录不抛错', () => {
    const registry: ProcessRegistry = createProcessRegistry()
    expect(registry.remove('nope')).toBe(false)
  })
})
