// M5.0 N1（U 系列之外的新功能）：详情页「游玩时间」的展示判据 -- 纯函数，零依赖。
//
// ===== 为什么值得抽出来 =====
//
// 用户原话：「我们已经有做了运行游戏的时候显示运行时间之类的，我觉得可以做一个
// 游玩时间统计之类的，就放到点击游戏卡片之后的启动游戏下方」
//
// 数据早就有（M3.5 落的 `play-stats.json`：totalSeconds / playCount / lastPlayedAt），
// 这一轮只是加 UI。看着最"安全"，但恰恰是这种「只加个显示」最容易出三类静默错误：
//
//   ① **把 0 秒当成"没玩过"**。`totalSeconds: 0` 是真实存在的状态：
//      启动后立刻崩溃 / 关掉，`finish()` 记的是 0 秒。若把它隐藏，用户看到的是
//      「还没玩过」，而 `playCount` 明明 ≥ 1 —— 两块信息自相矛盾。
//   ② **凭空编一个数字**。没有记录时显示「0 分钟」比显示「暂无记录」更糟：
//      它看起来像一个真的统计值，用户会以为自己的游玩历史被清空了。
//      （D37 的同一精神：拿不到就说拿不到，不假装。）
//   ③ **时长单位换算的边界**（59 秒 / 60 秒 / 59 分 / 60 分 / 99 小时）。
//      差一分钟的地方用户最容易发现，因为"刚玩了一小时"就在手边可核对。
//
// ⚠️ 零依赖：不 import vue / pinia / i18n / api-client。
// 文案不在这个文件里拼（规矩：文案一律进 locales），这里只输出**结构**，
// 由渲染层套 i18n 键。这样纯 Node 的 vitest 能直接测全部边界。

/** `play-stats.json` 里一条记录的最小形状（与 PlayStat 同构）。 */
export interface PlayStatLike {
  lastPlayedAt?: string
  playCount?: number
  totalSeconds?: number
}

/**
 * 时长的展示形态。
 *
 * 与「运行中」那个 `runningDurationText` 的档次**刻意一致**（秒 / 分 / 小时+分），
 * 免得同一个应用里两处时长用两套读法，用户看着像两个来源的数据。
 */
export type DurationShape =
  | { unit: 'seconds'; seconds: number }
  | { unit: 'minutes'; minutes: number }
  | { unit: 'hours'; hours: number; minutes: number }

/**
 * 秒 → 展示形态（**不做文案**，只决定用哪个单位）。
 *
 * 边界（每条都有单测）：
 *   · 0 → 0 秒（**不是**"没有记录"，这两件事 caller 要分开判断）
 *   · < 60 → 秒
 *   · < 3600 → 分（向下取整：玩 90 秒显示"1 分钟"比"2 分钟"诚实）
 *   · ≥ 3600 → 小时 + 余分（余分为 0 时不显示分，避免"3 小时 0 分钟"）
 *
 * 负数 / NaN / Infinity 一律按 0：这些值只可能来自手改或坏数据，
 * 给用户看"NaN 分钟"是最糟的降级（D37 精神）。
 */
export function durationShape(totalSeconds: number | undefined | null): DurationShape {
  const raw = typeof totalSeconds === 'number' && Number.isFinite(totalSeconds) ? totalSeconds : 0
  const seconds = raw > 0 ? Math.floor(raw) : 0
  if (seconds < 60) return { unit: 'seconds', seconds }
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return { unit: 'minutes', minutes }
  const hours = Math.floor(minutes / 60)
  return { unit: 'hours', hours, minutes: minutes % 60 }
}

/** 详情页「游玩时间」那一块的展示状态。 */
export type PlayTimeView =
  /** 完全没有记录：显示「暂无游玩记录」（**不显示 0**）。 */
  | { kind: 'none' }
  /** 有记录：显示时长 + 次数（+ 最后一次时间）。 */
  | {
      kind: 'stats'
      duration: DurationShape
      playCount: number
      /** 最后一次游玩的 ISO 时间；空串 = 记录里没有（UI 不显示这一项）。 */
      lastPlayedAt: string
    }

/**
 * 一条 `PlayStat` → 展示状态。
 *
 * 判据是「有没有**这条记录**」，不是「totalSeconds 是否 > 0」：
 * 启动后立刻退出也会写一条记录（playCount ≥ 1、totalSeconds = 0），
 * 那是真实发生过的事，该显示「0 秒 · 玩过 1 次」而不是「暂无记录」。
 */
export function playTimeView(stat: PlayStatLike | undefined | null): PlayTimeView {
  if (!stat || typeof stat !== 'object') return { kind: 'none' }
  const playCount =
    typeof stat.playCount === 'number' && Number.isFinite(stat.playCount)
      ? Math.max(0, Math.floor(stat.playCount))
      : 0
  const lastPlayedAt = typeof stat.lastPlayedAt === 'string' ? stat.lastPlayedAt : ''
  return {
    kind: 'stats',
    duration: durationShape(stat.totalSeconds),
    playCount,
    lastPlayedAt
  }
}

/**
 * 记录里「最后游玩时间」能不能拿去格式化。
 *
 * 单独一个判据是因为 `new Date('')` 会得到 Invalid Date、`toLocaleString()` 给出
 * "Invalid Date" 这种英文串直接画在页面上。空串、坏格式一律当"没有这一项"。
 */
export function hasValidPlayedAt(lastPlayedAt: string | undefined | null): boolean {
  if (typeof lastPlayedAt !== 'string' || !lastPlayedAt) return false
  return !Number.isNaN(Date.parse(lastPlayedAt))
}
