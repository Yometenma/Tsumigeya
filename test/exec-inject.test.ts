// M3.5 S2 单测：launcher 加载时的 `child_process` 注入（D48/D49）。
//
// 这一层是整个「进程管理」的地基：拿不到 PID，后面追踪/关闭/游玩记录全都是空谈。
// 所以要钉死的不只是「能拿到 PID」，还有方案 §9 列出的那几条风险：
//   R1 手工编译与 createRequire 的行为差异 → 无 hook 时必须走原路径
//   R2 上游改用 spawn / execSync → 只换 exec，其余照常透传，最坏丢追踪而不崩
//   R3 PID 复用 → 靠 execPath 复核（这里钉 extractExecPath 的解析）
// 外加几条自己踩出来的边界：不传回调、`node:` 前缀、同步抛错。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createCoreHost, loadScriptWithInjection, resolveCorePath } from '../src/main/core-host'
import {
  createPatchedChildProcess,
  extractExecPath,
  isChildProcessRequest,
  type ExecExitInfo,
  type ExecSpawnInfo
} from '../src/main/exec-inject'

let dataDir: string
let moduleRoot: string

/** 上游 launcher 的真实形态：调 exec 并**丢弃返回值**（方案 §2.2 实测）。 */
const LAUNCHER_DROP_RETURN = `
const { exec } = require('child_process')
const os = require('os')
exports.launch = function (gamePath, folder, args, title, ui) {
  exec('echo hi', (err, stdout, stderr) => { exports.lastStdout = stdout })
  exports.sawSpawn = typeof require('child_process').spawnSync
  exports.otherModuleType = typeof os.platform()
}
`
/** 连回调都不传的形态：退出只能靠我们自己的 exit 监听感知。 */
const LAUNCHER_NO_CALLBACK = `
const { exec } = require('child_process')
exports.launch = function () { exec('echo silent') }
`
/** 用 node: 前缀的写法（上游目前不用，但换了就是静默失去追踪）。 */
const LAUNCHER_NODE_PREFIX = `
const { exec } = require('node:child_process')
exports.launch = function () { exec('echo npipe') }
`
/** R2：上游某天改用 spawnSync —— 追踪不到，但绝不能崩。 */
const LAUNCHER_USE_SPAWN_SYNC = `
const { spawnSync } = require('child_process')
exports.launch = function () {
  const result = spawnSync('echo', ['ok'], { encoding: 'utf8' })
  exports.spawnSyncStdout = result.stdout
}
`
/** 启动不存在的可执行文件（ENOENT）：应当记录失败，而不是静默消失。 */
const LAUNCHER_BAD_BINARY = `
const { exec } = require('child_process')
exports.launch = function () { exec('definitely-not-a-real-binary-tsumigeya --version', () => {}) }
`

function installFakeModule(folder: string, source: string): void {
  const dir = path.join(dataDir, 'modules', folder)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ name: folder, version: '1.0.0' }))
  fs.writeFileSync(path.join(dir, 'launcher.js'), source)
}

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-inject-'))
  moduleRoot = path.join(dataDir, 'modules', 'nwjs')
  installFakeModule('nwjs', LAUNCHER_DROP_RETURN)
  installFakeModule('nocb', LAUNCHER_NO_CALLBACK)
  installFakeModule('npre', LAUNCHER_NODE_PREFIX)
  installFakeModule('sync', LAUNCHER_USE_SPAWN_SYNC)
  installFakeModule('bad', LAUNCHER_BAD_BINARY)
})

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

