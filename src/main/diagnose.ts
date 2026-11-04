// M3 故障自愈：启动前诊断（docs/M3-实施方案.md §3）。
//
// 设计要点（不要改）：
// - **纯逻辑，不 import electron**：与 core-host / dlsite 一样，要能在 vitest 里直接跑，
//   也要能被 ipc.ts 在纯 Node 环境（假 host）里调用。
// - **只用本地文件特征**（D32）：不调 mkxp-z、不解析英文报错。报错文本不稳定且是英文，
//   而魔数 / 目录结构 / Game.ini 的 ASCII 结构行是确定的。
// - `.rgss3a` 等归档的魔数版本号**优先于** launcher 的 DLL 扫描推断（D33）。
// - **加密发行只检测 + 提示 + 引导，绝不自动解包**（D34，DRM 法律风险）。
// - **`fontSub` 不做自动修复**（D35），只提示「自带字体存在」。
// - `Game.ini` 是 GBK / Shift-JIS（§2.5 实测），**只按 latin1 读 ASCII 结构行**。
//   绝不用 `Title=` 的内容做任何判断或展示（读出来是乱码）。
import fs from 'node:fs'
import path from 'node:path'
import { scanCandidates } from './core-host'
// RTP 路径的唯一来源（M4.0 D56）：诊断与启动写 mkxp.json 必须查同一处
import { mkxpzRtpRootFromEngineDir } from './launchers/binary-paths'

// ===== 类型（§3.1）=====

export type DiagnosisLevel = 'fatal' | 'warning' | 'info'

/** 稳定标识：UI 与 i18n 用它查文案（文案键是 `diagnose.<code>`，见 §5）。 */
export type DiagnosisCode =
  | 'encryptedArchive'
  | 'missingRtp'
  | 'missingExecutable'
  | 'moduleMissing'
  | 'pathGone'
  | 'fontsPresent'

/**
 * 能一键修的动作。修不了（或只能引导用户自己动手）的条目没有 `fix`。
 *
 * 注意 `openFolder` 只负责「打开目录让用户自己看/自己整理」，
 * 它**不是**「自动解包」——加密发行永远走人工（D34）。
 */
export type DiagnosisFix =
  | { kind: 'installRtp'; engine: string }
  | { kind: 'installModule'; engine: string }
  | { kind: 'openFolder'; path: string }
  | { kind: 'repoint' }

export interface Diagnosis {
  code: DiagnosisCode
  level: DiagnosisLevel
  /** 给用户看的中文（i18n key，不是原文）。 */
  messageKey: string
  /** 文案里的占位符（只允许 `{simpleIdentifier}`，见 §5 的警告）。 */
  args?: Record<string, string>
  /** 能一键修的话指向哪个动作；修不了就是 undefined。 */
  fix?: DiagnosisFix
}

const LEVEL_WEIGHT: Record<DiagnosisLevel, number> = { fatal: 0, warning: 1, info: 2 }

/**
 * 同一级别内部的顺序（数字小的排前面）。
 *
 * 为什么需要（S3 端到端探针实测发现的真实缺陷）：`moduleMissing` 与 `encryptedArchive`
 * 都是 fatal，按检测顺序 moduleMissing 会排第一，于是诊断框里第一个按钮是「安装引擎」——
 * 但用户装完引擎**问题依旧**（这个游戏是被加密的，装了引擎也跑不了），等于让用户白忙一场。
 *
 * 排序原则：**越根本、越不可绕过的阻塞排越前**。
 *   pathGone（目录都没了）→ encryptedArchive（要用户自己解包，最重的活）
 *   → moduleMissing / missingExecutable → missingRtp → fontsPresent
 */
const CODE_WEIGHT: Record<DiagnosisCode, number> = {
  pathGone: 0,
  encryptedArchive: 1,
  moduleMissing: 2,
  missingExecutable: 3,
  missingRtp: 4,
  fontsPresent: 5
}

/** fatal 会拦下启动；warning / info 只提示（§3.1）。 */
export function isBlocking(diagnosis: Diagnosis): boolean {
  return diagnosis.level === 'fatal'
}

/** 只要有一条 fatal 就不能直接启动（launch 前拦截用）。 */
export function hasBlocking(diagnoses: readonly Diagnosis[]): boolean {
  return diagnoses.some(isBlocking)
}

