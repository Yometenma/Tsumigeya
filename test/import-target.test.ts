// M5.0 S3（U5）单测：「只选文件」之后怎么反推游戏目录（src/shared/import-target.ts）。
//
// ===== 这轮测什么 =====
//
// U5 把「选择文件夹」删了，用户只能选文件。四个引擎的入口都是「目录里有哪些文件」，
// 所以选哪个标志性文件都能反推目录 —— 但方案 §6 点名了两个例外，两个都是真坑：
//
//   ① 用户选错文件（readme.txt / www/package.json）→ 要能往上退到游戏根
//   ② Ren'Py 的入口在 游戏名/game/ 子目录 → 只退一层不够？
//      实测只退 1 层就够（game/ 的父就是游戏根），但 mac 的
//      Xxx.app/Contents/MacOS/xxx 要退 2 层 → 这是 MAX_ASCEND=2 的依据
//
// 更要紧的是**上限**：没有上限就会一路退到 /Users 甚至 /，
// 撞上无关目录里的残骸文件，认出一个"看起来对"的引擎，用户存进去才发现指错了游戏。
//
// ⚠️ 这些判据是纯字符串逻辑，不碰盘 —— 所以能纯 Node 跑，也不受 Windows/mac 路径风格影响。
// 下面 Windows 反斜杠与 POSIX 斜杠两组都测，因为开发机是 Windows、目标平台是 mac。
import { describe, expect, test } from 'vitest'
import {
  MAX_ASCEND,
  buildImportAttempts,
  importGamePath,
  importOutcome,
  parentOf,
  stripTrailingSep
} from '../src/shared/import-target'

describe('stripTrailingSep：尾分隔符', () => {
  test('剥掉重复的斜杠（mac 上从 Finder 拖进来的路径经常带尾斜杠）', () => {
    expect(stripTrailingSep('/x/Game/')).toBe('/x/Game')
    expect(stripTrailingSep('/x/Game///')).toBe('/x/Game')
    expect(stripTrailingSep('D:\\Games\\A\\')).toBe('D:\\Games\\A')
  })

  test('没有尾斜杠时原样返回', () => {
    expect(stripTrailingSep('/x/Game')).toBe('/x/Game')
    expect(stripTrailingSep('D:\\Games\\A')).toBe('D:\\Games\\A')
  })

  test('Unix 根不会被剥成空串', () => {
    expect(stripTrailingSep('/')).toBe('/')
  })

  test('首尾空白先剥掉，再处理分隔符', () => {
    expect(stripTrailingSep('  /x/Game/  ')).toBe('/x/Game')
  })

  test('空输入 → 空串（调用方据此提前返回）', () => {
    expect(stripTrailingSep('')).toBe('')
    expect(stripTrailingSep('   ')).toBe('')
  })
})

describe('parentOf：上退一层，到顶就停', () => {
  test('POSIX 路径', () => {
    expect(parentOf('/Users/me/Games/MyGame/Game.exe')).toBe('/Users/me/Games/MyGame')
    expect(parentOf('/Users/me/Games/MyGame')).toBe('/Users/me/Games')
  })

  test('Windows 反斜杠（开发机是 Windows，必须认）', () => {
    expect(parentOf('D:\\Games\\MyGame\\Game.exe')).toBe('D:\\Games\\MyGame')
    expect(parentOf('D:\\Games\\MyGame')).toBe('D:\\Games')
  })

  test('⚠️ 到 Unix 根就停（返回 null）：不能一路退到 /', () => {
    expect(parentOf('/x')).toBeNull()
    expect(parentOf('/')).toBeNull()
  })

  test('⚠️ 到 Windows 盘符根就停（不再退到 D: 这种盘符本身）', () => {
    // `D:\x` 的父目录是盘符根 `D:\` —— 它不是游戏目录，所以直接判到头（null）
    expect(parentOf('D:\\x')).toBeNull()
    expect(parentOf('D:\\x\\y')).toBe('D:\\x')
    // `D:` 本身也到头
    expect(parentOf('D:')).toBeNull()
  })

  test('混合分隔符也能取到正确的父目录', () => {
    expect(parentOf('/Users/me\\Games/MyGame')).toBe('/Users/me\\Games')
  })

  test('没有分隔符的相对名 → null（不让它退成空路径）', () => {
    expect(parentOf('Game.exe')).toBeNull()
  })
})

describe('buildImportAttempts：尝试顺序与上限', () => {
  test('level 0 是选中的文件本身，然后逐层往上', () => {
    const attempts = buildImportAttempts('/Users/me/Games/MyGame/Game.exe')
    expect(attempts.map((item) => item.level)).toEqual([0, 1, 2])
    expect(attempts[0]?.path).toBe('/Users/me/Games/MyGame/Game.exe')
    expect(attempts[1]?.path).toBe('/Users/me/Games/MyGame')
    expect(attempts[2]?.path).toBe('/Users/me/Games')
  })

  test('⚠️ 上限就是 MAX_ASCEND=2（再深就不是游戏目录了）', () => {
    expect(MAX_ASCEND).toBe(2)
    const attempts = buildImportAttempts('/a/b/c/d/e/f.txt')
    expect(attempts).toHaveLength(3)
  })

  test('层级不够时不越界（路径本来就浅）', () => {
    expect(buildImportAttempts('/x/Game.exe').map((item) => item.level)).toEqual([0, 1])
  })

  test('尾斜杠不会多造一层重复项', () => {
    const attempts = buildImportAttempts('/x/Game/')
    expect(attempts[0]?.path).toBe('/x/Game')
    expect(attempts.map((item) => item.path)).toEqual(['/x/Game', '/x'])
  })

  test('空输入 → 空列表（调用方不用特判）', () => {
    expect(buildImportAttempts('')).toEqual([])
  })

  test('可自定义上限（测试与将来放宽时用）', () => {
    expect(buildImportAttempts('/a/b/c/d', 0)).toHaveLength(1)
    expect(buildImportAttempts('/a/b/c/d', 1)).toHaveLength(2)
  })
})

