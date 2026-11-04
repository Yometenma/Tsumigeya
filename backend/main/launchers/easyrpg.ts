// M4.0 S2：EasyRPG Player 的启动方案（D53/D54）。
//
// 上游 easyrpg/launcher.js 123 行，真正启动在末尾的 `exec(...)`。它的参数处理
// 没有作弊注入之类的附加功能，所以**规则**与上游一致——但这套规则我们按自己的
// 措辞重写在下面，理由是我们自己的：
//
//   1. gameArgs 每个键 → kebab-case 的 `--flag`
//   2. 值按类型决定带不带值：true → 只带 flag；数字非 0 / 字符串非空 → flag + 值；
//      数组 → 每个元素重复一次 flag
//   3. 有否定键（`noVsync` 之类）且为 true 时，丢掉对应的肯定键
//   4. 用户没设音源时，若模块自带的 `GMGSx.SF2` 存在就注入 `--soundfont-path`
//   5. 最后固定追加 `--window --project-path <游戏目录>`
//
// 为什么要有第 1、2 条（而不是「只传用户改过的少数几个键」）：gameArgs 的表单
// schema 来自 manifest，有 50 多个键，逐个白名单维护必然漏。这套通则保证
// 「用户改过的任何一项都能生效」——漏一个的表现是「某个选项设置无效」，极难查。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { easyrpgBinaryPath, easyrpgSoundfontPath } from './binary-paths'
import type { LaunchContext, LaunchPlan } from './types'

/**
 * 互斥键对：**否定键**为 true 时，整个丢掉对应的**肯定键**。
 *
 * 「各自独立的 boolean 都勾上」时两个 flag 会同时出现在命令行里，取哪个取决于
 * EasyRPG 自己的解析顺序，结果不确定 → 必须由我们定规矩：**否定优先**，
 * 因为勾「不要 X」是比勾「要 X」更强的意图表达。
 *
 * 规则写成「否定为 true 就丢掉肯定」，**不看肯定键的值类型**。
 * 上游写的是 `if (positive === true)`，于是数字型的肯定键（`fpsLimit: 60`）
 * 与否定键同时存在时会**两个都输出**——那是个按值类型分叉的怪规则，我们不做
 * （M4.0 的目标之一就是不再维护上游那套补丁式逻辑）。
 *
 * ⚠️ 现状说明：manifest 的 gameArgs schema 里**没有**这些否定键（实测只有
 * `vsync` / `showFps` / `stretch` / `fpsLimit` / `pauseFocusLost` 等肯定键），
 * 所以这段在常规路径上不触发。它的作用只有一个：用户手改过 games.json、
 * 或者装了旧版模块而带了 `noXxx` 时，**不要**输出自相矛盾的参数。
 */
const CONTRADICTORY_PAIRS: ReadonlyArray<readonly [positive: string, negative: string]> = [
  ['vsync', 'noVsync'],
  ['showFps', 'noShowFps'],
  ['stretch', 'noStretch'],
  ['fpsLimit', 'noFpsLimit'],
  ['pauseFocusLost', 'noPauseFocusLost']
]

/** `soundfontPath` → `--soundfont-path`；`patchRpg2k3Cmds` → `--patch-rpg2k3-cmds`。 */
export function toFlag(key: string): string {
  return (
    '--' +
    key
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .replace(/_/g, '-')
      .toLowerCase()
  )
}

/** 把 gameArgs 转成命令行参数数组（不含固定的尾部三个）。 */
export function argsToFlags(gameArgs: Record<string, unknown>): string[] {
  // 克隆：绝不改调用方传进来的对象
  const copy: Record<string, unknown> = { ...gameArgs }
  // 否定键优先：否定为 true 就丢掉肯定键（不看肯定键的**值类型**，见常量注释）
  for (const [positive, negative] of CONTRADICTORY_PAIRS) {
    if (copy[negative] === true) delete copy[positive]
  }

  const args: string[] = []
  for (const [key, value] of Object.entries(copy)) {
    if (value === null || value === undefined) continue
    if (typeof value === 'boolean') {
      if (value) args.push(toFlag(key))
    } else if (typeof value === 'number') {
      // 0 是多数 flag 的「关」值（音量 0 / 帧率上限 0 / 起始地图 0），传了等于没传
      if (value !== 0) {
        args.push(toFlag(key))
        args.push(String(value))
      }
    } else if (typeof value === 'string') {
      const trimmed = value.trim()
      if (trimmed) {
        args.push(toFlag(key))
        args.push(trimmed)
      }
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        if (entry === null || entry === undefined) continue
        const text = String(entry).trim()
        if (text) {
          args.push(toFlag(key))
          args.push(text)
        }
      }
    }
  }
  return args
}

/** 用户是否已经自己指定了音源（键名忽略大小写，`soundfont` 与 `soundfontPath` 都算）。 */
function hasProvidedSoundfont(gameArgs: Record<string, unknown>): boolean {
  const keys = Object.keys(gameArgs).map((key) => key.toLowerCase())
  return keys.includes('soundfont') || keys.includes('soundfontpath')
}

/** 文件是否存在（不抛）。 */
function isFileSafe(target: string): boolean {
  try {
    return fs.statSync(target).isFile()
  } catch {
    return false
  }
}

/**
 * EasyRPG 的启动方案。
 *
 * ⚠️ `cwd` 取**游戏目录**（与上游的 exec 默认 cwd = 主进程 cwd 不同）。
 * 定 `cwd` 的理由：EasyRPG 有的相对路径参数（`fontPath` / `configPath` / `savePath`）
 * 是相对当前工作目录解析的；上游从 launcher 所在进程的 cwd 起，那个 cwd 对我们不可控。
 * 定成游戏目录至少是**确定**的，且用户填相对路径时直觉上也指向游戏自己。
 */
export function easyrpgPlan(ctx: LaunchContext): LaunchPlan {
  const binary = easyrpgBinaryPath(ctx.dataDir)
  const args = argsToFlags(ctx.gameArgs)

  // 默认音源：只在用户没指定、且模块自带的音源真的存在时才注入
  //（传不存在的路径会让 EasyRPG 启动即报错，比不传更糟）
  if (!hasProvidedSoundfont(ctx.gameArgs)) {
    const soundfont = easyrpgSoundfontPath(ctx.dataDir)
    if (isFileSafe(soundfont)) {
      args.push('--soundfont-path')
      args.push(soundfont)
    }
  }

  // 固定尾部（顺序与上游一致：--window 在前，最后才是项目目录本身）
  args.push('--window')
  args.push('--project-path')
  args.push(ctx.folder)

  return { binary, args, cwd: ctx.folder, engine: 'easyrpg' }
}

/** 展开 `~/` 前缀（gameArgs 里的路径可能写成 `~/Games/xxx`）。 */
export function expandTilde(value: string, homedir: string = os.homedir()): string {
  if (value.startsWith('~/')) return path.join(homedir, value.slice(2))
  return value
}