/**
 * fatal → warning → info；同级内按 CODE_WEIGHT。
 * 排序稳定：同级别同 weight 的条目保持检测顺序。
 */
export function sortDiagnoses(diagnoses: Diagnosis[]): Diagnosis[] {
  return [...diagnoses].sort(
    (a, b) => LEVEL_WEIGHT[a.level] - LEVEL_WEIGHT[b.level] || CODE_WEIGHT[a.code] - CODE_WEIGHT[b.code]
  )
}

// ===== ① 加密发行：RGSS 归档魔数（§2.1，实测过的规律）=====

/** `RGSSAD` + 空字节，共 7 字节；第 8 字节是版本号。 */
const RGSS_MAGIC = Buffer.from('RGSSAD\0', 'latin1')
const RGSS_MAGIC_LENGTH = RGSS_MAGIC.length

/** 归档魔数第 8 字节 → RGSS 版本（§2.1）。 */
const RGSS_VERSION_BY_MAGIC: Record<number, 1 | 2 | 3> = { 0x01: 1, 0x02: 2, 0x03: 3 }

/** 扩展名 → RGSS 版本（魔数缺失/不认识时的兜底；D33 保证魔数优先）。 */
const RGSS_VERSION_BY_EXTENSION: Record<string, 1 | 2 | 3> = {
  '.rgssad': 1,
  '.rgss2a': 2,
  '.rgss3a': 3
}

export interface ArchiveMagic {
  /** 文件开头是不是 RGSS 归档魔数。 */
  isArchive: boolean
  /** 魔数第 8 字节推断的 RGSS 版本；不是归档则为 null。 */
  rgssVersion: 1 | 2 | 3 | null
  /** 小写扩展名（含点），如 `.rgss3a`；不认识的扩展时是它本身。 */
  extension: string
}

/**
 * 读文件头 8 字节解析归档魔数。**只读 8 字节**，不读整个 121MB 的归档。
 *
 * 不抛错：文件不存在 / 读不了 / 不足 8 字节一律按「不是归档」处理
 * （诊断不能因为一个读不到的文件就整页崩掉）。
 */
export function parseArchiveMagic(file: string): ArchiveMagic {
  const extension = path.extname(file).toLowerCase()
  try {
    const handle = fs.openSync(file, 'r')
    try {
      const head = Buffer.alloc(RGSS_MAGIC_LENGTH + 1)
      const read = fs.readSync(handle, head, 0, head.length, 0)
      if (read < RGSS_MAGIC_LENGTH + 1) return { isArchive: false, rgssVersion: null, extension }
      if (!head.subarray(0, RGSS_MAGIC_LENGTH).equals(RGSS_MAGIC)) {
        return { isArchive: false, rgssVersion: null, extension }
      }
      const version = RGSS_VERSION_BY_MAGIC[head[RGSS_MAGIC_LENGTH]] ?? null
      return { isArchive: true, rgssVersion: version, extension }
    } finally {
      fs.closeSync(handle)
    }
  } catch {
    return { isArchive: false, rgssVersion: null, extension }
  }
}

export const RGSS_VERSION_LABEL: Record<1 | 2 | 3, string> = {
  1: 'XP',
  2: 'VX',
  3: 'VX Ace'
}

/** 归档扩展名（小写，含点）。用户真实样本是 `.rgss3a`。 */
const ARCHIVE_EXTENSIONS = new Set(['.rgss3a', '.rgss2a', '.rgssad'])

/** 加载游戏目录时跳过的目录名（与 core-host 的 scanCandidates 一致）。 */
const SKIP_DIRS = new Set(['node_modules'])

/**
 * 找出目录里的 RGSS 加密归档（顶层 + 一层子目录，跳过点目录与 node_modules）。
 *
 * 一层子目录的理由：有些发行把 `Game.rgss3a` 放在子文件夹里；
 * 只扫顶层会漏报，而「漏报」在这个功能里等于用户看到 mkxp-z 的英文报错（正是 M3 要消灭的）。
 */
