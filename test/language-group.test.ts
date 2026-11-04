// M2.5-C 单测：多语言版本偏好（§C.6）。
//
// 重点在于**不误认**：认错组会让用户点启动时被引到另一个游戏，
// 比「没认出来、什么都不提示」严重得多（§C.2 的保守原则）。
import { describe, expect, test } from 'vitest'
import {
  GAME_LANGUAGES,
  normalizeTitle,
  stripLanguageSuffix
} from '../src/shared/game-language'
import {
  DEFAULT_SIMILARITY_THRESHOLD,
  applyParentFolderInference,
  detectGameLanguage,
  groupByLanguage,
  isSuffixExtension,
  similarity,
  type LanguageGroupCandidate
} from '../src/shared/language-group'

describe('stripLanguageSuffix（§C.3）', () => {
  test('语言标记：中/日/英/韩各种写法', () => {
    const cases: Array<[string, string, string]> = [
      ['傭兵の冒険_CHN', '傭兵の冒険', 'zh'],
      ['傭兵の冒険_CN', '傭兵の冒険', 'zh'],
      ['傭兵の冒険_CHS', '傭兵の冒険', 'zh'],
      ['傭兵の冒険_SC', '傭兵の冒険', 'zh'],
      ['傭兵の冒険_中文', '傭兵の冒険', 'zh'],
      ['傭兵の冒険_简中', '傭兵の冒険', 'zh'],
      ['傭兵の冒険_简体中文', '傭兵の冒険', 'zh'],
      ['傭兵の冒険_JPN', '傭兵の冒険', 'ja'],
      ['傭兵の冒険_JP', '傭兵の冒険', 'ja'],
      ['傭兵の冒険_日文', '傭兵の冒険', 'ja'],
      ['Slave Sword_ENG', 'Slave Sword', 'en'],
      ['Slave Sword_EN', 'Slave Sword', 'en'],
      ['Slave Sword_英文', 'Slave Sword', 'en'],
      ['게임_KOR', '게임', 'ko'],
      ['게임_韩文', '게임', 'ko']
    ]
    for (const [input, base, lang] of cases) {
      const result = stripLanguageSuffix(input)
      expect(result.base, input).toBe(base)
      expect(result.lang, input).toBe(lang)
    }
  })

  test('大小写不敏感', () => {
    expect(stripLanguageSuffix('Game_chs')).toEqual({ base: 'Game', lang: 'zh' })
    expect(stripLanguageSuffix('Game_Eng')).toEqual({ base: 'Game', lang: 'en' })
  })

  test('版本号剥掉但不产生 lang', () => {
    expect(stripLanguageSuffix('Game_v1.0.10')).toEqual({ base: 'Game' })
    expect(stripLanguageSuffix('Game_1.0.2')).toEqual({ base: 'Game' })
  })

  test('语言与版本混着写也能剥（两种顺序都行）', () => {
    expect(stripLanguageSuffix('Game_CHS_v1.2')).toEqual({ base: 'Game', lang: 'zh' })
    expect(stripLanguageSuffix('Game_v1.2_CHS')).toEqual({ base: 'Game', lang: 'zh' })
  })

  test('⚠️ 续作序号不能被当成版本号剥掉（实测纠错）', () => {
    // 第一版写成 `v?\\d+` 时，「傭兵の冒険2_CHN」被剥成「傭兵の冒険」，
    // 导致续作与原作被判成同一款的多语言版 —— 用户点启动会被引到错的游戏。
    expect(stripLanguageSuffix('傭兵の冒険2_CHN')).toEqual({ base: '傭兵の冒険2', lang: 'zh' })
    expect(stripLanguageSuffix('傭兵の冒険2')).toEqual({ base: '傭兵の冒険2' })
    // 但带小数点的多段数字仍然是版本号
    expect(stripLanguageSuffix('Game2_1.0.2')).toEqual({ base: 'Game2' })
  })

  test('没有标记时原样返回（不能瞎剥）', () => {
    expect(stripLanguageSuffix('傭兵の冒険')).toEqual({ base: '傭兵の冒険' })
    expect(stripLanguageSuffix('中文游戏')).toEqual({ base: '中文游戏' }) // 标记在中间，不算后缀
    expect(stripLanguageSuffix('Game_HD')).toEqual({ base: 'Game_HD' }) // HD 不是语言
  })

  test('标记出现在中间不算（避免把作者名/地区当语言）', () => {
    expect(stripLanguageSuffix('CHN_Game').lang).toBeUndefined()
    expect(stripLanguageSuffix('JP_Collection').lang).toBeUndefined()
  })

  test('空 / 非字符串 / 纯标记', () => {
    expect(stripLanguageSuffix('')).toEqual({ base: '' })
    expect(stripLanguageSuffix('   ')).toEqual({ base: '' })
    expect(stripLanguageSuffix(undefined)).toEqual({ base: '' })
    expect(stripLanguageSuffix(123 as never)).toEqual({ base: '' })
    // 整个名字就是标记时保留原名（不产生空标题）
    expect(stripLanguageSuffix('_CHN').base).toBe('_CHN')
  })
})

