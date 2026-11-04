// library-meta.json 单测（M2 §9）：不依赖网络、不依赖 GUI、不 import electron。
// 与 dlsite 缓存的策略差异是重点：**用户数据绝不静默覆盖**。
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createLibraryMetaStore, mergeWork } from '../src/main/library-meta'
import { writeJSON, readJSON } from '../src/main/games-store'
import type { DlsiteWork } from '../src/main/dlsite'

let dataDir: string
let store: ReturnType<typeof createLibraryMetaStore>

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'tsmg-meta-'))
  store = createLibraryMetaStore(dataDir)
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

function work(overrides: Partial<DlsiteWork> = {}): DlsiteWork {
  return {
    rj: 'RJ294126',
    title: '純愛おま○こ当番【アップデート版】',
    circle: '青春×フェティシズム',
    circleId: 'RG51931',
    coverUrl: 'https://img.dlsite.jp/modpub/images2/work/doujin/RJ295000/RJ294126_img_main.jpg',
    fetchedAt: '2026-11-04T00:00:00.000Z',
    ...overrides
  }
}

describe('基本读写', () => {
  test('文件不存在 → 空对象', () => {
    expect(store.load()).toEqual({})
  })

  test('save 后 load 能读回，且写入磁盘', () => {
    store.save('1', work())
    expect(store.load()['1'].title).toBe('純愛おま○こ当番【アップデート版】')
    expect(existsSync(store.metaFile)).toBe(true)
  })

  test('第二次写入产生 .bak', () => {
    store.save('1', work())
    expect(existsSync(`${store.metaFile}.bak`)).toBe(false)
    store.save('2', work({ rj: 'RJ111111' }))
    expect(existsSync(`${store.metaFile}.bak`)).toBe(true)
  })

  test('多个游戏互不影响', () => {
    store.save('1', work())
    store.save('2', work({ rj: 'RJ111111', title: '第二作' }))
    expect(Object.keys(store.load()).sort()).toEqual(['1', '2'])
    expect(store.load()['2'].title).toBe('第二作')
  })

  test('不残留 .tmp', () => {
    store.save('1', work())
    expect(readdirSync(dataDir).some((name) => name.endsWith('.tmp'))).toBe(false)
  })
})

