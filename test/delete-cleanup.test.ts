// M5.0 S6（U1）：删游戏时旁挂数据的清理 —— 回归测试。
//
// ===== 这个 bug 是怎么被发现的 =====
//
// 做 U1 批量删除时，本鱼先查「删一个游戏要清哪些旁挂数据」，发现 `deleteGame` 清了
// `library-meta`，却**从来没清 `play-stats.json`** —— 而 `PlayStatsStore.remove()`
// 这个 API 早在 M3.5 就写好了，只是**没有任何调用点**（死代码）。
//
// 单条删除时这个 bug 隐蔽：删掉的 id 通常不会被复用，于是留下一条谁也看不到的孤儿记录，
// 顶多让 play-stats.json 慢慢变大。**但批量删除会把它放大** —— 一次删掉一批后
// 新建游戏，id 是从「当前最大 id + 1」算的，很容易正好落到刚删掉的那个号上。
//
// 复用 id 的后果不是「多一条垃圾数据」，是**把别人的游玩历史安到新游戏头上**：
// 用户装了个新游戏，详情页显示「玩过 12 次 · 3 小时」—— 那是上一个游戏的历史。
// 这种"数据串台"比丢数据更难排查，因为界面一切正常、数字看起来也合理。
//
// ===== 为什么必须有测试 =====
//
// ① 复用 id 是 `saveGame` 的真实行为（`Math.max(...)+1`），不是理论风险。
// ② 清理调用点删掉后**不会有任何报错** —— 只有这条测试会红。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createCoreHost } from '../src/main/core-host'
import { createDispatcher } from '../src/main/ipc'
import { createPlayStatsStore } from '../src/main/play-stats'

let dataDir: string
let host: ReturnType<typeof createCoreHost>

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-bulk-'))
  host = createCoreHost({ dataDir })
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

function saveGame(title: string, id?: string): string {
  const all = host.store.saveGame({
    id,
    game: { gameTitle: title, gamePath: `/games/${title}`, gameEngine: 'nwjs' }
  })
  // 新加的那个 = 标题匹配的那条
  const entry = Object.entries(all).find(([, game]) => game.gameTitle === title)
  if (!entry) throw new Error(`game ${title} not found`)
  return entry[0]
}

describe('★ 删游戏必须清掉它的游玩记录（否则复用 id 时历史会串台）', () => {
  test('删掉之后 play-stats.json 里不再有该 gameId', async () => {
    const id = saveGame('游戏A')
    const stats = createPlayStatsStore(dataDir)
    stats.record(id, '2026-11-05T00:00:00.000Z')
    stats.finish(id, 3600)
    expect(stats.load()[id]?.playCount).toBe(1)

    const dispatcher = createDispatcher({ host })
    await dispatcher.dispatch('deleteGame', { id }, new AbortController().signal)

    expect(Object.hasOwn(stats.load(), id)).toBe(false)
  })

  test('⚠️ 删掉最大 id 后新建游戏 → id 复用，但游玩历史不能跟过来', async () => {
    // 造三条，删掉最大那条
    const first = saveGame('游戏A')
    const second = saveGame('游戏B')
    const third = saveGame('游戏C')
    expect([first, second, third]).toEqual(['1', '2', '3'])

    const stats = createPlayStatsStore(dataDir)
    stats.record(third, '2026-11-05T00:00:00.000Z')
    stats.finish(third, 3600)

    const dispatcher = createDispatcher({ host })
    await dispatcher.dispatch('deleteGame', { id: third }, new AbortController().signal)

    // 新建一条：id 复用 '3'（saveGame 的 Math.max(...)+1 规则）
    const recreated = saveGame('游戏D')
    expect(recreated).toBe(third)

    // 关键：新游戏**不该**继承上一个游戏的游玩历史
    expect(Object.hasOwn(stats.load(), recreated)).toBe(false)
  })

  test('删别的游戏不影响其他游戏的记录', async () => {
    const a = saveGame('游戏A')
    const b = saveGame('游戏B')
    const stats = createPlayStatsStore(dataDir)
    stats.record(a, '2026-11-05T00:00:00.000Z')
    stats.record(b, '2026-11-05T00:00:00.000Z')

    const dispatcher = createDispatcher({ host })
    await dispatcher.dispatch('deleteGame', { id: a }, new AbortController().signal)

    const left = stats.load()
    expect(Object.hasOwn(left, a)).toBe(false)
    expect(Object.hasOwn(left, b)).toBe(true)
  })

  test('批量删多个：全部的记录都要清掉（逐个走 deleteGame）', async () => {
    const ids = ['游戏A', '游戏B', '游戏C', '游戏D'].map((title) => saveGame(title))
    const stats = createPlayStatsStore(dataDir)
    for (const id of ids) {
      stats.record(id, '2026-11-05T00:00:00.000Z')
      stats.finish(id, 60)
    }

    const dispatcher = createDispatcher({ host })
    // 留下第一条，删 2/3/4
    for (const id of ids.slice(1)) {
      await dispatcher.dispatch('deleteGame', { id }, new AbortController().signal)
    }

    const left = stats.load()
    expect(Object.hasOwn(left, ids[0]!)).toBe(true)
    for (const id of ids.slice(1)) expect(Object.hasOwn(left, id)).toBe(false)
  })

  test('play-stats.json 坏掉时删游戏仍然成功（统计坏了不能拦住删游戏）', async () => {
    const id = saveGame('游戏A')
    fs.writeFileSync(path.join(dataDir, 'play-stats.json'), '{ not json')
    const dispatcher = createDispatcher({ host })

    // 清理失败必须被 catch 掉，不能让 deleteGame 抛错 ——
    // 「一份统计文件坏了就删不掉游戏」比「留下一条孤儿记录」糟得多。
    await expect(
      dispatcher.dispatch('deleteGame', { id }, new AbortController().signal)
    ).resolves.toBeTruthy()

    const all = host.store.loadGames()
    expect(Object.hasOwn(all, id)).toBe(false)
  })
})
