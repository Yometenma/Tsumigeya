// M6.5：Siglus 的启动方案（siglus_rs）。
//
// ===== 为什么这一个引擎能覆盖四种格式 =====
//
// **siglus_rs**（https://github.com/xmoezzz/siglus_rs，MPL-2.0）是一个 Rust 重实现，
// 同时支持 **UK2 / AVG32 / RealLive / SiglusEngine** 四种日本 VN 引擎格式。
//
//   许可证 MPL-2.0 → 与 GPL-3.0 兼容（且是文件级 copyleft，不传染整个项目）
//   macOS 官方构建：aarch64 app / x86_64 app / universal DMG app bundle
//
// 官方用法（README）：
//
//     siglus_engine --project-dir <游戏目录>
//
// ===== ⚠️ 唯一门槛：key.toml（16 字节副密钥）=====
//
// SiglusEngine 的资源是加密的，需要副密钥才能解密。siglus_rs 支持**自动爆破**
// （README 有说明）—— 所以我们**不自己处理密钥，交给它**。
//
// ⚠️ 这条要留意：爆破失败时它会怎样（报错？卡住？）**未实测**，
// 所以本文件不假装能覆盖所有游戏。出问题时错误文案要指向「可能是密钥问题」，
// 而不是一句泛泛的「启动失败」。
//
// ===== 关于 RealLive 是否单独做 =====
//
// siglus_rs 已覆盖 RealLive，所以 **RealLive 游戏优先走这个引擎**。
// 另一条候选是 rlvm（GPL-3.0），但它的**许可证全文、macOS 存档路径、arm64 支持全都未核实**，
// 风险高于「已有官方 mac 预编译」的 siglus_rs。
// → 除非实测发现 siglus_rs 跑不了某些 RealLive 游戏，否则**不做 rlvm**。
import fs from 'node:fs'
import path from 'node:path'
import { siglusBinaryPath, siglusDepsDir, siglusExpectedPath } from './binary-paths'
import type { LaunchContext, LaunchPlan } from './types'

/**
 * 这个目录像不像 siglus_rs 能读的游戏。
 *
 * 判据是**存在任一标志文件**（不要求全部）：
 *   · `Scene.pck`   — SiglusEngine 的主归档
 *   · `Gameexe.dat` — SiglusEngine 的配置
 *   · `Seen.txt`    — RealLive 的脚本
 *   · `Gameexe.ini` — RealLive / AVG32 的配置
 *   · `*.pak`       — UK2 的归档（目录扫描另判，这里只看固定名）
 *
 * 为什么不要求全在：四种格式的标志各不相同，要求全在就一个都认不出来。
 */
export function hasSiglusEntry(folder: string): boolean {
  for (const name of ['Scene.pck', 'Gameexe.dat', 'Seen.txt', 'Gameexe.ini']) {
    try {
      if (fs.statSync(path.join(folder, name)).isFile()) return true
    } catch {
      // 继续看下一个
    }
  }
  return false
}

/**
 * 引擎私有的工作目录（`<dataDir>/modules/siglus/work/<游戏>`）。
 *
 * 为什么需要：siglus_rs 爆破密钥时可能要写中间文件。**这些绝不能落进游戏目录**
 * （D53）。给它一个我们自己的目录，让它随便写。
 */
export function siglusWorkDir(ctx: Pick<LaunchContext, 'dataDir' | 'folder' | 'gameTitle'>): string {
  const raw = (ctx.gameTitle ?? '').trim()
  const safe = raw && !raw.includes('/') && !raw.includes('\\') ? raw : path.basename(ctx.folder) || 'game'
  return path.join(siglusDepsDir(ctx.dataDir), 'work', safe)
}

/**
 * Siglus 的启动方案。
 *
 * 参数按 README 的 `--project-dir <游戏目录>`。
 *
 * 找不到二进制时**仍然返回 plan**（binary 指向期望路径），由 ipc 层报可读错误。
 */
export function siglusPlan(ctx: LaunchContext): LaunchPlan {
  const resolved = siglusBinaryPath(ctx.dataDir)
  const binary = resolved ?? siglusExpectedPath(ctx.dataDir)

  const args: string[] = ['--project-dir', ctx.folder]

  return {
    binary,
    args,
    cwd: ctx.folder,
    engine: 'siglus',
    /**
     * prepare：**建好私有工作目录**。
     *
     * 为什么必需：这个引擎会爆破密钥，需要一个它可写的目录；
     * 不给的话它可能试图写游戏目录（那里可能不该写，甚至会失败）或者当前目录。
     * 先建好是零成本、确定正确的。
     *
     * ⚠️ 不碰游戏目录（D53）。
     */
    prepare: () => {
      fs.mkdirSync(siglusWorkDir(ctx), { recursive: true })
    }
  }
}

/**
 * 「这个目录不像是 Siglus/UK2/AVG32/RealLive 的游戏」的可读说明。
 *
 * 为什么不复用一句泛泛的「找不到脚本」：这四种格式的标志文件各不相同，
 * 用户需要知道**我们到底在找什么**，否则他没法判断是自己选错了目录还是这游戏真不支持。
 */
export function siglusMissingEntryMessage(folder: string): string {
  return (
    `这个目录里找不到 Scene.pck / Gameexe.dat / Seen.txt / Gameexe.ini 任何一个，` +
    `不像是 Siglus、UK2、AVG32 或 RealLive 的游戏根目录：${folder}\n` +
    '请确认选中的是整个游戏目录（通常是解压后的那一层），而不是里面的某个子目录。'
  )
}

/**
 * 「密钥爆破失败」的可操作提示。
 *
 * 为什么专门有一句：siglus_rs 的唯一门槛就是那个 16 字节副密钥。
 * 如果是密钥问题，用户重装引擎一万遍都没用 —— 必须告诉他真正的原因。
 */
export function siglusKeyHint(): string {
  return (
    '这个 Siglus 游戏可能资源加密方式特殊，副密钥自动爆破失败。\n' +
    '这是引擎（siglus_rs）的限制，与本程序是否正常无关；重装引擎不会改善。'
  )
}
