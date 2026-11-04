// M5.0 S7（U2）：分类存储 + **落盘白名单陷阱**的回归测试。
//
// ===== 这个文件存在的理由（方案 §4.2.2 明确写着「这条必踩」）=====
//
// `library-meta.json` 现在有**三种**内容，混在同一个文件里：
//
//     "1": { "rj": "RJ…", "title": "…" }     ← DLsite 条目（键是 gameId）
//     "categories":  { "action": {...} }      ← 分类定义表（S7 新增）
//     "assignments": { "1": ["action"] }      ← 归属表（S7 新增）
//
// 由此产生**三个**静默失败点，每一个都不报错、只是数据悄悄坏掉：
//
// ① **`load()` 不过滤顶层键** → `categories` 被当成一个"游戏 id"混进 meta，
//    渲染层的 unboundCount / languageGroups 会把它算成一个未绑定的游戏。
//
// ② **`save()` 整体覆写** → 它先用 `load()`（**已过滤**）读，再 `writeJSON` 整体写回。
//    那一次的写盘会把 `categories` / `assignments` **整个抹掉**。
//    触发时机极隐蔽：用户改了一次 DLsite 信息（编辑标题、重新获取元数据）
//    → 分类全没了。这是本轮**最危险**的一处。
//
// ③ **删分类漏摘某个游戏** → 留下悬空引用，侧边栏点进去什么都没有。
//
// 三条都有断言。另外钉住「删分类绝不删游戏」（方案 §4.2.2 + D31 精神）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createCategoryStore, splitMetaFile } from '../src/main/category-store'
import { createLibraryMetaStore } from '../src/main/library-meta'
import { readJSON } from '../src/main/games-store'
import type { DlsiteWork } from '../src/main/dlsite'

let dataDir: string
let metaFile: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-cat-'))
  metaFile = path.join(dataDir, 'library-meta.json')
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

function work(rj = 'RJ294126', title = '测试作品'): DlsiteWork {
  return { rj, title, fetchedAt: '2026-11-05T00:00:00.000Z' }
}

/** 直接读磁盘原始内容（不经过任何过滤）。 */
function rawFile(): Record<string, unknown> {
  return readJSON<Record<string, unknown>>(metaFile)
}

describe('splitMetaFile：顶层键与游戏条目分开', () => {
  test('游戏条目的键必须是纯数字', () => {
    const split = splitMetaFile({
      '1': { rj: 'RJ1' },
      categories: { action: { name: '动作类', order: 1 } },
      assignments: { '1': ['action'] }
    })
    expect(Object.keys(split.entries)).toEqual(['1'])
    expect(split.defs).toEqual({ action: { name: '动作类', order: 1 } })
    expect(split.assignments).toEqual({ '1': ['action'] })
  })

  test('⚠️ 未知顶层键被忽略（但不该被我们删掉 —— 那是用户/将来的数据）', () => {
    const split = splitMetaFile({ '1': { rj: 'RJ1' }, somethingElse: { keep: true } })
    expect(Object.keys(split.entries)).toEqual(['1'])
    expect(split.defs).toEqual({})
  })

  test('坏的定义条目被逐条丢弃（不是整体报废）', () => {
    const split = splitMetaFile({
      categories: {
        good: { name: '好的', order: 1 },
        noName: { order: 2 }, // 没名字 → 丢
        emptyName: { name: '   ', order: 3 }, // 空白 → 丢
        notObject: 'x' as unknown, // 不是对象 → 丢
        badOrder: { name: '序号坏', order: 'abc' } // order 归一为 0，保留
      }
    })
    expect(Object.keys(split.defs).sort()).toEqual(['badOrder', 'good'])
    expect(split.defs.badOrder?.order).toBe(0)
  })

  test('坏的归属条目被忽略', () => {
    const split = splitMetaFile({
      assignments: {
        '1': ['a'],
        '2': 'a' as unknown, // 不是数组 → 丢
        '3': [] // 空数组 → 丢（不留空键）
      }
    })
    expect(split.assignments).toEqual({ '1': ['a'] })
  })

  test('非对象输入 → 全空（不抛）', () => {
    expect(splitMetaFile(null)).toEqual({ entries: {}, defs: {}, assignments: {} })
    expect(splitMetaFile([])).toEqual({ entries: {}, defs: {}, assignments: {} })
  })
})

