// M4.0 S3：mkxp-z 的启动方案（D53/D54）。
//
// mkxp-z 与其它三个引擎**不一样**：它不接受命令行参数，启动时读一个配置文件
//
//     <Z-Universal.app>/Contents/Game/mkxp.json
//
// 所以「启动前做点什么」在这里是实质必需的一步（`prepare`），不是可选装饰。
//
// ===== 配置内容怎么决定（这是我们自己的设计，不是照抄上游）=====
//
// mkxp.json 的字段分两类：
//
//   A. **由我们推断/计算**的三项
//      · `gameFolder`   —— 游戏根目录
//      · `rgssVersion`  —— RGSS 版本（0 = 让 mkxp-z 自己判断）
//      · `RTP`          —— RTP 目录数组
//
//   B. **其余全部原样透传**（`smoothScaling` / `vsync` / `windowTitle` / `fontSub` …50 多项）
//      这些是 mkxp-z 自己的配置项，UI 的表单 schema 来自 manifest，
//      「用户改了哪一项就写哪一项」的通则保证不漏键。
//
// A 的三项**复用 M3 的推断**（`decideWantedRtp` + `RTP_BY_RGSS_VERSION` + `normalizeRtpName`），
// 不重写一套（M4.0 §2.4 明确要求）。那一套逻辑是拿真实样本验证过的：
// `Game.ini` 的 `RTP=` → `Library=RGSSxxx.dll` → `Scripts=` 扩展名 → 归档魔数。
//
// ===== 值类型：为什么必须 coerce =====
//
// 表单出来的值大多是**字符串**（`"60"` / `"true"` / `"~/x.sf2"`），而 mkxp.json 是
// mkxp-z 用严格类型读的 JSON：`"rgssVersion": "3"` 与 `3` 是两个东西。
// 所以写盘前统一转：`"true"/"false"` → 布尔、纯数字串 → 数字、`~/` 展开成绝对路径。
// 这一步做错的表现是「某个选项设置无效」，不报错、极难查。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  RTP_BY_RGSS_VERSION,
  decideWantedRtp,
  normalizeRtpName,
  readGameIni,
  resolveGameDir
} from '../diagnose'
import { expandDataDirPlaceholders } from '../engines/registry'
import { mkxpzBinaryPath, mkxpzRtpDir } from './binary-paths'
import type { LaunchContext, LaunchPlan } from './types'

/** mkxp-z 认的「自动判断」值（`rgssVersion: 0`）。 */
export const RGSS_AUTO = 0

/** 展开 `~/` 前缀。 */
export function expandTilde(value: string, homedir: string = os.homedir()): string {
  if (value.startsWith('~/')) return path.join(homedir, value.slice(2))
  return value
}

/**
 * 把表单值转成 mkxp.json 认的类型。
 *
 * 只处理三种「看起来像别的类型」的字符串：布尔、数字、`~/` 路径。
 * **不做**乐观转换（比如把 `"1e5"` 转成数字 100000）——那会改变用户的语义。
 */
export function coerceValue(value: unknown, homedir: string = os.homedir()): unknown {
  if (Array.isArray(value)) return value.map((item) => coerceScalar(item, homedir))
  if (value && typeof value === 'object') {
    // 浅层递归：mkxp.json 里没有深层嵌套的配置项，但保险起见处理一层
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = coerceValue(item, homedir)
    }
    return out
  }
  return coerceScalar(value, homedir)
}

function coerceScalar(value: unknown, homedir: string): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed) return value
  const lower = trimmed.toLowerCase()
  if (lower === 'true') return true
  if (lower === 'false') return false
  // 只认**整数**字符串（`"3"` / `"-1"`）。浮点不转：`"1.5"` 当路径更不可能，
  // 而当数字转进去反而不符合表单里那几个 float 项的默认值写法（它们本来就是数字）。
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed)
  return expandTilde(trimmed, homedir)
}

export interface MkxpConfig {
  gameFolder: string
  RTP: string[]
  rgssVersion: number
  [key: string]: unknown
}

