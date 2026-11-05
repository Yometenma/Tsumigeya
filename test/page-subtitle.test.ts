// 页面副标题的守卫（用户 2026-11-05 提的「其余 UI 观感」里的一处真问题）。
//
// ===== 这条防什么 =====
//
// 设置页的副标题原来是 `<p class="page-subtitle">{{ t('app.tagline') }}</p>`
// —— 直接把品牌标语（「DLsite 游戏启动器」）复述一遍。
// 表现是：点进设置页，标题下面那行字与应用名一样，**零新信息**。
//
// 这种"占位文案"没有任何检查会红：tsc 过、build 过、单测过（i18n 键确实存在）。
// 用户不会来报"副标题是废话"，他只会觉得这个页面粗糙。
//
// 所以判据钉在源码级：**页面副标题不许直接复用 `app.tagline`**，
// 且用到 `settings.subtitle` 时必须带 `{path}` 参数（它的信息量就来自那个路径）。
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = path.join(process.cwd(), 'src', 'renderer', 'src')
const LANGS = ['zh-CN'] as const

function readPage(relative: string): string {
  return fs.readFileSync(path.join(SRC, relative), 'utf8')
}

describe('★ 页面副标题要有信息量（不许复述应用名）', () => {
  test('SettingsPage 的副标题不许是 app.tagline', () => {
    const sfc = readPage('pages/SettingsPage.vue')
    expect(sfc, '设置页副标题又写回品牌标语了（那是零信息的占位）').not.toMatch(
      /class="page-subtitle"[^>]*>\s*\{\{ t\('app\.tagline'\)/s
    )
  })

  test('SettingsPage 用的是 settings.subtitle，且带 {path} 参数', () => {
    const sfc = readPage('pages/SettingsPage.vue')
    expect(sfc).toMatch(/t\('settings\.subtitle'/)
    // 参数缺了的话 vue-i18n 会把 `{path}` 原样画出来（不报错）
    expect(sfc, 'settings.subtitle 少了 path 参数会原样画出 {path}').toMatch(
      /t\('settings\.subtitle',\s*\{\s*path:/
    )
  })

  test('settings.subtitle 在每个语言里都存在，且含 {path} 占位', () => {
    for (const lang of LANGS) {
      const locales = JSON.parse(
        fs.readFileSync(path.join(SRC, 'locales', `${lang}.json`), 'utf8')
      ) as Record<string, Record<string, unknown>>
      const subtitle = (locales.settings as Record<string, unknown>).subtitle
      expect(typeof subtitle, `${lang}: settings.subtitle 不存在`).toBe('string')
      expect(subtitle as string, `${lang}: settings.subtitle 必须含 {path}`).toContain('{path}')
    }
  })
})