describe('normalizeTitle（相似度比较用的归一化）', () => {
  test('小写 + 去空白 + 去括号内容 + 去后缀', () => {
    expect(normalizeTitle('傭兵の冒険')).toBe('傭兵の冒険')
    expect(normalizeTitle('傭兵の冒険_CHN')).toBe('傭兵の冒険')
    expect(normalizeTitle('傭兵の冒険（アップデート版）')).toBe('傭兵の冒険')
    expect(normalizeTitle('傭兵の冒険【アップデート版】')).toBe('傭兵の冒険')
    expect(normalizeTitle('Slave Sword')).toBe('slavesword')
  })

  test('标点被去掉（但括号外的修饰词保留）', () => {
    expect(normalizeTitle('傭兵の冒険!')).toBe('傭兵の冒険')
    // ⚠️ 注意：`~完全版~` 去掉波浪号后剩下「完全版」——它是**不同的商品**，
    // 不该被归一成和原作同一个标题（否则会被错认成多语言版）。
    // 所以这里只断言标点被去掉，不期待它变成「傭兵の冒険」。
    expect(normalizeTitle('傭兵の冒険 ~~')).toBe('傭兵の冒険')
    expect(normalizeTitle('傭兵の冒険 ~完全版~')).toBe('傭兵の冒険完全版')
  })

  test('空 / 非字符串', () => {
    expect(normalizeTitle('')).toBe('')
    expect(normalizeTitle(undefined)).toBe('')
  })
})

describe('similarity（Levenshtein 换算）', () => {
  test('完全相同 → 1', () => {
    expect(similarity('abc', 'abc')).toBe(1)
  })

  test('完全不同 → 0', () => {
    expect(similarity('abc', 'xyz')).toBe(0)
    expect(similarity('', 'abc')).toBe(0)
  })

  test('两个都空 → 1（视为一致，避免除零）', () => {
    expect(similarity('', '')).toBe(1)
  })

  test('续作序号能显著降低相似度', () => {
    const base = similarity(normalizeTitle('傭兵の冒険'), normalizeTitle('傭兵の冒険2'))
    const same = similarity(normalizeTitle('傭兵の冒険'), normalizeTitle('傭兵の冒険_CHN'))
    expect(same).toBe(1)
    expect(base).toBeLessThan(same)
  })

  test('阈值默认值就是 §7-② 用户确认的 0.8', () => {
    expect(DEFAULT_SIMILARITY_THRESHOLD).toBe(0.8)
  })
})

describe('detectGameLanguage（路径优先，标题兜底）', () => {
  test('路径里最内层的标记优先', () => {
    expect(
      detectGameLanguage({ id: '1', title: '傭兵の冒険', path: 'E:/Game/RPG/傭兵の冒険/傭兵の冒険_CHN' })
    ).toBe('zh')
  })

  test('路径没有标记时看标题', () => {
    expect(detectGameLanguage({ id: '1', title: '傭兵の冒険_CHN', path: 'E:/Game/RPG/傭兵の冒険' })).toBe('zh')
  })

  test('都没有 → undefined', () => {
    expect(detectGameLanguage({ id: '1', title: '傭兵の冒険', path: 'E:/Game/RPG/傭兵の冒険' })).toBeUndefined()
  })

  test('从最内层往外找（内层没有标记、外层有）', () => {
    expect(detectGameLanguage({ id: '1', title: 'x', path: 'E:/Game_CN/子目录' })).toBe('zh')
  })
})

