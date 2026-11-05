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
import {
  canLaunchAsNwDirectory,
  resolveNwRoot,
  tyranoMissingManifestMessage,
  tyranoPlan
} from '../src/main/launchers/tyrano'
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

// ===== M6.5：Tyrano v5（Electron）形态 =====
//
// v5 的网页根不在游戏目录，而在 `resources/app/` 里：
//   <游戏目录>/resources/app/{index.html,main.js,tyrano/,data/}
//
// 直接把游戏目录喂给 `nw` 会找不到入口 → 启动失败，而游戏本身完全正常。
// 这一组测 `resolveNwRoot` 能正确往下探一层。
//
// 同时测**不支持的两种形态**（单文件 exe、只有 asar）——
// 它们必须**明确失败**，而不是悄悄当成 v4 去启动一个空目录。
describe('M6.5 resolveNwRoot：v5 的 resources/app/ 布局', () => {
  test('v4：根上有 package.json → 就用根', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-tyrano-'))
    created.push(dir)
    fs.writeFileSync(path.join(dir, 'package.json'), '{}')
    expect(resolveNwRoot(dir)).toBe(dir)
  })

  test('v5 unpacked：resources/app 下有 package.json → 用它', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-tyrano-'))
    created.push(dir)
    const app = path.join(dir, 'resources', 'app')
    fs.mkdirSync(app, { recursive: true })
    fs.writeFileSync(path.join(app, 'package.json'), '{}')
    expect(resolveNwRoot(dir)).toBe(app)
  })

  test('v5 unpacked：resources/app 下只有 index.html（无 package.json）→ 仍用 app 目录', () => {
    // v5 的入口常在 asar 内的 package.json 或主进程里，目录里可能没有 package.json。
    // 有 index.html 就够了 —— nw 对缺 main 的 package 会退回 index.html。
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-tyrano-'))
    created.push(dir)
    const app = path.join(dir, 'resources', 'app')
    fs.mkdirSync(app, { recursive: true })
    fs.writeFileSync(path.join(app, 'index.html'), '')
    expect(resolveNwRoot(dir)).toBe(app)
  })

  test('根上有 package.json 时**优先用根**（不去看 resources/app）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-tyrano-'))
    created.push(dir)
    fs.writeFileSync(path.join(dir, 'package.json'), '{}')
    const app = path.join(dir, 'resources', 'app')
    fs.mkdirSync(app, { recursive: true })
    fs.writeFileSync(path.join(app, 'package.json'), '{}')
    expect(resolveNwRoot(dir)).toBe(dir)
  })

  test('⚠️ 只有 resources/app.asar → null（NW.js 不支持 asar，明确失败）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-tyrano-'))
    created.push(dir)
    const app = path.join(dir, 'resources')
    fs.mkdirSync(app, { recursive: true })
    fs.writeFileSync(path.join(app, 'app.asar'), '')
    expect(resolveNwRoot(dir)).toBeNull()
  })

  test('⚠️ 单文件 exe（目录里只有 exe）→ null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-tyrano-'))
    created.push(dir)
    fs.writeFileSync(path.join(dir, 'game.exe'), '')
    expect(resolveNwRoot(dir)).toBeNull()
  })

  test('空目录 → null（不抛）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-tyrano-'))
    created.push(dir)
    expect(resolveNwRoot(dir)).toBeNull()
  })
})

describe('M6.5 tyranoPlan 用解析出的目录而不是游戏目录', () => {
  test('v5 形态下 args[0] 是 resources/app，不是游戏根', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-tyrano-'))
    created.push(dir)
    const app = path.join(dir, 'resources', 'app')
    fs.mkdirSync(app, { recursive: true })
    fs.writeFileSync(path.join(app, 'package.json'), '{}')

    const plan = tyranoPlan(makeCtx({ folder: dir }))
    expect(plan.args[0]).toBe(app)
  })

  test('v4 形态下 args[0] 就是游戏根', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-tyrano-'))
    created.push(dir)
    fs.writeFileSync(path.join(dir, 'package.json'), '{}')

    const plan = tyranoPlan(makeCtx({ folder: dir }))
    expect(plan.args[0]).toBe(dir)
  })

  test('解析不出来时退回游戏目录本身（让 NW.js 报它自己的错，比我们猜路径准）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-tyrano-'))
    created.push(dir)
    fs.writeFileSync(path.join(dir, 'game.exe'), '')

    const plan = tyranoPlan(makeCtx({ folder: dir }))
    expect(plan.args[0]).toBe(dir)
  })

  test('cwd 仍然是游戏目录（不是 resources/app）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-tyrano-'))
    created.push(dir)
    const app = path.join(dir, 'resources', 'app')
    fs.mkdirSync(app, { recursive: true })
    fs.writeFileSync(path.join(app, 'package.json'), '{}')

    const plan = tyranoPlan(makeCtx({ folder: dir }))
    expect(plan.cwd).toBe(dir)
  })
})
