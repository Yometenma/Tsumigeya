// M3 的 IPC 层单测（docs/M3-实施方案.md §7 的后半）。用假 host（tmpdir）跑 dispatcher，全程离线。
//
// 两条必须钉死的行为：
//   1. `launch` 遇到 fatal 诊断时返回 `{ blocked }` 而**不是抛错**——
//      抛错会走 translateError 通用路径，诊断框需要结构化数据，扛不住 contextBridge 截断。
//   2. `diagnoseGame` 绕队列、`repairGame` 进队列——后者可能触发 244MB 下载。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
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

/**
 * 造一个 tar，内部结构与 §2.3 实测的 RTP.zip 一致：
 *
 *   `<depName>`（= 归档顶层的包裹目录，mkxpz 的包就是 `RTP/`）
 *     └── `RTP/<版本>/Audio|Graphics`（§2.3 实测的真实层级）
 *
 * 也就是说，解压到 `deps/RTP/` 之后，正确结果是 `deps/RTP/RTP/<版本>/`。
 *
 * 为什么用 tar 而不是 zip：`src/main/extract.ts` 走系统 bsdtar，tar 是它最原生支持的格式；
 * Node 标准库没有 zip 写入能力（不引第三方依赖是本项目的规矩）。
 * 这不影响被测逻辑——被测的是「下载 → 解压 → 拍平同名包裹层 → 落到 deps/RTP/RTP/<版本>」这条通路。
 */
