/*
 * M5.0 S7（U2）：分类在主进程侧的存储（library-meta.json 的两个新增顶层键）。
 *
 * ===== ⚠️ 这个文件存在的唯一理由：落盘白名单陷阱 =====
 *
 * `library-meta.ts` 的 `sanitize()` 是**字段白名单** —— 新加的字段不写进去会被
 * **静默丢弃**（M2.6 已实测踩过：saveGameMeta 回执里缺 summary/author/...）。
 * 分类涉及**两个**顶层键与**一条**条目内字段，任何一处漏写都是"用户建了分类、
 * 重启后没了"，而且不报错。
 *
 * ===== 为什么是"分离式"而不是方案示意的"塞进条目" =====
 *
 * 方案 §4.2.1 的示意写成：
 *
 *     "1": { "work": {...}, "categories": ["action"] }
 *
 * 本鱼实施时发现这条路有两个硬问题，所以改成**分离式**（顶层多一个 assignments 表）：
 *
 * ① **`work` 包一层会打断所有既有读取**。现状是**平铺**的：
 *    `"1": { "rj": "RJ…", "title": "…", "editedFields": [...] }`。
 *    改成嵌套后，渲染层 `library.meta[id].title` / `.rj` / `.coverUrl` 全部要改，
 *    `GameMeta = DlsiteWork` 这个跨边界契约也要动 —— 影响面远超这一项该有的范围。
 *
 * ② **"未绑定的游戏分不了类"**。`sanitize()` 要求 `rj` 非空才能落盘（那是 DLsite
 *    条目的最低要求）。但用户要分类的恰恰可能是**还没绑 DLsite 的游戏**（U4 的
 *    「只看未绑定」就是为这批游戏做的待办清单）。塞进条目里就意味着必须先绑 RJ。
 *
 * 所以：**配置与归属都放到与 meta 条目平级的顶层键**，不动任何既有条目形状。
 *
 *     {
 *       "1": { ...原来的 DlsiteWork，一字不动... },
 *       "categories":  { "action": { "name": "动作类", "order": 1 } },
 *       "assignments": { "1": ["action"], "2": [] }
 *     }
 *
 * 好处：
 *   · 已存数据**零迁移**（老文件读进来照常工作）
 *   · 渲染层 `library.meta[id]` 的读取路径一个都不用改
 *   · 没绑 DLsite 的游戏照样能归入分类
 *   · 删分类只改 `assignments`，不碰 meta 条目（不会误伤封面/标题等）
 *
 * 代价（如实记录）：与方案 §4.2.1 的字面结构不同。核心设计（多归属、扁平、
 * slug id、删除只删定义、未分类是虚拟分类）**全部保留**。
 */
import fs from 'node:fs'
import path from 'node:path'
import { component, readJSON, writeJSON } from './games-store'
import { normalizeAssignments, type CategoryDef, type CategoryDefs } from '../shared/categories'

/** 定义表的顶层键（不是 gameId —— gameId 必须是纯数字，见 games-store 的校验）。 */
export const CATEGORY_DEFS_KEY = 'categories'
/** 归属表的顶层键。 */
export const ASSIGNMENTS_KEY = 'assignments'

/** `{ <gameId>: [categoryId, ...] }`。 */
export type CategoryAssignments = Record<string, string[]>

/**
 * 从 `library-meta.json` 的原始内容里剥出三类数据。
 *
 * ⚠️ 这是本文件最重要的一个函数：`load()` 如果不过滤顶层键，
 * `categories` / `assignments` 会被当成**游戏 id** 混进 `meta` 里 ——
 * 渲染层 `library.meta['categories']` 会拿到一个定义表，而任何"遍历 meta"的逻辑
 * （比如 unboundCount）都会把它算成一个未绑定的游戏。不报错，只是数字不对。
 *
 * 所以过滤判据是**「键必须是纯数字」**，与 games-store 的 gameId 规则一致，
 * 而不是"排除已知的两个键"——后者在将来再加顶层键时会再次踩坑。
 */
