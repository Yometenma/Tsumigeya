// M5.0 S9（U9）单测：设置页的分组定义（src/shared/settings-groups.ts）。
//
// ===== 这轮真正要防的错误 =====
//
// 用户说「设置页面，也可以顺手优化一下」。分组化看起来只是"把 13 条搬进 5 个 box"，
// 但它有一个只删不守就会复发的风险：
//
//     **某个设置项在搬家时被漏掉**。
//
// 表现是"用户找不到那个开关了"，而且**不会报错**：页面正常渲染、类型检查通过、
// 单测全绿 —— 因为没有任何东西在核对「Settings 的每个键都出现在某个分组里」。
// 这就是这个文件存在的理由（D68 的同一取向）。
//
// 另外钉住"重复列出"：同一个开关出现两次，用户改了一处、另一处看起来没变，
// 会以为有两个独立设置。
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  BOOL_DEFAULTS,
  INFO_KEYS,
  SETTINGS_GROUPS,
  SETTINGS_KEYS,
  duplicatedSettings,
  groupHasCustom,
  isEmptyGroup,
  missingSettings,
  type SettingsGroup
} from '../src/shared/settings-groups'

describe('★ 每个设置项恰好被分组列一次', () => {
  test('没有遗漏的设置项（漏了 = 用户找不到那个开关）', () => {
    expect(missingSettings()).toEqual([])
  })

  test('没有重复的（重复 = 用户以为有两个独立设置）', () => {
    expect(duplicatedSettings()).toEqual([])
  })

  test('分组覆盖的项数 = SETTINGS_KEYS 的项数（不多不少）', () => {
    const covered = SETTINGS_GROUPS.flatMap((group) => group.keys)
    expect(covered).toHaveLength(SETTINGS_KEYS.length)
    expect(new Set(covered).size).toBe(SETTINGS_KEYS.length)
  })

  test('SETTINGS_KEYS 本身没有重复', () => {
    expect(new Set(SETTINGS_KEYS).size).toBe(SETTINGS_KEYS.length)
  })
})

describe('★ 与真实 Settings 类型对齐（源码级核对）', () => {
  /**
   * 从渲染层的 `client.ts` 里抠出 `Settings` 接口的字段名。
   *
   * 为什么要在源码里扫而不是只靠手写清单：手写清单**永远会忘记更新**，
   * 而忘记更新的表现正是"用户找不到新加的那个开关"。
   */
  function settingsFieldsFromSource(): string[] {
    const file = path.join(process.cwd(), 'src', 'renderer', 'src', 'api', 'client.ts')
    const source = fs.readFileSync(file, 'utf8')
    const start = source.indexOf('export interface Settings')
    expect(start).toBeGreaterThan(-1)
    // 从 `{` 到配对的 `}`：接口体里没有嵌套对象字面量，按第一个 `}` 结束即可
    const body = source.slice(source.indexOf('{', start) + 1, source.indexOf('}', start))
    const fields: string[] = []
    for (const line of body.split('\n')) {
      // 只取形如 `  listView: boolean` 的字段行；跳过注释
      const match = line.match(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\??:/)
      if (match) fields.push(match[1]!)
    }
    return fields
  }

  test('⚠️ Settings 接口里的每个字段都在 SETTINGS_KEYS 里（新增字段忘了归类会红）', () => {
    // 只读信息字段不参与"开关分组"，单独在白名单里
    const infoKeys = new Set<string>(INFO_KEYS)
    const actual = settingsFieldsFromSource().filter((field) => !infoKeys.has(field))
    expect(actual.length).toBeGreaterThan(0)
    for (const field of actual) {
      expect(SETTINGS_KEYS, `Settings 的新字段 ${field} 没归进任何分组`).toContain(field)
    }
  })

  test('SETTINGS_KEYS 里没有 Settings 中不存在的字段（防手抖写错名字）', () => {
    const infoKeys = new Set<string>(INFO_KEYS)
    const actual = new Set(settingsFieldsFromSource().filter((field) => !infoKeys.has(field)))
    for (const key of SETTINGS_KEYS) {
      expect(actual.has(key), `SETTINGS_KEYS 里的 ${key} 在 Settings 接口里不存在`).toBe(true)
    }
  })
})

