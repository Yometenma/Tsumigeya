/*
 * M5.0 S7（U2）：自定义分类的纯逻辑 -- 零依赖。
 *
 * ===== 用户拍板的两条语义 =====
 *
 * **多归属**（一个游戏可同时属于多个分类，像标签）+ **扁平**（不做父子层级）。
 *
 * ===== 为什么抽成纯函数 =====
 *
 * 分类是「用户自己建的一层组织体系」，它对数据做的事全都是**批量改写**：
 *   · 删一个分类 → 要从**所有**游戏上摘掉那个 id（写错一个就留下悬空引用）
 *   · 重命名 → **只改 name、id 不动**（改动了 id 就等于把全库的归属全丢了）
 *   · 新建 → 名字查重 + 生成唯一 id（撞了 id 会把两个分类合并成一个）
 *
 * 这三件事的共同点是：**错了不报错，只是数据慢慢变脏**。而且分类是用户会长期
 * 累积的东西，脏一次就很难还原。所以判据必须能单测。
 *
 * ⚠️ 零依赖：不 import vue / pinia / fs / electron。
 * 文案不进这里（规矩：文案一律进 locales），这里只返回**结构**。
 */

/** 一条分类定义。 */
export interface CategoryDef {
  /** 显示名（用户建的时候填的）。 */
  name: string
  /**
   * 排序权重（方案 §4.2.1：`order` 用于侧边栏排序，第一版按创建顺序）。
   *
   * 用数字而不是数组下标：数组下标在「删掉中间一个」时会整体前移，
   * 而 order 是稳定值 —— 用户删掉第 2 个分类，第 3 个不会突然变成第 2。
   */
  order: number
}

/** 定义表：`{ <slug>: CategoryDef }`。 */
export type CategoryDefs = Record<string, CategoryDef>

/** 一个分类名字符数上限（防止用户粘一整段进去把侧边栏撑爆）。 */
export const CATEGORY_NAME_MAX = 24

/** id 长度上限（slug 是给内部用的，不该长得像一句话）。 */
export const CATEGORY_ID_MAX = 32

/**
 * 名字归一化：去首尾空白 + **把连续空白压成一个空格**。
 *
 * 为什么压空白：`"我的 分类"` 与 `"我的   分类"` 在查重时应该算同一个名字，
 * 否则用户复制粘贴带多个空格就建出两个看起来一样的分类。
 *
 * ⚠️ **不改大小写**：中文没有大小写，而英文名（"RPG"）用户可能刻意要保留大写。
 * 查重时才按小写比较（见 `isDuplicateName`），显示仍用原样。
 */
export function normalizeCategoryName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.trim().replace(/\s+/g, ' ')
}

/** 名字是否合法（非空、不超长）。返回错误码而不是抛，调用方自己决定怎么提示。 */
export type CategoryNameError = 'empty' | 'too-long' | null

export function validateCategoryName(raw: unknown): CategoryNameError {
  const name = normalizeCategoryName(raw)
  if (!name) return 'empty'
  if ([...name].length > CATEGORY_NAME_MAX) return 'too-long'
  return null
}

/**
 * 名字查重（**大小写不敏感**）。
 *
 * `excludeId` 用于「重命名」场景：改自己的名字不该和自己冲突。
 *
 * 为什么要查重：两个同名分类在侧边栏里完全无法区分，用户点哪个都可能是错的。
 * 而且删掉其中一个之后，另一个的归属看起来"凭空少了一半"——这类困惑极难解释。
 */
export function isDuplicateName(defs: CategoryDefs, raw: unknown, excludeId?: string): boolean {
  const name = normalizeCategoryName(raw).toLowerCase()
  if (!name) return false
  for (const [id, def] of Object.entries(defs)) {
    if (excludeId && id === excludeId) continue
    if (normalizeCategoryName(def.name).toLowerCase() === name) return true
  }
  return false
}

/**
 * 从名字生成 slug（内部 id）。
 *
 * 规则：**只取 ASCII 字母数字**，其余（含中文、标点、emoji）当分隔符。
 *   · `"动作类"` → 全是中文 → 无可用字符 → 走兜底 `cat`
 *   · `"RPG Maker"` → `rpg-maker`
 *   · `"我的 RPG"` → `rpg`（前缀中文被剥掉，没丢信息因为显示名还在 def.name 里）
 *
 * 为什么不做拼音转写：那要引入一张表（几百 KB）或一个库，而 id 是**内部标识**，
 * 用户永远看不到它。可读性收益为零，成本不小。
 *
 * ⚠️ 兜底名是 `cat` 而不是空串：空 id 会被当成「未分类」的判据误伤
 * （`categories` 数组里有个空串，筛选时看着像"属于某个分类"但点进去什么都没有）。
 */