// ===== M2.6 §4.1：sanitize 是落盘的**字段白名单** =====
//
// 端到端探针实测踩到过：S1 在 dlsite.ts 里解析出了 summary/author/salesCount/rating，
// 但 saveGameMeta 回执的 keys 里根本没有它们——因为这一层只挑自己认识的字段，
// 新字段不写进来就被**静默丢弃**（界面表现：明明解析到了，详情页全是「暂无」）。
describe('M2.6 新增字段必须能落盘（字段白名单回归）', () => {
  function workWithM26(overrides: Partial<DlsiteWork> = {}): DlsiteWork {
    return work({
      summary: '本作は、隣の部屋に住む…（已清洗）',
      author: 'Tonda',
      salesCount: 739,
      rating: 4.5,
      workType: 'MNG',
      ...overrides
    })
  }

  test('summary / author / salesCount / rating 全部写进磁盘并能读回', () => {
    store.save('1', workWithM26())
    const saved = store.load()['1']
    expect(saved.summary).toBe('本作は、隣の部屋に住む…（已清洗）')
    expect(saved.author).toBe('Tonda')
    expect(saved.salesCount).toBe(739)
    expect(saved.rating).toBe(4.5)
  })

  test('重新读文件（不是读内存）也还在——确认真的落了盘', () => {
    store.save('1', workWithM26())
    const onDisk = JSON.parse(readFileSync(store.metaFile, 'utf8'))
    expect(onDisk['1'].summary).toBeTruthy()
    expect(onDisk['1'].author).toBe('Tonda')
    expect(onDisk['1'].salesCount).toBe(739)
    expect(onDisk['1'].rating).toBe(4.5)
  })

  test('缺失时是 undefined，不是 0 / 空串（rating 缺省 ≠ 0 分）', () => {
    store.save('1', work())
    const saved = store.load()['1']
    expect(saved.summary).toBeUndefined()
    expect(saved.author).toBeUndefined()
    expect(saved.salesCount).toBeUndefined()
    expect(saved.rating).toBeUndefined()
  })

  test('salesCount = 0 是合法值，不能被当成「没有」丢掉', () => {
    store.save('1', workWithM26({ salesCount: 0 }))
    expect(store.load()['1'].salesCount).toBe(0)
  })

  test('rating = 0 / 非法值被清洗掉（0 分不是 DLsite 的真实状态）', () => {
    // num() 只校验"是不是有限数字"，0 会被保留——所以这里锁的是「非数字被丢」
    store.save('1', workWithM26({ rating: Number.NaN }))
    expect(store.load()['1'].rating).toBeUndefined()
    store.save('2', workWithM26({ salesCount: '739' as never }))
    expect(store.load()['2'].salesCount).toBeUndefined()
  })

  test('纯空白的 summary / author 归 undefined（不写空串进库）', () => {
    store.save('1', workWithM26({ summary: '   ', author: '  ' }))
    const saved = store.load()['1']
    expect(saved.summary).toBeUndefined()
    expect(saved.author).toBeUndefined()
  })

  test('mergeWork 刷新时保留只有搜索页才有的字段（author / salesCount / rating）', () => {
    store.save('1', workWithM26())
    // 模拟一次「重新获取」：DLsite **详情页**没有 author/salesCount/rating（只有搜索页有，§3.1），
    // 所以 incoming 缺这三项；但用户库里已有的值不该被抹掉。
    const merged = mergeWork(workWithM26(), {
      rj: 'RJ294126',
      title: '純愛おま○こ当番【アップデート版】',
      circle: '青春×フェティシズム',
      // summary 来自详情页（cleanupDescription 产出），刷新当然能拿到新值 → 应该被覆盖
      summary: '新的简介（这次刷新拿到的）',
      fetchedAt: '2026-11-05T00:00:00.000Z'
    })
    expect(merged.author).toBe('Tonda')
    expect(merged.salesCount).toBe(739)
    expect(merged.rating).toBe(4.5)
    // summary 不是搜索页专有字段：详情页拿得到，所以刷新值覆盖旧值
    expect(merged.summary).toBe('新的简介（这次刷新拿到的）')
    // 真正的「刷新值」应该覆盖非编辑字段
    expect(merged.fetchedAt).toBe('2026-11-05T00:00:00.000Z')
  })

  test('incoming 带了搜索页字段时用新值（不被旧值挡住）', () => {
    store.save('1', workWithM26())
    const merged = mergeWork(workWithM26(), workWithM26({ author: '新作者', salesCount: 9999, rating: 5 }))
    expect(merged.author).toBe('新作者')
    expect(merged.salesCount).toBe(9999)
    expect(merged.rating).toBe(5)
  })

  test('previous 没有这些字段时，incoming 缺也就保持 undefined（不会凭空造值）', () => {
    const merged = mergeWork(work() as never, work())
    expect(merged.author).toBeUndefined()
    expect(merged.salesCount).toBeUndefined()
    expect(merged.rating).toBeUndefined()
  })
})

describe('校验与清洗', () => {
  test('空 / 非法 gameId → error.dlsiteGameRequired', () => {
    expect(() => store.save('', work())).toThrow(
      expect.objectContaining({ translationKey: 'error.dlsiteGameRequired' })
    )
    for (const id of ['../evil', 'a/b', 'a\\b', '..']) {
      expect(() => store.save(id, work())).toThrow(
        expect.objectContaining({ translationKey: 'error.invalidComponent' })
      )
    }
  })

  test('缺 rj → error.dlsiteInvalidRj', () => {
    expect(() => store.save('1', { title: 'x' } as never)).toThrow(
      expect.objectContaining({ translationKey: 'error.dlsiteInvalidRj' })
    )
  })

  test('非对象 → error.dlsiteParse', () => {
    expect(() => store.save('1', [] as never)).toThrow(
      expect.objectContaining({ translationKey: 'error.dlsiteParse' })
    )
    expect(() => store.save('1', 'text' as never)).toThrow(
      expect.objectContaining({ translationKey: 'error.dlsiteParse' })
    )
  })

  test('未知字段不会写进库里（只保留白名单字段）', () => {
    store.save('1', { ...work(), evil: '<script>', nested: { a: 1 } } as never)
    const onDisk = JSON.parse(readFileSync(store.metaFile, 'utf8')) as Record<string, Record<string, unknown>>
    expect(onDisk['1']).not.toHaveProperty('evil')
    expect(onDisk['1']).not.toHaveProperty('nested')
  })

  test('类型不对的字段被丢弃（数值写成字符串不会被污染）', () => {
    store.save('1', { ...work(), price: '750' } as never)
    expect(store.load()['1'].price).toBeUndefined()
  })
})

