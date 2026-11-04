// M5.0 S7（U2）：分类的 IPC 层测试（四条命令 + snapshot 下发）。
//
// ===== 补的是哪一面 =====
//
// `category-store.test.ts` 测了存储层（三个陷阱）；
// `categories.test.ts` 测了纯逻辑（46 条）；
// 这里测**走 dispatcher 的那一段**：命令的参数校验、错误键、以及
// 「改完之后 snapshot 立刻反映新状态」——渲染层拿的就是这个 snapshot。
//
// 特别钉住三条与用户直接相关的事：
//  · 新建时名字查重 / 超长 / 空白都报**可翻译的错误键**（不是英文原文）
//  · 重命名**不改 id**（改 id 等于把全库归属全丢）
//  · 删分类**不删游戏**（方案 §4.2.2 / D31）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createCoreHost } from '../src/main/core-host'
import { createDispatcher } from '../src/main/ipc'

let dataDir: string
let host: ReturnType<typeof createCoreHost>

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-catipc-'))
  host = createCoreHost({ dataDir })
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

const signal = (): AbortSignal => new AbortController().signal

function saveGame(title: string): string {
  const all = host.store.saveGame({
    game: { gameTitle: title, gamePath: `/games/${title}`, gameEngine: 'nwjs' }
  })
  const entry = Object.entries(all).find(([, game]) => game.gameTitle === title)
  if (!entry) throw new Error(`game ${title} not found`)
  return entry[0]
}

type Snap = {
  games: Array<{ id: string }>
  categories: { defs: Record<string, { name: string; order: number }>; assignments: Record<string, string[]> }
}

describe('createCategory', () => {
  test('新建成功 → snapshot 里出现（带 order）', async () => {
    const dispatcher = createDispatcher({ host })
    const snap = (await dispatcher.dispatch('createCategory', { name: '动作类' }, signal())) as Snap
    expect(Object.keys(snap.categories.defs)).toHaveLength(1)
    const def = Object.values(snap.categories.defs)[0]!
    expect(def.name).toBe('动作类')
    expect(def.order).toBe(1)
  })

  test('⚠️ 重复名字 → error.categoryDuplicate（不是英文原文）', async () => {
    const dispatcher = createDispatcher({ host })
    await dispatcher.dispatch('createCategory', { name: '动作类' }, signal())
    await expect(dispatcher.dispatch('createCategory', { name: '动作类' }, signal())).rejects.toMatchObject({
      translationKey: 'error.categoryDuplicate'
    })
  })

  test('⚠️ 大小写不敏感查重（RPG 与 rpg 算同名）', async () => {
    const dispatcher = createDispatcher({ host })
    await dispatcher.dispatch('createCategory', { name: 'RPG' }, signal())
    await expect(dispatcher.dispatch('createCategory', { name: 'rpg' }, signal())).rejects.toMatchObject({
      translationKey: 'error.categoryDuplicate'
    })
  })

  test('空白名字 → error.categoryNameRequired', async () => {
    const dispatcher = createDispatcher({ host })
    await expect(dispatcher.dispatch('createCategory', { name: '   ' }, signal())).rejects.toMatchObject({
      translationKey: 'error.categoryNameRequired'
    })
  })

  test('超长名字 → error.categoryNameTooLong', async () => {
    const dispatcher = createDispatcher({ host })
    await expect(
      dispatcher.dispatch('createCategory', { name: 'あ'.repeat(40) }, signal())
    ).rejects.toMatchObject({ translationKey: 'error.categoryNameTooLong' })
  })

  test('多个分类的 order 递增（侧边栏按它排序）', async () => {
    const dispatcher = createDispatcher({ host })
    for (const name of ['甲', '乙', '丙']) {
      await dispatcher.dispatch('createCategory', { name }, signal())
    }
    const orders = Object.values(host.categories.loadDefs()).map((def) => def.order)
    expect(orders.sort((a, b) => a - b)).toEqual([1, 2, 3])
  })

  test('⚠️ 同名中文分类拿到**不同** id（slug 都退化成 cat，靠 -2/-3 区分）', async () => {
    const dispatcher = createDispatcher({ host })
    await dispatcher.dispatch('createCategory', { name: '甲类' }, signal())
    await dispatcher.dispatch('createCategory', { name: '乙类' }, signal())
    const ids = Object.keys(host.categories.loadDefs())
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })
})

