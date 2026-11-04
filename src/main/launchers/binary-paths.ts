// 四个引擎可执行文件路径的**唯一来源**（D56）。
//
// 上游把路径硬编码在每个 launcher.js 里（四处各一份），上游一改路径就得改四处。
// 这里集中成一组纯函数：只拼字符串 + 少数几处 readdir（renpy 要扫版本目录）。
//
// 路径拼法**照抄上游实测**（docs/M4.0-实施方案.md §2.2，用户已实测，不要改）：
//
//   nwjs:     <data>/modules/nwjs/deps/version/<version>/nwjs-sdk-<version>-osx-<arch>/nwjs.app/Contents/MacOS/nwjs
//   mkxpz:    <data>/modules/mkxpz/deps/mkxpz/Z-Universal.app/Contents/MacOS/Z-Universal
//   easyrpg:  <data>/modules/easyrpg/deps/player/EasyRPG Player.app/Contents/MacOS/EasyRPG Player
//   renpy:    <data>/modules/renpy/deps/renpy/renpy.sh  或  <data>/modules/renpy/deps/renpy/renpy-<x.y.z>-sdk/renpy.sh
//
// ⚠️ nwjs 的 <arch> 是 **os.arch()**（`arm64` / `x64`），不是 process.arch 的语义差别——
//    两者在 mac 上恰好同名，但用户真机上出问题就出在「以为可以随便换」。这里只接受调用方
//    传进来的 arch 字符串，绝不自己读 process（便于单测覆盖 arm64 / x64 两种）。
//
// ⚠️ 这些路径是 **macOS 布局**（.app bundle）。Windows 开发机上同样返回这套拼法——
//    这只是路径计算，不 stat 就不会出错；真正的 stat / spawn 发生在 mac 上。
//    单测因此在 Windows 上也能跑（这也是为什么本文件**不 import electron**）。
//
// 为什么不用 `app.getPath('home')` 之类：数据目录由 core-host 的 resolveDataDir 决定
// （mac 上 D58 切到 Tsumigeya），这里只负责「在给定数据目录下，引擎二进制在哪」。
import fs from 'node:fs'
import path from 'node:path'

/** 模块目录的子目录名（与上游 module.js 的约定一致）。 */
export const MODULES_DIR_NAME = 'modules'

/** 引擎文件夹名（= manifest / 数据目录里的目录名，也是 gameEngine 字段的值）。 */
export const ENGINE_IDS = ['nwjs', 'mkxpz', 'easyrpg', 'renpy'] as const

export type EngineId = (typeof ENGINE_IDS)[number]

/** `<数据目录>/modules/<引擎>`。 */
export function moduleDir(dataDir: string, engine: string): string {
  return path.join(dataDir, MODULES_DIR_NAME, engine)
}

/** `<数据目录>/modules/<引擎>/deps[/seg...]`（依赖解压后的根）。 */
export function depsDir(dataDir: string, engine: string, ...segments: string[]): string {
  return path.join(moduleDir(dataDir, engine), 'deps', ...segments)
}

/**
 * NW.js 的可执行文件（`nwjs.app/Contents/MacOS/nwjs`）。
 *
 * `version` 必须是 deps 下的**真实目录名**（典型是 `v0.106.1`，带 v）。
 * 用户没选版本时上游兜底 `0.106.1`（不带 v）→ 路径不存在 → 点启动没反应；
 * 我们由 `core-host.reconcileVersionArgs` 先修正成真实目录名再传进来。
 */
export function nwjsBinaryPath(dataDir: string, version: string, arch: string): string {
  return path.join(
    depsDir(dataDir, 'nwjs'),
    'version',
    version,
    `nwjs-sdk-${version}-osx-${arch}`,
    'nwjs.app',
    'Contents',
    'MacOS',
    'nwjs'
  )
}

/** NW.js 的版本根目录（`deps/version`）——「有没有装过任何版本」的判断用它。 */
export function nwjsVersionsDir(dataDir: string): string {
  return depsDir(dataDir, 'nwjs', 'version')
}

/** mkxp-z 的可执行文件（`Z-Universal.app/Contents/MacOS/Z-Universal`）。 */
export function mkxpzBinaryPath(dataDir: string): string {
  return path.join(
    depsDir(dataDir, 'mkxpz'),
    'mkxpz',
    'Z-Universal.app',
    'Contents',
    'MacOS',
    'Z-Universal'
  )
}

/**
 * mkxp-z 的 app 包内 `Contents/Game` 目录。
 *
 * ⚠️ **`mkxp.json` 不写在这里**（M5.1 改）：mkxp-z 按 **cwd** 找配置，而我们的 spawn
 * 传 `cwd: 游戏目录`。写在 app 包里它读不到 → 报
 * 「No script file has been specified」。
 * 配置现在写在 `<游戏目录>/mkxp.json`（见 `mkxpz.ts` 的 `mkxpzPlan`）。
 *
 * 这个函数保留是因为**排障时要知道用户以前把配置写在哪**（老版本的残留文件）。
 */