export interface SplitMetaFile {
  /** 游戏条目（键全部是数字）。 */
  entries: Record<string, Record<string, unknown>>
  defs: CategoryDefs
  assignments: CategoryAssignments
}

export function splitMetaFile(raw: unknown): SplitMetaFile {
  const entries: Record<string, Record<string, unknown>> = {}
  let defs: CategoryDefs = {}
  let assignments: CategoryAssignments = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { entries, defs, assignments }
  }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d+$/.test(key)) {
      // 顶层非数字键：
      //   · categories  → 定义表（逐条校验，坏条目丢弃而不是整体报废）
      //   · assignments → 归属表（值必须是非字符串数组，否则忽略）
      //   · 其它未知顶层键 → **忽略但保留在文件里**（我们不认识它，不代表用户的数据可以删）
      if (key === CATEGORY_DEFS_KEY) defs = normalizeDefs(value)
      else if (key === ASSIGNMENTS_KEY) assignments = normalizeAssignmentsMap(value)
      continue
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      entries[key] = value as Record<string, unknown>
    }
  }
  return { entries, defs, assignments }
}

/** 定义表归一：只收 `{ name: string, order?: number }`，坏条目丢弃。 */
function normalizeDefs(value: unknown): CategoryDefs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: CategoryDefs = {}
  for (const [id, rawDef] of Object.entries(value as Record<string, unknown>)) {
    const trimmedId = id.trim()
    if (!trimmedId) continue
    if (!rawDef || typeof rawDef !== 'object' || Array.isArray(rawDef)) continue
    const source = rawDef as Record<string, unknown>
    const name = typeof source.name === 'string' ? source.name.trim() : ''
    if (!name) continue
    const order = typeof source.order === 'number' && Number.isFinite(source.order) ? source.order : 0
    out[trimmedId] = { name, order }
  }
  return out
}

/** 归属表归一：值是字符串数组才收（否则整条忽略，不制造半个归属）。 */
function normalizeAssignmentsMap(value: unknown): CategoryAssignments {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: CategoryAssignments = {}
  for (const [gameId, rawIds] of Object.entries(value as Record<string, unknown>)) {
    const id = gameId.trim()
    if (!id) continue
    if (!Array.isArray(rawIds)) continue
    const ids = rawIds.filter((item): item is string => typeof item === 'string')
    if (ids.length === 0) continue
    out[id] = ids
  }
  return out
}

/**
 * 分类数据的读写句柄。
 *
 * 与 `LibraryMetaStore` 共用**同一个文件**：分类和 DLsite 元数据都是"旁挂"，
 * 放一个文件里能保证读改写是**一次原子写**（拆两个文件会出现
 * 「meta 写成功、assignments 写失败」这种半套状态，而删分类要同时动两处）。
 */
export interface CategoryStore {
  readonly file: string
  loadDefs(): CategoryDefs
  loadAssignments(): CategoryAssignments
  loadAll(): { defs: CategoryDefs; assignments: CategoryAssignments }
  /** 整体写回定义表 + 归属表（其余顶层键与游戏条目原样保留）。 */
  save(defs: CategoryDefs, assignments: CategoryAssignments): void
  /** 删分类：**只删定义 + 从所有游戏上摘掉该 id**，绝不删游戏（方案 §4.2.2）。 */
  removeCategory(id: string): { defs: CategoryDefs; assignments: CategoryAssignments }
  /** 给若干游戏追加归属（批量归入，复用 U1 的多选）。 */
  assignGames(gameIds: readonly string[], categoryId: string): { defs: CategoryDefs; assignments: CategoryAssignments }
  /** 从归属表里彻底清掉某个游戏（删游戏时调用，避免孤儿键）。 */
  removeGame(gameId: string): void
}

