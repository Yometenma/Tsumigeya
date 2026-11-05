/**
 * M5.5：图标体系的**唯一入口**（Lucide + Morphicons）。
 *
 * ===== 这个文件为什么存在 =====
 *
 * 换了图标体系之后有一个隐蔽的分叉，必须在一处收口：
 *
 *     Lucide 的 npm 包给的是**组件**（`<Gamepad2 />`），
 *     Morphicons 要的是**数据**（`IconNode`：`[tag, attrs][]`）。
 *
 * 如果各自文件里各写一遍（一半写组件、一半写数据），就会有两份图标的几何定义：
 * 有人改了一处觉得"图标换了个样子"，另一处没变 —— 而且**不会报错**。
 * 所以：
 *
 *   · 本文件是**图标几何的唯一来源**（每个图标只有一条定义）
 *   · 组件与数据都从这里派生（`ICON_COMPONENTS` / `MORPH_ICONS`）
 *   · 有单测拿 `lucide-vue-next` 包里的真实数据逐字节比对（包一升级就红）
 *
 * ===== 为什么数据是「手抄常量」而不是从组件里抠 =====
 *
 * lucide 的每个图标是 `(props, ctx) => h(Icon, { iconNode, name })` 的函数式组件，
 * IconNode 只在 vnode.props 上露一次（闭包里）。理论上能 `component({}, {slots:{}})`
 * 抠出来 —— 本鱼试过，**能用**。但那是在赌 lucide 的内部实现细节：
 * 它换个写法（比如改成 `defineComponent` + setup 返回 props）就会静默变成
 * `undefined`，而 `MorphIcon icon={undefined}` 只是**不画**，不报错（白屏级故障）。
 *
 * 手抄常量 + 「与包内数据深比对」的单测是更稳的组合：
 *   · 跑起来完全不依赖 lucide 的内部结构（只依赖它导出的**名字**）
 *   · 一旦包里的几何变了，测试当场变红并指出该抄什么（而不是悄悄变形）
 *
 * ⚠️ 零依赖：不 import vue / 不 import morphicons。
 *   它只描述"图标长什么样"，不关心谁去渲染。
 */

/** Lucide 的图标节点（与 `morphicons` 的 `IconNode` 结构同形，见 §类型）。 */
export type IconNodeAttr = Record<string, string | number>
export type IconNode = ReadonlyArray<readonly [string, IconNodeAttr]>

/**
 * 图标名 → IconNode。
 *
 * 每个图标的 `kind` 决定它**怎么被用**：
 *   · `component`：一次性动作/纯装饰，用 `LucideIcon` 直接画
 *   · `morph`：同一个按钮有**两种状态**时才用 `MorphIcon`
 *
 * ⚠️ 只在「同一个按钮有两种状态」处用 morph（方案 §5 的使用原则）：
 * 菜单←→X / 播放←→停止 / 展开←→收起。一次性动作按钮（添加游戏、删除）
 * 变形**没有信息价值**，硬塞是滥用。
 */
export const ICON_NODES = {
  // ===== 有状态的（可 morph）=====
  /** 侧边栏折叠：展开中（可以收起） */
  Menu: [['path', { d: 'M4 5h16' }], ['path', { d: 'M4 12h16' }], ['path', { d: 'M4 19h16' }]],
  /** 侧边栏折叠：已收起（可以展开） */
  X: [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]],
  /** 游戏：可启动 */
  Play: [['path', { d: 'M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z' }]],
  /** 游戏：运行中（停止） */
  Square: [['rect', { width: '18', height: '18', x: '3', y: '3', rx: '2' }]],
  /** 简介折叠：展开 */
  ChevronDown: [['path', { d: 'm6 9 6 6 6-6' }]],
  /** 简介折叠：收起 */
  ChevronUp: [['path', { d: 'm18 15-6-6-6 6' }]],

  // ===== 一次性动作 / 导航（只画，不 morph）=====
  /** 卡片与列表行的 ⋯ 菜单（原 MoreFilled） */
  Ellipsis: [['circle', { cx: '12', cy: '12', r: '1' }], ['circle', { cx: '19', cy: '12', r: '1' }], ['circle', { cx: '5', cy: '12', r: '1' }]],
  /** 详情页返回（原 ArrowLeft） */
  ArrowLeft: [['path', { d: 'm12 19-7-7 7-7' }], ['path', { d: 'M19 12H5' }]],
  /** 重新获取元数据（原 Refresh） */
  RefreshCw: [
    ['path', { d: 'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8' }],
    ['path', { d: 'M21 3v5h-5' }],
    ['path', { d: 'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16' }],
    ['path', { d: 'M8 16H3v5' }]
  ],
  /** 侧边栏：游戏库（替代 emoji 🎮） */
  Gamepad2: [
    ['line', { x1: '6', x2: '10', y1: '11', y2: '11' }],
    ['line', { x1: '8', x2: '8', y1: '9', y2: '13' }],
    ['line', { x1: '15', x2: '15.01', y1: '12', y2: '12' }],
    ['line', { x1: '18', x2: '18.01', y1: '10', y2: '10' }],
    [
      'path',
      {
        d:
          'M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z'
      }
    ]
  ],
  /** 侧边栏：引擎管理（替代 emoji ⚙️） */
  Settings: [
    [
      'path',
      {
        d:
          'M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915'
      }
    ],
    ['circle', { cx: '12', cy: '12', r: '3' }]
  ],
  /** 侧边栏：设置（替代 emoji 🛠️） */
  Wrench: [
    [
      'path',
      {
        d:
          'M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z'
      }
    ]
  ]
} as const satisfies Record<string, IconNode>