export function mkxpzConfigDir(dataDir: string): string {
  return path.join(depsDir(dataDir, 'mkxpz'), 'mkxpz', 'Z-Universal.app', 'Contents', 'Game')
}

/**
 * mkxp-z 的 RTP 根目录（`deps/RTP/RTP`）——给定**引擎目录**（`<数据目录>/modules/mkxpz`）。
 *
 * 为什么单独有「给定引擎目录」的版本：诊断（diagnose.ts）拿到的是 `modulesDir + engine`
 * 拼出来的引擎目录，而不是数据目录本身。两个入口都指向同一个常量拼法，
 * 才谈得上「唯一来源」（D56）——否则诊断说缺、启动却填另一个路径，会互相打脸。
 */
export function mkxpzRtpRootFromEngineDir(engineDir: string): string {
  return path.join(engineDir, 'deps', 'RTP', 'RTP')
}

/** mkxp-z 的 RTP 目录（`deps/RTP/RTP/<名字>`），给定引擎目录。 */
export function mkxpzRtpDirFromEngineDir(engineDir: string, rtpName: string): string {
  return path.join(mkxpzRtpRootFromEngineDir(engineDir), rtpName)
}

/**
 * mkxp-z 的 RTP 目录，给定**数据目录**（启动时填 `mkxp.json` 的 `RTP` 用这个）。
 *
 * 与上面的 `...FromEngineDir` 是同一个拼法，两种入参各有其调用方（见上面的注释）。
 */
export function mkxpzRtpDir(dataDir: string, rtpName: string): string {
  return mkxpzRtpDirFromEngineDir(moduleDir(dataDir, 'mkxpz'), rtpName)
}

/** EasyRPG Player 的可执行文件（`EasyRPG Player.app/Contents/MacOS/EasyRPG Player`）。 */
export function easyrpgBinaryPath(dataDir: string): string {
  return path.join(
    depsDir(dataDir, 'easyrpg'),
    'player',
    'EasyRPG Player.app',
    'Contents',
    'MacOS',
    'EasyRPG Player'
  )
}

/**
 * EasyRPG 的默认音源（`deps/soundfont/GMGSx.SF2`）。
 *
 * 用户没设音源时上游会自动注入它（只在文件真的存在时）。不存在就别传，
 * 让 EasyRPG 用内建的——传一个不存在的路径会让它启动即报错。
 */
export function easyrpgSoundfontPath(dataDir: string): string {
  return depsDir(dataDir, 'easyrpg', 'soundfont', 'GMGSx.SF2')
}

/** Ren'Py 的依赖根目录（`deps/renpy`）。 */
export function renpyDepsDir(dataDir: string): string {
  return depsDir(dataDir, 'renpy', 'renpy')
}

/** 上游认的 Ren'Py SDK 目录名（`renpy-8.3.4-sdk`）。 */
const RENPY_SDK_DIR = /^renpy-\d+\.\d+\.\d+-sdk$/

/**
 * 找 Ren'Py 的启动脚本（`renpy.sh`）。
 *
 * 两种布局都认（上游同样两种都认）：
 *   1. `deps/renpy/renpy.sh`（直接放）
 *   2. `deps/renpy/renpy-<x.y.z>-sdk/renpy.sh`（解压出来的 SDK，**取版本号最大的一版**）
 *
 * 排序用 `localeCompare(..., { numeric: true })`：只按字符串比会把 `renpy-8.3.4-sdk`
 * 排在 `renpy-10.0.0-sdk` 后面（"10" < "8"），拿到的就是旧版。
 *
 * 找不到返回 `null`（不猜、不造路径）——调用方据此报中文的可操作提示。
 */
export function renpyBinaryPath(dataDir: string): string | null {
  const root = renpyDepsDir(dataDir)
  const direct = path.join(root, 'renpy.sh')
  if (isFileSafe(direct)) return direct

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }

  const candidates = entries
    .filter((entry) => entry.isDirectory() && RENPY_SDK_DIR.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))

  for (const folder of candidates) {
    const candidate = path.join(root, folder, 'renpy.sh')
    if (isFileSafe(candidate)) return candidate
  }
  return null
}

/** 列出已装的所有 Ren'Py SDK 版本目录（排障与「装了什么」提示用；不影响启动）。 */
export function renpyInstalledSdks(dataDir: string): string[] {
  try {
    return fs
      .readdirSync(renpyDepsDir(dataDir), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && RENPY_SDK_DIR.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  } catch {
    return []
  }
}

/** 存在且是文件（不抛）。 */
function isFileSafe(target: string): boolean {
  try {
    return fs.statSync(target).isFile()
  } catch {
    return false
  }
}
