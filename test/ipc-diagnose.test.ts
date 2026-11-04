// M3 的 IPC 层单测（docs/M3-实施方案.md §7 的后半）。用假 host（tmpdir）跑 dispatcher，全程离线。
//
// 两条必须钉死的行为：
//   1. `launch` 遇到 fatal 诊断时返回 `{ blocked }` 而**不是抛错**——
//      抛错会走 translateError 通用路径，诊断框需要结构化数据，扛不住 contextBridge 截断。
//   2. `diagnoseGame` 绕队列、`repairGame` 进队列——后者可能触发 244MB 下载。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createCoreHost, resolveCorePath } from '../src/main/core-host'
import { OFF_QUEUE_METHODS, createDispatcher } from '../src/main/ipc'

let dataDir: string
let host: ReturnType<typeof createCoreHost>

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-ipc-m3-'))
  host = createCoreHost({
    dataDir,
    corePath: resolveCorePath({ isPackaged: false, appPath: process.cwd() }),
    fetchImpl: (async () => {
      throw new Error('offline')
    }) as never
  })
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

/** 造一个「加密发行」的游戏目录（与真实样本 傭兵の冒険 同结构）。 */
function makeEncryptedGame(name = 'mercenary'): string {
  const gameDir = path.join(dataDir, name)
  fs.mkdirSync(gameDir, { recursive: true })
  fs.writeFileSync(path.join(gameDir, 'Game.exe'), 'MZ')
  fs.writeFileSync(
    path.join(gameDir, 'Game.rgss3a'),
    Buffer.from([0x52, 0x47, 0x53, 0x53, 0x41, 0x44, 0x00, 0x03])
  )
  fs.writeFileSync(path.join(gameDir, 'Game.ini'), '[Game]\nRTP=RPGVXAce\r\n')
  return gameDir
}

/** 造一个「正常可跑」的游戏目录（有 Data/、有 exe、不需要 RTP）。 */
function makeHealthyGame(name = 'healthy'): string {
  const gameDir = path.join(dataDir, name)
  fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true })
  fs.mkdirSync(path.join(gameDir, 'www'), { recursive: true })
  fs.writeFileSync(path.join(gameDir, 'Game.exe'), 'MZ')
  fs.writeFileSync(path.join(gameDir, 'nw.dll'), '')
  fs.writeFileSync(path.join(gameDir, 'www', 'package.json'), '{}')
  return gameDir
}

/** 装一个假引擎模块（只建目录 + manifest，不求真能启动）。 */
function installModule(folder: string): void {
  const dir = path.join(dataDir, 'modules', folder)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: folder, version: '1.0.0' }))
}

const signal = (): AbortSignal => new AbortController().signal

describe('OFF_QUEUE_METHODS（M3 §4.1）', () => {
  test('diagnoseGame 绕队列（纯本地只读、用户点启动就在等它）', () => {
    expect(OFF_QUEUE_METHODS.has('diagnoseGame')).toBe(true)
  })

  test('repairGame **必须**进队列（可能触发 244MB 的 RTP 下载）', () => {
    expect(OFF_QUEUE_METHODS.has('repairGame')).toBe(false)
  })
})

