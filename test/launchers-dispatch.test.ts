// M4.0 S4 单测：引擎分发（buildLaunchPlan）。
//
// 这一层要钉死的是**路由**，不是各引擎的细节（那些在 launchers-*.test.ts 里）。
//
// 关键：不认识的引擎必须返回 null，而且**不能**退回任何别的引擎
// （D57：未知引擎不回退）。这条如果写错，用户装了 ruffle/wine/macos 后点启动
// 会被静默地用某个别的引擎拉起来 —— 那比报「不支持」危险得多。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  LAUNCHABLE_ENGINES,
  buildLaunchPlan,
  isLaunchable
} from '../src/main/launchers'
import { nwjsBinaryPath, easyrpgBinaryPath, mkxpzBinaryPath } from '../src/main/launchers/binary-paths'
import type { LaunchContext } from '../src/main/launchers/types'

const created: string[] = []
function tempDir(prefix = 'tsmg-s4-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  created.push(dir)
  return dir
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

function makeCtx(overrides: Partial<LaunchContext> = {}): LaunchContext {
  const dataDir = tempDir('tsmg-s4-data-')
  const folder = path.join(tempDir('tsmg-s4-game-'), 'Game')
  fs.mkdirSync(folder, { recursive: true })
  return {
    folder,
    gamePath: folder,
    gameArgs: {},
    gameTitle: '测试游戏',
    dataDir,
    platform: 'darwin',
    arch: 'arm64',
    ...overrides
  }
}

describe('S4：四个支持的引擎被正确路由', () => {
  test('nwjs → nwjsPlan（args 只有一个游戏目录）', () => {
    const ctx = makeCtx({ gameArgs: { version: 'v0.106.1' } })
    const plan = buildLaunchPlan('nwjs', ctx)
    expect(plan).not.toBeNull()
    expect(plan!.engine).toBe('nwjs')
    expect(plan!.binary).toBe(nwjsBinaryPath(ctx.dataDir, 'v0.106.1', 'arm64'))
    expect(plan!.args).toEqual([ctx.folder])
    expect(plan!.prepare).toBeUndefined()
  })

  test('mkxpz → mkxpzPlan（空参数 + 有 prepare）', () => {
    const ctx = makeCtx({ gameArgs: { rgssVersion: '3' } })
    const plan = buildLaunchPlan('mkxpz', ctx)
    expect(plan!.engine).toBe('mkxpz')
    expect(plan!.binary).toBe(mkxpzBinaryPath(ctx.dataDir))
    expect(plan!.args).toEqual([])
    expect(typeof plan!.prepare).toBe('function')
  })

  test('easyrpg → easyrpgPlan（固定尾部 --window --project-path）', () => {
    const ctx = makeCtx()
    const plan = buildLaunchPlan('easyrpg', ctx)
    expect(plan!.engine).toBe('easyrpg')
    expect(plan!.binary).toBe(easyrpgBinaryPath(ctx.dataDir))
    expect(plan!.args.slice(-3)).toEqual(['--window', '--project-path', ctx.folder])
  })

  test('renpy → renpyPlan（--savedir 开头）', () => {
    const ctx = makeCtx()
    const plan = buildLaunchPlan('renpy', ctx)
    expect(plan!.engine).toBe('renpy')
    expect(plan!.args[0]).toBe('--savedir')
  })

  test('同一个 ctx 分发给不同引擎，各自拿到自己的 binary（不会串）', () => {
    const ctx = makeCtx({ gameArgs: { version: 'v0.106.1' } })
    const binaries = LAUNCHABLE_ENGINES.map((engine) => buildLaunchPlan(engine, ctx)?.binary)
    // 四个引擎的 binary 互不相同
    expect(new Set(binaries).size).toBe(4)
  })
})

describe('S4：未知引擎返回 null（D57：绝不回退到任何别的引擎）', () => {
  test('上游仓库里我们不做的三个模块 → null', () => {
    for (const engine of ['ruffle', 'wine', 'macos']) {
      const ctx = makeCtx()
      expect(buildLaunchPlan(engine, ctx)).toBeNull()
      expect(isLaunchable(engine)).toBe(false)
    }
  })

  test('空串 / 随机字符串 / 大小写不像的 → null', () => {
    for (const engine of ['', 'unknown', 'nw', 'nwjs2', 'mkxp', 'rpgmaker']) {
      expect(buildLaunchPlan(engine, makeCtx())).toBeNull()
    }
  })

  test('非字符串（手改坏的 games.json 里可能有数字/null/对象）→ null，不抛', () => {
    const ctx = makeCtx()
    expect(() => buildLaunchPlan(null, ctx)).not.toThrow()
    expect(buildLaunchPlan(null, ctx)).toBeNull()
    expect(buildLaunchPlan(undefined, ctx)).toBeNull()
    expect(buildLaunchPlan(42, ctx)).toBeNull()
    expect(buildLaunchPlan({ engine: 'nwjs' }, ctx)).toBeNull()
  })

  test('★ 关键：未知引擎**不会**回落到任何一个已知引擎', () => {
    const ctx = makeCtx({ gameArgs: { version: 'v0.106.1' } })
    // 如果实现里写了「找不到就用 nwjs 兜底」，这条会拿到一个 plan
    for (const engine of ['ruffle', 'wine', 'macos', 'unknown']) {
      expect(buildLaunchPlan(engine, ctx)).toBeNull()
    }
  })
})

describe('S4：引擎名的归一化（脏值不该被误判成未知）', () => {
  test('首尾空格被 trim', () => {
    expect(buildLaunchPlan('  nwjs  ', makeCtx({ gameArgs: { version: 'v1' } }))).not.toBeNull()
  })

  test('大小写不敏感', () => {
    expect(buildLaunchPlan('NWJS', makeCtx())).not.toBeNull()
    expect(buildLaunchPlan('MkxpZ', makeCtx())).not.toBeNull()
    expect(buildLaunchPlan('EASYRPG', makeCtx())).not.toBeNull()
  })
})

describe('S4：LAUNCHABLE_ENGINES 是唯一名单', () => {
  test('正好四个，顺序与我们声明的一致', () => {
    expect([...LAUNCHABLE_ENGINES]).toEqual(['nwjs', 'mkxpz', 'easyrpg', 'renpy'])
  })

  test('名单里的每一个都真的能分发（没有「声明支持但没实现」）', () => {
    for (const engine of LAUNCHABLE_ENGINES) {
      expect(isLaunchable(engine)).toBe(true)
      expect(buildLaunchPlan(engine, makeCtx())).not.toBeNull()
    }
  })

  test('名单成员互不相同（防止手滑写重复）', () => {
    expect(new Set(LAUNCHABLE_ENGINES).size).toBe(LAUNCHABLE_ENGINES.length)
  })
})
