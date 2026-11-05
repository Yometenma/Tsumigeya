// M6 S2：TyranoScript 的启动方案（D53/D54）。
//
// ===== 为什么它复用 NW.js，而不是自己下一份运行时 =====
//
// TyranoScript 是 **HTML5 引擎**：游戏本体就是 `index.html` + `tyrano/` + `data/`
// 的网页目录（官方教程明写「ブラウザゲームとして配布する場合はプロジェクトフォルダ
// 以下のファイルを丸ごとサーバーにアップ」）。
//
// 而 NW.js 就是一个浏览器壳：`nw <含 package.json 的目录>`。
// **两者形态天然同构** —— 所以 Tyrano 游戏用我们已有的 NW.js 运行时加载就行，
// 不需要为它写一个新的引擎二进制，也不需要新的下载地址（registry 里 dependencies 是空的）。
//
// 这是全清单里**成本最低的一档**，原因就在这：不是「再加一个引擎」，
// 而是「让已有的 nwjs 支持多一种游戏目录」。
//
// ===== 三种 Windows 分发包形态（复述 registry 的注释，这里只讲启动侧的处置）=====
//
//   ① 未打包目录：`tyranoscript.exe` + `game/`（内含 index.html、tyrano/、data/）
//   ② `app.nw`：项目打成 zip 后改名，与 exe 并排
//   ③ 单文件 `game.exe`：`copy /b tyranoscript.exe+app.nw game.exe`（zip 拼在 exe 尾部）
//
// **本文件只处理 ①② 的「目录已经在磁盘上」这种情况**：直接 `nw <目录>`。
// 形态 ③ 需要「读 exe 尾部找 zip → 解包」的 prepare 步骤，**必须先有真机样本实测**
// 才敢写（见 docs/引擎范围扩展-实施方案.md §8-B）。在那之前它会被识别失败、
// 落到「未知引擎」，用户得到的是「本版本不支持」而不是静默失败——这是**有意的保守**。
//
// ===== 不写游戏目录（D53）=====
//
// NW.js 需要一个 `package.json` 指明 `main`。**很多 Tyrano 分发包没有这个文件**
// （它自己那个 `tyranoscript.exe` 已经内嵌了入口）。
// 那怎么办？**在 `<dataDir>` 里造一个 shim 目录，不碰游戏目录**：
//
//   <dataDir>/modules/tyrano/shim/<gameId>/package.json   ← 我们写的，指向游戏目录
//   <dataDir>/modules/tyrano/shim/<gameId>/index.html     ← 我们写的，转跳/加载游戏
//
// 但**本版本先不自动造 shim**：因为「shim 里到底该写什么」取决于 Tyrano 各版本的入口
// 约定（V4 是 `tyrano.js` + `index.html`，V5/V6 有差别），没实测就写是赌。
// 所以本版本的行为是：
//   · 游戏目录**有** `package.json`（含 main） → 直接 `nw <游戏目录>`（正常路径）
//   · 没有 → 返回一个**明确的失败**，告诉用户「这个分发包缺少 package.json，
//     暂时无法自动启动」+ 期望路径。**不猜、不静默、不写游戏目录。**
//
// 这条边界与 D57 的精神一致：宁可明确报错，也不做「看起来成功了」的假动作。
import fs from 'node:fs'
import path from 'node:path'
import { nwjsBinaryPath } from './binary-paths'
import type { LaunchContext, LaunchPlan } from './types'

/**
 * 判断一个目录能不能直接喂给 `nw`。
 *
 * NW.js 的硬要求是根上有 `package.json`，且其中 `main` 指向一个存在的入口
 * （不写 `main` 时它默认找 `index.html`）。这里**只检查 package.json 是否存在且是文件**，
 * 不解析 main —— 解析 JSON 失败/字段缺失会让「明明能跑的游戏」被我们判成不能跑，
 * 而 NW.js 自己会报一个更准确的错。
 *
 * 为什么不需要判断 `index.html`：`nw` 对没有 main 的 package.json 会退回 `index.html`，
 * 而 Tyrano 的目录里一定有它（`tyrano/` 和 `data/` 是判据，已经保证是 Tyrano 工程）。
 */
export function canLaunchAsNwDirectory(folder: string): boolean {
  const manifest = path.join(folder, 'package.json')
  try {
    return fs.statSync(manifest).isFile()
  } catch {
    return false
  }
}

/**
 * TyranoScript 的启动方案。
 *
 * **与 nwjsPlan 的关系**：binary / args 的拼法与它一致（同一个运行时、同样的参数顺序），
 * 但多了一道 `canLaunchAsNwDirectory` 前置检查，并把 `engine` 标成 `tyrano`
 * （诊断、日志、进程表都靠这个字段区分「这是哪种游戏」）。
 *
 * 找不到 NW.js 运行时时的处置与 nwjsPlan 相同：**仍然返回 plan**（binary 指向「本该在那」），
 * 由 ipc 层统一按「可执行文件不存在」处理，这样错误文案能带上期望路径。
 *
 * ⚠️ 参数顺序照抄 nwjsPlan 的实测结论：Chromium 开关必须放在**游戏目录之后**
 * （放前面会被 NW.js 当成它自己的参数）。那个结论是 mac 真机测出来的，别改。
 */
export function tyranoPlan(ctx: LaunchContext): LaunchPlan {
  const version = String(ctx.gameArgs.version ?? '')
  const binary = nwjsBinaryPath(ctx.dataDir, version, ctx.arch)
  const args: string[] = [ctx.folder]
  if (ctx.gameArgs.fullscreen === true) {
    args.push('--start-fullscreen')
  }
  return {
    binary,
    args,
    cwd: ctx.folder,
    engine: 'tyrano'
  }
}

/**
 * 「这个 Tyrano 分发包缺少 package.json」的可读说明。
 *
 * 为什么要专门有一句而不是让 spawn 报 `ENOENT`：
 * 用户看到「找不到可执行文件」，会以为是自己没装引擎，跑去引擎页重装一遍 —— 白折腾。
 * 真实原因是**这个游戏的分发包形态**（作者打包时没带 package.json），
 * 跟引擎装没装完全无关。
 */
export function tyranoMissingManifestMessage(folder: string): string {
  return (
    `这个 TyranoScript 分发包缺少 package.json，暂时无法自动启动：${folder}\n` +
    '（这是游戏分发包的形态问题，与引擎是否安装无关。' +
    '若是单文件 exe 形态的分发包，本版本暂不支持。）'
  )
}
