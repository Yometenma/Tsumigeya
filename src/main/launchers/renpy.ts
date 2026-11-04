// M4.0 S2：Ren'Py 的启动方案（D53/D54）。
//
// Ren'Py 的启动形态就这样：`<renpy.sh> --savedir <存档目录> <游戏目录> [<command>]`。
// 这些是 Ren'Py 自己的命令行契约，不是上游发明的——所以「和上游一致」在这里只是
// 顺带的结果，理由是我们自己的：
//
//   1. `--savedir` 指向 `<存档基目录>/<游戏名>` —— 存档按游戏分开（M4 存档管理的地基）
//   2. 存档基目录默认 `<数据目录>/renpysaves/`，用户可在 gameArgs.savedir 改（支持 `~/`）
//   3. `command` 非空时**作为最后一个位置参数**追加
//
// ⚠️ 存档目录**属于我们自己的命名空间**：`<数据目录>/renpysaves/`。
// 别的程序把存档放哪儿与我们无关，我们只认自己数据目录下的那一份
// （代码里因此不出现任何别人的目录名）。
//
// ⚠️ 更早版本的用户在本程序旧存档位置下的存档**不会自动搬**。这是有意的：
// 那是另一套安装留下的数据，搬过来之后两边程序会互相覆盖。
// 「导入旧存档」属于 M4 存档管理的范围（方案 §10-④ 已把存档约定留给 M4）。
import os from 'node:os'
import path from 'node:path'
import { renpyBinaryPath, renpyDepsDir } from './binary-paths'
import type { LaunchContext, LaunchPlan } from './types'

/** 存档基目录的默认位置（`<数据目录>/renpysaves`）。 */
export function defaultRenpySaveDir(dataDir: string): string {
  return path.join(dataDir, 'renpysaves')
}

/** 展开 `~/` 前缀（gameArgs.savedir 可能是 `~/RenpySaves/`）。 */
export function expandTilde(value: string, homedir: string = os.homedir()): string {
  if (value.startsWith('~/')) return path.join(homedir, value.slice(2))
  return value
}

/**
 * 算这次启动用的存档目录：`<基目录>/<游戏名>`。
 *
 * 游戏名取 `gameTitle`；空标题时退回 `game`——不能让它拼出 `.../` 这种指向基目录
 * 本身的路径，那会让 Ren'Py 把所有游戏都写进同一个存档夹（存档互相覆盖）。
 */
export function renpySaveDir(ctx: Pick<LaunchContext, 'gameArgs' | 'gameTitle' | 'dataDir'>, homedir = os.homedir()): string {
  const configured = ctx.gameArgs.savedir
  const base =
    typeof configured === 'string' && configured.trim()
      ? expandTilde(configured.trim(), homedir)
      : defaultRenpySaveDir(ctx.dataDir)
  const raw = ctx.gameTitle == null ? '' : String(ctx.gameTitle).trim()
  const name = raw || 'game'
  return path.join(base, name)
}

/**
 * Ren'Py 的启动方案。
 *
 * 找不到 `renpy.sh` 时**仍然返回一个 plan**（binary 指向「本该在那」的位置），
 * 由调用方统一按「可执行文件不存在」处理：这样错误文案里能带上**期望路径**，
 * 比一个空洞的 "renpy not installed" 有用得多（方案 §7 R1/R6 的处置）。
 */
export function renpyPlan(ctx: LaunchContext): LaunchPlan {
  const resolved = renpyBinaryPath(ctx.dataDir)
  // 找不到时给「本该在那」的直放布局位置（路径拼法仍走 binary-paths，不在这里另写一份）
  const binary = resolved ?? path.join(renpyDepsDir(ctx.dataDir), 'renpy.sh')

  const savedir = renpySaveDir(ctx)
  const args = ['--savedir', savedir, ctx.folder]

  // command 是 Ren'Py 的命令字（如 `compile` / `lint` 之类的子命令）
  const command = ctx.gameArgs.command
  if (typeof command === 'string' && command.trim()) args.push(command.trim())

  return { binary, args, cwd: ctx.folder, engine: 'renpy' }
}
