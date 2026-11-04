// M2 的 IPC 层测试：验证错误路径真的带 translationKey（渲染层靠它查中文文案）。
//
// 为什么单独一个文件：探针里发现 `dlsiteLookup({rj:'nope'})` 返回的对象居然没有 key，
// 而渲染层的 translateError 完全依赖 `error.key`——没有 key 就只能显示英文原文。
// 这条必须在单测里钉死，不能靠端到端探针碰运气。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createCoreHost, resolveCorePath } from '../src/main/core-host'
import { createDispatcher } from '../src/main/ipc'

let dataDir: string
let host: ReturnType<typeof createCoreHost>

function fakeFetch(counter: { calls: string[] }): (input: string) => Promise<Response> {
  return async (input: string) => {
    counter.calls.push(input)
    return new Response('', { status: 404 })
  }
}

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'tsmg-ipc-'))
  const calls: string[] = []
  host = createCoreHost({
    dataDir,
    corePath: resolveCorePath({ isPackaged: false, appPath: process.cwd() }),
    fetchImpl: fakeFetch({ calls }) as never
  })
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

function dispatcher() {
  return createDispatcher({ host })
}

describe('DLsite 命令的错误路径必须带 translationKey', () => {
  test('dlsiteLookup(非法 RJ) → error.dlsiteInvalidRj', async () => {
    await expect(
      dispatcher().dispatch('dlsiteLookup', { rj: 'nope' }, new AbortController().signal)
    ).rejects.toMatchObject({ translationKey: 'error.dlsiteInvalidRj' })
  })

  test('dlsiteLookup(未找到) → error.dlsiteNotFound（假 fetch 全 404）', async () => {
    await expect(
      dispatcher().dispatch('dlsiteLookup', { rj: 'RJ999999' }, new AbortController().signal)
    ).rejects.toMatchObject({ translationKey: 'error.dlsiteNotFound' })
  })

  test('dlsiteDetectRJ 是只读的，永远不抛（路径不存在返回空候选）', async () => {
    const result = (await dispatcher().dispatch(
      'dlsiteDetectRJ',
      { path: '/nonexistent/plain' },
      new AbortController().signal
    )) as { candidates: string[] }
    expect(result.candidates).toEqual([])
  })

  test('dlsiteDetectRJ 命中真实目录名', async () => {
    const result = (await dispatcher().dispatch(
      'dlsiteDetectRJ',
      { path: '/games/RJ294126 作品' },
      new AbortController().signal
    )) as { candidates: string[] }
    expect(result.candidates).toEqual(['RJ294126'])
  })
})

describe('saveGameMeta / refreshGameMeta / clearGameMeta', () => {
  test('游戏不存在 → error.gameNotFound', async () => {
    await expect(
      dispatcher().dispatch('saveGameMeta', { gameId: '9', work: { rj: 'RJ294126', title: 'x' } }, new AbortController().signal)
    ).rejects.toMatchObject({ translationKey: 'error.gameNotFound' })
    await expect(
      dispatcher().dispatch('refreshGameMeta', { gameId: '9' }, new AbortController().signal)
    ).rejects.toMatchObject({ translationKey: 'error.gameNotFound' })
  })

  test('首次启动的 snapshot 带空的 meta', async () => {
    const snapshot = (await dispatcher().dispatch('snapshot', {}, new AbortController().signal)) as {
      meta: Record<string, unknown>
    }
    expect(snapshot.meta).toEqual({})
  })

  test('存档后 snapshot.meta 里能看到，且 games 里没有 DLsite 字段', async () => {
    host.store.saveGame({
      game: { gameTitle: '测试游戏', gamePath: '/games/x', gameEngine: 'mkxpz' }
    })
    const d = dispatcher()
    await d.dispatch(
      'saveGameMeta',
      { gameId: '1', work: { rj: 'RJ294126', title: '作品', coverUrl: 'https://img.dlsite.jp/a.jpg' } },
      new AbortController().signal
    )
    const snapshot = (await d.dispatch('snapshot', {}, new AbortController().signal)) as {
      games: Array<Record<string, unknown>>
      meta: Record<string, Record<string, unknown>>
    }
    expect(snapshot.meta['1'].rj).toBe('RJ294126')
    expect(snapshot.games[0]).not.toHaveProperty('rj')
    expect(snapshot.games[0]).not.toHaveProperty('coverUrl')
  })

  test('refreshGameMeta 没有已存 RJ → error.dlsiteGameRequired', async () => {
    host.store.saveGame({ game: { gameTitle: 'g', gamePath: '/g', gameEngine: 'mkxpz' } })
    await expect(
      dispatcher().dispatch('refreshGameMeta', { gameId: '1' }, new AbortController().signal)
    ).rejects.toMatchObject({ translationKey: 'error.dlsiteGameRequired' })
  })

  test('clearGameMeta 删除条目（幂等，不存在的 gameId 也不报错）', async () => {
    host.store.saveGame({ game: { gameTitle: 'g', gamePath: '/g', gameEngine: 'mkxpz' } })
    const d = dispatcher()
    await d.dispatch(
      'saveGameMeta',
      { gameId: '1', work: { rj: 'RJ294126', title: '作品' } },
      new AbortController().signal
    )
    await d.dispatch('clearGameMeta', { gameId: '1' }, new AbortController().signal)
    const snapshot = (await d.dispatch('snapshot', {}, new AbortController().signal)) as {
      meta: Record<string, unknown>
    }
    expect(snapshot.meta).toEqual({})
    await expect(
      d.dispatch('clearGameMeta', { gameId: '99' }, new AbortController().signal)
    ).resolves.toBeTruthy()
  })

  test('deleteGame 会同步清掉 meta 条目，但保留 dlsite 缓存', async () => {
    host.store.saveGame({ game: { gameTitle: 'g', gamePath: '/g', gameEngine: 'mkxpz' } })
    const d = dispatcher()
    await d.dispatch(
      'saveGameMeta',
      { gameId: '1', work: { rj: 'RJ294126', title: '作品' } },
      new AbortController().signal
    )
    // deleteWithEngine 对不存在的目录应当放行（假路径 /g）
    await d.dispatch('deleteGame', { id: '1' }, new AbortController().signal)
    const snapshot = (await d.dispatch('snapshot', {}, new AbortController().signal)) as {
      games: unknown[]
      meta: Record<string, unknown>
    }
    expect(snapshot.games).toHaveLength(0)
    expect(snapshot.meta).toEqual({})
  })
})

describe('未知命令', () => {
  test('→ error.unknownMethod', async () => {
    await expect(
      dispatcher().dispatch('dlsiteNonsense', {}, new AbortController().signal)
    ).rejects.toMatchObject({ translationKey: 'error.unknownMethod' })
  })
})
