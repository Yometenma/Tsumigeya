// M5.0 S2（U3 + U4）：库页筛选 -- 纯函数，零依赖。
//
// ===== 为什么抽成纯文件 =====
//
// 这一轮改的是**语义**，不是外观：`onlyWithMeta`（只看有封面）→ `onlyUnbound`（只看未绑定）。
// 名字相近、判据却相反（一个要「有 meta」，一个要「没 meta」），是最容易悄悄改反的那类逻辑：
// 改反了不但不报错，界面还会安静地筛出**正好相反的一批游戏**，用户只会觉得"筛选坏了"。
//
// 而 store 里的 `filtered` 是 computed，纯 Node 的 vitest 跑不了（要 pinia + vue）；
// 所以把判据搬到 shared 里，store 只是把它套进 computed。这与 shared/launch-language.ts
// 和 shared/gamecard-info.ts 是同一取向：「画错不报错」的逻辑必须有单测钉。
//
// ⚠️ 零依赖：不 import vue / pinia / element-plus / api-client。
// 需要的字段在这里就地声明（与 GameRecord / GameMeta 同构的子集），
// 这样纯 Node 的 vitest 能直接跑，不必跨 tsconfig 工程引用渲染层代码。

/** 筛选需要的游戏字段子集（GameRecord 的子集）。 */
export interface FilterableGame {
  /** 用来在 meta 索引里查条目。 */
  id: string
  gameTitle: string
  tags?: readonly string[]
}

/**
 * 筛选需要的元数据字段子集（GameMeta 的子集）。
 *
 * 只声明 `rj` 是因为**它就是"已绑定"的判据**：`library-meta.ts` 的 `sanitize()` 要求
 * rj 非空才能落盘，所以「有条目」等价于「有 RJ」。
 * 但从磁盘 `load()` 回来的数据**不过 sanitize**（readJSON 原样返回），
 * 手工改过的文件里可能出现 `{"1": {}}` 这种空条目 —— 所以判据不能只看"有没有这个键"。
 */
export interface FilterableMeta {
  title?: string
  circle?: string
  rj?: string
}

/** 一条元数据是否算「已绑定 DLsite 作品」。 */
export function isBoundMeta(meta: FilterableMeta | undefined | null): boolean {
  if (!meta || typeof meta !== 'object') return false
  const rj = typeof meta.rj === 'string' ? meta.rj.trim() : ''
  return rj.length > 0
}

/** 库页的筛选条件（全部是"用户当前勾了什么"）。 */
export interface LibraryFilter {
  /** 搜索关键词（空 = 不筛）。 */
  keyword: string
  /**
   * 只看未绑定（U4）。
   *
   * 语义是**待办清单**，不是装饰筛选：用户想知道"哪些还没去绑 DLsite 商品"。
   * 原来这里是 `onlyWithMeta`（只看有封面的），判据正好相反。
   */
  onlyUnbound: boolean
}

/**
 * 单条游戏是否通过筛选。
 *
 * 三个条件都是「不满足就 false」，顺序无所谓；写成显式 early-return 比一个大布尔表达式好读，
 * 也方便单测逐条定位是哪个条件把它筛掉的。
 *
 * 关键词匹配范围（与 M2/M2.5 落地时一致，别缩减）：
 * 本地标题、本地标签、DLsite 标题（日文原名）、社团名、RJ 号。
 * 用户库里存的常是中文译名，想搜原名/社团/RJ 就靠后三条。
 */
export function matchGame(game: FilterableGame, meta: FilterableMeta | undefined, filter: LibraryFilter): boolean {
  if (filter.onlyUnbound && isBoundMeta(meta)) return false

  const keyword = filter.keyword.trim().toLowerCase()
  if (!keyword) return true

  if (game.gameTitle.toLowerCase().includes(keyword)) return true
  if ((game.tags ?? []).some((tag) => tag.toLowerCase().includes(keyword))) return true
  if (meta?.title?.toLowerCase().includes(keyword)) return true
  if (meta?.circle?.toLowerCase().includes(keyword)) return true
  if (meta?.rj?.toLowerCase().includes(keyword)) return true
  return false
}

/** 整体筛选（保序，不排序：排序是别的模块的事）。 */
export function filterGames<T extends FilterableGame>(
  games: readonly T[],
  metaIndex: Readonly<Record<string, FilterableMeta | undefined>>,
  filter: LibraryFilter
): T[] {
  return games.filter((game) => matchGame(game, metaIndex[game.id], filter))
}

/** 「未绑定」数量 —— 给工具栏显示待办规模用（不必为此再算一遍 filtered）。 */
export function unboundCount(
  games: readonly FilterableGame[],
  metaIndex: Readonly<Record<string, FilterableMeta | undefined>>
): number {
  let count = 0
  for (const game of games) if (!isBoundMeta(metaIndex[game.id])) count += 1
  return count
}
