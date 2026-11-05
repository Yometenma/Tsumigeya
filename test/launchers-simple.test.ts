// M4.0 S2 单测：nwjs / easyrpg / renpy 三个引擎的启动方案。
//
// 钉死的是**参数数组的形状与内容**（D54 的核心：args 数组而非命令行字符串）：
//   · 含空格/中文的路径必须原样进 args（不转义、不加引号）
//   · easyrpg 的 kebab-case 转换、值的类型规则、互斥对、默认音源注入
//   · renpy 的 `--savedir <基目录>/<游戏名>` 与 command 追加位置
//   · nwjs **绝不**读写游戏目录里的任何文件（M4.0 最主要的收益）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { nwjsBinaryPath, easyrpgBinaryPath, easyrpgSoundfontPath } from '../src/main/launchers/binary-paths'
import { argsToFlags, easyrpgPlan, expandTilde as easyrpgTilde, toFlag } from '../src/main/launchers/easyrpg'
import { nwjsPlan } from '../src/main/launchers/nwjs'
import { defaultRenpySaveDir, renpyPlan, renpySaveDir, expandTilde as renpyTilde } from '../src/main/launchers/renpy'
import type { LaunchContext } from '../src/main/launchers/types'

const created: string[] = []
function tempDir(prefix = 'tsmg-s2-'): string {
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

/** 造一个假数据目录 + 假游戏目录，返回可直接用的 ctx。 */
function makeCtx(
  overrides: Partial<LaunchContext> & { engine?: 'nwjs' | 'easyrpg' | 'renpy'; folderName?: string } = {}
): LaunchContext {
  const dataDir = tempDir('tsmg-s2-data-')
  const folder = path.join(tempDir('tsmg-s2-game-'), overrides.folderName ?? 'Game')
  fs.mkdirSync(folder, { recursive: true })
  const ctx: LaunchContext = {
    folder,
    gamePath: folder,
    gameArgs: {},
    gameTitle: '测试游戏',
    dataDir,
    platform: 'darwin',
    arch: 'arm64',
    ...overrides
  }
  return ctx
}

// ===== nwjs =====

describe('S2：nwjs 启动方案', () => {
  test('binary 用 deps 下带 v 的真实目录名，args 只有一个游戏目录', () => {
    const ctx = makeCtx({ gameArgs: { version: 'v0.106.1' } })
    const plan = nwjsPlan(ctx)
    expect(plan.binary).toBe(nwjsBinaryPath(ctx.dataDir, 'v0.106.1', 'arm64'))
    expect(plan.args).toEqual([ctx.folder])
    expect(plan.engine).toBe('nwjs')
  })

  test('x64 机器上 arch 段跟着变（不是写死 arm64）', () => {
    const ctx = makeCtx({ gameArgs: { version: 'v0.106.1' }, arch: 'x64' })
    expect(nwjsPlan(ctx).binary).toContain('osx-x64')
  })

  // ===== 全屏（M5 S2）=====
  test('fullscreen=true → 追加 --start-fullscreen，且**在游戏目录之后**', () => {
    // ⚠️ 顺序是判据的一部分：`nw <path> [args]` —— Chromium 开关放到 path 之前
    // 会被 NW.js 当成自己的参数。这条测试钉住顺序。
    const ctx = makeCtx({ gameArgs: { version: 'v0.106.1', fullscreen: true } })
    expect(nwjsPlan(ctx).args).toEqual([ctx.folder, '--start-fullscreen'])
  })

  test('fullscreen=false / 未设 → 不多给任何参数（不产生空开关）', () => {
    const off = makeCtx({ gameArgs: { version: 'v0.106.1', fullscreen: false } })
    expect(nwjsPlan(off).args).toEqual([off.folder])

    const absent = makeCtx({ gameArgs: { version: 'v0.106.1' } })
    expect(nwjsPlan(absent).args).toEqual([absent.folder])
  })

  test('没设 version 时拼出的路径不含版本（由调用方的存在性检查报可读错误）', () => {
    const ctx = makeCtx({ gameArgs: {} })
    const plan = nwjsPlan(ctx)
    // 关键：**不兜底一个假的版本号**（上游兜底 "0.106.1" 正是「点启动没反应」的根因）
    expect(plan.binary).toBe(nwjsBinaryPath(ctx.dataDir, '', 'arm64'))
  })

  test('游戏目录含空格与中文时，args 里原样保留（不转义不加引号）', () => {
    const ctx = makeCtx({ folderName: '我的 游戏 A' })
    const plan = nwjsPlan(ctx)
    expect(plan.args).toEqual([ctx.folder])
    expect(plan.args[0]).not.toContain('"')
    expect(plan.args[0]).not.toContain('%20')
    expect(plan.args[0]).toContain('我的 游戏 A')
  })

  test('★ 绝不碰游戏目录里的任何文件（M4.0 的主要收益，D53）', () => {
    const ctx = makeCtx({ gameArgs: { version: 'v0.106.1' } })
    // 造出上游会改写的那几个文件，确认我们一个都不动
    const targets = [
      path.join(ctx.folder, 'package.json'),
      path.join(ctx.folder, 'js', 'main.js')
    ]
    fs.mkdirSync(path.join(ctx.folder, 'js'), { recursive: true })
    fs.writeFileSync(targets[0], JSON.stringify({ name: 'g', 'chromium-args': '--disable-devtools' }, null, 2))
    fs.writeFileSync(targets[1], 'ORIGINAL MAIN JS CONTENT')

    const plan = nwjsPlan(ctx)
    // 没有 prepare（没有任何前置写盘动作）
    expect(plan.prepare).toBeUndefined()
    // 执行完 plan（含 prepare，若存在）之后原文件逐字节不变
    void plan.prepare?.()
    expect(fs.readFileSync(targets[1], 'utf8')).toBe('ORIGINAL MAIN JS CONTENT')
    expect(fs.readFileSync(targets[0], 'utf8')).toContain('--disable-devtools')
  })
})

// ===== easyrpg =====

describe('S2：easyrpg 参数转换（kebab-case）', () => {
  test('驼峰与下划线都转成 kebab-case', () => {
    expect(toFlag('soundfontPath')).toBe('--soundfont-path')
    expect(toFlag('patchRpg2k3Cmds')).toBe('--patch-rpg2k3-cmds')
    expect(toFlag('showFps')).toBe('--show-fps')
    expect(toFlag('vsync')).toBe('--vsync')
    expect(toFlag('no_rtp')).toBe('--no-rtp')
  })

  test('boolean：true 只带 flag，false 完全不带', () => {
    expect(argsToFlags({ vsync: true, showFps: false })).toEqual(['--vsync'])
  })

  // ===== 全屏与缩放（M5 S1）=====
  test('fullscreen=true → --fullscreen；false → 不带（EasyRPG 默认就是窗口）', () => {
    expect(argsToFlags({ fullscreen: true })).toEqual(['--fullscreen'])
    expect(argsToFlags({ fullscreen: false })).toEqual([])
  })

  test('scaling 传值；空串不产生 `--scaling`（不会给个空模式）', () => {
    // 参数名与取值来自 EasyRPG 官方 man page（resources/unix/easyrpg-player.6.adoc）：
    //   --scaling MODE: nearest / integer / bilinear
    expect(argsToFlags({ scaling: 'integer' })).toEqual(['--scaling', 'integer'])
    expect(argsToFlags({ scaling: '' })).toEqual([])
    expect(argsToFlags({ scaling: '   ' })).toEqual([])
  })

  test('数字：非 0 带 flag+值，0 不带', () => {
    expect(argsToFlags({ musicVolume: 80, soundVolume: 0 })).toEqual(['--music-volume', '80'])
  })

  test('字符串：非空带 flag+值（前后空格被 trim），空串不带', () => {
    expect(argsToFlags({ encoding: ' 936 ', language: '   ' })).toEqual(['--encoding', '936'])
  })

  test('数组：每个元素重复一次 flag', () => {
    expect(argsToFlags({ solidFonts: ['A', 'B'] })).toEqual(['--solid-fonts', 'A', '--solid-fonts', 'B'])
  })

  test('null / undefined 跳过', () => {
    expect(argsToFlags({ engine: null, encoding: undefined, vsync: true })).toEqual(['--vsync'])
  })

  test('否定键为 true → 丢掉对应的肯定键（**不看肯定键的值类型**）', () => {
    // 规矩：否定优先。勾「不要 X」是比勾「要 X」更强的意图表达，
    // 而且两个 flag 同时在命令行里时取哪个取决于 EasyRPG 自己的解析顺序 —— 结果不确定。
    expect(argsToFlags({ vsync: true, noVsync: true })).toEqual(['--no-vsync'])
    expect(argsToFlags({ stretch: true, noStretch: true })).toEqual(['--no-stretch'])
    // 关键：数字型的肯定键也照样被丢掉（上游按 `=== true` 判断，会两个都输出）
    expect(argsToFlags({ fpsLimit: 60, noFpsLimit: true })).toEqual(['--no-fps-limit'])
    // 否定键是 false 时不丢肯定键
    expect(argsToFlags({ vsync: true, noVsync: false })).toEqual(['--vsync'])
    // 只有否定键、没有肯定键时照常输出
    expect(argsToFlags({ noVsync: true })).toEqual(['--no-vsync'])
  })

  test('不改调用方传进来的对象（互斥处理用的是克隆）', () => {
    const original = { vsync: true, noVsync: true }
    argsToFlags(original)
    expect(original).toEqual({ vsync: true, noVsync: true })
  })
})

describe('S2：easyrpg 启动方案', () => {
  test('binary 路径 + 固定尾部 --window --project-path <游戏目录>', () => {
    const ctx = makeCtx()
    const plan = easyrpgPlan(ctx)
    expect(plan.binary).toBe(easyrpgBinaryPath(ctx.dataDir))
    expect(plan.args.slice(-3)).toEqual(['--window', '--project-path', ctx.folder])
    expect(plan.engine).toBe('easyrpg')
  })

  test('gameArgs 的键值排在固定尾部之前', () => {
    const ctx = makeCtx({ gameArgs: { vsync: true, encoding: '936' } })
    const plan = easyrpgPlan(ctx)
    expect(plan.args.slice(0, 4)).toEqual(['--vsync', '--encoding', '936', '--window'])
  })

  test('模块自带音源存在且用户没指定 → 自动注入 --soundfont-path', () => {
    const ctx = makeCtx()
    const sf2 = easyrpgSoundfontPath(ctx.dataDir)
    fs.mkdirSync(path.dirname(sf2), { recursive: true })
    fs.writeFileSync(sf2, 'FAKE SF2')
    const plan = easyrpgPlan(ctx)
    expect(plan.args).toContain('--soundfont-path')
    expect(plan.args[plan.args.indexOf('--soundfont-path') + 1]).toBe(sf2)
  })

  test('模块自带音源**不存在** → 不注入（传不存在的路径会让它启动即报错）', () => {
    const ctx = makeCtx()
    const plan = easyrpgPlan(ctx)
    expect(plan.args).not.toContain('--soundfont-path')
  })

  test('用户自己指定了音源 → 不覆盖（即使模块自带的有）', () => {
    const ctx = makeCtx({ gameArgs: { soundfontPath: '/my/font.sf2' } })
    const sf2 = easyrpgSoundfontPath(ctx.dataDir)
    fs.mkdirSync(path.dirname(sf2), { recursive: true })
    fs.writeFileSync(sf2, 'FAKE SF2')
    const plan = easyrpgPlan(ctx)
    // 只有用户那一个 --soundfont-path，且值是用户给的
    const indices = plan.args.reduce<number[]>((acc, item, index) => (item === '--soundfont-path' ? [...acc, index] : acc), [])
    expect(indices).toHaveLength(1)
    expect(plan.args[indices[0] + 1]).toBe('/my/font.sf2')
  })

  test('soundfont 与 soundfontPath（任意大小写）都算「用户已指定」→ 不注入模块自带的', () => {
    const sf2Of = (dataDir: string): string => easyrpgSoundfontPath(dataDir)
    for (const key of ['soundfont', 'soundFont', 'soundfontPath', 'SOUNDFONTPATH']) {
      const ctx = makeCtx({ gameArgs: { [key]: '/x.sf2' } })
      const sf2 = sf2Of(ctx.dataDir)
      fs.mkdirSync(path.dirname(sf2), { recursive: true })
      fs.writeFileSync(sf2, 'FAKE SF2')
      const args = easyrpgPlan(ctx).args
      // 判据是「模块自带的那个路径有没有被注入」——注意 `soundfont` 键展开成 `--soundfont`
      // （不是 `--soundfont-path`），所以不能靠数 flag 名，要看值
      expect(args).not.toContain(sf2)
      expect(args).toContain('/x.sf2')
    }
  })

  test('游戏目录含空格/中文 → 作为**一个**参数原样进 args（不解成两个）', () => {
    const ctx = makeCtx({ folderName: '我的 游戏 B' })
    const plan = easyrpgPlan(ctx)
    expect(plan.args).toContain(ctx.folder)
    expect(plan.args.every((a) => typeof a === 'string')).toBe(true)
    // 关键：不能被空格拆成多个参数（那正是拼命令行字符串的老坑）
    expect(plan.args.filter((a) => a.includes('我的')).length).toBe(1)
  })

  test('cwd 固定为游戏目录（相对路径参数才有确定含义）', () => {
    const ctx = makeCtx()
    expect(easyrpgPlan(ctx).cwd).toBe(ctx.folder)
  })

  test('~/ 前缀被展开成真实 home 下的路径', () => {
    expect(easyrpgTilde('~/Games/a', '/home/tester')).toBe(path.join('/home/tester', 'Games', 'a'))
    expect(easyrpgTilde('/abs/path', '/home/tester')).toBe('/abs/path')
  })
})

// ===== renpy =====

describe('S2：renpy 启动方案', () => {
  function installRenpy(dataDir: string, version = 'renpy-8.3.4-sdk'): string {
    const root = path.join(dataDir, 'modules', 'renpy', 'deps', 'renpy')
    const dir = path.join(root, version)
    fs.mkdirSync(dir, { recursive: true })
    const sh = path.join(dir, 'renpy.sh')
    fs.writeFileSync(sh, '#!/bin/sh\n')
    return sh
  }

  test('binary 是扫到的 renpy.sh，args 是 --savedir <存档目录> <游戏目录>', () => {
    const ctx = makeCtx()
    const sh = installRenpy(ctx.dataDir)
    const plan = renpyPlan(ctx)
    expect(plan.binary).toBe(sh)
    expect(plan.args).toEqual(['--savedir', renpySaveDir(ctx), ctx.folder])
    expect(plan.engine).toBe('renpy')
  })

  test('存档目录 = <数据目录>/renpysaves/<游戏标题>（D58 后不再指向 xenolauncher）', () => {
    const ctx = makeCtx({ gameTitle: '我的游戏' })
    installRenpy(ctx.dataDir)
    const savedir = renpySaveDir(ctx)
    expect(savedir).toBe(path.join(defaultRenpySaveDir(ctx.dataDir), '我的游戏'))
    // 绝不能出现上游的 xenolauncher 路径（D58 已切到 Tsumigeya）
    expect(savedir).not.toContain('xenolauncher')
  })

    test('gameArgs.savedir 覆盖默认基目录，且仍拼 <游戏名>', () => {
    const ctx = makeCtx({ gameArgs: { savedir: '/custom/saves' }, gameTitle: 'G1' })
    expect(renpySaveDir(ctx)).toBe(path.join('/custom/saves', 'G1'))
  })

  test('gameArgs.savedir 支持 ~/ 前缀', () => {
    const ctx = makeCtx({ gameArgs: { savedir: '~/RenpySaves/' }, gameTitle: 'G2' })
    expect(renpySaveDir(ctx, '/home/tester')).toBe(path.join('/home/tester', 'RenpySaves', 'G2'))
    expect(renpyTilde('~/a', '/home/tester')).toBe(path.join('/home/tester', 'a'))
  })

  test('空标题退回 "game"（否则会拼成基目录本身，所有游戏共用一个存档夹）', () => {
    for (const title of ['', '   ', null, undefined]) {
      const ctx = makeCtx({ gameTitle: title as unknown as string })
      const savedir = renpySaveDir(ctx)
      expect(path.basename(savedir)).toBe('game')
    }
  })

  test('command 非空时作为**最后一个**位置参数追加', () => {
    const ctx = makeCtx({ gameArgs: { command: 'lint' } })
    installRenpy(ctx.dataDir)
    const plan = renpyPlan(ctx)
    expect(plan.args.at(-1)).toBe('lint')
    expect(plan.args.slice(0, 3)).toEqual(['--savedir', renpySaveDir(ctx), ctx.folder])
  })

  test('command 为空/空白时不追加', () => {
    for (const command of ['', '   ']) {
      const ctx = makeCtx({ gameArgs: { command } })
      installRenpy(ctx.dataDir)
      expect(renpyPlan(ctx).args).toEqual(['--savedir', renpySaveDir(ctx), ctx.folder])
    }
  })

  test('找不到 renpy.sh 时仍给一个 plan，binary 指向「本该在那」的位置', () => {
    const ctx = makeCtx()
    const plan = renpyPlan(ctx)
    // 不返回 null（不是「不支持的引擎」），而是让调用方的存在性检查报带期望路径的错误
    expect(plan.binary).toBe(path.join(ctx.dataDir, 'modules', 'renpy', 'deps', 'renpy', 'renpy.sh'))
    expect(plan.args.length).toBe(3)
  })

  test('游戏目录与存档目录含中文/空格时原样进 args', () => {
    const ctx = makeCtx({ folderName: '我的 游戏 C', gameTitle: '标题 带 空格' })
    installRenpy(ctx.dataDir)
    const plan = renpyPlan(ctx)
    expect(plan.args[1]).toContain('标题 带 空格')
    expect(plan.args[2]).toBe(ctx.folder)
    for (const arg of plan.args) expect(arg).not.toContain('"')
  })
})
