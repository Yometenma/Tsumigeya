// 加载引擎 launcher 时**只对这一个模块**劫持 `require('child_process')`，用来拿到 PID（M3.5 §3，D48/D49）。
//
// 背景（方案 §2.2，已实测，别重复验证）：
//   上游 nwjs / mkxpz / easyrpg / renpy 四个 launcher **全部**用 `exec` 启动游戏，
//   而且都是「调完就返回、不 await」——所以 `await launcher.launch()` 不会挂住。
//   真问题是：`exec()` 回一个 ChildProcess（有 `.pid`），而**上游把返回值丢掉了**：
//       function launch(...) { exec(cmd, cb) }   // ← 返回值被丢弃
//   于是我们拿不到 PID → 不知道游戏在不在跑 → 无法关闭。
//
// 为什么用注入而不是改上游（D48）：
//   · 改 modules 仓库的 launcher.js：上游一更新就冲掉，而且要改 4 个模块；
//   · 自己 spawn 再调上游：会启动两次；
//   · 注入：零上游改动，launcher 以为自己调的是原生 exec，实际走我们的。
//
// 为什么只替换 `exec`（D49）：
//   上游可能改实现（改成 spawn / execFile）。只换 exec + 其余原样透传，
//   保证「最坏是失去进程追踪」，而不是「game 启动不起来」。
//
// ⚠️ 本文件不 import electron（单测直接跑）。

import * as realChildProcess from 'node:child_process'

/** 一次 exec 落地时我们关心的事实（来自启动的那一刻）。 */
export interface ExecSpawnInfo {
  /** exec 拿到的 PID；进程没起来（ENOENT 等）时是 null。 */
  pid: number | null
  /** 上游传给 exec 的原始命令串（诊断用，也是 PID 复用复核的依据）。 */
  command: string
  /** 从命令串里抠出来的可执行文件路径（第一个 token，去掉引号）。 */
  execPath: string | null
}

/** 进程结束（或启动失败）时我们关心的事实。 */
export interface ExecExitInfo {
  pid: number | null
  command: string
  /** exec 回调拿到的 err（正常退出是 null）。 */
  error: Error | null
  code: number | null
  signal: NodeJS.Signals | null
  /** 从 spawn 到退出的毫秒数（用单调时钟差值算，不受系统时间调整影响）。 */
  durationMs: number
}

/**
 * 拦截器：由 IPC 层实现（登记/注销进程表、记游玩记录）。
 *
 * **两个回调都必须是非阻塞的**：它们跑在 exec 的同步路径 / 子进程事件回调里，
 * 抛错会污染 launcher 的调用栈（甚至让它以为启动失败）。
 * 所以本模块把两个回调都包在 try/catch 里，绝不让它们的异常冒到 launcher。
 */
export interface ExecInterceptor {
  onSpawn?(info: ExecSpawnInfo): void
  onExit?(info: ExecExitInfo): void
}

/**
 * 从 exec 命令串里取可执行文件路径。
 *
 * 上游实际用法是 `exec(`"${nwjsPath}" "${gameFolder}"`)`（两侧带双引号），
 * 也有引擎是不带引号的裸路径。两种都要认：
 *   `"C:\Program Files\nw.exe" "game dir"` → `C:\Program Files\nw.exe`
 *   `/opt/mkxp-z game`                     → `/opt/mkxp-z`
 *
 * 只取第一个 token 是刻意的：后面的是参数，不是「谁在跑」。
 * 抠不出来返回 null，**不猜**（猜错了会让 PID 复用复核误判成 match，反而更危险）。
 */
export function extractExecPath(command: string): string | null {
  if (typeof command !== 'string') return null
  const text = command.trimStart()
  if (!text) return null
  const quote = text[0]
  if (quote === '"' || quote === "'") {
    const end = text.indexOf(quote, 1)
    if (end < 0) return null
    const inner = text.slice(1, end).trim()
    return inner || null
  }
  const match = /^[^\s]+/.exec(text)
  return match ? match[0] || null : null
}

