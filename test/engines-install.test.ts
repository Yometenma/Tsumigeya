// M4.1 S3 单测：detectFolder 改读 registry + 引擎安装自己生成 manifest（D60 / D62）。
//
// 这一层钉四件事：
//   1. `detectFolder` 的 autodetect 规则**来自 registry**，且零网络
//   2. 安装引擎 = 写生成的 manifest + 按它装依赖（不再下载模块目录）
//   3. 生成的 manifest 能被 core 读回、**旧版本的多版本目录不被误删**、失败时事务回滚
//   4. 版本列表自己实现（§3.3 的「扫本地目录」是错的，真实现要拉 nwjs.io）
//
// ⚠️ 关于 fixtures 的说明（S3 验收时踩到的真问题，写在这里免得下个会话再踩）：
//
//   `test/fixtures/rpg-mv` 原来只有 `www/nw.dll` + `www/package.json`，
//   `rpg-vxace` 缺 `System/`。那两份 fixture 是按 `detect.test.ts` 里**手写的** MANIFESTS
//   造的（`files: ['www/package.json', 'www/nw.dll']`），而**上游真实 manifest 是裸
//   `files: ['nw.dll', 'package.json']`、mkxpz 要 `files: [Game.ini, System, Graphics, Audio]`**
//   —— 两者本来就不一致，只是从来没人拿真规则验过。
//
//   S3 用 registry 的真规则一跑，rpg-mv / rpg-vxace 立刻认不出来（best=null）。
//   本鱼的处理：**补全 fixture**（根目录加 `nw.dll` / `package.json`、加 `System/`），
//   而不是放宽 registry 的规则 —— 规则抄的是上游实测值，改了它就认不出真实游戏了。
//   补全依据是 M3 实测的真实样本结构
//   （`Game.exe + Game.ini + Game.rgss3a + Audio/ + Fonts/ + System/`，无 Data/）。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createCoreHost, resolveCorePath } from '../src/main/core-host'
import { createDispatcher, safeDependencyPath } from '../src/main/ipc'
import { buildManifest, findEngine } from '../src/main/engines/registry'
import { NWJS_VERSIONS_URL, fetchNwjsVersions, pickMacBuilds } from '../src/main/engines/versions'

const FIXTURES = path.join(process.cwd(), 'test', 'fixtures')

// ===== 测试辅助 =====

/**
 * 造一个**真的能被 bsdtar 解开**的极小 zip。
 *
 * 为什么不能给纯文本：依赖里标了 `unzip: true` 的，`extractArchive` 会调系统 tar 去解它。
 * 给纯文本就报 `tar.exe: Error opening archive: Unrecognized archive format`
 * —— 本鱼第一版就是这么把自己的三条测试搞红的。
 */
