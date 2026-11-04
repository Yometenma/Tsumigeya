// M2.5-C：多语言版本**分组**（docs/M2.5-实施方案.md §C.2）。
//
// 规则（保守，宁少不错）：
//   a. 两个游戏都识别出语言标记，且**语言不同**；
//   b. 标题归一化后相似度 ≥ 阈值（默认 0.8，用户 2026-11-04 确认）；
//   c. 绝不把「没有语言标记」的游戏拉进任何组 —— 没有标记就没有依据，
//      硬猜会把用户的日文原版和某个中文游戏错配一起，点启动时被引到错的游戏。
//
// ⚠️ 零依赖纯函数：主进程 / 渲染层 / vitest 共用一份。

import { normalizeTitle, stripLanguageSuffix, type GameLanguage } from './game-language'

/** 默认相似度阈值（§7-② 用户确认 0.8）。 */
export const DEFAULT_SIMILARITY_THRESHOLD = 0.8

/** 参与分组的游戏（只取分组需要的字段，不依赖 GameRecord 全貌）。 */
export interface LanguageGroupCandidate {
  /** 游戏唯一标识（GameRecord.id）。 */
  id: string
  /** 标题来源：优先 gameTitle，没有 DLsite 元数据时它就是唯一依据。 */
  title: string
  /** 游戏路径（也参与语言识别：用户常把语言标记放在更深一层的目录上）。 */
  path?: string
}

/** 一个多语言版本组。 */
export interface LanguageGroup {
  /** 归一化后的组标题（仅用于调试与展示，不保证唯一）。 */
  base: string
  /** 成员：id → 该成员识别出的语言。 */
  members: Array<{ id: string; lang: GameLanguage }>
}

export interface GroupOptions {
  /** 相似度阈值，默认 0.8。 */
  threshold?: number
}

/**
 * 从游戏路径里取语言标记。
 *
 * 为什么要看路径：用户的真实布局是
 *   `E:\Game\RPG\傭兵の冒険\傭兵の冒険_CHN`（语言标记在最内层）
 *   `E:\Game\RPG\傭兵の冒険_CHN\`（也可能直接挂在游戏目录上）
 * 只看标题会漏掉后者（标题可能是纯日文原名）。
 *
 * 做法：从最内层往外看若干段，**取最内层第一个命中的**（离游戏本体最近，最可信）。
 */
function languageFromPath(path: string | undefined): GameLanguage | undefined {
  if (typeof path !== 'string' || !path.trim()) return undefined
  const segments = path
    .split(/[\\/]+/)
    .filter((segment) => segment.trim().length > 0)
    .reverse()
  for (const segment of segments) {
    const found = stripLanguageSuffix(segment).lang
    if (found) return found
  }
  return undefined
}

/**
 * 一个游戏自身的语言：**路径优先，标题兜底**。
 *
 * 为什么路径优先：用户实际把 `_CHN` 打在文件夹上，而标题常常是作者写的原名（不带标记）。
 * 反过来（标题优先）会把「标题末尾恰好有 JP/EN」的作品误判。
 *
 * 注意：这里**只认显式标记**。父目录推断（无标记→ja）是分组阶段的逻辑，
 * 见 `applyParentFolderInference()`，因为它需要看到全部候选才能判断。
 */
export function detectGameLanguage(candidate: LanguageGroupCandidate): GameLanguage | undefined {
  return languageFromPath(candidate.path) ?? stripLanguageSuffix(candidate.title).lang
}

/**
 * 相似度：归一化后的 Levenshtein 距离换算成 [0,1]。
 *
 * 为什么用编辑距离而不是字符集重合：`傭兵の冒険` 与 `傭兵の冒険2` 的字符集几乎全重合，
 * 但它们是**两个不同作品**，必须靠位置信息区分。编辑距离能给出 0.833 的差，
 * 单靠阈值 0.8 挡不住 —— 真正的防线见 `isSuffixExtension()`。
 */
