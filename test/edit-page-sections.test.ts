// 「组件被 import 了、但模板里没渲染」的守卫（M5.0 S11b 实测踩到）。
//
// ===== 为什么需要这条 =====
//
// S11b 把编辑页拆成 5 个组件时，`<GameInfoForm>` 那个 <section> **被整体删掉**，
// 但只是留下了一段注释。而：
//   · `import GameInfoForm` 还在 → tsc 不报「未使用」
//   · `infoForm` ref 还在        → 有引用
//   · 单测全绿、build 全绿
// 后果是**编辑页里再也找不到 DLsite**（RJ 输入 / 搜索 / 封面预览 / 标题来源全没了），
// 用户没法手动补或改元数据。这是 v0.6.1 用户实测报出来的。
//
// 所以要有这条：**模板里必须真的出现该元素**。
// 与 `vue-handler-exists.test.ts` 是同一取向（边界另一侧）：
//   那条管「模板引用的函数必须存在」，这条管「import 的组件必须在模板里出现」。

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const ROOT = process.cwd()
const EDIT_PAGE = path.join(ROOT, 'src', 'renderer', 'src', 'pages', 'GameEditPage.vue')

/**
 * 取 SFC 的 `<template>` 段。
 *
 * ⚠️ **必须用 lastIndexOf**（AGENTS.md 已知坑）：SFC 里可能有多个 `</template>`
 * （`<template #title>` 具名插槽），用 indexOf 取第一个会**提前截断**，
 * 于是「模板里有没有某元素」的判断会假绿/假红。
 */
function templateOf(sfc: string): string {
  const open = sfc.indexOf('<template>')
  const close = sfc.lastIndexOf('</template>')
  if (open < 0 || close < 0) throw new Error('SFC 里找不到 template 段')
  return sfc.slice(open + '<template>'.length, close)
}

describe('编辑页：import 过的区块组件必须真的渲染', () => {
  test('★ 回归：<GameInfoForm> 必须在模板里（S11b 曾把它删掉只剩注释）', () => {
    const sfc = fs.readFileSync(EDIT_PAGE, 'utf8')
    const tpl = templateOf(sfc)
    // 元素必须出现（不是只在注释里出现 —— 注释里的 `<GameInfoForm>` 也算匹配，
    // 所以额外要求「有 <GameInfoForm 且后面跟着 ref=」这种真实用法特征）
    expect(tpl).toMatch(/<GameInfoForm\b/)
    // 真实渲染的标志：至少带一个 :prop 绑定（只写个空标签不算接得上）
    expect(tpl).toMatch(/<GameInfoForm[\s\S]*?:initial-meta=|:game-path=/)
  })

  test('★ 每个 import 进来的 Section 组件都在模板里出现', () => {
    // 这条比上一条更泛化：拆组件时「import 了但没渲染」是同一类错误，
    // 只是 GameInfoForm 那次后果最严重（整个 DLsite 区块消失）才被发现。
    const sfc = fs.readFileSync(EDIT_PAGE, 'utf8')
    const tpl = templateOf(sfc)

    const imported = [...sfc.matchAll(/^import\s+(\w+)\s+from\s+'@\/components\/[^']+'/gm)]
      .map((m) => m[1])
      // 对话框类不算「区块」（它们由 v-model + 事件驱动，不总是渲染）
      .filter((name) => !/Dialog$/.test(name))

    expect(imported.length).toBeGreaterThanOrEqual(4) // 至少 4 个区块组件
    for (const name of imported) {
      expect(tpl, `组件 ${name} 被 import 了，但模板里没渲染`).toMatch(
        new RegExp(`<${name}\\b`)
      )
    }
  })

  test('DLsite 相关文案的 i18n 键存在（区块恢复了，键也得在）', () => {
    // 恢复区块时用到了 `game.identitySection` / `game.identitySectionHint`；
    // 若这两个键不存在，vue-i18n 会把 key **原样画出来**（不报错），
    // 用户看到的是 `game.identitySection` 这种字面文本。
    const locales = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'src', 'locales', 'zh-CN.json'), 'utf8')
    ) as Record<string, Record<string, unknown>>
    expect(locales.game).toHaveProperty('identitySection')
    expect(locales.game).toHaveProperty('identitySectionHint')
  })
})
