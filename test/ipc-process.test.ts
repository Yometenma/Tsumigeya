// M3.5 S3/S4 单测：进程追踪 / 关闭 / 游玩记录在 IPC 层的行为。
//
// 用假 host（tmpdir）+ 假的进程实现（不真起子进程、不真 kill），全程离线、毫秒级。
// 这里要钉死的是**决策**而不是系统调用：
//   · 启动成功后进程表里有记录、游玩记录落盘、发 gameStarted 事件
//   · 退出后记录被清、时长累加、发 gameExited 事件
//   · 重复启动同一个游戏被拒（否则 PID 记录会打架）
//   · stopGame 两段式：能温和退出就不 kill；叫不退才 kill（D52）
//   · PID 复用：明确不像 → 拒绝并清脏记录
//   · 诊断拦下时**不**登记进程、**不**记游玩次数（被拦下的不算「启动成功」）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createCoreHost, resolveCorePath, type CoreEvent } from '../src/main/core-host'
import { createDispatcher, type ProcessDeps } from '../src/main/ipc'
import { createPlayStatsStore } from '../src/main/play-stats'
import { createProcessRegistry, type ProcessRegistry } from '../src/main/process-registry'

let dataDir: string
let host: ReturnType<typeof createCoreHost>
let events: CoreEvent[]

/** 上游 launcher 的形态：调 exec、丢弃返回值。这里用 node 自身 echo 当「游戏」。 */
const LAUNCHER = `
const { exec } = require('child_process')
exports.launch = function () {
  exec('node -e "setTimeout(()=>{},60000)"', () => {})
}
`
/** 立刻退出的「游戏」：用来测退出回调与时长累加。 */
const LAUNCHER_INSTANT_EXIT = `
const { exec } = require('child_process')
exports.launch = function () { exec('node -e ""', () => {}) }
`

function installFakeModule(folder: string, template: string): void {
  const dir = path.join(dataDir, 'modules', folder)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      name: folder,
      version: '1.0.0',
      // autodetect 让诊断把「缺引擎」判成已装（我们这里只关心进程管理）
      autodetect: { extensions: ['exe'] }
    })
  )
  fs.writeFileSync(path.join(dir, 'launcher.js'), template)
}

function makeGame(id: string, kind: 'long' | 'instant' = 'long'): void {
  const dir = path.join(dataDir, `game-${id}`)
  fs.mkdirSync(path.join(dir, 'www'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'Game.exe'), 'MZ')
  fs.writeFileSync(path.join(dir, 'nw.dll'), '')
  fs.writeFileSync(path.join(dir, 'www', 'package.json'), '{}')
  installFakeModule(kind === 'long' ? 'mkxpz' : 'easyrpg', kind === 'long' ? LAUNCHER : LAUNCHER_INSTANT_EXIT)
  host.store.saveGame({
    game: {
      gameTitle: `游戏 ${id}`,
      gamePath: dir,
      gameEngine: kind === 'long' ? 'mkxpz' : 'easyrpg',
      gameArgs: {}
    }
  })
}

