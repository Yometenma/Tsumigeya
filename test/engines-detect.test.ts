// M4.2 S2 单测：manifest 读取/合并 + 引擎识别（D63 的自实现判决）。
//
// 方案 §5 S2 的验收标准：用现有 fixtures（MV / VX Ace / 2000 / Ren'Py）验证识别仍正确。
// 另外 R1 是本步的**头号风险**：`.app` 包与「文件在子目录里」漏了 → macOS 上识别不出游戏。
// 所以下面单独一整组锁 `isAppBundlePath` / `gameDirForFiles` 的语义，
// 并用真实目录（临时目录里造的 .app 包）验端到端识别，而不是只测路径函数。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  definitionsFromRegistry,
  detectEngineForPath,
  detectEngineFromDefinitions,
  gameDirForFiles,
  getInstalledModuleFolders,
  getPathExtLower,
  isAppBundlePath,
  normalizeExt,
  ruleFromManifestAutodetect
} from '../src/main/engines/detect'
import { readLocalManifests, readManifest, reconcileGameArgs } from '../src/main/engines/manifest'
import { ENGINES, findEngine } from '../src/main/engines/registry'
import type { ManifestRaw } from '../src/main/engines/manifest'

const FIXTURES = path.join(process.cwd(), 'test', 'fixtures')

// 与上游模块仓库一致的 autodetect 规则（沿用 M1 的 detect.test.ts 形状，证明兼容）。
const UPSTREAM_MANIFESTS: Record<string, ManifestRaw> = {
  nwjs: { autodetect: { extensions: ['exe'], files: ['www/package.json', 'www/nw.dll'], all_required: true } },
  mkxpz: { autodetect: { extensions: ['exe'], files: ['Game.ini', 'Data/System.rvdata2'], all_required: true } },
  easyrpg: { autodetect: { extensions: ['exe'], files: ['RPG_RT.ldb', 'RPG_RT.lmt'], all_required: true } },
  renpy: { autodetect: { extensions: ['exe'], files: ['renpy', 'game/script.rpy'], all_required: true } }
}

let scratch: string
/** 一个空目录（每组用例自己往里造东西，互不干扰）。 */
function scratchDir(name: string): string {
  const dir = path.join(scratch, name)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-m42-detect-'))
})

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true })
})

// ===== 1. 路径工具（R1 的全部细节都在这四个函数里）=====

describe('S2 路径工具：扩展名与 .app 判定（R1）', () => {
  test('normalizeExt 剥任意多个前导点并小写（".py" / "py" 都是 "py"）', () => {
    expect(normalizeExt('.py')).toBe('py')
    expect(normalizeExt('PY')).toBe('py')
    expect(normalizeExt('..py')).toBe('py')
    expect(normalizeExt('')).toBe('')
    expect(normalizeExt(undefined)).toBe('')
  })

  test('getPathExtLower 取最后一段（tar.gz → gz）', () => {
    expect(getPathExtLower('/x/a.tar.gz')).toBe('gz')
    expect(getPathExtLower('/x/Game.EXE')).toBe('exe')
    expect(getPathExtLower('/x/noext')).toBe('')
  })

  test('R1-② 尾斜杠不影响扩展名（Finder 拖进来的路径常带斜杠）', () => {
    expect(getPathExtLower('/x/Game.app/')).toBe('app')
    expect(getPathExtLower('/x/Game.app//')).toBe('app')
    // Windows 反斜杠同理
    expect(getPathExtLower('D:\\games\\Game.app\\')).toBe('app')
  })

  test('isAppBundlePath 只看扩展名，不碰 fs（不存在也判真）', () => {
    expect(isAppBundlePath('/x/Game.app')).toBe(true)
    expect(isAppBundlePath('/x/Game.app/')).toBe(true)
    expect(isAppBundlePath('/x/Game.APP')).toBe(true)
    expect(isAppBundlePath('/x/Game.exe')).toBe(false)
    expect(isAppBundlePath('/x/Game.app/Contents/MacOS/Game')).toBe(false) // 包内可执行文件不是包
    expect(isAppBundlePath('')).toBe(false)
    expect(isAppBundlePath(undefined)).toBe(false)
  })

  test('R1-① .app 的探测点**是它自己**；普通可执行文件的探测点是父目录', () => {
    expect(gameDirForFiles('/x/Game.app')).toBe('/x/Game.app')
    // 尾斜杠被剥掉（否则 path.join 之后路径形态会漂移）
    expect(gameDirForFiles('/x/Game.app/')).toBe('/x/Game.app')
    expect(gameDirForFiles('/x/mac/Game.exe')).toBe('/x/mac')
  })
})