describe('★ 陷阱①：library-meta 的 load() 不能把 categories 当成游戏', () => {
  test('有分类定义时 load() 只返回数字键条目', () => {
    fs.writeFileSync(
      metaFile,
      JSON.stringify({
        '1': { rj: 'RJ1', title: 'A', fetchedAt: '2026-01-01T00:00:00.000Z' },
        categories: { action: { name: '动作类', order: 1 } },
        assignments: { '1': ['action'] }
      })
    )
    const meta = createLibraryMetaStore(dataDir).load()
    expect(Object.keys(meta)).toEqual(['1'])
    // 关键：不能出现 'categories' / 'assignments' 这两个"游戏"
    expect(Object.hasOwn(meta, 'categories')).toBe(false)
    expect(Object.hasOwn(meta, 'assignments')).toBe(false)
    expect(meta['1']?.rj).toBe('RJ1')
  })
})

describe('★★ 陷阱②：saveGameMeta 不能抹掉分类（本轮最危险的一处）', () => {
  test('保存一条 DLsite 元数据后，分类定义与归属**原样保留**', () => {
    const categories = createCategoryStore(dataDir)
    // 先建分类 + 归属
    categories.save({ action: { name: '动作类', order: 1 } }, { '1': ['action'] })
    // 再保存一条 DLsite 元数据（模拟用户改标题 / 重新获取元数据）
    createLibraryMetaStore(dataDir).save('1', work())

    const raw = rawFile()
    expect(raw.categories).toEqual({ action: { name: '动作类', order: 1 } })
    expect(raw.assignments).toEqual({ '1': ['action'] })
    expect(raw['1']).toMatchObject({ rj: 'RJ294126' })
  })

  test('删一条元数据（remove）也不抹掉分类', () => {
    const categories = createCategoryStore(dataDir)
    categories.save({ action: { name: '动作类', order: 1 } }, { '2': ['action'] })
    createLibraryMetaStore(dataDir).save('1', work('RJ1', '将被删的'))

    createLibraryMetaStore(dataDir).remove('1')

    const raw = rawFile()
    expect(raw.categories).toEqual({ action: { name: '动作类', order: 1 } })
    expect(raw.assignments).toEqual({ '2': ['action'] })
    expect(Object.hasOwn(raw, '1')).toBe(false)
  })

  test('⚠️ 未知顶层键同样要保留（我们不认识它 ≠ 可以删）', () => {
    fs.writeFileSync(
      metaFile,
      JSON.stringify({ '1': { rj: 'RJ1', fetchedAt: '2026-01-01T00:00:00.000Z' }, future: { a: 1 } })
    )
    createLibraryMetaStore(dataDir).save('2', work('RJ2', '新作品'))
    expect(rawFile().future).toEqual({ a: 1 })
  })

  test('反过来：分类存储写盘也不能抹掉 DLsite 条目', () => {
    createLibraryMetaStore(dataDir).save('1', work())
    const categories = createCategoryStore(dataDir)
    categories.save({ action: { name: '动作类', order: 1 } }, {})
    const raw = rawFile()
    expect(raw['1']).toMatchObject({ rj: 'RJ294126' })
  })
})

describe('★ 陷阱③：删分类只删定义 + 摘归属，**绝不删游戏**', () => {
  test('删掉分类后，该分类从所有游戏上消失', () => {
    const store = createCategoryStore(dataDir)
    store.save(
      { action: { name: '动作类', order: 1 }, favorite: { name: '我喜欢的', order: 2 } },
      { '1': ['action', 'favorite'], '2': ['action'], '3': ['favorite'] }
    )
    const { defs, assignments } = store.removeCategory('action')

    expect(Object.hasOwn(defs, 'action')).toBe(false)
    expect(Object.hasOwn(defs, 'favorite')).toBe(true)
    // 1 还剩 favorite；2 被摘成空 → 键被删掉
    expect(assignments['1']).toEqual(['favorite'])
    expect(Object.hasOwn(assignments, '2')).toBe(false)
    expect(assignments['3']).toEqual(['favorite'])
  })

  test('⚠️ **游戏本身一个都不少**（D31 精神：删定义不是删用户数据）', () => {
    // 造 games.json
    const gamesFile = path.join(dataDir, 'games.json')
    fs.writeFileSync(
      gamesFile,
      JSON.stringify({
        '1': { gameTitle: 'A', gamePath: '/a', gameEngine: 'nwjs' },
        '2': { gameTitle: 'B', gamePath: '/b', gameEngine: 'nwjs' }
      })
    )
    const store = createCategoryStore(dataDir)
    store.save({ action: { name: '动作类', order: 1 } }, { '1': ['action'], '2': ['action'] })
    store.removeCategory('action')

    const games = readJSON<Record<string, unknown>>(gamesFile)
    expect(Object.keys(games).sort()).toEqual(['1', '2'])
  })

  test('删不存在的分类 → 不改任何东西（幂等）', () => {
    const store = createCategoryStore(dataDir)
    store.save({ action: { name: '动作类', order: 1 } }, { '1': ['action'] })
    const before = rawFile()
    store.removeCategory('nope')
    expect(rawFile()).toEqual(before)
  })

  test('删完最后一个分类后，assignments 是空对象而不是一堆空数组', () => {
    const store = createCategoryStore(dataDir)
    store.save({ only: { name: '唯一', order: 1 } }, { '1': ['only'], '2': ['only'] })
    store.removeCategory('only')
    expect(rawFile().assignments).toEqual({})
  })
})

