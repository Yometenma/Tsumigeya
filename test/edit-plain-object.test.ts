// 回归测试：响应式 Proxy 不能直接过 contextBridge（S4 端到端探针实测抓到的真 bug）。
//
// 症状：用户点「保存」后字段看起来没动，控制台只有一行
//       "An object could not be cloned." —— 因为 Vue 的响应式 Proxy
//       无法被结构化克隆，而 `{ ...meta }` 只做浅拷贝，深层数组仍是 Proxy。
//
// 这个文件不测 Vue 组件，而是钉住「传给 IPC 的载荷必须是纯对象」这条契约：
// 它跑得快、不需要 GUI，而且任何新增的 IPC 载荷都能照这个模式加断言。
import { describe, expect, test } from 'vitest'

/** 判断一个值里是否藏着 Proxy（结构化克隆的判据近似：用 structuredClone 试一次）。 */
function isStructuredCloneable(value: unknown): boolean {
  try {
    structuredClone(value)
    return true
  } catch {
    return false
  }
}

/**
 * 与 GameEditPage 的 plainWork() 同规则的实现。
 * 刻意在测试里**再写一遍**而不是 import 组件内部函数：
 * 组件函数在 .vue 里无法被单测直接调用，而这里的价值是钉住「怎么剥」这条规则本身。
 */
function plainWork(meta: Record<string, unknown>): Record<string, unknown> {
  return {
    rj: meta.rj,
    title: meta.title,
    titleFull: meta.titleFull,
    circle: meta.circle,
    circleId: meta.circleId,
    seriesName: meta.seriesName,
    category: meta.category,
    workType: meta.workType,
    registDate: meta.registDate,
    price: meta.price,
    priceWithTax: meta.priceWithTax,
    officialPrice: meta.officialPrice,
    discount: meta.discount,
    coverUrl: meta.coverUrl,
    description: meta.description,
    fetchedAt: meta.fetchedAt,
    editedFields: [...((meta.editedFields as string[] | undefined) ?? [])]
  }
}

/**
 * 用与 Vue reactive 等价的 Proxy 包一层（Vue 3 的 reactive 就是 Proxy）——
 * 这里不 import vue，避免测试依赖框架内部实现；行为特征足够一致。
 */
function reactiveLike<T extends object>(target: T): T {
  return new Proxy(target, {
    get(obj, key, receiver) {
      const value = Reflect.get(obj, key, receiver) as unknown
      // Vue 的 reactive 会递归包装嵌套对象/数组
      if (value && typeof value === 'object') return reactiveLike(value as object)
      return value
    }
  }) as T
}

describe('IPC 载荷必须是纯对象（Proxy 过不了 contextBridge）', () => {
  test('Proxy 装的数组确实会被 structuredClone 拒绝（证明这个坑真实存在）', () => {
    const proxied = reactiveLike({ items: ['a', 'b'] })
    expect(isStructuredCloneable(proxied)).toBe(false)
  })

  test('浅拷贝 `{ ...proxy }` 仍然不可克隆（因为深层的数组还是 Proxy）', () => {
    const proxied = reactiveLike({ title: '标题', editedFields: ['title'] })
    expect(isStructuredCloneable({ ...proxied })).toBe(false)
  })

  test('plainWork 逐字段取值后可以安全跨桥', () => {
    const proxied = reactiveLike({
      rj: 'RJ306254',
      title: '傭兵の冒険',
      circle: 'たかまくらん',
      price: 750,
      editedFields: ['title']
    })
    const plain = plainWork(proxied as Record<string, unknown>)
    expect(isStructuredCloneable(plain)).toBe(true)
    expect(plain.title).toBe('傭兵の冒険')
    expect(plain.rj).toBe('RJ306254')
    expect(plain.price).toBe(750)
    // editedFields 必须是普通数组的拷贝（不是同一个引用）
    expect(plain.editedFields).toEqual(['title'])
    expect((plain.editedFields as string[]).length).toBe(1)
  })

  test('plainWork 不会漏掉字段（漏字段会让主进程把该值当 undefined 丢掉）', () => {
    const full = {
      rj: 'RJ306254',
      title: 't',
      titleFull: 'tf',
      circle: 'c',
      circleId: 'RG1',
      seriesName: 's',
      category: 'maniax',
      workType: 'SOU',
      registDate: '2020/08/30',
      price: 750,
      priceWithTax: 1650,
      officialPrice: 1650,
      discount: 50,
      coverUrl: 'https://img.dlsite.jp/a.jpg',
      description: 'd',
      fetchedAt: '2026-11-04T00:00:00.000Z',
      editedFields: ['title']
    }
    const plain = plainWork(full)
    for (const key of Object.keys(full)) {
      expect(plain).toHaveProperty(key)
    }
  })

  test('没有 editedFields 时给空数组（主进程据此判断「没被编辑过」）', () => {
    expect(plainWork({ rj: 'RJ1', title: 't' }).editedFields).toEqual([])
  })
})
