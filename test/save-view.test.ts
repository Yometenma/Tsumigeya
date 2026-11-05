// M4 S2：详情页「存档」区块的判据（src/shared/save-view.ts）。
//
// ===== 这个文件存在的理由 =====
//
// 用户可见的三种状态是：「不知道存档在哪」「位置找到了但还没存档」「有存档」。
// 前两种**长得一样**（都没东西可列），但意思完全不同：
//   · 第一种是故障 —— 用户该去排障
//   · 第二种是正常 —— 用户该去玩到存档点
//
// 糊成一句的后果不是崩溃，是**用户永远查不出问题**（他把故障当成"我还没玩到"）。
// 所以这三条分支必须有测试钉住，而不是只靠人眼看页面。
import { describe, expect, test } from 'vitest'
import { formatByteSize, isValidSaveTime, saveSectionView, type SaveListingLike } from '../src/shared/save-view'

const item = (name: string, size: number, mtime = '2026-11-05T10:00:00.000Z') => ({ name, size, mtime })

const listing = (patch: Partial<SaveListingLike>): SaveListingLike => ({
  location: { layout: 'nwjs-mv', relativeDir: 'www/save' },
  dir: "/games/Karryn's Prison/www/save",
  slots: [],
  configs: [],
  empty: true,
  ...patch
})

describe('★ 三种状态必须分开（本文件的主要目的）', () => {
  test('location=null → unknown（**不是** empty）', () => {
    const view = saveSectionView(listing({ location: null, dir: null }))
    expect(view.kind).toBe('unknown')
  })

  test('empty=true → empty（带目录，UI 要说"会出现在这里"）', () => {
    const view = saveSectionView(listing({ empty: true }))
    expect(view.kind).toBe('empty')
    if (view.kind === 'empty') expect(view.dir).toContain('www/save')
  })

  test('有槽 → list（并把槽与配置分开）', () => {
    const view = saveSectionView(
      listing({
        empty: false,
        slots: [item('file1.rpgsave', 2048), item('file2.rpgsave', 4096)],
        configs: [item('config.rpgsave', 128)]
      })
    )
    expect(view.kind).toBe('list')
    if (view.kind === 'list') {
      expect(view.slots.map((s) => s.name)).toEqual(['file1.rpgsave', 'file2.rpgsave'])
      expect(view.configs.map((s) => s.name)).toEqual(['config.rpgsave'])
      expect(view.hasConfigs).toBe(true)
    }
  })

  test('⚠️ location 有、dir 却是 null → 也当 unknown（半个结果不能拿去拼路径）', () => {
    // 主进程契约是两者同时为 null，但渲染层不该赌那个默契：
    // 只拿到 location 会让「在访达中显示」指向 undefined —— 点了没反应，用户不会报错。
    const view = saveSectionView(listing({ location: { layout: 'nwjs-mv' }, dir: null }))
    expect(view.kind).toBe('unknown')
  })

  test('listing 本身缺失（首次加载/请求失败）→ unknown，不抛错', () => {
    expect(saveSectionView(undefined).kind).toBe('unknown')
    expect(saveSectionView(null).kind).toBe('unknown')
  })

  test('empty=true 但 slots 非空 → 以 empty 为准（不混着画一个半截列表）', () => {
    // 主进程算 empty 的口径是「slots 长度为 0」，正常不会出现这种组合。
    // 真出现了说明两边口径漂了，此时**宁可显示空态**——画一个列表却又说"没有存档"更糟。
    const view = saveSectionView(listing({ empty: true, slots: [item('file1.rpgsave', 100)] }))
    expect(view.kind).toBe('empty')
  })
})

describe('没有配置项时不画「配置文件」小标题', () => {
  test('只有槽、没有配置 → hasConfigs=false', () => {
    const view = saveSectionView(listing({ empty: false, slots: [item('file1.rpgsave', 100)] }))
    expect(view.kind).toBe('list')
    if (view.kind === 'list') expect(view.hasConfigs).toBe(false)
  })

  test('RGSS 布局（configPattern 永不匹配）天然没有配置项', () => {
    const view = saveSectionView(
      listing({ location: { layout: 'rgss-data' }, slots: [item('Save1.rvdata2', 300)], configs: [] })
    )
    if (view.kind === 'list') expect(view.hasConfigs).toBe(false)
  })
})