// ===== 2. 用已装 manifest 认引擎（detectEngineForPath）=====

describe('S2 detectEngineForPath：用上游形状的 manifest 认引擎', () => {
  test.each([
    ['rpg-mv', 'Game.exe', 'nwjs'],
    ['rpg-vxace', 'Game.exe', 'mkxpz'],
    ['rpg-2000', 'RPG_RT.exe', 'easyrpg'],
    ['renpy', 'Game.exe', 'renpy']
  ])('fixture %s 的 %s → %s', (dir, exe, engine) => {
    expect(detectEngineForPath(path.join(FIXTURES, dir, exe), UPSTREAM_MANIFESTS)).toBe(engine)
  })

  test('空路径 / 空表 → null（不猜）', () => {
    expect(detectEngineForPath('', UPSTREAM_MANIFESTS)).toBeNull()
    expect(detectEngineForPath(undefined, UPSTREAM_MANIFESTS)).toBeNull()
    expect(detectEngineForPath('/x/Game.exe', {})).toBeNull()
    expect(detectEngineForPath('/x/Game.exe', null)).toBeNull()
  })

  test('all_required 要求**全部**文件在场：缺一个就不命中', () => {
    const partial = scratchDir('partial-mv')
    fs.mkdirSync(path.join(partial, 'www'), { recursive: true })
    fs.writeFileSync(path.join(partial, 'Game.exe'), '')
    fs.writeFileSync(path.join(partial, 'www', 'package.json'), '{}')
    // 缺 www/nw.dll
    expect(detectEngineForPath(path.join(partial, 'Game.exe'), UPSTREAM_MANIFESTS)).toBeNull()
  })

  test('扩展名不在规则里 → 不命中（Game.ini 不是可执行文件）', () => {
    expect(detectEngineForPath(path.join(FIXTURES, 'rpg-vxace', 'Game.ini'), UPSTREAM_MANIFESTS)).toBeNull()
  })

  test('manifest 没有 autodetect 块 → 跳过该条（不影响其它引擎）', () => {
    const mixed: Record<string, ManifestRaw> = {
      broken: {},
      mkxpz: UPSTREAM_MANIFESTS.mkxpz
    }
    expect(detectEngineForPath(path.join(FIXTURES, 'rpg-vxace', 'Game.exe'), mixed)).toBe('mkxpz')
  })

  test('ruleFromManifestAutodetect 归一化：单数 extension 也算扩展名规则', () => {
    const rule = ruleFromManifestAutodetect({ extension: '.PY', files: ['renpy'], all_required: true })
    expect(rule).toEqual({ extensions: ['py'], files: ['renpy'], all_required: true })
    expect(ruleFromManifestAutodetect(undefined)).toBeNull()
  })
})

// ===== 3. 用 registry 的规则认引擎（detectEngineFromDefinitions）=====

