// R18 封面打码的判定逻辑测试。
//
// 判定依据是 DLsite 的 section（category）：
//   实测同一 R18 作品在 homepro（全年龄站）返回 404、在 maniax 返回 200，
//   所以 category 是可靠判据，不需要额外的年龄分级字段。
//
// 注意：这只是**界面层面的温和保护**，不是内容过滤——
// 挡不住用户自己去 DLsite 查看，也挡不住本地游戏本身。
import { describe, expect, test } from 'vitest'
import { isAdultWork } from '../src/shared/age-rating'

describe('isAdultWork（R18 封面打码判定）', () => {
  test('maniax 判定为 R18', () => {
    expect(isAdultWork({ category: 'maniax' })).toBe(true)
  })

  test('books（成漫）判定为 R18', () => {
    expect(isAdultWork({ category: 'books' })).toBe(true)
  })

  test('homepro（同人全年龄）不算 R18', () => {
    expect(isAdultWork({ category: 'homepro' })).toBe(false)
  })

  test('soft / pro / appx 等全年龄站不算 R18', () => {
    for (const category of ['soft', 'pro', 'appx', 'comic']) {
      expect(isAdultWork({ category })).toBe(false)
    }
  })

  // 保守策略：缺字段时**不**打码，避免误伤全年龄作品。
  // 宁可漏保护，也不要让用户的全年龄游戏莫名其妙只剩占位图。
  test('缺少 category 时保守判定为否', () => {
    expect(isAdultWork({})).toBe(false)
    expect(isAdultWork(null)).toBe(false)
    expect(isAdultWork(undefined)).toBe(false)
  })

  test('大小写与空白不影响判定', () => {
    expect(isAdultWork({ category: ' MANIAX ' })).toBe(true)
    expect(isAdultWork({ category: 'Books' })).toBe(true)
  })

  test('未知分类不算 R18', () => {
    expect(isAdultWork({ category: 'unknown-section' })).toBe(false)
  })
})