export function findEncryptedArchives(dir: string): string[] {
  const found: string[] = []
  const scan = (target: string, depth: number): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(target, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const absolute = path.join(target, entry.name)
      if (entry.isDirectory()) {
        if (depth > 0) continue
        if (SKIP_DIRS.has(entry.name)) continue
        if (path.extname(entry.name).toLowerCase() === '.app') continue
        scan(absolute, depth + 1)
        continue
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      if (!ARCHIVE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
      found.push(absolute)
    }
  }
  scan(dir, 0)
  return found.sort()
}

/** RPG Maker 已解包时会出现的脚本文件（R3：三个后缀都认）。 */
const SCRIPT_EXTENSIONS = new Set(['.rvdata2', '.rvdata', '.rxdata'])

/**
 * 是否已经解包过（`Data/` 下有脚本数据文件）。
 *
 * 判定刻意**宁宽不严**：只要 `Data/` 里出现任意 `.rvdata2/.rvdata/.rxdata` 就算解包了。
 * 理由：这一条是「不要误报 fatal」的护栏。用户解包后把脚本改名 / 只放几个数据文件时，
 * 严格只认 `Scripts.rvdata2` 会把他拒之门外——而 fatal 是**没有绕过按钮**的。
 */
export function hasExtractedData(dir: string): boolean {
  const dataDir = path.join(dir, 'Data')
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dataDir, { withFileTypes: true })
  } catch {
    return false
  }
  return entries.some(
    (entry) => entry.isFile() && SCRIPT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
  )
}

/**
 * §3.2 ①：目录里有 RGSS 归档、且没有解包后的 `Data/` → fatal。
 *
 * **检测不到的边界（有意为之）**：已经解包并放了 `Data/Scripts.rvdata2` 时不报这条，
 * 哪怕 `.rgss3a` 还在（用户可能留着原档备份）。
 */
export function detectEncryptedArchive(dir: string): Diagnosis | null {
  const archives = findEncryptedArchives(dir)
  if (archives.length === 0) return null
  if (hasExtractedData(dir)) return null

  const archive = archives[0]
  const magic = parseArchiveMagic(archive)
  // 魔数不认识时退回扩展名（D33 的兜底方向：魔数优先，但魔数缺失时扩展名也是可靠信号）
  const version = magic.rgssVersion ?? RGSS_VERSION_BY_EXTENSION[magic.extension] ?? null
  // 相对路径用 / 分隔，跨平台文案一致（顶层归档就是 `Game.rgss3a`，与 §5 示例相同）
  const relative = path.relative(dir, archive).split(path.sep).join('/')

  return {
    code: 'encryptedArchive',
    level: 'fatal',
    messageKey: 'diagnose.encryptedArchive',
    args: {
      file: relative,
      rgssVersion: version ? RGSS_VERSION_LABEL[version] : '未知',
      // 多个归档时让用户知道不止一个（文案里不强制用，但排障有用）
      count: String(archives.length)
    },
    // 只打开目录让用户自己去解包，**不自动破解**（D34）
    fix: { kind: 'openFolder', path: dir }
  }
}

// ===== ② RTP 缺失（§3.2 ②、§2.3）=====

/**
 * 需要检查 RTP 的引擎（RGSS 系）。
 *
 * 只对 mkxpz 检查：其它引擎（nwjs / easyrpg / renpy）没有 `deps/RTP` 的概念，
 * 对它们报「RTP 缺失」就是纯噪音。将来接入别的 RGSS 引擎时往这里加。
 */
export const RTP_ENGINES: ReadonlySet<string> = new Set(['mkxpz'])

/**
 * RTP 的三个真实目录名（`deps/RTP/RTP/<这个>`）。
 *
 * ⚠️ XP 的目录名是 **`Standard`**，不是 `RPGXP`（M4.0 S3 实测纠正）。
 *
 * 判据不是猜的：直接下了真实 RTP.zip（255,812,166 字节）读它的中央目录，
 * 顶层是 `RTP/`，其下只有三个目录：
 *
 *     RTP/Standard/     ← RPG Maker XP
 *     RTP/RPGVX/        ← RPG Maker VX
 *     RTP/RPGVXAce/     ← RPG Maker VX Ace
 *
 * M3 的初稿把它写成 `RPGXP` 并标注「推测」——那个推测是错的。后果很具体：
 * XP 游戏的 `Game.ini` 写 `RTP=Standard`，`normalizeRtpName` 认不出 `Standard`
 * 会原样返回，查 `deps/RTP/RTP/Standard` 恰好能命中；但若走的是
 * `RTP_BY_RGSS_VERSION[1]` 这条路径（读不到 RTP= 时按版本映射），就会去查
 * 一个**永远不存在**的 `RPGXP` → XP 游戏永久判「RTP 缺失」，一键补装也修不掉。
 */
