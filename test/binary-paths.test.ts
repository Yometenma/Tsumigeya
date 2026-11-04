// M4.0 S1 单测：引擎可执行文件路径（D56 的唯一来源）。
//
// 这里钉死的是**路径各段的拼法与顺序**，不是「能不能跑起来」：
// 上游把路径硬编码在 4 个 launcher.js 里，我们照抄，不许「顺手优化」。
// 一旦拼错，用户那边表现是「引擎明明装了，点启动没反应」（M1 的老问题）。
//
// ⚠️ 期望值一律用 `path.join` 拼，**不要写死 `/Users/...` 字面量**：
//    本机是 Windows（path.join 用 `\`），而 CI 是 Linux、目标是 macOS（用 `/`）。
//    写死斜杠会让这条测试在开发机上假红、在 CI 上假绿（两边都没测到真东西）。
//    用 path.join 拼期望值时，断言真正钉住的是「段与段的顺序」——那才是会写错的地方。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  easyrpgBinaryPath,
  easyrpgSoundfontPath,
  mkxpzBinaryPath,
  mkxpzConfigDir,
  mkxpzRtpDir,
  moduleDir,
  nwjsBinaryPath,
  nwjsVersionsDir,
  renpyBinaryPath,
  renpyInstalledSdks
} from '../src/main/launchers/binary-paths'

/** 假的 mac 数据目录（只用于拼字符串——本机是 Windows，这些路径不会真的存在）。 */
const DATA = path.join('/Users', 'tester', 'Library', 'Application Support', 'Tsumigeya')

const created: string[] = []
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-paths-'))
  created.push(dir)
  return dir
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

describe('S1：nwjs 路径（含 arch，最容易拼错的一个）', () => {
  test('arm64 的路径段与顺序与上游 launcher.js 一致', () => {
    expect(nwjsBinaryPath(DATA, 'v0.106.1', 'arm64')).toBe(
      path.join(
        DATA,
        'modules',
        'nwjs',
        'deps',
        'version',
        'v0.106.1',
        'nwjs-sdk-v0.106.1-osx-arm64',
        'nwjs.app',
        'Contents',
        'MacOS',
        'nwjs'
      )
    )
  })

  test('x64 只改 arch 那一段，其余不变', () => {
    const arm = nwjsBinaryPath(DATA, 'v0.106.1', 'arm64')
    const x64 = nwjsBinaryPath(DATA, 'v0.106.1', 'x64')
    expect(x64).toBe(arm.replace('osx-arm64', 'osx-x64'))
  })

  test('version 原样进路径（带 v 的目录名不会被剥掉）', () => {
    // 上游就是拿 gameArgs.version 直接拼；剥 v 会拼出不存在的目录（M3 之前的坑）
    const out = nwjsBinaryPath(DATA, 'v0.106.1', 'arm64')
    expect(out).toBe(
      path.join(
        DATA,
        'modules',
        'nwjs',
        'deps',
        'version',
        'v0.106.1',
        'nwjs-sdk-v0.106.1-osx-arm64',
        'nwjs.app',
        'Contents',
        'MacOS',
        'nwjs'
      )
    )
    // 而「去掉 v 的值」会拼出另一个路径（这正是 reconcileVersionArgs 存在的理由）
    expect(nwjsBinaryPath(DATA, '0.106.1', 'arm64')).not.toBe(out)
  })

  test('版本根目录用于「有没有装过任何版本」判断', () => {
    expect(nwjsVersionsDir(DATA)).toBe(path.join(DATA, 'modules', 'nwjs', 'deps', 'version'))
  })
})

describe('S1：mkxpz 路径（二进制 + 配置目录）', () => {
  test('可执行文件路径', () => {
    expect(mkxpzBinaryPath(DATA)).toBe(
      path.join(DATA, 'modules', 'mkxpz', 'deps', 'mkxpz', 'Z-Universal.app', 'Contents', 'MacOS', 'Z-Universal')
    )
  })

  test('app 包内的 Contents/Game 目录（老版本写配置的地方，仅排障用）', () => {
    expect(mkxpzConfigDir(DATA)).toBe(
      path.join(DATA, 'modules', 'mkxpz', 'deps', 'mkxpz', 'Z-Universal.app', 'Contents', 'Game')
    )
  })

  test('⚠️ mkxp.json 不写在 app 包里（M5.1：mkxp-z 按 cwd 找配置，写这里它读不到）', () => {
    // 这里只断言「binary 仍在 .app 内」——配置的位置由 mkxpzPlan 决定（游戏目录）
    const appRoot = path.join(DATA, 'modules', 'mkxpz', 'deps', 'mkxpz', 'Z-Universal.app')
    expect(mkxpzBinaryPath(DATA).startsWith(appRoot + path.sep)).toBe(true)
  })

  test('RTP 目录与诊断（diagnose.detectMissingRtp）查的是同一个位置', () => {
    expect(mkxpzRtpDir(DATA, 'RPGVXace')).toBe(
      path.join(DATA, 'modules', 'mkxpz', 'deps', 'RTP', 'RTP', 'RPGVXace')
    )
  })
})