/** 假进程实现：PID 全由测试自己记账，不发真信号。 */
interface FakeProcess extends ProcessDeps {
  alive: Map<number, boolean>
  signals: Array<{ pid: number; name: NodeJS.Signals }>
  commands: Map<number, string>
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
    corePath: resolveCorePath({ isPackaged: false, appPath: process.cwd() }),
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

/** 等一段时间，让 exec 的回调 / 事件跑到。 */
function wait(ms = 400): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('S4：Snapshot.running（运行态的只读投影）', () => {
  test('没有运行中的游戏时是空数组（不是 undefined，UI 不用判空）', () => {
    makeGame('1')
    const dispatcher = createDispatcher({ host })
    const snap = dispatcher.snapshot() as { running: unknown[] }
    expect(Array.isArray(snap.running)).toBe(true)
    expect(snap.running).toHaveLength(0)
  })

  test('启动后 snapshot 里出现该游戏（gameId / pid / startedAt）', async () => {
    makeGame('1')
    const fake = fakeProcess()
    const dispatcher = createDispatcher({ host, process: fake })
    await dispatcher.dispatch('launch', { id: '1', diagnose: false }, new AbortController().signal)
    await wait()

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
    const dispatcher = createDispatcher({ host, process: fake })
    await dispatcher.dispatch('launch', { id: '1', diagnose: false }, new AbortController().signal)
    await wait()
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
    const dispatcher = createDispatcher({ host, process: fake })
    const result = await dispatcher.dispatch('launch', { id: '1', diagnose: false }, new AbortController().signal)
    expect('message' in (result as object)).toBe(true)
    await wait()

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

  test('进程退出 → 记录被清 + gameExited 事件 + 时长累加', async () => {
    makeGame('1', 'instant')
    const fake = fakeProcess()
    const dispatcher = createDispatcher({ host, process: fake })
    await dispatcher.dispatch('launch', { id: '1', diagnose: false }, new AbortController().signal)
    await wait(800)

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
    const dispatcher = createDispatcher({ host, process: fake })
    await dispatcher.dispatch('launch', { id: '1', diagnose: false }, new AbortController().signal)
    await wait()

    await expect(
      dispatcher.dispatch('launch', { id: '1', diagnose: false }, new AbortController().signal)
    ).rejects.toThrow(/already running/i)
    // 表里仍只有一条
    expect(dispatcher.runningGames()).toHaveLength(1)
    // 游玩次数没有被第二次（失败的）启动污染
    expect(createPlayStatsStore(dataDir).load()['1'].playCount).toBe(1)
  })

  test('被 fatal 诊断拦下时**不**登记进程、**不**记游玩次数（被拦下的不算启动）', async () => {
    const dir = path.join(dataDir, 'encrypted')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'Game.exe'), 'MZ')
    fs.writeFileSync(path.join(dir, 'Game.rgss3a'), Buffer.from([0x52, 0x47, 0x53, 0x53, 0x41, 0x44, 0x00, 0x03]))
    fs.writeFileSync(path.join(dir, 'Game.ini'), '[Game]\nRTP=RPGVXAce\r\n')
    installFakeModule('mkxpz', LAUNCHER)
    host.store.saveGame({
      game: { gameTitle: '加密游戏', gamePath: dir, gameEngine: 'mkxpz', gameArgs: {} }
    })
    // 打开诊断（beforeEach 里关掉了）
    host.store.saveSettings({ diagnoseBeforeLaunch: true })

    const fake = fakeProcess()
    const dispatcher = createDispatcher({ host, process: fake })
    const result = (await dispatcher.dispatch('launch', { id: '1' }, new AbortController().signal)) as {
      blocked?: boolean
    }
    expect(result.blocked).toBe(true)
    expect(dispatcher.runningGames()).toHaveLength(0)
    expect(fs.existsSync(path.join(dataDir, 'play-stats.json'))).toBe(false)
    expect(events.filter((event) => event.event === 'gameStarted')).toHaveLength(0)
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
    const dispatcher = createDispatcher({ host, process: fake })
    await dispatcher.dispatch('launch', { id: '1', diagnose: false }, new AbortController().signal)
    await wait()
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
    const dispatcher = createDispatcher({ host, process: fake })
    await dispatcher.dispatch('launch', { id: '1', diagnose: false }, new AbortController().signal)
    await wait()
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
    const dispatcher = createDispatcher({ host, process: fake })
    await dispatcher.dispatch('launch', { id: '1', diagnose: false }, new AbortController().signal)
    await wait()
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
    const dispatcher = createDispatcher({ host, process: fake })
    await dispatcher.dispatch('launch', { id: '1', diagnose: false }, new AbortController().signal)
    await wait()
    const entry = dispatcher.runningGames()[0]
    fake.alive.set(entry.pid, true)
    // 那个号现在跑的是别的东西（execPath 记录的是 nwjs）
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