/** 单调时钟（ms）。用 performance 而不是 Date：系统时间被改也不影响时长。 */
function monotonicMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
}

/**
 * 造一个「只有 exec 被替换」的 child_process 替身。
 *
 * 透传部分用展开拷贝：spawn / execFile / execFileSync / spawnSync / fork / ChildProcess 全部原样。
 * 这就是 D49 —— 上游某天改用 spawn，最坏结果是「追踪不到」，而不是崩溃。
 */
export function createPatchedChildProcess(
  interceptor: ExecInterceptor,
  real: typeof realChildProcess = realChildProcess
): typeof realChildProcess {
  const patched = {
    ...real,
    /**
     * exec 的签名有三种调用形态，必须全部接住：
     *   exec(cmd, cb)
     *   exec(cmd, opts, cb)
     *   exec(cmd)              // 无回调：只返回 ChildProcess
     */
    exec(
      command: string,
      optionsOrCallback?: unknown,
      maybeCallback?: unknown
    ): realChildProcess.ChildProcess {
      const start = monotonicMs()
      const execPath = extractExecPath(command)
      const userCallback =
        typeof optionsOrCallback === 'function'
          ? optionsOrCallback
          : typeof maybeCallback === 'function'
            ? maybeCallback
            : null
      const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback

      let pid: number | null = null
      let settled = false

      /** 只记一次（exit 事件 / 回调 / 启动失败三条路都可能到达这里）。 */
      const finish = (code: number | null, signal: NodeJS.Signals | null, error: Error | null): void => {
        if (settled) return
        settled = true
        try {
          interceptor.onExit?.({
            pid,
            command,
            error,
            code,
            signal,
            durationMs: Math.round(monotonicMs() - start)
          })
        } catch {
          // 拦截器的错误绝不能冒到 launcher（宁可丢一次记录，也不能让启动看起来失败）
        }
      }

      let child: realChildProcess.ChildProcess
      try {
        child = real.exec(command, options as never, ((
          error: Error | null,
          stdout: string,
          stderr: string
        ) => {
          // 这里不承担「记录退出」的主责：正常退出时 `exit` 事件先到。
          // 但启动失败（ENOENT）不会有 exit，只有这里与 'error' 能感知到。
          finish(null, null, error ?? null)
          if (userCallback) (userCallback as (...args: unknown[]) => void)(error, stdout, stderr)
        }) as never)
      } catch (error) {
        // 参数非法等同步抛出：与原生行为一致，同步抛出。但要留下记录。
        finish(null, null, error as Error)
        throw error
      }

      // ⚠️ 顺序很重要：先拿到 PID 交给上层，再返回给 launcher。
      // exec 的回调是异步的，但进程表必须**同步**拿到 PID——
      // 否则用户紧接着点「关闭游戏」时表里还是空的。
      pid = typeof child.pid === 'number' ? child.pid : null

      try {
        interceptor.onSpawn?.({ pid, command, execPath })
      } catch {
        // 同上：拦截器出错不影响启动
      }

      // 兜底退出监听：
      // · 上游可能**不传回调**（那 exec 的 callback 根本不会触发）→ 靠这里注销进程表；
      // · 我们自己 SIGKILL 时回调和事件都会来，`settled` 保证只记一次。
      child.once('exit', (code, signal) => finish(code ?? null, signal ?? null, null))
      child.once('error', (error) => finish(null, null, error))

      return child
    }
  }
  return patched as typeof realChildProcess
}

/**
 * 判断某个 require 的 id 是不是要替换的 child_process。
 *
 * 两种写法都要认：`require('child_process')`（上游目前用的）与 `require('node:child_process')`。
 * 漏掉任何一种都表现为「静默失去追踪」，很难查。
 */
export function isChildProcessRequest(id: unknown): boolean {
  return id === 'child_process' || id === 'node:child_process'
}
