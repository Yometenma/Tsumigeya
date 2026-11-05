// M6 S3：吉里吉里（KiriKiri 2 / Z）的启动方案（D53/D54）。
//
// ===== 运行时：krkrsdl2 =====
//
// 吉里吉里原本只有 Windows 版运行时（krkr.exe / krkrz.exe）。macOS 上用的是
// **krkrsdl2**（吉里吉里Z 的 SDL2 移植版，MIT，官方提供 macOS 预编译包）：
//
//     https://krkrsdl2.github.io/krkrsdl2/en/
//
// 它的用法（官方 Usage 段原文）：
//
//     /path/to/krkrsdl2 /path/to/startup/directory
//
// 即：**把「含 startup.tjs 的那一层目录」当作参数传进去**。
// 不传参数时它读**当前工作目录**里的 startup.tjs —— 我们选择显式传目录，
// 因为显式传参不依赖 cwd，少一个变量（cwd 设错时会静默启动另一个游戏）。
//
// ===== ⚠️ 上游不背书「商用游戏」=====
//
// krkrsdl2 官方页面明写：
//
//     "Running **unmodified commercial games** using this project is **not supported**.
//      Please use Wine or GameNative instead."
//
// 用户 2026-11-05 拍板接受这条限制，所以我们做它；但它因此被标成引擎页的「实验性」
// （见 registry.ts 的 kirikiri 定义 + types.ts 的 `experimental` 字段）。
//
// 这个文件**不做任何检测或拒绝**：那是上游的立场声明，不是技术闸门
// （它并不会真的拦住未魔改的商业游戏）。我们如实转达，不替用户挡。
//
// ===== 认不出的形态 =====
//
// 吉里吉里有两种布局：
//   ① `data.xp3`（归档，最常见）← autodetect 认的就是它
//   ② `startup.tjs` + 散文件（不打包）
//
// 形态 ② 的散文件布局**没有统一约定**（作者想怎么放就怎么放），
// 强行认会把一堆「碰巧有 .tjs」的项目误判，所以 **autodetect 只认 ①**。
// 但**启动侧两种都支持**：只要游戏目录里有 `data.xp3` 或 `startup.tjs` 之一，都能跑。
import fs from 'node:fs'
import path from 'node:path'
import { krkrsdl2BinaryPath, krkrsdl2ExpectedPath } from './binary-paths'
import type { LaunchContext, LaunchPlan } from './types'

/**
 * 这个目录「像不像」吉里吉里的启动目录。
 *
 * 判据是**存在任一入口**（`data.xp3` / `startup.tjs`），而不是两个都要 ——
 * 因为两种分发布局是互斥的：打包版只有 `data.xp3`，散文件版只有 `startup.tjs`。
 * 要求两个都在会把一半的游戏判成不能跑。
 *
 * ⚠️ 这里只看**文件是否存在**，不解析 xp3（那是另一个工程）。
 */
export function hasKirikiriEntry(folder: string): boolean {
  for (const name of ['data.xp3', 'startup.tjs']) {
    try {
      if (fs.statSync(path.join(folder, name)).isFile()) return true
    } catch {
      // 不存在就继续看下一个
    }
  }
  return false
}

/**
 * 吉里吉里的启动方案。
 *
 * 与 `renpyPlan` 同一个取向：找不到二进制时**仍然返回 plan**（binary 指向「本该在那」），
 * 由 ipc 层统一报「可执行文件不存在」并带上期望路径 —— 比一句 "krkrsdl2 not installed" 有用得多。
 *
 * `cwd` 设成游戏目录：虽然我们显式传了目录参数，但 krkrsdl2 的一些插件/子脚本会按
 * cwd 找相对路径，指到游戏目录最安全（与 nwjs/renpy 一致）。
 */
export function kirikiriPlan(ctx: LaunchContext): LaunchPlan {
  const resolved = krkrsdl2BinaryPath(ctx.dataDir)
  const binary = resolved ?? krkrsdl2ExpectedPath(ctx.dataDir)

  return {
    binary,
    args: [ctx.folder],
    cwd: ctx.folder,
    engine: 'kirikiri'
  }
}

/**
 * 「这个目录里找不到吉里吉里的启动文件」的可读说明。
 *
 * 为什么单独有一句：用户可能把**子目录**选成了游戏根（比如 `game/voice/`），
 * 或者下载的是个还没解压完的残包。这两种情况下让 spawn 报 ENOENT 会误导成「引擎没装」。
 */
export function kirikiriMissingEntryMessage(folder: string): string {
  return (
    `这个目录里既没有 data.xp3 也没有 startup.tjs，不像是吉里吉里的游戏根目录：${folder}\n` +
    '请确认选中的是整个游戏目录（通常是解压后的那一层），而不是里面的某个子目录。'
  )
}
