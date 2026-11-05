// M6：识别范围 > 启动范围 —— 「只认不跑」的引擎不许抢走「能跑」的引擎。
//
// ===== 这条测试守的是什么 =====
//
// 用户要求「引擎范围尽可能广」。为此我们做了两件事：
//
//   ① `ENGINES`（能装能跑）扩到 6 个（加 tyrano / kirikiri）
//   ② 新增 `DETECT_ONLY`（Unity / RPGBakin / ウディタ）—— **只认，不跑**
//      （它们只有 Windows 二进制，用户拍板交给 CrossOver）
//
// ②的关键前提是：**仅识别规则必须弱于所有可启动引擎**。
// 一旦它抢走一个本该属于可启动引擎的游戏，后果是**游戏能跑却跑不了**：
// 用户添加一个 RPG Maker 游戏，系统说「这是 Unity，需要 Windows」——
// 而实际上它用现有引擎立刻就能玩。这类错误**不报错、不崩溃**，只是安静地废掉一个功能，
// 是最难发现的一类回归。
//
// `pickBestRule` 的保证是规则 ③：「强命中永远压过打分命中」。
// 所以只要 DETECT_ONLY 的条目**一律 `all_required: false`**（走打分），
// 可启动引擎的强命中就不可能被抢。**这条测试把它钉死。**
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { DETECT_ONLY, ENGINES } from '../src/main/engines/registry'
import { definitionsFromRegistry, definitionsWithDetectOnly, detectEngineFromDefinitions } from '../src/main/engines/detect'

const created: string[] = []
afterAll(() => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** 造一个临时游戏目录，`entries` 是「相对路径 → 是否目录」。 */
function makeGameDir(entries: Record<string, 'file' | 'dir'>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-prio-'))
  created.push(root)
  for (const [rel, kind] of Object.entries(entries)) {
    const target = path.join(root, rel)
    if (kind === 'dir') {
      fs.mkdirSync(target, { recursive: true })
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, '')
    }
  }
  return root
}

/** 合并表（= 生产用的那张）。 */
const merged = definitionsWithDetectOnly(ENGINES, DETECT_ONLY)

describe('DETECT_ONLY 的强度：一律走打分，绝不强命中', () => {
  test('每个仅识别条目的 all_required 都是 false（这条破了下面的保证就没了）', () => {
    // 若有人给 DETECT_ONLY 写了 all_required: true，两个强命中撞车时
    // pickBestRule 会按「文件命中数多」排序，可能选中跑不了的那个。
    for (const entry of DETECT_ONLY) {
      const rule = definitionsFromRegistry([entry])[entry.folder]
      expect(rule, `${entry.folder} 必须生成规则`).toBeDefined()
      expect(rule.all_required, `${entry.folder} 不许是强命中`).toBe(false)
    }
  })

  test('仅识别条目不进 ENGINES（不会被列成「可安装」）', () => {
    for (const entry of DETECT_ONLY) {
      expect(ENGINES.map((engine) => engine.folder)).not.toContain(entry.folder)
    }
  })

  test('每个仅识别条目都带 reasonKey（UI 要用它解释「为什么跑不了」）', () => {
    for (const entry of DETECT_ONLY) {
      expect(entry.reasonKey.trim(), `${entry.folder} 缺 reasonKey`).not.toBe('')
    }
  })
})

describe('可启动引擎永远赢过仅识别引擎', () => {
  test('一个同时像 Unity、又确实是 RPG Maker MV 的目录 → 判成 nwjs', () => {
    // 构造：MV 的强命中标志（nw.dll + package.json）全在，
    // 同时塞一个 UnityPlayer.dll 诱饵（Unity 规则是打分制）。
    const dir = makeGameDir({
      'nw.dll': 'file',
      'package.json': 'file',
      'UnityPlayer.dll': 'file'
    })
    expect(detectEngineFromDefinitions(path.join(dir, 'Game.exe'), merged)).toBe('nwjs')
  })

  test('一个同时像 Unity、又确实是 Ren\'Py 的目录 → 判成 renpy', () => {
    const dir = makeGameDir({
      renpy: 'dir',
      'UnityPlayer.dll': 'file'
    })
    expect(detectEngineFromDefinitions(path.join(dir, 'Game.exe'), merged)).toBe('renpy')
  })

  test('一个同时像 Unity、又确实是 Tyrano 的目录 → 判成 tyrano', () => {
    const dir = makeGameDir({
      tyrano: 'dir',
      data: 'dir',
      'UnityPlayer.dll': 'file'
    })
    expect(detectEngineFromDefinitions(path.join(dir, 'Game.exe'), merged)).toBe('tyrano')
  })

  test('一个同时像ウディタ、又确实是吉里吉里的目录 → 判成 kirikiri', () => {
    const dir = makeGameDir({
      'data.xp3': 'file',
      'Data.wolf': 'file'
    })
    expect(detectEngineFromDefinitions(path.join(dir, 'Game.exe'), merged)).toBe('kirikiri')
  })
})

describe('仅识别引擎也能被认出来（这是「范围广」的那一半）', () => {
  test('纯 Unity 目录 → unity', () => {
    const dir = makeGameDir({ 'UnityPlayer.dll': 'file' })
    expect(detectEngineFromDefinitions(path.join(dir, 'Game.exe'), merged)).toBe('unity')
  })

  test('纯ウディタ目录（有 Data.wolf） → wolfrpg', () => {
    const dir = makeGameDir({ 'Data.wolf': 'file', 'Game.exe': 'file' })
    expect(detectEngineFromDefinitions(path.join(dir, 'Game.exe'), merged)).toBe('wolfrpg')
  })

  test('既没有可启动引擎、也没有仅识别规则命中 → null（不猜、不回退）', () => {
    const dir = makeGameDir({ 'readme.txt': 'file' })
    expect(detectEngineFromDefinitions(path.join(dir, 'Game.exe'), merged)).toBeNull()
  })
})

describe('合并表本身', () => {
  test('包含 ENGINES 与 DETECT_ONLY 的全部条目（不多不少）', () => {
    const expected = [...ENGINES.map((e) => e.folder), ...DETECT_ONLY.map((e) => e.folder)].sort()
    expect(Object.keys(merged).sort()).toEqual(expected)
  })

  test('可启动引擎在先、仅识别在后（顺序参与同分排序）', () => {
    const keys = Object.keys(merged)
    const firstDetectOnly = keys.indexOf(DETECT_ONLY[0].folder)
    for (const engine of ENGINES) {
      expect(keys.indexOf(engine.folder)).toBeGreaterThanOrEqual(0)
      expect(keys.indexOf(engine.folder)).toBeLessThan(firstDetectOnly)
    }
  })
})