/** 一次 RTP 决策的结果（`decideWantedRtp` 的产物 + 最终用于 mkxp.json 的目录）。 */
export interface RtpDecision {
  /** `mkxp.json` 里的 `RTP` 数组（绝对路径）。 */
  rtpDirs: string[]
  /** 写进 `mkxp.json` 的 `rgssVersion`（0 = mkxp-z 自己判断）。 */
  rgssVersion: number
  /** 推断来源（排障与日志用）。 */
  source: 'gameArgs' | 'ini' | 'library' | 'scripts' | 'archive' | 'unknown'
  /** 推断出的规范 RTP 目录名（`Standard` / `RPGVX` / `RPGVXace`）；null = 未确定。 */
  rtpName: string | null
}

/**
 * 决定这次启动的 RTP 与 rgssVersion。
 *
 * 优先级（**用户显式设置 > 本地推断**）：
 *   1. `gameArgs.rgssVersion` 是 1/2/3 → 用它，RTP 名由它映射（用户已在表单里选定了版本）
 *   2. `gameArgs.RTP` 是非空数组 → 用用户给的路径（`~/` 展开），rgssVersion 仍按 1 或推断
 *   3. 都没有 → 用 M3 的 `decideWantedRtp` 从本地文件特征推断
 *
 * 与上游的一处**刻意不同**（这是设计决定，不是疏漏）：
 *   上游在「推断不出来」时兜底 `["Standard", 1]`（即默认当 XP 给 Standard RTP）。
 *   我们不兜底——推断不出来就 `rgssVersion = 0`（让 mkxp-z 自己判断）+ RTP 空数组。
 *   理由：给一个错版本的 RTP 会污染游戏的素材查找路径（找不到的文件会去 RTP 里找），
 *   而「什么都不给」只是缺素材，且 mkxp-z 自己的判断往往比我们的兜底更准。
 */
export function resolveRtp(ctx: LaunchContext, homedir: string = os.homedir()): RtpDecision {
  const rawVersion = ctx.gameArgs.rgssVersion
  const explicitVersion =
    rawVersion === undefined || rawVersion === null || String(rawVersion).trim() === ''
      ? null
      : Number(String(rawVersion).trim())

  // 用户给的 RTP 路径优先（非空数组才算「给了」）
  const rawRtp = ctx.gameArgs.RTP
  const userRtp =
    Array.isArray(rawRtp)
      ? rawRtp
          .filter((item): item is string => typeof item === 'string')
          .map((item) => item.trim())
          .filter(Boolean)
          .map((item) => expandTilde(item, homedir))
      : []

  const validVersion = explicitVersion === 1 || explicitVersion === 2 || explicitVersion === 3 ? explicitVersion : null

  if (validVersion) {
    const rtpName = RTP_BY_RGSS_VERSION[validVersion]
    return {
      rtpDirs: userRtp.length > 0 ? userRtp : [mkxpzRtpDir(ctx.dataDir, rtpName)],
      rgssVersion: validVersion,
      source: 'gameArgs',
      rtpName
    }
  }

  // 没显式版本 → 本地推断（复用 M3）
  const dir = resolveGameDir(ctx.folder)
  const ini = readGameIni(dir)
  const wanted = decideWantedRtp(dir, ini)

  // ⚠️ M3 的 `decideWantedRtp` 只从 `RTP=` 推出**目录名**，`rgssVersion` 要靠 `Library=`
  // 才拿得到。但目录名本身就确定了版本（`RPGVXace` 必是 3）——所以这里反查一次。
  // 不反查的后果：`RTP=RPGVXace` 但没写 `Library=` 的游戏会得到 rgssVersion=0，
  // 于是我们告诉 mkxp-z「你自己判断」，它可能要试几次才知道该起哪个 RGSS 运行时。
  const inferredVersion = wanted.rgssVersion ?? (wanted.rtp ? versionOfRtpName(wanted.rtp) : null)

  const rtpDirs =
    userRtp.length > 0
      ? userRtp
      : wanted.rtp
        ? [mkxpzRtpDir(ctx.dataDir, wanted.rtp)]
        : []

  return {
    rtpDirs,
    // 推断不出就 0（让 mkxp-z 自己判断），**不兜底一个猜的版本**
    rgssVersion: inferredVersion ?? RGSS_AUTO,
    source: wanted.source === 'ini' && !wanted.rtp ? 'ini' : wanted.source,
    rtpName: wanted.rtp
  }
}