export function similarity(a: string, b: string): number {
  const left = a ?? ''
  const right = b ?? ''
  if (!left && !right) return 1
  if (!left || !right) return 0
  if (left === right) return 1

  const rows = left.length + 1
  const cols = right.length + 1
  // 标准 Levenshtein，滚动一维数组（避免 2D 大数组）
  let previous: number[] = new Array(cols)
  let current: number[] = new Array(cols)
  for (let col = 0; col < cols; col += 1) previous[col] = col
  for (let row = 1; row < rows; row += 1) {
    current[0] = row
    for (let col = 1; col < cols; col += 1) {
      const cost = left[row - 1] === right[col - 1] ? 0 : 1
      current[col] = Math.min(
        previous[col] + 1, // 删除
        current[col - 1] + 1, // 插入
        previous[col - 1] + cost // 替换
      )
    }
    const swap = previous
    previous = current
    current = swap
  }
  const distance = previous[cols - 1]
  const longest = Math.max(left.length, right.length)
  return 1 - distance / longest
}

/**
 * 「短的那个是长的那个的**前缀**」→ 视为不同的作品，禁止成组。
 *
 * ⚠️ 这条是**实测必要性**：`傭兵の冒険` vs `傭兵の冒険2` 的归一化相似度是 **0.833**，
 * 高于 0.8 阈值 —— 光靠阈值会把续作判成原作的多语言版，用户点启动就被引到错的游戏。
 *
 * 为什么"前缀关系"是可靠的区分：
 * - 多语言版的差异**已经被剥离了**（`_CHN` 在 normalizeTitle 阶段就没了），
 *   所以真正的多语言版本归一化后应当是**完全相同**的（相似度 1.0）；
 * - 归一化后还差一个尾巴（`2`、`完全版`、`DLC`…），那是**另一个商品**，不是语言差异。
 *
 * 代价：`傭兵の冒険` 与 `傭兵の冒険【完全版】` 也不会成组。这是**有意的保守**——
 * 按 §C.2「宁可少认，不要错认」，漏认的后果是"没提示"，错认的后果是"启动错游戏"。
 */
export function isSuffixExtension(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return false
  const longer = a.length >= b.length ? a : b
  const shorter = a.length >= b.length ? b : a
  if (longer.length <= shorter.length) return false
  return longer.startsWith(shorter)
}

/**
 * 父目录推断（§C.2 用户样本支持的那一条）。
 *
 * 场景：用户的真实布局是
 *   `E:\Game\RPG\傭兵の冒険\`           ← 日文原版，**目录名本身没有语言标记**
 *   `E:\Game\RPG\傭兵の冒険\傭兵の冒険_CHN\` ← 中文版，标记在最内层
 * 按规则 2a「两者都必须识别出语言」这条样本永远成不了组。
 *
 * 所以补一条**极保守**的推断：只在一个候选**完全没有**语言标记、
 * 且它正好是另一个「已识别出非 ja 语言」的候选的**祖先目录**时，
 * 把它当 ja（日文原版）。
 *
 * 为什么是 ja 而不是别的：这套判定服务的场景是「日系游戏 + 中文化补丁」，
 * 没打语言标记的那份几乎总是作者发布的原版（日文）。这也正是 §C.2 样本的预期。
 *
 * 为什么必须先确认「它没有任何标记」：如果父目录自己写着 `_EN`，那它就是英文版，
 * 不能被推断覆盖（那种情况由显式标记优先）。
 */
export function applyParentFolderInference(
  candidates: readonly LanguageGroupCandidate[]
): Array<{ id: string; lang: GameLanguage; inferred: boolean }> {
  const result: Array<{ id: string; lang: GameLanguage; inferred: boolean }> = []
  const normalizedPath = (value: string | undefined): string => {
    if (typeof value !== 'string') return ''
    // 统一分隔符 + 去掉尾部斜杠，方便做「谁是谁的祖先」判断
    return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  }

  for (const candidate of candidates) {
    const explicit = detectGameLanguage(candidate)
    if (explicit) {
      result.push({ id: candidate.id, lang: explicit, inferred: false })
      continue
    }
    // 自己没标记 → 看有没有「住在自己肚子里」且标了非 ja 语言的候选
    const ownPath = normalizedPath(candidate.path)
    if (!ownPath) {
      result.push({ id: candidate.id, lang: undefined as never, inferred: false })
      continue
    }
    const child = candidates.find((other) => {
      if (other.id === candidate.id) return false
      const otherPath = normalizedPath(other.path)
      if (!otherPath || otherPath === ownPath) return false
      if (!otherPath.startsWith(`${ownPath}/`)) return false
      const otherLang = detectGameLanguage(other)
      // 只把「住在自己目录下、且语言不是 ja」的那个当依据：
      // 若子目录也是 ja，说明父目录没有"多语言"关系可言
      return otherLang !== undefined && otherLang !== 'ja'
    })
    if (child) result.push({ id: candidate.id, lang: 'ja', inferred: true })
    else result.push({ id: candidate.id, lang: undefined as never, inferred: false })
  }
  return result.filter((item) => item.lang !== undefined)
}

