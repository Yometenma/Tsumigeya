// M5.0 S6（U1）：批量删除的**主进程侧**回归测试 —— 逐个删除的原子性与清理完整度。
//
// ===== 为什么要有这一层 =====
//
// 渲染层的 `library.removeGames()` 只是"逐个调 deleteGame 并收集结果"，
// 真正的删除与清理都在主进程。所以这里测的是**主进程的 deleteGame 在批量场景下的行为**：
//
//   · 删 N 个：每一个的旁挂数据（library-meta + play-stats）都必须清干净
//   · 中间删掉一个不存在的 id：只影响那一条，不打断其余的
//   · 删完之后 snapshot 立刻正确（界面不会短暂显示"已删了但还在列表里"）
//
// 批量删除的**二次确认文案**在 shared/bulk-select.ts（22 条单测）；
// 删游戏清游玩记录的回归在 delete-cleanup.test.ts（5 条）。
// 这个文件补的是「多条连续删除时每条都清干净」这一面。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createCoreHost } from '../src/main/core-host'
import { createDispatcher } from '../src/main/ipc'
import { createPlayStatsStore } from '../src/main/play-stats'
import { createLibraryMetaStore } from '../src/main/library-meta'

let dataDir: string
let host: ReturnType<typeof createCoreHost>

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-bulkmain-'))
  host = createCoreHost({ dataDir })
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

function saveGame(title: string): string {
  const all = host.store.saveGame({
    game: { gameTitle: title, gamePath: `/games/${title}`, gameEngine: 'nwjs' }
  })
  const entry = Object.entries(all).find(([, game]) => game.gameTitle === title)
  if (!entry) throw new Error(`game ${title} not found`)
  return entry[0]
}

/** 给一个游戏造齐三类旁挂数据（meta + playStats）。 */
function fillSideData(id: string): void {
  const meta = createLibraryMetaStore(dataDir)
  meta.save(id, {
    rj: `RJ00${id}`,
    title: `作品${id}`,
    fetchedAt: '2026-11-05T00:00:00.000Z'
  })
  const stats = createPlayStatsStore(dataDir)
  stats.record(id, '2026-11-05T00:00:00.000Z')
  stats.finish(id, 120)
}

describe('批量删除（逐个走 deleteGame）', () => {
  test('★ 每一个被删游戏的 meta 与 play-stats 都清干净（不留孤儿）', async () => {
    const ids = ['A', 'B', 'C'].map((title) => saveGame(title))
    for (const id of ids) fillSideData(id)

    const dispatcher = createDispatcher({ host })
    for (const id of ids) {
      await dispatcher.dispatch('deleteGame', { id }, new AbortController().signal)
    }

    const meta = createLibraryMetaStore(dataDir).load()
    const stats = createPlayStatsStore(dataDir).load()
    for (const id of ids) {
      expect(Object.hasOwn(meta, id), `meta 里残留 ${id}`).toBe(false)
      expect(Object.hasOwn(stats, id), `play-stats 里残留 ${id}`).toBe(false)
    }
  })

  test('只删一部分时，没删的那些旁挂数据必须原样保留', async () => {
    const keep = saveGame('保留')
    const drop = saveGame('删掉')
    fillSideData(keep)
    fillSideData(drop)

    const dispatcher = createDispatcher({ host })
    await dispatcher.dispatch('deleteGame', { id: drop }, new AbortController().signal)

    const meta = createLibraryMetaStore(dataDir).load()
    const stats = createPlayStatsStore(dataDir).load()
    expect(Object.hasOwn(meta, keep)).toBe(true)
    expect(Object.hasOwn(stats, keep)).toBe(true)
    // 而且内容没被改动
    expect(stats[keep]?.playCount).toBe(1)
    expect(stats[keep]?.totalSeconds).toBe(120)
  })

  test('删一个不存在的 id → 只那一条报错，其余照常能删（渲染层据此继续下一个）', async () => {
    const exists = saveGame('存在')
    const dispatcher = createDispatcher({ host })

    // 先删一个假的（模拟「选中集里有个陈旧 id」）
    await expect(
      dispatcher.dispatch('deleteGame', { id: '999' }, new AbortController().signal)
    ).rejects.toMatchObject({ translationKey: 'error.gameNotFound' })

    // 然后删真的，必须成功
    await expect(
      dispatcher.dispatch('deleteGame', { id: exists }, new AbortController().signal)
    ).resolves.toBeTruthy()
  })

  test('deleteGame 返回的 snapshot 立刻反映删除结果（不是下一次才更新）', async () => {
    const a = saveGame('A')
    const b = saveGame('B')
    const dispatcher = createDispatcher({ host })
    const snap = (await dispatcher.dispatch('deleteGame', { id: a }, new AbortController().signal)) as {
      games: Array<{ id: string }>
    }
    expect(snap.games.map((game) => game.id)).toEqual([b])
  })

  test('删光之后 snapshot 里 games / meta / playStats 三处都空', async () => {
    const ids = ['A', 'B'].map((title) => saveGame(title))
    for (const id of ids) fillSideData(id)
    const dispatcher = createDispatcher({ host })
    for (const id of ids) {
      await dispatcher.dispatch('deleteGame', { id }, new AbortController().signal)
    }
    const snap = dispatcher.snapshot() as {
      games: unknown[]
      meta: Record<string, unknown>
      playStats: Record<string, unknown>
    }
    expect(snap.games).toHaveLength(0)
    expect(Object.keys(snap.meta)).toHaveLength(0)
    expect(Object.keys(snap.playStats)).toHaveLength(0)
  })

  test('删除时**不碰引擎目录**（D31 精神：引擎是共享的，不是某个游戏的）', async () => {
    const id = saveGame('A')
    // 造一个假引擎目录
    const engineDir = path.join(dataDir, 'modules', 'nwjs')
    fs.mkdirSync(engineDir, { recursive: true })
    fs.writeFileSync(path.join(engineDir, 'manifest.json'), '{"name":"nwjs"}')

    const dispatcher = createDispatcher({ host })
    await dispatcher.dispatch('deleteGame', { id }, new AbortController().signal)

    expect(fs.existsSync(path.join(engineDir, 'manifest.json'))).toBe(true)
  })
})