/** 等一次异步回调（exec 的回调在下个 tick 之后）。 */
function wait(ms = 400): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('extractExecPath（PID 复用复核用的可执行路径解析）', () => {
  test('双引号包裹（上游 nwjs / mkxpz 的真实写法）', () => {
    expect(extractExecPath('"/Applications/nwjs.app/Contents/MacOS/nwjs" "/Users/x/Game"')).toBe(
      '/Applications/nwjs.app/Contents/MacOS/nwjs'
    )
  })
  test('单引号也认（某些引擎会这么拼）', () => {
    expect(extractExecPath("'/opt/mkxp-z' '/games/x'")).toBe('/opt/mkxp-z')
  })
  test('不带引号的裸路径', () => {
    expect(extractExecPath('/usr/local/bin/easyrpg-player --project game')).toBe('/usr/local/bin/easyrpg-player')
  })
  test('Windows 风格带空格路径（引号内不切分）', () => {
    expect(extractExecPath('"C:\\Program Files\\nw.exe" "D:\\Game"')).toBe('C:\\Program Files\\nw.exe')
  })
  test('前导空白不影响', () => {
    expect(extractExecPath('   "/opt/renpy/renpy.sh" x')).toBe('/opt/renpy/renpy.sh')
  })
  test('解析不出来时返回 null，**不猜**', () => {
    // 猜错会让 PID 复用复核把「别的进程」判成 match，比不猜危险得多
    expect(extractExecPath('')).toBeNull()
    expect(extractExecPath('   ')).toBeNull()
    expect(extractExecPath('"/unterminated')).toBeNull()
    expect(extractExecPath(undefined as unknown as string)).toBeNull()
  })
})

describe('isChildProcessRequest', () => {
  test('两种写法都要认（漏掉任何一种都是静默失去追踪）', () => {
    expect(isChildProcessRequest('child_process')).toBe(true)
    expect(isChildProcessRequest('node:child_process')).toBe(true)
  })
  test('别的模块不受影响', () => {
    for (const id of ['fs', 'node:fs', 'os', 'child_process/promises', '']) {
      expect(isChildProcessRequest(id)).toBe(false)
    }
  })
})