describe('formatByteSize：列要能对齐，所以必须是确定性输出', () => {
  test('字节段的边界', () => {
    expect(formatByteSize(0)).toBe('0 B')
    expect(formatByteSize(1)).toBe('1 B')
    expect(formatByteSize(512)).toBe('512 B')
    expect(formatByteSize(1023)).toBe('1023 B')
  })

  test('KB 段（1024 进制，与访达一致）', () => {
    expect(formatByteSize(1024)).toBe('1 KB')
    expect(formatByteSize(2048)).toBe('2 KB')
    expect(formatByteSize(1536)).toBe('1.5 KB')
  })

  test('MB / GB 段', () => {
    expect(formatByteSize(1024 * 1024)).toBe('1 MB')
    expect(formatByteSize(3.4 * 1024 * 1024)).toBe('3.4 MB')
    expect(formatByteSize(1024 ** 3)).toBe('1 GB')
    expect(formatByteSize(5.5 * 1024 ** 3)).toBe('5.5 GB')
  })

  test('整数不带 .0（对齐用的噪音）', () => {
    expect(formatByteSize(1024)).toBe('1 KB')
    expect(formatByteSize(1024 * 1024)).toBe('1 MB')
  })

  test('坏数据（负数 / NaN / Infinity / undefined）一律 0 B', () => {
    // 画「NaN B」比画「0 B」更没有价值，且会让整列看起来像坏了
    expect(formatByteSize(-1)).toBe('0 B')
    expect(formatByteSize(Number.NaN)).toBe('0 B')
    expect(formatByteSize(Number.POSITIVE_INFINITY)).toBe('0 B')
    expect(formatByteSize(undefined)).toBe('0 B')
    expect(formatByteSize(null)).toBe('0 B')
  })

  test('⚠️ 不给超大值跳出 GB（不画成 12345.6 MB）', () => {
    expect(formatByteSize(1024 ** 4 * 3)).toBe('3072 GB')
  })
})

describe('isValidSaveTime：坏时间不能画出英文 Invalid Date', () => {
  test('ISO 串可用', () => {
    expect(isValidSaveTime('2026-11-05T10:00:00.000Z')).toBe(true)
  })

  test('空串 / 坏格式 / null 一律不可用', () => {
    expect(isValidSaveTime('')).toBe(false)
    expect(isValidSaveTime('not a date')).toBe(false)
    expect(isValidSaveTime(null)).toBe(false)
    expect(isValidSaveTime(undefined)).toBe(false)
  })

  test('list 形态里坏数据的项：timeValid=false（UI 据此不画时间）', () => {
    const view = saveSectionView(
      listing({ empty: false, slots: [{ name: 'file1.rpgsave', size: 100, mtime: '' }] })
    )
    if (view.kind === 'list') expect(view.slots[0]!.timeValid).toBe(false)
  })
})

describe('槽的顺序不在这一层重排（判据只有一份，在 shared/save-locate.ts）', () => {
  test('渲染层原样透传主进程给的顺序（自然序已在那里排过）', () => {
    // ⚠️ 这条钉的是"别在这里再排一次"：两处排序一旦口径不同，
    // 同一个目录在两个界面里顺序会不一样，用户会以为文件变了。
    const given = ['file10.rpgsave', 'file2.rpgsave', 'file1.rpgsave']
    const view = saveSectionView(listing({ empty: false, slots: given.map((n) => item(n, 10)) }))
    if (view.kind === 'list') expect(view.slots.map((s) => s.name)).toEqual(given)
  })
})

// ===== ★ 第四种态：位置找到了，但目录读不进来（2026-11-05 ssh 真机审查发现的 bug）=====
//
// 原来主进程把这种情况直接返回 `location: null`，于是 UI 说的是
// 「没找到存档位置（引擎还没识别出来）」—— 把用户引去查引擎识别，
// 而真正的问题是文件权限 / 目录被删。
//
// 这与本文件开篇反对的「三种没有存档被糊成一句」是同一类错误，只是漏了第四种。
describe('★ unreadable：知道在哪但读不了，不能糊成 unknown', () => {
  test('dirReadable=false → unreadable（不是 unknown，也不是 empty）', () => {
    const view = saveSectionView(
      listing({ dirReadable: false, empty: false, slots: [], configs: [] })
    )
    expect(view.kind).toBe('unreadable')
    // 必须带上目录：用户要能照着它去查权限
    if (view.kind === 'unreadable') expect(view.dir).toBeTruthy()
  })

  test('★ 顺序：dirReadable=false 必须在 empty 之前判（读不到时 slots 也是空）', () => {
    // 真实世界里读不到目录时 `empty` 也是 false（主进程那边 slots 空、empty 为 false），
    // 但如果哪天真主进程给了 empty:true，也不能让它盖住 unreadable ——
    // 否则用户看到「玩到存档点就有了」，而其实他是没权限。
    const view = saveSectionView(
      listing({ dirReadable: false, empty: true, slots: [], configs: [] })
    )
    expect(view.kind, 'dirReadable=false 被 empty 盖住了').toBe('unreadable')
  })

  test('dirReadable 缺省（undefined）= 正常，不影响其它三种', () => {
    expect(saveSectionView(listing({ empty: true, slots: [], configs: [] })).kind).toBe('empty')
    expect(saveSectionView(listing({ empty: false, slots: [item('f', 1)], configs: [] })).kind).toBe(
      'list'
    )
    expect(saveSectionView(null).kind).toBe('unknown')
  })

  test('location=null 且 dirReadable=false → 仍是 unknown（没位置就谈不上读不读）', () => {
    const view = saveSectionView(
      listing({ location: null, dir: null, dirReadable: false, empty: false, slots: [], configs: [] })
    )
    expect(view.kind).toBe('unknown')
  })
})
