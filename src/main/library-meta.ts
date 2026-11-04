// library-meta.json：DLsite 元数据的旁挂存储（M2 §3.2）。
// 为什么单独一个文件：D10 要求 GameRecord 与上游 schema 零改动，删掉本文件游戏库照常能启动。
//
// ⚠️ 本文件不 import electron（vitest 直接跑）。
// 与 dlsite 缓存的区别：这里的损坏文件**绝不静默覆盖**（是用户数据），缓存则可重建（见 dlsite.ts）。
import fs from 'node:fs'
import path from 'node:path'
import { component, readJSON, writeJSON } from './games-store'
import { normalizeCoverUrl } from './dlsite'
import type { DlsiteWork } from './dlsite'

/** 一条游戏的 DLsite 元数据。字段即 DlsiteWork（含 rj / fetchedAt）。 */
export type GameMeta = DlsiteWork

/**
 * M2.5-B：可被用户手动编辑的字段白名单（§B.3，用户 2026-11-04 确认）。
 *
 * **不给编辑 `rj`**——改 RJ 等于换作品，应该走「重新搜索 / 填 RJ」流程，
 * 否则会出现「标题属于 A 作品、RJ 属于 B 作品」的错位数据。
 */
export const EDITABLE_FIELDS = ['title', 'circle', 'coverUrl', 'registDate', 'price'] as const

export type EditableField = (typeof EDITABLE_FIELDS)[number]

/** 磁盘形态：`{ "<gameId>": GameMeta }`（条目里带 edited / editedFields）。 */
export type GameMetaMap = Record<string, GameMeta>

export interface LibraryMetaStore {
  readonly metaFile: string
  load(): GameMetaMap
  /**
   * 保存一条元数据。
   * `editedFields` 会与磁盘上已有的值**合并**（不是覆盖）：用户这次改了标题、
   * 下次只改社团，标题仍应保留「被编辑过」的标记，否则下次刷新会把标题冲掉。
   */
  save(gameId: string, meta: GameMeta, editedFields?: readonly EditableField[]): GameMetaMap
  remove(gameId: string): GameMetaMap
}

/**
 * 把任意输入收敛成合法字段名：丢弃未知名字、去重，并**按白名单顺序排序**。
 *
 * 排序是刻意的：并集（见 `save()`）与合并（见 `mergeWork()`）都会把两批字段拼起来，
 * 不归一顺序的话磁盘上的数组顺序会随「用户先改了哪个字段」而抖动，
 * 造成无意义的 diff、也让单测难写。白名单顺序是唯一权威顺序。
 */
export function normalizeEditedFields(value: unknown): EditableField[] {
  if (!Array.isArray(value)) return []
  const present = new Set<string>()
  for (const item of value) {
    if (typeof item === 'string') present.add(item.trim())
  }
  return EDITABLE_FIELDS.filter((field) => present.has(field))
}

/**
 * M2.5-B 的核心：把「新抓到的 DLsite 数据」与「库里已存的条目」合并（§B.2）。
 *
 * 规则：
 * - 用户在 `editedFields` 里列出的字段，**保留库里的值**（不覆盖）；
 * - 其余字段用新抓到的值；
 * - `editedFields` 与 `edited` 标记原样保留，`fetchedAt` 更新为新数据的抓取时间
 *   （它代表「最后一次成功抓取」，不是用户编辑 —— 所以不在可编辑白名单里）。
 *
 * 纯函数：不读写盘，方便单测直接钉住规则。`keep` 为空时等价于「全量覆盖」。
 */
/**
 * 合并一次「重新获取」的结果。
 *
 * `incoming` 整体覆盖 `previous`，除了两类例外：
 *
 * ① **用户编辑过的字段**（`keep`，D26）：用户手改的值不该被一次刷新冲掉。
 * ② **只在搜索结果页才有的字段**（M2.6 §3.1：author / salesCount / rating）。
 *    这三项从详情页重拉时**天然拿不到**（`contents` JSON 里没有），
 *    直接按 `{...incoming}` 覆盖会把之前搜到并保存的值抹成 undefined——
 *    用户明明有过作者信息，一次「重新获取」就消失了。
 *
 *    ⚠️ 只在 `incoming` 缺这个值时才回退到 previous；`incoming` 有新值就用新的
 *    （例如将来 DLsite 改了页面结构、详情页也能拿到时，这条回退不会挡路）。
 */