export function createCategoryStore(dataDir: string): CategoryStore {
  const file = path.join(dataDir, 'library-meta.json')

  /**
   * 读整个文件（含我们不认识的顶层键）。
   *
   * ⚠️ 不直接复用 `readJSON` 的返回就写回：`save()` 需要**保留**那些我们不懂的键
   * （用户手改的、或将来别的模块加的）。丢掉它们等于静默删用户数据。
   */
  const loadRaw = (): Record<string, unknown> => {
    if (!fs.existsSync(file)) return {}
    return readJSON<Record<string, unknown>>(file)
  }

  const loadAll = (): { defs: CategoryDefs; assignments: CategoryAssignments } => {
    const split = splitMetaFile(loadRaw())
    return { defs: split.defs, assignments: split.assignments }
  }

  /**
   * 写回。
   *
   * 顺序上是「读整个文件 → 只替换 categories / assignments 两个键 → 原子写」。
   * 游戏条目与未知顶层键原样带过去 —— 这个文件是**用户数据**，
   * 我们只该动自己那两个键。
   */
  function save(defs: CategoryDefs, assignments: CategoryAssignments): void {
    const raw = loadRaw()
    // 空表就写空对象而不是删键：保持文件形状稳定，diff 更干净
    raw[CATEGORY_DEFS_KEY] = defs
    raw[ASSIGNMENTS_KEY] = Object.keys(assignments).length ? assignments : {}
    writeJSON(file, raw)
  }

  function loadDefs(): CategoryDefs {
    return loadAll().defs
  }

  function loadAssignments(): CategoryAssignments {
    return loadAll().assignments
  }

  function removeCategory(id: string): { defs: CategoryDefs; assignments: CategoryAssignments } {
    const { defs, assignments } = loadAll()
    if (!Object.hasOwn(defs, id)) return { defs, assignments }
    const nextDefs: CategoryDefs = { ...defs }
    delete nextDefs[id]
    // ⚠️ 从**所有**游戏上摘掉 —— 漏一个就留下悬空引用
    const nextAssignments: CategoryAssignments = {}
    for (const [gameId, ids] of Object.entries(assignments)) {
      if (!ids.includes(id)) {
        nextAssignments[gameId] = ids
        continue
      }
      const remaining = ids.filter((item) => item !== id)
      // 摘成空就**删键**（否则 assignments 会被一堆空数组塞满，文件越滚越大）
      if (remaining.length > 0) nextAssignments[gameId] = remaining
    }
    save(nextDefs, nextAssignments)
    return { defs: nextDefs, assignments: nextAssignments }
  }

  function assignGames(
    gameIds: readonly string[],
    categoryId: string
  ): { defs: CategoryDefs; assignments: CategoryAssignments } {
    const { defs, assignments } = loadAll()
    // 定义表里没有这个分类就不动（否则会造出"指向不存在分类"的归属）
    if (!Object.hasOwn(defs, categoryId)) return { defs, assignments }
    const known = new Set(Object.keys(defs))
    const next: CategoryAssignments = { ...assignments }
    for (const gameId of gameIds) {
      const id = component(gameId, 'game id')
      const current = normalizeAssignments(next[id], known)
      // 已在其中 → 原样（保持顺序，不做无意义的写）
      next[id] = current.includes(categoryId) ? current : [...current, categoryId]
    }
    save(defs, next)
    return { defs, assignments: next }
  }

  function removeGame(gameId: string): void {
    const { defs, assignments } = loadAll()
    const id = component(gameId, 'game id')
    if (!Object.hasOwn(assignments, id)) return
    const next: CategoryAssignments = { ...assignments }
    delete next[id]
    save(defs, next)
  }

  return { file, loadDefs, loadAssignments, loadAll, save, removeCategory, assignGames, removeGame }
}

/** 定义表的一条（导出给测试与类型用）。 */
export type { CategoryDef }
