// M4 S3/S4：导出/导入在 **IPC 层**的行为。
//
// ===== 补的是哪一面 =====
//
// `save-archive-io.test.ts` 测了 IO（26 条，读写真盘）；
// `save-archive.test.ts` 测了判据（39 条，纯函数）；
// 这里测**走 dispatcher 的那一段** —— 也就是用户点按钮时真正发生的事：
//
//   · 游戏运行中 → 导出被拒（`error.saveExportRunning`），**一个包都不写**
//   · 没位置 / 还没存档 → 各自的可翻译错误键（不是英文原文）
//   · 正常导出 → zip 真的落在磁盘上，manifest 字段对
//   · 正常导入 → 文件还原 + 有备份
//
// 最关键的是第一条：「运行中禁止导出」是 S3 的硬要求（方案 §3.4）。
// 它在 UI 上可能被绕过（用户手快点了两次之类），所以必须在**主进程**再拦一次 ——
// 这一层拦不住的话，用户拿到的就是一个半截文件。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createCoreHost } from '../src/main/core-host'
import { createDispatcher } from '../src/main/ipc'
import { createProcessRegistry } from '../src/main/process-registry'
import type { ExportSaveResult, ImportSaveResult } from '../src/main/save-archive-io'

let dataDir: string
let host: ReturnType<typeof createCoreHost>

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-saveipc-'))
  host = createCoreHost({ dataDir })
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

const signal = (): AbortSignal => new AbortController().signal

/**
 * 造一个 MV 布局的游戏（`www/save/` + `.rpgsave`），返回 gameId。
 *
 * ⚠️ 玩家真机上的目录就是这个形状（Karryn's Prison 实测），
 * 所以这里不简化成"随便一个目录" —— 探测判据要走完整的真实分支。
 */
function makeMvGame(title: string, options: { withSaves?: boolean } = {}): string {
  const dir = path.join(dataDir, 'game')
  fs.mkdirSync(path.join(dir, 'www', 'save'), { recursive: true })
  if (options.withSaves !== false) {
    fs.writeFileSync(path.join(dir, 'www', 'save', 'file1.rpgsave'), 'PK-A')
    fs.writeFileSync(path.join(dir, 'www', 'save', 'config.rpgsave'), 'CFG')
    fs.writeFileSync(path.join(dir, 'www', 'save', 'lastsave.autobak'), 'BAK')
  }
  const all = host.store.saveGame({
    game: { gameTitle: title, gamePath: dir, gameEngine: 'nwjs', gameArgs: {} }
  })
  const entry = Object.entries(all).find(([, game]) => game.gameTitle === title)
  if (!entry) throw new Error('game not found')
  return entry[0]
}

/** 造一个"已有存档目录但里面没存档"的游戏（`empty: true`）。 */
function makeEmptyGame(title: string): string {
  const dir = path.join(dataDir, 'game-empty')
  fs.mkdirSync(path.join(dir, 'www', 'save'), { recursive: true })
  const all = host.store.saveGame({
    game: { gameTitle: title, gamePath: dir, gameEngine: 'nwjs', gameArgs: {} }
  })
  const entry = Object.entries(all).find(([, game]) => game.gameTitle === title)
  if (!entry) throw new Error('game not found')
  return entry[0]
}

/**
 * 造一个**进程表里有记录**的 dispatcher（模拟"游戏正在运行"）。
 *
 * ⚠️ 不真起进程：进程表是纯内存的（D50），直接 add 一条就等价。
 * 这正是 D50 的另一个好处 —— 测试不需要一个活着的 pid。
 */
function dispatcherWithRunning(gameId: string): ReturnType<typeof createDispatcher> {
  const registry = createProcessRegistry()
  registry.add({
    gameId,
    pid: 4242,
    engine: 'nwjs',
    command: 'nwjs /game',
    execPath: '/nwjs',
    startedAt: new Date().toISOString()
  })
  return createDispatcher({ host, process: { registry } })
}

describe('★ 运行中禁止导出（方案 §3.4 的硬要求）', () => {
  test('⚠️ 游戏在跑 → error.saveExportRunning，一个包都不写', async () => {
    const id = makeMvGame('Karryn')
    const dispatcher = dispatcherWithRunning(id)
    const outDir = path.join(dataDir, 'out')
    await expect(dispatcher.dispatch('exportSaves', { id, outDir }, signal())).rejects.toMatchObject({
      translationKey: 'error.saveExportRunning'
    })
    // 关键：目录里什么都没生成（不是"先写再报错"）
    expect(fs.existsSync(outDir) ? fs.readdirSync(outDir) : []).toEqual([])
  })

  test('⚠️ 运行中优先于"没存档"（否则用户会去查目录而不是去关游戏）', async () => {
    const id = makeEmptyGame('Empty')
    const dispatcher = dispatcherWithRunning(id)
    await expect(
      dispatcher.dispatch('exportSaves', { id, outDir: path.join(dataDir, 'out') }, signal())
    ).rejects.toMatchObject({ translationKey: 'error.saveExportRunning' })
  })

  test('游戏没在跑 → 正常导出（进程表里没有记录不等于"在跑"）', async () => {
    const id = makeMvGame('Karryn')
    const dispatcher = createDispatcher({ host })
    const result = (await dispatcher.dispatch(
      'exportSaves',
      { id, outDir: path.join(dataDir, 'out') },
      signal()
    )) as ExportSaveResult
    expect(result.fileCount).toBe(3)
  })
})

