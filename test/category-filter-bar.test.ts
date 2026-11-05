// M5.0 S12：分类从侧边栏搬到库页顶部的**结构守卫**。
//
// ===== 这条为什么必须有 =====
//
// 「分类在哪」这件事**没有任何自动检查会红**：
//   · 把它从侧边栏删掉、却忘了接到库页 → 分类功能整个消失，
//     typecheck / build / 全部单测**全绿**（组件没人 import 就是死代码，tsc 不报）
//   · 接到了库页、但侧边栏那份没删 → 两个入口共享同一个 `library.categoryFilter`，
//     表现是"点侧边栏的分类，库页顶部的 chip 也变了"，双倍困惑
//
// 这正是用户 2026-11-05 报的那件事的结构面。所以判据只能是源码级的：
//   ① 库页**必须**渲染 <CategoryFilterBar>；
//   ② App.vue **不许**再出现分类相关的模板/方法（'categoriesVisible' / selectCategory…）；
//   ③ 侧边栏的 SIDEBAR_PARTS 里不许再有 'categories'（那条在 sidebar-collapse.test.ts）；
//   ④ 筛选栏用到的 i18n 键必须真的存在（vue-i18n 查不到会**原样画出 key**，不报错）。
//
// 与 `edit-page-sections.test.ts` 是同一取向（那边管「import 了但没渲染」）。
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const ROOT = process.cwd()
const SRC = path.join(ROOT, 'src', 'renderer', 'src')

/**
 * 取 SFC 的 `<template>` 段。
 *
 * ⚠️ 必须用 lastIndexOf（AGENTS.md 已知坑：具名插槽 `<template #title>`
 * 会让第一个 `</template>` 提前截断 → 判据假绿）。
 */
function templateOf(sfc: string): string {
  const open = sfc.indexOf('<template')
  const close = sfc.lastIndexOf('</template>')
  if (open < 0 || close < 0) throw new Error('SFC 里找不到 template 段')
  return sfc.slice(sfc.indexOf('>', open) + 1, close)
}

function readFile(relative: string): string {
  return fs.readFileSync(path.join(SRC, relative), 'utf8')
}

describe('★ 分类筛选栏必须接在库页上', () => {
  test('LibraryPage 必须 import 并渲染 <CategoryFilterBar>（删了侧边栏却没接 = 功能消失）', () => {
    const sfc = readFile('pages/LibraryPage.vue')
    const tpl = templateOf(sfc)
    expect(sfc, 'LibraryPage 没有 import CategoryFilterBar').toMatch(
      /import\s+CategoryFilterBar\s+from\s+'@\/components\/CategoryFilterBar\.vue'/
    )
    // 真实渲染（不是只在注释里出现）：必须有 <CategoryFilterBar 开标签
    expect(tpl, 'LibraryPage 模板里没有渲染 CategoryFilterBar').toMatch(/<CategoryFilterBar\b/)
  })

  test('筛选栏在**标题下方、搜索工具条上方**（顺序不对就等于没有入口）', () => {
    // 用户的原话是「库页上方出现一条横向分类筛选栏」。
    // 这条只钉相对顺序：分类 chip 必须出现在 .toolbar 之前 ——
    // 否则会出现"先搜关键词、再选分类把搜索结果的语境换掉"的困惑。
    const tpl = templateOf(readFile('pages/LibraryPage.vue'))
    const barAt = tpl.indexOf('<CategoryFilterBar')
    const toolbarAt = tpl.indexOf('class="toolbar"')
    expect(barAt, '模板里找不到 <CategoryFilterBar>').toBeGreaterThan(-1)
    expect(toolbarAt, '模板里找不到 .toolbar').toBeGreaterThan(-1)
    expect(barAt, '分类筛选栏必须排在搜索工具条前面').toBeLessThan(toolbarAt)
  })

  test('★ App.vue 里不许再有任何分类代码（否则两个入口共享一份筛选状态）', () => {
    const sfc = readFile('App.vue')
    for (const token of [
      'categoriesVisible',
      'selectCategory',
      'startCreateCategory',
      'submitCreateCategory',
      'renameCategory',
      'deleteCategory',
      'onCategoryMenu',
      'countInCategory',
      'app-categories',
      'UNCATEGORIZED_ID'
    ]) {
      expect(sfc, `App.vue 里还有分类代码残留：${token}（分类应只在 CategoryFilterBar 里）`).not.toContain(
        token
      )
    }
  })
})

