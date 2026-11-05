// M4 S3：存档导出包的**判据** -- 纯函数，零依赖。
//
// ===== 这个文件管三件事，每件都有"错了不报错"的失败面 =====
//
// ① **包名**（`tsumigeya-save-<游戏名>-<YYYYMMDD-HHMM>.zip`）
//    错了的后果：用户在访达里看到一堆 `tsumigeya-save---2026.zip`，
//    或者两个游戏的包同名互相覆盖（游戏的标题里可能有 `/` `:` `*` 等
//    **文件系统非法字符**，Windows 上 `:` 更是直接让 open 失败）。
//
// ② **manifest.json 的结构与 sha256**
//    这是导入端（S4）唯一可信的依据。S4 的规矩是「只接受我们导出的包」，
//    依据就是"manifest 里的 sha256 能对上"。
//    ⇒ 所以**导出端算的哈希必须与导入端校验的算法完全一致**，
//      否则用户带着包换机会被自己拒之门外（而且报错文案只会说"校验不过"，
//      查不出是算法不同）。
//
// ③ **运行中禁止导出**
//    判据本身是"进程表里有没有这个游戏"（D50：只在内存），
//    但**提示怎么给**是由这里定的（`exportBlockedReason`）——
//    这条必须与"找不到存档位置"分开，否则用户会去查目录而不是去关游戏。
//
// ⚠️ 零依赖：不 import vue / pinia / i18n / electron / fs / crypto。
//    sha256 的实现留在主进程（`node:crypto`），这里只定**格式**（小写十六进制、64 位）。

/** 导出包里 manifest.json 的内容（S4 的导入端照这个读）。 */
export interface SaveManifest {
  /** 游戏标题（用户库里的，不是 DLsite 的）。 */
  gameTitle: string
  /** 引擎模块名（nwjs / mkxpz / easyrpg / renpy）。 */
  engine: string
  /** 布局类别（nwjs-mv / nwjs-mz / rgss-data / ...）。 */
  layout: string
  /** 导出时刻（ISO 8601）。 */
  exportedAt: string
  /**
   * 打包进去的**每一个**文件（含槽、配置、插件文件）。
   *
   * `name` 是包内相对 `saves/` 的文件名，`sha256` 是小写十六进制的 64 位。
   * ⚠️ 这里**不收子目录**：存档目录是平铺的（实测 Karryn's Prison 的
   * `www/save/` 全是平铺文件）。真遇到子目录就整体跳过并在结果里报出来，
   * 而不是悄悄少带一个 —— 见 `collectExportFiles` 的注释。
   */
  files: Array<{ name: string; sha256: string }>
}

/** manifest 的格式版本（将来改结构时用它分辨旧包）。 */
export const SAVE_MANIFEST_VERSION = 1

/** 包内 manifest 的路径（固定）。 */
export const SAVE_MANIFEST_PATH = 'manifest.json'

/** 包内存档目录的路径前缀（固定）。 */
export const SAVE_FILES_PREFIX = 'saves/'

/** 导出包的扩展名（`.zip`，mac 上双击就能看内容）。 */
export const SAVE_ARCHIVE_EXT = '.zip'

/**
 * 把游戏标题洗成**文件系统安全**的片段。
 *
 * 规则（每条都有单测）：
 *   · 非法字符 `/ \ : * ? " < > |` → `_`（Windows 上 `:` 会让创建文件直接失败）
 *   · 控制字符（\u0000-\u001f）→ 去掉
 *   · 首尾空白与点 → 去掉（`.zip` 与 `.` 开头的文件名在有些工具里行为诡异）
 *   · 空白 → `-`（少用空格：包名常被贴进命令行/聊天框，空格会被截断）
 *   · 过长的截断到 60 个字符（各平台都接受，且访达里能看全）
 *   · 洗完是空的（比如标题全是中文标点）→ 用 `game`
 *
 * ⚠️ 刻意**保留中文**：用户的游戏名大多是中文，洗成拼音或 ASCII 反而认不出来。
 *    UTF-8 文件名在 mac / Windows 现代版本都没问题。
 */