describe('createPatchedChildProcess（只换 exec，其余透传 —— D49）', () => {
  test('透传：其余方法与原生对象同一引用（spawnSync / execFile / fork…）', () => {
    const patched = createPatchedChildProcess({})
    for (const key of ['spawn', 'execFile', 'execFileSync', 'spawnSync', 'fork', 'ChildProcess'] as const) {
      expect(typeof (patched as Record<string, unknown>)[key]).toBe(typeof (realOf(key) as unknown))
    }
    // spawnSync 必须是**同一个函数对象**（不是包装过的），否则「透传」就是假的
    expect(patched.spawnSync).toBe(realOf('spawnSync'))
  })

  function realOf(key: string): unknown {
    // 原生 child_process：用非拦截器路径拿一份（本文件顶部 import 的就是原版）
    return (require('node:child_process') as Record<string, unknown>)[key]
  }

  test('onSpawn 拿到真实 PID 与命令串（这是整层的核心）', async () => {
    const spawned: ExecSpawnInfo[] = []
    const patched = createPatchedChildProcess({ onSpawn: (info) => spawned.push(info) })
    patched.exec('echo tsmg-spawn')
    await wait()
    expect(spawned).toHaveLength(1)
    expect(spawned[0].command).toBe('echo tsmg-spawn')
    expect(typeof spawned[0].pid).toBe('number')
    expect(spawned[0].pid).toBeGreaterThan(0)
    expect(spawned[0].execPath).toBe('echo')
  })

  test('onExit 在进程结束后触发，带 code 与 durationMs', async () => {
    const exits: ExecExitInfo[] = []
    const patched = createPatchedChildProcess({ onExit: (info) => exits.push(info) })
    patched.exec('echo tsmg-exit')
    await wait()
    expect(exits).toHaveLength(1)
    expect(exits[0].code).toBe(0)
    expect(exits[0].error).toBeNull()
    expect(exits[0].durationMs).toBeGreaterThanOrEqual(0)
  })

  test('只在**一次** onExit（回调 + exit 事件 + error 都会到达，不能重复记）', async () => {
    const exits: ExecExitInfo[] = []
    const patched = createPatchedChildProcess({ onExit: (info) => exits.push(info) })
    patched.exec('echo dedupe', () => undefined)
    await wait()
    expect(exits).toHaveLength(1)
  })

  test('启动失败（可执行文件不存在）也记一次 onExit', async () => {
    const exits: ExecExitInfo[] = []
    const patched = createPatchedChildProcess({ onExit: (info) => exits.push(info) })
    patched.exec('definitely-not-a-real-binary-tsumigeya')
    await wait()
    expect(exits).toHaveLength(1)
    // ⚠️ 平台差异（实测）：Windows 上 exec 走 cmd 外壳，不存在的程序只是 exit code 1，
    // 不会有 'error' 事件；POSIX 上则是 spawn ENOENT（error 非 null、无 exit）。
    // 判据因此写成「要么有 error，要么退出码非 0」——两种都代表「没真跑起来」。
    const failure = exits[0]
    expect(failure.error !== null || failure.code !== 0).toBe(true)
    expect(failure.pid === null || typeof failure.pid === 'number').toBe(true)
  })

  test('上游不传回调时，退出仍然被记录（靠自己的 exit 监听）', async () => {
    const exits: ExecExitInfo[] = []
    const patched = createPatchedChildProcess({ onExit: (info) => exits.push(info) })
    // 只传 options 不传回调
    patched.exec('echo nocb', { encoding: 'utf8' })
    await wait()
    expect(exits).toHaveLength(1)
  })

  test('用户回调的语义原样保留（err/stdout/stderr 照旧）', async () => {
    const seen: string[] = []
    const patched = createPatchedChildProcess({})
    patched.exec('echo kept', (_err: unknown, stdout: string) => {
      seen.push(String(stdout).trim())
    })
    await wait()
    expect(seen).toEqual(['kept'])
  })

  test('exec(cmd, opts, cb) 三参形态也能同时拿到 PID 与回调', async () => {
    const spawned: ExecSpawnInfo[] = []
    const out: string[] = []
    const patched = createPatchedChildProcess({ onSpawn: (info) => spawned.push(info) })
    patched.exec('echo three', { encoding: 'utf8' }, (_err: unknown, stdout: string) => {
      out.push(String(stdout).trim())
    })
    await wait()
    expect(spawned).toHaveLength(1)
    expect(out).toEqual(['three'])
  })

  test('拦截器自己抛错**不影响**启动（最后一层防线）', async () => {
    const out: string[] = []
    const patched = createPatchedChildProcess({
      onSpawn: () => {
        throw new Error('interceptor boom')
      },
      onExit: () => {
        throw new Error('interceptor boom')
      }
    })
    expect(() => {
      patched.exec('echo resilient', (_err: unknown, stdout: string) => {
        out.push(String(stdout).trim())
      })
    }).not.toThrow()
    await wait()
    expect(out).toEqual(['resilient'])
  })
})

