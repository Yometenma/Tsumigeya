// DLsite 元数据：RJ 号识别 + 页面解析 + TTL 缓存（M2-A）。
// 契约：docs/M2-实施方案.md §4（网络层）、§3.2/§3.3（存储）。
// 数据源：页面末尾 `var contents = {...}` 的 JSON（调研 §2.2），**不解析 HTML 表格**。
// ⚠️ 本文件不 import electron：解析与缓存逻辑要能在 vitest 里直接跑（fetch / cookie 由外部注入）。
import fs from 'node:fs'
import path from 'node:path'
import { failure, readJSON, writeJSON } from './games-store'

/** 缓存有效期：7 天（§3.3）。 */
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 单次页面请求超时（§4.1）。 */
const DEFAULT_TIMEOUT_MS = 15_000
/** 全局最小请求间隔（§4.1，防未来批量误用打爆 DLsite）。 */
const DEFAULT_MIN_INTERVAL_MS = 800
/** 简介截断长度：避免把 library-meta.json 塞爆。 */
const DESCRIPTION_LIMIT = 400

/**
 * `og:description` 里的**站点自述尾巴**标记（M2.6 §3.3 实测）。
 *
 * DLsite 会在作品简介后面接一段自家广告：
 *   「…おま○こ当番とは、…。**「DLsite 同人 - R18」は同人誌・同人ゲーム・…
 *     国内最大級の二次元総合ダウンロードショップ「DLsite」！**」
 * 实测 RJ294126：原始 260 字 → 清洗后 122 字。
 *
 * 规则：截断在**最靠前**的那个标记之前；清洗后为空则视为无简介。
 */
const SITE_TAIL_MARKERS = ['「DLsite', 'DLsite 同人', '国内最大級の二次元'] as const
/** 自动识别时最多读几个 readme、每个读多少字节。 */
const MAX_README_FILES = 8
const MAX_README_BYTES = 64 * 1024

/**
 * 作品所在 section 的尝试顺序（§4.1）。
 * 同一个作品可能落在 maniax / homepro / books，404 才试下一个；
 * **网络超时 / 连接失败不重试**——那不是分类问题，重试只会让用户多等。
 */
const PAGE_CATEGORIES = ['maniax', 'homepro', 'books'] as const

/** 封面只允许来自这个主机（D22：外部数据不可信，禁止任意远程图进渲染层）。 */
const ALLOWED_COVER_HOSTS = new Set(['img.dlsite.jp'])

/**
 * 搜索结果页里混在标题位置的**按钮文案**（M2.5 §1.2）。
 * 实测同一页每个作品都会带「カートに追加 / お気に入りに追加」，而且它们的 `<a>` 也指向 `product_id/`，
 * 不滤掉就会盖住真标题。
 */
const SEARCH_NOISE_TEXTS = new Set(['カートに追加', 'お気に入りに追加', '詳細'])

/** 搜索结果最多返回条数（M2.5 §7-③ 用户确认 20）。 */
export const SEARCH_RESULT_LIMIT = 20

/** 搜索默认 section（与查询作品页的默认一致）。 */
const DEFAULT_SEARCH_CATEGORY = 'maniax'

export interface DlsiteWork {
  /** 规范化大写，如 RJ294126。 */
  rj: string
  /** contents.detail[0].name；缺省回退 og:title 的名字部分。 */
  title: string
  /** og:title 去掉社团与「 | DLsite」后缀。 */
  titleFull?: string
  /** 社团名：优先 og:title 的 [方括号]，回退面包屑。 */
  circle?: string
  /** contents.detail[0].brand（= RG 号）。 */
  circleId?: string
  seriesName?: string
  category?: string
  /** 作品类型（SOU 等）。只作展示，**不是** genre（N1：标签不做）。 */
  workType?: string
  registDate?: string
  /** discount 后的价格。 */
  price?: number
  priceWithTax?: number
  officialPrice?: number
  discount?: number
  /** 已归一化为 https 绝对地址，且 host 必须 ∈ img.dlsite.jp。 */
  coverUrl?: string
  /** `og:description` 原值（含站点广告尾巴，**不要直接渲染**）。 */
  description?: string
  /**
   * M2.6：**清洗过**的简介（已剥掉「国内最大級の二次元…」那段站点自述，
   * 见 `cleanupDescription`）。UI 展示用这个，不是 `description`。
   */
  summary?: string
  /**
   * M2.6 §3.1：作者。**只有搜索结果页才有**（详情页的 `contents` 不含这个字段），
   * 所以解析走 `parseSearchResults`，再由搜索点选流程带进元数据。
   */
  author?: string
  /** M2.6 §3.1：销量（同样只在搜索结果页有，如「販売数: 739」）。 */
  salesCount?: number
  /** M2.6 §3.1：评分 0–5（来自 `star_rating star_45` 这样的 class）。 */
  rating?: number
  fetchedAt: string
  /**
   * M2.5-B：该条目是否被用户手动编辑过（由 editedFields 派生，不单独写入）。
   * 抓取产生的 work **永远不带**这两个字段，只有 library-meta.json 里的条目才带。
   */
  edited?: boolean
  /** M2.5-B：哪些字段是用户改的（后续刷新不覆盖这些字段，见 §B.2）。 */
  editedFields?: ('title' | 'circle' | 'coverUrl' | 'registDate' | 'price')[]
}