describe('S2 detectEngineFromDefinitions：未装引擎也能认（零网络）', () => {
  const definitions = definitionsFromRegistry(ENGINES)

  test('四个 fixtures 都能用 registry 规则认出来', () => {
    expect(detectEngineFromDefinitions(path.join(FIXTURES, 'rpg-mv', 'Game.exe'), definitions)).toBe('nwjs')
    expect(detectEngineFromDefinitions(path.join(FIXTURES, 'rpg-vxace', 'Game.exe'), definitions)).toBe('mkxpz')
    expect(detectEngineFromDefinitions(path.join(FIXTURES, 'rpg-2000', 'RPG_RT.exe'), definitions)).toBe('easyrpg')
    expect(detectEngineFromDefinitions(path.join(FIXTURES, 'renpy', 'Game.exe'), definitions)).toBe('renpy')
  })

  test('规则表形状与 module.js 的 fetchModulesForAutodetect 完全一致', () => {
    // 形状错了就没有引擎能认出来 —— 这是「静默失效」的典型
    expect(Object.keys(definitions).sort()).toEqual(['easyrpg', 'mkxpz', 'nwjs', 'renpy'])
    for (const [folder, rule] of Object.entries(definitions)) {
      const engine = findEngine(folder)!
      // all_required 必须显式是布尔（省了 → undefined → 判据 === true 失效）
      expect(rule.all_required).toBe(engine.autodetect.all_required === true)
      if (engine.autodetect.files?.length) expect(rule.files).toEqual(engine.autodetect.files)
      if (engine.autodetect.extensions?.length) expect(rule.extensions).toEqual(engine.autodetect.extensions)
    }
  })

  test('easyrpg 的 all_required=false 走打分：命中 1/3 也能认出来', () => {
    const dir = scratchDir('only-ldb')
    fs.writeFileSync(path.join(dir, 'RPG_RT.exe'), '')
    fs.writeFileSync(path.join(dir, 'RPG_RT.ldb'), '') // 只有 1/3
    expect(detectEngineFromDefinitions(path.join(dir, 'RPG_RT.exe'), definitions)).toBe('easyrpg')
  })

  test('强命中压过打分命中：mkxpz 四文件齐全时不会被 easyrpg 抢走', () => {
    // VX Ace fixture 里有 Game.ini / System / Graphics / Audio，且**没有** RPG_RT.*
    // easyrpg 打分得 0，mkxpz 强命中 → mkxpz
    expect(detectEngineFromDefinitions(path.join(FIXTURES, 'rpg-vxace', 'Game.exe'), definitions)).toBe('mkxpz')
  })

  test('什么规则都不命中 → null', () => {
    const lonely = scratchDir('lonely')
    fs.writeFileSync(path.join(lonely, 'Game.exe'), '')
    expect(detectEngineFromDefinitions(path.join(lonely, 'Game.exe'), definitions)).toBeNull()
  })

  test('空规则表 → null（不抛）', () => {
    expect(detectEngineFromDefinitions('/x/Game.exe', {})).toBeNull()
    expect(detectEngineFromDefinitions('/x/Game.exe', null)).toBeNull()
  })
})

// ===== 4. R1 的端到端：.app 包与子目录里的文件 =====