describe('分组本身的形状', () => {
  test('分组 id 唯一', () => {
    const ids = SETTINGS_GROUPS.map((group) => group.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  test('⚠️ 不是全部展开（用户的抱怨就是"一条条平铺"，13 条全展开等于没分组）', () => {
    const openCount = SETTINGS_GROUPS.filter((group) => group.defaultOpen).length
    expect(openCount).toBeLessThan(SETTINGS_GROUPS.length)
    // 至少有一个默认展开，否则用户进来看到一片折叠的标题，反而更难
    expect(openCount).toBeGreaterThan(0)
  })

  test('默认展开的组里装的是最常改的（外观 / 游戏库删确认与封面）', () => {
    const openIds = SETTINGS_GROUPS.filter((group) => group.defaultOpen).map((group) => group.id)
    expect(openIds).toContain('appearance')
    expect(openIds).toContain('library')
  })

  test('⚠️ 多语言偏好的三个参数在同一个组（拆开会让用户在两处找）', () => {
    const group = SETTINGS_GROUPS.find((item) => item.keys.includes('preferredLanguage'))
    expect(group?.id).toBe('language')
    for (const key of ['fallbackLanguage', 'languageSwitchPrompt'] as const) {
      expect(group?.keys).toContain(key)
    }
  })

  test('⚠️ 启动相关的两个开关在同一组（都影响"这次启动会不会被拦/能不能认出来"）', () => {
    const group = SETTINGS_GROUPS.find((item) => item.keys.includes('diagnoseBeforeLaunch'))
    expect(group?.id).toBe('launch')
    expect(group?.keys).toContain('nonInstalledAutodetect')
  })

  test('「数据与版本」组没有开关项（它放的是只读信息与按钮）', () => {
    const group = SETTINGS_GROUPS.find((item) => item.id === 'data')
    expect(group).toBeDefined()
    expect(group?.keys).toEqual([])
    expect(isEmptyGroup(group!)).toBe(true)
  })
})

describe('missingSettings / duplicatedSettings 的判据本身', () => {
  test('人为漏掉一个 → 能被检出来', () => {
    const broken: SettingsGroup[] = SETTINGS_GROUPS.map((group) => ({
      ...group,
      keys: group.keys.filter((key) => key !== 'appearance')
    }))
    expect(missingSettings(broken)).toEqual(['appearance'])
  })

  test('人为重复一个 → 能被检出来', () => {
    const broken: SettingsGroup[] = [
      ...SETTINGS_GROUPS,
      { id: 'appearance', keys: ['appearance'], defaultOpen: true }
    ]
    expect(duplicatedSettings(broken)).toEqual(['appearance'])
  })

  test('空分组不算问题（数据组本来就没有开关）', () => {
    expect(isEmptyGroup({ id: 'data', keys: [], defaultOpen: false })).toBe(true)
    expect(isEmptyGroup({ id: 'appearance', keys: ['appearance'], defaultOpen: true })).toBe(false)
  })
})

/**
 * 主进程用「非 false 即 true」写法的那几个布尔默认值。
 *
 * 它们**不在** `DEFAULT_SETTINGS` 里，而是在 `settings()` 里逐项兜底：
 *     languageSwitchPrompt: saved.languageSwitchPrompt === false ? false : true
 *     diagnoseBeforeLaunch: saved.diagnoseBeforeLaunch === false ? false : true
 *
 * 也就是说**默认是 true**。本鱼第一版把其中一项当成了 `DEFAULT_SETTINGS` 的成员，
 * 测试直接报"主进程 undefined" —— 这正是那条源码级核对的价值。
 */
const DEPEND_DEFAULTS: Record<string, boolean> = {
  languageSwitchPrompt: true,
  diagnoseBeforeLaunch: true
}

describe('★ BOOL_DEFAULTS 必须与主进程的真实默认值一致（源码级核对）', () => {
  /**
   * 从 `games-store.ts` 里抠出 `DEFAULT_SETTINGS` 的布尔值。
   *
   * ===== 为什么这条测试非有不可 =====
   *
   * 本鱼第一版在设置页里手抄了一份默认值给「收起的组有没有被改过」用，
   * **抄错了** `checkModuleUpdatesOnStartup`（真实是 true，抄成 false）。
   * 后果是：用户什么都没改，收起的「启动与引擎」组上却一直挂着一个
   * "你改过这里"的圆点 —— 不报错、类型检查通过，只有人眼能发现。
   *
   * 而这份镜像**不得不留**：渲染层不能 import 主进程的 games-store.ts
   * （它 import node:fs，打包进浏览器会当场失败）。
   *
   * 所以：镜像放 shared，用一条源码级核对把两边钉在一起。主进程改默认值时这条会红。
   */
  function boolDefaultsFromMainSource(): Record<string, boolean> {
    const file = path.join(process.cwd(), 'src', 'main', 'games-store.ts')
    const source = fs.readFileSync(file, 'utf8')
    const start = source.indexOf('const DEFAULT_SETTINGS')
    expect(start).toBeGreaterThan(-1)
    const open = source.indexOf('{', start)
    const close = source.indexOf('}', open)
    const body = source.slice(open + 1, close)
    const out: Record<string, boolean> = {}
    for (const line of body.split('\n')) {
      // 只取形如 `  listView: false,` 的布尔行
      const match = line.match(/^\s{2}([a-zA-Z][a-zA-Z0-9]*):\s*(true|false),?\s*$/)
      if (match) out[match[1]!] = match[2] === 'true'
    }
    return out
  }

  test('⚠️ 每一项都与主进程的真实默认值相同（写错会让收起的组误报"已改过"）', () => {
    const actual = boolDefaultsFromMainSource()
    expect(Object.keys(actual).length).toBeGreaterThan(0)
    for (const [key, value] of Object.entries(BOOL_DEFAULTS)) {
      // DEPEND_DEFAULTS 里那几项不在 DEFAULT_SETTINGS 里（源码用的是
      // `saved.x === false ? false : true` 这种"非 false 即 true"的写法），走另一条判据
      const expected = key in actual ? actual[key] : DEPEND_DEFAULTS[key]
      expect(
        expected,
        `BOOL_DEFAULTS 里的 ${key} 在主进程既不在 DEFAULT_SETTINGS、也不在 DEPEND_DEFAULTS 里`
      ).toBeDefined()
      expect(
        expected,
        `BOOL_DEFAULTS 里的 ${key} 与主进程默认值不一致（主进程是 ${String(expected)}）`
      ).toBe(value)
    }
  })

  test('BOOL_DEFAULTS 覆盖了主进程的全部布尔默认值（不多不少，含 DEPEND_DEFAULTS 那几项）', () => {
    const actual = boolDefaultsFromMainSource()
    const all = { ...actual, ...DEPEND_DEFAULTS }
    expect(Object.keys(BOOL_DEFAULTS).sort()).toEqual(Object.keys(all).sort())
  })

  test('⚠️ DEPEND_DEFAULTS 与主进程源码里的写法一致（"非 false 即 true"）', () => {
    // 钉住的是判定方式本身：源码里 `saved.x === false ? false : true` 意味着默认 true。
    // 若哪天主进程改成 `?? false`（默认 false），这条会红，逼我们回来改镜像。
    const source = fs.readFileSync(path.join(process.cwd(), 'src', 'main', 'games-store.ts'), 'utf8')
    for (const key of Object.keys(DEPEND_DEFAULTS)) {
      // ⚠️ 这里**刻意不用正则**：`\s` 的转义层级在字符串模板里容易算错，
      // 本鱼第一版就写坏了 —— 正则变成 `s*` 而不是 `\s*`，判据静默空转（测试还是绿的）。
      // 用 split/includes 比正则稳，出错时当场能看见。
      const compact = source.replace(/\s+/g, ' ')
      const expected = `saved.${key} === false ? false : true`
      expect(compact.includes(expected), `games-store.ts 里 ${key} 的默认值写法变了，本测试的假设失效`).toBe(true)
    }
  })
})

describe('groupHasCustom：收起的组要不要挂圆点', () => {
  const appearanceGroup = SETTINGS_GROUPS.find((group) => group.id === 'appearance')!

  test('全部等于默认值 → false（不挂圆点）', () => {
    expect(groupHasCustom(appearanceGroup, { appearance: 'system', listView: false })).toBe(false)
  })

  test('有一个偏离 → true', () => {
    expect(groupHasCustom(appearanceGroup, { appearance: 'system', listView: true })).toBe(true)
  })

  test('只对布尔项判断（枚举/字符串不参与，避免误报）', () => {
    // appearance 是枚举、没有 BOOL_DEFAULTS 条目 → 改它不该触发圆点
    expect(groupHasCustom(appearanceGroup, { appearance: 'dark', listView: false })).toBe(false)
  })

  test('空分组 → false', () => {
    expect(groupHasCustom({ id: 'data', keys: [], defaultOpen: false }, {})).toBe(false)
  })

  test('当前对象缺这个键 → 视为偏离（不能因为缺失就当成默认）', () => {
    // 真实的 settings 永远有全部键；这里防的是调用方传了半个对象
    expect(groupHasCustom(appearanceGroup, {})).toBe(true)
  })
})

describe('INFO_KEYS：只读信息不是开关', () => {
  test('四个只读项都在，且都不在 SETTINGS_KEYS 里（它们搬不进"开关"的语义）', () => {
    expect([...INFO_KEYS]).toEqual(['dataPath', 'appVersion', 'nodeVersion', 'platform'])
    for (const key of INFO_KEYS) {
      expect(SETTINGS_KEYS).not.toContain(key as never)
    }
  })
})