// ===== RJ 号 =====

/**
 * 校验并规范化 RJ 号：接受 `RJ294126` / `rj294126` / `RJ-294126` / `294126`。
 * 非法返回 null（调用方决定抛什么错）。
 */
export function normalizeRj(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const match = /^[Rr]?[Jj]?[\s\-_]*(\d{6,8})$/.exec(value.trim())
  if (!match) return null
  return `RJ${match[1]}`
}

/**
 * 从任意文本里提取 RJ 号候选（按出现顺序去重）。
 * 不加词边界前缀：`RJ294126` 常紧跟中文或下划线，加 \b 反而漏掉；
 * 尾部负向断言 `(?!\d)` 防止把 `RJ29412699` 截成 `RJ2941269`。
 */
export function extractRjCandidates(value: unknown): string[] {
  if (typeof value !== 'string' || !value) return []
  const found: string[] = []
  for (const match of value.matchAll(/[Rr][Jj][\s\-_]*(\d{6,8})(?!\d)/g)) {
    const rj = `RJ${match[1]}`
    if (!found.includes(rj)) found.push(rj)
  }
  return found
}

/** 只读文件头部若干字节（readme 可能很大，别整份读进内存）。 */
function readHead(file: string, limit = MAX_README_BYTES): string {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(limit)
      const read = fs.readSync(fd, buffer, 0, limit, 0)
      return buffer.subarray(0, read).toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return ''
  }
}

function readmeFiles(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^readme/i.test(entry.name))
      .slice(0, MAX_README_FILES)
      .map((entry) => path.join(dir, entry.name))
  } catch {
    return []
  }
}

/**
 * 从游戏路径猜 RJ 号（§4.6 优先级：目录名 → 路径各段 → readme）。
 * 返回**按优先级排序**的候选列表：UI 默认取 `[0]`，多个不同 RJ 时让用户选（不瞎猜）。
 */
export function detectRjFromPath(gamePath: string): string[] {
  if (typeof gamePath !== 'string' || !gamePath.trim()) return []
  const resolved = path.resolve(gamePath)
  let dir = resolved
  try {
    if (!fs.statSync(resolved).isDirectory()) dir = path.dirname(resolved)
  } catch {
    // 路径还不存在：仍按字面路径猜（用户可能先填了未安装的目录）
  }

  const found: string[] = []
  const consider = (text: string): void => {
    for (const rj of extractRjCandidates(text)) if (!found.includes(rj)) found.push(rj)
  }

  // 目录名优先级最高（用户多半把游戏解到 `RJ294126 作品名/`）
  consider(path.basename(dir))
  for (const segment of dir.split(path.sep).reverse()) consider(segment)
  for (const file of readmeFiles(dir)) consider(readHead(file))
  return found
}

// ===== 页面解析 =====

/**
 * 清洗 `og:description`：剥掉 DLsite 的站点自述尾巴（M2.6 §3.3）。
 *
 * 为什么必须清洗：那个字段是「作品简介 + 站点广告」拼接的，直接拿去渲染会把
 * 「国内最大級の二次元総合ダウンロードショップ」贴到每张卡片上，非常难看。
 *
 * 实测（RJ294126）：260 字 → 122 字，正好剥在「「DLsite 同人 - R18」は同人誌…」之前。
 * 清洗后为空 / 全是空白时返回 `undefined`（视为无简介，UI 显示「暂无」）。
 */
export function cleanupDescription(raw: string | undefined | null): string | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  let cut = raw.length
  for (const marker of SITE_TAIL_MARKERS) {
    const index = raw.indexOf(marker)
    if (index >= 0 && index < cut) cut = index
  }
  const cleaned = raw.slice(0, cut).trim()
  return cleaned || undefined
}

/** 极简 HTML 实体解码（og content 里常见 &amp; / &#xXXXX;）。 */
export function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = hex ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole
      return String.fromCodePoint(code)
    }
    return named[body.toLowerCase()] ?? whole
  })
}