/**
 * 由规范 RTP 目录名反查 RGSS 版本（`RPGVXace` → 3）。
 *
 * 单独的导出便于单测直接钉住这条反向映射（正反两向都要对，否则一边改了另一边静默错位）。
 */
export function versionOfRtpName(rtpName: string): 1 | 2 | 3 | null {
  const normalized = normalizeRtpName(rtpName)
  if (!normalized) return null
  for (const [version, name] of Object.entries(RTP_BY_RGSS_VERSION)) {
    if (name === normalized) return Number(version) as 1 | 2 | 3
  }
  return null
}

/**
 * 造 `mkxp.json` 的内容（**纯函数**，不碰磁盘，便于单测逐字段断言）。
 */
export function buildMkxpConfig(ctx: LaunchContext, homedir: string = os.homedir()): MkxpConfig {
  const decision = resolveRtp(ctx, homedir)

  // 其余参数原样透传（转成 mkxp.json 认的类型）
  const passthrough: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(ctx.gameArgs)) {
    if (key === 'rgssVersion' || key === 'RTP') continue // 这两项由上面算出来
    if (value === null || value === undefined) continue
    const cleaned = sanitize(value, ctx, homedir)
    if (cleaned !== undefined) passthrough[key] = cleaned
  }

  return {
    gameFolder: ctx.folder,
    RTP: decision.rtpDirs,
    rgssVersion: decision.rgssVersion,
    ...passthrough
  }
}

/** 写 `mkxp.json`（4 空格缩进，与 mkxp-z 的示例配置一致，便于用户手改时看）。 */
export function writeMkxpConfig(file: string, config: MkxpConfig): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(config, null, 4), 'utf8')
}

// ===== 指向「别人家目录」的默认值：一律丢掉 =====
//
// 引擎模块的 manifest 里，有些 gameArgs 的 default 写死了**另一套程序的数据目录**：
// preloadScript 的默认值指到一个不存在的预载脚本、midiSoundFont 指到一个不存在的音源。
// 那是模块作者按他自己的安装位置写的，在我们这台机器上必然不存在。
//
// 留着它们的后果**全是静默的**：
//   · 预载脚本读不到 → 补丁层不生效（某些游戏表现异常，但不报错）
//   · 音源读不到   → MIDI 音乐静音（不报错）
// 用户只会觉得「这游戏有点怪」，查不出原因。
//
// 规则只有一条，而且**不写死任何名字**：
//
//   一个绝对路径，如果**不在我们的数据目录里**，但它的前面出现了 `/modules/` 这一层，
//   说明它是「某套程序的数据目录/modules/...」——指到别人家去了，丢掉。
//
// 「数据目录/modules/」是我们和上游都遵守的目录约定（引擎模块就装在这里）。
// 所以判据是：`/modules/` 之前的那个目录是不是我们自己的。
// 不是 → 别人的 → 丢掉。
//
// 这样写的好处：
//   · 代码里不出现任何具体程序的名字（不写死别人的目录名）
//   · 不管上游把数据目录叫什么，只要有 modules 这一层就被认出来
//   · 用户自己填的、跟 modules 无关的路径（`/Users/x/MyStuff/a.rb`）完全不受影响

/** 从 `<前缀>/modules/<...>` 里取出 `<前缀>`（已归一化分隔符）；不含 `/modules/` 时返回 null。 */
function modulesParent(target: string): string | null {
  const unified = target.split(String.fromCharCode(92)).join('/')
  const marker = '/modules/'
  const index = unified.lastIndexOf(marker)
  if (index < 0) return null
  return unified.slice(0, index)
}

/**
 * 这个绝对路径是不是**指向别人家的数据目录**。
 *
 * 只有一种情况返回 true：路径里带 `/modules/`，且它的前缀**不是**我们自己的数据目录。
 *
 * 其余全部保留（返回 false）：
 *   · 相对路径 / 纯文件名（游戏自己的东西）
 *   · 我们自己的 `<dataDir>/modules/...`（真能用）
 *   · 跟 modules 无关的任意路径（用户自己填的、系统字体/音源等）
 */