/** 图标名（本文件定义的每一个）。 */
export type IconName = keyof typeof ICON_NODES

/**
 * 同一个按钮的**两种状态**：状态 A ↔ 状态 B。
 *
 * 这是 morph 的判据本身 —— 一对图标代表一个布尔状态，而不是两个动作。
 * 新增一对时**先问自己**：这是同一个按钮的两种状态，还是两个一次性动作？
 * 后者不该用 morph（方案 §5「硬塞是滥用」）。
 */
export const MORPH_PAIRS = {
  /** 侧边栏折叠开关：展开中 Menu ←→ 已收起 X */
  sidebarCollapse: ['Menu', 'X'],
  /** 启动/停止：可启动 Play ←→ 运行中 Square */
  launch: ['Play', 'Square'],
  /** 简介折叠：收起 ChevronDown ←→ 展开 ChevronUp */
  summary: ['ChevronDown', 'ChevronUp']
} as const satisfies Record<string, readonly [IconName, IconName]>

/** 一对 morph 的名字。 */
export type MorphPairName = keyof typeof MORPH_PAIRS

/**
 * 取某个命名 morph 在**指定状态**下该显示的图标数据。
 *
 * 为什么做成纯函数（而不是在两个模板里各写一个三元表达式）：
 *   · 模板里写 `pair[a] : pair[b]` 需要下标运算 —— 模板禁复杂表达式（AGENTS.md 已知坑）
 *   · 状态与图标的**对应关系**是判据，判据要有单测（`morphPair` 就是那个可测点）
 *
 * @param name 哪个 morph
 * @param second true = 状态 B（收起 / 运行中 / 已展开），false = 状态 A
 */
export function morphIcon(name: MorphPairName, second: boolean): IconNode {
  const [first, other] = MORPH_PAIRS[name]
  return second ? ICON_NODES[other] : ICON_NODES[first]
}

/** 一个图标的类型（决定谁去渲染它）。 */
export type IconKind =
  /** 一次性动作/纯装饰：用 `LucideIcon` 画（不进 morph 管线） */
  | 'component'
  /** 有状态的：可以进 `MorphIcon` */
  | 'morph'

/** 只画不 morph 的图标（`component` 类）。 */
export const STATIC_ICON_NAMES = ['Ellipsis', 'ArrowLeft', 'RefreshCw', 'Gamepad2', 'Settings', 'Wrench'] as const satisfies readonly IconName[]

/** 可 morph 的图标（`MORPH_PAIRS` 里出现过的每一个）。 */
export const MORPH_ICON_NAMES = Array.from(
  new Set(Object.values(MORPH_PAIRS).flat())
) as readonly IconName[]

/** 图标归类（用于单测核对「没有图标被两边都算上/两边都漏掉」）。 */
export function iconKind(name: IconName): IconKind {
  return (MORPH_ICON_NAMES as readonly string[]).includes(name) ? 'morph' : 'component'
}

/** 全部图标名（按定义顺序）。 */
export const ALL_ICON_NAMES = Object.keys(ICON_NODES) as readonly IconName[]