/**
 * 从 `start` 处的 `{` 做**字符串感知**的括号配对扫描，返回匹配 `}` 的下标；失败返回 -1。
 *
 * 为什么不用调研里那个 `/var\s+contents\s*=(\{[\s\S]*?\})\;/` 正则：
 * 非贪婪 `*?` 遇到字符串内部出现的 `};` 会**提前截断**，而作品简介里什么字符都可能出现。
 * 本扫描只在字符串之外计数括号，能正确跨过 `"note":"…};…"` 这类内容。
 */
export function scanBalancedObject(text: string, start: number): number {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      continue
    }
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

/**
 * 提取页面末尾 `var contents = {...}` 的 JSON（调研 §2.2）。
 * 取**最后一次**出现的位置——页面别处偶尔也有同名变量，末尾那个才是作品数据。
 */
export function extractContentsJson(html: unknown): unknown | null {
  if (typeof html !== 'string' || !html) return null
  const lower = html.toLowerCase()
  let anchor = -1
  let from = 0
  while (true) {
    const hit = lower.indexOf('var contents', from)
    if (hit === -1) break
    anchor = hit
    from = hit + 1
  }
  if (anchor === -1) return null
  const braceStart = html.indexOf('{', anchor)
  if (braceStart === -1) return null
  const braceEnd = scanBalancedObject(html, braceStart)
  if (braceEnd === -1) return null
  try {
    return JSON.parse(html.slice(braceStart, braceEnd + 1)) as unknown
  } catch {
    return null
  }
}

/** 读 `<meta property="..." content="...">`；两种属性顺序都支持。 */
export function extractMetaContent(html: string, property: string): string | undefined {
  if (typeof html !== 'string' || !html) return undefined
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${escaped}["'][^>]*?content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*?property=["']${escaped}["']`, 'i')
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(html)
    if (match) return decodeHtmlEntities(match[1]).trim() || undefined
  }
  return undefined
}

/**
 * 从 og:title 拆出「名字部分」与「社团名」（§4.4）。
 * 形如：`純愛おま○こ当番【アップデート版】 [青春×フェティシズム] | DLsite`
 *
 * 为什么优先用 og:title 而不是面包屑：面包屑 DOM 结构最易随改版而变，
 * 而 og 标签是给社交平台预览用的，改动频率低得多。
 */
export function extractTitleAndCircle(ogTitle?: string): { titleFull?: string; circle?: string } {
  if (typeof ogTitle !== 'string' || !ogTitle) return {}
  // 去掉尾部「 | DLsite」（含全角变体）
  const base = ogTitle.replace(/\s*[|｜]\s*DLsite\s*$/i, '').trim()
  if (!base) return {}
  // 社团：[社团名] 必须紧贴名字结尾
  const bracket = /\s*\[([^\]]{1,120})\]\s*$/.exec(base)
  if (bracket) {
    const titleFull = base.slice(0, bracket.index).trim()
    return { titleFull: titleFull || undefined, circle: bracket[1].trim() || undefined }
  }
  return { titleFull: base }
}

/** 面包屑里拿社团（§4.4 的回退路径）：`maker_id/(RG\d+)` + 其后第一个 `<span>`。 */
export function extractCircleFromBreadcrumb(html: string): { circle?: string; circleId?: string } {
  if (typeof html !== 'string' || !html) return {}
  const match = /maker_id\/(RG\d+)/.exec(html)
  if (!match) return {}
  const circleId = match[1]
  const chunk = html.slice(match.index, match.index + 800)
  const span = /<span[^>]*>([^<]{1,120})<\/span>/.exec(chunk)
  const circle = span ? decodeHtmlEntities(span[1]).trim() || undefined : undefined
  return { circle, circleId }
}

/**
 * 封面 URL 归一化（§4.5 + D22）：
 * 协议相对 `//img.dlsite.jp/...` → `https:`，并**强制校验 host 白名单**，其余一律丢弃。
 */
export function normalizeCoverUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  let raw = value.trim()
  if (raw.startsWith('//')) raw = `https:${raw}`
  else if (raw.startsWith('http://')) raw = `https:${raw.slice('http://'.length)}`
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:') return undefined
    if (!ALLOWED_COVER_HOSTS.has(url.hostname.toLowerCase())) return undefined
    return url.toString()
  } catch {
    return undefined
  }
}

function asText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed || undefined
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return undefined
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function readDetail(contents: unknown): Record<string, unknown> | null {
  const detail = (contents as { detail?: unknown } | null)?.detail
  if (!Array.isArray(detail) || detail.length === 0) return null
  const first: unknown = detail[0]
  if (!first || typeof first !== 'object' || Array.isArray(first)) return null
  return first as Record<string, unknown>
}

/**
 * 解析一个作品页 → `DlsiteWork`。
 * 拿不到 `detail[0]`（例如抓到年龄确认页、或 DLsite 改版拿掉 var contents）→ `error.dlsiteParse`，
 * **明示原因，不静默兜底**（§11 R5）。
 */