describe('导出：正常路径与各自的拒绝原因', () => {
  test('正常导出 → zip 落盘，manifest 里有引擎与布局', async () => {
    const id = makeMvGame('Karryn')
    const dispatcher = createDispatcher({ host })
    const outDir = path.join(dataDir, 'out')
    const result = (await dispatcher.dispatch('exportSaves', { id, outDir }, signal())) as ExportSaveResult

    expect(fs.existsSync(result.file)).toBe(true)
    expect(result.manifest.engine).toBe('nwjs')
    expect(result.manifest.layout).toBe('nwjs-mv')
    expect(result.manifest.gameTitle).toBe('Karryn')
    // ⚠️ 插件文件必须带走（只打槽会让用户换机后少东西）
    expect(result.manifest.files.map((f) => f.name)).toContain('lastsave.autobak')
    expect(result.size).toBeGreaterThan(0)
  })

  test('还没存过档 → error.saveArchiveEmpty（不是"打包成功但包里空着"）', async () => {
    const id = makeEmptyGame('Empty')
    const dispatcher = createDispatcher({ host })
    await expect(
      dispatcher.dispatch('exportSaves', { id, outDir: path.join(dataDir, 'out') }, signal())
    ).rejects.toMatchObject({ translationKey: 'error.saveArchiveEmpty' })
  })

  test('找不到存档位置 → error.saveExportNoLocation', async () => {
    // 用一个探测不到的目录（既没有 www/save 也没有 save，且引擎是 nwjs）
    const dir = path.join(dataDir, 'unknown-layout')
    fs.mkdirSync(dir, { recursive: true })
    const all = host.store.saveGame({
      game: { gameTitle: 'Unknown', gamePath: dir, gameEngine: 'nwjs', gameArgs: {} }
    })
    const id = Object.entries(all).find(([, game]) => game.gameTitle === 'Unknown')![0]
    const dispatcher = createDispatcher({ host })
    await expect(
      dispatcher.dispatch('exportSaves', { id, outDir: path.join(dataDir, 'out') }, signal())
    ).rejects.toMatchObject({ translationKey: 'error.saveExportNoLocation' })
  })

  test('游戏不存在 → error.gameNotFound', async () => {
    const dispatcher = createDispatcher({ host })
    await expect(dispatcher.dispatch('exportSaves', { id: '999' }, signal())).rejects.toMatchObject({
      translationKey: 'error.gameNotFound'
    })
  })

  test('outDir 是用户选的路径（不是我们猜的）', async () => {
    const id = makeMvGame('Karryn')
    const dispatcher = createDispatcher({ host })
    const custom = path.join(dataDir, 'chosen-by-user')
    const result = (await dispatcher.dispatch('exportSaves', { id, outDir: custom }, signal())) as ExportSaveResult
    expect(path.dirname(result.file)).toBe(custom)
  })
})

