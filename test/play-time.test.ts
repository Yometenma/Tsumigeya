// M5.0 N1 单测：详情页「游玩时间」的展示判据（src/shared/play-time.ts）。
//
// ===== 这轮测什么 =====
//
// N1 看着最安全（数据 M3.5 就有，只加 UI），但「只加个显示」恰恰最爱出静默错误：
//
//   ① 把 0 秒当"没玩过" → 与 playCount ≥ 1 自相矛盾
//   ② 没记录时显示「0 分钟」→ 看起来像真数据，用户以为历史被清空（D37：不假装）
//   ③ 单位换算边界（59 秒 / 60 秒 / 59 分 / 60 分 / 余分为 0）
//
// 这三类都不报错、页面也不崩，只是画出一个「不太对」的界面 —— 必须靠单测钉住。
// 全部是纯数值/结构判据，纯 Node 跑得起（不碰 vue / i18n / 盘）。
import { describe, expect, test } from 'vitest'
import { durationShape, hasValidPlayedAt, playTimeView } from '../src/shared/play-time'

describe('durationShape：秒 → 展示单位', () => {
  test('0 秒 → 0 秒（这是合法值，不是"没有记录"）', () => {
    // 启动后立刻崩溃/关掉就是这种情况：totalSeconds=0 但 playCount≥1。
    // 判据必须落在「有没有这条记录」上，不能落在「时长是否 > 0」。
    expect(durationShape(0)).toEqual({ unit: 'seconds', seconds: 0 })
  })

  test('秒级（< 60）', () => {
    expect(durationShape(1)).toEqual({ unit: 'seconds', seconds: 1 })
    expect(durationShape(59)).toEqual({ unit: 'seconds', seconds: 59 })
  })

  test('⚠️ 60 秒整 → 进分钟档（边界）', () => {
    expect(durationShape(60)).toEqual({ unit: 'minutes', minutes: 1 })
  })

  test('分钟级向下取整（玩 90 秒显示 1 分钟，比 2 分钟诚实）', () => {
    expect(durationShape(90)).toEqual({ unit: 'minutes', minutes: 1 })
    expect(durationShape(119)).toEqual({ unit: 'minutes', minutes: 1 })
    expect(durationShape(3599)).toEqual({ unit: 'minutes', minutes: 59 })
  })

  test('⚠️ 3600 秒整 → 进小时档（边界）', () => {
    expect(durationShape(3600)).toEqual({ unit: 'hours', hours: 1, minutes: 0 })
  })

  test('小时 + 余分', () => {
    expect(durationShape(3600 + 300)).toEqual({ unit: 'hours', hours: 1, minutes: 5 })
    expect(durationShape(3600 * 99 + 59 * 60)).toEqual({ unit: 'hours', hours: 99, minutes: 59 })
  })

  test('余分为 0 时仍带 minutes: 0（渲染层据此省略"0 分钟"那几个字）', () => {
    expect(durationShape(7200)).toEqual({ unit: 'hours', hours: 2, minutes: 0 })
  })

  test('⚠️ 坏数据一律按 0（绝不把 NaN 画到页面上）', () => {
    expect(durationShape(Number.NaN)).toEqual({ unit: 'seconds', seconds: 0 })
    expect(durationShape(Number.POSITIVE_INFINITY)).toEqual({ unit: 'seconds', seconds: 0 })
    expect(durationShape(-100)).toEqual({ unit: 'seconds', seconds: 0 })
    expect(durationShape(undefined)).toEqual({ unit: 'seconds', seconds: 0 })
    expect(durationShape(null)).toEqual({ unit: 'seconds', seconds: 0 })
  })

  test('小数被截断（不应出现"1.5 秒"）', () => {
    expect(durationShape(1.9)).toEqual({ unit: 'seconds', seconds: 1 })
  })
})

describe('playTimeView：一条记录 → 展示状态', () => {
  test('⚠️ 没有记录 → none（不显示 0，也不假装有数据）', () => {
    expect(playTimeView(undefined)).toEqual({ kind: 'none' })
    expect(playTimeView(null)).toEqual({ kind: 'none' })
  })

  test('⚠️ totalSeconds=0 但 playCount=1 → 仍然是 stats（0 秒是真实值）', () => {
    const view = playTimeView({ totalSeconds: 0, playCount: 1, lastPlayedAt: '2026-11-05T01:00:00.000Z' })
    expect(view.kind).toBe('stats')
    if (view.kind !== 'stats') throw new Error('unreachable')
    expect(view.duration).toEqual({ unit: 'seconds', seconds: 0 })
    expect(view.playCount).toBe(1)
  })

  test('正常记录', () => {
    const view = playTimeView({ totalSeconds: 3725, playCount: 12, lastPlayedAt: '2026-11-04T10:00:00.000Z' })
    expect(view).toMatchObject({
      kind: 'stats',
      playCount: 12,
      lastPlayedAt: '2026-11-04T10:00:00.000Z'
    })
  })

  test('playCount 缺失/坏值按 0（渲染层据此不显示"玩过 0 次"）', () => {
    const view = playTimeView({ totalSeconds: 120 })
    expect(view.kind).toBe('stats')
    if (view.kind !== 'stats') throw new Error('unreachable')
    expect(view.playCount).toBe(0)
  })

  test('playCount 为负 / 小数时归一', () => {
    const view = playTimeView({ totalSeconds: 60, playCount: -3 })
    if (view.kind !== 'stats') throw new Error('unreachable')
    expect(view.playCount).toBe(0)
    const fractional = playTimeView({ totalSeconds: 60, playCount: 2.7 })
    if (fractional.kind !== 'stats') throw new Error('unreachable')
    expect(fractional.playCount).toBe(2)
  })

  test('lastPlayedAt 缺失时给空串（渲染层据此不显示这一项）', () => {
    const view = playTimeView({ totalSeconds: 60, playCount: 1 })
    if (view.kind !== 'stats') throw new Error('unreachable')
    expect(view.lastPlayedAt).toBe('')
  })
})

describe('hasValidPlayedAt：能不能拿去格式化', () => {
  test('合法 ISO → true', () => {
    expect(hasValidPlayedAt('2026-11-05T01:00:00.000Z')).toBe(true)
  })

  test('⚠️ 空串 / undefined / 坏串 → false（否则页面会画出英文 Invalid Date）', () => {
    expect(hasValidPlayedAt('')).toBe(false)
    expect(hasValidPlayedAt(undefined)).toBe(false)
    expect(hasValidPlayedAt(null)).toBe(false)
    expect(hasValidPlayedAt('not-a-date')).toBe(false)
    expect(hasValidPlayedAt('2026-13-45')).toBe(false)
  })
})
