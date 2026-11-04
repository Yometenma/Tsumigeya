// M5.0 S2（U3 + U4）单测：库页筛选的判据（src/shared/library-filter.ts）。
//
// ===== 为什么这轮必须有测试 =====
//
// 这一轮改的是**语义反转**，而不是加个按钮：
//   onlyWithMeta（只看**有**封面的）  →  onlyUnbound（只看**未**绑定的）
//
// 判据正好相反，而「筛出来的是另一批游戏」**不会报任何错**：
// 界面安静地少了几张卡，用户只会觉得"筛选坏了"，我们这边测试全绿。
// 这类改反了还能上线的东西，必须靠单测钉住。
//
// 另一个必踩点：`isBoundMeta` 不能只看「meta 里有没有这个键」。
// `saveGameMeta` 写盘前过 sanitize（要求 rj 非空），但从磁盘 load() **不过 sanitize**
// （readJSON 原样返回）—— 手改过的 library-meta.json 里可能躺着 `{"1": {}}`。
// 只看键存在的话，这种空条目会被当成"已绑定"而从待办清单里消失。
import { describe, expect, test } from 'vitest'
import {
  filterGames,
  isBoundMeta,
  matchGame,
  unboundCount,
  type FilterableGame,
  type FilterableMeta
} from '../src/shared/library-filter'

const NO_FILTER = { keyword: '', onlyUnbound: false }

function game(id: string, title: string, tags?: string[]): FilterableGame {
  return tags ? { id, gameTitle: title, tags } : { id, gameTitle: title }
}

describe('isBoundMeta：什么算「已绑定 DLsite 商品」', () => {
  test('没有条目 = 未绑定', () => {
    expect(isBoundMeta(undefined)).toBe(false)
    expect(isBoundMeta(null)).toBe(false)
  })

  test('有 rj = 已绑定', () => {
    expect(isBoundMeta({ rj: 'RJ01012345', title: 'とある作品' })).toBe(true)
  })

  test('⚠️ 空条目（只有键、没有 rj）= 未绑定', () => {
    // 这是本测试的重点：键存在不等于绑定了。
    // 磁盘上的 library-meta.json 是用户可手改的，load() 不过 sanitize。
    expect(isBoundMeta({} as FilterableMeta)).toBe(false)
    expect(isBoundMeta({ title: '手写的标题' })).toBe(false)
  })

  test('rj 是空白字符串 = 未绑定（trim 后为空不算数）', () => {
    expect(isBoundMeta({ rj: '' })).toBe(false)
    expect(isBoundMeta({ rj: '   ' })).toBe(false)
  })

  test('rj 前后有空格也能正确判为已绑定（脏数据不该漏进待办清单）', () => {
    expect(isBoundMeta({ rj: ' RJ01012345 ' })).toBe(true)
  })
})

describe('matchGame：搜索', () => {
  test('空关键词放行', () => {
    expect(matchGame(game('1', 'テスト'), undefined, NO_FILTER)).toBe(true)
  })

  test('本地标题命中（大小写不敏感）', () => {
    expect(matchGame(game('1', 'RPG Maker'), undefined, { keyword: 'rpg', onlyUnbound: false })).toBe(true)
  })

  test('本地标签命中', () => {
    expect(matchGame(game('1', '标题', ['中文']), undefined, { keyword: '中', onlyUnbound: false })).toBe(true)
  })

  test('DLsite 日文原名命中也算（用户库里存的是译名，想搜原名就靠这条）', () => {
    const meta: FilterableMeta = { rj: 'RJ1', title: '傭兵の冒険' }
    expect(matchGame(game('1', '佣兵冒险'), meta, { keyword: '傭兵', onlyUnbound: false })).toBe(true)
  })

  test('社团名命中', () => {
    const meta: FilterableMeta = { rj: 'RJ1', circle: 'さくら工房' }
    expect(matchGame(game('1', '某游戏'), meta, { keyword: 'さくら', onlyUnbound: false })).toBe(true)
  })

  test('RJ 号命中', () => {
    const meta: FilterableMeta = { rj: 'RJ01012345' }
    expect(matchGame(game('1', '某游戏'), meta, { keyword: 'rj01012', onlyUnbound: false })).toBe(true)
  })

  test('全都不命中就排除', () => {
    expect(matchGame(game('1', '完全无关'), undefined, { keyword: 'xyz', onlyUnbound: false })).toBe(false)
  })
})

