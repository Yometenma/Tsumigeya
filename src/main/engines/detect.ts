// M4.2 S2-②：引擎自动识别（D63 的自实现判决）+ 已装引擎目录列表。
//
// ===== 这个文件替代了什么 =====
//
// `module.js` 的三个 API（方案 §1.1 判「自实现」）：
//   · `detectEngineForPath(exe, manifests)`        ← 用**已装模块的 manifest** 的 autodetect
//   · `detectEngineFromAutodetectMap(exe, defs)`   ← 用**registry 的规则**（未装也能认）
//   · `getInstalledModuleFolders()`                ← modules 下的目录名
//
// 后两个的算法在 module.js 里是**一模一样的两份代码**（1209–1278 行与 1310–1372 行）。
// 这里合成一个 `scoreEngineForPath()`，两个导出各调一次 —— 只有一份算法，
// 就不会出现「装了引擎能认出来、没装引擎认不出来」这种分叉。
//
// ===== ⚠️ R1：`.app` 包与「文件在子目录里」=====
//
// 方案 §2.2 把这个点列为**头号风险**：漏掉 `isAppBundlePath` 语义，
// macOS 上 .app 游戏会识别不出来。三处细节必须保留，每处都有单测钉着：
//
//   ① **`.app` 是目录，探测点就是它本身，不是它的父目录**
//      `gameDirForFiles('/x/Game.app')` → `/x/Game.app`
//      而 `gameDirForFiles('/x/Game.exe')` → `/x`
//      漏掉的话：mac 的 Ren'Py / NW.js 包内文件探测会全落在父目录 → 一个都探不到。
//
//   ② **路径可能以斜杠结尾**：`/x/Game.app/` 也是 .app
//      光用 `path.dirname` 会得到 `/x/Game.app`（正确，纯属巧合）；但
//      `path.extname('/x/Game.app/')` 得到 `''`（因为尾斜杠），于是 ext 判断失败。
//      所以取扩展名之前必须先剥尾分隔符。
//
//   ③ **尾斜杠剥除要连同 `file://` 之外的所有形式**：上游写的是 `/[\\/]+$/`，
//      正反斜杠都剥（Windows 上用户粘的路径可能是反斜杠）。
import fs from 'node:fs'
import path from 'node:path'
import type { ManifestRaw, ManifestAutodetect } from './manifest'

// ===== 路径工具（照抄 module.js 的语义） =====

/**
 * 归一化扩展名：**不带点、小写**。
 *
 * 上游 `normalizeExt` 是 `replace(/^\.+/, '').toLowerCase()` —— 剥**任意多个**前导点。
 * 所以 `.py` 与 `py` 都是 `py`，而 `..py` 也是 `py`。
 *
 * 但要注意它**不会**剥掉中间的点：`tar.gz` 会保持 `gz`（取最后一段）。
 */
export function normalizeExt(ext: string | undefined | null): string {
  if (!ext) return ''
  return String(ext).replace(/^\.+/, '').toLowerCase()
}

/**
 * 取路径的扩展名（不带点、小写），**先剥尾分隔符**。
 *
 * 上游 `getPathExtLower` 的等价物。为什么不用 `path.extname` 就完事：
 * 因为 `/x/Game.app/` 这种尾斜杠会让 `path.extname` 返回空串，
 * 而 mac 上用户从 Finder 拖进来的路径**经常带尾斜杠**。
 */
export function getPathExtLower(input: string | undefined | null): string {
  if (!input) return ''
  const trimmed = String(input).trim().replace(/[\\/]+$/, '')
  const base = path.basename(trimmed)
  const index = base.lastIndexOf('.')
  return index >= 0 ? base.slice(index + 1).toLowerCase() : ''
}

/**
 * 这个路径是不是 macOS 的 `.app` 包（**只看扩展名，不碰 fs**）。
 *
 * 「不碰 fs」是有意的：上游的注释写的就是 "Detects macOS .app bundles by extension only"。
 * 好处是这个判断在单测里不依赖真实符号链接/目录；坏处是 `MyFiles.app` 这种普通目录
 * 也会被判成 .app —— 但那种名字在游戏库里不会出现，可接受。
 */
export function isAppBundlePath(input: string | undefined | null): boolean {
  return normalizeExt(getPathExtLower(input)) === 'app'
}