describe('删除', () => {
  test('remove 删掉条目并落盘', () => {
    store.save('1', work())
    store.remove('1')
    expect(store.load()).toEqual({})
  })

  test('删除不存在的条目算成功（删游戏时顺手清，不该报错）', () => {
    expect(() => store.remove('99')).not.toThrow()
    expect(store.load()).toEqual({})
  })

  test('文件不存在时 remove 也不报错', () => {
    expect(() => store.remove('1')).not.toThrow()
  })
})

describe('损坏文件（用户数据绝不静默覆盖）', () => {
  test('损坏的 library-meta.json → writeJSON 抛错且原文件不变', () => {
    const corrupt = '{ this is not json'
    writeFileSync(store.metaFile, corrupt, 'utf8')
    expect(() => store.save('1', work())).toThrow()
    expect(readFileSync(store.metaFile, 'utf8')).toBe(corrupt)
    expect(existsSync(`${store.metaFile}.bak`)).toBe(false)
  })

  test('JSON 是数组 → load 抛 error.invalidObject', () => {
    writeFileSync(store.metaFile, '[1,2,3]', 'utf8')
    expect(() => store.load()).toThrow(expect.objectContaining({ translationKey: 'error.invalidObject' }))
  })

  test('readJSON 与 writeJSON 的复用是同一套规则（间接验证）', () => {
    writeJSON(store.metaFile, { '1': work() })
    expect(Object.keys(readJSON(store.metaFile))).toEqual(['1'])
  })
})

// ===== M2.5-B：可编辑元数据（§B）=====

describe('editedFields 契约（§B.1）', () => {
  test('保存带 editedFields → 读回一致，edited 自动为 true', () => {
    store.save('1', work(), ['title', 'circle'])
    const saved = store.load()['1']
    expect(saved.editedFields).toEqual(['title', 'circle'])
    expect(saved.edited).toBe(true)
  })

  test('不传 editedFields → edited 为 false（纯抓取数据不是「被编辑过」）', () => {
    store.save('1', work())
    expect(store.load()['1'].edited).toBe(false)
    expect(store.load()['1'].editedFields).toEqual([])
  })

  test('未知字段名被丢弃（不能让库被奇怪的键撑变形）', () => {
    store.save('1', work(), ['title', 'rj', 'evil', 'description'] as never)
    // rj 不在可编辑白名单里；description 第一版不给编辑（§B.3 只做 5 个）
    expect(store.load()['1'].editedFields).toEqual(['title'])
  })

  test('editedFields 会与已有标记取并集（改社团不丢标题的编辑标记）', () => {
    store.save('1', work(), ['title'])
    store.save('1', work({ circle: '新社团' }), ['circle'])
    // 标题仍是「被编辑过」的，否则下次刷新会把用户的标题冲回 DLsite 值
    // 顺序固定为白名单顺序（title 在 circle 前面），不随用户操作顺序抖动
    expect(store.load()['1'].editedFields).toEqual(['title', 'circle'])
  })

  test('传空数组 → 清空所有编辑标记（「强制覆盖全部」）', () => {
    store.save('1', work(), ['title', 'circle'])
    store.save('1', work(), [])
    expect(store.load()['1'].editedFields).toEqual([])
    expect(store.load()['1'].edited).toBe(false)
  })

  test('旧格式条目（没有 edited/editedFields）读回不报错', () => {
    // 模拟 M2 时期写下的文件
    writeJSON(store.metaFile, { '1': work() })
    const loaded = store.load()['1']
    expect(loaded.title).toBe('純愛おま○こ当番【アップデート版】')
    // 向后兼容：直接读出来的旧条目就是没有这两个键
    expect(Object.keys(loaded)).not.toContain('edited')
  })

  test('旧格式条目再保存一次后长出 edited 字段（且不误判为被编辑过）', () => {
    writeJSON(store.metaFile, { '1': work() })
    store.save('1', store.load()['1'])
    expect(store.load()['1'].edited).toBe(false)
    expect(store.load()['1'].editedFields).toEqual([])
  })

  test('外部塞 edited:true 但没给 editedFields → 仍然不是「被编辑过」', () => {
    store.save('1', { ...work(), edited: true } as never)
    expect(store.load()['1'].edited).toBe(false)
  })
})

