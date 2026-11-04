// M2 的 IPC 层测试：验证错误路径真的带 translationKey（渲染层靠它查中文文案）。
//
// 为什么单独一个文件：探针里发现 `dlsiteLookup({rj:'nope'})` 返回的对象居然没有 key，
// 而渲染层的 translateError 完全依赖 `error.key`——没有 key 就只能显示英文原文。
// 这条必须在单测里钉死，不能靠端到端探针碰运气。
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createCoreHost, resolveCorePath } from '../src/main/core-host'
import { OFF_QUEUE_METHODS, createDispatcher } from '../src/main/ipc'

/** 搜索结果结构（与 api/client.ts 的 DlsiteSearchHit 一致；测试不跨 tsconfig 工程引用渲染层类型）。 */
interface SearchHit {
  rj: string
  title: string
  category?: string
  coverUrl?: string
}

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

// ===== M2.5-B：可编辑元数据的 IPC 行为（§B.2）=====
//
// 这两条是 S3 的核心验收：**被编辑字段刷新不丢**。
// 用真 fixture 走 dlsiteLookup，让「新抓到的值」与「用户改过的值」真的不同。

const workFixture = readFileSync(path.join(__dirname, 'fixtures', 'dlsite', 'RJ294126.html'), 'utf8')

/** 造一个能返回作品页的 host（refreshGameMeta 会真的重新抓一次）。 */
function lookupHost(dir: string, body = workFixture) {
  return createCoreHost({
    dataDir: dir,
    corePath: resolveCorePath({ isPackaged: false, appPath: process.cwd() }),
    fetchImpl: (async () => new Response(body, { status: 200 })) as never
  })
}

describe('saveGameMeta 带 editedFields', () => {
  test('保存 editedFields 后 snapshot.meta 里能看到标记', async () => {
    host.store.saveGame({ game: { gameTitle: 'g', gamePath: '/g', gameEngine: 'mkxpz' } })
    const d = dispatcher()
    await d.dispatch(
      'saveGameMeta',
      {
        gameId: '1',
        work: { rj: 'RJ294126', title: '我自己改的标题', circle: 'DLsite 社团', fetchedAt: 'now' },
        editedFields: ['title']
      },
      new AbortController().signal
    )
    const snapshot = (await d.dispatch('snapshot', {}, new AbortController().signal)) as {
      meta: Record<string, { title: string; edited?: boolean; editedFields?: string[] }>
    }
    expect(snapshot.meta['1'].title).toBe('我自己改的标题')
    expect(snapshot.meta['1'].edited).toBe(true)
    expect(snapshot.meta['1'].editedFields).toEqual(['title'])
  })

  test('不传 editedFields 时不会误判成「被编辑过」', async () => {
    host.store.saveGame({ game: { gameTitle: 'g', gamePath: '/g', gameEngine: 'mkxpz' } })
    const d = dispatcher()
    await d.dispatch(
      'saveGameMeta',
      { gameId: '1', work: { rj: 'RJ294126', title: 'DLsite 标题' } },
      new AbortController().signal
    )
    const snapshot = (await d.dispatch('snapshot', {}, new AbortController().signal)) as {
      meta: Record<string, { edited?: boolean }>
    }
    expect(snapshot.meta['1'].edited).toBe(false)
  })
})

