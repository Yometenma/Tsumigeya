// M6.5：Godot 启动方案的单测。
//
// 守四件事：
//   ① `--main-pack` **一律传绝对路径**（相对路径在别的引擎上出过「找不到文件」的怪问题）
//   ② 多个 .pck 时**不猜**（Godot 的补丁机制会让目录里有多个 pck，选错 = 内容不对）
//   ③ 没有独立 pck 时**不乱传参数**（内嵌形态我们没实现，猜错比如实报错更糟）
//   ④ 二进制路径两种布局都能解析
//
// ⚠️ 这个引擎有一条**已知限制**：存档位置改不了（官方明确导出工程不支持
// self-contained mode，而默认位置依赖要从 pck 里读的 project_name）。
// 所以本测试**不测存档** —— 没实现的东西不写测试假装实现。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { godotBinaryPath, godotDepsDir, godotExpectedPath } from '../src/main/launchers/binary-paths'
import {
  findMainPck,
  godotEmbeddedUnsupportedMessage,
  godotManagedCodeHint,
  godotPlan,
  hasGodotPck
} from '../src/main/launchers/godot'
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
    gamePath: '/games/demo/game.pck',
    gameArgs: {},
    gameTitle: 'Demo',
    dataDir: '/data',
    platform: 'darwin',
    arch: 'arm64',
    ...overrides
  }
}

/** 造临时 dataDir；`binRelative` 非空时在 deps/godot/<该路径> 放假二进制。 */
function makeDataDir(binRelative?: string): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-godot-'))
  created.push(dataDir)
  if (binRelative) {
    const target = path.join(godotDepsDir(dataDir), binRelative)
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

describe('godotBinaryPath：两种布局都认', () => {
  test('官方 zip 解压后的布局（Godot.app/Contents/MacOS/Godot）', () => {
    const dataDir = makeDataDir(path.join('Godot.app', 'Contents', 'MacOS', 'Godot'))
    expect(godotBinaryPath(dataDir)).toBe(godotExpectedPath(dataDir))
  })

  test('多一层包裹目录也能找到', () => {
    const dataDir = makeDataDir(path.join('wrapper', 'Godot.app', 'Contents', 'MacOS', 'Godot'))
    const found = godotBinaryPath(dataDir)
    expect(found).not.toBeNull()
    expect(found).toContain('Godot')
  })

  test('都没有 → null（不猜、不造路径）', () => {
    expect(godotBinaryPath(makeDataDir())).toBeNull()
  })
})

describe('findMainPck：多个 pck 时**不猜**', () => {
  test('只有一个 pck → 返回它', () => {
    const dir = makeGameDir(['game.pck'])
    expect(findMainPck(dir)).toBe(path.join(dir, 'game.pck'))
  })

  test('⚠️ 有多个 pck → 返回 null（选错的表现是「能启动但内容不对」）', () => {
    // Godot 的补丁机制（Patch PCK）会让目录里有主包 + 补丁。
    // 猜错比报错更糟：游戏能起来，但资源不对，用户完全想不到原因。
    const dir = makeGameDir(['game.pck', 'patch1.pck'])
    expect(findMainPck(dir)).toBeNull()
  })

  test('扩展名大小写不敏感（.PCK 也算）', () => {
    const dir = makeGameDir(['GAME.PCK'])
    expect(findMainPck(dir)).toBe(path.join(dir, 'GAME.PCK'))
  })

  test('没有 pck → null', () => {
    expect(findMainPck(makeGameDir(['readme.txt']))).toBeNull()
  })

  test('目录不存在 → null（不抛）', () => {
    expect(findMainPck('/no/such/dir')).toBeNull()
  })
})

describe('hasGodotPck', () => {
  test('有 pck → true', () => {
    expect(hasGodotPck(makeGameDir(['game.pck']))).toBe(true)
  })

  test('没 pck → false', () => {
    expect(hasGodotPck(makeGameDir(['game.exe']))).toBe(false)
  })
})

describe('godotPlan：参数构造', () => {
  test('有唯一 pck 时传 --main-pack + **绝对路径**', () => {
    const dir = makeGameDir(['game.pck'])
    const plan = godotPlan(makeCtx({ folder: dir }))
    expect(plan.args).toEqual(['--main-pack', path.join(dir, 'game.pck')])
  })

  test('⚠️ pck 路径必须是绝对路径（相对路径在某些引擎上出过找不到文件的怪问题）', () => {
    const dir = makeGameDir(['game.pck'])
    const plan = godotPlan(makeCtx({ folder: dir }))
    const pckArg = plan.args[1]!
    expect(path.isAbsolute(pckArg), `pck 参数应为绝对路径，实际是 ${pckArg}`).toBe(true)
  })

  test('多个 pck 时**不传 --main-pack**（不猜）', () => {
    const dir = makeGameDir(['game.pck', 'patch.pck'])
    const plan = godotPlan(makeCtx({ folder: dir }))
    expect(plan.args).not.toContain('--main-pack')
  })

  test('没有 pck 时也不传 --main-pack（内嵌形态没实现，不猜）', () => {
    const dir = makeGameDir(['Game.exe'])
    const plan = godotPlan(makeCtx({ folder: dir }))
    expect(plan.args).toEqual([])
  })

  test('全屏开关按需附加', () => {
    const dir = makeGameDir(['game.pck'])
    const plan = godotPlan(makeCtx({ folder: dir, gameArgs: { fullscreen: true } }))
    expect(plan.args).toContain('--fullscreen')
  })

  test('engine 标成 godot', () => {
    expect(godotPlan(makeCtx()).engine).toBe('godot')
  })

  test('cwd 是游戏目录', () => {
    const dir = makeGameDir(['game.pck'])
    expect(godotPlan(makeCtx({ folder: dir })).cwd).toBe(dir)
  })

  test('找不到二进制时仍然返回 plan', () => {
    const dataDir = makeDataDir()
    expect(godotPlan(makeCtx({ dataDir })).binary).toBe(godotExpectedPath(dataDir))
  })
})

describe('错误文案', () => {
  test('缺 pck 的说明指出「内嵌形态不支持」且说明是已知限制', () => {
    const msg = godotEmbeddedUnsupportedMessage('/games/demo')
    expect(msg).toContain('/games/demo')
    expect(msg).toContain('已知限制')
  })

  test('C#/GDExtension 的提示说清「重装引擎没改善」（否则用户白折腾）', () => {
    const msg = godotManagedCodeHint()
    expect(msg).toContain('重装引擎')
    expect(msg).toContain('GDExtension')
  })
})