export function mergeWork(previous: GameMeta, incoming: DlsiteWork, keep?: readonly EditableField[]): GameMeta {
  const kept = normalizeEditedFields(keep ?? previous.editedFields)
  const merged: GameMeta = { ...incoming, fetchedAt: incoming.fetchedAt }
  // ② M2.6：搜索页专有字段——incoming 没有就沿用上一份
  if (merged.author === undefined) merged.author = previous.author
  if (merged.salesCount === undefined) merged.salesCount = previous.salesCount
  if (merged.rating === undefined) merged.rating = previous.rating
  for (const field of kept) {
    // 只覆盖值；`price` 是数字，`undefined` 也算合法（用户清空过）
    const value = previous[field]
    if (field === 'price') {
      merged.price = typeof value === 'number' ? value : undefined
    } else {
      merged[field] = value as never
    }
  }
  merged.edited = kept.length > 0
  merged.editedFields = kept
  return merged
}

function requireGameId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw Object.assign(new Error('Invalid game id'), {
      translationKey: 'error.dlsiteGameRequired',
      translationArguments: {}
    })
  }
  // 与 games-store 的 component 同规则：挡掉 ../ 与分隔符，防止拼出目录外的路径
  return component(value, 'game id')
}

/**
 * 只保留已知字段 + 必填校验：外部（页面）数据写进库之前必须过一遍，
 * 免得 DLsite 哪天多塞个奇怪字段就把我们的 JSON 撑变形。
 */
/**
 * 条目必须是普通对象。抽成命名函数是因为 **两处**都要这份判断：
 * `sanitize()` 自己做一遍，`save()` 在展开（`{...meta}`）之前也得先挡一遍，
 * 否则 `{...[]}` 会把数组悄悄变成 `{}`，错误从「不是合法条目」退化成「缺 rj」。
 */
function assertObject(gameId: string, meta: unknown): void {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    throw Object.assign(new Error(`Invalid DLsite metadata for game ${gameId}`), {
      translationKey: 'error.dlsiteParse',
      translationArguments: { rj: '' }
    })
  }
}