describe('S2 R1：.app 包内文件与「文件在子目录里」', () => {
  test('.app 包内的 package.json + nw.dll → 认出 nwjs（探测点是包本身）', () => {
    const bundle = path.join(scratchDir('mac-mv'), 'Game.app')
    fs.mkdirSync(bundle, { recursive: true })
    fs.writeFileSync(path.join(bundle, 'package.json'), '{}')
    fs.writeFileSync(path.join(bundle, 'nw.dll'), '')
    const definitions = definitionsFromRegistry(ENGINES)
    expect(detectEngineFromDefinitions(bundle, definitions)).toBe('nwjs')
    // 带尾斜杠也要认（Finder 拖拽的真实形态）
    expect(detectEngineFromDefinitions(bundle + '/', definitions)).toBe('nwjs')
    // 也能用 manifest 那条通路认
    expect(detectEngineForPath(bundle, { nwjs: { autodetect: { files: ['package.json', 'nw.dll'], all_required: true } } })).toBe('nwjs')
  })

  // 反证 R1：这条故意把「探测点」换成父目录 —— 旧实现若漏掉 isAppBundlePath
  // 就正是这个行为，结果是一条规则都不命中。有此断言，谁把 gameDirForFiles 改回
  // 「一律 path.dirname」都会立刻红。
  test('反证 R1：若探测点错取父目录，同一个包会认不出来', () => {
    const root = scratchDir('mac-mv-neg')
    const bundle = path.join(root, 'Game.app')
    fs.mkdirSync(bundle, { recursive: true })
    fs.writeFileSync(path.join(bundle, 'package.json'), '{}')
    fs.writeFileSync(path.join(bundle, 'nw.dll'), '')
    const rules = { nwjs: { extensions: ['exe', 'app'], files: ['package.json', 'nw.dll'], all_required: true } }

    // 正确语义：探测点是包本身 → 命中
    expect(gameDirForFiles(bundle)).toBe(bundle)
    expect(detectEngineFromDefinitions(bundle, rules)).toBe('nwjs')

    // 反证：父目录里没有这两个文件，同一个规则一条都不命中
    const siblingInParent = path.join(root, 'Game.exe')
    fs.writeFileSync(siblingInParent, '')
    expect(gameDirForFiles(siblingInParent)).toBe(root)
    expect(detectEngineFromDefinitions(siblingInParent, rules)).toBeNull()
  })

  test('「文件在子目录里」：规则写 www/package.json，exe 在外层也命中', () => {
    const dir = scratchDir('subdir-mv')
    fs.mkdirSync(path.join(dir, 'www'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'Game.exe'), '')
    fs.writeFileSync(path.join(dir, 'www', 'package.json'), '{}')
    fs.writeFileSync(path.join(dir, 'www', 'nw.dll'), '')
    const rule = { nwjs: { extensions: ['exe'], files: ['www/package.json', 'www/nw.dll'], all_required: true } }
    expect(detectEngineFromDefinitions(path.join(dir, 'Game.exe'), rule)).toBe('nwjs')
  })

  test('.app 包内的可执行文件按「普通文件」处理（探测点退一层到 Contents/MacOS）', () => {
    const bundle = path.join(scratchDir('mac-renpy'), 'Game.app')
    const macos = path.join(bundle, 'Contents', 'MacOS')
    fs.mkdirSync(macos, { recursive: true })
    fs.writeFileSync(path.join(macos, 'Game'), '')
    // renpy 的文件规则是 `renpy`（包内根本没有）→ 不命中，**不能**误判
    expect(detectEngineFromDefinitions(path.join(macos, 'Game'), definitionsFromRegistry(ENGINES))).toBeNull()
  })
})

/**
 * 反证助手已并入「反证 R1」用例里，这里删掉旧的占位实现（保留函数会让下个会话
 * 以为还有第二处用法）。
 */

// ===== 5. 读本地 manifest 与合并缺省值 =====

describe('S2 readLocalManifests：坏 manifest 只跳过自己', () => {
  let dataDir: string
  beforeAll(() => {
    dataDir = scratchDir('data-ok')
    for (const folder of ['nwjs', 'mkxpz']) {
      const dir = path.join(dataDir, 'modules', folder)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: folder, version: '1.0.0' }))
    }
    // 一个坏 manifest（JSON 语法错）+ 一个没 manifest 的目录 + 一个非目录条目
    fs.mkdirSync(path.join(dataDir, 'modules', 'broken'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'modules', 'broken', 'manifest.json'), '{ not json')
    fs.mkdirSync(path.join(dataDir, 'modules', 'empty'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'modules', 'stray.txt'), '')
  })

  test('正常 manifest 全读出来（坏的被跳过，所以不在键集里）', () => {
    const manifests = readLocalManifests(dataDir)
    expect(Object.keys(manifests).sort()).toEqual(['mkxpz', 'nwjs'])
    expect(manifests.nwjs?.version).toBe('1.0.0')
  })

  test('坏 JSON 只跳过它自己，其余照常（不能让 snapshot 整个崩）', () => {
    const manifests = readLocalManifests(dataDir)
    expect(manifests.broken).toBeUndefined()
    expect(manifests.mkxpz).toBeDefined()
  })

  test('非目录条目与「没 manifest 的目录」都不产出键', () => {
    const manifests = readLocalManifests(dataDir)
    expect(manifests['stray.txt']).toBeUndefined()
    expect(manifests.empty).toBeUndefined()
  })

  test('modules 目录不存在 → 空对象（不是抛错）', () => {
    expect(readLocalManifests(path.join(scratch, 'no-such-data'))).toEqual({})
  })

  test('readManifest 只读单个；不存在 / 坏 JSON → null', () => {
    expect(readManifest(dataDir, 'nwjs')?.name).toBe('nwjs')
    expect(readManifest(dataDir, 'absent')).toBeNull()
    expect(readManifest(dataDir, 'broken')).toBeNull()
  })
})

