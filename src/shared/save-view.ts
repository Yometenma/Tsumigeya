// M4 S2：详情页「存档」区块的展示判据 -- 纯函数，零依赖。
//
// ===== 这个文件唯一要防的错误：三种"没有存档"被糊成一句 =====
//
// 主进程的 `listSaves` 会给出两个**独立的**信号（S1 定的，别改）：
//   · `location: null` → **不知道这个游戏的存档在哪**（引擎未识别 / Ren'Py 在游戏目录外）
//   · `empty: true`    → **位置找到了，只是还没存过档**
//
// 如果 UI 把两者合成「没有存档」，用户就永远查不出问题：
//   · 第一种是**故障**（该能查出来才能排障），文案要指向"我们没找到"
//   · 第二种是**正常**（新游戏还没玩到存档点），文案要给下一步动作
// 而第三种（有槽）照常列出来。三条分支必须分开，这也是本文件存在的理由。
//
// ⚠️ 判据一律在这里（纯函数 + 单测），**不写进 store 或 .vue**：
// 写在组件里就没法单测，而这三条分支恰恰是最容易"看起来对、实际糊了"的地方。
//
// ⚠️ 零依赖：不 import vue / pinia / i18n / api-client。
// 文案不进这里（规矩：文案一律进 locales），这里只输出**结构与键**。

/** 与主进程 SaveSlot 同构的最小形状（只要有这三样就够展示）。 */
export interface SaveItemLike {
  name: string
  size: number
  /** 最后修改时刻（ISO 8601）；读不到时是空串。 */
  mtime: string
}

/** 与主进程 SaveListing 同构的最小形状。 */
export interface SaveListingLike {
  location: unknown | null
  dir: string | null
  slots: readonly SaveItemLike[]
  configs: readonly SaveItemLike[]
  empty: boolean
}

/** 列表里的一项（已把字节数换成给人看的大小）。 */
export interface SaveItemView {
  name: string
  /** 例：`1.2 KB` / `512 B` / `3.4 MB` */
  sizeText: string
  /** 原始 ISO 时刻；空串表示读不到（UI 不画时间）。 */
  mtime: string
  /** 时间能不能拿去格式化（`new Date('')` 会画出英文 "Invalid Date"）。 */
  timeValid: boolean
}

/**
 * 详情页「存档」区块的三种形态。
 *
 * `unknown` 与 `empty` **必须**是两个分支 —— 见文件头注释。
 */
export type SaveSectionView =
  /** 不知道存档在哪（故障态：不是"没存档"）。 */
  | { kind: 'unknown' }
  /** 位置找到了，但还没存过档（正常态：玩到存档点就会出现）。 */
  | { kind: 'empty'; dir: string }
  /** 有内容：槽与配置分开列（配置不是第 0 号存档）。 */
  | {
      kind: 'list'
      dir: string
      slots: SaveItemView[]
      configs: SaveItemView[]
      /** 有没有配置项（没有就不画「配置文件」小标题）。 */
      hasConfigs: boolean
    }

/**
 * 一个「列存档」的结果 → 区块形态。
 *
 * 判定顺序（每一步都有单测）：
 *   ① `location === null` **或**拿不到 `dir`  → unknown（先判这个：没有位置就谈不上空/有）
 *   ② `empty === true`                        → empty
 *   ③ 其余                                     → list
 *
 * ⚠️ ① 里为什么 `dir` 也要判：S1 的契约是"两者同时为 null"，但渲染层不该依赖
 * 主进程"永不给出半个结果"的默契 —— 只拿到 location 而没有 dir 的话，
 * 「在访达中显示」会指向 undefined，那是**点了没反应**，用户不会报错只会觉得坏了。
 */
export function saveSectionView(listing: SaveListingLike | null | undefined): SaveSectionView {
  if (!listing || listing.location === null || !listing.dir) return { kind: 'unknown' }
  if (listing.empty) return { kind: 'empty', dir: listing.dir }
  const slots = listing.slots.map(toItemView)
  const configs = listing.configs.map(toItemView)
  return { kind: 'list', dir: listing.dir, slots, configs, hasConfigs: configs.length > 0 }
}

/** 一项 → 展示项。 */
function toItemView(item: SaveItemLike): SaveItemView {
  return {
    name: item.name,
    sizeText: formatByteSize(item.size),
    mtime: item.mtime,
    timeValid: isValidSaveTime(item.mtime)
  }
}

/**
 * 字节 → 给人看的大小（**确定性**，不依赖 locale）。
 *
 * 为什么不用 `toLocaleString`：它按系统区域变（中文会给 `1.2 千字节`），
 * 而这一列要和文件名/时间对齐成表格；数字位数跳动会让整列歪。
 *
 * 进制：**1024**（文件大小的传统口径）。刻意选它而不是 1000：
 * 用户在访达里看到的就是 1024 口径，两边对不上会被当成 bug。
 *
 * 边界（都有单测）：
 *   · 负数 / NaN / Infinity → `0 B`（坏数据不该画出 `NaN B`）
 *   · < 1024 → `N B`（整数，不带小数：`512.0 B` 是噪音）
 *   · < 1024² → `X.X KB`
 *   · < 1024³ → `X.X MB`
 *   · 更大 → `X.X GB`（存档不该有这么大，但插件目录可能有，别画成 `12345.6 MB`）
 */
export function formatByteSize(bytes: number | undefined | null): string {
  const raw = typeof bytes === 'number' && Number.isFinite(bytes) ? bytes : 0
  const value = raw > 0 ? raw : 0
  if (value < 1024) return `${Math.floor(value)} B`
  const units = ['KB', 'MB', 'GB'] as const
  let scaled = value / 1024
  let index = 0
  while (scaled >= 1024 && index < units.length - 1) {
    scaled /= 1024
    index += 1
  }
  const rounded = Math.round(scaled * 10) / 10
  // 12.0 KB → 12 KB：`.0` 是噪音，而且会让同一列的宽度无谓变化
  const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
  return `${text} ${units[index]}`
}

/**
 * 修改时间能不能拿去格式化。
 *
 * 单独一个判据的理由与 `shared/play-time.ts` 的 `hasValidPlayedAt` 相同：
 * `new Date('').toLocaleString()` 给出的是英文 `Invalid Date`，会**直接画在页面上**。
 * 空串、坏格式一律当"这一项没有时间"。
 */
export function isValidSaveTime(mtime: string | undefined | null): boolean {
  if (typeof mtime !== 'string' || !mtime) return false
  return !Number.isNaN(Date.parse(mtime))
}