describe('importGamePath：哪一层认出就存什么', () => {
  const picked = '/Users/me/Games/MyGame/Game.exe'
  const attempts = buildImportAttempts(picked)

  test('level 0（选中的文件本身认出来了）→ 原样存那个文件', () => {
    expect(importGamePath(picked, attempts[0]!, '/Users/me/Games/MyGame/Game.exe')).toBe(picked)
  })

  test('level 1（退到目录才认出来）→ 存该层识别出的候选（通常是个 exe）', () => {
    expect(importGamePath(picked, attempts[1]!, '/Users/me/Games/MyGame/Other.exe')).toBe(
      '/Users/me/Games/MyGame/Other.exe'
    )
  })

  test('level ≥ 1 但该层没给候选 → 退回该层路径（不能存成 undefined）', () => {
    expect(importGamePath(picked, attempts[1]!, null)).toBe('/Users/me/Games/MyGame')
  })

  test('用户选的是 readme.txt：认出来的是同目录的 Game.exe', () => {
    const readme = '/Users/me/Games/MyGame/readme.txt'
    const list = buildImportAttempts(readme)
    expect(importGamePath(readme, list[1]!, '/Users/me/Games/MyGame/Game.exe')).toBe(
      '/Users/me/Games/MyGame/Game.exe'
    )
  })

  test("⚠️ Ren'Py 例外：选了 game/script.rpy，退一层到游戏根", () => {
    // 实测目录形态：游戏名/renpy/  +  游戏名/game/script.rpy
    const script = '/Users/me/Games/MyGame/game/script.rpy'
    const list = buildImportAttempts(script)
    expect(list[1]?.path).toBe('/Users/me/Games/MyGame/game')
    expect(list[2]?.path).toBe('/Users/me/Games/MyGame')
    // renpy 规则要的 files 里含 'renpy'，只有游戏根那层能命中 → level 2
    expect(importGamePath(script, list[2]!, '/Users/me/Games/MyGame/Game.exe')).toBe(
      '/Users/me/Games/MyGame/Game.exe'
    )
  })

  test('⚠️ mac .app：选了包里的二进制，退两层回到 .app 本身', () => {
    const binary = '/Users/me/Games/MyGame.app/Contents/MacOS/MyGame'
    const list = buildImportAttempts(binary)
    expect(list[0]?.path).toBe('/Users/me/Games/MyGame.app/Contents/MacOS/MyGame')
    expect(list[1]?.path).toBe('/Users/me/Games/MyGame.app/Contents/MacOS')
    // `.app` 包的根是它自己，不是 Contents
    expect(list[2]?.path).toBe('/Users/me/Games/MyGame.app/Contents')
  })
})

describe('importOutcome：收敛结论', () => {
  const picked = '/Users/me/Games/MyGame/readme.txt'
  const attempts = buildImportAttempts(picked)

  test('第一次成功就采纳，后面的不看', () => {
    const outcome = importOutcome(picked, attempts, [
      { level: 0, engine: 'renpy', bestPath: picked },
      { level: 1, engine: 'nwjs', bestPath: '/Users/me/Games/MyGame/Game.exe' }
    ])
    expect(outcome.engine).toBe('renpy')
    expect(outcome.level).toBe(0)
    expect(outcome.ascended).toBe(false)
  })

  test('level 0 失败、level 1 成功 → 标记 ascended 且换成候选路径', () => {
    const outcome = importOutcome(picked, attempts, [
      { level: 0, engine: null, bestPath: null },
      { level: 1, engine: 'nwjs', bestPath: '/Users/me/Games/MyGame/Game.exe' }
    ])
    expect(outcome.engine).toBe('nwjs')
    expect(outcome.level).toBe(1)
    expect(outcome.ascended).toBe(true)
    expect(outcome.gamePath).toBe('/Users/me/Games/MyGame/Game.exe')
  })

  test('⚠️ 全失败 → 保持用户选的文件（不擅自改成父目录）', () => {
    const outcome = importOutcome(picked, attempts, [
      { level: 0, engine: null, bestPath: null },
      { level: 1, engine: null, bestPath: null },
      { level: 2, engine: null, bestPath: null }
    ])
    expect(outcome.engine).toBeNull()
    expect(outcome.level).toBeNull()
    expect(outcome.ascended).toBe(false)
    // 老行为：识别失败也能把游戏存下来（引擎可稍后在编辑页指定）
    expect(outcome.gamePath).toBe(picked)
  })

  test('空检测列表等价于全失败', () => {
    expect(importOutcome(picked, attempts, []).gamePath).toBe(picked)
  })

  test('level 0 就认出来时 gamePath 是用户选的那个文件（不擅自改写）', () => {
    const gameExe = '/Users/me/Games/MyGame/Game.exe'
    const list = buildImportAttempts(gameExe)
    const outcome = importOutcome(gameExe, list, [{ level: 0, engine: 'mkxpz', bestPath: gameExe }])
    expect(outcome.gamePath).toBe(gameExe)
    expect(outcome.ascended).toBe(false)
  })

  test('ascended 只在真的往上退过一层时才是 true', () => {
    const outcome = importOutcome(picked, attempts, [{ level: 2, engine: 'nwjs', bestPath: null }])
    expect(outcome.ascended).toBe(true)
    // 没给候选 → 存该层路径
    expect(outcome.gamePath).toBe('/Users/me/Games')
  })
})
