// M5.5 单测：侧边栏折叠的判据。
//
// ===== 这个文件要防的是什么 =====
//
// 「侧边栏能折叠」看起来只是两个宽度 + 一个布尔，但它有一条**完全不报错**的坑：
//
//     折叠后只把宽度改窄、没把内容一起收起 → 分类名 / 计数 / 「新建分类」
//     全部溢出或被裁掉。页面照常渲染、typecheck / build / 其它测试全绿，
//     只是界面变得没法用。
//
// 所以「折叠时哪些块该隐藏」被写成**数据**（SIDEBAR_HIDDEN_WHEN_COLLAPSED），
// 再用判据核对「每个侧边栏块都恰好被归到显示/隐藏其中一边」。
// 新增一块侧边栏内容却忘了归类 → 这条测试红（D68 同一取向）。
//
// 另一半是**方向**容易搞反的地方：
//   · 图标：折叠后显示 X（"我可以关掉"）
//   · 无障碍标签：折叠后是"展开侧边栏"（读屏用户要的是**动作**）
// 两者互补而不是相同 —— 搞反了读屏用户听到的指令就是错的，且肉眼看不出来。
import { describe, expect, test } from 'vitest'
import {
  SIDEBAR_HIDDEN_WHEN_COLLAPSED,
  SIDEBAR_PARTS,
  SIDEBAR_WIDTH,
  sidebarPartVisible,
  sidebarPartsVisibleWhenCollapsed,
  sidebarToggleLabelKey,
  sidebarWidth,
  type SidebarPart
} from '../src/shared/sidebar-collapse'

describe('★ 折叠态：哪些块该收起（漏一个就溢出，而且不报错）', () => {
  test('折叠态只剩导航图标（图标就是折叠后唯一的导航）', () => {
    expect(sidebarPartsVisibleWhenCollapsed()).toEqual(['navIcon'])
  })

  test('品牌行、导航文字、分类区、页脚全部收起', () => {
    for (const part of ['brand', 'navLabel', 'categories', 'footer'] as SidebarPart[]) {
      expect(sidebarPartVisible(part, true), `${part} 在折叠态应该是隐藏的`).toBe(false)
    }
  })

  test('展开态**所有**块都显示（折叠只是收，不是删）', () => {
    for (const part of SIDEBAR_PARTS) {
      expect(sidebarPartVisible(part, false), `${part} 在展开态应该显示`).toBe(true)
    }
  })

  test('每个侧边栏块恰好归到一边：隐藏 ∪ 显示 == 全部（不重不漏）', () => {
    const shown = sidebarPartsVisibleWhenCollapsed()
    const hidden = SIDEBAR_HIDDEN_WHEN_COLLAPSED
    const union = new Set([...shown, ...hidden])
    expect(
      [...SIDEBAR_PARTS].filter((part) => !union.has(part)),
      '这些块没被归到显示/隐藏任何一边（折叠时行为未定义）'
    ).toEqual([])
    expect(union.size, '有块被同时归到了显示与隐藏').toBe(SIDEBAR_PARTS.length)
  })

  test('分类区必须在隐藏清单里（它是最容易被忘掉的那一块）', () => {
    // 这一条的独立价值：分类区是后加的（M5.0 S7），折叠是 M5.5 ——
    // 后加的功能最容易被忘。"分类区收不收"这件事单独钉一条，
    // 免得上面那条"不重不漏"被顺手改成两遍都符合的形式而失去意义。
    expect(SIDEBAR_HIDDEN_WHEN_COLLAPSED).toContain('categories')
  })
})

describe('★ 宽度', () => {
  test('展开 208 / 折叠 56（折叠态要能放下一列图标 + 内边距）', () => {
    expect(SIDEBAR_WIDTH.expanded).toBe(208)
    expect(SIDEBAR_WIDTH.collapsed).toBe(56)
  })

  test('sidebarWidth 按折叠态给出正确值', () => {
    expect(sidebarWidth(false)).toBe(208)
    expect(sidebarWidth(true)).toBe(56)
  })

  test('折叠一定比展开窄（反过来就是 bug）', () => {
    expect(SIDEBAR_WIDTH.collapsed).toBeLessThan(SIDEBAR_WIDTH.expanded)
  })

  test('折叠宽度容得下 18px 图标 + 两侧内边距（56 - 12*2 = 32 > 18）', () => {
    // 内边距是 .app-sidebar 的 12px（styles/main.css）
    expect(SIDEBAR_WIDTH.collapsed - 12 * 2).toBeGreaterThanOrEqual(18)
  })
})

describe('★ 无障碍标签的方向（与图标互补，容易搞反）', () => {
  test('已折叠 → 按钮的动作是"展开"', () => {
    expect(sidebarToggleLabelKey(true)).toBe('nav.expandSidebar')
  })

  test('未折叠 → 按钮的动作是"收起"', () => {
    expect(sidebarToggleLabelKey(false)).toBe('nav.collapseSidebar')
  })

  test('两个键不重复（否则读屏用户永远听到同一句）', () => {
    expect(sidebarToggleLabelKey(true)).not.toBe(sidebarToggleLabelKey(false))
  })
})