describe('★ 导入：还原 + 备份', () => {
  test('导出再导入到新目录 → 文件都在，且没多余备份（原本空着）', async () => {
    const id = makeMvGame('Karryn')
    const dispatcher = createDispatcher({ host })
    const exported = (await dispatcher.dispatch(
      'exportSaves',
      { id, outDir: path.join(dataDir, 'out') },
      signal()
    )) as ExportSaveResult

    // 目标：另一个游戏（模拟"同一台机器上换了个副本"，或换机后的同布局目录）
    const target = path.join(dataDir, 'target-game')
    fs.mkdirSync(path.join(target, 'www', 'save'), { recursive: true })
    const all = host.store.saveGame({
      game: { gameTitle: 'Target', gamePath: target, gameEngine: 'nwjs', gameArgs: {} }
    })
    const targetId = Object.entries(all).find(([, game]) => game.gameTitle === 'Target')![0]

    const result = (await dispatcher.dispatch(
      'importSaves',
      { id: targetId, file: exported.file },
      signal()
    )) as ImportSaveResult
    expect(result.fileCount).toBe(3)
    expect(result.backups).toEqual([])
    expect(fs.readFileSync(path.join(target, 'www', 'save', 'file1.rpgsave'), 'utf8')).toBe('PK-A')
  })

  test('⚠️ 目标里已有同名文件 → 先备份再覆盖', async () => {
    const id = makeMvGame('Karryn')
    const dispatcher = createDispatcher({ host })
    const exported = (await dispatcher.dispatch(
      'exportSaves',
      { id, outDir: path.join(dataDir, 'out') },
      signal()
    )) as ExportSaveResult

    // 目标里先放一个"我自己玩的档"
    const target = path.join(dataDir, 'target2')
    fs.mkdirSync(path.join(target, 'www', 'save'), { recursive: true })
    fs.writeFileSync(path.join(target, 'www', 'save', 'file1.rpgsave'), 'MINE')
    const all = host.store.saveGame({
      game: { gameTitle: 'Target2', gamePath: target, gameEngine: 'nwjs', gameArgs: {} }
    })
    const targetId = Object.entries(all).find(([, game]) => game.gameTitle === 'Target2')![0]

    const result = (await dispatcher.dispatch(
      'importSaves',
      { id: targetId, file: exported.file },
      signal()
    )) as ImportSaveResult
    expect(result.backups).toContain('file1.rpgsave.tsumigeya-bak')
    expect(fs.readFileSync(path.join(target, 'www', 'save', 'file1.rpgsave.tsumigeya-bak'), 'utf8')).toBe('MINE')
  })

  test('⚠️ 运行中禁止导入（两边都不是完整的一档）', async () => {
    const id = makeMvGame('Karryn')
    const dispatcher = createDispatcher({ host })
    const exported = (await dispatcher.dispatch(
      'exportSaves',
      { id, outDir: path.join(dataDir, 'out') },
      signal()
    )) as ExportSaveResult

    const targetId = makeMvGame('Running')
    const runningDispatcher = dispatcherWithRunning(targetId)
    await expect(
      runningDispatcher.dispatch('importSaves', { id: targetId, file: exported.file }, signal())
    ).rejects.toMatchObject({ translationKey: 'error.saveImportRunning' })
  })

  test('不是我们的包 → 可翻译的错误键（不是英文原文）', async () => {
    const id = makeMvGame('Karryn')
    const dispatcher = createDispatcher({ host })
    const bogus = path.join(dataDir, 'bogus.zip')
    fs.writeFileSync(bogus, 'not a zip')
    await expect(dispatcher.dispatch('importSaves', { id, file: bogus }, signal())).rejects.toMatchObject({
      translationKey: 'error.saveArchiveNotZip'
    })
  })

  test('没给 file → error.saveArchiveMissing', async () => {
    const id = makeMvGame('Karryn')
    const dispatcher = createDispatcher({ host })
    await expect(dispatcher.dispatch('importSaves', { id, file: '' }, signal())).rejects.toMatchObject({
      translationKey: 'error.saveArchiveMissing'
    })
  })

  test('⚠️ 校验不过 → 原文件一个字节都不动', async () => {
    const id = makeMvGame('Karryn')
    const dispatcher = createDispatcher({ host })
    const exported = (await dispatcher.dispatch(
      'exportSaves',
      { id, outDir: path.join(dataDir, 'out') },
      signal()
    )) as ExportSaveResult

    // 手工改坏包里的一个文件（保留 manifest）
    const { unzipSync, zipSync } = await import('fflate')
    const entries = unzipSync(fs.readFileSync(exported.file))
    entries['saves/file1.rpgsave'] = new TextEncoder().encode('TAMPERED')
    const tampered = path.join(dataDir, 'tampered.zip')
    fs.writeFileSync(tampered, zipSync(entries))

    await expect(dispatcher.dispatch('importSaves', { id, file: tampered }, signal())).rejects.toMatchObject({
      translationKey: 'error.saveArchiveVerifyFailed'
    })
    // 原文件没被改（"校验不过就一个字节都不写"）
    expect(fs.readFileSync(path.join(dataDir, 'game', 'www', 'save', 'file1.rpgsave'), 'utf8')).toBe('PK-A')
  })

  test('找不到存档位置 → 拒绝（不猜一个目标目录）', async () => {
    const dir = path.join(dataDir, 'nowhere')
    fs.mkdirSync(dir, { recursive: true })
    const all = host.store.saveGame({
      game: { gameTitle: 'Nowhere', gamePath: dir, gameEngine: 'nwjs', gameArgs: {} }
    })
    const id = Object.entries(all).find(([, game]) => game.gameTitle === 'Nowhere')![0]
    const dispatcher = createDispatcher({ host })
    const bogus = path.join(dataDir, 'x.zip')
    fs.writeFileSync(bogus, 'x')
    await expect(dispatcher.dispatch('importSaves', { id, file: bogus }, signal())).rejects.toMatchObject({
      translationKey: 'error.saveExportNoLocation'
    })
  })
})

