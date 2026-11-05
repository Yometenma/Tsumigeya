// M6.5：引擎页卡片判据的单测 + **源码级「有没有被调用」守卫**。
//
// ===== 这个文件防守的那类错误 =====
//
// 判据写完、单测全绿、**但界面根本没接** —— AGENTS.md 里记过这个坑（M4 S5 的
// `showsManualButtons`：3 条单测全绿，组件里没接，功能等于没写）。
//
// 本轮的两个判据正好属于这一类：
//   · `hasDependencies` 不接 → tyrano 卡片照样显示「安装」按钮 → 点了没反应
//   · `isExperimental` 不接 → 吉里吉里的限制永远不告诉用户
//
// 所以除了断言判据本身，还要**扫模板**确认它被引用。
//
// ⚠️ 这里**可以** import `main/engines/registry`（test/ 在 node 工程里），
//    而 `src/shared/engine-card.ts` **不可以**（它会被渲染层打包，跨工程会 TS6307）。
//    这就是判据改成「依赖注入」的原因 —— 见该文件头的注释。
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  hasDependencies,
  installableTargets,
  isExperimental,
  toCardSource,
  toCardSources
} from '../src/shared/engine-card'
import { ENGINES } from '../src/main/engines/registry'

const PAGE = path.join(process.cwd(), 'src', 'renderer', 'src', 'pages', 'EnginesPage.vue')

/** 把 registry 的引擎定义转成判据输入（这就是生产里 EnginesPage 干的事）。 */
const SOURCES = ENGINES.map((engine) => ({
  folder: engine.folder,
  dependencies: engine.dependencies as Record<string, unknown>,
  experimental: engine.experimental
}))

describe('hasDependencies', () => {
  test('tyrano 的 dependencies 是空对象 → false（它复用 NW.js，无需下载）', () => {
    expect(hasDependencies('tyrano', SOURCES)).toBe(false)
  })

  test('有依赖的引擎 → true', () => {
    for (const folder of ['nwjs', 'mkxpz', 'easyrpg', 'renpy', 'kirikiri', 'nscripter', 'siglus', 'godot']) {
      expect(hasDependencies(folder, SOURCES), `${folder} 应该有依赖`).toBe(true)
    }
  })

  test('未知引擎 → true（保守：多显示一个按钮比「该能装却说无需下载」安全）', () => {
    expect(hasDependencies('no-such-engine', SOURCES)).toBe(true)
  })

  test('与 registry 一致：只有 tyrano 是空依赖（若将来多了，这条会红，提醒去改 UI）', () => {
    const empty = ENGINES.filter((engine) => Object.keys(engine.dependencies).length === 0)
    expect(empty.map((engine) => engine.folder)).toEqual(['tyrano'])
  })
})

describe('isExperimental', () => {
  test('kirikiri 标了 experimental → true', () => {
    expect(isExperimental('kirikiri', SOURCES)).toBe(true)
  })

  test('其余引擎都不是实验性', () => {
    for (const folder of ['nwjs', 'mkxpz', 'easyrpg', 'renpy', 'tyrano', 'nscripter', 'siglus', 'godot']) {
      expect(isExperimental(folder, SOURCES), `${folder} 不该是实验性`).toBe(false)
    }
  })

  test('未知引擎 → false（不误伤）', () => {
    expect(isExperimental('no-such-engine', SOURCES)).toBe(false)
  })
})

describe('installableTargets：排除空依赖引擎', () => {
  test('从可安装列表里剔除 tyrano', () => {
    const available = [{ folder: 'nwjs' }, { folder: 'tyrano' }, { folder: 'godot' }]
    expect(installableTargets(available, SOURCES)).toEqual([{ folder: 'nwjs' }, { folder: 'godot' }])
  })

  test('全是空依赖时返回空数组', () => {
    expect(installableTargets([{ folder: 'tyrano' }], SOURCES)).toEqual([])
  })

  test('保留原顺序（进度文案要对得上卡片列表）', () => {
    const available = [{ folder: 'godot' }, { folder: 'nwjs' }]
    expect(installableTargets(available, SOURCES)).toEqual([{ folder: 'godot' }, { folder: 'nwjs' }])
  })
})

describe('toCardSource：从 manifest 的 raw 里取依赖', () => {
  test('取 raw.dependencies', () => {
    const source = toCardSource({ folder: 'x', raw: { dependencies: { a: {} } } })
    expect(source.folder).toBe('x')
    expect(source.dependencies).toEqual({ a: {} })
  })

  test('⚠️ 也认上游老写法的 raw.deps（两处都出现过，只认一处会漏）', () => {
    const source = toCardSource({ folder: 'x', raw: { deps: { b: {} } } })
    expect(source.dependencies).toEqual({ b: {} })
  })

  test('两处都没有 → 空对象（= 无需下载）', () => {
    const source = toCardSource({ folder: 'x', raw: {} })
    expect(source.dependencies).toEqual({})
    expect(hasDependencies('x', [source])).toBe(false)
  })

  test('连 raw 都没有 → 空对象（不抛）', () => {
    expect(toCardSource({ folder: 'x' }).dependencies).toEqual({})
  })

  test('toCardSources 批量转换', () => {
    const list = toCardSources([{ folder: 'a', raw: {} }, { folder: 'b', raw: { dependencies: { d: {} } } }])
    expect(list.map((item) => item.folder)).toEqual(['a', 'b'])
  })
})

// ===== 源码级守卫：判据必须真的被用（否则等于没写）=====
describe('⚠️ 判据必须被界面调用（防「写了、测了、但没人接」）', () => {
  const source = fs.readFileSync(PAGE, 'utf8')

  test('EnginesPage 引用了 engine-card 判据', () => {
    expect(source).toContain("from '../../../shared/engine-card'")
    expect(source).toContain('hasDependencies')
    expect(source).toContain('isExperimental')
    expect(source).toContain('installableTargets')
    expect(source).toContain('toCardSources')
  })

  test('可安装卡片用判据决定显不显示「安装」按钮', () => {
    // 模板里必须有 v-if="canInstall(...)" 包住安装按钮的 <template>
    expect(source).toMatch(/v-if="canInstall\(module\.folder\)"/)
    // 并且在 else 分支给出「无需单独下载」这句话（而不是什么都不显示）
    expect(source).toContain("t('engines.noDependencies')")
  })

  test('实验性标签真的渲染了', () => {
    expect(source).toMatch(/v-if="showExperimental\(module\.folder\)"/)
    expect(source).toContain("t('engines.experimental')")
  })

  test('「全部安装」两处（计数与执行）都排除了空依赖引擎', () => {
    const uses = source.match(/installableTargets\(/g) ?? []
    expect(uses.length, '应该有两处用到 installableTargets（计数 + 执行）').toBeGreaterThanOrEqual(2)
  })

  test('i18n 键真的存在于 locales（vue-i18n 查不到会原样画 key 且不报错）', () => {
    const locales = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), 'src', 'renderer', 'src', 'locales', 'zh-CN.json'),
        'utf8'
      )
    ) as Record<string, unknown>
    const engines = locales.engines as Record<string, unknown>
    expect(engines).toHaveProperty('experimental')
    expect(engines).toHaveProperty('noDependencies')
  })
})
