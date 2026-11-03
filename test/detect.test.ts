// detect 单测（§6）：真实装载 resources/core/module.js，不依赖网络与 GUI。
// 模块 manifest 用上游 Xenolauncher-Modules 的 autodetect 规则（写进临时数据目录）。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createCoreHost, resolveCorePath, scanCandidates, compareCandidates } from '../src/main/core-host'

describe('resolveCorePath（dev 入口路径探测）', () => {
  test('appPath 是项目根时直接命中', () => {
    const resolved = resolveCorePath({ env: {}, appPath: process.cwd() })
    expect(resolved).toBe(path.join(process.cwd(), 'resources', 'core', 'module.js'))
  })

  // 回归：用 `electron out/main/index.js`（文件入口）启动时 app.getAppPath() 是 out/main，
  // 旧实现会拼出 out/main/resources/core/module.js 并抛 ENOENT。
  test('appPath 是 out/main（文件入口）时向上探测到项目根', () => {
    const resolved = resolveCorePath({ env: {}, appPath: path.join(process.cwd(), 'out', 'main') })
    expect(resolved).toBe(path.join(process.cwd(), 'resources', 'core', 'module.js'))
  })

  test('TSUMIGEYA_CORE_PATH 覆盖优先', () => {
    const resolved = resolveCorePath({
      env: { TSUMIGEYA_CORE_PATH: 'D:/custom/core/module.js' },
      appPath: process.cwd()
    })
    expect(resolved).toBe(path.resolve('D:/custom/core/module.js'))
  })

  test('打包态用 resourcesPath/core/module.js', () => {
    const resolved = resolveCorePath({
      env: {},
      isPackaged: true,
      resourcesPath: '/Applications/Tsumigeya.app/Contents/Resources'
    })
    expect(resolved).toBe(path.join('/Applications/Tsumigeya.app/Contents/Resources', 'core', 'module.js'))
  })
})

/** 与上游模块仓库一致的 autodetect 规则（§6 要求）。 */
const MANIFESTS: Record<string, Record<string, unknown>> = {
  nwjs: {
    name: 'NW.js',
    version: '0.1.0',
    author: 'm5kro',
    description: 'RPG Maker MV/MZ',
    autodetect: { extensions: ['exe'], files: ['www/package.json', 'www/nw.dll'], all_required: true }
  },
  mkxpz: {
    name: 'MKXP-Z',
    version: '1.1.5',
    author: 'm5kro',
    description: 'RPG Maker XP/VX/VX Ace',
    autodetect: { extensions: ['exe'], files: ['Game.ini', 'Data/System.rvdata2'], all_required: true }
  },
  easyrpg: {
    name: 'EasyRPG',
    version: '1.0.0',
    author: 'm5kro',
    description: 'RPG Maker 2000/2003',
    autodetect: { extensions: ['exe'], files: ['RPG_RT.ldb', 'RPG_RT.lmt'], all_required: true }
  },
  renpy: {
    name: "Ren'Py",
    version: '1.0.0',
    author: 'm5kro',
    description: "Ren'Py visual novels",
    autodetect: { extensions: ['exe'], files: ['renpy', 'game/script.rpy'], all_required: true }
  }
}

const FIXTURES = path.join(process.cwd(), 'test', 'fixtures')

let dataDir: string
let host: ReturnType<typeof createCoreHost>

beforeAll(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'tsmg-detect-'))
  for (const [folder, manifest] of Object.entries(MANIFESTS)) {
    const dir = path.join(dataDir, 'modules', folder)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
    writeFileSync(path.join(dir, 'launcher.js'), 'exports.launch = async () => {}')
  }
  host = createCoreHost({
    dataDir,
    corePath: resolveCorePath({ env: {}, appPath: process.cwd() }),
    // 测试绝不触网：显式给一个会失败的 fetch
    fetchImpl: async () => {
      throw new Error('network disabled in tests')
    },
    onEvent: () => undefined
  })
})

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('detectFolder 的远端兜底不能挂死', () => {
  // 回归：core.fetchModulesForAutodetect 没有 signal 参数，网络卡住时会把
  // 「正在识别引擎…」永远挂在那里。detectFolder 必须自己带超时护栏。
  test('远端 fetch 永不返回时，仍在超时内返回本地结果', async () => {
    const slowDir = mkdtempSync(path.join(tmpdir(), 'tsmg-slow-'))
    const slowHost = createCoreHost({
      dataDir: slowDir,
      corePath: resolveCorePath({ env: {}, appPath: process.cwd() }),
      // 永不 resolve：模拟 DNS 卡死 / 连接挂起
      fetchImpl: () => new Promise<Response>(() => undefined),
      onEvent: () => undefined
    })
    const started = Date.now()
    try {
      const result = await slowHost.detectFolder({ path: path.join(FIXTURES, 'rpg-vxace'), includeRemote: true })
      const elapsed = Date.now() - started
      // 本地 manifest 为空（slowDir 里没装模块），所以 engine 应为 null，但调用必须返回
      expect(result).toBeTruthy()
      expect(elapsed).toBeLessThan(15_000)
    } finally {
      rmSync(slowDir, { recursive: true, force: true })
    }
  }, 20_000)
})

