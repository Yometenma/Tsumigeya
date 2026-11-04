// M2.5-C：多语言版本偏好（docs/M2.5-实施方案.md §C）。
//
// 先厘清一件容易搞错的事（§1.5 实测）：DLsite 的 `lang_options` 是**作品单值字段**
// （如 "JPN"），不是「同一游戏的多语言版列表」。不同语言版在 DLsite 上是**独立 RJ 号**。
// 所以本功能与 DLsite 无关，纯粹是**本地文件层面**的判断：
//
//   同一款游戏，用户机器上有多个语言版本的文件夹，希望启动时按偏好选。
//
// 设计取向：**宁可少认，不要错认**（§C.2）。认错组会让用户点启动时被引到另一个游戏，
// 比「没认出来、什么都不提示」严重得多。
//
// ⚠️ 零依赖纯函数：主进程、渲染层、vitest 三处共用一份实现。

/** 支持识别的语言。 */
export type GameLanguage = 'zh' | 'ja' | 'en' | 'ko'

export const GAME_LANGUAGES: readonly GameLanguage[] = ['zh', 'ja', 'en', 'ko'] as const

/**
 * 语言标记 → 语言。
 *
 * 只收**明确的**缩写/词，不做模糊猜测（例如单独的 `c`、`t` 不算）。
 * 全部按小写比较；顺序无关，碰到第一个命中的就用。
 */
const LANGUAGE_MARKERS: ReadonlyArray<readonly [string, GameLanguage]> = [
  // 中文（简体优先；繁中也归到 zh——对"想玩中文版"的用户来说它们是同一诉求）
  ['chs', 'zh'],
  ['cht', 'zh'],
  ['chn', 'zh'],
  ['sc', 'zh'],
  ['tc', 'zh'],
  ['cn', 'zh'],
  ['zh', 'zh'],
  ['简体中文', 'zh'],
  ['繁體中文', 'zh'],
  ['繁体中文', 'zh'],
  ['中文版', 'zh'],
  ['简中', 'zh'],
  ['繁中', 'zh'],
  ['中文', 'zh'],
  ['汉化版', 'zh'],
  ['漢化版', 'zh'],
  ['汉化', 'zh'],
  ['漢化', 'zh'],
  // 日文
  ['jpn', 'ja'],
  ['jp', 'ja'],
  ['ja', 'ja'],
  ['日文版', 'ja'],
  ['日文', 'ja'],
  ['日本語', 'ja'],
  ['日本语', 'ja'],
  // 英文
  ['eng', 'en'],
  ['en', 'en'],
  ['us', 'en'],
  ['英文版', 'en'],
  ['英文', 'en'],
  // 韩文
  ['kor', 'ko'],
  ['kr', 'ko'],
  ['ko', 'ko'],
  ['韩文版', 'ko'],
  ['韓文版', 'ko'],
  ['韩文', 'ko'],
  ['韓文', 'ko']
]

/** 把标记按长度**从长到短**排序再匹配：避免 `jpn` 被 `jp` 抢先、`chs` 被 `cs` 之类的误命中。 */
const SORTED_MARKERS = [...LANGUAGE_MARKERS].sort((a, b) => b[0].length - a[0].length)

/**
 * 版本号 / 补丁号后缀，剥掉但不产生 lang。
 *
 * ⚠️ **裸的单个数字不算版本号**（这是实测纠错，代价很大）：
 * 第一版写成 `v?\d+(?:[._]\d+)*`，结果 `傭兵の冒険2_CHN` 被剥成 `傭兵の冒険`，
 * 于是「傭兵の冒険」和它的续作「傭兵の冒険2」被判为**同一款游戏的多语言版**——
 * 用户点启动会被引到另一个作品。这正是 §C.2 说的「宁可少认，不要错认」。
 *
 * 所以只在两种情况下认版本号：
 *   ① 有显式 `v`/`ver` 前缀：`Game_v1.0.10`
 *   ② 是**多段**数字（含小数点）：`Game_1.0.2`（单段裸数字可能是作品序号，保守不剥）
 *
 * ⚠️ 第二次纠错：小数分隔符必须是**真正的点**（`[.]`），不能把 `_` 也算进去。
 * 写成 `[._]` 时，`Game2_1.0.2` 会被从中间吃掉 `2_1.0.2` 而剥成 `Game`，
 * 于是「Game2」的续作序号又被吃掉了——和第一个坑一模一样的后果。
 */