describe('coverUrl 走主机白名单（D22）', () => {
  test('img.dlsite.jp 的地址保留', () => {
    store.save('1', work({ coverUrl: 'https://img.dlsite.jp/a.jpg' }))
    expect(store.load()['1'].coverUrl).toBe('https://img.dlsite.jp/a.jpg')
  })

  test('用户手填的站外地址被丢弃（和自动抓取同一套规则）', () => {
    store.save('1', work({ coverUrl: 'https://evil.example.com/x.jpg' }))
    expect(store.load()['1'].coverUrl).toBeUndefined()
    store.save('2', work({ rj: 'RJ111111', coverUrl: 'javascript:alert(1)' }))
    expect(store.load()['2'].coverUrl).toBeUndefined()
  })
})

describe('mergeWork（§B.2 覆盖规则）', () => {
  const base = work()
  const incoming = work({
    title: 'DLsite 上的新标题',
    circle: 'DLsite 上的新社团',
    registDate: '2021/01/01',
    price: 999,
    fetchedAt: '2026-11-05T00:00:00.000Z'
  })

  test('没有被编辑的字段 → 全部用新抓到的值', () => {
    const merged = mergeWork(base, incoming)
    expect(merged.title).toBe('DLsite 上的新标题')
    expect(merged.circle).toBe('DLsite 上的新社团')
    expect(merged.registDate).toBe('2021/01/01')
    expect(merged.price).toBe(999)
  })

  test('被编辑的字保留用户的值，其余字段更新', () => {
    const previous = { ...base, title: '我自己改的标题', editedFields: ['title'] as const }
    const merged = mergeWork(previous as never, incoming)
    expect(merged.title).toBe('我自己改的标题') // 不被覆盖
    expect(merged.circle).toBe('DLsite 上的新社团') // 其余更新
    expect(merged.registDate).toBe('2021/01/01')
    expect(merged.editedFields).toEqual(['title'])
    expect(merged.edited).toBe(true)
  })

  test('多个被编辑字段都不覆盖', () => {
    const previous = {
      ...base,
      title: '我的标题',
      circle: '我的社团',
      price: 100,
      editedFields: ['title', 'circle', 'price'] as const
    }
    const merged = mergeWork(previous as never, incoming)
    expect(merged.title).toBe('我的标题')
    expect(merged.circle).toBe('我的社团')
    expect(merged.price).toBe(100)
    expect(merged.registDate).toBe('2021/01/01') // 没编辑过的照常更新
  })

  test('重置某字段后（不在 editedFields 里）下次刷新能取回 DLsite 值', () => {
    const previous = { ...base, title: '我的标题', editedFields: ['title'] as const }
    // 用户点「重置此字段」→ 从 editedFields 移除
    const afterReset = { ...previous, editedFields: [] as const }
    const merged = mergeWork(afterReset as never, incoming)
    expect(merged.title).toBe('DLsite 上的新标题')
    expect(merged.editedFields).toEqual([])
    expect(merged.edited).toBe(false)
  })

  test('fetchedAt 总是用新数据的时间（它代表最后一次成功抓取，不是用户编辑）', () => {
    const previous = { ...base, editedFields: ['title'] as const }
    expect(mergeWork(previous as never, incoming).fetchedAt).toBe('2026-11-05T00:00:00.000Z')
  })

  test('editedFields 输出顺序稳定（按白名单顺序，不随输入乱序抖动）', () => {
    const previous = { ...base, editedFields: ['price', 'title'] as const }
    const merged = mergeWork(previous as never, incoming)
    expect(merged.editedFields).toEqual(['title', 'price'])
  })
})
