// M2.6：卡片 / 详情页的**信息降级**（docs/M2.6-实施方案.md §5.1 / §5.2）。
//
// 为什么抽成纯函数：
// ① 这段逻辑全是「有就显示、没有就不能留空白」的降级判断，正是最容易悄悄画错的
//    那种 UI 逻辑（空简介留两行空白、没社团显示 undefined）；
// ② 抽出来就能用单测钉死（不必靠端到端探针碰运气），与 shared/launch-language.ts 同一取向；
// ③ 渲染层只负责把这些值贴上 i18n 标签，不在这里拼文案（规矩：文案一律进 locales）。
//
// ⚠️ 零依赖：不 import vue / pinia / element-ui / api-client。
// 与 api/client.ts 的 GameMeta 同构，但这里只声明自己需要的那几个字段，
// 这样纯 Node 的 vitest 工程能直接跑它，不必跨 tsconfig 工程引用渲染层代码。

/** 卡片需要的那部分元数据（GameMeta 的子集）。 */
export interface CardMetaView {
  circle?: string
  seriesName?: string
  /** 作品类型代码（`SOU` / `MNG` / `RPG` …），见 work-type.ts。 */
  workType?: string
  registDate?: string
  price?: number
  priceWithTax?: number
  /** M2.6 §3.3：**清洗过**的简介。拿不到就是 undefined（UI 明说「暂无」）。 */
  summary?: string
  /** M2.6 §3.1：作者（只在搜索结果页有）。 */
  author?: string
  /** M2.6 §3.1：销量。 */
  salesCount?: number
  /** M2.6 §3.1：评分 0–5。缺省 = 无评分，**不是 0 分**。 */
  rating?: number
  rj?: string
  category?: string
}

/** 卡片 / 详情页取值的输入。`meta` 为 undefined 表示这条游戏**还没抓过 DLsite 信息**。 */
export interface CardInfoInput {
  gameTitle: string
  gameEngine: string
  meta?: CardMetaView | null
  /** M2.5-C：该条目识别出的语言展示名（如「中文」）。没有就不标。 */
  languageLabel?: string
  /** M2.5-C：「也有 xx 版」的展示串（如「日文」）。空串/undefined 不显示。 */
  alternateLabel?: string
}

/** 卡片要渲染的那几项。**值为 undefined 的一律不渲染**，绝不填空串冒充有内容。 */
export interface CardInfo {
  title: string
  /**
   * 副标题：有社团就社团名，否则退回引擎名（沿用 M2 行为）。
   * 两者都没有时是空串——UI 仍可不渲染。
   */
  subtitle: string
  /** 副标题是不是社团名（false = 退化的引擎名，UI 可以调暗显示）。 */
  hasCircle: boolean
  /** 发售日（没有就是 undefined）。 */
  releasedAt?: string
  /** 简介（没有就是 undefined，卡片**不留空行**）。 */
  summary?: string
  /** 作品类型代码（没有就是 undefined）。 */
  workType?: string
  /** 语言标记（没有就不标，绝不瞎猜）。 */
  languageLabel?: string
  /** 「也有 xx 版」。 */
  alternateLabel?: string
}

/** 去掉多余空白；空串一律归 undefined（避免 `'  '` 被当成「有内容」）。 */
function meaningful(value: string | undefined | null): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

/**
 * 卡片信息降级（§5.1）。
 *
 * 规则（每条都有对应单测）：
 * - 副标题：社团 → 引擎名 → 空串；
 * - 简介：只认清洗过的 `summary`，`description`（带站点广告尾巴）**绝不拿来渲染**；
 * - 作品类型 / 语言 / 发售日：没有就 undefined，UI 不画那一行。
 */
export function buildCardInfo(input: CardInfoInput): CardInfo {
  const meta = input.meta ?? undefined
  const circle = meaningful(meta?.circle)

  return {
    title: meaningful(input.gameTitle) ?? '',
    subtitle: circle ?? meaningful(input.gameEngine) ?? '',
    hasCircle: !!circle,
    releasedAt: meaningful(meta?.registDate),
    summary: meaningful(meta?.summary),
    workType: meaningful(meta?.workType)?.toUpperCase(),
    languageLabel: meaningful(input.languageLabel),
    alternateLabel: meaningful(input.alternateLabel)
  }
}

/**
 * DLsite 的「作品形式」代码 → i18n 键后缀。
 *
 * 代码表来源：DLsite 页面自身（fixture 里能看到 `work_type/MNG">マンガ`、
 * `work_type/RPG">ロールプレイング`、`work_type/SLN">シミュレーション`），
 * 完整枚举与 [dlsite-rs 的 WorkType](https://docs.rs/dlsite/latest/dlsite/interface/enum.WorkType.html) 一致。
 *
 * **不在这里硬编码中文**（规矩：文案一律进 locales/zh-CN.json）。
 * 认不出的代码就返回 `undefined`，UI 退回原样显示代码本身（不假装翻译过）。
 */