describe('renameCategory', () => {
  test('★ 重命名后 **id 不变**（所以所有游戏的归属自动跟随）', async () => {
    const dispatcher = createDispatcher({ host })
    await dispatcher.dispatch('createCategory', { name: '旧名字' }, signal())
    const id = Object.keys(host.categories.loadDefs())[0]!

    const gameId = saveGame('游戏A')
    await dispatcher.dispatch('assignCategory', { id, gameIds: [gameId] }, signal())
    expect(host.categories.loadAssignments()[gameId]).toEqual([id])

    const snap = (await dispatcher.dispatch('renameCategory', { id, name: '新名字' }, signal())) as Snap
    expect(snap.categories.defs[id]?.name).toBe('新名字')
    // 归属**一点没变** —— 这就是「id 用 slug 不用自增数字」的全部收益
    expect(snap.categories.assignments[gameId]).toEqual([id])
  })

  test('改成别人在用的名字 → error.categoryDuplicate', async () => {
    const dispatcher = createDispatcher({ host })
    await dispatcher.dispatch('createCategory', { name: '甲' }, signal())
    await dispatcher.dispatch('createCategory', { name: '乙' }, signal())
    const ids = Object.keys(host.categories.loadDefs())
    const idA = ids[0]!
    await expect(
      dispatcher.dispatch('renameCategory', { id: idA, name: '乙' }, signal())
    ).rejects.toMatchObject({ translationKey: 'error.categoryDuplicate' })
  })

  test('改成自己原来的名字 → 允许（excludeId 生效）', async () => {
    const dispatcher = createDispatcher({ host })
    await dispatcher.dispatch('createCategory', { name: '甲' }, signal())
    const id = Object.keys(host.categories.loadDefs())[0]!
    await expect(dispatcher.dispatch('renameCategory', { id, name: '甲' }, signal())).resolves.toBeTruthy()
  })

  test('重命名不存在的分类 → error.categoryNotFound', async () => {
    const dispatcher = createDispatcher({ host })
    await expect(
      dispatcher.dispatch('renameCategory', { id: 'ghost', name: 'X' }, signal())
    ).rejects.toMatchObject({ translationKey: 'error.categoryNotFound' })
  })

  test('重命名保留 order（不会因为改名跑到列表末尾）', async () => {
    const dispatcher = createDispatcher({ host })
    await dispatcher.dispatch('createCategory', { name: '甲' }, signal())
    await dispatcher.dispatch('createCategory', { name: '乙' }, signal())
    const idA = Object.keys(host.categories.loadDefs())[0]!
    const before = host.categories.loadDefs()[idA]!.order
    await dispatcher.dispatch('renameCategory', { id: idA, name: '甲改' }, signal())
    expect(host.categories.loadDefs()[idA]!.order).toBe(before)
  })
})

describe('★ deleteCategory：只删定义，绝不删游戏（方案 §4.2.2 / D31）', () => {
  test('删掉分类后游戏一个不少，只是不再归入它', async () => {
    const dispatcher = createDispatcher({ host })
    const a = saveGame('游戏A')
    const b = saveGame('游戏B')
    await dispatcher.dispatch('createCategory', { name: '动作类' }, signal())
    const id = Object.keys(host.categories.loadDefs())[0]!
    await dispatcher.dispatch('assignCategory', { id, gameIds: [a, b] }, signal())

    const snap = (await dispatcher.dispatch('deleteCategory', { id }, signal())) as Snap
    // **游戏都还在**
    expect(snap.games.map((game) => game.id).sort()).toEqual([a, b].sort())
    // 分类定义没了，归属也被摘干净
    expect(Object.hasOwn(snap.categories.defs, id)).toBe(false)
    expect(snap.categories.assignments[a]).toBeUndefined()
    expect(snap.categories.assignments[b]).toBeUndefined()
  })

  test('删一个分类不影响别的分类的归属', async () => {
    const dispatcher = createDispatcher({ host })
    const gameId = saveGame('游戏A')
    await dispatcher.dispatch('createCategory', { name: '甲' }, signal())
    await dispatcher.dispatch('createCategory', { name: '乙' }, signal())
    const ids = Object.keys(host.categories.loadDefs())
    const [idA, idB] = ids
    await dispatcher.dispatch('assignCategory', { id: idA!, gameIds: [gameId] }, signal())
    await dispatcher.dispatch('assignCategory', { id: idB!, gameIds: [gameId] }, signal())

    await dispatcher.dispatch('deleteCategory', { id: idA! }, signal())
    expect(host.categories.loadAssignments()[gameId]).toEqual([idB])
  })

  test('删不存在的分类 → error.categoryNotFound', async () => {
    const dispatcher = createDispatcher({ host })
    await expect(
      dispatcher.dispatch('deleteCategory', { id: 'ghost' }, signal())
    ).rejects.toMatchObject({ translationKey: 'error.categoryNotFound' })
  })
})

