// M4.0 S2：nwjs 的启动方案（D53/D54）。
//
// 上游 nwjs/launcher.js 542 行，真正启动在第 534 行：
//     exec(`"${nwjsPath}" "${gameFolder}"`)
// 其余 533 行全是附加功能，**我们一律不做**（D53 / §10-③）：
//   · copyCheatFiles / removeCheatFiles        往游戏目录塞作弊文件
//   · modifyMVMainJs / modifyMZMainJs          **改写游戏的 js/main.js**
//   · applyProtection / removeProtection       改 package.json 的 chromium-args
//   · addChromiumArg / ensureChromiumArgsField 同上
//   · patchRpgmGetPixel                        改游戏取色函数
//   · package.json 里补 name                   写用户的游戏文件
//
// 自实现启动的**默认行为就是「不碰游戏目录」**——这是 M4.0 最主要的收益（动机 A）。
//
// ⚠️ 未决风险 R2：上游会往 package.json 塞 `chromium-args`。我们不改，
//    待 mac 真机对比「同一游戏用上游 vs 自实现」的行为差异（见方案 §7 R2）。
//    若无差异就不加；若确有差异再评估。**不要在没实测前自己加参数。**
import fs from 'node:fs'
import { nwjsBinaryPath } from './binary-paths'
import type { LaunchContext, LaunchPlan } from './types'

/**
 * NW.js 的启动方案。
 *
 * 参数只有一个：游戏目录。NW.js 自己会读 `<游戏目录>/package.json` 决定主进程脚本。
 *
 * `version` 必须已经是 deps 下的**真实目录名**（`v0.106.1`）——由
 * `core-host.reconcileVersionArgs` 在启动前修正（见 M4.0 §4「必须保留」清单）。
 */
export function nwjsPlan(ctx: LaunchContext): LaunchPlan {
  const version = String(ctx.gameArgs.version ?? '')
  const binary = nwjsBinaryPath(ctx.dataDir, version, ctx.arch)
  return {
    binary,
    // 不拼命令行字符串（D54）：args 数组天然处理空格/中文/引号
    args: [ctx.folder],
    cwd: ctx.folder,
    engine: 'nwjs'
  }
}

/** NW.js 的启动前置检查：可执行文件必须在，否则给出含**期望路径**的可读失败。 */
export function nwjsMissingBinaryMessage(binary: string, version: string): string {
  return (
    `找不到 NW.js 运行时：${binary}\n` +
    `请在「引擎管理」里为 NW.js 安装一个版本（当前记录的版本是 "${version || '未设置'}"）。`
  )
}

/** 可执行文件是否存在（不抛）。 */
export function binaryExists(target: string): boolean {
  try {
    return fs.statSync(target).isFile()
  } catch {
    return false
  }
}
