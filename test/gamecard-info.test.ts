// M2.6 §6：卡片 / 详情页的信息降级单测（不依赖 vue / pinia / GUI）。
//
// 为什么这些断言值得写：这一段全是「有就显示、没有就不能留空白」的降级判断，
// 画错了不会报错、只会让界面看起来「缺一块」，靠端到端探针很难发现。
// 把取值逻辑抽成 src/shared/gamecard-info.ts 就是为了让它能被单测钉死。
import { describe, expect, test } from 'vitest'
import {
  buildCardInfo,
  buildDetailFields,
  canRefreshMeta,
  formatPrice,
  formatRating,
  formatSales,
  summaryNeedsCollapse,
  workTypeI18nSuffix
} from '../src/shared/gamecard-info'

const fullMeta = {
  rj: 'RJ294126',
  circle: '青春×フェティシズム',
  seriesName: 'おま○こ当番',
  workType: 'SOU',
  registDate: '2020/08/30',
  price: 750,
  priceWithTax: 1650,
  summary: '本作は、隣の部屋に住む…',
  author: 'Tonda',
  salesCount: 739,
  rating: 4.5,
  category: 'maniax'
}

describe('buildCardInfo 的降级（§5.1）', () => {
  test('元数据齐全 → 各项都有值', () => {
    const info = buildCardInfo({
      gameTitle: '傭兵の冒険',
      gameEngine: 'RPG Maker VX Ace',
      meta: fullMeta
    })
    expect(info.title).toBe('傭兵の冒険')
    expect(info.subtitle).toBe('青春×フェティシズム')
    expect(info.hasCircle).toBe(true)
    expect(info.releasedAt).toBe('2020/08/30')
    expect(info.summary).toBe('本作は、隣の部屋に住む…')
    expect(info.workType).toBe('SOU')
  })

  test('没有社团 → 副标题退回引擎名（沿用 M2 行为），hasCircle=false', () => {
    const info = buildCardInfo({
      gameTitle: 'Game',
      gameEngine: 'RPG Maker MV',
      meta: { ...fullMeta, circle: undefined }
    })
    expect(info.subtitle).toBe('RPG Maker MV')
    expect(info.hasCircle).toBe(false)
  })

  test('社团是纯空白 → 同样退回引擎名（不当成有内容）', () => {
    const info = buildCardInfo({
      gameTitle: 'Game',
      gameEngine: 'RPG Maker MV',
      meta: { ...fullMeta, circle: '   ' }
    })
    expect(info.subtitle).toBe('RPG Maker MV')
    expect(info.hasCircle).toBe(false)
  })

  test('完全没有元数据（还没抓过 DLsite）→ 简介/发售日/类型都是 undefined', () => {
    const info = buildCardInfo({ gameTitle: 'Game', gameEngine: 'RPG Maker MV' })
    expect(info.subtitle).toBe('RPG Maker MV')
    expect(info.releasedAt).toBeUndefined()
    expect(info.summary).toBeUndefined()
    expect(info.workType).toBeUndefined()
  })

  test('无简介 → summary undefined（卡片不画那一行，不留空白）', () => {
    const info = buildCardInfo({
      gameTitle: 'Game',
      gameEngine: 'MV',
      meta: { ...fullMeta, summary: undefined }
    })
    expect(info.summary).toBeUndefined()
  })

  test('简介是纯空白 → 也算没有', () => {
    const info = buildCardInfo({ gameTitle: 'Game', gameEngine: 'MV', meta: { ...fullMeta, summary: '  \n ' } })
    expect(info.summary).toBeUndefined()
  })

  test('作品类型代码统一大写（页面偶尔给小写）', () => {
    const info = buildCardInfo({ gameTitle: 'G', gameEngine: 'MV', meta: { ...fullMeta, workType: 'sou' } })
    expect(info.workType).toBe('SOU')
  })

  test('语言标记与「也有 xx 版」缺失时是 undefined（不瞎标）', () => {
    const info = buildCardInfo({ gameTitle: 'G', gameEngine: 'MV', meta: fullMeta })
    expect(info.languageLabel).toBeUndefined()
    expect(info.alternateLabel).toBeUndefined()
  })

  test('语言标记与「也有 xx 版」有值就透传', () => {
    const info = buildCardInfo({
      gameTitle: 'G',
      gameEngine: 'MV',
      languageLabel: '中文',
      alternateLabel: '日文'
    })
    expect(info.languageLabel).toBe('中文')
    expect(info.alternateLabel).toBe('日文')
  })

  test('卡片绝不把 description（带站点广告尾巴）当简介用', () => {
    // 传进去只有 description、没有 summary → 简介必须是 undefined
    const meta = { ...fullMeta, summary: undefined, description: '正文。「DLsite 同人 - R18」は…' }
    const info = buildCardInfo({ gameTitle: 'G', gameEngine: 'MV', meta })
    expect(info.summary).toBeUndefined()
  })

  test('空标题 → 空串（不返回 undefined 让模板炸）', () => {
    const info = buildCardInfo({ gameTitle: '   ', gameEngine: 'MV' })
    expect(info.title).toBe('')
  })
})