describe('applyParentFolderInference（父目录推为 ja）', () => {
  test('★ 用户真实样本：日文原版在父目录、中文版在内层', () => {
    const inferred = applyParentFolderInference([
      { id: 'ja', title: '傭兵の冒険', path: 'E:/Game/RPG/傭兵の冒険' },
      { id: 'zh', title: '傭兵の冒険_CHN', path: 'E:/Game/RPG/傭兵の冒険/傭兵の冒険_CHN' }
    ])
    expect(inferred).toEqual([
      { id: 'ja', lang: 'ja', inferred: true },
      { id: 'zh', lang: 'zh', inferred: false }
    ])
  })

  test('父目录自己有显式标记 → 以显式为准，不推断', () => {
    const inferred = applyParentFolderInference([
      { id: 'en', title: 'Game', path: 'E:/Game/Game_EN' },
      { id: 'zh', title: 'Game_CHN', path: 'E:/Game/Game_EN/Game_CHN' }
    ])
    expect(inferred.find((item) => item.id === 'en')).toEqual({ id: 'en', lang: 'en', inferred: false })
  })

  test('没有子目录带语言标记 → 不推断（绝不把孤儿拉进组）', () => {
    const inferred = applyParentFolderInference([
      { id: 'alone', title: '傭兵の冒険', path: 'E:/Game/RPG/傭兵の冒険' }
    ])
    expect(inferred).toEqual([])
  })

  test('只有路径前缀相同才算父子（不做模糊匹配）', () => {
    const inferred = applyParentFolderInference([
      { id: 'a', title: 'Game', path: 'E:/Game/RPG/Game' },
      // 相似但**不是**子目录
      { id: 'b', title: 'Game_CHN', path: 'E:/Game/RPG/Game_CHN' }
    ])
    expect(inferred.some((item) => item.id === 'a')).toBe(false)
  })

  test('子目录也是 ja 时不推断（没有"多语言"关系）', () => {
    const inferred = applyParentFolderInference([
      { id: 'a', title: 'Game', path: 'E:/Game/Game' },
      { id: 'b', title: 'Game_JPN', path: 'E:/Game/Game/Game_JPN' }
    ])
    expect(inferred.some((item) => item.id === 'a')).toBe(false)
  })
})