describe('matchGame：只看未绑定（U4 的核心语义反转）', () => {
  test('未绑定 + 勾选 → 留下', () => {
    expect(matchGame(game('1', '某游戏'), undefined, { keyword: '', onlyUnbound: true })).toBe(true)
  })

  test('已绑定 + 勾选 → 筛掉', () => {
    const meta: FilterableMeta = { rj: 'RJ01012345' }
    expect(matchGame(game('1', '某游戏'), meta, { keyword: '', onlyUnbound: true })).toBe(false)
  })

  test('⚠️ 空条目 + 勾选 → 仍然留下（不能因为键存在就当成已绑定）', () => {
    // 这条与上一组的「有 rj = 已绑定」是同一判据的两面，这里再从筛选侧钉一遍：
    // 否则「键存在即已绑定」这种错误实现能通过上一组测试、却漏掉真待办。
    expect(matchGame(game('1', '某游戏'), {} as FilterableMeta, { keyword: '', onlyUnbound: true })).toBe(true)
  })

  test('未勾选时不筛（已绑定/未绑定都留下）', () => {
    const meta: FilterableMeta = { rj: 'RJ1' }
    expect(matchGame(game('1', '某游戏'), meta, NO_FILTER)).toBe(true)
    expect(matchGame(game('2', '另一个'), undefined, NO_FILTER)).toBe(true)
  })
})

describe('filterGames：组合条件', () => {
  const games: FilterableGame[] = [game('1', 'A 游戏'), game('2', 'B 游戏', ['中文']), game('3', 'C 游戏')]
  const metaIndex: Record<string, FilterableMeta | undefined> = {
    '1': { rj: 'RJ1', title: 'A' },
    '2': undefined,
    '3': {} // 空条目 = 未绑定
  }

  test('只看未绑定 → 恰好是 2 和 3', () => {
    expect(filterGames(games, metaIndex, { keyword: '', onlyUnbound: true }).map((g) => g.id)).toEqual(['2', '3'])
  })

  test('未绑定 + 关键词按标签 → 只剩 2', () => {
    expect(filterGames(games, metaIndex, { keyword: '中文', onlyUnbound: true }).map((g) => g.id)).toEqual(['2'])
  })

  test('已绑定的游戏用 RJ 也能搜到（筛选与搜索互不干扰）', () => {
    expect(filterGames(games, metaIndex, { keyword: 'RJ1', onlyUnbound: false }).map((g) => g.id)).toEqual(['1'])
  })

  test('结果保序（不排序，排序是别的模块的事）', () => {
    expect(filterGames(games, metaIndex, NO_FILTER).map((g) => g.id)).toEqual(['1', '2', '3'])
  })

  test('空库 → 空结果', () => {
    expect(filterGames([], {}, { keyword: '', onlyUnbound: true })).toEqual([])
  })
})

describe('unboundCount：工具栏上的待办规模', () => {
  test('与 filterGames(onlyUnbound) 的长度恒等（两处判据必须一致）', () => {
    const games: FilterableGame[] = [game('1', 'A'), game('2', 'B'), game('3', 'C'), game('4', 'D')]
    const metaIndex: Record<string, FilterableMeta | undefined> = {
      '1': { rj: 'RJ1' },
      '2': undefined,
      '3': {},
      '4': { rj: '' }
    }
    expect(unboundCount(games, metaIndex)).toBe(3)
    expect(filterGames(games, metaIndex, { keyword: '', onlyUnbound: true }).length).toBe(3)
  })

  test('全部已绑定 → 0', () => {
    const games = [game('1', 'A'), game('2', 'B')]
    expect(unboundCount(games, { '1': { rj: 'RJ1' }, '2': { rj: 'RJ2' } })).toBe(0)
  })

  test('全部未绑定 → 总数', () => {
    expect(unboundCount([game('1', 'A'), game('2', 'B')], {})).toBe(2)
  })
})