export function safeArchiveNamePart(title: string | undefined | null): string {
  const raw = typeof title === 'string' ? title : ''
  const cleaned = raw
    // 控制字符直接去掉（它们连"替换成下划线"的价值都没有）
    .replace(/[\u0000-\u001f]/g, '')
    // 文件系统保留字符统一换成下划线
    .replace(/[/\\:*?"<>|]/g, '_')
    // 空白折成连字符
    .replace(/\s+/g, '-')
    // 连续的连字符/下划线压缩（`a__-_-b` 这类是噪音）
    .replace(/[-_]{2,}/g, (match) => (match.includes('-') ? '-' : '_'))
    .replace(/^[-_.]+/, '')
    .replace(/[-_.]+$/, '')
    .slice(0, 60)
    .replace(/[-_.]+$/, '')
  return cleaned || 'game'
}

/**
 * 时刻 → `YYYYMMDD-HHMM`（**本地时间**）。
 *
 * 为什么用本地时间而不是 UTC：用户在访达里看到的时间是本地时间，
 * 包名与他记忆里的"我昨天下午导的"必须对得上。UTC 会差 8 小时（中国用户）。
 *
 * ⚠️ 不用 `toISOString().slice()`：那是 UTC，会让包名与访达显示差一天。
 * ⚠️ 月份是 0 基（`getMonth() + 1`），忘了 +1 的后果是"11 月导出显示 10 月"。
 */
export function archiveTimestamp(at: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const year = at.getFullYear()
  const month = pad(at.getMonth() + 1)
  const day = pad(at.getDate())
  const hour = pad(at.getHours())
  const minute = pad(at.getMinutes())
  return `${year}${month}${day}-${hour}${minute}`
}

/**
 * 完整的导出包文件名：`tsumigeya-save-<游戏名>-<YYYYMMDD-HHMM>.zip`
 *
 * 例：`tsumigeya-save-Karryn's-Prison-20261105-1440.zip`
 */
export function archiveFileName(title: string | undefined | null, at: Date): string {
  return `tsumigeya-save-${safeArchiveNamePart(title)}-${archiveTimestamp(at)}${SAVE_ARCHIVE_EXT}`
}

/** 导出被拒绝的原因（**不是**错误文案，是可翻译的键 + 参数）。 */
export type ExportBlock =
  /** 游戏正在运行：导出的包可能是半截文件，换机会丢档。 */
  | { kind: 'running' }
  /** 找不到存档位置（什么都没打包）。 */
  | { kind: 'noLocation' }
  /** 位置找到了但目录里一个文件都没有（还没存过档）。 */
  | { kind: 'empty' }

/**
 * 能不能导出（**运行中一律禁止**，这是 S3 的硬要求）。
 *
 * ===== 为什么运行中必须禁止 =====
 *
 * 游戏正在写存档时我们把它读出来，得到的是一个**半截文件**：
 * 头对、尾巴缺。用户带着这个包换机，导入后游戏会报存档损坏 ——
 * 而他完全想不到问题出在"当初导出时游戏没关"。
 *
 * 这类故障**没有任何自愈余地**（存档是游戏的格式，我们不解析也不修，见方案 §6），
 * 所以必须在源头拦住，而不是事后提示。
 *
 * 判定顺序：先判运行（那是"现在就能解决"的，让用户去关游戏），
 * 再判位置（那是"要去查"的）。反过来会让一个正在跑的游戏显示"找不到存档"，
 * 用户就去查目录了 —— 而真正的问题是"关掉游戏"。
 */
export function exportBlocked(input: {
  running: boolean
  hasLocation: boolean
  empty: boolean
}): ExportBlock | null {
  if (input.running) return { kind: 'running' }
  if (!input.hasLocation) return { kind: 'noLocation' }
  if (input.empty) return { kind: 'empty' }
  return null
}

/** sha256 文本的形状（小写十六进制 64 位）。 */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

/**
 * 解析 manifest.json 的原文（S4 用；这里定判据，S3 只写）。
 *
 * 为什么现在就把**读**的判据写出来：导出端与导入端必须用同一份结构。
 * 分成两个文件各写一半的话，漂移的表现是"自己导出的包自己拒收"。
 *
 * 返回 `null` = 不是我们的包（或缺字段）—— 调用方按"拒绝"处理，
 * **不要**去猜缺了什么再试着补（猜错了就是拿用户的存档冒险）。
 */
export function parseSaveManifest(raw: unknown): SaveManifest | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  if (typeof obj.gameTitle !== 'string') return null
  if (typeof obj.engine !== 'string') return null
  if (typeof obj.layout !== 'string') return null
  if (typeof obj.exportedAt !== 'string') return null
  if (!Array.isArray(obj.files)) return null
  const files: SaveManifest['files'] = []
  for (const entry of obj.files) {
    if (!entry || typeof entry !== 'object') return null
    const item = entry as Record<string, unknown>
    if (typeof item.name !== 'string' || !item.name) return null
    if (!isSha256Hex(item.sha256)) return null
    files.push({ name: item.name, sha256: item.sha256 })
  }
  return {
    gameTitle: obj.gameTitle,
    engine: obj.engine,
    layout: obj.layout,
    exportedAt: obj.exportedAt,
    files
  }
}

/**
 * 校验「包内实际文件」与 manifest 是否一致。
 *
 * 返回不一致的项（应当是空数组）。三种不一致都有独立含义：
 *   · `missing`  → manifest 里有、包内没有（包被改过/传输丢了）
 *   · `extra`    → 包内有、manifest 里没有（有人往包里塞了东西）
 *   · `mismatch` → 名对上了但 sha256 不同（内容被改过）
 *
 * ⚠️ **extra 也要拒**：只校验"manifest 里的都在"的话，攻击面是
 * "往包里多塞一个同名不同路径的文件"（zip 里 `saves/file1.rpgsave` 出现两次，
 * 解压工具取哪个取决于实现）。既然只接受我们导出的包，就按完全一致来。
 */
export function verifyManifestFiles(
  manifest: SaveManifest,
  actual: ReadonlyArray<{ name: string; sha256: string }>
): {
  missing: string[]
  extra: string[]
  mismatch: string[]
} {
  const expected = new Map(manifest.files.map((file) => [file.name, file.sha256]))
  const seen = new Map(actual.map((file) => [file.name, file.sha256]))
  const missing: string[] = []
  const mismatch: string[] = []
  for (const [name, sha] of expected) {
    const got = seen.get(name)
    if (got === undefined) missing.push(name)
    else if (got !== sha) mismatch.push(name)
  }
  const extra = [...seen.keys()].filter((name) => !expected.has(name))
  return { missing, extra, mismatch }
}