describe('diagnoseGame', () => {
  test('游戏不存在 → error.gameNotFound', async () => {
    await expect(
      createDispatcher({ host }).dispatch('diagnoseGame', { gameId: '9' }, signal())
    ).rejects.toMatchObject({ translationKey: 'error.gameNotFound' })
  })

  test('加密发行 → 返回 fatal 的 encryptedArchive', async () => {
    const gameDir = makeEncryptedGame()
    installModule('mkxpz')
    host.store.saveGame({ game: { gameTitle: '傭兵の冒険', gamePath: gameDir, gameEngine: 'mkxpz' } })
    const diagnoses = (await createDispatcher({ host }).dispatch(
      'diagnoseGame',
      { gameId: '1' },
      signal()
    )) as Array<{ code: string; level: string; args?: Record<string, string> }>
    expect(diagnoses[0]).toMatchObject({ code: 'encryptedArchive', level: 'fatal' })
    expect(diagnoses[0].args?.rgssVersion).toBe('VX Ace')
  })

  test('正常游戏 → 空数组（不误报）', async () => {
    const gameDir = makeHealthyGame()
    installModule('nwjs')
    host.store.saveGame({ game: { gameTitle: 'ok', gamePath: gameDir, gameEngine: 'nwjs' } })
    const diagnoses = (await createDispatcher({ host }).dispatch('diagnoseGame', { gameId: '1' }, signal())) as unknown[]
    expect(diagnoses).toEqual([])
  })

  test('引擎未装 → moduleMissing（且不会同时报 missingRtp，避免用户不知道点哪个）', async () => {
    const gameDir = makeEncryptedGame()
    host.store.saveGame({ game: { gameTitle: 'm', gamePath: gameDir, gameEngine: 'mkxpz' } })
    const diagnoses = (await createDispatcher({ host }).dispatch('diagnoseGame', { gameId: '1' }, signal())) as Array<{
      code: string
    }>
    expect(diagnoses.map((d) => d.code)).toContain('moduleMissing')
    expect(diagnoses.map((d) => d.code)).not.toContain('missingRtp')
  })
})

describe('launch 的启动前诊断（M3 §4.2）', () => {
  test('有 fatal 诊断 → 返回 { blocked } 而不是抛错', async () => {
    const gameDir = makeEncryptedGame()
    installModule('mkxpz')
    host.store.saveGame({ game: { gameTitle: '傭兵の冒険', gamePath: gameDir, gameEngine: 'mkxpz' } })
    const result = (await createDispatcher({ host }).dispatch('launch', { id: '1' }, signal())) as {
      blocked?: boolean
      message?: string
      diagnoses?: unknown[]
    }
    expect(result.blocked).toBe(true)
    expect(result.message).toBeUndefined()
    expect((result.diagnoses as unknown[]).length).toBeGreaterThan(0)
  })

  test('只有 warning / info 时不拦（缺 RTP 的游戏常常仍能跑）', async () => {
    const gameDir = path.join(dataDir, 'rtp-only')
    fs.mkdirSync(path.join(gameDir, 'Data'), { recursive: true })
    fs.writeFileSync(path.join(gameDir, 'Game.exe'), 'MZ')
    fs.writeFileSync(path.join(gameDir, 'Game.ini'), '[Game]\nRTP=RPGVXAce\n')
    installModule('mkxpz')
    host.store.saveGame({ game: { gameTitle: 'rtp', gamePath: gameDir, gameEngine: 'mkxpz' } })

    const diagnoses = (await createDispatcher({ host }).dispatch(
      'diagnoseGame',
      { gameId: '1' },
      signal()
    )) as Array<{ level: string }>
    // 前置条件：确实只有非 fatal 的条目
    expect(diagnoses.every((d) => d.level !== 'fatal')).toBe(true)

    // 没有 launcher.js 会抛（scriptPath / launchExport 都算）——重点是它**抛错**而不是
    // 返回 `{ blocked }`，说明诊断确实没拦住只有 warning 的游戏。
    // 不绑定具体 key：这属于 M1 的启动链细节，M3 不该把它钉死在这里。
    let threw = false
    try {
      const result = (await createDispatcher({ host }).dispatch('launch', { id: '1' }, signal())) as {
        blocked?: boolean
      }
      // 万一没抛：绝不能是 blocked
      expect(result.blocked).toBeUndefined()
    } catch (error) {
      threw = true
      expect((error as { translationKey?: string }).translationKey).toMatch(/^error\./)
    }
    expect(threw).toBe(true)
  })

  test('params.diagnose=false 时不再拦（用户已看过诊断框，点「还是启动试试」）', async () => {
    const gameDir = makeEncryptedGame()
    installModule('mkxpz')
    host.store.saveGame({ game: { gameTitle: 'm', gamePath: gameDir, gameEngine: 'mkxpz' } })
    // 前置条件：默认确实会被拦
    const blocked = (await createDispatcher({ host }).dispatch('launch', { id: '1' }, signal())) as {
      blocked?: boolean
    }
    expect(blocked.blocked).toBe(true)

    // 带 diagnose=false：不该再返回 blocked。这是「绕过按钮真的有效」的证据——
    // 没有它，点「还是启动试试」会再次被同一个框拦住（§9 R5）。
    let returnedBlocked = false
    try {
      const result = (await createDispatcher({ host }).dispatch(
        'launch',
        { id: '1', diagnose: false },
        signal()
      )) as { blocked?: boolean }
      returnedBlocked = result.blocked === true
    } catch {
      /* 抛错也算没拦住 */
    }
    expect(returnedBlocked).toBe(false)
  })

  test('settings.diagnoseBeforeLaunch=false 时整个诊断关闭（连 fatal 也不拦）', async () => {
    const gameDir = makeEncryptedGame()
    installModule('mkxpz')
    host.store.saveGame({ game: { gameTitle: 'm', gamePath: gameDir, gameEngine: 'mkxpz' } })
    host.store.saveSettings({ diagnoseBeforeLaunch: false })

    let returnedBlocked = false
    try {
      const result = (await createDispatcher({ host }).dispatch('launch', { id: '1' }, signal())) as {
        blocked?: boolean
      }
      returnedBlocked = result.blocked === true
    } catch {
      /* 抛错也算没拦住 */
    }
    expect(returnedBlocked).toBe(false)
  })

})

