// M6.5：NScripter（ONScripter）启动方案的单测。
//
// 守的是「三个会静默失败的点」——这类错误不崩溃、不报错，只是安静地表现成另一个行为：
//
//   ① 缺 default.ttf：**根本起不来**（所以字体必须由我们提供，不能依赖游戏目录）
//   ② 存档落进随机目录：**用户的档存下来了但谁都找不到**（D85 同类的坑）
//   ③ 选错二进制（onscripter 而不是 onscripter-sdl2）：**画面画不出来**（黑屏，不报错）
//
// 这三条的共同点：**测试是唯一能在无画面环境里抓住它们的办法**。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import {
  nscripterDepsDir,
  onscripterBinaryPath,
  onscripterExpectedPath
} from '../src/main/launchers/binary-paths'
import {
  bundledFontPath,
  hasNscripterEntry,
  nscripterMissingEntryMessage,
  nscripterPlan,
  nscripterSaveDir
} from '../src/main/launchers/nscripter'
import type { LaunchContext } from '../src/main/launchers/types'

const created: string[] = []
afterAll(() => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

function makeCtx(overrides: Partial<LaunchContext> = {}): LaunchContext {
  return {
    folder: '/games/demo',
    gamePath: '/games/demo/nscript.dat',
    gameArgs: {},
    gameTitle: 'Demo Game',
    dataDir: '/data',
    platform: 'darwin',
    arch: 'arm64',
    ...overrides
  }
}

/** 造一个临时 dataDir；`files` 是相对 deps/onscripter 的文件列表。 */
function makeDataDir(files: string[] = []): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-ons-'))
  created.push(dataDir)
  for (const rel of files) {
    const target = path.join(nscripterDepsDir(dataDir), rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, '')
  }
  return dataDir
}

/** 造一个临时游戏目录。 */
function makeGameDir(entries: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-game-'))
  created.push(dir)
  for (const name of entries) fs.writeFileSync(path.join(dir, name), '')
  return dir
}

describe('onscripterBinaryPath：必须优先 sdl2 版', () => {
  test('两个都在时**选 onscripter-sdl2**（Apple Silicon 上只有它能用）', () => {
    // tmkk 原话：现代 macOS 用 SDL 1.2 画不出东西；arm64 只能跑 64 位 → 必须 sdl2 版。
    // 选错的表现是**黑屏**，不报错。
    const dataDir = makeDataDir(['onscripter-sdl2', 'onscripter'])
    expect(onscripterBinaryPath(dataDir)).toBe(path.join(nscripterDepsDir(dataDir), 'onscripter-sdl2'))
  })

  test('只有 sdl2 版 → 用它', () => {
    const dataDir = makeDataDir(['onscripter-sdl2'])
    expect(onscripterBinaryPath(dataDir)).toBe(path.join(nscripterDepsDir(dataDir), 'onscripter-sdl2'))
  })

  test('只有旧版 → 仍返回它（让它跑，总比报「没装」好；mac 上会画不出但那是它们的事）', () => {
    const dataDir = makeDataDir(['onscripter'])
    expect(onscripterBinaryPath(dataDir)).toBe(path.join(nscripterDepsDir(dataDir), 'onscripter'))
  })

  test('多一层目录布局也能找到', () => {
    const dataDir = makeDataDir([path.join('some-wrapper', 'onscripter-sdl2')])
    const found = onscripterBinaryPath(dataDir)
    expect(found).not.toBeNull()
    expect(found).toContain('onscripter-sdl2')
  })

  test('都没有 → null（不猜、不造路径）', () => {
    expect(onscripterBinaryPath(makeDataDir())).toBeNull()
  })

  test('期望路径指向 sdl2 版（错误文案要给出正确的文件名）', () => {
    expect(onscripterExpectedPath('/data')).toContain('onscripter-sdl2')
  })
})

describe('nscripterSaveDir：存档位置由我们决定', () => {
  test('用游戏标题命名', () => {
    expect(nscripterSaveDir(makeCtx())).toBe(path.join('/data', 'saves', 'nscripter', 'Demo Game'))
  })

  test('标题为空 → 退回目录名（不能拼出指向存档根本身的路径）', () => {
    const dir = nscripterSaveDir(makeCtx({ gameTitle: '', folder: '/games/MyGame' }))
    expect(dir).toBe(path.join('/data', 'saves', 'nscripter', 'MyGame'))
  })

  test('标题含斜杠 → 不许用它当目录名（会逃出我们的命名空间）', () => {
    const dir = nscripterSaveDir(makeCtx({ gameTitle: '../evil', folder: '/games/MyGame' }))
    // 必须退回目录名，且结果仍在我们的 saves 下
    expect(dir.startsWith(path.join('/data', 'saves', 'nscripter'))).toBe(true)
    expect(dir).toBe(path.join('/data', 'saves', 'nscripter', 'MyGame'))
  })

  test('标题含反斜杠 → 同样退回目录名', () => {
    const dir = nscripterSaveDir(makeCtx({ gameTitle: 'a\\b', folder: '/games/X' }))
    expect(dir).toBe(path.join('/data', 'saves', 'nscripter', 'X'))
  })
})

