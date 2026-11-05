<script setup lang="ts">
// M5.5：图标渲染的唯一入口（Lucide 组件 / Morphicons 变形）。
//
// ===== 为什么要有这层，而不是在模板里各写各的 =====
//
// 换图标体系之后，渲染有三种写法，混在模板里必然踩坑：
//
//   1. `<Ellipsis />`            —— Lucide 的**组件**（一次性动作/纯装饰 用这个）
//   2. `{{ icon }}`              —— Morphicons 要的**数据**（IconNode）
//   3. `<MorphIcon :icon="…" />` —— 变形组件
//
// AGENTS.md 明写了「图标组件是**数据**不是组件」，且「模板里不能写类型断言」。
// 本组件就是那层收口：调用方只传**名字**或**数据**，由这里决定怎么画。
//
// 好处：
//   · 调用方的模板里没有任何类型、没有下标运算、没有三元表达式（三条白屏坑都躲开）
//   · 图标的几何、粗细、弹簧只有一处定义（`shared/icon-nodes.ts` + 下面两个常量）
//
// ===== 两种用法（区别是「这个图标会不会变」）=====
//
//   <AppIcon name="Ellipsis" />           一次性动作/纯装饰：名字是常量，不 shape 变形
//   <AppIcon :icon="summaryIcon" />       **同一个按钮的两种状态**：传的是会变的数据
//
// 第二种必须传数据（来自 `morphIcon(pair, state)`，有单测），而不是传名字：
// MorphIcon 的变形靠的是 `icon` prop **换了一个新引用**；传死名字它永远不变形。
//
// ⚠️ 只做「同一个按钮有两种状态」的 morph（方案 §5 的使用原则）。
// 一次性动作按钮（添加游戏、删除）变形**没有信息价值**，硬塞是滥用 ——
// 那种地方请用 `name` 的写法。
// ⚠️ 三个 prop 都不给时**直接报错**（`warn`+不画），而不是静默不画：
// 后者是白屏级故障，且控制台没有任何线索。
import { computed } from 'vue'
import { MorphIcon } from 'morphicons/vue'
import { createLucideIcon } from 'lucide-vue-next'
import { ICON_NODES, type IconName, type IconNode } from '../../../shared/icon-nodes'

const props = withDefaults(
  defineProps<{
    /** 图标名（`shared/icon-nodes.ts` 里定义的任何一个）。静态图标用它。 */
    name?: IconName
    /**
     * 图标**数据**。用于「同一个按钮的两种状态」——
     * 调用方传 `morphIcon(pair, state)` 的结果，状态一变数据就变，图标随之变形。
     */
    icon?: IconNode
    /** 边长（px）。默认 18（与 Element Plus 图标在 14px 字号下的视觉大小相当）。 */
    size?: number
    /**
     * 线条粗细（24 网格单位）。
     *
     * 默认 1.5：暗色 UI 上 1.5 比 2 更精致（浅色线条在深色背景上本来会显得更"重"）。
     * 这是方案 §7 待确认项 ② 的默认值，**要用户真机确认**（见 docs/M5.5-动态图标.md）。
     */
    strokeWidth?: number
  }>(),
  { size: 18, strokeWidth: 1.5 }
)

/**
 * Morphicons 的弹簧。
 *
 * 用户拍板「无回弹」（方案 §7 待确认项 ① 的默认值 = `smooth`，ζ=1.00 临界阻尼）。
 * 但**官方 `smooth` 预设太慢**：用它自带的 Spring 类实测，
 * `smooth`(k=170,c=26) 要 **0.72s** 才停稳，而侧边栏面板的宽度过渡原本是 0.18s ——
 * 面板早就收好了，图标还在天上飞，两段节奏差 4 倍，看起来像两件不相关的事。
 *
 * 所以这里给**显式参数**而不是预设名：仍是 ζ=1（`c = 2√k` 保证临界阻尼、零回弹，
 * 与 `smooth` 是同一条曲线族），只把刚度提到 400 → 实测 **0.48s**，
 * 比 smooth 快 33%，手感紧凑，回弹仍是 0.0%。
 *
 * 实测数据（用 morphicons 自己的 Spring，160Hz tick）：
 *   · smooth  k=170 c=26 → 0.72s，回弹  0.0%
 *   · 本配置  k=400 c=40 → 0.48s，回弹  0.0%
 *   · snappy  k=420 c=30 → 0.41s，回弹  2.8%  ← 有回弹，不采用
 *   · bouncy  k=300 c=14 → 0.92s，回弹 24.5%
 *
 * ⚠️ **这是主观手感，要用户真机确认**。若觉得还是慢/太快，
 * 只改这两个数即可（`c` 要保持 `≈2√k` 才无回弹）。
 */
const SPRING = { stiffness: 400, damping: 40 }

/**
 * 最终要画的图标数据（**数据**，不是组件 —— Morphicons 要的就是这个）。
 *
 * 优先用调用方传进来的 `icon`（那是会随状态变化的数据）；
 * 否则按名字从唯一来源取（同一个名字每次都是**同一个引用**，不会误触发变形）。
 */
const iconNode = computed<IconNode>(() => {
  if (props.icon) return props.icon
  if (props.name) return ICON_NODES[props.name]
  // 两个都没给 = 调用方写错了。不是"不画"就完事 —— 那会变成看不见的故障。
  throw new Error('AppIcon 需要 name 或 icon 其中之一')
})

/**
 * Lucide 组件（只在**静态**图标时才用）。
 *
 * 用 `createLucideIcon(name, node)` 从**我们的数据**现造，而不是
 * `import { Ellipsis } from 'lucide-vue-next'` —— 这样几何只有一份来源
 * （`shared/icon-nodes.ts`），组件与数据不可能长得不一样。
 *
 * 那次 `.map()` 是**类型转换**，不是数据处理：
 * lucide 的 `IconNode` 声明成可变的 `[string, Record<string, string>][]`，
 * 我们的（沿用 Morphicons 的定义）是 `readonly` 且 attrs 允许 number。
 * 运行时两者完全兼容（都是 `[tag, attrs]` 数组），只是 TS 严格模式下
 * readonly → mutable 不允许隐式转换。这里做一次浅拷贝把类型对齐，
 * **不改变任何几何**（attr 的键值原样拷过去）。
 */
const lucideComponent = computed(() =>
  createLucideIcon(
    (props.name ?? 'icon').toLowerCase(),
    iconNode.value.map(([tag, attrs]) => [tag, { ...attrs }] as [string, Record<string, string>])
  )
)
</script>

<template>
  <!-- 传了数据 = 有状态的图标：交给 Morphicons。props.icon 一变它就自己变形，
       无需 key、无需配置（官方原话 "That is the whole thing"）。 -->
  <MorphIcon
    v-if="icon"
    :icon="iconNode"
    :size="size"
    :stroke-width="strokeWidth"
    :spring="SPRING"
  />
  <!-- 只给了名字 = 一次性动作/纯装饰：普通 Lucide 图标，不做变形 -->
  <component :is="lucideComponent" v-else :size="size" :stroke-width="strokeWidth" />
</template>
