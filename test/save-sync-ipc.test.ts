// M4 S5：存档同步模式在设置层的落地（读回 / 归一化 / 不破坏旧库）。
//
// ===== 这一条最容易出的错：旧库读不出来 =====
//
// `settings.json` 是**跨版本存在**的文件。旧版本里没有 `saveSyncMode` 这个键，
// 新版本读它时必须**补上默认值**而不是崩掉或留下 undefined ——
// 后者会让设置页的下拉框显示空白（`el-select` 拿到 undefined 什么都不画）。
//
// 另一条：**非法值静默落回 none**（不是报错）。理由见 shared/save-sync.ts 的头注释：
// 这个开关只影响设置页文案，为一个无关操作莫名失败比"静默改正"更糟。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createCoreHost } from '../src/main/core-host'
import { createDispatcher } from '../src/main/ipc'
import { normalizeSettings } from '../src/main/games-store'
import { DEFAULT_SAVE_SYNC_MODE } from '../src/shared/save-sync'

let dataDir: string
let host: ReturnType<typeof createCoreHost>

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-syncipc-'))
  host = createCoreHost({ dataDir })
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

const signal = (): AbortSignal => new AbortController().signal

type Snap = { settings: { saveSyncMode?: unknown } }

describe('normalizeSettings：旧库 / 脏值 / 正常值', () => {
  test('⚠️ 旧库（完全没有这个键）→ 补上默认 none（不是 undefined）', () => {
    // 设置页的 el-select 拿到 undefined 会显示空白 —— 比显示"无"更糟
    expect(normalizeSettings({ listView: true }).saveSyncMode).toBe(DEFAULT_SAVE_SYNC_MODE)
  })

  test('空设置对象 → 默认 none', () => {
    expect(normalizeSettings({}).saveSyncMode).toBe('none')
  })

  test('合法值原样保留', () => {
    expect(normalizeSettings({ saveSyncMode: 'manual' }).saveSyncMode).toBe('manual')
    expect(normalizeSettings({ saveSyncMode: 'none' }).saveSyncMode).toBe('none')
  })

  test('⚠️ 非法值静默落回 none（不抛错）', () => {
    for (const bad of ['dropbox', '', null, 42, { x: 1 }]) {
      expect(normalizeSettings({ saveSyncMode: bad }).saveSyncMode).toBe('none')
    }
  })
})

describe('saveSettings：走 dispatcher 的那一段', () => {
  test('设置 manual → snapshot 里读回来是 manual', async () => {
    const dispatcher = createDispatcher({ host })
    const snap = (await dispatcher.dispatch('saveSettings', { saveSyncMode: 'manual' }, signal())) as Snap
    expect(snap.settings.saveSyncMode).toBe('manual')
  })

  test('改回 none → 读回来是 none', async () => {
    const dispatcher = createDispatcher({ host })
    await dispatcher.dispatch('saveSettings', { saveSyncMode: 'manual' }, signal())
    const snap = (await dispatcher.dispatch('saveSettings', { saveSyncMode: 'none' }, signal())) as Snap
    expect(snap.settings.saveSyncMode).toBe('none')
  })

  test('⚠️ 传了个非字符串 → 不报错，落回 none（不弄坏设置页）', async () => {
    const dispatcher = createDispatcher({ host })
    const snap = (await dispatcher.dispatch('saveSettings', { saveSyncMode: 123 }, signal())) as Snap
    expect(snap.settings.saveSyncMode).toBe('none')
  })

  test('⚠️ 不认识的字符串 → 静默 none（**不 throw**，与语言偏好的显式报错刻意不同）', async () => {
    const dispatcher = createDispatcher({ host })
    const snap = (await dispatcher.dispatch(
      'saveSettings',
      { saveSyncMode: 'third-party-cloud' },
      signal()
    )) as Snap
    expect(snap.settings.saveSyncMode).toBe('none')
  })

  test('落盘真的写进了 global-settings.json（不是只在内存里）', async () => {
    const dispatcher = createDispatcher({ host })
    await dispatcher.dispatch('saveSettings', { saveSyncMode: 'manual' }, signal())
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'global-settings.json'), 'utf8')) as Record<string, unknown>
    expect(raw.saveSyncMode).toBe('manual')
  })

  test('改这个设置不影响其它设置（白名单里没有漏项）', async () => {
    const dispatcher = createDispatcher({ host })
    await dispatcher.dispatch('saveSettings', { listView: true }, signal())
    const before = ((await dispatcher.dispatch('snapshot', {}, signal())) as Snap).settings as Record<string, unknown>
    await dispatcher.dispatch('saveSettings', { saveSyncMode: 'manual' }, signal())
    const snap = (await dispatcher.dispatch('snapshot', {}, signal())) as Snap
    expect(snap.settings.saveSyncMode).toBe('manual')
    expect((snap.settings as Record<string, unknown>).listView).toBe(before.listView)
  })
})