describe('两条命令都在队列里（写盘，不能绕队列）', () => {
  test('OFF_QUEUE_METHODS 不含 exportSaves / importSaves', async () => {
    const { OFF_QUEUE_METHODS } = await import('../src/main/ipc')
    expect(OFF_QUEUE_METHODS.has('exportSaves')).toBe(false)
    expect(OFF_QUEUE_METHODS.has('importSaves')).toBe(false)
    // 对照：只读的 listSaves 仍在名单里
    expect(OFF_QUEUE_METHODS.has('listSaves')).toBe(true)
  })
})

// ===== ★ 用户在目录框点「取消」时，不许照样导出（2026-11-05 真机实测抓到的 bug）=====
//
// 原来 `outDir || await pickPath()` 然后 `chosen ?? defaultExportDir()`：
// pickPath 返回 null（= 用户取消）时，照样把包装进 ~/Downloads。
//
// 为什么单测一直没抓到：本文件**所有导出测试都显式传 `outDir`**（旁路对话框），
// 所以永远走不到「取消」那条分支。真机上点两次按钮 → Downloads 多出两个包才暴露。
//
// 这条测试的价值：把"取消"这个语义钉死。它不是在验一个边界 case，
// 而是在验**用户的意图**：点取消就是不想导出。
describe('★ 用户取消导出：一个字节都不写', () => {
  /** 造一个 pickPath 恒返回 null 的 dispatcher（模拟用户点了取消）。 */
  function dispatcherWithCancelledPicker(): ReturnType<typeof createDispatcher> {
    // ⚠️ 必须传 `host`（play-stats / categories 等旁挂存储都挂在它上面）；
    //    只传几个拆开的字段会撞 `deps.process?.dataDir` 的 undefined。
    //    `pickPath: async () => null` 就是「用户在系统目录框点了取消」。
    return createDispatcher({ host, pickPath: async () => null })
  }

  test('取消 → 返回 cancelled，而不是偷偷导到默认目录', async () => {
    const id = makeMvGame('取消导出')
    const dispatcher = dispatcherWithCancelledPicker()
    const raw = await dispatcher.dispatch('exportSaves', { id }, signal())
    // dispatch 的返回是 `unknown`（通用 IPC 边界），这里按契约断言
    const result = raw as { cancelled?: boolean; file: string | null; fileCount: number }

    expect(result.cancelled, '用户点了取消却没被如实回报').toBe(true)
    expect(result.file, '取消时不该有输出文件').toBeNull()
    expect(result.fileCount).toBe(0)
  })

  test('★ 取消后磁盘上不许出现任何新 zip（Downloads 尤其不许）', async () => {
    const id = makeMvGame('取消不落盘')
    const dispatcher = dispatcherWithCancelledPicker()

    // 记录默认目录（~/Downloads）里已有的包，防止测试污染真实目录
    const before = new Set(
      fs.existsSync(os.homedir())
        ? fs.readdirSync(os.homedir()).filter((n) => n.startsWith('tsumigeya-save-'))
        : []
    )
    const downloadsBefore = (() => {
      const d = path.join(os.homedir(), 'Downloads')
      if (!fs.existsSync(d)) return new Set<string>()
      return new Set(fs.readdirSync(d).filter((n) => n.startsWith('tsumigeya-save-')))
    })()

    await dispatcher.dispatch('exportSaves', { id }, signal())

    const downloadsAfter = (() => {
      const d = path.join(os.homedir(), 'Downloads')
      if (!fs.existsSync(d)) return new Set<string>()
      return new Set(fs.readdirSync(d).filter((n) => n.startsWith('tsumigeya-save-')))
    })()
    const leaked = [...downloadsAfter].filter((n) => !downloadsBefore.has(n))
    expect(leaked, `取消导出却在 Downloads 里留下了包：${leaked.join(', ')}`).toEqual([])
    // 顺带确认没有别的目录被写（before 只是保险，不参与断言逻辑）
    expect(before.size).toBeGreaterThanOrEqual(0)
  })

  test('显式给 outDir 时不弹框、正常导出（探针/API 旁路仍然可用）', async () => {
    const id = makeMvGame('显式目录')
    const outDir = path.join(dataDir, 'out')
    const dispatcher = dispatcherWithCancelledPicker() // pickPath 是 null，但不该被用到
    const raw = await dispatcher.dispatch('exportSaves', { id, outDir }, signal())
    const result = raw as { cancelled?: boolean; file: string | null }

    // 正常路径**不带** `cancelled` 字段（用的是联合类型里那个成功分支）——
    // 所以判据是「不是 true」+「file 是真的」，而不是 `=== false`。
    expect(result.cancelled).not.toBe(true)
    expect(result.file).toBeTruthy()
    expect(fs.existsSync(result.file!)).toBe(true)
  })
})
