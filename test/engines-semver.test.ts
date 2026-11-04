// M4.2 S1 单测：版本号比较（D63 的「自实现 compareVersions / hasUpdate」）。
//
// 方案 §2.3 要求「约 60 行，配 15 条单测（含 prerelease 排序、不等位数、非数字段）」。
// 本文件 18 条，多出的三条是实施时发现的**真边界**：
//   · `hasUpdate` 的 N/A 兜底（上游那两行 if 删了就会挂永久的「有更新」红点）
//   · build metadata 不参与排序（`+build` 不截断会让 `1.0.0+a` != `1.0.0+b`）
//   · 脏值不抛错（本地 manifest 的 version 可能是旧版留下的任意字符串）
import { describe, expect, test } from 'vitest'
import {
  compareVersions,
  hasUpdate,
  normalizeVersion,
  parseVersion
} from '../src/main/engines/semver'

describe('S1 normalizeVersion：剥前导 v', () => {
  test('v / V 前缀都剥，大小写不影响', () => {
    expect(normalizeVersion('v0.106.1')).toBe('0.106.1')
    expect(normalizeVersion('V1.4.4')).toBe('1.4.4')
    expect(normalizeVersion('  1.4.4  ')).toBe('1.4.4')
  })

  test('没有前缀原样返回；null / undefined 变空串', () => {
    expect(normalizeVersion('1.4.4')).toBe('1.4.4')
    expect(normalizeVersion(null)).toBe('')
    expect(normalizeVersion(undefined)).toBe('')
  })

  test('只剥开头一个 v，中间的不动（"vv1.0" 只剥一层）', () => {
    expect(normalizeVersion('vv1.0')).toBe('v1.0')
  })
})

describe('S1 compareVersions：数字段', () => {
  test('大小关系与返回三元值', () => {
    expect(compareVersions('1.0.0', '1.0.1')).toBe(-1)
    expect(compareVersions('1.0.1', '1.0.0')).toBe(1)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
  })

  test('位数不等时缺段补 0：1.2 == 1.2.0', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('1.2', '1.2.1')).toBe(-1)
    expect(compareVersions('1.2', '1.3')).toBe(-1)
  })

  test('带 v 与不带 v 相等（nwjs 依赖名是 v0.106.1，manifest 是 1.4.4）', () => {
    expect(compareVersions('v0.106.1', '0.106.1')).toBe(0)
    expect(compareVersions('1.4.4', 'v1.4.5')).toBe(-1)
  })

  test('多段数字逐个比，不是字符串比（10 > 9）', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1)
    expect(compareVersions('1.2.10', '1.2.9')).toBe(1)
  })

  test('前导零按数值处理（01 == 1）', () => {
    expect(compareVersions('1.01', '1.1')).toBe(0)
  })
})

describe('S1 compareVersions：预发布段（prerelease）', () => {
  test('正式版大于同核心的预发布版', () => {
    expect(compareVersions('1.0.0', '1.0.0-beta.1')).toBe(1)
    expect(compareVersions('1.0.0-beta.1', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBe(-1)
  })

  test('预发布标识符按码位比（beta < rc）', () => {
    expect(compareVersions('1.0.0-beta', '1.0.0-rc')).toBe(-1)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBe(-1)
  })

  test('预发布里的数字段按数值比（beta.2 < beta.10）', () => {
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.10')).toBe(-1)
    expect(compareVersions('1.0.0-beta.1', '1.0.0-beta.2')).toBe(-1)
  })

  test('前缀相同、段数不同时段数少的小', () => {
    expect(compareVersions('1.0.0-beta', '1.0.0-beta.1')).toBe(-1)
    expect(compareVersions('1.0.0-beta.1', '1.0.0-beta.1.1')).toBe(-1)
  })

  test('预发布里的数字段大于字符串段（semver §11.4.3）', () => {
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBe(1)
  })

  test('核心段不同时先比核心段，预发布不参与', () => {
    expect(compareVersions('1.0.1-beta', '1.0.0')).toBe(1)
    expect(compareVersions('0.9.9', '1.0.0-beta')).toBe(-1)
  })
})

describe('S1 compareVersions：非数字段与脏值（不抛错）', () => {
  test('两个都是非数字段时按码位比', () => {
    expect(compareVersions('garbage', 'garbage')).toBe(0)
    expect(compareVersions('abc', 'def')).toBe(-1)
  })

  test('数字段排在字符串段之上（1 > alpha）', () => {
    expect(compareVersions('1.0', 'alpha.0')).toBe(1)
    expect(compareVersions('alpha.0', '1.0')).toBe(-1)
  })

  test('脏值不抛错，能给出一个稳定结果', () => {
    expect(() => compareVersions('not a version', '1.0.0')).not.toThrow()
    expect(() => compareVersions('', '')).not.toThrow()
    expect(compareVersions('', '')).toBe(0)
    // 空串当 0：空 vs 1.0.0 → 更小
    expect(compareVersions('', '1.0.0')).toBe(-1)
  })

  test('空段按 0 处理（1..2 这种脏值不炸）', () => {
    expect(compareVersions('1..2', '1.0.2')).toBe(0)
  })

  test('build metadata 不参与排序（+build 被截掉）', () => {
    expect(compareVersions('1.0.0+build.5', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0+a', '1.0.0+b')).toBe(0)
    // 有 build 也有 pre：pre 照样生效
    expect(compareVersions('1.0.0-beta+exp.a', '1.0.0')).toBe(-1)
  })
})

describe('S1 parseVersion：拆解结果可断言', () => {
  test('正式版没有 pre 字段，预发布版有', () => {
    expect(parseVersion('1.2.3')).toEqual({ core: [1, 2, 3] })
    expect(parseVersion('1.2.3-beta.1')).toEqual({ core: [1, 2, 3], pre: ['beta', 1] })
  })

  test('build metadata 被截掉', () => {
    expect(parseVersion('1.2.3+build.9')).toEqual({ core: [1, 2, 3] })
  })
})

describe('S1 hasUpdate：N/A 兜底与「谁比谁新」', () => {
  test('期望版本更新 → true；相同或更旧 → false', () => {
    expect(hasUpdate('1.4.3', '1.4.4')).toBe(true)
    expect(hasUpdate('1.4.4', '1.4.4')).toBe(false)
    expect(hasUpdate('1.4.5', '1.4.4')).toBe(false)
  })

  test('本地版本缺失（undefined / 空串 / N/A）一律 false', () => {
    expect(hasUpdate(undefined, '1.4.4')).toBe(false)
    expect(hasUpdate('', '1.4.4')).toBe(false)
    expect(hasUpdate('N/A', '1.4.4')).toBe(false)
  })

  test('期望版本缺失一律 false（否则引擎页会挂永不消失的红点）', () => {
    expect(hasUpdate('1.0.0', undefined)).toBe(false)
    expect(hasUpdate('1.0.0', '')).toBe(false)
    expect(hasUpdate('1.0.0', 'N/A')).toBe(false)
  })

  test('带 v 与不带 v 混合比较仍正确（nwjs 依赖名的真实形态）', () => {
    // 本地 manifest 写 1.4.4，期望也是 1.4.4 → 无更新
    expect(hasUpdate('1.4.4', 'v1.4.4')).toBe(false)
    // 本地是人手填的 v0.106.0，期望 0.106.1 → 有更新
    expect(hasUpdate('v0.106.0', '0.106.1')).toBe(true)
  })

  test('两边都是脏值时按比较结果来，不抛错', () => {
    expect(() => hasUpdate('odd', 'odds')).not.toThrow()
  })
})
