// M6.5：NScripter 的启动方案（ONScripter）。
//
// ===== 判据 =====
//
// 资源：`nscript.dat`（脚本）+ `arc.nsa`（归档）+ 图片音频 —— 全是数据（判据 A ✅）
// 运行时：ONScripter（GPL-2+，与 GPL-3.0 兼容），tmkk 版有 Apple Silicon 原生二进制（判据 B ✅）
//
// 详见 registry.ts 的 nscripter 定义与 docs/引擎范围扩展-实施方案.md §10。
//
// ===== 这个引擎的特殊之处：**prepare 是必需的，不是可选** =====
//
// 另外三个引擎（mkxpz 写配置、SPawn 之前）的 prepare 多少有点「锦上添花」，
// 而 ONScripter 这两件事**不处理就是纯粹的坏**：
//
//   ① **缺 `default.ttf` 根本启动不了**（不是警告、不是崩溃，是压根不出画面）
//   ② **缺 `game.id` 会把存档写进一个随机命名的目录** —— 用户的档确实存下来了，
//      但下次进「详情页 → 存档」时我们找不到，他自己在访达里更找不到。
//      这就是 D85 那个坑的同一类：**看起来成功，实际不可用**。
//
// ===== D53：绝不写用户游戏目录 =====
//
// 上面两件事都是「往游戏目录里放文件」，而 D53 明令禁止。
// 解法：**不写游戏目录，改用命令行参数**（ONScripter 支持把 ons.cfg 的每一项都写成命令行开关）：
//
//   ① 字体：`--font <path>` 指向我们自己那份（放 `<dataDir>/modules/nscripter/fonts/`）
//       —— 它不一定支持 --font 这个拼法（待实测），所以**同时**保留 ons.cfg 里的 font 键。
//   ② 存档：`--save <path>` 明确指到我们的目录
//   ③ game.id：**这个没有命令行等价**（它是读游戏目录里的文件）→ 见下
//
// ⚠️ `game.id` 没有命令行替代，这是已知的**未解决项**。本文件的策略是：
//   · **不写游戏目录**（守 D53）
//   · 改为**总是传 `--save=<我们的目录>`**，这样存档位置由我们决定，
//     game.id 只影响「如果不传 --save 时」的默认目录 —— 我们传了，就不受影响。
//   · 若实测发现 `--save` 不生效（某些版本），再把 game.id 方案拿上来评估。
//
// → **这条必须在真机样本上验**：docs/引擎范围扩展-实施方案.md §10.10 已记。
import fs from 'node:fs'
import path from 'node:path'
import { nscripterDepsDir, onscripterBinaryPath, onscripterExpectedPath } from './binary-paths'
import type { LaunchContext, LaunchPlan } from './types'

/**
 * 我们自带的默认字体文件（`<dataDir>/modules/nscripter/fonts/default.ttf`）。
 *
 * 不写在游戏目录（D53），而是由安装链路下载到我们的模块目录。
 * 用户如果想用游戏自带的字体，可以通过 gameArgs 覆盖（见下）。
 */
export function bundledFontPath(dataDir: string): string {
  return path.join(nscripterDepsDir(dataDir), 'default.ttf')
}

/**
 * 存档目录（`<dataDir>/saves/nscripter/<gameTitle或folder哈希>`）。
 *
 * 与 Ren'Py 的 `<dataDir>/renpysaves/<游戏名>` 同一取向：**属于我们自己的命名空间**，
 * 不去猜 ONScripter 的默认落点（那个默认落点在 macOS 上**未查到**，猜了就会错）。
 */
export function nscripterSaveDir(ctx: Pick<LaunchContext, 'dataDir' | 'folder' | 'gameTitle'>): string {
  const raw = (ctx.gameTitle ?? '').trim()
  // ⚠️ 游戏名可能是空串或含路径分隔符 —— 这两种都会拼出「指向别的目录」的路径
  const safe = raw && !raw.includes('/') && !raw.includes('\\') ? raw : path.basename(ctx.folder) || 'game'
  return path.join(ctx.dataDir, 'saves', 'nscripter', safe)
}

/**
 * 这个目录里有没有 ONScripter 认的脚本。
 *
 * 判据是**存在任一**（`nscript.dat` / `arc.nsa` / `0.txt`），不是要求全部 ——
 * 不同发行方式只出现其中一个：打包版是 `nscript.dat`+`arc.nsa`，
 * 散装版可能是 `0.txt`（明文脚本）+ 散素材。
 */
export function hasNscripterEntry(folder: string): boolean {
  for (const name of ['nscript.dat', 'arc.nsa', '0.txt']) {
    try {
      if (fs.statSync(path.join(folder, name)).isFile()) return true
    } catch {
      // 不存在就看下一个
    }
  }
  return false
}

/**
 * NScripter 的启动方案。
 *
 * 参数顺序的考虑：
 *   · `--save=` **必须有**（否则存档落进随机目录）
 *   · `--font=` 只在字体文件真的存在时传（**传一个不存在的路径会让它启动即失败**，
 *     与 easyrpg 的 soundfont 同一条经验）
 *   · `--root=` 传游戏目录，明确资源位置（不依赖 cwd）
 *   · 全屏用 `--fullscreen`
 *
 * 找不到二进制时**仍然返回 plan**（binary 指向期望路径），由 ipc 层报可读错误 ——
 * 与 renpy/kirikiri 同一取向。
 */
export function nscripterPlan(ctx: LaunchContext): LaunchPlan {
  const resolved = onscripterBinaryPath(ctx.dataDir)
  const binary = resolved ?? onscripterExpectedPath(ctx.dataDir)

  const saveDir = nscripterSaveDir(ctx)
  const args: string[] = [`--save=${saveDir}`]

  // 字体只在文件真的存在时传（不存在就传 = 启动即失败）
  const font = bundledFontPath(ctx.dataDir)
  try {
    if (fs.statSync(font).isFile()) args.push(`--font=${font}`)
  } catch {
    // 没有就交给 ONScripter 自己的默认（靠游戏目录里的 default.ttf）
  }

  args.push(`--root=${ctx.folder}`)

  if (ctx.gameArgs.fullscreen === true) args.push('--fullscreen')

  return {
    binary,
    args,
    cwd: ctx.folder,
    engine: 'nscripter',
    /**
     * prepare：**确保存档目录存在**。
     *
     * 为什么这是必需的：`--save=` 指到一个不存在的目录时，ONScripter 的行为
     * **未实测**（可能报错、也可能静默回落到默认位置 —— 后者是我们最不想要的，
     * 因为那就回到「存档丢进随机目录」的老问题）。
     * 先建目录是零成本且确定正确的做法。
     *
     * ⚠️ **不碰游戏目录**（D53）：只建 `<dataDir>/saves/nscripter/<游戏>`。
     */
    prepare: () => {
      fs.mkdirSync(saveDir, { recursive: true })
    }
  }
}

/**
 * 「这个目录里找不到 NScripter 的脚本」的可读说明。
 *
 * 用户最常见的原因是**选到了子目录**（比如 `素材/`、`sound/`）或下载的是残包。
 * 让 spawn 报 ENOENT 会误导成「引擎没装」 —— 那是完全无关的事。
 */
export function nscripterMissingEntryMessage(folder: string): string {
  return (
    `这个目录里既没有 nscript.dat 也没有 arc.nsa，不像是 NScripter 的游戏根目录：${folder}\n` +
    '请确认选中的是整个游戏目录（通常是解压后的那一层），而不是里面的某个子目录。'
  )
}
