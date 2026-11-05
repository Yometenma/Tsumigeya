/**
 * M5.5：侧边栏折叠的判据（纯函数 + 纯数据，零依赖）。
 *
 * ===== 为什么要单独抽一个文件 =====
 *
 * 「侧边栏能折叠」看起来只是两个 CSS 宽度加一个布尔，但它有一条**不报错**的坑：
 *
 *     折叠状态下侧边栏只剩一条 icon，**分类区（用户的整理体系）必须一起收起**。
 *
 * 如果只把宽度改窄、不收起分类区与文字，结果是：
 *   · 208px 的侧边栏压到 56px，分类名 / 计数 / 「新建分类」全部溢出或被裁掉
 *   · 页面**照常渲染、不报任何错** —— 只是变得没法用
 *
 * 所以「折叠时哪些块该隐藏」写成**数据**（`SIDEBAR_PARTS`），
 * 再用单测核对「每个侧边栏块都恰好被归到某一边」，漏一个就红。
 * 与 D68 同一取向（只删不守 = 迟早复发）。
 *
 * ⚠️ 零依赖：不 import vue / i18n / api-client。
 * 宽度与文案在外面（CSS 变量 / locales），这里只描述**结构**。
 */

/** 展开 / 折叠两种状态的侧边栏宽度（px）。 */
export const SIDEBAR_WIDTH = {
  expanded: 208,
  collapsed: 56
} as const

/** 侧边栏里的一块区域。 */
export type SidebarPart =
  /** 品牌名 + 副标题（"Tsumigeya" / tagline） */
  | 'brand'
  /** 三个导航项的**图标**（折叠态唯一还显示的东西） */
  | 'navIcon'
  /** 三个导航项的**文字标签**（折叠态收起，图标仍在） */
  | 'navLabel'
  /** 分类区（用户的整理体系，含新建分类） */
  | 'categories'
  /** 底部的版本号 / 平台信息 */
  | 'footer'

/**
 * 折叠时**必须收起**的块。
 *
 * 判据：这些内容在 56px 宽度里放不下（文字会溢出/被裁），
 * 而且折叠态的意义是「只留图标，把空间还给内容区」。
 *
 * ⚠️ 注意 `navLabel` 与 `brand` 都在里面：折叠后只留图标。
 * 图标本身靠 `title` 提供提示（见 App.vue 的 `title` 绑定）。
 */
export const SIDEBAR_HIDDEN_WHEN_COLLAPSED: readonly SidebarPart[] = [
  'brand',
  'navLabel',
  'categories',
  'footer'
]

/**
 * 折叠时**仍然显示**的块 —— 由「哪些要隐藏」反推。
 *
 * 为什么是个函数而不是再手写一份常量：两份手写清单迟早对不上
 * （那正是 `sidebarPartVisible` 要避免的错误类型）。导出它是给单测核对
 * 「隐藏 ∪ 显示 == 全部」用的。
 */
export function sidebarPartsVisibleWhenCollapsed(): readonly SidebarPart[] {
  return SIDEBAR_PARTS.filter((part) => sidebarPartVisible(part, true))
}

/**
 * 全部侧边栏块（用于单测核对「没有块被漏掉」）。
 *
 * ⚠️ 这是**结构清单**：新增一块侧边栏内容时必须同时决定它在折叠态显示还是隐藏，
 * 否则 `sidebarPartCoverage` 那条测试会红。
 */
export const SIDEBAR_PARTS: readonly SidebarPart[] = [
  'brand',
  'navIcon',
  'navLabel',
  'categories',
  'footer'
]

/**
 * 某个块在**指定折叠态**下该不该显示。
 *
 * 模板里只调这个（不内联 `collapsed && part !== 'navIcon'` 那种表达式 ——
 * 模板禁复杂表达式，AGENTS.md 已知坑）。
 */
export function sidebarPartVisible(part: SidebarPart, collapsed: boolean): boolean {
  if (!collapsed) return true
  return !SIDEBAR_HIDDEN_WHEN_COLLAPSED.includes(part)
}

/**
 * 折叠态下侧边栏的宽度（px）。
 *
 * 为什么做成函数而不是在模板里写三元：宽度要同时给 `width` 与 `flex-basis`
 * 两处用，模板里算两遍容易写错一处（而写错只表现为"宽度变了但没变全"）。
 */
export function sidebarWidth(collapsed: boolean): number {
  return collapsed ? SIDEBAR_WIDTH.collapsed : SIDEBAR_WIDTH.expanded
}

/**
 * 折叠/展开按钮的无障碍标签键（i18n key，文案在 locales）。
 *
 * 折叠时按钮的作用是「展开」，展开时是「收起」——
 * 与图标（Menu ←→ X）表达的是**同一件事**，但两者方向相反：
 *   · 图标：折叠后显示 X（"点我可以关掉这个面板"）
 *   · 标签：折叠后是"展开侧边栏"（读屏用户需要的是**动作**）
 * 这个容易搞反，所以放在一个有单测的地方。
 */
export function sidebarToggleLabelKey(collapsed: boolean): string {
  return collapsed ? 'nav.expandSidebar' : 'nav.collapseSidebar'
}
