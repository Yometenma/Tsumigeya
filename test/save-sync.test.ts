// M4 S5：存档同步占位（src/shared/save-sync.ts）。
//
// ===== 这个文件要钉住的是"**没有**做云同步" =====
//
// 用户要的是「预留一下一些同步方案」。方案 §3.5 与 D31 的结论是：
// 只留接口，**不接任何云**。这件事的失败面很特别 ——
// 它不是"功能坏了"，而是"功能悄悄多出来了"：
//
//   · 某个会话遇到"这里缺个同步"，顺手接了个 Dropbox SDK
//   · 用户的存档开始被传到第三方服务器上
//   · 而这**不需要任何测试变绿/变红**，甚至不需要用户点过那个开关
//
// 所以这里用两条结构性判据把它钉住：
//   ① 源码里不许出现网络调用的能力（fetch / https / net）—— 连 import 都不许
//   ② 设置项只有 `none` / `manual` 两个值，没有第三个
//
// 这与 D68 的取向一致：**删掉/不许有的东西必须有测试守着**。
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  DEFAULT_SAVE_SYNC_MODE,
  SAVE_SYNC_MODES,
  needsManualDisclaimer,
  saveSyncModeLabelKey,
  showsManualButtons,
  validSaveSyncMode,
  type SaveSyncMode
} from '../src/shared/save-sync'

describe('★「不接任何云」必须是结构性的（不是"我们记得别接"）', () => {
  /**
   * 读 save-sync.ts 的源码并**剥掉注释**。
   *
   * 为什么必须剥注释：这个文件的头注释里就写着「不接 Dropbox / iCloud」，
   * 直接扫原文会把那些词当成"用了" —— 判据会**假红**。
   * （反向踩过这个坑的同类测试在 `test/app-version.test.ts` 里也有。）
   */
  function sourceWithoutComments(): string {
    const file = path.join(process.cwd(), 'src', 'shared', 'save-sync.ts')
    const source = fs.readFileSync(file, 'utf8')
    return source
      // 块注释：用「行注释与块注释」这种措辞描述，避免注释里写出定界符字面形式
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // 行注释
      .replace(/\/\/.*$/gm, '')
  }

  test('⚠️ 源码里没有任何网络能力（fetch / https / net / axios / dropbox / icloud）', () => {
    const code = sourceWithoutComments().toLowerCase()
    for (const forbidden of ['fetch(', 'https', 'http', 'axios', 'node:net', 'dropbox', 'icloud', 'webdav']) {
      expect(code, `save-sync.ts 里出现了网络相关的东西：${forbidden}（M4 明令不接任何云）`).not.toContain(
        forbidden
      )
    }
  })

  test('⚠️ 也没有 import 任何 IO 模块（它必须是纯类型 + 纯判据）', () => {
    const code = sourceWithoutComments()
    expect(code).not.toMatch(/^\s*import\s/m)
  })

  test('没有实现类（`new` / `class` 都不该出现）', () => {
    // 留着 interface 是为了"形状已定好"；但**一实现就意味着接了某个方案**
    expect(sourceWithoutComments()).not.toMatch(/\bclass\s+\w+/)
  })

  test('⚠️ 三个网络相关的真实风险点都点不到（这个文件不碰盘也不碰网）', () => {
    // 结构性保证：文件里连 `require` 都没有，运行时无从发起请求
    expect(sourceWithoutComments()).not.toContain('require')
  })
})

describe('★ 模式只有 none / manual 两个（没有第三个）', () => {
  test('合法值恰好两个，顺序固定（顺序 = 下拉里的显示顺序）', () => {
    expect([...SAVE_SYNC_MODES]).toEqual(['none', 'manual'])
  })

  test('默认是 none（默认不该替用户做主）', () => {
    expect(DEFAULT_SAVE_SYNC_MODE).toBe('none')
    // 「默认不启用」与「不接任何云」同一条取向
    expect(SAVE_SYNC_MODES[0]).toBe('none')
  })

  test('i18n 键的格式（设置页按下标取文案，写错了会直接画出 key 原文）', () => {
    // ⚠️ 必须是 `saveSyncModes.<mode>`：`saveSync` 本身是那一行的标题（字符串），
    // 同一个键既做标题又做命名空间在 JSON 里是重复键 → 渲染出 [object Object]。
    expect(saveSyncModeLabelKey('none')).toBe('settings.saveSyncModes.none')
    expect(saveSyncModeLabelKey('manual')).toBe('settings.saveSyncModes.manual')
  })
})

describe('validSaveSyncMode：非法值静默落回默认（不让设置页读不出来）', () => {
  test('合法值原样返回', () => {
    expect(validSaveSyncMode('none')).toBe('none')
    expect(validSaveSyncMode('manual')).toBe('manual')
  })

  test.each([
    ['null', null],
    ['undefined', undefined],
    ['空串', ''],
    ['不认识的值', 'dropbox'],
    ['数字', 1],
    ['对象', { mode: 'manual' }]
  ])('%s → 落回默认（不报错）', (_label, raw) => {
    expect(validSaveSyncMode(raw)).toBe(DEFAULT_SAVE_SYNC_MODE)
  })

  test('⚠️ 它不影响数据安全，所以静默回落是对的（与语言偏好那几项刻意不同）', () => {
    // 这里钉的是"刻意不同"这件事本身：
    // 语言偏好非法时 `saveSettings` 会**报错**（因为那几个键决定"启动时会不会被提示"），
    // 而同步模式只是 UI 提示 → 静默回落。
    // 若哪天有人把它改成"报错"，用户就会在保存一个无关设置时莫名失败。
    const bad = 'third-party-cloud' as unknown
    expect(() => validSaveSyncMode(bad)).not.toThrow()
  })
})

