// M5.0 S7（U2）单测：自定义分类的纯逻辑（src/shared/categories.ts）。
//
// ===== 这轮测什么 =====
//
// 用户拍板：**多归属**（一个游戏可属于多个分类）+ **扁平**（不做父子）。
//
// 分类对数据做的全是**批量改写**，而这类操作错了不报错、只是数据慢慢变脏：
//
//   · 删分类要摘掉**所有**游戏上的那个 id（漏一个就留悬空引用）
//   · 重命名**只改 name、id 不动**（动了 id 等于把全库归属全丢了）
//   · 新建要查重 + 生成唯一 id（撞 id 会把两个分类静默合并，归属当场错乱）
//
// 分类是用户长期累积的东西，脏一次很难还原 —— 所以判据必须能单测。
import { describe, expect, test } from 'vitest'
import {
  CATEGORY_NAME_MAX,
  UNCATEGORIZED_ID,
  isDuplicateName,
  matchesCategory,
  nextCategoryOrder,
  normalizeAssignments,
  normalizeCategoryName,
  slugifyCategoryName,
  sortedCategories,
  uniqueCategoryId,
  validateCategoryName,
  withCategory,
  withoutCategory,
  type CategoryDefs
} from '../src/shared/categories'

function defs(pairs: Array<[string, string, number]>): CategoryDefs {
  const out: CategoryDefs = {}
  for (const [id, name, order] of pairs) out[id] = { name, order }
  return out
}

describe('normalizeCategoryName：名字归一化', () => {
  test('去首尾空白', () => {
    expect(normalizeCategoryName('  动作类  ')).toBe('动作类')
  })

  test('⚠️ 连续空白压成一个（否则「我的 分类」和「我的   分类」会建出两个看起来一样的分类）', () => {
    expect(normalizeCategoryName('我的   分类')).toBe('我的 分类')
    expect(normalizeCategoryName('a\t\nb')).toBe('a b')
  })

  test('⚠️ 不改大小写（英文名用户可能刻意要留大写；查重时才按小写比较）', () => {
    expect(normalizeCategoryName('RPG Maker')).toBe('RPG Maker')
  })

  test('非字符串 → 空串', () => {
    expect(normalizeCategoryName(undefined)).toBe('')
    expect(normalizeCategoryName(123)).toBe('')
  })
})

describe('validateCategoryName', () => {
  test('空 / 全空白 → empty', () => {
    expect(validateCategoryName('')).toBe('empty')
    expect(validateCategoryName('   ')).toBe('empty')
  })

  test('正常名字 → null（没有错误）', () => {
    expect(validateCategoryName('动作类')).toBeNull()
  })

  test('正好上限 → 通过（边界，不能差一位）', () => {
    const name = 'あ'.repeat(CATEGORY_NAME_MAX)
    expect(validateCategoryName(name)).toBeNull()
  })

  test('超一位 → too-long', () => {
    expect(validateCategoryName('あ'.repeat(CATEGORY_NAME_MAX + 1))).toBe('too-long')
  })

  test('⚠️ 按**字符数**而不是 UTF-16 长度判（emoji / 代理对不该被算两个）', () => {
    // 32 个 emoji = UTF-16 长度 64，若用 .length 会误判超长
    const name = '🎮'.repeat(CATEGORY_NAME_MAX)
    expect(validateCategoryName(name)).toBeNull()
  })
})

describe('isDuplicateName：查重', () => {
  const defs1 = defs([
    ['action', '动作类', 1],
    ['rpg', 'RPG', 2]
  ])

  test('同名 → true', () => {
    expect(isDuplicateName(defs1, '动作类')).toBe(true)
  })

  test('⚠️ 大小写不敏感（RPG 与 rpg 是同一个分类）', () => {
    expect(isDuplicateName(defs1, 'rpg')).toBe(true)
    expect(isDuplicateName(defs1, ' RpG ')).toBe(true)
  })

  test('⚠️ 依赖归一化（首尾空白不算不同名）', () => {
    expect(isDuplicateName(defs1, '  动作类  ')).toBe(true)
    // 但中间插入空白**是**不同名：归一化只压连续空白，不会删掉词间的空格
    expect(isDuplicateName(defs1, '动作 类')).toBe(false)
  })

  test('重命名自己不算冲突（excludeId）', () => {
    expect(isDuplicateName(defs1, '动作类', 'action')).toBe(false)
    // 但改成别人已在用的名字要拦
    expect(isDuplicateName(defs1, 'RPG', 'action')).toBe(true)
  })

  test('空名字不报重复（交给 validateCategoryName 报 empty）', () => {
    expect(isDuplicateName(defs1, '')).toBe(false)
  })
})