export const RTP_BY_RGSS_VERSION: Record<1 | 2 | 3, string> = {
  1: 'Standard',
  2: 'RPGVX',
  3: 'RPGVXace'
}

/**
 * 兼容旧写法：`Game.ini` 里写 `RTP=RPGXP` 的（RPG Maker XP 的官方叫法）
 * 与写 `RTP=Standard` 的（这个 RTP 包里的真实目录名）都算 XP。
 *
 * 两张表分开维护：`RTP_BY_RGSS_VERSION` 是**发版契约**（决定查哪个目录），
 * 下面这张是**别名表**（决定输入怎么归一化）。混在一起会让「加一个别名」
 * 变成「改一个对外行为」。
 */
const RTP_ALIASES: Record<string, 1 | 2 | 3> = {
  standard: 1,
  rpgxp: 1, // XP 的另一种常见写法（本机的 RTP.zip 里没有这个目录，但要认得）
  rpgvx: 2,
  rpgvxace: 3
}

/**
 * 把 `Game.ini` 里 `RTP=` 的写法归一化成**真实目录名**。
 *
 * ⚠️ 为什么必须做（v0.3.0 CI 第三次失败实测）：
 * 真实目录名是 `RPGVXace`（小写 a），而不少游戏的 `Game.ini` 写成 `RPGVXAce`（大写 A）。
 * - **Windows/macOS 默认文件系统大小写不敏感** → 两种写法都能 stat 成功，本机永远测不出来
 * - **Linux 大小写敏感** → `RPGVXAce` 目录找不到 → 诊断永远判「RTP 缺失」
 *   （CI 断言 `expected ['encryptedArchive','missingRtp'] not to include 'missingRtp'`）
 *
 * 规则：按**忽略大小写**匹配已知目录名（含 `RPGXP` → `Standard` 这类别名），
 * 命中就返回规范写法；匹配不上（未知 RTP 名）原样返回——那种情况由调用方判「无法确定」。
 */
export function normalizeRtpName(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  const version = RTP_ALIASES[trimmed.toLowerCase()]
  if (version) return RTP_BY_RGSS_VERSION[version]
  return trimmed
}

export interface GameIni {
  /** `RTP=` 的值（已 trim）；**`null` = 明确不使用 RTP**（写了空值或没有这一行）。 */
  rtp: string | null
  /** `[Game]` 段里到底有没有 `RTP=` 这一行（区分「没有行」与「行存在但为空」）。 */
  hasRtpLine: boolean
  /** `Scripts=` 的值（形如 `Data\Scripts.rvdata2`）。 */
  scripts: string | null
  /** `Library=` 的值（形如 `System\RGSS300.dll`）。 */
  library: string | null
  /** Game.ini 本身是否存在。 */
  exists: boolean
}

/** Game.ini 超过这个尺寸就不再解析（正常只有几百字节；防御异常文件）。 */
const GAME_INI_MAX_BYTES = 256 * 1024

/**
 * 读 `Game.ini` 的 **ASCII 结构行**（§2.5）。
 *
 * ⚠️ 只按 `'latin1'` 读，**绝不**用 `Title=`（GBK，读出来是乱码），
 * 也绝不尝试 UTF-8（会让中文标题变成替换字符、甚至解析错行）。
 * 我们只关心 `RTP=` / `Scripts=` / `Library=` 这三个纯 ASCII 键。
 */
export function readGameIni(dir: string): GameIni {
  const empty: GameIni = { rtp: null, hasRtpLine: false, scripts: null, library: null, exists: false }
  const file = path.join(dir, 'Game.ini')
  let text: string
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile()) return empty
    if (stat.size > GAME_INI_MAX_BYTES) return empty
    text = fs.readFileSync(file, 'latin1')
  } catch {
    return empty
  }

  const result: GameIni = { rtp: null, hasRtpLine: false, scripts: null, library: null, exists: true }
  let section = ''
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith(';') || line.startsWith('#')) continue
    if (line.startsWith('[')) {
      section = line.replace(/^\[/, '').replace(/\]$/, '').trim().toLowerCase()
      continue
    }
    if (section !== 'game') continue
    const equals = line.indexOf('=')
    if (equals <= 0) continue
    const key = line.slice(0, equals).trim().toLowerCase()
    const value = line.slice(equals + 1).trim()
    if (key === 'rtp') {
      result.hasRtpLine = true
      result.rtp = value || null
    } else if (key === 'scripts') {
      result.scripts = value || null
    } else if (key === 'library') {
      result.library = value || null
    }
  }
  return result
}