describe('assignCategory：批量归入 / 移出', () => {
  test('归入多个游戏', async () => {
    const dispatcher = createDispatcher({ host })
    const ids = ['A', 'B', 'C'].map((title) => saveGame(title))
    await dispatcher.dispatch('createCategory', { name: '分类' }, signal())
    const catId = Object.keys(host.categories.loadDefs())[0]!

    const snap = (await dispatcher.dispatch('assignCategory', { id: catId, gameIds: ids }, signal())) as Snap
    for (const gameId of ids) expect(snap.categories.assignments[gameId]).toEqual([catId])
  })

  test('⚠️ 多归属：同一游戏归入两个分类，两个都在', async () => {
    const dispatcher = createDispatcher({ host })
    const gameId = saveGame('游戏A')
    await dispatcher.dispatch('createCategory', { name: '甲' }, signal())
    await dispatcher.dispatch('createCategory', { name: '乙' }, signal())
    const [idA, idB] = Object.keys(host.categories.loadDefs())

    await dispatcher.dispatch('assignCategory', { id: idA!, gameIds: [gameId] }, signal())
    await dispatcher.dispatch('assignCategory', { id: idB!, gameIds: [gameId] }, signal())
    expect(host.categories.loadAssignments()[gameId]).toEqual([idA, idB])
  })

  test('remove=true 移出分类', async () => {
    const dispatcher = createDispatcher({ host })
    const gameId = saveGame('游戏A')
    await dispatcher.dispatch('createCategory', { name: '分类' }, signal())
    const catId = Object.keys(host.categories.loadDefs())[0]!
    await dispatcher.dispatch('assignCategory', { id: catId, gameIds: [gameId] }, signal())

    const snap = (await dispatcher.dispatch(
      'assignCategory',
      { id: catId, gameIds: [gameId], remove: true },
      signal()
    )) as Snap
    expect(snap.categories.assignments[gameId]).toBeUndefined()
  })

  test('移出后归类为空 → 键被删掉（不留空数组）', async () => {
    const dispatcher = createDispatcher({ host })
    const gameId = saveGame('游戏A')
    await dispatcher.dispatch('createCategory', { name: '分类' }, signal())
    const catId = Object.keys(host.categories.loadDefs())[0]!
    await dispatcher.dispatch('assignCategory', { id: catId, gameIds: [gameId] }, signal())
    await dispatcher.dispatch('assignCategory', { id: catId, gameIds: [gameId], remove: true }, signal())

    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'library-meta.json'), 'utf8'))
    expect(raw.assignments ?? {}).toEqual({})
  })

  test('⚠️ 归入不存在的分类 → error.categoryNotFound（不造悬空归属）', async () => {
    const dispatcher = createDispatcher({ host })
    const gameId = saveGame('游戏A')
    await expect(
      dispatcher.dispatch('assignCategory', { id: 'ghost', gameIds: [gameId] }, signal())
    ).rejects.toMatchObject({ translationKey: 'error.categoryNotFound' })
  })

  test('归入不存在的游戏 → error.gameNotFound（整体失败，不半成）', async () => {
    const dispatcher = createDispatcher({ host })
    const real = saveGame('真游戏')
    await dispatcher.dispatch('createCategory', { name: '分类' }, signal())
    const catId = Object.keys(host.categories.loadDefs())[0]!
    await expect(
      dispatcher.dispatch('assignCategory', { id: catId, gameIds: [real, '9999'] }, signal())
    ).rejects.toMatchObject({ translationKey: 'error.gameNotFound' })
  })

  test('空 gameIds → 什么都不做（不报错）', async () => {
    const dispatcher = createDispatcher({ host })
    await dispatcher.dispatch('createCategory', { name: '分类' }, signal())
    const catId = Object.keys(host.categories.loadDefs())[0]!
    await expect(dispatcher.dispatch('assignCategory', { id: catId, gameIds: [] }, signal())).resolves.toBeTruthy()
  })
})