const VERSION_SUFFIX = /[\s._-]*(?:v|ver)[\s._-]*\d+(?:\.\d+)*[\s._-]*$|[\s._-]*\d+(?:\.\d+)+[\s._-]*$/i

/**
 * 剥离语言后缀与版本号（§C.3）。
 *
 * 例：
 *   `傭兵の冒険_CHN`   → { base: '傭兵の冒険', lang: 'zh' }
 *   `傭兵の冒険`       → { base: '傭兵の冒険', lang: undefined }
 *   `Game_v1.0.10`    → { base: 'Game', lang: undefined }
 *   `Game_CHS_v1.2`   → { base: 'Game', lang: 'zh' }（语言与版本混着也能剥）
 *
 * 只处理**末尾**的标记：`CHN` 出现在中间（如 `CHN_Game`）不算，
 * 因为那多半是别的含义（地区、作者名），贸然认成语言会错认组。
 */
export function stripLanguageSuffix(name: unknown): { base: string; lang?: GameLanguage } {
  if (typeof name !== 'string') return { base: '' }
  let base = name.trim()
  if (!base) return { base: '' }

  let lang: GameLanguage | undefined
  // 最多剥两轮：允许 `Game_CHS_v1.2` 这种「语言 + 版本」的组合，也允许顺序反过来
  for (let round = 0; round < 2; round += 1) {
    const before = base
    // ① 先试版本号（它通常在最后）
    const withoutVersion = base.replace(VERSION_SUFFIX, '')
    if (withoutVersion !== base) {
      base = withoutVersion
    }
    // ② 再试语言标记（必须紧贴末尾，前缀必须是分隔符或字符串开头）
    const matched = matchTrailingLanguage(base)
    if (matched) {
      base = matched.base
      lang = lang ?? matched.lang
    }
    if (base === before) break
  }

  base = base.replace(/[\s._-]+$/, '').trim()
  // 只剥到一个空字符串时，说明整个名字都是标记（罕见），保留原名更安全
  if (!base) return { base: name.trim(), lang }
  return lang ? { base, lang } : { base }
}

/** 末尾是否紧贴一个语言标记；是则返回剥掉后的 base。 */
function matchTrailingLanguage(value: string): { base: string; lang: GameLanguage } | null {
  const lower = value.toLowerCase()
  for (const [marker, lang] of SORTED_MARKERS) {
    if (!lower.endsWith(marker)) continue
    const cutAt = value.length - marker.length
    // 标记前面必须是分隔符（或整个串就是标记本身，那种情况由调用方兜底）
    const before = cutAt > 0 ? value[cutAt - 1] : ''
    if (cutAt === 0) continue // `_CHN` 单独一个词不算好名字，交给外层判断
    if (!/[\s._\-()（）]/.test(before)) continue
    return { base: value.slice(0, cutAt), lang }
  }
  return null
}

/**
 * 标题归一化：小写、去空白、去括号内容、去语言/版本后缀。
 * 用于「两个游戏是不是同一款」的相似度比较。
 */
export function normalizeTitle(title: unknown): string {
  if (typeof title !== 'string') return ''
  const stripped = stripLanguageSuffix(title).base
  return stripped
    .toLowerCase()
    // 去括号内容（全角与半角都算）：`傭兵の冒険【アップデート版】` 与 `傭兵の冒険` 要能对上
    .replace(/【[^】]*】/g, '')
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/[\s\u3000]+/g, '')
    // 常见修饰词/符号：不影响"是不是同一款"的判断
    .replace(/[!！?？.,，。、…·・:：;；'"'"~～\-_—–]+/g, '')
    .trim()
}

/** 语言的小写别名（UI 展示用）。 */
export function languageShortName(lang: GameLanguage): string {
  const table: Record<GameLanguage, string> = { zh: '中文', ja: '日文', en: '英文', ko: '韩文' }
  return table[lang]
}