/**
 * 从 `Library=System\RGSS300.dll` 推断 RGSS 版本。
 *
 * 这是**比扩展名更靠前**的信号，因为它是游戏自己声明的加载目标：
 * `RGSS300/301/302` → VX Ace，`RGSS200/202` → VX，`RGSS100/102/104` → XP。
 */
export function inferRgssVersionFromLibrary(library: string | null): 1 | 2 | 3 | null {
  if (!library) return null
  const match = /RGSS(\d{3})/i.exec(library)
  if (!match) return null
  const number = match[1]
  if (number === '300' || number === '301' || number === '302') return 3
  if (number === '200' || number === '202') return 2
  if (number === '100' || number === '102' || number === '104') return 1
  return null
}

/** 从 `Scripts=Data\Scripts.rvdata2` 的扩展名推断 RGSS 版本。 */
export function inferRgssVersionFromScripts(scripts: string | null): 1 | 2 | 3 | null {
  if (!scripts) return null
  const extension = path.extname(scripts).toLowerCase()
  if (extension === '.rvdata2') return 3
  if (extension === '.rvdata') return 2
  if (extension === '.rxdata') return 1
  return null
}

/** RTP 名必须是合法目录名（防 Game.ini 里的 `..\\..` 拼出越界路径）。 */
function isSafeComponent(value: string): boolean {
  return value.length > 0 && value.length <= 64 && !/[/\\:*?"<>|\u0000-\u001f]/.test(value)
}

export interface WantedRtp {
  /** 期望的 RTP 目录名（`RPGVXace` 等）；null = 无法确定（不检查）。 */
  rtp: string | null
  /** 这个值时怎么来的（排障用：'ini' / 'library' / 'scripts' / 'archive' / 'unknown'）。 */
  source: 'ini' | 'library' | 'scripts' | 'archive' | 'unknown'
  /** 推断出的 RGSS 版本（供文案与其它检测器共用）。 */
  rgssVersion: 1 | 2 | 3 | null
}

/**
 * 决定「这个游戏需要哪个 RTP」。
 *
 * 优先级（从可信到兜底，R1 的处置就是这条链）：
 *   1. `Game.ini` 的 `RTP=`（大小写不敏感；空值 = 明确不使用 RTP → 返回 null 且 source='ini'）
 *   2. `Library=` 里的 `RGSS<数字>`
 *   3. `Scripts=` 的扩展名
 *   4. 归档魔数（`.rgss3a` = VX Ace）
 *   5. 都没有 → 不检查（避免瞎猜，猜错会让用户白下 244MB）
 */
export function decideWantedRtp(dir: string, ini: GameIni = readGameIni(dir)): WantedRtp {
  if (ini.hasRtpLine && !ini.rtp) {
    // `RTP=` 空值是 RPG Maker 的「明确不使用 RTP」写法，绝不能当成缺失
    return { rtp: null, source: 'ini', rgssVersion: inferRgssVersionFromLibrary(ini.library) }
  }
  if (ini.rtp) {
    // 值可能是 `RPGVXace` 也可能带子目录写法；只取合法的一段。
    // **必须归一化大小写**：真实目录是 `RPGVXace`，而 Game.ini 常写 `RPGVXAce`
    // （Windows 不敏感所以没事，Linux 上直接判缺失——见 normalizeRtpName 注释）。
    if (isSafeComponent(ini.rtp)) {
      return { rtp: normalizeRtpName(ini.rtp), source: 'ini', rgssVersion: inferRgssVersionFromLibrary(ini.library) }
    }
    return { rtp: null, source: 'unknown', rgssVersion: null }
  }
  const fromLibrary = inferRgssVersionFromLibrary(ini.library)
  if (fromLibrary) {
    return { rtp: RTP_BY_RGSS_VERSION[fromLibrary], source: 'library', rgssVersion: fromLibrary }
  }
  const fromScripts = inferRgssVersionFromScripts(ini.scripts)
  if (fromScripts) {
    return { rtp: RTP_BY_RGSS_VERSION[fromScripts], source: 'scripts', rgssVersion: fromScripts }
  }
  const archives = findEncryptedArchives(dir)
  if (archives.length > 0) {
    const magic = parseArchiveMagic(archives[0])
    const version = magic.rgssVersion ?? RGSS_VERSION_BY_EXTENSION[magic.extension] ?? null
    if (version) return { rtp: RTP_BY_RGSS_VERSION[version], source: 'archive', rgssVersion: version }
  }
  return { rtp: null, source: 'unknown', rgssVersion: null }
}

/**
 * §3.2 ②：RTP 缺失 → **warning**（不是 fatal）。
 *
 * 为什么是 warning：缺 RTP 的游戏常常**仍能跑**（只是缺素材 / 少数情况黑屏），
 * 拦死它会让本来能玩的游戏变成不能玩。所以给「还是启动试试」（§9 R5）。
 */
export function detectMissingRtp(engineDir: string, engine: string, wanted: string | null): Diagnosis | null {
  if (!wanted) return null
  // 路径拼法来自 launchers/binary-paths.ts（D56 的唯一来源）：
  // 「诊断说缺 RTP」与「启动时写进 mkxp.json 的 RTP 路径」必须是同一处，
  // 否则诊断会放过一个其实跑不起来的游戏（或反之白报一个不缺的）。
  const root = mkxpzRtpRootFromEngineDir(engineDir)
  const target = path.join(root, wanted)
  if (existsAsDirectory(target)) return null
  // 精确路径不存在时再按**忽略大小写**扫一遍实际目录：
  // Linux 上 `RPGVXAce` 与 `RPGVXace` 是两个不同名字，光归一化还不够稳，
  // 目录里真实的写法才作数（也兜住用户手改过的目录名）。
  const spelled = findCaseInsensitive(root, wanted)
  if (spelled && existsAsDirectory(spelled)) return null
  return {
    code: 'missingRtp',
    level: 'warning',
    messageKey: 'diagnose.missingRtp',
    args: { rtp: wanted, engine },
    fix: { kind: 'installRtp', engine }
  }
}

/** 目录是否真的存在且是目录（不抛）。 */
function existsAsDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory()
  } catch {
    return false
  }
}

