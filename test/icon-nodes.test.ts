// M5.5 单测：图标几何的**唯一来源**不许漂移。
//
// ===== 这个文件为什么存在 =====
//
// 本鱼把 Lucide 的图标几何**手抄**进了 `src/shared/icon-nodes.ts`（理由见那个文件头），
// 代价是：**包一升级，抄的常量就可能与世界脱节**。
//
// 脱节的表现很刁：图标不会报错，只是**样子变了**（圆角半径改了、路径微调了），
// 或者更糟 —— morph 的两个端点不再是同一个形状族，变形时会看到诡异的扭曲。
// typecheck / build / 其它测试**全部放过**。
//
// 所以这份判据的作用是：拿 `lucide-vue-next` 包里**真实导出**的几何，
// 与手抄常量**逐字节**比对。包一升级、图标一改，这条测试当场变红，
// 并且在报错里直接给出「该抄成什么」。
//
// ⚠️ 这条测试是「反向验证过」的：本鱼第一版抄错了 Gamepad2 与 Settings 两个路径，
// 就是被这条判据（当时是一次性探针）抓出来的，报错形如
//   ❌ Gamepad2: 期望 … 实际 …
import { describe, expect, test } from 'vitest'
import * as lucide from 'lucide-vue-next'
import {
  ALL_ICON_NAMES,
  ICON_NODES,
  MORPH_ICON_NAMES,
  MORPH_PAIRS,
  STATIC_ICON_NAMES,
  iconKind,
  morphIcon,
  type IconName
} from '../src/shared/icon-nodes'

/**
 * 从 lucide 的**组件**里取出它闭包里的 IconNode 数据。
 *
 * lucide 的图标是函数式组件 `(props, ctx) => h(Icon, { iconNode, name })`，
 * 调一次（不挂载、不进 DOM）就能拿到那份数据。
 *
 * 注意：这是**测试侧**才允许的手法。生产代码不这么取（理由见 icon-nodes.ts 文件头：
 * 依赖 lucide 内部结构，它一改变就静默 `undefined` → 图标不显示、还不报错）。
 * 测试里用它是安全的：真取不到会抛错、会红，而不是悄悄变形。
 */
function iconNodeOf(name: string): ReadonlyArray<readonly [string, Record<string, unknown>]> {
  const component = (lucide as unknown as Record<string, unknown>)[name]
  if (typeof component !== 'function') {
    throw new Error(`lucide-vue-next 里没有名为 ${name} 的图标（包升级后改名了？）`)
  }
  const vnode = (component as (p: unknown, c: unknown) => { props?: { iconNode?: unknown } })(
    {},
    { slots: {} }
  )
  const node = vnode?.props?.iconNode
  if (!Array.isArray(node)) {
    throw new Error(`从 lucide 的 ${name} 组件里取不到 iconNode（它的内部结构变了）`)
  }
  return node as ReadonlyArray<readonly [string, Record<string, unknown>]>
}

/**
 * 去掉 lucide 自带的 `key` 属性。
 *
 * `key` 是 vdom diff 用的稳定标识，**与几何无关**；而且它在不同版本的生成器里
 * 可能变（同一段路径换个哈希），把它算进判据只会让测试因为无关改动变红。
 * 几何相关的属性（`d` / `width` / `cx` …）全部保留比对。
 */
function geometric(node: ReadonlyArray<readonly [string, Record<string, unknown>]>): unknown {
  return node.map(([tag, attrs]) => [
    tag,
    Object.fromEntries(Object.entries(attrs).filter(([key]) => key !== 'key'))
  ])
}

describe('★ 手抄的图标几何必须与 lucide-vue-next 包里的真实数据一致', () => {
  test.each(ALL_ICON_NAMES as readonly IconName[])('%s 的几何逐字节一致', (name) => {
    const real = geometric(iconNodeOf(name))
    const ours = geometric(
      ICON_NODES[name] as ReadonlyArray<readonly [string, Record<string, unknown>]>
    )
    expect(
      ours,
      `${name} 的几何与 lucide-vue-next 不一致 —— 按下面的"期望"改 src/shared/icon-nodes.ts`
    ).toEqual(real)
  })

  test('每个图标都真的存在于 lucide-vue-next（改名就红）', () => {
    for (const name of ALL_ICON_NAMES) {
      // iconNodeOf 内部会抛错，这里只需要它不抛
      expect(() => iconNodeOf(name), `lucide 包里没有 ${name}`).not.toThrow()
    }
  })
})

describe('★ morph 的配对必须是「同一个按钮的两种状态」', () => {
  test('每一对的两个图标都在 ICON_NODES 里', () => {
    for (const [pairName, endpoints] of Object.entries(MORPH_PAIRS)) {
      for (const endpoint of endpoints) {
        expect(ICON_NODES, `${pairName} 引用了不存在的图标 ${endpoint}`).toHaveProperty(endpoint)
      }
    }
  })

  test('一对里的两个图标**不同**（相同就没得变形）', () => {
    for (const [pairName, [first, second]] of Object.entries(MORPH_PAIRS)) {
      expect(first, `${pairName} 的两个端点相同，morph 没有意义`).not.toBe(second)
    }
  })

  test('可 morph 的图标**恰好**是各配对里出现过的那些（不多不少）', () => {
    const fromPairs = new Set(Object.values(MORPH_PAIRS).flat())
    expect(new Set(MORPH_ICON_NAMES)).toEqual(fromPairs)
  })

  test('静态图标与 morph 图标**不相交**（一个图标不能既只画不 morph、又参与 morph）', () => {
    const overlap = (STATIC_ICON_NAMES as readonly string[]).filter((name) =>
      (MORPH_ICON_NAMES as readonly string[]).includes(name)
    )
    expect(overlap, `这些图标同时被归到了两种用法：${overlap.join(', ')}`).toEqual([])
  })

  test('每个图标**恰好**属于一类（漏归类 = 没人画它）', () => {
    const all = new Set(ALL_ICON_NAMES)
    const accounted = new Set<string>([...MORPH_ICON_NAMES, ...STATIC_ICON_NAMES])
    const missing = [...all].filter((name) => !accounted.has(name))
    expect(missing, `这些图标没有归到 component/morph 任何一类：${missing.join(', ')}`).toEqual([])
    expect(accounted.size, '有图标被归到了两处').toBe(all.size)
  })

  test('iconKind 与两张清单说的是同一件事', () => {
    for (const name of ALL_ICON_NAMES) {
      const expected = (MORPH_ICON_NAMES as readonly string[]).includes(name) ? 'morph' : 'component'
      expect(iconKind(name), `${name} 的归类不一致`).toBe(expected)
    }
  })
})

describe('★ morphIcon：状态 → 图标的映射（模板里不许自己算下标）', () => {
  test('第二个参数 false → 状态 A（展开中 / 可启动 / 已收起简介）', () => {
    expect(morphIcon('sidebarCollapse', false)).toBe(ICON_NODES.Menu)
    expect(morphIcon('launch', false)).toBe(ICON_NODES.Play)
    expect(morphIcon('summary', false)).toBe(ICON_NODES.ChevronDown)
  })

  test('第二个参数 true → 状态 B（已收起 / 运行中 / 已展开简介）', () => {
    expect(morphIcon('sidebarCollapse', true)).toBe(ICON_NODES.X)
    expect(morphIcon('launch', true)).toBe(ICON_NODES.Square)
    expect(morphIcon('summary', true)).toBe(ICON_NODES.ChevronUp)
  })
})