describe('★ CategoryFilterBar 自身', () => {
  const sfc = readFile('components/CategoryFilterBar.vue')

  test('「全部 / 未分类 / 用户分类」三档都在，且点选都接到 setCategoryFilter', () => {
    const tpl = templateOf(sfc)
    expect(tpl, '缺「全部」').toMatch(/t\('category\.all'\)/)
    expect(tpl, '缺「未分类」').toMatch(/t\('category\.uncategorized'\)/)
    // 用户分类的循环
    expect(tpl, '缺用户分类的 v-for').toMatch(/v-for="category in library\.categoryList"/)
    // 三档都必须真的能筛（selectCategory 是唯一入口）
    expect(tpl, '@click="selectCategory(null)"').toContain('selectCategory(null)')
  })

  test('多归属的判据来自 shared（不在模板/组件里重写筛选逻辑）', () => {
    // 筛选本身在 store（`matchesCategory` 是纯函数，有 46 条单测）。
    // 组件只负责**设置筛选值**，不许自己 filter 列表 —— 重写一份就会出现
    // 「chip 的计数按 A 判据、列表按 B 判据」这种对不上。
    expect(sfc, '组件不该自己 filter 游戏列表（判据在 shared/categories.ts）').not.toMatch(
      /\.filter\(\s*\(?game[^)]*\)?\s*=>\s*matchesCategory/
    )
  })

  test('删分类的确认文案必须说清「游戏不会被删」（D31）', () => {
    // 这条文案由 locales 提供，组件必须走 deleteConfirmWithGames / deleteConfirm
    expect(sfc).toMatch(/deleteConfirmWithGames/)
    expect(sfc).toMatch(/deleteConfirm/)
  })

  test('删掉正在筛的分类时要清筛选（否则筛一个不存在的分类 = 永远空列表）', () => {
    expect(sfc, '删除分类后没有清掉指向它的筛选').toMatch(/setCategoryFilter\(null\)/)
  })

  test('模板里的 @click 方法都在 script 里声明过（防死键）', () => {
    // 与 vue-handler-exists.test.ts 同一条判据，这里针对新组件单独钉一遍：
    // 新组件是新写的，最容易被"忘了声明"的正是它的按钮。
    const tpl = templateOf(sfc)
    const script = sfc.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1] ?? ''
    const declared = new Set<string>()
    for (const m of script.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) declared.add(m[1]!)
    for (const m of script.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/g)) declared.add(m[1]!)
    const used = new Set<string>()
    for (const m of tpl.matchAll(/@[\w:.-]+(?:\.\w+)*="([A-Za-z_$][\w$]*)\s*(?:\()/g)) used.add(m[1]!)
    const missing = [...used].filter((name) => !declared.has(name))
    expect(missing, `筛选栏模板引用了不存在的处理函数：${missing.join(', ')}`).toEqual([])
  })
})

describe('★ 用到的 i18n 键真的存在（查不到会原样画出 key 原文，不报错）', () => {
  const locales = JSON.parse(
    fs.readFileSync(path.join(SRC, 'locales', 'zh-CN.json'), 'utf8')
  ) as Record<string, Record<string, unknown>>

  test('category.* 文案齐全', () => {
    const category = locales.category as Record<string, unknown>
    for (const key of [
      'all',
      'uncategorized',
      'create',
      'namePlaceholder',
      'nameRequired',
      'created',
      'renamed',
      'renameTitle',
      'renamePrompt',
      'rename',
      'delete',
      'deleteTitle',
      'deleteConfirm',
      'deleteConfirmWithGames',
      'deleted'
    ]) {
      expect(typeof category[key], `category.${key} 在 locales 里不存在`).toBe('string')
    }
  })

  test('library.moreActions 仍然存在（⋯ 的提示文案）', () => {
    const library = locales.library as Record<string, unknown>
    expect(typeof library.moreActions).toBe('string')
  })

  test('category.sidebarTitle 已随侧边栏一起删除（留着就是给"加回去"铺路）', () => {
    const category = locales.category as Record<string, unknown>
    expect(category.sidebarTitle, 'categories 已不在侧边栏，这个键该删').toBeUndefined()
  })
})