describe('⚠️ showsManualButtons 恒 true：把按钮藏起来等于让用户以为没有导出功能', () => {
  test('none 模式也显示导出/导入按钮', () => {
    // `none` 的语义是"我不需要同步方案"，**不是**"我不想备份"。
    // 手动导入导出是唯一真正能防丢档的手段（方案 §6 反对自动备份的原因也在这）。
    expect(showsManualButtons('none')).toBe(true)
  })

  test('manual 模式显示', () => {
    expect(showsManualButtons('manual')).toBe(true)
  })

  test('每个合法模式都是 true（将来加云模式时这条会红，逼我们回来想清楚）', () => {
    for (const mode of SAVE_SYNC_MODES) {
      expect(showsManualButtons(mode)).toBe(true)
    }
  })
})

describe('needsManualDisclaimer：只在 manual 时说明"不会上传任何东西"', () => {
  test('none → 不需要（什么都没发生）', () => {
    expect(needsManualDisclaimer('none')).toBe(false)
  })

  test('manual → 需要（让用户明白我们没偷偷联网）', () => {
    expect(needsManualDisclaimer('manual')).toBe(true)
  })
})

describe('★ showsManualButtons 必须真的被用到（否则它就是死代码）', () => {
  /**
   * 这条防的是"判据写了但没人用"。
   *
   * 本鱼写这一轮时确实踩到了：`showsManualButtons` 先写进 shared、加了 3 条测试，
   * 但 `SaveSection.vue` 里当时根本没接 —— 测试全绿，功能上却等于没写。
   * 判据的价值只在**被调用**时才存在。
   */
  const sectionSource = (): string =>
    fs.readFileSync(path.join(process.cwd(), 'src', 'renderer', 'src', 'components', 'SaveSection.vue'), 'utf8')

  test('SaveSection.vue 引用了 showsManualButtons（不是写死 v-if="true"）', () => {
    expect(sectionSource()).toContain('showsManualButtons')
  })

  test('两个按钮的可见性走同一个判据（不是只有导出接了）', () => {
    const source = sectionSource()
    const guarded = source.match(/v-if="showManualButtons"/g) ?? []
    expect(guarded.length, '导出与导入两个按钮都要走 showManualButtons').toBe(2)
  })

  test('⚠️ 设置值经 validSaveSyncMode 归一（磁盘上的脏值不该把按钮弄没）', () => {
    // 好处是结构性的：就算 settings.json 被人改成 `dropbox`，
    // showsManualButtons 拿到的也永远是合法值 —— 按钮不会因为脏值消失。
    expect(sectionSource()).toContain('validSaveSyncMode')
  })
})

describe('类型的可用性（这些常量真的能被渲染层用起来）', () => {
  test('SaveSyncMode 可以从常量推导，不需要手写第三份', () => {
    const modes: SaveSyncMode[] = [...SAVE_SYNC_MODES]
    expect(modes).toHaveLength(2)
  })
})

describe('★ 对应的 i18n 键必须真的存在于 locales', () => {
  /**
   * 从 locales 里按点路径取值。
   *
   * 为什么要这条测试：vue-i18n 查不到键时**原样返回 key**，
   * 所以 `settings.saveSyncModes.mnual`（拼错一个字母）会直接把
   * `settings.saveSyncModes.mnual` 这串英文画在下拉框里 ——
   * 不报错、不警告，只有人眼看页面才发现。
   */
  function lookup(key: string): unknown {
    const file = path.join(process.cwd(), 'src', 'renderer', 'src', 'locales', 'zh-CN.json')
    const json = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    let cursor: unknown = json
    for (const part of key.split('.')) {
      if (!cursor || typeof cursor !== 'object') return undefined
      cursor = (cursor as Record<string, unknown>)[part]
    }
    return cursor
  }

  test('每个模式的标签键都取得到字符串（不是 undefined、不是对象）', () => {
    for (const mode of SAVE_SYNC_MODES) {
      const value = lookup(saveSyncModeLabelKey(mode))
      expect(typeof value, `${saveSyncModeLabelKey(mode)} 在 locales 里不是字符串`).toBe('string')
      expect(value as string).not.toBe('')
    }
  })

  test('设置页用到的固定键也都在（标题 / 说明 / 手动模式那句）', () => {
    for (const key of ['settings.saveSync', 'settings.saveSyncHint', 'settings.saveSyncManualDisclaimer']) {
      expect(typeof lookup(key), `${key} 在 locales 里不存在`).toBe('string')
    }
  })

  test('⚠️ 存档区块用到的 detail.saves / error.save* 键也都在', () => {
    // 这两个页面组件的文案键一次列全：漏一个的表现是页面上出现一串英文 key。
    for (const key of [
      'detail.saves',
      'detail.savesUnknown',
      'detail.savesEmpty',
      'detail.savesConfigsTitle',
      'detail.revealInFinder',
      'detail.exportSaves',
      'detail.importSaves',
      'detail.exportDone',
      'detail.importDone',
      'detail.importDoneWithBackup',
      'error.saveExportRunning',
      'error.saveImportRunning',
      'error.saveExportNoLocation',
      'error.saveArchiveEmpty',
      'error.saveArchiveMissing',
      'error.saveArchiveNotZip',
      'error.saveArchiveNoManifest',
      'error.saveArchiveBadManifest',
      'error.saveArchiveVerifyFailed',
      'error.saveBackupFailed'
    ]) {
      expect(typeof lookup(key), `${key} 在 locales 里不存在`).toBe('string')
    }
  })
})