describe('四个 fixtures 的引擎识别', () => {
  const cases: Array<{ dir: string; exe: string; engine: string }> = [
    { dir: 'rpg-mv', exe: 'Game.exe', engine: 'nwjs' },
    { dir: 'rpg-vxace', exe: 'Game.exe', engine: 'mkxpz' },
    { dir: 'rpg-2000', exe: 'RPG_RT.exe', engine: 'easyrpg' },
    { dir: 'renpy', exe: 'Game.exe', engine: 'renpy' }
  ]

  for (const item of cases) {
    test(`${item.dir} 的可执行文件 → ${item.engine}`, () => {
      const exe = path.join(FIXTURES, item.dir, item.exe)
      const engine = host.core.detectEngineForPath(exe, host.core.readLocalManifests())
      expect(engine).toBe(item.engine)
    })
  }
})

describe('all_required 与打分', () => {
  test('只有 Game.exe、没有 www/ 时不会误判成 nwjs', () => {
    const lonely = path.join(dataDir, 'lonely')
    mkdirSync(lonely, { recursive: true })
    writeFileSync(path.join(lonely, 'Game.exe'), '')
    expect(host.core.detectEngineForPath(path.join(lonely, 'Game.exe'), MANIFESTS)).toBeNull()
  })

  test('MV 目录缺 www/nw.dll 时也不算命中（all_required 要求全部文件）', () => {
    const partial = path.join(dataDir, 'partial-mv')
    mkdirSync(path.join(partial, 'www'), { recursive: true })
    writeFileSync(path.join(partial, 'Game.exe'), '')
    writeFileSync(path.join(partial, 'www', 'package.json'), '{}')
    // 缺 www/nw.dll
    expect(host.core.detectEngineForPath(path.join(partial, 'Game.exe'), MANIFESTS)).toBeNull()
  })

  test('VX Ace 目录若缺 System.rvdata2 则不命中', () => {
    const partial = path.join(dataDir, 'partial-vxace')
    mkdirSync(path.join(partial, 'Data'), { recursive: true })
    writeFileSync(path.join(partial, 'Game.exe'), '')
    writeFileSync(path.join(partial, 'Game.ini'), '')
    expect(host.core.detectEngineForPath(path.join(partial, 'Game.exe'), MANIFESTS)).toBeNull()
  })

  test('非 exe 扩展名不命中（autodetect.extensions 限制）', () => {
    const script = path.join(FIXTURES, 'rpg-vxace', 'Game.ini')
    expect(host.core.detectEngineForPath(script, MANIFESTS)).toBeNull()
  })
})

