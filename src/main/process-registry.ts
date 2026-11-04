// 进程表：**只在内存**（D50）。进程是运行时事实，落盘会造出「显示在跑但其实早没了」的假象。
//
// M3.5 §4.1。这一层只做三件事：登记、注销、查。
// 具体怎么杀进程（SIGTERM→5s→SIGKILL，D52）在 ipc.ts 的 stopGame 里——它需要等，
// 而本文件保持同步、纯内存、可在单测里毫秒级断言。
//
// ⚠️ 不 import electron（单测直接跑）。
import { spawn } from 'node:child_process'

/** 一个「我们认为在运行」的游戏（M3.5 §4.1）。 */
export interface RunningGame {
  gameId: string
  pid: number
  /** 引擎模块名（nwjs / mkxpz / easyrpg / renpy），诊断与展示都用得上。 */
  engine: string
  /** 上游传给 exec 的原始命令串（展示 + PID 复用复核）。 */
  command: string
  /** 从命令串里抠出的可执行文件路径（无法解析时为 null）。 */
  execPath: string | null
  /** 启动时刻（ISO 8601）。 */
  startedAt: string
}

export interface ProcessRegistry {
  /** 登记。同 gameId 已有记录时返回 false（不覆盖）。 */
  add(entry: RunningGame): boolean
  /** 注销；pid 不匹配（说明表里已是另一份记录）时不删，返回 false。 */
  remove(gameId: string, pid?: number): boolean
  get(gameId: string): RunningGame | undefined
  /** 是否有记录（**不代表进程还活着**——存活由 `isAlive` / `matches` 判定）。 */
  has(gameId: string): boolean
  list(): RunningGame[]
  size(): number
  clear(): void
}

export function createProcessRegistry(): ProcessRegistry {
  const running = new Map<string, RunningGame>()
  return {
    add(entry) {
      if (running.has(entry.gameId)) return false
      running.set(entry.gameId, entry)
      return true
    },
    remove(gameId, pid) {
      const existing = running.get(gameId)
      if (!existing) return false
      // 传了 pid 就复核：老记录退出的迟到回调不能把**新一次启动**的记录删掉
      if (typeof pid === 'number' && existing.pid !== pid) return false
      return running.delete(gameId)
    },
    get: (gameId) => running.get(gameId),
    has: (gameId) => running.has(gameId),
    list: () => [...running.values()],
    size: () => running.size,
    clear: () => running.clear()
  }
}

/**
 * 进程是否还活着。
 *
 * `process.kill(pid, 0)` 是 Node 里判断存活的**标准做法**：不发真信号，只做存在性与权限检查。
 * - 进程在 → 返回 true
 * - 进程不在 → 抛 ESRCH（= 已退出）
 * - 进程在但不是我们能碰的（别的用户）→ 抛 EPERM。这种情况**当作活着**：
 *   我们和游戏永远是同一用户（同一进程树里起的），真出现 EPERM 说明号被别人拿了，
 *   那种情况下 kill 会失败，但「以为它死了」更危险（会让 stopGame 功能假装成功）。
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** `ps -o comm= -p <pid>` 超时（毫秒）。它只在 stopGame 前复核时调一次，防 PID 复用。 */
const PS_TIMEOUT_MS = 3_000

/**
 * 取某个 PID 的可执行文件名（用于 PID 复用复核，方案 §6 的缓解措施）。
 *
 * 为什么需要：游戏退出后那个 PID 可能被系统分给**别的进程**。如果我们表里还留着旧记录
 * （比如退出回调因为某些原因没到），`stopGame` 就会去 kill 一个无关进程。
 * 复核方式就是比对「这个 PID 现在跑的是不是当初那个可执行文件」。
 *
 * 实现用 `ps` 而不是读 `/proc`：macOS 上没有 /proc，而 `ps` 两边都有。
 * 拿不到就返回 null —— **null 不等于匹配**，调用方必须按「不确定」处理。
 */
export function processCommand(pid: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: string | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => done(null), PS_TIMEOUT_MS)
    try {
      const child = spawn('ps', ['-o', 'comm=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] })
      let out = ''
      child.stdout?.on('data', (chunk: Buffer | string) => {
        out += String(chunk)
      })
      child.once('error', () => done(null))
      child.once('close', () => done(out.trim() || null))
    } catch {
      done(null)
    }
  })
}

/**
 * PID 现在的可执行文件是否还是当初启动的那个。
 *
 * 判定刻意**宽松**：`ps -o comm=` 给的是 basename（`nwjs` / `mkxp-z`），
 * 而记录里存的是完整路径（`/Applications/nwjs.app/Contents/MacOS/nwjs`）。
 * 所以只比对**文件名**（去扩展名后小写包含）。宁可放过一个被复用的 PID（kill 会失败、报错，用户看得见），
 * 也不要把「同名进程」误判成匹配之后去 kill 无关的东西。
 *
 * 三者任一缺失 → 返回 `null`（不确定）。调用方应把它当作「别动手，报错让用户决定」。
 */
export function looksLikeSameExecutable(execPath: string | null, actualCommand: string | null): boolean | null {
  if (!execPath || !actualCommand) return null
  const base = (value: string): string => value.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? ''
  const wanted = base(execPath).toLowerCase()
  const actual = base(actualCommand).toLowerCase()
  if (!wanted || !actual) return null
  // macOS 的 .app 里真实进程名常带后缀（nwjs Helper），用包含关系而不是全等
  return actual.includes(wanted) || wanted.includes(actual)
}

/** 轮询等待进程退出（毫秒精度，最多 `timeoutMs`）。返回 true = 已退出。 */
export function waitForExit(pid: number, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  return new Promise((resolve) => {
    if (!isProcessAlive(pid)) {
      resolve(true)
      return
    }
    const deadline = Date.now() + timeoutMs
    const tick = (): void => {
      if (!isProcessAlive(pid)) {
        resolve(true)
        return
      }
      if (Date.now() >= deadline) {
        resolve(false)
        return
      }
      setTimeout(tick, Math.min(intervalMs, Math.max(0, deadline - Date.now())))
    }
    setTimeout(tick, intervalMs)
  })
}

/** 发信号；目标已不存在返回 false（而不是抛错）。信号在 Windows 上只能是 SIGTERM/SIGKILL。 */
export function sendSignal(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}
