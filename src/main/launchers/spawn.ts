// M4.0 S5：真正把游戏拉起来的唯一一处（`spawn` 封装）。
//
// D54：用 `spawn(binary, args[])`，**不拼命令行字符串**，也不用 `exec`。
//      args 数组天然处理空格 / 中文 / 引号，不需要谁写 `quote()`。
//
// D55：`detached: true` + `stdio: 'ignore'` + `child.unref()`。
//      这三样缺一不可，否则**关掉 Tsumigeya 会把游戏一起杀掉**：
//        · 不 detached → 子进程与父进程同属一个进程组，父进程退出时它收到 SIGHUP
//        · 不 ignore   → 子进程的 stdout/stderr 管道挂在父进程上，父进程一退出管道断
//        · 不 unref    → Node 的 event loop 认为「还有子进程要等」，父进程退不干净
//      游戏应该在启动器退出后继续活着（这是产品定位：启动器是启动器）。
//
// ⚠️ 本文件不 import electron（单测直接跑）。
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { LaunchPlan } from './types'

/** 一次 spawn 的结果：要么拿到了子进程，要么带着**可读原因**失败。 */
export type SpawnOutcome =
  | { ok: true; child: ChildProcess; pid: number }
  | { ok: false; code: SpawnErrorCode; message: string; detail: string }

/**
 * spawn 失败的分类。IPC 层据此给不同的中文提示（都比 `spawn ENOENT` 原文有用）。
 */
export type SpawnErrorCode = 'missing' | 'permission' | 'failed'

/**
 * 把 Node 的 errno 归类。
 *
 * `ENOENT` 有两种含义，必须分开看（否则文案会误导用户去「重装引擎」）：
 *   · binary 不存在 → `missing`（真的没装 / 装错版本）
 *   · cwd 不存在    → `failed`（游戏目录被删了，不是引擎问题）
 * 两者都是 ENOENT，靠 errno 分不开——所以这里**显式检查 binary 是否可执行**，
 * 而不是等错误信息去猜。
 */
function classify(error: NodeJS.ErrnoException, cwd: string): SpawnErrorCode {
  if (error.code === 'EACCES' || error.code === 'EPERM') return 'permission'
  if (error.code === 'ENOENT') {
    // 判定顺序很重要：cwd 不存在时 spawn 也报 ENOENT，
    // 若先判 binary 就会把一个「游戏目录被删」误报成「引擎没装」。
    if (!pathExists(cwd)) return 'failed'
    return 'missing'
  }
  return 'failed'
}

/** 路径是否存在（不抛，任何类型都算存在——binary 可能是脚本、目录不该出现但也不拦）。 */
function pathExists(target: string): boolean {
  try {
    fs.accessSync(target)
    return true
  } catch {
    return false
  }
}

/**
 * 启动一个计划里的游戏进程。
 *
 * **同步返回**（不像 `launch()` 里的上游实现那样等）：spawn 的 `pid` 在返回时已可用，
 * 而进程能不能活下来是之后的事（`exit` / `error` 事件）。
 * 这个设计让「用户点启动 → 立刻能点关闭」成立（M3.5 §3 的同一个目标）。
 *
 * ⚠️ **ENOENT 不会在这里被抛出**（实测踩到）：`spawn` 对「可执行文件不存在」是
 * **异步**报错的——同步返回一个 child（`pid` 是 undefined），随后 `error` 事件才到。
 * 所以：
 *   · 同步 try/catch 抓不到 ENOENT（早期版本就是这么漏的）
 *   · `pid === undefined` 才是同步能看到的唯一信号
 *
 * 因此这里**主动检查二进制是否存在**：先手检一次，能给出「缺引擎」这种可操作的中文提示；
 * 万一漏检（比如权限问题），`pid` 为 undefined 也兜住，报 `failed`。
 * 此外给 child 挂一个 `error` 监听器——**没有监听器的 'error' 事件会让 Node 直接抛**，
 * 那会崩掉主进程（这正是 D5 「上游吞掉 Promise，成败不可知」的另一个版本）。
 */
export function spawnGame(plan: LaunchPlan, fallbackCwd: string): SpawnOutcome {
  const cwd = plan.cwd ?? fallbackCwd

  // 先手检可执行文件：ENOENT 是异步的，等它来就只能报一句英文。
  //
  // ⚠️ 只检**绝对路径**：相对路径 / 裸命令名（`ping`、`sleep`）要靠 PATH 解析，
  // `fs.accessSync('ping')` 必然失败——那会把一个完全正常的命令误判成「缺失」
  // （本鱼的集成测试就是这么抓到的）。引擎的 binary 全部来自 binary-paths.ts、
  // 都是绝对路径，所以这条限制刚好够用；裸命令名的情况交给下面的异步路径兜底。
  if (path.isAbsolute(plan.binary) && !pathExists(plan.binary)) {
    return {
      ok: false,
      code: pathExists(cwd) ? 'missing' : 'failed',
      message: `可执行文件不存在：${plan.binary}`,
      detail: plan.binary
    }
  }

  let child: ChildProcess
  try {
    child = spawn(plan.binary, plan.args, {
      cwd,
      // D55：独立存活
      detached: true,
      stdio: 'ignore'
    })
  } catch (error) {
    const errno = error as NodeJS.ErrnoException
    return {
      ok: false,
      code: classify(errno, cwd),
      message: errno.message ?? String(error),
      detail: plan.binary
    }
  }

  // 子进程没有自己的 I/O，unref 之后父进程不会因为它而挂着
  child.unref()

  // ⚠️ 必须挂 'error' 监听器：没有监听器的 'error' 会让 Node 抛（并崩掉主进程）
  child.once('error', () => undefined)

  const pid = typeof child.pid === 'number' ? child.pid : null
  if (pid === null) {
    // 走到这里说明 spawn 异步失败了（典型是 cwd 不存在或权限），
    // 原因随后会以 'error' 事件到——但那时用户已经在等结果，所以按最可能的原因报
    return {
      ok: false,
      code: 'failed',
      message: `无法启动：${plan.binary}`,
      detail: plan.binary
    }
  }
  return { ok: true, child, pid }
}

/**
 * spawn 的失败原因 × 可读说明（返回给 IPC 层拼文案的原料）。
 *
 * 放这里而不是 ipc.ts：文案的关键信息是「哪个文件」，而只有这里知道 binary 路径。
 */
export function describeSpawnFailure(code: SpawnErrorCode, binary: string): string {
  if (code === 'missing') {
    return (
      `找不到引擎的可执行文件：${binary}\n` +
      `这个引擎可能没有安装、或者安装的版本与游戏记录不一致。请到「引擎管理」检查。`
    )
  }
  if (code === 'permission') {
    return (
      `没有权限执行引擎的可执行文件：${binary}\n` +
      `可能是文件权限被改过（例如解压时丢了执行位）。可以尝试重新安装该引擎。`
    )
  }
  return `启动引擎失败：${binary}`
}