describe('formatPrice（§5.2 价格）', () => {
  test('优先含税价（用户实际要付的钱）', () => {
    expect(formatPrice({ price: 750, priceWithTax: 1650 })).toBe('1650')
  })

  test('只有不含税价 → 用它', () => {
    expect(formatPrice({ price: 750 })).toBe('750')
  })

  test('都没有 → undefined（不是「0 日元」，0 元是免费作品的语义）', () => {
    expect(formatPrice({})).toBeUndefined()
    expect(formatPrice(undefined)).toBeUndefined()
    expect(formatPrice(null)).toBeUndefined()
  })

  test('0 / 负数 / 非有限数 → undefined', () => {
    expect(formatPrice({ priceWithTax: 0, price: 0 })).toBeUndefined()
    expect(formatPrice({ price: -100 })).toBeUndefined()
    expect(formatPrice({ price: Number.NaN })).toBeUndefined()
  })
})

describe('formatSales（§5.2 销量）', () => {
  test('正常值原样给', () => {
    expect(formatSales(739)).toBe('739')
  })

  test('0 是合法值（一条都没卖出去），不能当成「没有」', () => {
    expect(formatSales(0)).toBe('0')
  })

  test('缺失 / 负数 / 非数字 → undefined', () => {
    expect(formatSales(undefined)).toBeUndefined()
    expect(formatSales(-1)).toBeUndefined()
    expect(formatSales(Number.NaN)).toBeUndefined()
  })

  test('小数向下取整（销量不可能是 739.5 条）', () => {
    expect(formatSales(739.7)).toBe('739')
  })
})

describe('formatRating（§5.2 评分）', () => {
  test('4.5 → "4.5"（一位小数）', () => {
    expect(formatRating(4.5)).toBe('4.5')
  })

  test('满分 5 → "5.0"', () => {
    expect(formatRating(5)).toBe('5.0')
  })

  test('缺失 → undefined（**不是 0 分**，D37 同一条精神：不假装）', () => {
    expect(formatRating(undefined)).toBeUndefined()
  })

  test('0 / 超过 5 / 非有限数 → undefined', () => {
    expect(formatRating(0)).toBeUndefined()
    expect(formatRating(5.1)).toBeUndefined()
    expect(formatRating(Number.NaN)).toBeUndefined()
    expect(formatRating(-1)).toBeUndefined()
  })
})

