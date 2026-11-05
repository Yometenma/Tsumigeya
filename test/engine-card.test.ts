// M6.5：引擎页卡片判据的单测 + **源码级「有没有被调用」守卫**。
//
// ===== 这个文件防守的那类错误 =====
//
// 判据写完、单测全绿、**但界面根本没接** —— AGENTS.md 里记过这个坑（M4 S5 的
// `showsManualButtons`：3 条单测全绿，组件里没接，功能等于没写）。
//
// 本轮的两个判据正好属于这一类：
//   · `hasDependencies` 不接 → tyrano 卡片照样显示「安装」按钮 → 点了没反应
//   · `engineWarning` 不接 → 吉里吉里的上游限制 / 5 个新引擎的「未验证」
//     永远不会告诉用户
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
  engineWarning,
  hasDependencies,
  installableTargets,
  isExperimental,
  toCardSource,
  toCardSources
} from '../src/shared/engine-card'
import { ENGINES, buildManifest } from '../src/main/engines/registry'

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

// ===== 两种警告必须分开（这是本轮最重要的一条语义）=====
describe('engineWarning：两种原因必须给出不同的标签', () => {
  test('kirikiri → upstream-gate（上游明写不支援商用游戏）', () => {
    expect(engineWarning('kirikiri', SOURCES)).toBe('upstream-gate')
  })

  test('5 个未验证引擎 → unverified（是「我们没验」，不是「上游不承诺」）', () => {
    for (const folder of ['tyrano', 'nscripter', 'siglus', 'godot']) {
      expect(engineWarning(folder, SOURCES), `${folder} 应标未验证`).toBe('unverified')
    }
  })

  test('老四个引擎没有任何警告', () => {
    for (const folder of ['nwjs', 'mkxpz', 'easyrpg', 'renpy']) {
      expect(engineWarning(folder, SOURCES), `${folder} 不该有警告`).toBeNull()
    }
  })

  test('未知引擎 → null（不误伤）', () => {
    expect(engineWarning('no-such-engine', SOURCES)).toBeNull()
  })

  test('⚠️ 老数据里的布尔 true 按 upstream-gate 处理（那是它唯一出现过的含义）', () => {
    expect(engineWarning('legacy', [{ folder: 'legacy', dependencies: {}, experimental: true }])).toBe(
      'upstream-gate'
    )
  })

  test('全库清点：5 个未验证 + 1 个上游限制', () => {
    const unverified = ENGINES.filter((engine) => engine.experimental === 'unverified')
    const gate = ENGINES.filter((engine) => engine.experimental === 'upstream-gate')
    expect(unverified.map((e) => e.folder)).toEqual(['tyrano', 'nscripter', 'siglus', 'godot'])
    expect(gate.map((e) => e.folder)).toEqual(['kirikiri'])
  })

  test('isExperimental 仍然回答「有没有警告」（老调用方兼容）', () => {
    expect(isExperimental('kirikiri', SOURCES)).toBe(true)
    expect(isExperimental('nwjs', SOURCES)).toBe(false)
  })
})

// ===== 跨边界字段漏传（与 GameMeta sanitize 同一个坑）=====
describe('experimental 必须写进 manifest 才能传到渲染层', () => {
  test('buildManifest 带上了每张卡片的 experimental', () => {
    for (const engine of ENGINES) {
      const manifest = buildManifest(engine)
      if (engine.experimental) {
        // 漏写 → 渲染层拿不到 → 标签永远不显示，而且**不报错**
        expect(manifest.experimental, `${engine.folder} 的 experimental 没进 manifest`).toBe(
          engine.experimental
        )
      } else {
        expect(manifest.experimental, `${engine.folder} 不该有 experimental`).toBeUndefined()
      }
    }
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

describe('toCardSource：从 manifest 的 raw 里取依赖与标记', () => {
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

  test('experimental 在 raw 里（manifest 来源）也能取到', () => {
    const source = toCardSource({ folder: 'x', raw: { experimental: 'unverified' } })
    expect(source.experimental).toBe('unverified')
  })

  test('experimental 在顶层（引擎定义来源）也能取到', () => {
    const source = toCardSource({ folder: 'x', experimental: 'upstream-gate' })
    expect(source.experimental).toBe('upstream-gate')
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
    expect(source).toContain('engineWarning')
    expect(source).toContain('hasDependencies')
    expect(source).toContain('installableTargets')
    expect(source).toContain('toCardSources')
  })

  test('可安装卡片用判据决定显不显示「安装」按钮', () => {
    expect(source).toMatch(/v-if="canInstall\(module\.folder\)"/)
    expect(source).toContain("t('engines.noDependencies')")
  })

  test('**两种**警告标签都渲染了（分开的 v-if，不是合一个）', () => {
    expect(source).toMatch(/warningOf\(module\.folder\) === 'upstream-gate'/)
    expect(source).toMatch(/warningOf\(module\.folder\) === 'unverified'/)
    expect(source).toContain("t('engines.experimentalUpstream')")
    expect(source).toContain("t('engines.experimentalUnverified')")
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
    expect(engines).toHaveProperty('experimentalUpstream')
    expect(engines).toHaveProperty('experimentalUnverified')
    expect(engines).toHaveProperty('noDependencies')
    // 旧的合并键应该已经删掉（留着就是死 key，i18n-keys.test.ts 会红）
    expect(engines).not.toHaveProperty('experimental')
  })
})