describe('S2 getInstalledModuleFolders：看目录不看 manifest', () => {
  test('有目录就算装了（manifest 缺失不影响「已装」判定）', () => {
    const dataDir = scratchDir('data-installed')
    fs.mkdirSync(path.join(dataDir, 'modules', 'mkxpz'), { recursive: true })
    fs.mkdirSync(path.join(dataDir, 'modules', 'nwjs'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'modules', 'nwjs', 'manifest.json'), '{}')
    expect(getInstalledModuleFolders(dataDir).sort()).toEqual(['mkxpz', 'nwjs'])
  })

  test('modules 不存在 → 空数组；文件条目被排除', () => {
    expect(getInstalledModuleFolders(path.join(scratch, 'no-modules'))).toEqual([])
    const dataDir = scratchDir('data-stray')
    fs.mkdirSync(path.join(dataDir, 'modules'), { recursive: true })
    fs.writeFileSync(path.join(dataDir, 'modules', 'a.txt'), '')
    fs.mkdirSync(path.join(dataDir, 'modules', 'renpy'), { recursive: true })
    expect(getInstalledModuleFolders(dataDir)).toEqual(['renpy'])
  })
})

describe('S2 reconcileGameArgs：四条语义', () => {
  const schema = {
    fullscreen: { type: 'boolean', default: false },
    RTP: { type: 'array', default: [] },
    version: { type: 'multi-version', default: '' },
    noDefault: { type: 'string' }
  }

  test('① 只补缺、不覆盖：已有的 false / "" / 0 都保住了', () => {
    const merged = reconcileGameArgs({ fullscreen: true, RTP: [] }, schema)
    expect(merged.merged.fullscreen).toBe(true)
    expect(merged.merged.RTP).toEqual([])
  })

  test('① 反面：用 `??` 判缺会踩的坑（false 是合法值，不能被当没填）', () => {
    // schema 只有 fullscreen 这一条：值已存在 → 不该补、也不该报 changed
    const merged = reconcileGameArgs({ fullscreen: false }, { fullscreen: { type: 'boolean', default: false } })
    expect(merged.merged.fullscreen).toBe(false)
    expect(merged.changed).toBe(false)
  })

  test('② 未知键原样保留（我们砍掉的 49 个参数不能被删）', () => {
    const merged = reconcileGameArgs({ legacyCheat: true, applyPixelPatch: 1 }, schema)
    expect(merged.merged.legacyCheat).toBe(true)
    expect(merged.merged.applyPixelPatch).toBe(1)
  })

  test('③ multi-version 不补默认值（补了会拼出不存在的路径 → 点启动没反应）', () => {
    const merged = reconcileGameArgs({}, schema)
    expect(Object.hasOwn(merged.merged, 'version')).toBe(false)
  })

  test('④ changed 只在真的补了东西时为 true；schema 没写 default 的不补', () => {
    expect(reconcileGameArgs({}, schema).changed).toBe(true)
    expect(reconcileGameArgs({ fullscreen: true }, { noDefault: { type: 'string' } }).changed).toBe(false)
    expect(reconcileGameArgs(undefined, null).changed).toBe(false)
  })

  test('默认数组是拷贝，不是共享引用（否则改 A 游戏的 RTP 会影响 B）', () => {
    const first = reconcileGameArgs({}, { RTP: { type: 'array', default: [] } })
    ;(first.merged.RTP as string[]).push('RTP.zip')
    const second = reconcileGameArgs({}, { RTP: { type: 'array', default: [] } })
    expect(second.merged.RTP).toEqual([])
  })

  test('不改入参（入参对象本身保持原样）', () => {
    const input = { fullscreen: true }
    reconcileGameArgs(input, schema)
    expect(input).toEqual({ fullscreen: true })
  })
})