describe('detectFolder', () => {
  test('rpg-vxace 目录 → best.engine === mkxpz、isFile === false', async () => {
    const result = await host.detectFolder({ path: path.join(FIXTURES, 'rpg-vxace') })
    expect(result.isFile).toBe(false)
    expect(result.best?.engine).toBe('mkxpz')
    expect(result.best?.installed).toBe(true)
    expect(result.candidates.length).toBeGreaterThan(0)
  })

  test('传可执行文件 → isFile === true', async () => {
    const result = await host.detectFolder({ path: path.join(FIXTURES, 'rpg-2000', 'RPG_RT.exe') })
    expect(result.isFile).toBe(true)
    expect(result.best?.engine).toBe('easyrpg')
  })

  test('不存在的路径 → error.pathMissing', async () => {
    await expect(host.detectFolder({ path: path.join(FIXTURES, 'no-such-dir') })).rejects.toMatchObject({
      translationKey: 'error.pathMissing'
    })
  })

  test('空字符串路径 → error.pathMissing', async () => {
    await expect(host.detectFolder({ path: '' })).rejects.toMatchObject({
      translationKey: 'error.pathMissing'
    })
  })

  test('目录里没有可执行文件 → best 为 null、candidates 为空', async () => {
    const empty = path.join(dataDir, 'empty-dir')
    mkdirSync(empty, { recursive: true })
    writeFileSync(path.join(empty, 'readme.txt'), 'nothing here')
    const result = await host.detectFolder({ path: empty })
    expect(result.best).toBeNull()
    expect(result.candidates).toEqual([])
  })

  test('includeRemote 失败（无网络）不崩，只是拿不到远端规则', async () => {
    const lonely = path.join(dataDir, 'lonely2')
    mkdirSync(lonely, { recursive: true })
    writeFileSync(path.join(lonely, 'Game.exe'), '')
    // fetchImpl 会抛错 → detectFolder 内部 catch 掉并 log，不向外抛
    const result = await host.detectFolder({ path: lonely, includeRemote: true })
    expect(result.best).toBeNull()
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]?.engine).toBeNull()
  })
})

describe('候选扫描与排序', () => {
  test('只收 exe/app/msi/bat/sh/command', () => {
    const dir = path.join(dataDir, 'mixed')
    mkdirSync(dir, { recursive: true })
    for (const name of ['a.exe', 'b.app', 'c.msi', 'd.bat', 'e.sh', 'f.command', 'readme.txt', 'image.png']) {
      if (name.endsWith('.app')) mkdirSync(path.join(dir, name), { recursive: true })
      else writeFileSync(path.join(dir, name), '')
    }
    const { candidates } = scanCandidates(dir)
    expect(candidates).toHaveLength(6)
    expect(candidates.every((item) => /\.(exe|app|msi|bat|sh|command)$/i.test(item))).toBe(true)
  })

  test('文件名含 game 的优先', () => {
    expect(compareCandidates('/x/Game.exe', '/x/aaa.exe')).toBeLessThan(0)
    expect(compareCandidates('/x/GAME.EXE', '/x/zzz.exe')).toBeLessThan(0)
  })

  test('扩展名权重 app > exe > command > sh > bat > msi', () => {
    const order = ['a.app', 'a.exe', 'a.command', 'a.sh', 'a.bat', 'a.msi']
    for (let i = 0; i < order.length - 1; i += 1) {
      const left = `/x/${order[i]}`
      const right = `/x/${order[i + 1]}`
      expect(compareCandidates(left, right)).toBeLessThan(0)
    }
  })

  test('同权重时浅层优先', () => {
    expect(compareCandidates('/x/aaa.exe', '/x/sub/aaa.exe')).toBeLessThan(0)
  })

  test('跳过 node_modules 与点目录', () => {
    const dir = path.join(dataDir, 'skips')
    mkdirSync(path.join(dir, 'node_modules'), { recursive: true })
    mkdirSync(path.join(dir, '.hidden'), { recursive: true })
    writeFileSync(path.join(dir, 'node_modules', 'tool.exe'), '')
    writeFileSync(path.join(dir, '.hidden', 'secret.exe'), '')
    writeFileSync(path.join(dir, 'Real.exe'), '')
    const { candidates } = scanCandidates(dir)
    expect(candidates).toHaveLength(1)
    expect(path.basename(candidates[0] ?? '')).toBe('Real.exe')
  })

  test('最多 200 个候选', () => {
    const dir = path.join(dataDir, 'many')
    mkdirSync(dir, { recursive: true })
    for (let index = 0; index < 260; index += 1) {
      writeFileSync(path.join(dir, `g${String(index).padStart(3, '0')}.exe`), '')
    }
    const { candidates } = scanCandidates(dir)
    expect(candidates).toHaveLength(200)
  })

  test('.app 内部不会被深扫', () => {
    const dir = path.join(dataDir, 'bundle')
    mkdirSync(path.join(dir, 'Game.app', 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(path.join(dir, 'Game.app', 'Contents', 'MacOS', 'runner'), '')
    const { candidates } = scanCandidates(dir)
    // 只把 .app 目录本身当候选，不深入内部
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.endsWith('Game.app')).toBe(true)
  })
})