/**
 * 「探测 autodetect 的 `files` 时该看哪个目录」。
 *
 * · `.app` 包 → **它自己**（包里才该有 `renpy/` / `package.json`）—— 见 R1 第 ① 条
 * · 普通可执行文件 → 它的**父目录**
 *
 * ⚠️ 剥尾斜杠（`String(exe).replace(/[\\/]+$/, '')`）不能省：
 * `path.dirname('/x/Game.app/')` 返回 `/x/Game.app`，看似对，但随后
 * `path.join('/x/Game.app', 'renpy/')` 会在某些平台拼成 `/x/Game.app/renpy` —— 正确；
 * 而如果不剥就直接把 `/x/Game.app/` 当探测点，`path.join` 会把尾斜杠吃掉变成
 * `/x/Game.app/renpy`，也对。**两处都对，但只有剥了之后 .app 判定才成立**，
 * 所以剥的理由是 R1 第 ② 条（extname 需要它），不是 join。
 */
export function gameDirForFiles(exe: string): string {
  return isAppBundlePath(exe) ? String(exe).trim().replace(/[\\/]+$/, '') : path.dirname(exe)
}

// ===== 打分（两个 API 共用的一算法） =====

/** 一条 autodetect 规则（两个来源——manifest 与 registry——都归一到这个形状）。 */
export interface DetectRule {
  extensions?: string[]
  files?: string[]
  all_required?: boolean
}

interface Scored {
  key: string
  score: number
  fileMatches: number
  extMatch: boolean
  allRequired: boolean
}

/**
 * 给所有规则打分，返回「命中的最好那个 key」。
 *
 * 语义**逐条照抄** `module.js`（这是识别正确与否的全部依据，不要"简化"）：
 *
 *   ① `all_required: true` —— 硬门槛
 *      有扩展名规则就必须命中，有文件规则就必须**全部**在场。
 *      通过的进 `strongMatches`，**不参与下面的分数竞争**。
 *
 *   ② `all_required: false` —— 打分
 *      `score = (扩展名命中 ? 1 : 0) + 命中文件数 / 文件总数`
 *      取最高分；同分时按「命中文件数多」→「扩展名命中」→「先出现的」排序。
 *
 *   ③ 多个强命中时：文件命中数多的优先，然后扩展名命中的优先，再保持原顺序。
 *
 *   ④ 一个强命中、其余都是打分命中 → **强命中赢**（`strongMatches.length === 1` 时直接返回）。
 *      这就是「easyrpg 的 RPG_RT.ini 命中了 1/3，但 mkxpz 的四个文件全在场」时
 *      必须选 mkxpz 的原因。
 *
 * ⚠️ 打分段的 `bestTie.fileMatches` 初值是 **-1**（不是 0）：这样「第一个分数 > 0 的
 *    规则」一定被选上，不会因为「同分且 fileMatches 都是 0」而永远返回 null。
 *    上游就是这个初值，别改。
 */
function pickBestRule(
  exe: string,
  rules: Iterable<[string, DetectRule | null | undefined]>
): string | null {
  if (!exe) return null
  const extOnPath = normalizeExt(getPathExtLower(exe))
  const dir = gameDirForFiles(exe)

  const strongMatches: Scored[] = []
  const scored: Scored[] = []

  for (const [key, rawRule] of rules) {
    if (!rawRule || typeof rawRule !== 'object') continue

    // 扩展名：`extensions` 数组，或单数 `extension`（上游两种都支持）
    const extList = collectExtensions(rawRule)
    const hasExtRule = extList.length > 0
    const extMatch = hasExtRule ? extList.includes(extOnPath) : false

    // 文件探测：`files` 是**相对游戏目录**的路径
    const files = Array.isArray(rawRule.files) ? rawRule.files : []
    let fileMatches = 0
    for (const rel of files) {
      if (typeof rel !== 'string' || !rel) continue
      if (fs.existsSync(path.join(dir, rel))) fileMatches += 1
    }
    const fileTotal = files.length

    if (rawRule.all_required === true) {
      // ① 硬门槛。空规则（既无扩展名也无文件）**通过**——与上游一致（两个 need 都是 true）。
      const needExt = hasExtRule ? extMatch : true
      const needFiles = fileTotal > 0 ? fileMatches === fileTotal : true
      if (needExt && needFiles) scored.push({ key, score: 0, fileMatches, extMatch, allRequired: true })
      continue
    }

    // ② 打分
    let score = 0
    if (hasExtRule && extMatch) score += 1
    if (fileTotal > 0) score += fileMatches / fileTotal
    if (score > 0) scored.push({ key, score, fileMatches, extMatch, allRequired: false })
  }

  for (const item of scored) if (item.allRequired) strongMatches.push(item)

  // ③ 有强命中就只在强命中里挑（强命中永远压过打分命中）
  if (strongMatches.length > 0) {
    // 排序必须**稳定**：同分同扩展名时保持注册顺序（引擎页顺序）
    const sorted = strongMatches.map((item, index) => ({ item, index }))
    sorted.sort((a, b) => {
      if (b.item.fileMatches !== a.item.fileMatches) return b.item.fileMatches - a.item.fileMatches
      if (a.item.extMatch !== b.item.extMatch) return a.item.extMatch ? -1 : 1
      return a.index - b.index
    })
    return sorted[0]?.item.key ?? null
  }

  // ④ 没强命中 → 打分取最高
  let best: Scored | null = null
  for (const item of scored) {
    if (!best || item.score > best.score) {
      best = item
      continue
    }
    if (item.score === best.score) {
      // 同分：文件命中数多优先，然后扩展名命中优先
      const better =
        item.fileMatches > best.fileMatches || (item.fileMatches === best.fileMatches && item.extMatch && !best.extMatch)
      if (better) best = item
    }
  }
  return best?.key ?? null
}