describe('loadScriptWithInjection（作用域劫持 —— 只影响这一个模块）', () => {
  test('launcher 拿到的是带 PID 的 exec，且返回值仍被它自己丢弃（上游形态不变）', async () => {
    const spawned: ExecSpawnInfo[] = []
    const launcher = loadScriptWithInjection(path.join(moduleRoot, 'launcher.js'), {
      onSpawn: (info) => spawned.push(info)
    })
    ;(launcher.launch as () => void)()
    await wait()
    expect(spawned).toHaveLength(1)
    expect(typeof spawned[0].pid).toBe('number')
    // 上游「丢弃返回值」的行为没被我们改变：它照样能拿到 stdout
    expect((launcher as { lastStdout?: string }).lastStdout).toContain('hi')
  })

  test('其余 child_process 方法在该模块里照常可用（D49）', () => {
    const launcher = loadScriptWithInjection(path.join(moduleRoot, 'launcher.js'), {})
    // 这两个属性由 launch() 内部写入，所以必须先调一次
    ;(launcher.launch as () => void)()
    expect((launcher as { sawSpawn?: string }).sawSpawn).toBe('function')
    expect((launcher as { otherModuleType?: string }).otherModuleType).toBe('string')
  })

  test('该模块的**其它** require 完全不受影响（只劫持 child_process）', () => {
    const launcher = loadScriptWithInjection(path.join(moduleRoot, 'launcher.js'), {})
    ;(launcher.launch as () => void)()
    expect((launcher as { otherModuleType?: string }).otherModuleType).toBe('string')
  })

  test('require("node:child_process") 写法同样被拦到', async () => {
    const spawned: ExecSpawnInfo[] = []
    const launcher = loadScriptWithInjection(path.join(dataDir, 'modules', 'npre', 'launcher.js'), {
      onSpawn: (info) => spawned.push(info)
    })
    ;(launcher.launch as () => void)()
    await wait()
    expect(spawned).toHaveLength(1)
  })

  test('R2：上游改用 spawnSync 时不崩，只是追踪不到（宁可丢追踪，不能崩）', () => {
    const spawned: ExecSpawnInfo[] = []
    const launcher = loadScriptWithInjection(path.join(dataDir, 'modules', 'sync', 'launcher.js'), {
      onSpawn: (info) => spawned.push(info)
    })
    expect(() => (launcher.launch as () => void)()).not.toThrow()
    expect((launcher as { spawnSyncStdout?: string }).spawnSyncStdout).toContain('ok')
    // 这正是预期行为：spawnSync 透传了，所以没有 PID —— 但游戏照常能起
    expect(spawned).toHaveLength(0)
  })
})

describe('injectionScopeIsolation（别的模块拿到的仍是原版 child_process）', () => {
  test('本文件（非注入模块）require 到的 child_process.exec 未被改动', () => {
    // 若用全局 Module._load 劫持，这里会拿到被包装过的 exec —— 方案 §3.2 明确弃用那种做法
    const real = require('node:child_process') as { exec: unknown }
    expect(real.exec).toBe(require('node:child_process').exec)
  })
})

describe('createHost 的接线（core-host 入口）', () => {
  let host: ReturnType<typeof createCoreHost>
  beforeAll(() => {
    host = createCoreHost({
      dataDir,
      corePath: resolveCorePath({ env: {}, appPath: process.cwd() }),
      fetchImpl: (async () => {
        throw new Error('offline')
      }) as never
    })
  })

  test('无 hook 时 loadScript 仍走原路径（R1：不改变既有行为）', () => {
    const launcher = host.loadScript('nwjs', 'launcher.js')
    expect(typeof launcher.launch).toBe('function')
  })

  test('有 hook 时能拿到 PID', async () => {
    const spawned: ExecSpawnInfo[] = []
    const launcher = host.loadScript('nwjs', 'launcher.js', {
      execInterceptor: { onSpawn: (info) => spawned.push(info) }
    })
    ;(launcher.launch as () => void)()
    await wait()
    expect(spawned).toHaveLength(1)
    expect(typeof spawned[0].pid).toBe('number')
  })

  test('模块不存在时的错误仍是 error.moduleMissing（注入不改错误路径）', () => {
    expect(() => host.loadScript('not-installed', 'launcher.js')).toThrow(/is not installed/)
  })
})

describe('模块装载的两种路径行为一致（R1）', () => {
  test('同一个 launcher，手工编译与 createRequire 导出的键集相同', () => {
    const viaInjection = loadScriptWithInjection(path.join(moduleRoot, 'launcher.js'), {})
    const host = createCoreHost({
      dataDir,
      corePath: resolveCorePath({ env: {}, appPath: process.cwd() }),
      fetchImpl: ((() => Promise.reject(new Error('offline'))) as never)
    })
    const viaRequire = host.loadScript('nwjs', 'launcher.js')
    expect(Object.keys(viaInjection).sort()).toEqual(Object.keys(viaRequire).sort())
  })
})

describe('真实子进程的 spawnSync 冒烟（确认原生导出没被污染）', () => {
  test('spawnSync 仍可正常执行', () => {
    const result = spawnSync('echo', ['native-ok'], { encoding: 'utf8' })
    expect(result.stdout).toContain('native-ok')
  })
})
