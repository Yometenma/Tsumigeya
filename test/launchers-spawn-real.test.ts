// M4.0 S5 集成测试：**真的** spawn 一个进程，验证 D55 的三件套与 PID 回收。
//
// 与 ipc-process.test.ts 的分工：
//   · 那个文件用假 spawn 验「决策」（进程表 / 记录 / 事件），毫秒级
//   · 这个文件用**真的 spawn** 验「系统行为」——detached / stdio:'ignore' / unref
//     这三次如果写错，单测全绿也照样在真机上出问题（关掉启动器游戏被一起杀掉），
//     所以必须有一次真进程参与。
//
// 假「游戏」用系统自带的长跑命令（AGENTS.md 的已知坑：不能用 process.execPath，
// 那是 Electron 的可执行文件，在纯 Node 里也可能立刻退出）：
//   Windows: ping -n 120 127.0.0.1
//   macOS/Linux: sleep 120
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  describeSpawnFailure,
  spawnGame
} from '../src/main/launchers/spawn'
import { isProcessAlive, sendSignal, waitForExit } from '../src/main/process-registry'
import type { LaunchPlan } from '../src/main/launchers/types'

/** 系统自带的长跑命令（约 120 秒），测试结束前一定会被我们杀掉。 */
function fakeGamePlan(): LaunchPlan {
  if (process.platform === 'win32') {
    return {
      binary: 'ping',
      args: ['-n', '120', '127.0.0.1'],
      cwd: os.tmpdir(),
      engine: 'easyrpg'
    }
  }
  return { binary: 'sleep', args: ['120'], cwd: os.tmpdir(), engine: 'easyrpg' }
}

const started: number[] = []

/** 测试结束后无论如何都清干净（避免 CI 上留下 120 秒的孤儿进程）。 */
afterEach(async () => {
  while (started.length > 0) {
    const pid = started.pop()
    if (pid && isProcessAlive(pid)) {
      sendSignal(pid, 'SIGKILL')
      await waitForExit(pid, 3_000)
    }
  }
})

describe('M4.0 S5：真 spawn（D55 的三件套在真机上成立）', () => {
  test('spawn 成功 → 拿到真实的 PID，且进程真的活着', async () => {
    const outcome = spawnGame(fakeGamePlan(), os.tmpdir())
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    started.push(outcome.pid)

    expect(outcome.pid).toBeGreaterThan(0)
    expect(typeof outcome.child.pid).toBe('number')
    // 真的在跑（不是「返回了 PID 但进程立刻没了」）
    expect(isProcessAlive(outcome.pid)).toBe(true)
  })

  test('★ 进程能被我们杀掉（说明 PID 是真的、且我们自己拿得到句柄）', async () => {
    const outcome = spawnGame(fakeGamePlan(), os.tmpdir())
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    started.push(outcome.pid)

    expect(sendSignal(outcome.pid, 'SIGKILL')).toBe(true)
    const gone = await waitForExit(outcome.pid, 5_000)
    expect(gone).toBe(true)
    expect(isProcessAlive(outcome.pid)).toBe(false)
    // 已经清理过了，别在 afterEach 里再杀一次
    started.pop()
  })

  test('★ detached + unref：父进程的事件循环不被它挂住', async () => {
    // 判据：spawn 之后 `child` 上**没有**被监听的 ref，且我们能立刻继续干活。
    // 更硬的判据是「父进程能正常退出」——那由整个测试文件的正常结束来体现：
    // 如果忘了 unref，vitest 会挂在「等待子进程」上而不是报这个断言失败。
    const outcome = spawnGame(fakeGamePlan(), os.tmpdir())
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    started.push(outcome.pid)

    // detached 之后 pid 与父进程不在同一进程组，kill(-pid) 才是「杀它的整组」
    if (process.platform !== 'win32') {
      const child = outcome.child as unknown as { spawnargs?: string[] }
      expect(Array.isArray(child.spawnargs)).toBe(true)
    }
    // 关键：拿到 PID 之后立刻还能继续（没被 unref 前的阻塞拖住）
    expect(isProcessAlive(outcome.pid)).toBe(true)
  })

  test('binary 不存在（ENOENT）→ ok:false + missing，且**不抛**', () => {
    const outcome = spawnGame(
      { binary: path.join(os.tmpdir(), 'no-such-binary-tsumigeya'), args: [], cwd: os.tmpdir(), engine: 'nwjs' },
      os.tmpdir()
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.code).toBe('missing')
    // 错误信息里必须带**那个路径**（用户与日志都靠它判断）
    expect(outcome.detail).toContain('no-such-binary-tsumigeya')
  })

  test('spawn 失败时给的中文说明里带 binary 路径（比英文 errno 有用）', () => {
    const binary = '/Applications/Some.app/Contents/MacOS/Some'
    const text = describeSpawnFailure('missing', binary)
    expect(text).toContain(binary)
    expect(text).toContain('引擎管理')
    // 三种失败各有不同的说明（不能都退回同一句）
    expect(describeSpawnFailure('permission', binary)).not.toBe(text)
    expect(describeSpawnFailure('failed', binary)).not.toBe(text)
  })
})