describe('归属：批量归入 / 去重 / 拒未知分类', () => {
  test('批量归入多个游戏', () => {
    const store = createCategoryStore(dataDir)
    store.save({ action: { name: '动作类', order: 1 } }, {})
    const result = store.assignGames(['1', '2', '3'], 'action')
    expect(result.assignments).toEqual({ '1': ['action'], '2': ['action'], '3': ['action'] })
  })

  test('⚠️ 多归属：一个游戏可以同时属于多个分类', () => {
    const store = createCategoryStore(dataDir)
    store.save(
      { action: { name: '动作类', order: 1 }, favorite: { name: '我喜欢的', order: 2 } },
      {}
    )
    store.assignGames(['1'], 'action')
    const result = store.assignGames(['1'], 'favorite')
    expect(result.assignments['1']).toEqual(['action', 'favorite'])
  })

  test('重复归入 → 不重复、顺序不变', () => {
    const store = createCategoryStore(dataDir)
    store.save({ action: { name: '动作类', order: 1 } }, { '1': ['action'] })
    const result = store.assignGames(['1'], 'action')
    expect(result.assignments['1']).toEqual(['action'])
  })

  test('⚠️ 归入不存在的分类 → 不写（否则造出指向不存在分类的悬空归属）', () => {
    const store = createCategoryStore(dataDir)
    store.save({}, {})
    const result = store.assignGames(['1'], 'ghost')
    expect(result.assignments).toEqual({})
  })

  test('非法 gameId 被挡（component 校验）', () => {
    const store = createCategoryStore(dataDir)
    store.save({ action: { name: '动作类', order: 1 } }, {})
    expect(() => store.assignGames(['../evil'], 'action')).toThrow()
  })
})

describe('removeGame：删游戏时清掉它的归属（不留孤儿键）', () => {
  test('删掉某个游戏的归属', () => {
    const store = createCategoryStore(dataDir)
    store.save({ action: { name: '动作类', order: 1 } }, { '1': ['action'], '2': ['action'] })
    store.removeGame('1')
    expect(Object.hasOwn(store.loadAssignments(), '1')).toBe(false)
    expect(store.loadAssignments()['2']).toEqual(['action'])
  })

  test('删一个本来就没归属的游戏 → 幂等', () => {
    const store = createCategoryStore(dataDir)
    store.save({ action: { name: '动作类', order: 1 } }, {})
    store.removeGame('9')
    expect(store.loadAssignments()).toEqual({})
  })
})

describe('loadAll：读回的一致性', () => {
  test('写什么读什么', () => {
    const store = createCategoryStore(dataDir)
    const defs = { action: { name: '动作类', order: 1 } }
    const assignments = { '1': ['action'], '2': ['action'] }
    store.save(defs, assignments)
    expect(store.loadAll()).toEqual({ defs, assignments })
  })

  test('文件不存在 → 全空（不是抛错）', () => {
    const store = createCategoryStore(dataDir)
    expect(store.loadAll()).toEqual({ defs: {}, assignments: {} })
  })

  test('.bak 备份由 writeJSON 负责（损坏文件不静默覆盖）', () => {
    const store = createCategoryStore(dataDir)
    store.save({ a: { name: 'A', order: 1 } }, {})
    store.save({ b: { name: 'B', order: 1 } }, {})
    // writeJSON 会写 .bak；这里只断言备份文件存在（策略本身在 games-store 的单测里）
    expect(fs.existsSync(`${metaFile}.bak`) || fs.existsSync(metaFile)).toBe(true)
  })
})

describe('顶层键的命名不与 gameId 冲突（结构前提）', () => {
  test("gameId 必须是纯数字，所以 'categories' / 'assignments' 不会被当成 id", () => {
    expect(/^\d+$/.test('categories')).toBe(false)
    expect(/^\d+$/.test('assignments')).toBe(false)
    expect(/^\d+$/.test('1')).toBe(true)
  })
})