export function parseDlsiteWork(html: string, rj: string, fetchedAt = new Date().toISOString()): DlsiteWork {
  const normalized = normalizeRj(rj)
  if (!normalized) {
    throw failure('error.dlsiteInvalidRj', `Invalid RJ number: ${String(rj)}`, { rj: String(rj) })
  }

  const detail = readDetail(extractContentsJson(html))
  if (!detail) {
    throw failure('error.dlsiteParse', `Cannot parse DLsite page data for ${normalized}`, { rj: normalized })
  }

  const ogTitle = extractMetaContent(html, 'og:title')
  const fromOg = extractTitleAndCircle(ogTitle)
  const fromBreadcrumb = extractCircleFromBreadcrumb(html)

  const title = asText(detail.name) ?? fromOg.titleFull
  if (!title) {
    throw failure('error.dlsiteParse', `DLsite page for ${normalized} has no work name`, { rj: normalized })
  }

  const description = extractMetaContent(html, 'og:description')

  return {
    rj: normalized,
    title,
    titleFull: fromOg.titleFull,
    circle: fromOg.circle ?? fromBreadcrumb.circle,
    circleId: asText(detail.brand) ?? fromBreadcrumb.circleId,
    seriesName: asText(detail.series_name),
    category: asText(detail.category),
    workType: asText(detail.work_type),
    registDate: asText(detail.regist_date),
    price: asNumber(detail.price),
    priceWithTax: asNumber(detail.price_with_tax),
    officialPrice: asNumber(detail.official_price),
    discount: asNumber(detail.discount),
    // 优先用 og:image（绝对地址），回退 contents.image_main（协议相对）
    coverUrl: normalizeCoverUrl(extractMetaContent(html, 'og:image') ?? detail.image_main),
    description: description ? description.slice(0, DESCRIPTION_LIMIT) : undefined,
    // M2.6：清洗版简介（剥掉站点广告尾巴），UI 只用这个
    summary: cleanupDescription(description)?.slice(0, DESCRIPTION_LIMIT),
    fetchedAt
  }
}

// ===== 服务：抓取 + 缓存 =====

export interface DlsiteServiceOptions {
  dataDir: string
  /** 生产是 net.fetch（走系统代理，D9）；测试注入假实现。 */
  fetch: (input: string, init?: unknown) => Promise<Response>
  /** 写 `adultchecked=1` 到 session cookie（§4.2）；纯 Node 下不传。 */
  setAdultCookie?: () => Promise<void>
  /** 时间源（测试可注入）。 */
  now?: () => number
  /** 最小请求间隔，默认 800ms；测试传 0。 */
  minIntervalMs?: number
  /** 单次请求超时，默认 15s。 */
  timeoutMs?: number
}

export interface DlsiteLookupInput {
  rj: string
  /** 强制重新抓取（忽略 TTL）。 */
  refresh?: boolean
  signal?: AbortSignal
}

export interface DlsiteService {
  fetchWork(input: DlsiteLookupInput): Promise<DlsiteWork>
  /** M2.5-A：按名字搜索（§A）。 */
  searchWorks(input: DlsiteSearchInput): Promise<DlsiteSearchResult>
  /** `<dataDir>/dlsite/<RJ>.json`。 */
  cachePath(rj: string): string
}

function pageUrl(category: string, rj: string): string {
  return `https://www.dlsite.com/${category}/work/=/product_id/${rj}.html`
}

// ===== M2.5-A：按名字搜索（§A）=====

/**
 * 构造搜索 URL。**唯一有效的格式**（M2.5 §1.1 实测）：
 * `/{category}/fsr/=/keyword/<编码关键词>`。
 * 其余写法（`/fs?keyword=`、`/fsr/=/keywords/`）要么 404，要么返回「条件搜索页」而非结果页。
 */
export function buildSearchUrl(keyword: string, category: string = DEFAULT_SEARCH_CATEGORY): string {
  const section = category && /^[a-z]+$/.test(category) ? category : DEFAULT_SEARCH_CATEGORY
  return `https://www.dlsite.com/${section}/fsr/=/keyword/${encodeURIComponent(keyword)}`
}

/** 搜索结果页判据：`<title>` 含「検索結果」（§1.1）。含则表示是真结果页。 */
export function isSearchResultPage(html: unknown): boolean {
  if (typeof html !== 'string' || !html) return false
  const title = /<title[^>]*>([\s\S]{0,200}?)<\/title>/i.exec(html)
  return title ? title[1].includes('検索結果') : false
}