/** 把规则里的扩展名统一成「不带点小写、去掉空项」的列表。 */
function collectExtensions(rule: { extensions?: unknown; extension?: unknown }): string[] {
  const raw = Array.isArray(rule.extensions)
    ? rule.extensions
    : rule.extension
      ? [rule.extension]
      : []
  const out: string[] = []
  for (const item of raw) {
    const normalized = normalizeExt(typeof item === 'string' ? item : String(item))
    if (normalized) out.push(normalized)
  }
  return out
}

// ===== 对外：两个识别入口 =====

/**
 * 用**已装模块的 manifest** 认引擎（`detectEngineForPath` 的等价物）。
 *
 * 「已装」这条信息由调用方自己体现（传进来的 manifests 就是本地有的那些）。
 * 返回 `null` 表示「这个路径没有已知引擎能认领」——**不猜、不回退**（D57 的精神）。
 */
export function detectEngineForPath(
  exe: string | undefined | null,
  manifests: Record<string, ManifestRaw> | null | undefined
): string | null {
  if (!exe) return null
  const entries = Object.entries(manifests ?? {}) as Array<[string, ManifestRaw]>
  return pickBestRule(
    exe,
    entries.map(([key, manifest]) => [key, (manifest as { autodetect?: DetectRule } | undefined)?.autodetect])
  )
}

/**
 * 用**一份规则表**认引擎（`detectEngineFromAutodetectMap` 的等价物）。
 *
 * 规则表的形状与 `module.js` 的 `fetchModulesForAutodetect()` 返回值一致：
 * `{ <folder>: { extensions?, files?, all_required? } }`。
 * M4.1 起这张表由 `engines/registry.ts` 直接生成（零网络），
 * 所以「未装引擎也认得出是哪款」是纯本地计算。
 */
export function detectEngineFromDefinitions(
  exe: string | undefined | null,
  definitions: Record<string, DetectRule> | null | undefined
): string | null {
  if (!exe || !definitions) return null
  return pickBestRule(exe, Object.entries(definitions))
}

/**
 * registry 的 `EngineDefinition[]` → `detectEngineFromDefinitions` 吃的规则表。
 *
 * ⚠️ 三个字段的语义（M4.1 已在 core-host 的注释里钉过，这里不能走样）：
 *   · `extensions` 必须**不带点且小写**（双写 `.py` 会被 `normalizeExt` 剥成 `""` 后被
 *     `filter(Boolean)` 丢掉 → 这条规则静默失效）
 *   · `files` 是**相对游戏目录**（`.app` 包里则相对包本身，见 R1）
 *   · `all_required` **必须显式写出**。省了就是 `undefined`，而判据是 `=== true`，
 *     于是「必须全都在」的引擎（nwjs / mkxpz / renpy）会退化成「命中一个就算」→ 张冠李戴。
 *
 * 导出它是为了让 `ipc.ts` 的 `detect` / `detectFolder` 与 `core-host.detectFolder`
 * **共用同一份生成逻辑**（两处各写一份迟早分叉，而分叉的表现是"添加游戏认不出引擎"）。
 */