function tinyZip(): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-s3-zip-'))
  try {
    fs.writeFileSync(path.join(dir, 'payload.txt'), 'engine binary placeholder')
    const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : '/usr/bin/tar'
    // bsdtar 能同时写 tar 与 zip；用 zip 是因为上游依赖都是 .zip
    execFileSync(tar, ['-a', '-c', '-f', path.join(dir, 'out.zip'), '-C', dir, 'payload.txt'])
    return fs.readFileSync(path.join(dir, 'out.zip'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** 造一个只服务指定 URL 的假 fetch（服务不到的 URL 直接抛，表示「这里不该联网」）。 */
function fakeFetch(links: readonly string[]): (input: string) => Promise<Response> {
  const zip = tinyZip()
  // nwjs.io 的版本清单单独给一份假响应（它返回 JSON 而不是 zip）
  return async (input: string) => {
    if (input === NWJS_VERSIONS_URL) {
      return new Response(JSON.stringify(FAKE_NWJS_VERSIONS), { status: 200 })
    }
    if (!links.includes(input)) throw new Error(`S3 测试不该请求：${input}`)
    return new Response(zip, { status: 200, headers: { 'content-length': String(zip.byteLength) } })
  }
}

/** 假的数据目录（每个用例一份，避免互相污染：一个装过的模块会让下一个用例看到「已装」）。 */
function tempDataDir(prefix = 'tsmg-s3-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** 造 host（指定数据目录 + 只服务 given links 的假 fetch）。 */
function makeHost(dir: string, links: readonly string[]): ReturnType<typeof createCoreHost> {
  return createCoreHost({
    dataDir: dir,
    corePath: resolveCorePath({ env: {}, appPath: process.cwd() }),
    fetchImpl: fakeFetch(links),
    onEvent: () => undefined
  })
}

/** 某引擎的全部依赖下载地址（两个架构都算）。 */
function linksOf(folder: string): string[] {
  const definition = findEngine(folder)!
  const links: string[] = []
  for (const dependency of Object.values(definition.dependencies)) {
    for (const build of [dependency.universal, dependency.arm64, dependency.x86_64]) {
      if (build?.link) links.push(build.link)
    }
  }
  return links
}

/** 假的 NW.js 版本清单（形状照 nwjs.io 的真实响应）。 */
const FAKE_NWJS_VERSIONS = {
  latest: 'v1.0.0',
  versions: [
    // 正常：sdk + 两个 mac 架构 → 该进列表
    { version: 'v1.0.0', files: ['osx-x64', 'osx-arm64', 'win-x64'], flavors: ['normal', 'sdk'] },
    // 只有 normal flavor → 排除（上游也只给 sdk）
    { version: 'v0.98.0', files: ['osx-x64', 'osx-arm64'], flavors: ['normal'] },
    // 缺 arm64 → 排除（mac 上装不了 arm64 版）
    { version: 'v0.97.0', files: ['osx-x64'], flavors: ['sdk'] },
    // 只有 win/linux → 排除（没有 mac 构建）
    { version: 'v0.96.0', files: ['win-x64', 'linux-x64'], flavors: ['sdk'] }
  ]
}

// ===== 0. 每个用例要清理的临时目录 =====
const createdDirs: string[] = []
function trackDir(dir: string): string {
  createdDirs.push(dir)
  return dir
}

afterAll(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ===== 1. detectFolder 改读 registry =====

describe('S3 detectFolder：autodetect 规则来自 registry，且零网络', () => {
  let dataDir: string
  let host: ReturnType<typeof createCoreHost>

  beforeAll(() => {
    dataDir = trackDir(tempDataDir())
    host = makeHost(dataDir, linksOf('nwjs'))
  })

  test('rpg-mv → nwjs（用 registry 的真规则 files:[nw.dll, package.json]）', async () => {
    const result = await host.detectFolder({ path: path.join(FIXTURES, 'rpg-mv') })
    expect(result.best?.engine).toBe('nwjs')
    // 没装引擎 → installed: false，提示「去装引擎」
    expect(result.best?.installed).toBe(false)
  })

  test('rpg-vxace → mkxpz（要 Game.ini + System + Graphics + Audio 四条全中）', async () => {
    const result = await host.detectFolder({ path: path.join(FIXTURES, 'rpg-vxace') })
    expect(result.best?.engine).toBe('mkxpz')
  })

  test('rpg-2000 → easyrpg（all_required:false，命中 .ldb/.lmt/.ini）', async () => {
    const result = await host.detectFolder({ path: path.join(FIXTURES, 'rpg-2000') })
    expect(result.best?.engine).toBe('easyrpg')
  })

  test('renpy → renpy（files:[renpy] 在场 + 扩展名 py/exe/sh 之一）', async () => {
    const result = await host.detectFolder({ path: path.join(FIXTURES, 'renpy') })
    expect(result.best?.engine).toBe('renpy')
  })

  test('includeRemote:false 时不用 registry 规则（只认已装模块的 manifest）', async () => {
    const result = await host.detectFolder({ path: path.join(FIXTURES, 'rpg-vxace'), includeRemote: false })
    // 什么都没装 → 认不出来（这才是 includeRemote:false 应有的结果）
    expect(result.best).toBeNull()
  })

  test('认不出来时不会瞎猜（只有一个 Game.exe 的空目录 → null）', async () => {
    const lonely = trackDir(tempDataDir('tsmg-s3-lonely-'))
    fs.writeFileSync(path.join(lonely, 'Game.exe'), '')
    const result = await host.detectFolder({ path: lonely })
    expect(result.best).toBeNull()
  })

  test('装了引擎后 detectFolder 认成「已安装」（installed 从 false 变 true）', async () => {
    const localDir = trackDir(tempDataDir('tsmg-s3-installed-'))
    const localHost = makeHost(localDir, [])
    const moduleDir = path.join(localDir, 'modules', 'mkxpz')
    fs.mkdirSync(moduleDir, { recursive: true })
    fs.writeFileSync(path.join(moduleDir, 'manifest.json'), JSON.stringify(buildManifest(findEngine('mkxpz')!)))

    const result = await localHost.detectFolder({ path: path.join(FIXTURES, 'rpg-vxace') })
    expect(result.best?.engine).toBe('mkxpz')
    expect(result.best?.installed, '装了引擎就该显示已安装').toBe(true)
  })
})

// ===== 2. 安装引擎 = 写 manifest + 装依赖 =====

describe('S3 安装引擎：自己生成 manifest 并装依赖（D62）', () => {
  test('moduleTask(install) 真的写出 manifest，且位置正确、core 能读回', async () => {
    const dataDir = trackDir(tempDataDir())
    const folder = 'renpy'
    const def = findEngine(folder)!
    const localHost = makeHost(dataDir, linksOf(folder))
    const dispatcher = createDispatcher({ host: localHost })
    const dir = path.join(dataDir, 'modules', folder)

    try {
      await dispatcher.dispatch('moduleTask', { folder, action: 'install' }, new AbortController().signal)

      // ① manifest 在正确位置，内容与 registry 一致
      const manifestFile = path.join(dir, 'manifest.json')
      expect(fs.existsSync(manifestFile), 'manifest.json 必须被写出来').toBe(true)
      const written = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as Record<string, unknown>
      expect(written.version).toBe(def.version)
      expect(written.autodetect).toEqual(def.autodetect)

      // ② 依赖也装进去了（deps/renpy/ 下应该有下载+解压的文件）
      const depDir = path.join(dir, 'deps', 'renpy')
      expect(fs.existsSync(depDir), '依赖目录必须存在').toBe(true)
      expect(fs.existsSync(path.join(depDir, 'payload.txt')), '解压后的文件应该落地').toBe(true)

      // ③ core 能读回来（D62 的核心要求）
      const local = localHost.core.readLocalManifests()
      expect(local[folder]?.version).toBe(def.version)
      expect(local[folder]?.gameArgs?.savedir).toMatchObject({ type: 'string' })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('带斜杠的依赖名（version/v0.106.1）能装进子目录 deps/version/v0.106.1/', async () => {
    // 这是 S3 接上真实安装后才暴露的**真 bug**：M3 写的 installDependencies 用
    // component() 校验依赖名，而 component 禁止斜杠 → 上游合法的 `version/v0.106.1`
    // 被判成 error.invalidComponent → **NW.js 永远装不上**。
    // 已换成 safeDependencyPath（放行斜杠、仍挡越界）。
    const dataDir = trackDir(tempDataDir())
    const folder = 'nwjs'
    const localHost = makeHost(dataDir, linksOf(folder))
    const dispatcher = createDispatcher({ host: localHost })
    const dir = path.join(dataDir, 'modules', folder)

    try {
      await dispatcher.dispatch('moduleTask', { folder, action: 'install' }, new AbortController().signal)
      // 依赖落在 deps/version/v0.106.1/（斜杠 = 子目录，与上游 path.join 行为一致）
      const depDir = path.join(dir, 'deps', 'version', 'v0.106.1')
      expect(fs.existsSync(depDir), '带斜杠的依赖必须落到子目录').toBe(true)
      expect(fs.existsSync(path.join(depDir, 'payload.txt')), '解压后的文件应该落地').toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('未知引擎的安装被明确拒绝，且列出支持的引擎（不回退）', async () => {
    const dataDir = trackDir(tempDataDir('tsmg-s3-unknown-'))
    const localHost = makeHost(dataDir, [])
    const dispatcher = createDispatcher({ host: localHost })
    let error: (Error & { translationKey?: string; translationArguments?: Record<string, unknown> }) | null = null
    try {
      await dispatcher.dispatch('moduleTask', { folder: 'ruffle', action: 'install' }, new AbortController().signal)
    } catch (caught) {
      error = caught as typeof error
    }
    expect(error, 'unknown engine must be rejected').toBeTruthy()
    expect(error!.translationKey).toBe('error.engineNotSupported')
    expect(String(error!.message)).toContain('not supported')
    // 错误里必须列出支持的引擎（用户要知道该怎么办）
    expect(String(error!.translationArguments?.supported)).toContain('nwjs')
    // 而且**绝不能**在磁盘上留下半个模块目录
    expect(fs.existsSync(path.join(dataDir, 'modules', 'ruffle'))).toBe(false)
  })
})

// ===== 3. 事务：多版本目录保留 + 失败回滚 =====

describe('S3 更新引擎：多版本目录不被误删、失败要回滚', () => {
  test('真的跑一次 install → deps 下已装的运行时还在（上游会把它删掉）', async () => {
    const dataDir = trackDir(tempDataDir())
    const folder = 'nwjs'
    const localHost = makeHost(dataDir, linksOf(folder))
    const dispatcher = createDispatcher({ host: localHost })
    const dir = path.join(dataDir, 'modules', folder)
    const keepFile = path.join(dir, 'deps', 'version', 'v0.106.1', 'keep.txt')

    // 预置：用户已经装好了一个 NW.js 运行时（多版本）
    fs.mkdirSync(path.dirname(keepFile), { recursive: true })
    fs.writeFileSync(keepFile, 'user installed runtime')

    try {
      await dispatcher.dispatch('moduleTask', { folder, action: 'install' }, new AbortController().signal)
      // 核心断言：**多版本目录还在**。
      // 上游的 install 是「先 rmSync 整个 localRoot」，那会把这个目录删掉；
      // 我们的 installEngine 明确不删（见其注释），这条就是它的回归测试。
      expect(fs.existsSync(keepFile), '用户已装的运行时不能被删掉').toBe(true)
      expect(fs.existsSync(path.join(dir, 'manifest.json'))).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)

  test('install 失败时事务回滚，不留下半个模块目录', async () => {
    // 这条抓到过本鱼的**第二个真 bug**：本鱼把 installEngine 里的内层 moduleTransaction
    // 删掉（理由「不能嵌套」），但外层忘了加 → 两条 install/update 路径**都没有事务**，
    // 失败时磁盘上留下「manifest 在、依赖缺一半」的半成品（比装不上更糟：
    // 界面上显示「已安装」，启动时却找不到二进制）。已在外层补上。
    const dataDir = trackDir(tempDataDir('tsmg-s3-rollback-'))
    const folder = 'easyrpg'
    const dir = path.join(dataDir, 'modules', folder)
    // 假的 host：所有下载都 500 → 安装必然失败
    const localHost = createCoreHost({
      dataDir,
      corePath: resolveCorePath({ env: {}, appPath: process.cwd() }),
      fetchImpl: async () => new Response('', { status: 500 }),
      onEvent: () => undefined
    })
    const dispatcher = createDispatcher({ host: localHost })

    await expect(
      dispatcher.dispatch('moduleTask', { folder, action: 'install' }, new AbortController().signal)
    ).rejects.toThrow()
    // 事务回滚后不该留下模块目录（原来是全新的安装，没有可还原的东西）
    expect(fs.existsSync(dir), '失败的安装不能留下半个模块目录').toBe(false)
  }, 30_000)
})

// ===== 4. safeDependencyPath（修 bug 时新增的校验函数）=====

describe('S3 safeDependencyPath：放行斜杠、挡住越界', () => {
  test('普通名原样放行', () => {
    expect(safeDependencyPath('RTP')).toBe('RTP')
    expect(safeDependencyPath('soundfont')).toBe('soundfont')
  })

  test('带斜杠的依赖名放行（斜杠 = 子目录，上游就是这么用的）', () => {
    expect(safeDependencyPath('version/v0.106.1')).toBe('version/v0.106.1')
    // 多段也放行
    expect(safeDependencyPath('a/b/c')).toBe('a/b/c')
  })

  test('.. 段被拒绝（防止爬出 deps 目录）', () => {
    expect(() => safeDependencyPath('..')).toThrow()
    expect(() => safeDependencyPath('a/../b')).toThrow()
    expect(() => safeDependencyPath('a/..')).toThrow()
  })

  test('绝对路径与盘符被拒绝', () => {
    expect(() => safeDependencyPath('/etc/passwd')).toThrow()
    expect(() => safeDependencyPath('C:evil')).toThrow()
  })

  test('反斜杠被拒绝（避免同一份清单在 win/mac 上跳向不同目录）', () => {
    expect(() => safeDependencyPath('a\\b')).toThrow()
  })

  test('空段被拒绝（a//b、结尾斜杠）', () => {
    expect(() => safeDependencyPath('a//b')).toThrow()
    expect(() => safeDependencyPath('a/')).toThrow()
    expect(() => safeDependencyPath('/a')).toThrow()
  })

  test('空值 / 非字符串被拒绝', () => {
    expect(() => safeDependencyPath('')).toThrow()
    expect(() => safeDependencyPath(null as unknown as string)).toThrow()
  })
})

// ===== 5. 版本列表（§3.3 的实际实现）=====

describe('S3 版本列表：自己实现（§3.3 的「扫本地目录」是错的）', () => {
  test('pickMacBuilds：只留 sdk + 两个 mac 架构齐全的版本', () => {
    const picked = pickMacBuilds(FAKE_NWJS_VERSIONS)
    expect(Object.keys(picked)).toEqual(['v1.0.0'])
    expect(picked['v1.0.0'].x86_64?.link).toBe('https://dl.nwjs.io/v1.0.0/nwjs-sdk-v1.0.0-osx-x64.zip')
    expect(picked['v1.0.0'].arm64?.link).toBe('https://dl.nwjs.io/v1.0.0/nwjs-sdk-v1.0.0-osx-arm64.zip')
    expect(picked['v1.0.0'].x86_64?.unzip).toBe(true)
  })

  test('pickMacBuilds：缺 arm64 / 只有 normal flavor / 只有 win-linux 都被排除', () => {
    const picked = pickMacBuilds(FAKE_NWJS_VERSIONS)
    expect(picked).not.toHaveProperty('v0.97.0') // 缺 arm64
    expect(picked).not.toHaveProperty('v0.98.0') // 只有 normal
    expect(picked).not.toHaveProperty('v0.96.0') // 没有 mac 构建
  })

  test('pickMacBuilds：垃圾输入不崩（返回空对象）', () => {
    expect(pickMacBuilds(null)).toEqual({})
    expect(pickMacBuilds({})).toEqual({})
    expect(pickMacBuilds({ versions: 'not-an-array' })).toEqual({})
    expect(pickMacBuilds({ versions: [null, 1, 'x', {}] })).toEqual({})
  })

  test('fetchNwjsVersions：正常拉取 → available 有内容、warning 为 null', async () => {
    const result = await fetchNwjsVersions(async () =>
      new Response(JSON.stringify(FAKE_NWJS_VERSIONS), { status: 200 })
    )
    expect(result.warning).toBeNull()
    expect(Object.keys(result.available)).toEqual(['v1.0.0'])
  })

  test('fetchNwjsVersions：HTTP 失败 → 空列表 + 可读 warning（**不抛错**）', async () => {
    const result = await fetchNwjsVersions(async () => new Response('', { status: 500 }))
    expect(result.available).toEqual({})
    expect(result.warning).toContain('500')
  })

  test('fetchNwjsVersions：网络异常 → 空列表 + 可读 warning（**不抛错**）', async () => {
    const result = await fetchNwjsVersions(async () => {
      throw new Error('network down')
    })
    expect(result.available).toEqual({})
    expect(result.warning).toContain('network down')
  })

  test('fetchNwjsVersions：拿到清单但筛出 0 个 → 说法与「网络失败」不同', async () => {
    const result = await fetchNwjsVersions(async () =>
      new Response(JSON.stringify({ versions: [] }), { status: 200 })
    )
    expect(result.available).toEqual({})
    // 不是「网络不好」，是「清单里没有 mac 构建」
    expect(result.warning).toContain('没有可用的 macOS')
  })

  test('fetchNwjsVersions：signal 已取消 → 抛错（不能装成空列表）', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      fetchNwjsVersions(async () => {
        throw new DOMException('aborted', 'AbortError')
      }, controller.signal)
    ).rejects.toThrow()
  })
})

describe('S3 versions 命令：接的是我们自己的实现（不加载上游脚本）', () => {
  test('nwjs 的 version 参数 → 拿到可下载列表', async () => {
    const dataDir = trackDir(tempDataDir('tsmg-s3-versions-'))
    const folder = 'nwjs'
    const localHost = makeHost(dataDir, linksOf(folder))
    const dir = path.join(dataDir, 'modules', folder)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(buildManifest(findEngine(folder)!)))

    const dispatcher = createDispatcher({ host: localHost })
    const result = (await dispatcher.dispatch(
      'versions',
      { folder, argKey: 'version' },
      new AbortController().signal
    )) as { installed: string[]; available: Record<string, unknown>; warning: string | null }

    expect(Object.keys(result.available)).toEqual(['v1.0.0'])
    expect(result.warning).toBeNull()
    // 还没装任何版本
    expect(result.installed).toEqual([])
  })

  test('已装的版本出现在 installed 里（本地信息永远可用，不依赖网络）', async () => {
    const dataDir = trackDir(tempDataDir('tsmg-s3-versions2-'))
    const folder = 'nwjs'
    const localHost = makeHost(dataDir, linksOf(folder))
    const dir = path.join(dataDir, 'modules', folder)
    fs.mkdirSync(path.join(dir, 'deps', 'version', 'v0.106.1'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(buildManifest(findEngine(folder)!)))

    const dispatcher = createDispatcher({ host: localHost })
    const result = (await dispatcher.dispatch(
      'versions',
      { folder, argKey: 'version' },
      new AbortController().signal
    )) as { installed: string[] }

    expect(result.installed).toEqual(['v0.106.1'])
  })

  test('网络失败时 installed 仍然返回（弹窗能显示已装版本，只是可下载为空）', async () => {
    const dataDir = trackDir(tempDataDir('tsmg-s3-offline-'))
    const folder = 'nwjs'
    const dir = path.join(dataDir, 'modules', folder)
    fs.mkdirSync(path.join(dir, 'deps', 'version', 'v0.106.1'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(buildManifest(findEngine(folder)!)))

    const offlineHost = createCoreHost({
      dataDir,
      corePath: resolveCorePath({ env: {}, appPath: process.cwd() }),
      fetchImpl: async () => {
        throw new Error('offline')
      },
      onEvent: () => undefined
    })
    const dispatcher = createDispatcher({ host: offlineHost })
    const result = (await dispatcher.dispatch(
      'versions',
      { folder, argKey: 'version' },
      new AbortController().signal
    )) as { installed: string[]; available: Record<string, unknown>; warning: string | null }

    // 关键：已装列表**照常返回**（这是「失败不抛错」的理由）
    expect(result.installed).toEqual(['v0.106.1'])
    expect(result.available).toEqual({})
    expect(result.warning).toBeTruthy()
  })

  test('不认识的 multi-version 参数 → 明确说拿不到（不装成空列表）', async () => {
    const dataDir = trackDir(tempDataDir('tsmg-s3-unknownver-'))
    const folder = 'mkxpz'
    const localHost = makeHost(dataDir, [])
    const dir = path.join(dataDir, 'modules', folder)
    fs.mkdirSync(dir, { recursive: true })
    // 造一个 registry 里没有的 multi-version 键
    const manifest = buildManifest(findEngine(folder)!) as { gameArgs: Record<string, unknown> }
    manifest.gameArgs.bogusVersion = { type: 'multi-version', label: 'Bogus' }
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))

    const dispatcher = createDispatcher({ host: localHost })
    const result = (await dispatcher.dispatch(
      'versions',
      { folder, argKey: 'bogusVersion' },
      new AbortController().signal
    )) as { available: Record<string, unknown>; warning: string | null }

    expect(result.available).toEqual({})
    expect(result.warning).toContain('不支持')
  })
})