/** 一条搜索结果。字段与 M2.5 §A.1 的 `DlsiteSearchHit` 一致。 */
export interface DlsiteSearchHit {
  /** 规范化大写（如 RJ294126）。 */
  rj: string
  /** 已过滤噪音文案的标题。 */
  title: string
  /** 从链接 URL 的 section 段推断：maniax / homepro / pro / books ... */
  category?: string
  /** 缩略图（归一化后必须是 img.dlsite.jp，否则丢弃）。 */
  coverUrl?: string
  /** M2.6 §3.1：作者（`maker_name` 后紧跟的 `<span class="author">`）。 */
  author?: string
  /** M2.6 §3.1：销量（`販売数: <span class="_dl_count_…">739</span>`）。 */
  salesCount?: number
  /** M2.6 §3.1：评分 0–5（`star_rating star_45` → 4.5）。 */
  rating?: number
}

interface RawHit {
  rj: string
  title?: string
  category?: string
  coverUrl?: string
  author?: string
  salesCount?: number
  rating?: number
  /** 页面里的出现顺序，用于稳定排序。 */
  order: number
}

function isNoiseTitle(value: string | undefined): boolean {
  if (!value) return true
  const trimmed = value.trim()
  if (!trimmed) return true
  if (SEARCH_NOISE_TEXTS.has(trimmed)) return true
  // 空占位 / 纯符号也别当标题
  return !/[\p{L}\p{N}]/u.test(trimmed)
}

/**
 * 解析搜索结果页 → 作品列表（按 RJ 去重、保序）。
 *
 * 实现要点（对照 M2.5 §1.2 与真页面结构）：
 * 1. 先找**结构化锚点** `data-list_item_product_id="RJ…"`——实测真实结果页每个作品都带（25 个/页），
 *    且每个 RJ 在整条记录里会重复 5 次（缩略图、链接、购物车按钮…），所以必须按 RJ 去重；
 * 2. 标题取该条记录里 `work_name` 块的 `<a title="…">`（没有 title 属性时退回标签内文本）；
 *    按钮文案（カートに追加 / お気に入りに追加 / 詳細）一律过滤；
 * 3. 页面里没有结构化锚点时，退回「按 href 匹配 product_id」的宽松模式。
 *    这一层仍会撞到按钮文案，所以同样靠噪音过滤保底。
 *
 * 不解析 HTML 表格、不做 genre（D19 已明确不做标签）。
 * M2.6 起额外提取 author / salesCount / rating——**这三个只有搜索结果页才有**，
 * 详情页的 `contents` JSON 不含它们（§3.1 实测）。
 */
export function parseSearchResults(html: unknown, limit = SEARCH_RESULT_LIMIT): DlsiteSearchHit[] {
  if (typeof html !== 'string' || !html) return []
  const raws: RawHit[] = []
  const seen = new Map<string, RawHit>()

  /** 记录一条出现；同一 RJ 重复出现时只补空缺字段（先到的标题优先）。 */
  const consider = (rj: string, chunk: string, order: number): void => {
    if (!rj) return
    const existing = seen.get(rj)
    const fields = readHitFields(chunk)
    if (existing) {
      if (!existing.title && fields.title) existing.title = fields.title
      if (!existing.category && fields.category) existing.category = fields.category
      if (!existing.coverUrl && fields.coverUrl) existing.coverUrl = fields.coverUrl
      if (!existing.author && fields.author) existing.author = fields.author
      if (existing.salesCount === undefined && fields.salesCount !== undefined) existing.salesCount = fields.salesCount
      if (existing.rating === undefined && fields.rating !== undefined) existing.rating = fields.rating
      return
    }
    const hit: RawHit = { rj, order, ...fields }
    seen.set(rj, hit)
    raws.push(hit)
  }

  // ① 结构化锚点：每条记录从 `data-list_item_product_id` 到下一个锚点之间
  const anchorPattern = /data-list_item_product_id\s*=\s*"(RJ[0-9]{6,8})"/g
  const anchors: Array<{ rj: string; index: number }> = []
  for (const match of html.matchAll(anchorPattern)) anchors.push({ rj: match[1], index: match.index ?? 0 })
  if (anchors.length > 0) {
    for (let i = 0; i < anchors.length; i += 1) {
      const from = anchors[i].index
      const to = i + 1 < anchors.length ? anchors[i + 1].index : Math.min(html.length, from + 4000)
      consider(anchors[i].rj, html.slice(from, to), i)
    }
  } else {
    // ② 宽松模式：按次出现的链接记录（每个 link 之后取一小段上下文）
    const linkPattern = /product_id\/(RJ[0-9]{6,8})\.html/g
    let counter = 0
    for (const match of html.matchAll(linkPattern)) {
      const index = match.index ?? 0
      consider(match[1], html.slice(index, Math.min(html.length, index + 1500)), counter)
      counter += 1
    }
  }

  const hits: DlsiteSearchHit[] = []
  const takenRj = new Set<string>()
  for (const raw of raws.sort((a, b) => a.order - b.order)) {
    if (isNoiseTitle(raw.title)) continue // 没拿到真标题的（例如只有按钮）直接跳过
    const rj = normalizeRj(raw.rj)
    if (!rj || takenRj.has(rj)) continue
    takenRj.add(rj)
    hits.push({
      rj,
      title: (raw.title as string).trim(),
      category: raw.category,
      coverUrl: raw.coverUrl,
      author: raw.author,
      salesCount: raw.salesCount,
      rating: raw.rating
    })
    if (hits.length >= limit) break
  }
  return hits
}