export function slugifyCategoryName(raw: unknown): string {
  const name = normalizeCategoryName(raw)
  const ascii = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  const base = ascii || 'cat'
  return base.slice(0, CATEGORY_ID_MAX).replace(/-+$/g, '') || 'cat'
}

/**
 * 生成一个**在现有定义表里唯一**的 id。
 *
 * 撞了就追加 `-2` / `-3` / …（而不是随机串）：随机串在导出的 JSON 里没法看懂，
 * 而 `cat-2` 一眼能猜到是"第二个没名字的分类"。
 *
 * 上限 1000 次后回落时间戳：正常用量绝不会走到，但**绝不能返回一个已存在的 id**
 * （那会把两个分类静默合并成一个，用户的归属数据当场错乱）。
 */
export function uniqueCategoryId(defs: CategoryDefs, raw: unknown): string {
  const base = slugifyCategoryName(raw)
  if (!Object.hasOwn(defs, base)) return base
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`
    if (!Object.hasOwn(defs, candidate)) return candidate
  }
  return `${base}-${Date.now().toString(36)}`
}

/**
 * 下一个 order 值（现有最大值 + 1）。
 *
 * 空表 → 1（不是 0，让"第一个分类"的 order 读起来像人话）。
 */
export function nextCategoryOrder(defs: CategoryDefs): number {
  let max = 0
  for (const def of Object.values(defs)) {
    if (Number.isFinite(def.order) && def.order > max) max = def.order
  }
  return max + 1
}

/** 侧边栏排序：order 升序，同 order 按 name（保证顺序稳定，不受对象键顺序影响）。 */
export function sortedCategories(defs: CategoryDefs): Array<{ id: string } & CategoryDef> {
  return Object.entries(defs)
    .map(([id, def]) => ({ id, ...def }))
    .sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order
      return a.name.localeCompare(b.name)
    })
}

/**
 * 从一条归属数组里摘掉某个分类 id。
 *
 * 纯函数（不就地改）：调用方要拿它做「全库批量摘除」，
 * 就地改会让"改到一半失败"留下半套数据。
 */
export function withoutCategory(ids: readonly string[] | undefined, removeId: string): string[] {
  if (!ids || ids.length === 0) return []
  return ids.filter((id) => id !== removeId)
}

/**
 * 给归属数组加上一个分类 id（已在其中则不变，**且保持原顺序**）。
 *
 * 保持原顺序很重要：`["a","b"]` 加 `c` 得 `["a","b","c"]`；
 * 若用 Set 之后随意 toArray，顺序会随插入历史漂移 → 每次保存的 diff 都不一样。
 */
export function withCategory(ids: readonly string[] | undefined, addId: string): string[] {
  const current = ids ?? []
  if (current.includes(addId)) return [...current]
  return [...current, addId]
}

/**
 * 归一化一条归属数组：去掉空串、去重（**保留首次出现的顺序**）、丢未知 id。
 *
 * 为什么丢未知 id：分类被删掉时我们**会**从所有游戏上摘除它（见 deleteCategory），
 * 但磁盘是用户可手改的、也可能有历史遗留。筛出未知 id 让侧边栏不出现
 * 「点进去什么都没有」的幽灵分类 —— 这类幽灵比"少一个分类"更让人困惑。
 */
export function normalizeAssignments(ids: unknown, known: ReadonlySet<string>): string[] {
  if (!Array.isArray(ids)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of ids) {
    if (typeof raw !== 'string') continue
    const id = raw.trim()
    if (!id || seen.has(id) || !known.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/** 「未分类」的判据：归属数组为空。它是**虚拟分类**，不进定义表（方案 §4.2.2）。 */
export const UNCATEGORIZED_ID = '__uncategorized__'

/** 一个游戏的归属展示：命中哪些分类 id。 */
export function matchesCategory(ids: readonly string[] | undefined, filterId: string | null): boolean {
  if (!filterId) return true
  const current = ids ?? []
  // 「未分类」是虚拟的：判据是「一个归属都没有」，不是「有一个叫 __uncategorized__ 的 id」
  if (filterId === UNCATEGORIZED_ID) return current.length === 0
  return current.includes(filterId)
}