describe('nscripterPlan：参数顺序与必需项', () => {
  test('--save= 一定在（否则存档落进随机目录）', () => {
    const plan = nscripterPlan(makeCtx())
    expect(plan.args.some((a) => a.startsWith('--save='))).toBe(true)
  })

  test('--root= 指向游戏目录（不依赖 cwd）', () => {
    const plan = nscripterPlan(makeCtx())
    expect(plan.args).toContain('--root=/games/demo')
  })

  test('engine 标成 nscripter', () => {
    expect(nscripterPlan(makeCtx()).engine).toBe('nscripter')
  })

  test('字体文件不存在时**不传 --font**（传不存在的路径会让它启动即失败）', () => {
    const dataDir = makeDataDir() // 没有字体
    const plan = nscripterPlan(makeCtx({ dataDir }))
    expect(plan.args.some((a) => a.startsWith('--font='))).toBe(false)
  })

  test('字体文件存在时才传 --font', () => {
    const dataDir = makeDataDir(['default.ttf'])
    const plan = nscripterPlan(makeCtx({ dataDir }))
    expect(plan.args).toContain(`--font=${bundledFontPath(dataDir)}`)
  })

  test('全屏开关只在 true 时加', () => {
    expect(nscripterPlan(makeCtx({ gameArgs: {} })).args).not.toContain('--fullscreen')
    expect(nscripterPlan(makeCtx({ gameArgs: { fullscreen: true } })).args).toContain('--fullscreen')
  })

  test('找不到二进制时仍然返回 plan（binary 指向期望路径）', () => {
    const dataDir = makeDataDir()
    expect(nscripterPlan(makeCtx({ dataDir })).binary).toBe(onscripterExpectedPath(dataDir))
  })
})

describe('prepare：建存档目录，且**绝不碰游戏目录**', () => {
  test('prepare 会建出存档目录（否则 --save 指向不存在的路径）', () => {
    const dataDir = makeDataDir()
    const plan = nscripterPlan(makeCtx({ dataDir }))
    expect(fs.existsSync(nscripterSaveDir(makeCtx({ dataDir })))).toBe(false)
    plan.prepare!()
    expect(fs.existsSync(nscripterSaveDir(makeCtx({ dataDir })))).toBe(true)
  })

  test('⚠️ prepare **不往游戏目录写任何东西**（D53）', () => {
    const dataDir = makeDataDir()
    const gameDir = makeGameDir(['nscript.dat', 'arc.nsa'])
    const before = fs.readdirSync(gameDir).sort()

    const plan = nscripterPlan(makeCtx({ dataDir, folder: gameDir }))
    plan.prepare!()

    const after = fs.readdirSync(gameDir).sort()
    // 目录内容一字不差 —— 这条是 D53 的硬约束
    expect(after).toEqual(before)
  })

  test('prepare 幂等（重复调用不抛）', () => {
    const dataDir = makeDataDir()
    const plan = nscripterPlan(makeCtx({ dataDir }))
    expect(() => {
      plan.prepare!()
      plan.prepare!()
    }).not.toThrow()
  })
})

describe('hasNscripterEntry：任一入口都认', () => {
  test('只有 nscript.dat → true', () => {
    expect(hasNscripterEntry(makeGameDir(['nscript.dat']))).toBe(true)
  })

  test('只有 arc.nsa → true', () => {
    expect(hasNscripterEntry(makeGameDir(['arc.nsa']))).toBe(true)
  })

  test('散装版的 0.txt → true', () => {
    expect(hasNscripterEntry(makeGameDir(['0.txt']))).toBe(true)
  })

  test('三个都没有 → false', () => {
    expect(hasNscripterEntry(makeGameDir(['readme.txt']))).toBe(false)
  })

  test('目录不存在 → false（不抛）', () => {
    expect(hasNscripterEntry('/no/such/dir')).toBe(false)
  })
})

describe('nscripterMissingEntryMessage', () => {
  test('包含路径', () => {
    expect(nscripterMissingEntryMessage('/games/demo')).toContain('/games/demo')
  })

  test('提示「可能选到了子目录」', () => {
    expect(nscripterMissingEntryMessage('/games/demo')).toContain('子目录')
  })
})