/**
 * 把候选游戏按「同一款的多语言版」分组。
 *
 * 返回**只包含 ≥2 个成员且语言各不相同的**组。单成员不算组（用户样本里
 * 「傭兵の冒険 仅此一个时不成组」就是这个意思）。
 */
export function groupByLanguage(
  candidates: readonly LanguageGroupCandidate[],
  options: GroupOptions = {}
): LanguageGroup[] {
  const threshold = options.threshold ?? DEFAULT_SIMILARITY_THRESHOLD

  // ① 先给每个候选算出语言与归一化标题；没有语言的直接淘汰
  // （父目录推断在这里生效：无标记的日文原版会被推成 ja）
  const inferred = applyParentFolderInference(candidates)
  const langById = new Map(inferred.map((item) => [item.id, item.lang]))

  const prepared: Array<{ id: string; lang: GameLanguage; normalized: string }> = []
  for (const candidate of candidates) {
    const lang = langById.get(candidate.id)
    if (!lang) continue
    const normalized = normalizeTitle(candidate.title) || normalizeTitle(stripLanguageSuffix(candidate.title).base)
    if (!normalized) continue
    prepared.push({ id: candidate.id, lang, normalized })
  }

  // ② 并查集：两两比较，满足「语言不同 + 相似度过阈值」才合并
  const parent = new Map<string, string>()
  for (const item of prepared) parent.set(item.id, item.id)
  const find = (id: string): string => {
    let root = id
    while (parent.get(root) !== root) root = parent.get(root) as string
    // 路径压缩
    let cursor = id
    while (parent.get(cursor) !== root) {
      const next = parent.get(cursor) as string
      parent.set(cursor, root)
      cursor = next
    }
    return root
  }
  const union = (a: string, b: string): void => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) parent.set(rootA, rootB)
  }

  for (let i = 0; i < prepared.length; i += 1) {
    for (let j = i + 1; j < prepared.length; j += 1) {
      const left = prepared[i]
      const right = prepared[j]
      // 规则 a：语言必须不同（同语言的两个条目不是"多语言版"，是重复安装）
      if (left.lang === right.lang) continue
      // 规则 b：归一化标题必须是**同一款**——前缀关系视为不同作品（见 isSuffixExtension）
      if (isSuffixExtension(left.normalized, right.normalized)) continue
      if (similarity(left.normalized, right.normalized) < threshold) continue
      union(left.id, right.id)
    }
  }

  // ③ 收集组，丢掉「全是同一种语言」的（并查集可能把 a-zh、a-zh、a-ja 合成一组，
  //    那仍然是有意义的，只要语言数 ≥2）
  const byRoot = new Map<string, Array<{ id: string; lang: GameLanguage }>>()
  for (const item of prepared) {
    const root = find(item.id)
    const list = byRoot.get(root) ?? []
    list.push({ id: item.id, lang: item.lang })
    byRoot.set(root, list)
  }

  const groups: LanguageGroup[] = []
  for (const members of byRoot.values()) {
    if (members.length < 2) continue
    const languages = new Set(members.map((member) => member.lang))
    if (languages.size < 2) continue // 同语言重复安装，不是多语言版
    // 组的 base：取组内最长归一化标题（通常最完整），仅作展示/调试
    const longest = prepared
      .filter((item) => members.some((member) => member.id === item.id))
      .reduce((best, item) => (item.normalized.length > best.length ? item.normalized : best), '')
    groups.push({ base: longest, members })
  }
  return groups
}
