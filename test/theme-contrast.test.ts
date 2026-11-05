// 主题可读性的两条守卫（用户 2026-11-05 实测报「浅色模式看不清楚了」）。
//
// ===== 为什么需要 =====
//
// ① **对比度不合格不会报任何错**。`--tsmg-text-dim` 原来用 `#909399`：
//    浅色底下只有 **2.87:1**，而这个变量在 30 多处用到（hint / 说明 / 副标题）。
//    表现是「字看得见但很费眼」——用户不会说"对比度不达标"，只会说"看不清"。
//
// ② **CSS 花括号不平衡也不会报错**。曾出现过两个连续的 `:root {`（多出来的那个
//    没有对应的 `}`），这会让**后面所有规则**的解析跟着错位 ——
//    而 CSS 的容错是"静默丢弃看不懂的部分"，所以页面只是"有点怪"。

import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const CSS = path.join(process.cwd(), 'src', 'renderer', 'src', 'styles', 'main.css')

/** WCAG 相对亮度（sRGB，去掉 alpha）。 */
function luminance(hex: string): number {
  const m = hex.replace('#', '').match(/../g)
  if (!m || m.length < 3) throw new Error(`不是 6 位十六进制色：${hex}`)
  const [r, g, b] = m.slice(0, 3).map((h) => {
    const v = parseInt(h, 16) / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** 两色的对比度（1–21）。 */
function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** 从 CSS 里读出某个主题块的变量（简单的 `--name: #hex;` 提取）。 */
function themeVars(css: string, blockStart: string): Record<string, string> {
  const start = css.indexOf(blockStart)
  if (start < 0) throw new Error(`找不到主题块 ${blockStart}`)
  const end = css.indexOf('\n}', start)
  const body = css.slice(start, end)
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/(--[a-z-]+):\s*(#[0-9a-fA-F]{6})/g)) {
    out[m[1]] = m[2]
  }
  return out
}

describe('主题可读性', () => {
  const css = fs.readFileSync(CSS, 'utf8')
  const light = themeVars(css, ':root {')
  const dark = themeVars(css, 'html.dark {')

  test('CSS 花括号必须平衡（不平衡 = 后面所有规则错位，而且不报错）', () => {
    const open = (css.match(/\{/g) ?? []).length
    const close = (css.match(/\}/g) ?? []).length
    expect(open, `{ 与 } 数量不等（${open} vs ${close}）`).toBe(close)
  })

  test('★ 浅色：正文与次要文字都 >= 4.5:1（WCAG AA）', () => {
    // 用最常见的两个背景：页面底 #f6f7f9 与面板 #ffffff
    const backgrounds = [light['--tsmg-bg'], light['--tsmg-panel']]
    for (const bg of backgrounds) {
      expect(contrast(light['--tsmg-text'], bg), `浅色正文 on ${bg}`).toBeGreaterThanOrEqual(4.5)
      // 这一条是用户报的那个："浅色模式看不清楚"
      expect(contrast(light['--tsmg-text-dim'], bg), `浅色次要文字 on ${bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  test('★ 深色：正文与次要文字同样 >= 4.5:1', () => {
    const backgrounds = [dark['--tsmg-bg'], dark['--tsmg-panel']]
    for (const bg of backgrounds) {
      expect(contrast(dark['--tsmg-text'], bg), `深色正文 on ${bg}`).toBeGreaterThanOrEqual(4.5)
      expect(contrast(dark['--tsmg-text-dim'], bg), `深色次要文字 on ${bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  test('两套主题都必须定义全部核心变量（漏一个会回落到继承值，颜色就乱了）', () => {
    for (const name of ['--tsmg-bg', '--tsmg-panel', '--tsmg-text', '--tsmg-text-dim']) {
      expect(light[name], `:root 缺 ${name}`).toBeTruthy()
      expect(dark[name], `html.dark 缺 ${name}`).toBeTruthy()
    }
  })
})