/**
 * 在 `parent` 里找与 `name` **忽略大小写**匹配的条目，返回它的完整路径。
 *
 * 用途：Windows 上 `RPGVXAce` 与 `RPGVXace` 是同一个目录，Linux 上不是。
 * 只在精确路径查不到时才调用（不改变 Windows 的行为）。
 */
export function findCaseInsensitive(parent: string, name: string): string | null {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(parent, { withFileTypes: true })
  } catch {
    return null
  }
  const wantedLower = name.toLowerCase()
  const hit = entries.find((entry) => entry.isDirectory() && entry.name.toLowerCase() === wantedLower)
  return hit ? path.join(parent, hit.name) : null
}

// ===== ③④ 路径 / 模块 / 可执行（§3.2 ③④）=====

/** gamePath 不存在 → fatal，让用户去编辑页重选（`repoint`）。 */
export function detectPathGone(gamePath: string): Diagnosis | null {
  try {
    const stat = fs.statSync(gamePath)
    if (stat.isDirectory() || stat.isFile()) return null
  } catch {
    return {
      code: 'pathGone',
      level: 'fatal',
      messageKey: 'diagnose.pathGone',
      args: { path: gamePath },
      fix: { kind: 'repoint' }
    }
  }
  return null
}

/** 引擎模块未安装 → fatal（装不了模块就谈不上启动）。 */
export function detectMissingModule(engine: string, installedModules: readonly string[]): Diagnosis | null {
  if (!engine) {
    return {
      code: 'moduleMissing',
      level: 'fatal',
      messageKey: 'diagnose.moduleMissing',
      args: { engine: '（未指定）' },
      fix: { kind: 'installModule', engine: '' }
    }
  }
  if (installedModules.includes(engine)) return null
  return {
    code: 'moduleMissing',
    level: 'fatal',
    messageKey: 'diagnose.moduleMissing',
    args: { engine },
    fix: { kind: 'installModule', engine }
  }
}