function sanitize(gameId: string, meta: unknown): GameMeta {
  assertObject(gameId, meta)
  const source = meta as Record<string, unknown>
  const rj = typeof source.rj === 'string' ? source.rj.trim() : ''
  if (!rj) {
    throw Object.assign(new Error('DLsite metadata is missing rj'), {
      translationKey: 'error.dlsiteInvalidRj',
      translationArguments: { rj: '' }
    })
  }
  const text = (key: string): string | undefined => {
    const value = source[key]
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  }
  const num = (key: string): number | undefined => {
    const value = source[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }
  // coverUrl 走与主进程其它地方**同一条**白名单（D22）：用户手填也算外部输入，
  // 不能让任意远程图混进渲染层。
  const coverUrl = normalizeCoverUrl(source.coverUrl)

  // M2.5-B：编辑标记。`edited` 由 editedFields 派生，不信任外部传入的 true
  // （否则「有 edited=true 但没有任何被编辑字段」会出现语义矛盾的状态）。
  const editedFields = normalizeEditedFields(source.editedFields)

  return {
    rj,
    title: text('title') ?? rj,
    titleFull: text('titleFull'),
    circle: text('circle'),
    circleId: text('circleId'),
    seriesName: text('seriesName'),
    category: text('category'),
    workType: text('workType'),
    registDate: text('registDate'),
    price: num('price'),
    priceWithTax: num('priceWithTax'),
    officialPrice: num('officialPrice'),
    discount: num('discount'),
    coverUrl,
    description: text('description'),
    // M2.6 §4.1：四个新字段必须在这层白名单里出现，否则 S1 解析出来的值会被**静默丢掉**
    // （端到端探针实测踩到：saveGameMeta 回执里的 keys 缺 summary/author/salesCount/rating）。
    summary: text('summary'),
    author: text('author'),
    salesCount: num('salesCount'),
    rating: num('rating'),
    fetchedAt: text('fetchedAt') ?? new Date().toISOString(),
    edited: editedFields.length > 0,
    editedFields
  }
}

export function createLibraryMetaStore(dataDir: string): LibraryMetaStore {
  const metaFile = path.join(dataDir, 'library-meta.json')

  /** 损坏文件会抛 error.invalidObject（由 readJSON 抛），原文件保持不动。 */
  /**
   * 读盘。
   *
   * ⚠️ M5.0 S7：本文件**多了两个非游戏顶层键**（`categories` 定义表与
   * `assignments` 归属表，见 category-store.ts）。这里必须把它们过滤掉，
   * 否则 `categories` 会被当成一个**游戏 id** 混进 meta ——
   * 渲染层 `library.meta['categories']` 会拿到定义表，
   * 而任何"遍历 meta"的逻辑（U4 的 unboundCount 等）会把它算成一个未绑定游戏。
   * 不报错，只是数字悄悄不对。
   *
   * 过滤判据是**键必须是纯数字**（与 games-store 的 gameId 规则一致），
   * 而不是"排除已知的那两个键"——后者在将来再加顶层键时会再踩一次。
   */
  const load = (): GameMetaMap => {
    const raw = readJSON<Record<string, unknown>>(metaFile)
    const out: GameMetaMap = {}
    for (const [gameId, value] of Object.entries(raw)) {
      if (/^\d+$/.test(gameId)) out[gameId] = value as GameMeta
    }
    return out
  }

  /**
   * 保存一条元数据。
   *
   * `editedFields` 的语义（§B.2）：
   * - 传非空数组 → 与磁盘已有标记**取并集**（用户这次只改社团，之前改的标题标记要留着，
   *   否则下次刷新会把标题冲回 DLsite 值）；
   * - 传 `[]` → 清空所有编辑标记（= §B.2 的「强制覆盖全部」，下次刷新取回全部 DLsite 值）；
   * - **不传**（undefined）→ 沿用磁盘上已有的标记，不因为一次普通保存就抹掉用户的编辑。
   */
  function save(gameId: string, meta: GameMeta, editedFields?: readonly EditableField[]): GameMetaMap {
    const id = requireGameId(gameId)
    // ⚠️ 先挡掉非对象再展开：`{ ...[] }` 会得到 `{}`，把「数组不是合法条目」这个错误
    // 伪装成「缺 rj」，报错信息就指错了方向（单测 `非对象 → error.dlsiteParse` 钉住这条）。
    assertObject(id, meta)
    const all = load()
    const previous = all[id] as (GameMeta & { editedFields?: unknown }) | undefined

    let merged: EditableField[]
    if (editedFields === undefined) {
      merged = normalizeEditedFields(previous?.editedFields)
    } else if (editedFields.length === 0) {
      merged = [] // 显式清空
    } else {
      merged = normalizeEditedFields(editedFields)
      for (const field of normalizeEditedFields(previous?.editedFields)) {
        if (!merged.includes(field)) merged.push(field)
      }
    }

    all[id] = sanitize(id, { ...meta, editedFields: merged })
    writeJSON(metaFile, withTopLevelKeys(all))
    return all
  }

  function remove(gameId: string): GameMetaMap {
    const id = requireGameId(gameId)
    if (!fs.existsSync(metaFile)) return {}
    const all = load()
    // 不存在也算成功：删游戏时顺手清 meta，不该因为「本来就没有」而报错
    if (!Object.hasOwn(all, id)) return all
    delete all[id]
    writeJSON(metaFile, withTopLevelKeys(all))
    return all
  }

  /**
   * ⚠️ M5.0 S7 的关键：把**非游戏顶层键**带回写入内容里。
   *
   * `load()` 已经把它们过滤掉了（那是 `GameMetaMap` 的契约：键全是 gameId）。
   * 如果 `save()` / `remove()` 把 `load()` 的结果直接整体 writeJSON，
   * **用户新建的分类与全部归属会在下一次保存 DLsite 信息时无声消失** ——
   * 这是本文件最危险的一处，而且完全不会报错（写进去的是合法 JSON）。
   *
   * 所以每次写回前都要把原始文件里那些我们不懂的键搬过来。
   * 这里刻意不区分具体键名（除了我们自己的两个），因为**用户的数据不该被我们删**。
   */
  const withTopLevelKeys = (entries: GameMetaMap): Record<string, unknown> => {
    const raw = fs.existsSync(metaFile) ? readJSON<Record<string, unknown>>(metaFile) : {}
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(raw)) {
      // 游戏条目以内存里的为准（可能是刚改过的），其余顶层键原样保留
      if (!/^\d+$/.test(key)) out[key] = value
    }
    return { ...out, ...entries }
  }

  return { metaFile, load, save, remove }
}