describe('slugifyCategoryName：生成内部 id', () => {
  test('英文 → 小写连字符', () => {
    expect(slugifyCategoryName('RPG Maker')).toBe('rpg-maker')
  })

  test('⚠️ 纯中文 → 兜底 "cat"（不做拼音转写：要引表/引库，而 id 用户看不到）', () => {
    expect(slugifyCategoryName('动作类')).toBe('cat')
  })

  test('中文前/后缀被剥掉，只留 ASCII', () => {
    expect(slugifyCategoryName('我的 RPG')).toBe('rpg')
    expect(slugifyCategoryName('RPG 分类')).toBe('rpg')
  })

  test('标点/emoji 当分隔符', () => {
    expect(slugifyCategoryName('a/b')).toBe('a-b')
    expect(slugifyCategoryName('🎮 RPG')).toBe('rpg')
  })

  test('⚠️ 绝不返回空串（空 id 会让「未分类」判据误伤）', () => {
    expect(slugifyCategoryName('')).toBe('cat')
    expect(slugifyCategoryName('  ')).toBe('cat')
    expect(slugifyCategoryName('!!!')).toBe('cat')
  })

  test('超长时截断且不留尾连字符', () => {
    const slug = slugifyCategoryName('a'.repeat(40))
    expect(slug.length).toBeLessThanOrEqual(32)
    expect(slug.endsWith('-')).toBe(false)
  })
})

describe('uniqueCategoryId：id 必须唯一', () => {
  const existing = defs([
    ['cat', '动作类', 1],
    ['cat-2', '另一个', 2]
  ])

  test('空表 → 直接用 base', () => {
    expect(uniqueCategoryId({}, 'RPG')).toBe('rpg')
  })

  test('⚠️ 撞了就追加 -3（-2 也被占了）', () => {
    expect(uniqueCategoryId(existing, '动作类')).toBe('cat-3')
  })

  test('⚠️ 绝不返回已存在的 id（否则两个分类会被静默合并，归属当场错乱）', () => {
    const id = uniqueCategoryId(existing, '动作类')
    expect(Object.hasOwn(existing, id)).toBe(false)
  })

  test('多个中文名各自拿到不同的 id', () => {
    const ids = new Set<string>()
    const table: CategoryDefs = {}
    for (const name of ['动作类', '我喜欢的', '待玩']) {
      const id = uniqueCategoryId(table, name)
      expect(ids.has(id)).toBe(false)
      ids.add(id)
      table[id] = { name, order: 1 }
    }
    expect(ids.size).toBe(3)
  })
})

describe('nextCategoryOrder / sortedCategories', () => {
  test('空表 → 1（不是 0，让"第一个"读起来像人话）', () => {
    expect(nextCategoryOrder({})).toBe(1)
  })

  test('取最大值 + 1（不是条目数：删掉中间一个后不该复用别人的号）', () => {
    expect(nextCategoryOrder(defs([['a', 'A', 1], ['b', 'B', 5]]))).toBe(6)
  })

  test('按 order 升序', () => {
    const list = sortedCategories(defs([['b', 'B', 2], ['a', 'A', 1]]))
    expect(list.map((item) => item.name)).toEqual(['A', 'B'])
  })

  test('同 order 按名字排（保证顺序稳定，不看对象键顺序）', () => {
    const list = sortedCategories(defs([['z', 'Z', 1], ['a', 'A', 1]]))
    expect(list.map((item) => item.name)).toEqual(['A', 'Z'])
  })

  test('结果带 id（渲染层要拿它做筛选与删除）', () => {
    expect(sortedCategories(defs([['a', 'A', 1]]))[0]).toMatchObject({ id: 'a', name: 'A' })
  })
})

