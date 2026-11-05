// M6 S2：TyranoScript 启动方案的单测。
//
// 守三件事：
//   ① 它**复用 NW.js 的 binary**（不下载第二份运行时）——这是它成本最低的原因
//   ② 参数顺序与 nwjsPlan 一致（Chromium 开关在游戏目录**之后**，mac 真机实测的结论）
//   ③ 「没有 package.json 的分发包」给出**可读失败**，而不是让 spawn 报 ENOENT
//      （那句 ENOENT 会让用户以为引擎没装，跑去重装一遍 —— 白折腾）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { nwjsBinaryPath } from '../src/main/launchers/binary-paths'
import { canLaunchAsNwDirectory, tyranoMissingManifestMessage, tyranoPlan } from '../src/main/launchers/tyrano'
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

describe('tyranoPlan：复用 NW.js 运行时', () => {
  test('binary 就是 nwjs 的二进制（不下载第二份运行时）', () => {
    const ctx = makeCtx({ gameArgs: { version: 'v0.106.1' } })
    const plan = tyranoPlan(ctx)
    // 同一个拼法、同一个版本 —— 若将来有人给 tyrano 造了独立二进制，这条会红
    expect(plan.binary).toBe(nwjsBinaryPath(ctx.dataDir, 'v0.106.1', 'arm64'))
  })

  test('engine 标成 tyrano（诊断与日志靠它区分「这是哪种游戏」）', () => {
    expect(tyranoPlan(makeCtx()).engine).toBe('tyrano')
  })

  test('args 只有游戏目录（默认不是全屏）', () => {
    expect(tyranoPlan(makeCtx()).args).toEqual(['/games/demo'])
  })

  test('全屏开关放在游戏目录**之后**（与 nwjsPlan 的实测结论一致）', () => {
    // 放前面会被 NW.js 当成它自己的参数 —— 这是 mac 真机测出来的，别改
    const plan = tyranoPlan(makeCtx({ gameArgs: { fullscreen: true } }))
    expect(plan.args).toEqual(['/games/demo', '--start-fullscreen'])
  })

  test('cwd 是游戏目录', () => {
    expect(tyranoPlan(makeCtx()).cwd).toBe('/games/demo')
  })

  test('版本为空时也不崩（binary 指向不存在的路径，由 ipc 层报可读错误）', () => {
    const plan = tyranoPlan(makeCtx({ gameArgs: {} }))
    expect(plan.binary).toContain('nwjs')
    expect(plan.args).toEqual(['/games/demo'])
  })
})

describe('canLaunchAsNwDirectory：能不能直接喂给 nw', () => {
  test('有 package.json → true', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-tyrano-'))
    created.push(dir)
    fs.writeFileSync(path.join(dir, 'package.json'), '{}')
    expect(canLaunchAsNwDirectory(dir)).toBe(true)
  })

  test('没有 package.json → false（不猜、不造 shim）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-tyrano-'))
    created.push(dir)
    fs.writeFileSync(path.join(dir, 'index.html'), '')
    expect(canLaunchAsNwDirectory(dir)).toBe(false)
  })

  test('目录不存在 → false（不抛）', () => {
    expect(canLaunchAsNwDirectory('/no/such/dir')).toBe(false)
  })
})

describe('tyranoMissingManifestMessage：把「为什么」说清楚', () => {
  test('包含期望路径（用户能自己去看）', () => {
    expect(tyranoMissingManifestMessage('/games/demo')).toContain('/games/demo')
  })

  test('明确说出「与引擎是否安装无关」（否则用户会去重装引擎）', () => {
    expect(tyranoMissingManifestMessage('/games/demo')).toContain('与引擎是否安装无关')
  })
})
