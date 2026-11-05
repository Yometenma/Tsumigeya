<script setup lang="ts">
// M5.5：侧边栏折叠按钮（**同一个按钮的两种状态** → morph 的典型用例）。
//
// ===== 为什么单独抽成组件 =====
//
// 这个按钮在 App.vue 里要出现在**两个位置**：
//   · 展开态：品牌行右侧（跟品牌名并排）
//   · 折叠态：独占一行（品牌行整块收起了，按钮不能跟着消失 —— 那就再也展开不回来）
//
// 两处 DOM 完全相同、只有外层的容器不同。如果各写一遍，就会出现「改一处忘一处」：
// 比如后来有人给按钮加了 aria 属性、改了图标大小，只改了其中一个 ——
// **这不会有任何报错**，也不会被任何测试发现（两处都还是"一个按钮"）。
//
// ⚠️ 图标是**数据**（IconNode），由父组件用 `morphIcon('sidebarCollapse', collapsed)` 算好传进来。
// 这个组件**不自己算图标**：图标随状态变化是"判据"，判据在 shared/icon-nodes.ts（有单测）。
// 传数据（而不是传名字）是 morph 能工作的前提 —— MorphIcon 靠 `icon` prop 换引用才变形。
import AppIcon from '@/components/AppIcon.vue'
import type { IconNode } from '../../../shared/icon-nodes'

defineProps<{
  /** 侧边栏是否已折叠（只用于 aria-expanded，不参与算图标）。 */
  collapsed: boolean
  /** 无障碍标签 / tooltip（折叠后是"展开侧边栏"，展开后是"收起侧边栏"）。 */
  label: string
  /**
   * 当前该显示的图标**数据**。
   *
   * ⚠️ 类型是这个 `IconNode`（来自 shared），不是 lucide 的那个 IconNode：
   * 两个包各自声明了一份、结构相同但 readonly 修饰不同，
   * 用 lucide 那份会让 `morphIcon()` 的返回值赋不进来。
   */
  icon: IconNode
}>()

defineEmits<{ toggle: [] }>()
</script>

<template>
  <!-- aria-expanded 表达的是"侧边栏当前是否展开"，与图标（Menu=展开中 / X=已收起）互补 -->
  <button
    type="button"
    class="app-sidebar-toggle"
    :title="label"
    :aria-label="label"
    :aria-expanded="!collapsed"
    @click="$emit('toggle')"
  >
    <AppIcon :icon="icon" :size="18" />
  </button>
</template>