describe('S1：easyrpg 路径', () => {
  test('可执行文件路径（.app 名里带空格，不能被截断成两段）', () => {
    expect(easyrpgBinaryPath(DATA)).toBe(
      path.join(
        DATA,
        'modules',
        'easyrpg',
        'deps',
        'player',
        'EasyRPG Player.app',
        'Contents',
        'MacOS',
        'EasyRPG Player'
      )
    )
    // 「EasyRPG Player.app」必须是一整段（带空格的目录名被拆开就找不到）
    expect(easyrpgBinaryPath(DATA)).toContain('EasyRPG Player.app')
  })

  test('默认音源路径', () => {
    expect(easyrpgSoundfontPath(DATA)).toBe(
      path.join(DATA, 'modules', 'easyrpg', 'deps', 'soundfont', 'GMGSx.SF2')
    )
  })
})

describe('S1：renpy 路径（要扫目录找最新版）', () => {
  test('直接放的 renpy.sh 优先', () => {
    const dir = tempDir()
    const root = path.join(dir, 'modules', 'renpy', 'deps', 'renpy')
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'renpy.sh'), '#!/bin/sh\n')
    // 同时存在一个 SDK 目录也不该被选中（直放优先）
    fs.mkdirSync(path.join(root, 'renpy-8.3.4-sdk'), { recursive: true })
    expect(renpyBinaryPath(dir)).toBe(path.join(root, 'renpy.sh'))
  })

  test('SDK 目录布局：取版本号最大的一版（numeric 排序，10 比 8 大）', () => {
    const dir = tempDir()
    const root = path.join(dir, 'modules', 'renpy', 'deps', 'renpy')
    for (const name of ['renpy-8.3.4-sdk', 'renpy-10.0.0-sdk', 'renpy-9.1.0-sdk']) {
      fs.mkdirSync(path.join(root, name), { recursive: true })
      fs.writeFileSync(path.join(root, name, 'renpy.sh'), '#!/bin/sh\n')
    }
    // 纯字符串排序会把 10 排在 8 之后 → 拿到 9.1.0 或 8.3.4，都是错的
    expect(renpyBinaryPath(dir)).toBe(path.join(root, 'renpy-10.0.0-sdk', 'renpy.sh'))
  })

  test('目录名不合 SDK 规则的（如 renpy-8.3.4）被跳过', () => {
    const dir = tempDir()
    const root = path.join(dir, 'modules', 'renpy', 'deps', 'renpy')
    fs.mkdirSync(path.join(root, 'renpy-8.3.4'), { recursive: true })
    fs.writeFileSync(path.join(root, 'renpy-8.3.4', 'renpy.sh'), '#!/bin/sh\n')
    // 只认 renpy-<x.y.z>-sdk，其它名字不猜
    expect(renpyBinaryPath(dir)).toBeNull()
  })

  test('什么都没有时返回 null（不造路径，让调用方报可读错误）', () => {
    expect(renpyBinaryPath(tempDir())).toBeNull()
  })

  test('SDK 目录存在但里面没有 renpy.sh → 继续找下一个，最终 null', () => {
    const dir = tempDir()
    const root = path.join(dir, 'modules', 'renpy', 'deps', 'renpy')
    fs.mkdirSync(path.join(root, 'renpy-10.0.0-sdk'), { recursive: true })
    expect(renpyBinaryPath(dir)).toBeNull()
  })

  test('已装版本清单按版本号从新到旧', () => {
    const dir = tempDir()
    const root = path.join(dir, 'modules', 'renpy', 'deps', 'renpy')
    for (const name of ['renpy-8.3.4-sdk', 'renpy-10.0.0-sdk']) {
      fs.mkdirSync(path.join(root, name), { recursive: true })
    }
    expect(renpyInstalledSdks(dir)).toEqual(['renpy-10.0.0-sdk', 'renpy-8.3.4-sdk'])
  })

  test('已装版本清单在目录不存在时返回空数组（不抛）', () => {
    expect(renpyInstalledSdks(tempDir())).toEqual([])
  })
})

describe('S1：路径含中文与空格（args 数组语义靠 spawn，路径本身不能被改写）', () => {
  const weird = path.join('/Users', 'tester', '我的 游戏 数据 dir')

  test('数据目录带中文与空格时，拼出的路径原样保留', () => {
    const out = nwjsBinaryPath(weird, 'v0.106.1', 'arm64')
    expect(out.startsWith(weird + path.sep)).toBe(true)
    // 不能有 URL 编码，也不能自己加引号（那是上游 quote() 在补的坑，D54 用 args 数组回避）
    expect(out).not.toContain('%20')
    expect(out).not.toContain('"')
    expect(out).toContain('nwjs.app')
  })

  test('mkxpz / easyrpg 同样不转义、不加引号', () => {
    for (const target of [mkxpzBinaryPath(weird), easyrpgBinaryPath(weird)]) {
      expect(target.startsWith(weird + path.sep)).toBe(true)
      expect(target).not.toContain('"')
    }
  })
})

describe('S1：moduleDir / 通用拼法', () => {
  test('<数据目录>/modules/<引擎>', () => {
    expect(moduleDir(DATA, 'nwjs')).toBe(path.join(DATA, 'modules', 'nwjs'))
  })

  test('四个引擎的模块目录互不相同，且都在 modules 下', () => {
    const dirs = ['nwjs', 'mkxpz', 'easyrpg', 'renpy'].map((engine) => moduleDir(DATA, engine))
    expect(new Set(dirs).size).toBe(4)
    for (const dir of dirs) expect(dir.startsWith(path.join(DATA, 'modules') + path.sep)).toBe(true)
  })
})