describe('repairGame', () => {
  test('游戏不存在 → error.gameNotFound', async () => {
    await expect(
      createDispatcher({ host }).dispatch('repairGame', { gameId: '9', fix: { kind: 'repoint' } }, signal())
    ).rejects.toMatchObject({ translationKey: 'error.gameNotFound' })
  })

  test('没有 fix → error.repairFixMissing', async () => {
    host.store.saveGame({ game: { gameTitle: 'g', gamePath: dataDir, gameEngine: 'mkxpz' } })
    await expect(
      createDispatcher({ host }).dispatch('repairGame', { gameId: '1' }, signal())
    ).rejects.toMatchObject({ translationKey: 'error.repairFixMissing' })
  })

  test('不认识的 fix.kind → error.repairUnknownFix（绝不静默成功）', async () => {
    host.store.saveGame({ game: { gameTitle: 'g', gamePath: dataDir, gameEngine: 'mkxpz' } })
    await expect(
      createDispatcher({ host }).dispatch('repairGame', { gameId: '1', fix: { kind: 'magicFix' } }, signal())
    ).rejects.toMatchObject({ translationKey: 'error.repairUnknownFix' })
  })

  test('openFolder 越界路径 → error.pathNotAllowed（不给开任意路径）', async () => {
    host.store.saveGame({ game: { gameTitle: 'g', gamePath: dataDir, gameEngine: 'mkxpz' } })
    await expect(
      createDispatcher({ host }).dispatch(
        'repairGame',
        { gameId: '1', fix: { kind: 'openFolder', path: path.join(os.tmpdir(), 'outside') } },
        signal()
      )
    ).rejects.toMatchObject({ translationKey: 'error.pathNotAllowed' })
  })

  test('repoint 不改任何东西，直接回一份重诊断（S5 会补真实动作）', async () => {
    const gameDir = makeEncryptedGame()
    host.store.saveGame({ game: { gameTitle: 'm', gamePath: gameDir, gameEngine: 'mkxpz' } })
    const result = (await createDispatcher({ host }).dispatch(
      'repairGame',
      { gameId: '1', fix: { kind: 'repoint' } },
      signal()
    )) as { ok: boolean; action: string; diagnoses: unknown[] }
    expect(result.ok).toBe(true)
    expect(result.action).toBe('repoint')
    expect(result.diagnoses.length).toBeGreaterThan(0)
  })
})