function buildTarWithNestedDir(tarPath: string, depName: string, rtpVersion: string): void {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-tar-'))
  try {
    const target = path.join(staging, depName, 'RTP', rtpVersion)
    fs.mkdirSync(path.join(target, 'Graphics'), { recursive: true })
    fs.writeFileSync(path.join(target, 'Graphics', 'marker.txt'), 'rtp fixture')
    fs.mkdirSync(path.join(target, 'Audio'), { recursive: true })
    // ⚠️ 必须用 **bsdtar**（Windows 自带的 C:\Windows\System32\tar.exe），不是 PATH 里的 GNU tar：
    // 实测 PATH 上的 /usr/bin/tar 是 GNU 版，它把 "C:\..." 当成远程主机名，
    // 报 "tar: Cannot connect to C: resolve failed"（exit 128）。
    // 而 src/main/extract.ts 生产环境走的就是 bsdtar，用同一个二进制才是真行为。
    const tarBin =
      process.platform === 'win32'
        ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
        : 'tar'
    execFileSync(tarBin, ['-cf', path.resolve(tarPath), depName], { stdio: 'ignore', cwd: staging })
  } finally {
    fs.rmSync(staging, { recursive: true, force: true })
  }
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

  // ===== S5：修复动作真的执行（不是只返回 ok）=====

  test('openFolder 合法路径 → 真的调用 openPath', async () => {
    const gameDir = makeEncryptedGame()
    host.store.saveGame({ game: { gameTitle: 'm', gamePath: gameDir, gameEngine: 'mkxpz' } })
    const opened: string[] = []
    const d = createDispatcher({
      host,
      openPath: async (target: string) => {
        opened.push(target)
        return '' // 空串 = 成功（与 shell.openPath 语义一致）
      }
    })
    const result = (await d.dispatch(
      'repairGame',
      { gameId: '1', fix: { kind: 'openFolder', path: gameDir } },
      signal()
    )) as { ok: boolean; action: string; message: string }
    expect(result.ok).toBe(true)
    expect(result.action).toBe('openFolder')
    expect(opened).toEqual([path.resolve(gameDir)])
  })

  test('openFolder 的系统调用失败要如实报错（不能假装成功）', async () => {
    const gameDir = makeEncryptedGame()
    host.store.saveGame({ game: { gameTitle: 'm', gamePath: gameDir, gameEngine: 'mkxpz' } })
    const d = createDispatcher({ host, openPath: async () => '权限不足' })
    await expect(
      d.dispatch('repairGame', { gameId: '1', fix: { kind: 'openFolder', path: gameDir } }, signal())
    ).rejects.toMatchObject({ translationKey: 'error.pathNotAllowed' })
  })

  test('installModule 真的进了安装流程（断网必然失败，失败自身就是证据）', async () => {
    // 如果它只是想当然地返回 ok，这里就会「成功」。
    // 它真去调 core.installModuleWithProgress 时，注入的 fetch 会抛 offline → 必须报错。
    const gameDir = makeEncryptedGame()
    host.store.saveGame({ game: { gameTitle: 'm', gamePath: gameDir, gameEngine: 'mkxpz' } })
    let threw = false
    try {
      await createDispatcher({ host }).dispatch(
        'repairGame',
        { gameId: '1', fix: { kind: 'installModule', engine: 'mkxpz' } },
        signal()
      )
    } catch (error) {
      threw = true
      expect((error as Error).message.length).toBeGreaterThan(0)
    }
    expect(threw).toBe(true)
  })

  test('installRtp 的引擎名过 component 校验（挡住路径穿越）', async () => {
    const gameDir = makeEncryptedGame()
    host.store.saveGame({ game: { gameTitle: 'm', gamePath: gameDir, gameEngine: 'mkxpz' } })
    await expect(
      createDispatcher({ host }).dispatch(
        'repairGame',
        { gameId: '1', fix: { kind: 'installRtp', engine: '../evil' } },
        signal()
      )
    ).rejects.toMatchObject({ translationKey: 'error.invalidComponent' })
  })

  /**
   * **S5 的核心验收**：点「一键补装 RTP」必须真的把 RTP 装进
   * `deps/RTP/RTP/<版本>`，而不是只返回 ok。
   *
   * 这条测试存在的理由（实测发现的真实缺陷）：core 的 `updateDependenciesTaskWithProgress`
   * 只更新**已安装**的依赖，RTP 从没装过时它什么都不下、还报「完成」——
   * 用户点完修复问题依旧，比不修更糟。所以必须走「按名字装指定依赖」。
   */
  test('★ installRtp 真的下载并落地到 deps/RTP/RTP/<版本>（不是只返回 ok）', async () => {
    const gameDir = makeEncryptedGame() // Game.ini 里 RTP=RPGVXAce
    installModule('mkxpz')
    // 给这个假模块写一个真 manifest：RTP 依赖指向一个本地可 fetch 的链接
    const manifestPath = path.join(dataDir, 'modules', 'mkxpz', 'manifest.json')
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        name: 'MKXP-Z',
        version: '1.1.5',
        dependencies: {
          RTP: { universal: { link: 'https://example.invalid/RTP.zip', unzip: true } }
        }
      })
    )
    host.store.saveGame({ game: { gameTitle: 'm', gamePath: gameDir, gameEngine: 'mkxpz' } })

    // 假 zip：用 bsdtar 能解的 tar.gz（extract.ts 走系统 bsdtar，认这个格式）
    // 内部结构照 §2.3 实测：RTP/RPGVXace/…（顶层是 RTP/<版本>/）
    const tar = path.join(dataDir, 'fake-rtp.tar')
    buildTarWithNestedDir(tar, 'RTP', 'RPGVXace')
    const archive = fs.readFileSync(tar)

    const fetched: string[] = []
    const fakeHost = createCoreHost({
      dataDir,
      corePath: resolveCorePath({ isPackaged: false, appPath: process.cwd() }),
      fetchImpl: (async (input: string) => {
        fetched.push(input)
        return new Response(archive, {
          status: 200,
          headers: { 'content-length': String(archive.length) }
        })
      }) as never
    })
    // fakeHost 与 beforeEach 的 host 共用同一个 dataDir（也共用 games.json），
    // 游戏已经在库里了 → 不要再 saveGame（会撞 error.duplicateGame）。
    const result = (await createDispatcher({ host: fakeHost }).dispatch(
      'repairGame',
      { gameId: '1', fix: { kind: 'installRtp', engine: 'mkxpz' } },
      signal()
    )) as { ok: boolean; action: string; diagnoses: Array<{ code: string }> }

    // ① 真的发生了下载
    expect(fetched).toEqual(['https://example.invalid/RTP.zip'])
    // ② 真的落地了：deps/RTP/RTP/RPGVXace 存在
    const rtpDir = path.join(dataDir, 'modules', 'mkxpz', 'deps', 'RTP', 'RTP', 'RPGVXace')
    expect(fs.existsSync(rtpDir)).toBe(true)
    expect(fs.statSync(rtpDir).isDirectory()).toBe(true)
    // ③ 重诊断里 missingRtp 消失了（修复真的解决了问题）
    expect(result.diagnoses.map((d) => d.code)).not.toContain('missingRtp')
  })

  test('installRtp：manifest 里没有该依赖 → error.dependencyMissing（不静默成功）', async () => {
    const gameDir = makeEncryptedGame()
    installModule('mkxpz') // 假 manifest 只有 name/version，没有 dependencies
    host.store.saveGame({ game: { gameTitle: 'm', gamePath: gameDir, gameEngine: 'mkxpz' } })
    await expect(
      createDispatcher({ host }).dispatch(
        'repairGame',
        { gameId: '1', fix: { kind: 'installRtp', engine: 'mkxpz' } },
        signal()
      )
    ).rejects.toMatchObject({ translationKey: 'error.dependencyMissing' })
  })

  test('installRtp：HTTP 失败 → error.download（不假装成功）', async () => {
    const gameDir = makeEncryptedGame()
    installModule('mkxpz')
    fs.writeFileSync(
      path.join(dataDir, 'modules', 'mkxpz', 'manifest.json'),
      JSON.stringify({
        name: 'MKXP-Z',
        dependencies: { RTP: { universal: { link: 'https://example.invalid/RTP.zip', unzip: true } } }
      })
    )
    host.store.saveGame({ game: { gameTitle: 'm', gamePath: gameDir, gameEngine: 'mkxpz' } })
    const failHost = createCoreHost({
      dataDir,
      corePath: resolveCorePath({ isPackaged: false, appPath: process.cwd() }),
      fetchImpl: (async () => new Response('', { status: 404 })) as never
    })
    // 这个 host 与上面那个共用同一个 dataDir（也共用 games.json），所以游戏已经在库里了：
    // 不要再 saveGame（会撞 error.duplicateGame）。
    await expect(
      createDispatcher({ host: failHost }).dispatch(
        'repairGame',
        { gameId: '1', fix: { kind: 'installRtp', engine: 'mkxpz' } },
        signal()
      )
    ).rejects.toMatchObject({ translationKey: 'error.download' })
  })
})