describe('buildDetailFields（§5.2 作品信息表）', () => {
  test('字段顺序固定（不随数据有没有而跳动）', () => {
    const withAll = buildDetailFields(fullMeta).map((field) => field.key)
    const withNone = buildDetailFields(undefined).map((field) => field.key)
    expect(withAll).toEqual(withNone)
    expect(withAll).toEqual([
      'rj',
      'circle',
      'series',
      'released',
      'type',
      'price',
      'sales',
      'rating',
      'author'
    ])
  })

  test('齐全时每项都有格式化后的值', () => {
    const fields = buildDetailFields(fullMeta)
    const byKey = Object.fromEntries(fields.map((field) => [field.key, field.value]))
    expect(byKey.rj).toBe('RJ294126')
    expect(byKey.circle).toBe('青春×フェティシズム')
    expect(byKey.series).toBe('おま○こ当番')
    expect(byKey.released).toBe('2020/08/30')
    expect(byKey.type).toBe('SOU')
    expect(byKey.price).toBe('1650')
    expect(byKey.sales).toBe('739')
    expect(byKey.rating).toBe('4.5')
    expect(byKey.author).toBe('Tonda')
  })

  test('拿不到时**照样返回这一行**，value=undefined（让 UI 明说「暂无」，与卡片故意不同）', () => {
    const fields = buildDetailFields(undefined)
    expect(fields).toHaveLength(9)
    for (const field of fields) expect(field.value).toBeUndefined()
  })

  test('老数据（只有 M2 的字段）→ 缺的项是 undefined，有的照常给', () => {
    const fields = buildDetailFields({ rj: 'RJ294126', circle: '社团', registDate: '2020/08/30', price: 750 })
    const byKey = Object.fromEntries(fields.map((field) => [field.key, field.value]))
    expect(byKey.rj).toBe('RJ294126')
    expect(byKey.circle).toBe('社团')
    expect(byKey.released).toBe('2020/08/30')
    expect(byKey.price).toBe('750')
    // R2：老数据没有 author / summary / salesCount / rating → 显示「暂无」，靠用户点「重新获取」补
    expect(byKey.author).toBeUndefined()
    expect(byKey.sales).toBeUndefined()
    expect(byKey.rating).toBeUndefined()
    expect(byKey.series).toBeUndefined()
    expect(byKey.type).toBeUndefined()
  })

  test('纯空白字段也归为拿不到', () => {
    const fields = buildDetailFields({ circle: '  ', rj: '' })
    const byKey = Object.fromEntries(fields.map((field) => [field.key, field.value]))
    expect(byKey.circle).toBeUndefined()
    expect(byKey.rj).toBeUndefined()
  })
})

describe('workTypeI18nSuffix（作品类型代码）', () => {
  test('认识的代码返回原代码（UI 拼 detail.workType.<CODE> 查文案）', () => {
    for (const code of ['SOU', 'MNG', 'RPG', 'SLN']) expect(workTypeI18nSuffix(code)).toBe(code)
  })

  test('小写也认（统一大写后再查）', () => {
    expect(workTypeI18nSuffix('sou')).toBe('SOU')
  })

  test('不认识的代码 → undefined（UI 退回显示原代码，不假装翻译过）', () => {
    expect(workTypeI18nSuffix('XYZ')).toBeUndefined()
    expect(workTypeI18nSuffix('')).toBeUndefined()
    expect(workTypeI18nSuffix(undefined)).toBeUndefined()
  })

  test('fixture 里真实出现过的三个代码都认识（MNG / RPG / SLN）', () => {
    // test/fixtures/dlsite/search-mercenary.html 里的 work_type 链接
    expect(workTypeI18nSuffix('MNG')).toBe('MNG')
    expect(workTypeI18nSuffix('RPG')).toBe('RPG')
    expect(workTypeI18nSuffix('SLN')).toBe('SLN')
  })
})

describe('canRefreshMeta（三点菜单 / 详情页的「重新获取」）', () => {
  test('存过 RJ → 可以重新获取', () => {
    expect(canRefreshMeta({ rj: 'RJ294126' })).toBe(true)
  })

  test('没有元数据 / 没有 RJ → 不能（refreshGameMeta 是「按已存的 RJ 重拉」）', () => {
    expect(canRefreshMeta(undefined)).toBe(false)
    expect(canRefreshMeta(null)).toBe(false)
    expect(canRefreshMeta({})).toBe(false)
    expect(canRefreshMeta({ circle: '社团' })).toBe(false)
  })

  test('RJ 是纯空白 → 不能', () => {
    expect(canRefreshMeta({ rj: '  ' })).toBe(false)
  })
})

describe('summaryNeedsCollapse（§11-② 详情页简介可展开）', () => {
  test('短简介不折叠', () => {
    expect(summaryNeedsCollapse('短短的简介')).toBe(false)
  })

  test('长简介要折叠（超过 6 行 × 48 字）', () => {
    expect(summaryNeedsCollapse('あ'.repeat(300))).toBe(true)
  })

  test('没有简介 → 不需要折叠（也不画折叠按钮）', () => {
    expect(summaryNeedsCollapse(undefined)).toBe(false)
    expect(summaryNeedsCollapse('   ')).toBe(false)
  })

  test('正好等于阈值 → 不折叠（边界含在内）', () => {
    expect(summaryNeedsCollapse('a'.repeat(288))).toBe(false)
    expect(summaryNeedsCollapse('a'.repeat(289))).toBe(true)
  })

  test('实测 RJ294126 清洗后 122 字 → 不需要折叠', () => {
    // §3.3：260 字 → 122 字
    expect(summaryNeedsCollapse('あ'.repeat(122))).toBe(false)
  })
})
