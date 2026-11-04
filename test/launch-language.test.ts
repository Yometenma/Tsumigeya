// M2.5-C：启动时的语言切换决策（§C.5）。
//
// 为什么把判定抽成纯函数：这段逻辑直接决定「点启动会不会启动另一个游戏」，
// 是本功能里风险最高的地方（错认 → 用户启动了错的游戏）。
// 抽出来用单测钉死，比在端到端探针里碰运气可靠。
import { describe, expect, test } from 'vitest'
import { decideLaunchTarget, type LaunchLanguage } from '../src/shared/launch-language'

const ALTERNATES = [
  { id: 'zh', lang: 'zh' as LaunchLanguage },
  { id: 'en', lang: 'en' as LaunchLanguage }
]

describe('decideLaunchTarget（§C.5）', () => {
  test('当前已经是首选语言 → 不切换、不提示', () => {
    expect(
      decideLaunchTarget({
        current: 'zh',
        alternates: ALTERNATES,
        preferred: 'zh',
        fallback: 'ja',
        prompt: true
      })
    ).toEqual({ action: 'launch', targetId: undefined, reason: 'preferred' })
  })

  test('当前是次选、组里有首选 → 建议切到首选', () => {
    const result = decideLaunchTarget({
      current: 'en',
      alternates: ALTERNATES,
      preferred: 'zh',
      fallback: 'en',
      prompt: true
    })
    expect(result.action).toBe('prompt')
    expect(result.targetId).toBe('zh')
  })

  test('当前是次选、组里有首选 → 建议切到首选（ja 次选场景）', () => {
    const result = decideLaunchTarget({
      current: 'ja',
      alternates: [{ id: 'zh', lang: 'zh' }],
      preferred: 'zh',
      fallback: 'ja',
      prompt: true
    })
    expect(result.action).toBe('prompt')
    expect(result.targetId).toBe('zh')
  })

  test('当前都不在偏好里、组里有首选 → 建议切到首选', () => {
    const result = decideLaunchTarget({
      current: 'ko',
      alternates: [{ id: 'zh', lang: 'zh' }],
      preferred: 'zh',
      fallback: 'ja',
      prompt: true
    })
    expect(result.action).toBe('prompt')
    expect(result.targetId).toBe('zh')
  })

  test('当前都不在偏好里、组里只有次选 → 建议切到次选', () => {
    const result = decideLaunchTarget({
      current: 'ko',
      alternates: [{ id: 'ja', lang: 'ja' }],
      preferred: 'zh',
      fallback: 'ja',
      prompt: true
    })
    expect(result.action).toBe('prompt')
    expect(result.targetId).toBe('ja')
  })

  test('组里没有比当前更好的 → 直接启动（不打扰）', () => {
    expect(
      decideLaunchTarget({
        current: 'ja',
        alternates: [{ id: 'ko', lang: 'ko' }],
        preferred: 'zh',
        fallback: 'ja',
        prompt: true
      })
    ).toEqual({ action: 'launch', targetId: undefined, reason: 'no-better' })
  })

  test('当前识别不出语言 → 直接启动（无从比较，不瞎提示）', () => {
    expect(
      decideLaunchTarget({
        current: undefined,
        alternates: ALTERNATES,
        preferred: 'zh',
        fallback: 'ja',
        prompt: true
      })
    ).toEqual({ action: 'launch', targetId: undefined, reason: 'unknown-language' })
  })

  test('没有同组其他版本 → 直接启动', () => {
    expect(
      decideLaunchTarget({
        current: 'ja',
        alternates: [],
        preferred: 'zh',
        fallback: 'ja',
        prompt: true
      })
    ).toEqual({ action: 'launch', targetId: undefined, reason: 'no-alternates' })
  })

  test('设置里关掉提示 → 直接启动（专家用户不想被问）', () => {
    expect(
      decideLaunchTarget({
        current: 'ja',
        alternates: [{ id: 'zh', lang: 'zh' }],
        preferred: 'zh',
        fallback: 'ja',
        prompt: false
      })
    ).toEqual({ action: 'launch', targetId: undefined, reason: 'prompt-disabled' })
  })

  test('首选与次选都是 none → 功能整体不生效', () => {
    expect(
      decideLaunchTarget({
        current: 'ja',
        alternates: [{ id: 'zh', lang: 'zh' }],
        preferred: 'none',
        fallback: 'none',
        prompt: true
      })
    ).toEqual({ action: 'launch', targetId: undefined, reason: 'feature-disabled' })
  })

  test('首选 none 但次选 zh → 次选就当首选用', () => {
    const result = decideLaunchTarget({
      current: 'ja',
      alternates: [{ id: 'zh', lang: 'zh' }],
      preferred: 'none',
      fallback: 'zh',
      prompt: true
    })
    expect(result.action).toBe('prompt')
    expect(result.targetId).toBe('zh')
  })

  test('多个候选时选排名最靠前的（首选优先于次选）', () => {
    const result = decideLaunchTarget({
      current: 'ko',
      alternates: [
        { id: 'ja', lang: 'ja' },
        { id: 'zh', lang: 'zh' }
      ],
      preferred: 'zh',
      fallback: 'ja',
      prompt: true
    })
    expect(result.targetId).toBe('zh')
  })

  test('当前语言不在偏好里时，任何偏好语言都算"更好"', () => {
    const result = decideLaunchTarget({
      current: 'ko',
      alternates: [{ id: 'en', lang: 'en' }],
      preferred: 'zh',
      fallback: 'en',
      prompt: true
    })
    expect(result.action).toBe('prompt')
    expect(result.targetId).toBe('en')
  })
})
