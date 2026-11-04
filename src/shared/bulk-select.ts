// M5.0 S6（U1）：库页批量模式的选择集与二次确认文案 -- 纯函数，零依赖。
//
// ===== 为什么这两块必须抽出来测 =====
//
// 方案 §4.1 把批量管理的关键约束写得很具体：
//   「批量删除**必须二次确认**，且弹窗里要列出被删的标题（≥3 个时只列前 3 + 「等 N 个」）」
//
// 这类「列几条 + 等几个」的文案最容易**差一位**，而且差一位当场看不出来：
//   · 删 3 个，列 3 个也写「等 0 个」 → 用户看到一个没意义的后缀
//   · 删 4 个，只列 3 个却写「等 1 个」→ 数字对但读起来像还有 1 个"别的"
//
// 更要紧的是**选中集合与筛选的关系**：批量模式开着的时候用户改了筛选条件，
// 那些被筛走的游戏还在不在选中集里？两种做法都"能用"，但会让用户误删：
// 他看不到某张卡片了、以为没选它，删除时却把它一起删了。
// 所以「选择集只增不减，但删除前必须按**当前可见**的集合再算一次」这个规则要钉住。
//
// ⚠️ 零依赖：不 import vue / pinia / i18n / api-client。
// 文案不在这个文件里拼（规矩：文案一律进 locales），这里只输出结构。

/** 二次确认弹窗里「要列出哪些标题」。 */
export interface DeleteConfirmPlan {
  /** 列出来的标题（最多 3 个）。 */
  listed: string[]
  /** 没列出来的个数（0 = 全部列出来了）。 */
  omitted: number
  /**
   * 需要提示「其中 N 个被筛掉了、当前不可见」吗。
   *
   * 为什么单独一项：用户勾选后又改了筛选，被筛走的那几个在界面上看不到。
   * 不提示的话，二次确认里出现的标题会让他困惑（「我什么时候选了这个？」）；
   * 提示了他才有机会取消。
   */
  hiddenCount: number
}

/** 列出多少个标题（方案 §4.1 的数）。 */
export const CONFIRM_LIST_LIMIT = 3

/**
 * 造二次确认的展示计划。
 *
 * @param titles   **按当前可见顺序**排好的、将被删除的标题
 * @param hidden   其中当前被筛掉（不可见）的个数
 *
 * 顺序很重要：先按可见顺序排，再截前 N 个 —— 用户看到的前三个和他屏幕上的一致，
 * 才有「对，就是这几个」的感觉。乱序会让人觉得程序在删别的东西。
 */
export function deleteConfirmPlan(titles: readonly string[], hidden = 0): DeleteConfirmPlan {
  const limit = CONFIRM_LIST_LIMIT
  const listed = titles.slice(0, limit)
  return {
    listed,
    omitted: Math.max(0, titles.length - listed.length),
    hiddenCount: Math.max(0, Math.min(hidden, titles.length))
  }
}

/**
 * 真正会被删的 id 集合：选中集 **∩ 当前可见集**。
 *
 * 为什么取交集而不是直接用选中集：
 *   · 直接用选中集 → 用户在批量模式里改了筛选、卡片看不见了，
 *     但删除时照样删掉它 —— 他以为没选，这是「误删」的直接来源。
 *   · 只用可见集 → 用户切了筛选再切回来，之前的选择丢了，更烦人。
 *
 * 所以：**选择集保留**（切筛选不丢），但**确认与执行都只看当前可见的交集**。
 * 被筛掉的那部分不删，改在确认弹窗里提示「其中 N 个当前不可见，不会被删除」。
 */
export function deletableSelection(selected: ReadonlySet<string>, visible: readonly string[]): string[] {
  return visible.filter((id) => selected.has(id))
}

/**
 * 批量模式的「全选」该怎么变。
 *
 * 三态而不是两态：全选 / 部分选 / 没选。
 * 用户勾了 5 个中的 3 个，全选框不该显示「已勾选」（那会让他以为全选了），
 * 也不该显示「未勾选」（那会让他以为一个都没选）。用 indeterminate。
 */
export type SelectAllState = 'none' | 'partial' | 'all'

export function selectAllState(selected: ReadonlySet<string>, visible: readonly string[]): SelectAllState {
  if (visible.length === 0) return 'none'
  const count = deletableSelection(selected, visible).length
  if (count === 0) return 'none'
  return count === visible.length ? 'all' : 'partial'
}

/**
 * 「已选 N 个」里的那个数字 —— 数的是**当前可见的选中项**。
 *
 * 与 `deletableSelection().length` 一致，两个数不能分叉：
 * 工具栏说「已选 3 个」而删除实际删了 5 个，是最糟的那种不一致。
 */
export function selectedCount(selected: ReadonlySet<string>, visible: readonly string[]): number {
  return deletableSelection(selected, visible).length
}