/** 从一条记录片段里读标题 / section / 缩略图。 */
function readHitFields(chunk: string): {
  title?: string
  category?: string
  coverUrl?: string
  author?: string
  salesCount?: number
  rating?: number
} {
  // 标题：优先 work_name 块里的 <a ... title="真标题">，否则退回标签内文本
  const nameBlock = /class="work_name"[\s\S]*?product_id\/(RJ[0-9]{6,8})\.html"?([^>]*)>([\s\S]{0,120}?)<\/a>/i.exec(chunk)
  let title: string | undefined
  let category: string | undefined
  if (nameBlock) {
    const attrs = nameBlock[2] ?? ''
    const titleAttr = /\btitle="([^"]{1,200})"/.exec(attrs)
    title = titleAttr ? decodeHtmlEntities(titleAttr[1]).trim() : decodeHtmlEntities(stripTags(nameBlock[3])).trim()
    category = sectionFromUrl(chunk, nameBlock.index)
  } else {
    // 宽松模式：找紧跟在 product_id 链接之后的第一个非噪音文本
    const loose = /product_id\/RJ[0-9]{6,8}\.html"?[^>]*>\s*([^<]{1,200})/i.exec(chunk)
    if (loose) title = decodeHtmlEntities(loose[1]).trim()
  }
  // 缩略图：记录里第一个 img.dlsite.jp 地址（协议相对也算）
  const images = chunk.match(/(?:https?:)?\/\/img\.dlsite\.jp\/[^"'\s,\\]+/g)
  return {
    title: isNoiseTitle(title) ? undefined : title,
    category,
    coverUrl: images ? normalizeCoverUrl(images[0]) : undefined,
    author: readHitAuthor(chunk),
    salesCount: readHitSalesCount(chunk),
    rating: readHitRating(chunk)
  }
}

/**
 * 作者（M2.6 §3.1）。真实结构：`<div class="maker_name"><a …>社团</a>
 * <span class="separator">/</span><span class="author"><a …>作者</a></span></div>`
 *
 * ⚠️ 只取 `.author` 里的内容——**不要把社团名当作者**（它们在同一块里）。
 */
function readHitAuthor(chunk: string): string | undefined {
  const match = /class="author"[^>]*>([\s\S]{0,160}?)<\/span>/i.exec(chunk)
  if (!match) return undefined
  const text = decodeHtmlEntities(stripTags(match[1])).trim()
  return text || undefined
}

/** 销量（M2.6 §3.1）：`販売数: <span class="_dl_count_RJ123">739</span>`。 */
function readHitSalesCount(chunk: string): number | undefined {
  const match = /class="_dl_count_[^"]*"[^>]*>(\d{1,9})</i.exec(chunk)
  if (!match) return undefined
  const value = Number.parseInt(match[1], 10)
  return Number.isFinite(value) ? value : undefined
}

/**
 * 评分（M2.6 §3.1）：`<div class="star_rating star_45 mini">` → 4.5。
 *
 * 类名里的 `star_45` 是「4.5 星」，`star_50` 是满分。没有这个 class 就不给评分
 * （**不把缺省当 0 分**——那是错的语义）。
 */
function readHitRating(chunk: string): number | undefined {
  const match = /class="star_rating\s+star_(\d{1,2})\b/i.exec(chunk)
  if (!match) return undefined
  const raw = Number.parseInt(match[1], 10)
  if (!Number.isFinite(raw) || raw <= 0) return undefined
  // 45 → 4.5；50 → 5.0；数字只有一位时按整数处理（如 star_5 → 5）
  const value = match[1].length >= 2 ? raw / 10 : raw
  return value > 0 && value <= 5 ? value : undefined
}

function stripTags(value: string | undefined): string {
  if (!value) return ''
  return value.replace(/<[^>]*>/g, ' ')
}

/** 从 `https://www.dlsite.com/<section>/...` 取 section；取不到返回 undefined。 */
function sectionFromUrl(text: string, from = 0): string | undefined {
  const chunk = text.slice(from)
  const match = /https?:\/\/(?:www\.)?dlsite\.com\/([a-z]+)\//i.exec(chunk)
  if (match) {
    const section = match[1].toLowerCase()
    if (/^[a-z]+$/.test(section)) return section
  }
  // 记录片段被裁断时退回全页第一个 section
  const fallback = /https?:\/\/(?:www\.)?dlsite\.com\/([a-z]+)\//i.exec(text)
  return fallback ? fallback[1].toLowerCase() : undefined
}

