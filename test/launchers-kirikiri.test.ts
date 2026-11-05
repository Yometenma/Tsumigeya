// M6 S3：吉里吉里启动方案的单测。
//
// 守三件事：
//   ① 两种 deps 布局（app bundle / 裸二进制）都能解析出可执行文件
//   ② 找不到时**不瞎猜**：返回「本该在那」的期望路径（让错误文案能带上它）
//   ③ `hasKirikiriEntry` 把「打包版」与「散文件版」都认作入口
//      （要求两个都在会把一半的游戏判成不能跑）
//
// ⚠️ 这个引擎是**实验性**的：运行时 krkrsdl2 的作者声明不承诺商用游戏兼容。
// 那是上游的立场声明，不是技术闸门 —— 所以这里不做任何「检测并拒绝」的逻辑，
// 只测启动方案本身的正确性。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { kirikiriDepsDir, krkrsdl2BinaryPath, krkrsdl2ExpectedPath } from '../src/main/launchers/binary-paths'
import { hasKirikiriEntry, kirikiriMissingEntryMessage, kirikiriPlan } from '../src/main/launchers/kirikiri'
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
    gamePath: '/games/demo/Game.exe',
    gameArgs: {},
    gameTitle: 'Demo',
    dataDir: '/data',
    platform: 'darwin',
    arch: 'arm64',
    ...overrides
  }
}

/** 造一个临时 dataDir；`relative` 非空时在 `deps/krkrsdl2/<relative>` 放一个假二进制。 */
function makeDataDir(relative?: string): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-krkr-'))
  created.push(dataDir)
  if (relative) {
    const target = path.join(kirikiriDepsDir(dataDir), relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, '')
  }
  return dataDir
}

/** 造一个临时游戏目录，塞入给定文件名。 */
function makeGameDir(entries: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-game-'))
  created.push(dir)
  for (const name of entries) fs.writeFileSync(path.join(dir, name), '')
  return dir
}

describe('krkrsdl2BinaryPath：两种布局都认', () => {
  test('app bundle 布局（krkrsdl2.app/Contents/MacOS/krkrsdl2）', () => {
    const dataDir = makeDataDir(path.join('krkrsdl2.app', 'Contents', 'MacOS', 'krkrsdl2'))
    const found = krkrsdl2BinaryPath(dataDir)
    expect(found).not.toBeNull()
    expect(found).toBe(krkrsdl2ExpectedPath(dataDir))
  })

  test('裸二进制布局（deps/krkrsdl2/krkrsdl2）', () => {
    const dataDir = makeDataDir('krkrsdl2')
    expect(krkrsdl2BinaryPath(dataDir)).toBe(path.join(kirikiriDepsDir(dataDir), 'krkrsdl2'))
  })

  test('两种都没有 → null（不猜、不造路径）', () => {
    // 这是「装了没有」的唯一判据：目录在不在不是判据，二进制在不在才是
    expect(krkrsdl2BinaryPath(makeDataDir())).toBeNull()
  })

  test('app bundle 优先于裸二进制（它是更完整的形态）', () => {
    const dataDir = makeDataDir(path.join('krkrsdl2.app', 'Contents', 'MacOS', 'krkrsdl2'))
    fs.writeFileSync(path.join(kirikiriDepsDir(dataDir), 'krkrsdl2'), '')
    expect(krkrsdl2BinaryPath(dataDir)).toBe(krkrsdl2ExpectedPath(dataDir))
  })
})

describe('kirikiriPlan', () => {
  test('args 是游戏目录（官方用法就是 `krkrsdl2 <启动目录>`）', () => {
    expect(kirikiriPlan(makeCtx()).args).toEqual(['/games/demo'])
  })

  test('engine 标成 kirikiri', () => {
    expect(kirikiriPlan(makeCtx()).engine).toBe('kirikiri')
  })

  test('cwd 是游戏目录（子脚本按 cwd 找相对路径）', () => {
    expect(kirikiriPlan(makeCtx()).cwd).toBe('/games/demo')
  })

  test('找不到二进制时**仍然返回 plan**，binary 指向期望路径', () => {
    // 与 renpyPlan 同一取向：这样 ipc 层能报出「本该在哪」，比一句 not installed 有用
    const dataDir = makeDataDir()
    expect(kirikiriPlan(makeCtx({ dataDir })).binary).toBe(krkrsdl2ExpectedPath(dataDir))
  })

  test('找得到二进制时用真实路径', () => {
    const dataDir = makeDataDir(path.join('krkrsdl2.app', 'Contents', 'MacOS', 'krkrsdl2'))
    const plan = kirikiriPlan(makeCtx({ dataDir }))
    expect(plan.binary).toBe(krkrsdl2BinaryPath(dataDir))
  })
})

describe('hasKirikiriEntry：两种分发布局都认作入口', () => {
  test('打包版只有 data.xp3 → true', () => {
    expect(hasKirikiriEntry(makeGameDir(['data.xp3']))).toBe(true)
  })

  test('散文件版只有 startup.tjs → true', () => {
    // ⚠️ 要求「两个都在」会把一半的游戏判成不能跑
    expect(hasKirikiriEntry(makeGameDir(['startup.tjs']))).toBe(true)
  })

  test('两个都在 → true', () => {
    expect(hasKirikiriEntry(makeGameDir(['data.xp3', 'startup.tjs']))).toBe(true)
  })

  test('两个都没有 → false', () => {
    expect(hasKirikiriEntry(makeGameDir(['readme.txt']))).toBe(false)
  })

  test('目录不存在 → false（不抛）', () => {
    expect(hasKirikiriEntry('/no/such/dir')).toBe(false)
  })
})

describe('kirikiriMissingEntryMessage：说清「选错了目录」', () => {
  test('包含路径', () => {
    expect(kirikiriMissingEntryMessage('/games/demo')).toContain('/games/demo')
  })

  test('提示「可能选到了子目录」（这是最常见的原因）', () => {
    expect(kirikiriMissingEntryMessage('/games/demo')).toContain('子目录')
  })
})