describe('groupByLanguage（§C.2 分组规则）', () => {
  test('★ 用户真实样本成组：傭兵の冒険（ja） + 傭兵の冒険_CHN（zh）', () => {
    const groups = groupByLanguage([
      { id: 'ja', title: '傭兵の冒険', path: 'E:/Game/RPG/傭兵の冒険' },
      { id: 'zh', title: '傭兵の冒険_CHN', path: 'E:/Game/RPG/傭兵の冒険/傭兵の冒険_CHN' }
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].members).toEqual([
      { id: 'ja', lang: 'ja' },
      { id: 'zh', lang: 'zh' }
    ])
  })

  test('★ 用户样本：只有日文原版一个时不成组', () => {
    expect(groupByLanguage([{ id: 'ja', title: '傭兵の冒険', path: 'E:/Game/RPG/傭兵の冒険' }])).toEqual([])
  })

  test('同语言的两个条目不成组（是重复安装，不是多语言版）', () => {
    const groups = groupByLanguage([
      { id: 'a', title: '傭兵の冒険_CHN', path: '/g/a/傭兵の冒険_CHN' },
      { id: 'b', title: '傭兵の冒険_CN', path: '/g/b/傭兵の冒険_CN' }
    ])
    expect(groups).toEqual([])
  })

  test('没有语言标记的条目绝不进组', () => {
    const groups = groupByLanguage([
      { id: 'a', title: '傭兵の冒険', path: '/g/a/傭兵の冒険' },
      { id: 'b', title: '傭兵の冒険', path: '/g/b/傭兵の冒険' }
    ])
    expect(groups).toEqual([])
  })

  test('续作与原作不该成组（标题多了个 2）', () => {
    const groups = groupByLanguage([
      { id: 'a', title: '傭兵の冒険_CHN', path: '/g/a/傭兵の冒険_CHN' },
      { id: 'b', title: '傭兵の冒険2_EN', path: '/g/b/傭兵の冒険2_EN' }
    ])
    expect(groups).toEqual([])
  })

  test('三个语言版本都能进同一组', () => {
    const groups = groupByLanguage([
      { id: 'a', title: 'Game', path: '/g/Game' },
      { id: 'zh', title: 'Game_CHN', path: '/g/Game/Game_CHN' },
      { id: 'en', title: 'Game_EN', path: '/g/Game_EN' }
    ])
    expect(groups).toHaveLength(1)
    const langs = groups[0].members.map((member) => member.lang).sort()
    expect(langs).toEqual(['en', 'ja', 'zh'])
  })

  test('阈值可调：归一化后完全一致的两个版本，即使阈值 1.0 也能成组', () => {
    const candidates: LanguageGroupCandidate[] = [
      { id: 'a', title: '純愛おま○こ当番_CHN', path: '/g/a/純愛おま○こ当番_CHN' },
      { id: 'b', title: '純愛おま○こ当番_EN', path: '/g/b/純愛おま○こ当番_EN' }
    ]
    // 归一化后两者完全一致（语言后缀已剥掉）→ 即使 1.0 也能成组
    expect(groupByLanguage(candidates, { threshold: 1 })).toHaveLength(1)
  })

  test('阈值边界：相似度达到阈值才成组（用"中间不同"的标题避免前缀规则干扰）', () => {
    // 刻意选**中间**有一个字不同的标题（不是前缀/后缀关系），
    // 这样才能单独测「阈值」这条规则（前缀差异由 isSuffixExtension 提前挡掉）
    const left = '傭兵の大冒険'
    const right = '傭兵の小冒険'
    const sim = similarity(normalizeTitle(left), normalizeTitle(right))
    expect(sim).toBeLessThan(1)
    expect(isSuffixExtension(normalizeTitle(left), normalizeTitle(right))).toBe(false)

    // 两个都要带**显式**语言标记（否则会被"无标记不进组"规则先淘汰）
    const a: LanguageGroupCandidate = { id: 'a', title: `${left}_CHN`, path: '/g/a/傭兵の大冒険_CHN' }
    const b: LanguageGroupCandidate = { id: 'b', title: `${right}_EN`, path: '/g/b/傭兵の小冒険_EN' }

    // 阈值设在 sim 之下 → 成组
    expect(groupByLanguage([a, b], { threshold: sim - 0.01 })).toHaveLength(1)
    // 阈值设在 sim 之上 → 不成组
    expect(groupByLanguage([a, b], { threshold: sim + 0.01 })).toEqual([])
  })

  test('★ 前缀关系绝不因高相似度而成组（续作防线）', () => {
    // 傭兵の冒険 vs 傭兵の冒険2 的归一化相似度是 0.833 > 默认阈值 0.8，
    // 光靠阈值会错认成多语言版 —— isSuffixExtension 是专门挡这种情况的。
    const short = normalizeTitle('傭兵の冒険')
    const longer = normalizeTitle('傭兵の冒険2')
    expect(similarity(short, longer)).toBeGreaterThan(DEFAULT_SIMILARITY_THRESHOLD)
    expect(isSuffixExtension(short, longer)).toBe(true)

    const groups = groupByLanguage([
      { id: 'a', title: '傭兵の冒険_CHN', path: '/g/a/傭兵の冒険_CHN' },
      { id: 'b', title: '傭兵の冒険2_EN', path: '/g/b/傭兵の冒険2_EN' }
    ])
    expect(groups).toEqual([])
  })

  test('空列表 / 单条目', () => {
    expect(groupByLanguage([])).toEqual([])
    expect(groupByLanguage([{ id: '1', title: 'Game_CHN', path: '/g/Game_CHN' }])).toEqual([])
  })
})

describe('语言常量', () => {
  test('四个语言齐全', () => {
    expect([...GAME_LANGUAGES].sort()).toEqual(['en', 'ja', 'ko', 'zh'])
  })
})