export interface DlsiteSearchInput {
  keyword: string
  /** 默认 maniax。 */
  category?: string
  /** 最多返回条数，默认 20（§7-③）。 */
  limit?: number
  signal?: AbortSignal
}

export interface DlsiteSearchResult {
  keyword: string
  results: DlsiteSearchHit[]
}

/** 让返回的 promise 也跟着 signal 走（不依赖 fetch 实现对 signal 的支持程度）。 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = (): void => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

export function createDlsiteService(options: DlsiteServiceOptions): DlsiteService {
  const cacheDir = path.join(options.dataDir, 'dlsite')
  const now = options.now ?? Date.now
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  /** 同一 RJ 的并发请求合并：连点两下只发一次（§4.1）。 */
  const inFlight = new Map<string, Promise<DlsiteWork>>()
  let lastRequestAt = 0
  let cookieOnce: Promise<void> | null = null

  const cachePath = (rj: string): string => path.join(cacheDir, `${rj}.json`)

  /**
   * 读缓存。**任何异常一律视为未命中**——缓存是可再生的，不像 library-meta.json 是用户数据；
   * TTL 过期同样算未命中。
   */
  function readCache(rj: string): DlsiteWork | null {
    const file = cachePath(rj)
    if (!fs.existsSync(file)) return null
    try {
      const raw = readJSON<Record<string, unknown>>(file)
      const work = raw.work as DlsiteWork | undefined
      if (!work || typeof work !== 'object' || Array.isArray(work)) return null
      const stamp = typeof raw.fetchedAt === 'string' ? Date.parse(raw.fetchedAt) : Number.NaN
      if (!Number.isFinite(stamp)) return null
      if (now() - stamp >= CACHE_TTL_MS) return null
      return work
    } catch {
      return null
    }
  }

  /**
   * 写缓存。旧缓存损坏时 `writeJSON` 会抛 `error.invalidObject`——缓存可重建，
   * 所以这里删掉重写（与 library-meta.json「绝不静默覆盖」的策略刻意相反）。
   */
  function writeCache(work: DlsiteWork): void {
    const file = cachePath(work.rj)
    const payload = { rj: work.rj, work, fetchedAt: work.fetchedAt }
    try {
      writeJSON(file, payload)
    } catch {
      fs.rmSync(file, { force: true })
      writeJSON(file, payload)
    }
  }

  function ensureCookie(): Promise<void> {
    const setter = options.setAdultCookie
    if (!setter) return Promise.resolve()
    if (!cookieOnce) {
      cookieOnce = Promise.resolve()
        .then(() => setter())
        .then(
          () => undefined,
          // 拿不到 cookie 最多是抓到年龄确认页，交给 parse 报错，不在这里炸
          () => undefined
        )
    }
    return cookieOnce
  }

  async function throttle(): Promise<void> {
    const wait = minIntervalMs - (now() - lastRequestAt)
    if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait))
    lastRequestAt = now()
  }

  async function fetchPage(
    category: string,
    rj: string,
    signal?: AbortSignal
  ): Promise<{ ok: boolean; status: number; html: string }> {
    return await fetchUrl(pageUrl(category, rj), rj, signal)
  }

  /**
   * 抓一个页面（查询页与搜索页共用）。
   * `context` 会塞进错误参数里，方便 UI 显示「是哪个 RJ / 哪个关键词出错」。
   */
  async function fetchUrl(
    url: string,
    context: string,
    signal?: AbortSignal
  ): Promise<{ ok: boolean; status: number; html: string }> {
    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      const response = await raceAbort(
        options.fetch(url, { headers: { accept: 'text/html,application/xhtml+xml' }, signal: combined }),
        combined
      )
      const html = response.ok ? await response.text() : ''
      return { ok: response.ok, status: response.status, html }
    } catch (error) {
      // 调用方主动取消 → 交给 IPC 层的 error.cancelled
      if (signal?.aborted) signal.throwIfAborted()
      const name = (error as { name?: string } | undefined)?.name
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw failure('error.dlsiteTimeout', `DLsite request timed out: ${url}`, { rj: context })
      }
      const reason = String((error as { message?: string } | undefined)?.message ?? error)
      throw failure('error.dlsiteNetwork', `DLsite request failed: ${reason}`, { reason })
    }
  }

  /**
   * 按名字搜索（M2.5 §A.1）。**刻意只取第一页**：用户要的是「点选填 RJ」，
   * 翻页会把交互复杂度抬上去，而搜索结果本身精度一般（§1.3），多给一页也不会更好选。
   *
   * 错误策略：
   * - 网络/超时 → 复用 error.dlsiteTimeout / error.dlsiteNetwork；
   * - 200 但不是结果页（含关键词确实无结果时进的「条件搜索页」）→ error.dlsiteSearchEmpty；
   * - 结果页但一个作品都没解析出来 → 同样 error.dlsiteSearchEmpty（对用户来说是同一件事）。
   */
  async function searchWorks(input: DlsiteSearchInput): Promise<DlsiteSearchResult> {
    const keyword = typeof input?.keyword === 'string' ? input.keyword.trim() : ''
    if (!keyword) {
      throw failure('error.dlsiteSearchEmpty', 'Search keyword is empty', { keyword: '' })
    }
    const category = input.category && /^[a-z]+$/.test(input.category) ? input.category : DEFAULT_SEARCH_CATEGORY
    const limit = input.limit && input.limit > 0 ? Math.min(input.limit, SEARCH_RESULT_LIMIT) : SEARCH_RESULT_LIMIT
    const signal = input.signal

    await ensureCookie()
    signal?.throwIfAborted()
    await throttle()

    const url = buildSearchUrl(keyword, category)
    const page = await fetchUrl(url, keyword, signal)
    if (!page.ok) {
      throw failure('error.dlsiteSearchEmpty', `DLsite search failed with status ${page.status}`, { keyword })
    }
    if (!isSearchResultPage(page.html)) {
      throw failure('error.dlsiteSearchEmpty', 'DLsite returned a non-result page', { keyword })
    }

    const results = parseSearchResults(page.html, limit)
    if (results.length === 0) {
      throw failure('error.dlsiteSearchEmpty', 'DLsite search returned no works', { keyword })
    }
    return { keyword, results }
  }

  /**
   * 依次尝试各 section：404 换下一个；200 就解析。
   * 全 404 → NotFound；有 200 但一个都解析不出来 → Parse（多为年龄确认页或已改版）。
   */
  async function runLookup(rj: string, signal?: AbortSignal): Promise<DlsiteWork> {
    await ensureCookie()
    let sawOk = false
    let lastStatus = 0
    let lastParseError: Error | null = null

    for (const category of PAGE_CATEGORIES) {
      signal?.throwIfAborted()
      await throttle()
      const page = await fetchPage(category, rj, signal)
      if (!page.ok) {
        lastStatus = page.status
        continue
      }
      sawOk = true
      try {
        // ⚠️ `fetchedAt` 必须来自**同一个时钟** `now()`，不能用 `new Date()`（M5.0 顺手修的 bug）。
        //
        // 原来写 `parseDlsiteWork(page.html, rj)`，第二个参数的默认值 `new Date().toISOString()`
        // 用的是**真实时间**；而 `readCache` 的 TTL 判断用的是注入的 `now()`。
        // 两者一旦不一致，`now() - fetchedAt` 会算出**负数** → 永远不判过期。
        //
        // 这个错误在 CI（Linux/UTC）上恰好被掩盖（假时间与真实时间相近），
        // 到 UTC+8 的开发机上 `now()` 比假时间晚 28 小时 → 符号翻转 →
        // `test/dlsite.test.ts > TTL 过期会重新发请求` 稳定变红。
        // 它测的正是「过期要重新发请求」，所以这条测试本身是**对的**，错的是实现。
        const work = parseDlsiteWork(page.html, rj, new Date(now()).toISOString())
        writeCache(work)
        return work
      } catch (error) {
        lastParseError = error as Error
        // RJ 格式错只可能来自 normalizeRj，那是调用方的错，直接抛出
        if ((error as { translationKey?: string }).translationKey === 'error.dlsiteInvalidRj') throw error
      }
    }

    if (sawOk) {
      throw lastParseError ?? failure('error.dlsiteParse', `Cannot parse DLsite page data for ${rj}`, { rj })
    }
    throw failure('error.dlsiteNotFound', `DLsite has no work ${rj} (last status ${lastStatus})`, {
      rj,
      status: lastStatus
    })
  }

  async function fetchWork(input: DlsiteLookupInput): Promise<DlsiteWork> {
    const rj = normalizeRj(input?.rj)
    if (!rj) {
      throw failure('error.dlsiteInvalidRj', `Invalid RJ number: ${String(input?.rj ?? '')}`, {
        rj: String(input?.rj ?? '')
      })
    }

    if (!input.refresh) {
      const cached = readCache(rj)
      if (cached) return cached
    }

    const existing = inFlight.get(rj)
    if (existing) return await existing

    const task = runLookup(rj, input.signal)
    inFlight.set(rj, task)
    try {
      return await task
    } finally {
      inFlight.delete(rj)
    }
  }

  return { fetchWork, searchWorks, cachePath }
}