/**
 * 目录里找不到任何可执行候选 → fatal。
 *
 * 复用 core-host 的 `scanCandidates`：**必须**与「添加游戏时的识别」用同一套判定，
 * 否则会出现「添加时说识别到了引擎、启动时诊断说没有可执行文件」这种自相矛盾。
 */
export function detectMissingExecutable(dir: string): Diagnosis | null {
  let candidates: string[]
  try {
    candidates = scanCandidates(dir).candidates
  } catch {
    return null // 目录都读不了的事交给 pathGone，不在这里堆两条
  }
  if (candidates.length > 0) return null
  return {
    code: 'missingExecutable',
    level: 'fatal',
    messageKey: 'diagnose.missingExecutable',
    args: { path: dir },
    fix: { kind: 'openFolder', path: dir }
  }
}

// ===== ⑤ 自带字体（info，只提示不修，D35）=====

const FONT_DIR_NAMES = ['Fonts', 'fonts', 'FONTS']
const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc'])

/**
 * 自带字体存在 → **info**（不拦启动、不给修复按钮）。
 *
 * 为什么不修（§2.4 / D35）：`mkxp.json` 的 `fontSub` 是「字体替换映射」
 * （`"Arial>Open Sans"`），**不是**字体目录加载器；而游戏自带的 `Fonts/*.ttf`
 * 本来就会被 mkxp-z 自动加载。自动改会猜错（用户到底遇到了哪种字体问题），反而添乱。
 */
export function detectFontsPresent(dir: string): Diagnosis | null {
  let count = 0
  for (const name of FONT_DIR_NAMES) {
    const fontDir = path.join(dir, name)
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(fontDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (FONT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) count += 1
    }
    if (count > 0) break // 有 Fonts/ 又有个 FONTS/ 的重复计数没必要
  }
  if (count === 0) return null
  return {
    code: 'fontsPresent',
    level: 'info',
    messageKey: 'diagnose.fontsPresent',
    args: { count: String(count) }
  }
}

// ===== 汇总（§3.3）=====

/** gamePath 可能是可执行文件，也可能是目录；统一给出「游戏目录」。 */
export function resolveGameDir(gamePath: string): string {
  try {
    if (fs.statSync(gamePath).isFile()) return path.dirname(gamePath)
  } catch {
    /* 不存在：按目录处理（pathGone 会报） */
  }
  return gamePath
}

export interface DiagnoseInput {
  game: { gamePath: string; gameEngine: string; gameArgs?: Record<string, unknown> }
  modulesDir: string
  installedModules: readonly string[]
}

/**
 * 全套诊断，按 fatal → warning → info 排序返回（§3.3）。
 *
 * 顺序上的两条规矩：
 * 1. `pathGone` 命中就**直接返回**——目录都没了，后面所有基于目录的检查都会是噪音；
 * 2. `mixedRtp` 只在模块已装时检查——模块没装时 `deps/RTP` 本来就不存在，
 *    同时报「装模块」和「装 RTP」会让用户不知道该点哪个。
 */
export function diagnoseGame(input: DiagnoseInput): Diagnosis[] {
  const { game } = input
  const diagnoses: Diagnosis[] = []

  const gone = detectPathGone(game.gamePath)
  if (gone) return [gone]

  const missingModule = detectMissingModule(game.gameEngine, input.installedModules)
  if (missingModule) diagnoses.push(missingModule)

  const dir = resolveGameDir(game.gamePath)
  const isFile = dir !== game.gamePath

  if (!isFile) {
    const executable = detectMissingExecutable(dir)
    if (executable) diagnoses.push(executable)
  }

  const encrypted = detectEncryptedArchive(dir)
  if (encrypted) diagnoses.push(encrypted)

  if (RTP_ENGINES.has(game.gameEngine) && !missingModule) {
    const engineDir = path.join(input.modulesDir, game.gameEngine)
    const ini = readGameIni(dir)
    const wanted = decideWantedRtp(dir, ini)
    // wanted.rtp 为 null（读不到 RTP= 也推不出版本）时 detectMissingRtp 直接返回 null：
    // 无法确定要哪个 RTP 就不报，猜错会让用户白下 244MB（§9 R1 的处置）。
    const missing = detectMissingRtp(engineDir, game.gameEngine, wanted.rtp)
    if (missing) diagnoses.push(missing)
  }

  const fonts = detectFontsPresent(dir)
  if (fonts) diagnoses.push(fonts)

  return sortDiagnoses(diagnoses)
}