describe('refreshGameMeta 的合并规则（被编辑字段刷新不丢）', () => {
  test('用户改过的标题不被 DLsite 新值覆盖，其余字段照常更新', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tsmg-merge-btn-'))
    const host2 = lookupHost(dir)
    const d = createDispatcher({ host: host2 })
    host2.store.saveGame({ game: { gameTitle: 'g', gamePath: '/g', gameEngine: 'mkxpz' } })

    // ① 用户手动改标题（其余字段是 DLsite 真值）
    await d.dispatch(
      'saveGameMeta',
      {
        gameId: '1',
        work: {
          rj: 'RJ294126',
          title: '我自己改的标题',
          circle: '旧社团',
          registDate: '2020/08/30',
          fetchedAt: '2026-11-04T00:00:00.000Z'
        },
        editedFields: ['title']
      },
      new AbortController().signal
    )

    // ② 点「重新获取」→ 走 refreshGameMeta（内部真抓 fixture）
    await d.dispatch('refreshGameMeta', { gameId: '1' }, new AbortController().signal)

    const snapshot = (await d.dispatch('snapshot', {}, new AbortController().signal)) as {
      meta: Record<string, { title: string; circle?: string; editedFields?: string[]; edited?: boolean }>
    }
    // 标题保留用户的（这是 §B.2 的核心）
    expect(snapshot.meta['1'].title).toBe('我自己改的标题')
    // 社团没被编辑过 → 用 DLsite 的新值（fixture 里是 青春×フェティシズム）
    expect(snapshot.meta['1'].circle).toBe('青春×フェティシズム')
    expect(snapshot.meta['1'].edited).toBe(true)
    expect(snapshot.meta['1'].editedFields).toEqual(['title'])
    rmSync(dir, { recursive: true, force: true })
  })

  test('force:true（强制覆盖全部）→ 清空编辑标记，标题取回 DLsite 值', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'tsmg-merge-force-'))
    const host2 = lookupHost(dir)
    const d = createDispatcher({ host: host2 })
    host2.store.saveGame({ game: { gameTitle: 'g', gamePath: '/g', gameEngine: 'mkxpz' } })

    await d.dispatch(
      'saveGameMeta',
      { gameId: '1', work: { rj: 'RJ294126', title: '我自己改的标题' }, editedFields: ['title'] },
      new AbortController().signal
    )
    await d.dispatch('refreshGameMeta', { gameId: '1', force: true }, new AbortController().signal)

    const snapshot = (await d.dispatch('snapshot', {}, new AbortController().signal)) as {
      meta: Record<string, { title: string; edited?: boolean; editedFields?: string[] }>
    }
    expect(snapshot.meta['1'].title).toBe('純愛おま○こ当番【アップデート版】')
    expect(snapshot.meta['1'].edited).toBe(false)
    expect(snapshot.meta['1'].editedFields).toEqual([])
  })
  }, 30_000)

// ===== M2.5-A：dlsiteSearch =====

const searchFixture = readFileSync(
  path.join(__dirname, 'fixtures', 'dlsite', 'search-mercenary.html'),
  'utf8'
)

describe('dlsiteSearch（§A.1）', () => {
  test('空关键词 → error.dlsiteSearchEmpty（带 keyword 参数）', async () => {
    await expect(
      dispatcher().dispatch('dlsiteSearch', { keyword: '  ' }, new AbortController().signal)
    ).rejects.toMatchObject({
      translationKey: 'error.dlsiteSearchEmpty',
      translationArguments: { keyword: '' }
    })
  })

  test('假 fetch 全 404 → error.dlsiteSearchEmpty（不是 NotFound）', async () => {
    await expect(
      dispatcher().dispatch('dlsiteSearch', { keyword: '傭兵' }, new AbortController().signal)
    ).rejects.toMatchObject({ translationKey: 'error.dlsiteSearchEmpty' })
  })

  test('真结果页 → 返回候选列表，且不写 library-meta.json', async () => {
    // 换一个能返回真结果页的 host
    const dataDir2 = mkdtempSync(path.join(tmpdir(), 'tsmg-ipc-search-'))
    const host2 = createCoreHost({
      dataDir: dataDir2,
      corePath: resolveCorePath({ isPackaged: false, appPath: process.cwd() }),
      fetchImpl: (async () => new Response(searchFixture, { status: 200 })) as never
    })
    const result = (await createDispatcher({ host: host2 }).dispatch(
      'dlsiteSearch',
      { keyword: '傭兵' },
      new AbortController().signal
    )) as { keyword: string; results: SearchHit[] }
    expect(result.keyword).toBe('傭兵')
    expect(result.results).toHaveLength(5)
    expect(result.results[0].rj).toBe('RJ01699769')
    // 搜索是只读的：不落 library-meta.json
    expect(existsSync(path.join(dataDir2, 'library-meta.json'))).toBe(false)
    rmSync(dataDir2, { recursive: true, force: true })
  })

  test('搜索在 OFF_QUEUE_METHODS 里（只读且用户要等结果）', () => {
    expect(OFF_QUEUE_METHODS.has('dlsiteSearch')).toBe(true)
  })
})