export function pointsElsewhere(value: string, dataDir: string): boolean {
  if (!value) return false
  const unified = value.split(String.fromCharCode(92)).join('/')
  if (!unified.startsWith('/')) return false
  const parent = modulesParent(unified)
  if (parent === null) return false
  const dataRoot = dataDir.split(String.fromCharCode(92)).join('/')
  const ours = dataRoot.endsWith('/') ? dataRoot.slice(0, -1) : dataRoot
  return parent !== ours
}

/**
 * 逐项过一遍 gameArgs：先转类型，然后丢掉指向别人家数据目录的值。
 *
 * 数组逐元素判断（preloadScript 是数组），丢空了就整项不写——
 * 写一个空的 [] 进 mkxp.json 毫无意义。
 */
function sanitize(value: unknown, ctx: LaunchContext, homedir: string): unknown {
  if (Array.isArray(value)) {
    const kept = value
      .map((item) => sanitize(item, ctx, homedir))
      .filter((item) => item !== undefined)
    return kept.length > 0 ? kept : undefined
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const cleaned = sanitize(item, ctx, homedir)
      if (cleaned !== undefined) out[key] = cleaned
    }
    return Object.keys(out).length > 0 ? out : undefined
  }
  const coerced = coerceValue(value, homedir)
  if (typeof coerced === 'string' && pointsElsewhere(coerced, ctx.dataDir)) return undefined
  return coerced
}

export function mkxpzPlan(ctx: LaunchContext, homedir: string = os.homedir()): LaunchPlan {
  const binary = mkxpzBinaryPath(ctx.dataDir)
  // ⚠️ 写在**游戏目录**里，不是 app 包内（M5.1 修的）：
  //
  // mkxp-z 按 **cwd** 找 `mkxp.json`，而我们的 spawn 传了 `cwd: ctx.folder`（游戏目录）。
  // 原来写进 `Z-Universal.app/Contents/Game/mkxp.json` → **它根本读不到** →
  // 没有 gameFolder / rgssVersion → 弹 mkxp-z 自己的英文错误
  // 「No script file has been specified. Check the game's INI and try again.」
  // （用户 mac 实测，`傭兵の冒険_CHN` 完美解包却打不开）。
  //
  // 写到游戏目录 = 与 cwd 一致，mkxp-z 必然找得到。代价是游戏目录里多一个 `mkxp.json`，
  // 这是可接受的（启动器给游戏写配置是通行做法，且它只影响启动参数，不改游戏数据）。
  //
  // 顺带：同名文件若已存在（用户手改过 / 上次启动留下的），直接覆盖 —— 配置是
  // 「每次启动按当前设置重新生成」的，不该沿用旧值（否则用户在编辑页改的参数不生效）。
  const configFile = path.join(ctx.folder, 'mkxp.json')

  // M4.1 S1/S3（D62）：manifest 里的默认值带 `<dataDir>` 占位符（例如
  // preloadScript 的 `<dataDir>/modules/mkxpz/deps/kawariki/kawariki/preload.rb`）。
  // 它**只能在启动时展开**——manifest 属于「引擎定义」，数据目录属于「这台机器的安装」。
  //
  // ⚠️ 顺序很关键：**先展开再 sanitize**。
  //   `sanitize` 会丢掉「指向别人家数据目录」的绝对路径（判据是路径里带 `/modules/`
  //   但前缀不是我们的）。如果先 sanitize，占位符还没展开就变成了一个不含 `/modules/`
  //   的字符串，判断落空 → 侥幸保住；但等它展开后就成了真实绝对路径，而**判据已经跑过了**，
  //   该报错的地方报不出来。先展开，sanitize 才能在真实路径上做判断。
  const expandedArgs = expandDataDirPlaceholders(ctx.gameArgs, ctx.dataDir)

  return {
    binary,
    // mkxp-z **不接受命令行参数**，一切配置走 mkxp.json
    args: [],
    cwd: ctx.folder,
    engine: 'mkxpz',
    prepare() {
      writeMkxpConfig(configFile, buildMkxpConfig({ ...ctx, gameArgs: expandedArgs }, homedir))
    }
  }
}

/** 配置目录（排障用）：mkxp.json 现在写在游戏目录里，这里返回「它会写到哪」。 */
export function mkxpzConfigLocation(gameFolder: string): string {
  return path.join(gameFolder, 'mkxp.json')
}