const KNOWN_WORK_TYPES = new Set([
  'ACN', // アクション
  'QIZ', // クイズ
  'ADV', // アドベンチャー
  'RPG', // ロールプレイング
  'TBL', // テーブル
  'DNV', // デジタルノベル
  'SLN', // シミュレーション
  'TYP', // タイピング
  'STG', // シューティング
  'PZL', // パズル
  'ETC', // その他ゲーム
  'MNG', // マンガ
  'SCM', // 劇画
  'WBT', // webtoon
  'ICG', // CG・イラスト
  'NRE', // ノベル
  'KSV', // 官能小説
  'MOV', // 動画
  'SOU', // ボイス・ASMR
  'MUS', // 音楽
  'TOL', // ツール
  'IMT', // 画像素材
  'AMT', // 音素材
  'ET3', // その他
  'VCM' // ボイスコミック
])

/**
 * 把作品类型代码转成 i18n 的**后缀**（`SOU` → `SOU`），UI 拼成 `detail.workType.SOU` 查文案。
 *
 * 返回 undefined 表示「这个代码不认识」（新品类 / 页面结构变了）——
 * UI 应退回显示原代码，而不是显示一个错的中文名。
 */
export function workTypeI18nSuffix(code: string | undefined | null): string | undefined {
  const normalized = meaningful(code)?.toUpperCase()
  if (!normalized) return undefined
  return KNOWN_WORK_TYPES.has(normalized) ? normalized : undefined
}

/** 详情页「作品信息」表的一行。`value` 为 undefined 表示该字段拿不到。 */
export interface DetailField {
  /** 稳定的字段名（`rj` / `circle` / …），UI 用它查 i18n 标签。 */
  key: DetailKey
  /** 已格式化的值；undefined = 拿不到。 */
  value?: string
}

/** 详情页要展示的字段键（与 §7 的 i18n 键表一一对应）。 */
export type DetailKey =
  | 'rj'
  | 'circle'
  | 'series'
  | 'released'
  | 'type'
  | 'price'
  | 'sales'
  | 'rating'
  | 'author'

/**
 * 详情页「作品信息」表（§5.2）。
 *
 * 顺序固定（RJ → 社团 → 系列 → 发售日 → 类型 → 价格 → 销量 → 评分 → 作者），
 * 不随数据有没有而跳动——否则用户每次刷新看到的字段顺序都不一样。
 *
 * **拿不到的字段照样返回这一行**（`value: undefined`），让 UI 明说「暂无」。
 * 这是与卡片**故意不同**的取向：卡片空间有限就不画，详情页是信息页必须交代清楚（D37）。
 */
export function buildDetailFields(meta?: CardMetaView | null): DetailField[] {
  const view = meta ?? undefined
  return [
    { key: 'rj', value: meaningful(view?.rj) },
    { key: 'circle', value: meaningful(view?.circle) },
    { key: 'series', value: meaningful(view?.seriesName) },
    { key: 'released', value: meaningful(view?.registDate) },
    { key: 'type', value: meaningful(view?.workType)?.toUpperCase() },
    { key: 'price', value: formatPrice(view) },
    { key: 'sales', value: formatSales(view?.salesCount) },
    { key: 'rating', value: formatRating(view?.rating) },
    { key: 'author', value: meaningful(view?.author) }
  ]
}

/**
 * 价格展示：优先含税价（用户实际要付的钱），没有含税价再退不含税价。
 * 两个都没有 → undefined（不是 `0 日元`——0 元是「免费作品」，语义完全不同）。
 */
export function formatPrice(meta?: CardMetaView | null): string | undefined {
  const withTax = meta?.priceWithTax
  const base = meta?.price
  const value = typeof withTax === 'number' && withTax > 0 ? withTax : base
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return String(value)
}

/** 销量：0 是**合法值**（真的一条没卖出去），所以只在缺失时返回 undefined。 */
export function formatSales(count?: number): string | undefined {
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return undefined
  return String(Math.floor(count))
}

/**
 * 评分：`4.5` → `4.5`。
 *
 * ⚠️ 缺失**不是** 0 分（D37 的同一条精神：不假装）。0 分在 DLsite 是不存在的状态，
 * 拿不到就是拿不到，UI 显示「暂无」。
 */
export function formatRating(rating?: number): string | undefined {
  if (typeof rating !== 'number' || !Number.isFinite(rating)) return undefined
  if (rating <= 0 || rating > 5) return undefined
  return rating.toFixed(1)
}

/**
 * 详情页的简介要不要折叠（§11 待确认项 2：默认折 6 行，可展开）。
 *
 * 判据用**字符数**而不是行数——行数取决于窗口宽度，不同屏幕下判断不一致。
 * 48 字 × 6 行是个保守估计（卡片 2 行约 16 字/行，详情栏更宽，取 48 更宽松）。
 */
export function summaryNeedsCollapse(
  summary: string | undefined,
  visibleLines = 6,
  charsPerLine = 48
): boolean {
  const text = meaningful(summary)
  if (!text) return false
  return text.length > visibleLines * charsPerLine
}

/**
 * 「重新获取元数据」能不能点（三点菜单 / 详情页）。
 *
 * 判据是**有没有存过 RJ**：`refreshGameMeta` 是按已存的 RJ 重新拉取，
 * 没有 RJ 就无从拉取（会对主进程发一个必然失败的请求）。
 * 要凭空获取请走编辑页的「填 RJ / 按名字搜索」流程。
 */
export function canRefreshMeta(meta?: CardMetaView | null): boolean {
  return !!meaningful(meta?.rj)
}

