// M6.5：Siglus（siglus_rs）启动方案的单测。
//
// 守三件事：
//   ① 一个引擎覆盖四种格式（Siglus / UK2 / AVG32 / RealLive）—— 入口判据必须宽，
//      要求「全部标志都在」会一个都认不出来
//   ② 二进制布局能兼容官方三种产物（裸二进制 / app bundle / 多一层目录）
//   ③ prepare 只建**我们自己的**私有目录，绝不碰游戏目录（D53）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { siglusBinaryPath, siglusDepsDir, siglusExpectedPath } from '../src/main/launchers/binary-paths'
import {
  hasSiglusEntry,
  siglusKeyHint,
  siglusMissingEntryMessage,
  siglusPlan,
  siglusWorkDir
} from '../src/main/launchers/siglus'
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
    gamePath: '/games/demo/Scene.pck',
    gameArgs: {},
    gameTitle: 'Demo Game',
    dataDir: '/data',
    platform: 'darwin',
    arch: 'arm64',
    ...overrides
  }
}

function makeDataDir(files: string[] = []): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-siglus-'))
  created.push(dataDir)
  for (const rel of files) {
    const target = path.join(siglusDepsDir(dataDir), rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, '')
  }
  return dataDir
}

function makeGameDir(entries: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-game-'))
  created.push(dir)
  for (const name of entries) fs.writeFileSync(path.join(dir, name), '')
  return dir
}

describe('siglusBinaryPath：三种官方产物布局都认', () => {
  test('裸二进制（deps/siglus_rs/siglus_engine）', () => {
    const dataDir = makeDataDir(['siglus_engine'])
    expect(siglusBinaryPath(dataDir)).toBe(path.join(siglusDepsDir(dataDir), 'siglus_engine'))
  })

  test('app bundle（siglus_engine.app/Contents/MacOS/siglus_engine）', () => {
    const dataDir = makeDataDir([path.join('siglus_engine.app', 'Contents', 'MacOS', 'siglus_engine')])
    expect(siglusBinaryPath(dataDir)).toBe(siglusExpectedPath(dataDir))
  })

  test('多一层目录（DMG 展开后常见）', () => {
    const dataDir = makeDataDir([path.join('wrapper', 'siglus_engine')])
    const found = siglusBinaryPath(dataDir)
    expect(found).not.toBeNull()
    expect(found).toContain('siglus_engine')
  })

  test('都没有 → null（不猜、不造路径）', () => {
    expect(siglusBinaryPath(makeDataDir())).toBeNull()
  })

  test('app bundle 优先于裸二进制', () => {
    const dataDir = makeDataDir([
      path.join('siglus_engine.app', 'Contents', 'MacOS', 'siglus_engine'),
      'siglus_engine'
    ])
    expect(siglusBinaryPath(dataDir)).toBe(siglusExpectedPath(dataDir))
  })
})

describe('hasSiglusEntry：四种格式任一入口都认', () => {
  // ⚠️ 要求「全部在」会一个都认不出来 —— 四种格式的标志完全不同
  test('SiglusEngine：Scene.pck → true', () => {
    expect(hasSiglusEntry(makeGameDir(['Scene.pck']))).toBe(true)
  })

  test('SiglusEngine：Gameexe.dat → true', () => {
    expect(hasSiglusEntry(makeGameDir(['Gameexe.dat']))).toBe(true)
  })

  test('RealLive：Seen.txt → true（这种交给同一个运行时）', () => {
    expect(hasSiglusEntry(makeGameDir(['Seen.txt']))).toBe(true)
  })

  test('AVG32：Gameexe.ini → true', () => {
    expect(hasSiglusEntry(makeGameDir(['Gameexe.ini']))).toBe(true)
  })

  test('都没有 → false', () => {
    expect(hasSiglusEntry(makeGameDir(['readme.txt']))).toBe(false)
  })

  test('目录不存在 → false（不抛）', () => {
    expect(hasSiglusEntry('/no/such/dir')).toBe(false)
  })
})

describe('siglusPlan', () => {
  test('用官方 README 的 --project-dir <游戏目录>', () => {
    expect(siglusPlan(makeCtx()).args).toEqual(['--project-dir', '/games/demo'])
  })

  test('engine 标成 siglus', () => {
    expect(siglusPlan(makeCtx()).engine).toBe('siglus')
  })

  test('cwd 是游戏目录', () => {
    expect(siglusPlan(makeCtx()).cwd).toBe('/games/demo')
  })

  test('找不到二进制时仍然返回 plan', () => {
    const dataDir = makeDataDir()
    expect(siglusPlan(makeCtx({ dataDir })).binary).toBe(siglusExpectedPath(dataDir))
  })
})

describe('prepare：只建私有工作目录，不碰游戏目录', () => {
  test('prepare 会建出工作目录（引擎爆破密钥时要写东西）', () => {
    const dataDir = makeDataDir()
    const plan = siglusPlan(makeCtx({ dataDir }))
    expect(fs.existsSync(siglusWorkDir(makeCtx({ dataDir })))).toBe(false)
    plan.prepare!()
    expect(fs.existsSync(siglusWorkDir(makeCtx({ dataDir })))).toBe(true)
  })

  test('⚠️ prepare **不往游戏目录写任何东西**（D53）', () => {
    const dataDir = makeDataDir()
    const gameDir = makeGameDir(['Scene.pck', 'Gameexe.dat'])
    const before = fs.readdirSync(gameDir).sort()

    const plan = siglusPlan(makeCtx({ dataDir, folder: gameDir }))
    plan.prepare!()

    expect(fs.readdirSync(gameDir).sort()).toEqual(before)
  })

  test('工作目录在 modules 下（不是游戏目录旁）', () => {
    const dir = siglusWorkDir(makeCtx())
    expect(dir.startsWith(path.join('/data', 'modules', 'siglus'))).toBe(true)
  })

  test('标题含斜杠时退回目录名（不许逃出命名空间）', () => {
    const dir = siglusWorkDir(makeCtx({ gameTitle: '../evil', folder: '/games/MyGame' }))
    expect(dir).toBe(path.join(siglusDepsDir('/data'), 'work', 'MyGame'))
  })
})

describe('错误文案', () => {
  test('缺入口的说明列出四个标志文件（用户才知道我们在找什么）', () => {
    const msg = siglusMissingEntryMessage('/games/demo')
    expect(msg).toContain('Scene.pck')
    expect(msg).toContain('Seen.txt')
    expect(msg).toContain('/games/demo')
  })

  test('密钥提示说清「重装引擎没用」（否则用户会白折腾）', () => {
    expect(siglusKeyHint()).toContain('重装引擎')
  })
})
