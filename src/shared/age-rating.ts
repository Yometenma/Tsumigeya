// 年龄分级判定（R18 封面打码用）。
//
// 为什么单独放在 shared/：主进程、渲染层、测试都要用同一份判定，
// 而渲染层的 client.ts 会拖进 pinia/window 依赖，测试（node 侧 tsconfig）不该引用它。
// 这里保持「零依赖纯函数」，与 bridge-error.ts 同样的处理方式。
//
// 判定依据是 DLsite 的 section（category）：
//   实测同一 R18 作品在 homepro（全年龄站）返回 404、在 maniax 返回 200，
//   说明 R18 与全年龄是**不同站点**，category 是可靠判据。
//
// | category | 性质 |
// |---|---|
// | maniax | 同人（R18） |
// | books  | 成漫（R18） |
// | homepro / soft / pro / appx | 全年龄 |
//
// 注意：这是**界面层面的温和保护**，不是内容过滤。
// 它只能避免封面墙直接铺出成人向封面，挡不住用户自己去 DLsite 查看，
// 也挡不住本地游戏本身。目标用户的游戏大多来自 DLsite 同人区，
// 这一点无法靠一个开关改变，所以不做过度承诺。

const ADULT_CATEGORIES = new Set(['maniax', 'books'])

/** 该作品是否属于 R18 section。缺少 category 时**保守判定为否**（避免误伤全年龄作品）。 */
export function isAdultWork(work: { category?: string } | null | undefined): boolean {
  const category = work?.category?.trim().toLowerCase()
  return !!category && ADULT_CATEGORIES.has(category)
}