export function definitionsFromRegistry(
  engines: ReadonlyArray<{ folder: string; autodetect: { extensions?: string[]; files?: string[]; all_required?: boolean } }>
): Record<string, DetectRule> {
  const out: Record<string, DetectRule> = {}
  for (const engine of engines) {
    const rule: DetectRule = {}
    if (engine.autodetect.extensions?.length) rule.extensions = engine.autodetect.extensions
    if (engine.autodetect.files?.length) rule.files = engine.autodetect.files
    rule.all_required = engine.autodetect.all_required === true
    out[engine.folder] = rule
  }
  return out
}

/** manifest 的 `autodetect`（宽松形状）→ `DetectRule`（丢掉 `extension` 单数写法等噪音）。 */
export function ruleFromManifestAutodetect(autodetect: ManifestAutodetect | undefined): DetectRule | null {
  if (!autodetect || typeof autodetect !== 'object') return null
  const rule: DetectRule = {}
  const exts = collectExtensions(autodetect)
  if (exts.length) rule.extensions = exts
  if (Array.isArray(autodetect.files) && autodetect.files.length) rule.files = autodetect.files
  rule.all_required = autodetect.all_required === true
  return rule
}

/**
 * 把「可启动引擎」与「只识别引擎」两套规则合成一张表（M6）。
 *
 * ===== 为什么识别范围要比启动范围大 =====
 *
 * 用户要的是「范围尽可能广」。而**「认得出」和「跑得动」是两件事**：
 * Unity / RPG Bakin / ウディタ 的游戏我们认得出，但它们只有 Windows 二进制，
 * 本版本不做兼容层（用户拍板交给 CrossOver）。
 *
 * 若完全不认它们，用户添加这类游戏会得到「未知引擎」——而「未知引擎」和
 * 「这需要 Windows 兼容层」是**两种完全不同的处境**：前者像是本程序坏了。
 * 若把它们塞进 `ENGINES`，引擎页会把它们列成「可安装」但下载地址是空的 → 点了必失败。
 *
 * 所以：识别表 = 两者合并，**但顺序与强度不同**：
 *
 *   ① **可启动引擎排在前**，且它们多数是强命中（`all_required: true`）
 *   ② 仅识别引擎排在后，且**一律走打分**（`all_required: false`）
 *
 * `pickBestRule` 的规则 ③「强命中永远压过打分命中」，于是**仅识别规则绝不可能
 * 抢走一个本该属于可启动引擎的游戏**。这条有单测钉着（`detect-priority.test.ts`）。
 *
 * ⚠️ 若某天有人给 `DETECT_ONLY` 的条目写了 `all_required: true`，这条保证就破了
 * （两个强命中撞车时按「文件命中数多」排序，可能选错）。**别那么写。**
 */
export function definitionsWithDetectOnly(
  engines: ReadonlyArray<{ folder: string; autodetect: { extensions?: string[]; files?: string[]; all_required?: boolean } }>,
  detectOnly: ReadonlyArray<{ folder: string; autodetect: { extensions?: string[]; files?: string[]; all_required?: boolean } }>
): Record<string, DetectRule> {
  // 顺序有意义：可启动的先进表（对称时它先被选上），仅识别的后进
  return { ...definitionsFromRegistry(engines), ...definitionsFromRegistry(detectOnly) }
}

// ===== 已装引擎目录 =====

/**
 * 已安装的引擎目录名（`<dataDir>/modules` 下的子目录，**不要求有 manifest**）。
 *
 * 为什么「不要求 manifest」：诊断（M3）判的是"这个引擎装了没有"，
 * 判据应该是目录在不在。manifest 缺失是另一个问题（引擎页会显示"未安装"或多版本缺文件），
 * 但那不该让「引擎已装」被判成未装。
 *
 * 顺带说明为什么放在这个文件而不是 manifest.ts：方案 §2.2 把它归到 detect.ts，
 * 而它确实是「探测本地有什么」这一类，与 `detectEngineForPath` 同一个用途。
 */
export function getInstalledModuleFolders(dataDir: string): string[] {
  const root = path.join(dataDir, 'modules')
  if (!fs.existsSync(root)) return []
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch (error) {
    console.warn(`[tsumigeya] 读已装引擎列表失败（按空处理）：${(error as Error).message}`)
    return []
  }
}