describe('★ 陷阱②在 IPC 层也堵住：saveGameMeta 之后分类还在', () => {
  test('保存 DLsite 元数据不会抹掉分类定义与归属', async () => {
    const dispatcher = createDispatcher({ host })
    const gameId = saveGame('游戏A')
    await dispatcher.dispatch('createCategory', { name: '动作类' }, signal())
    const catId = Object.keys(host.categories.loadDefs())[0]!
    await dispatcher.dispatch('assignCategory', { id: catId, gameIds: [gameId] }, signal())

    // 模拟用户编辑一次 DLsite 信息（走 saveGameMeta）
    await dispatcher.dispatch(
      'saveGameMeta',
      {
        gameId,
        work: { rj: 'RJ294126', title: '测试作品', fetchedAt: '2026-11-05T00:00:00.000Z' }
      },
      signal()
    )

    const snap = dispatcher.snapshot() as Snap
    expect(snap.categories.defs[catId]?.name).toBe('动作类')
    expect(snap.categories.assignments[gameId]).toEqual([catId])
  })

  test('clearGameMeta 也不会抹掉分类', async () => {
    const dispatcher = createDispatcher({ host })
    const gameId = saveGame('游戏A')
    await dispatcher.dispatch('createCategory', { name: '动作类' }, signal())
    const catId = Object.keys(host.categories.loadDefs())[0]!
    await dispatcher.dispatch('assignCategory', { id: catId, gameIds: [gameId] }, signal())
    await dispatcher.dispatch(
      'saveGameMeta',
      { gameId, work: { rj: 'RJ1', title: 'X', fetchedAt: '2026-01-01T00:00:00.000Z' } },
      signal()
    )

    await dispatcher.dispatch('clearGameMeta', { gameId }, signal())
    const snap = dispatcher.snapshot() as Snap
    expect(snap.categories.assignments[gameId]).toEqual([catId])
  })
})

describe('⚠️ 陷阱①在 IPC 层也堵住：categories 不能混进 meta', () => {
  test('建了分类之后，snapshot.meta 里不出现 categories 这个"游戏"', async () => {
    const dispatcher = createDispatcher({ host })
    await dispatcher.dispatch('createCategory', { name: '动作类' }, signal())
    const snap = dispatcher.snapshot() as { meta: Record<string, unknown> }
    expect(Object.keys(snap.meta)).toHaveLength(0)
  })

  test('有真实元数据时，meta 只有数字键', async () => {
    const dispatcher = createDispatcher({ host })
    const gameId = saveGame('游戏A')
    await dispatcher.dispatch('createCategory', { name: '动作类' }, signal())
    await dispatcher.dispatch(
      'saveGameMeta',
      { gameId, work: { rj: 'RJ1', title: 'X', fetchedAt: '2026-01-01T00:00:00.000Z' } },
      signal()
    )
    const snap = dispatcher.snapshot() as { meta: Record<string, unknown> }
    expect(Object.keys(snap.meta)).toEqual([gameId])
  })
})

describe('删游戏时清掉它的归属（不留孤儿键）', () => {
  test('deleteGame 之后 assignments 里没有那个 gameId 了', async () => {
    const dispatcher = createDispatcher({ host })
    const gameId = saveGame('游戏A')
    await dispatcher.dispatch('createCategory', { name: '分类' }, signal())
    const catId = Object.keys(host.categories.loadDefs())[0]!
    await dispatcher.dispatch('assignCategory', { id: catId, gameIds: [gameId] }, signal())

    await dispatcher.dispatch('deleteGame', { id: gameId }, signal())
    expect(Object.hasOwn(host.categories.loadAssignments(), gameId)).toBe(false)
  })
})