describe('withCategory / withoutCategory：归属增删', () => {
  test('加一个新分类', () => {
    expect(withCategory(['a'], 'b')).toEqual(['a', 'b'])
  })

  test('⚠️ 加已存在的分类 → 不变，且**保持原顺序**', () => {
    // 顺序漂移会让每次保存的 JSON diff 都变，无法 review
    expect(withCategory(['b', 'a'], 'a')).toEqual(['b', 'a'])
  })

  test('从没有归属的（undefined）开始加', () => {
    expect(withCategory(undefined, 'a')).toEqual(['a'])
  })

  test('摘掉一个分类', () => {
    expect(withoutCategory(['a', 'b'], 'a')).toEqual(['b'])
  })

  test('摘掉不存在的 → 原样（不是 undefined）', () => {
    expect(withoutCategory(['a'], 'zz')).toEqual(['a'])
  })

  test('摘成空 → 空数组（= 变回「未分类」）', () => {
    expect(withoutCategory(['a'], 'a')).toEqual([])
  })

  test('undefined 进 → 空数组出（不是 undefined，避免下游到处判空）', () => {
    expect(withoutCategory(undefined, 'a')).toEqual([])
  })

  test('⚠️ 都是纯函数，不就地改入参', () => {
    const original = ['a', 'b']
    withCategory(original, 'c')
    withoutCategory(original, 'a')
    expect(original).toEqual(['a', 'b'])
  })
})

describe('normalizeAssignments：脏数据归一', () => {
  const known = new Set(['a', 'b'])

  test('去空串、去重、保留首次出现顺序', () => {
    expect(normalizeAssignments(['b', '', 'a', 'b'], known)).toEqual(['b', 'a'])
  })

  test('⚠️ 丢未知 id（分类已被删掉的历史残留 → 不制造"点进去什么都没有"的幽灵）', () => {
    expect(normalizeAssignments(['a', 'gone'], known)).toEqual(['a'])
  })

  test('非数组 → 空', () => {
    expect(normalizeAssignments(undefined, known)).toEqual([])
    expect(normalizeAssignments('a', known)).toEqual([])
    expect(normalizeAssignments(null, known)).toEqual([])
  })

  test('非字符串元素被跳过', () => {
    expect(normalizeAssignments(['a', 1, null, {}], known)).toEqual(['a'])
  })

  test('trim 元素（脏数据里有 " a "）', () => {
    expect(normalizeAssignments([' a '], known)).toEqual(['a'])
  })
})

describe('matchesCategory：筛选（含「未分类」这个虚拟分类）', () => {
  test('没有筛选条件 → 全通过', () => {
    expect(matchesCategory(['a'], null)).toBe(true)
    expect(matchesCategory(undefined, null)).toBe(true)
  })

  test('命中某个分类', () => {
    expect(matchesCategory(['a', 'b'], 'a')).toBe(true)
    expect(matchesCategory(['b'], 'a')).toBe(false)
  })

  test('⚠️ 多归属：属于 a 也属于 b 的游戏，在两个筛选下都出现', () => {
    // 这就是"多归属（像标签）"的直接体现
    expect(matchesCategory(['a', 'b'], 'a')).toBe(true)
    expect(matchesCategory(['a', 'b'], 'b')).toBe(true)
  })

  test('⚠️「未分类」是虚拟分类：判据是"一个归属都没有"，不是某个特殊 id', () => {
    expect(matchesCategory([], UNCATEGORIZED_ID)).toBe(true)
    expect(matchesCategory(undefined, UNCATEGORIZED_ID)).toBe(true)
    expect(matchesCategory(['a'], UNCATEGORIZED_ID)).toBe(false)
    // 一个叫这个 id 的分类在定义表里**不存在**（方案 §4.2.2）
    expect(matchesCategory([UNCATEGORIZED_ID], UNCATEGORIZED_ID)).toBe(false)
  })
})
