<script setup lang="ts">
// 侧边栏布局 + 路由出口 + 全局挂载 ProgressOverlay / CoreDialogHost（§4 App.vue）。
// 首次 snapshot 在这里拉取，并把 settings 同步给 settings store。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import AppIcon from '@/components/AppIcon.vue'
import SidebarToggle from '@/components/SidebarToggle.vue'
import ProgressOverlay from '@/components/ProgressOverlay.vue'
import CoreDialogHost from '@/components/CoreDialogHost.vue'
import { api, translateError } from '@/api/client'
import { morphIcon } from '../../shared/icon-nodes'
import {
  sidebarPartVisible,
  sidebarToggleLabelKey,
  sidebarWidth
} from '../../shared/sidebar-collapse'
import { useLibraryStore } from '@/stores/library'
import { useSettingsStore } from '@/stores/settings'
import { useEnginesStore } from '@/stores/engines'
import { useTaskStore } from '@/stores/task'
import { useCoreDialogsStore } from '@/stores/coreDialogs'

const { t } = useI18n()
const route = useRoute()
const library = useLibraryStore()
const settings = useSettingsStore()
const engines = useEnginesStore()
const task = useTaskStore()
const coreDialogs = useCoreDialogsStore()

// ===== M5.5：侧边栏折叠 =====
//
// 折叠态**只在内存里**：它是「我现在想多看点内容区」这个临时的视图选择，
// 不是用户配置。落盘会让"打开应用时侧边栏是收着的"变成一个需要解释的谜
// （用户忘了自己折过）。与 D50（进程状态只在内存）是同一取向：
// 临时的界面状态不该假装成持久偏好。
//
// ⚠️ 必须在任何 immediate watch 之前声明（本页没有 immediate watch，
// 但保持这个顺序，将来加的时候不会踩 TDZ）。
const sidebarCollapsed = ref(false)

/** 折叠开关。模板只调这个名字（不内联 `!sidebarCollapsed` 赋值）。 */
function toggleSidebar(): void {
  sidebarCollapsed.value = !sidebarCollapsed.value
}

/**
 * 侧边栏的折叠/展开**图标数据**（M5.5 的第一处 morph）。
 *
 * 这是「同一个按钮的两种状态」的典型：Menu（展开中，点了会收起）
 * ←→ X（已收起，点了会展开）。传**数据**给 AppIcon，状态一变就变形。
 */
const sidebarToggleIcon = computed(() => morphIcon('sidebarCollapse', sidebarCollapsed.value))

/** 折叠按钮的无障碍标签（折叠后动作变成"展开"，与图标方向相反，见 shared 模块）。 */
const sidebarToggleLabel = computed(() => t(sidebarToggleLabelKey(sidebarCollapsed.value)))

/** 侧边栏宽度（px，展开 208 / 折叠 56）。 */
const sidebarPx = computed(() => sidebarWidth(sidebarCollapsed.value))

/**
 * 各块在折叠态是否可见。
 *
 * 全部经 `sidebarPartVisible`（判据在 shared，有单测）——
 * 模板里不写 `collapsed && part !== ...` 这类表达式（禁复杂表达式）。
 */
const brandVisible = computed(() => sidebarPartVisible('brand', sidebarCollapsed.value))
const navLabelVisible = computed(() => sidebarPartVisible('navLabel', sidebarCollapsed.value))
const footerVisible = computed(() => sidebarPartVisible('footer', sidebarCollapsed.value))

/**
 * 品牌行的 class（展开态是 `app-brand` 横排，折叠态是 `app-brand-collapsed` 居中）。
 *
 * 做成 computed 而不是模板里写三元：模板禁复杂表达式（AGENTS.md 已知坑）。
 * 关键是这一行**永远渲染** —— 折叠态只是换 class、收起文字，
 * 折叠按钮本身不能重建（重建就看不到 morph，见模板处注释）。
 */
const brandRowClass = computed(() => (sidebarCollapsed.value ? 'app-brand-collapsed' : 'app-brand'))

/**
 * 导航项。
 *
 * M5.5：emoji（🎮 ⚙️ 🛠️）换成 Lucide 的图标**名字**。
 * 为什么必须换：emoji 是彩色字形，跨平台渲染不一致，和暗色 UI 不搭，
 * 且没法控制粗细 —— 换图标体系时顺手解决（方案 §4.2 列了这个额外收益）。
 *
 * 这里存**图标名**（字符串），不是组件、也不是数据：
 * 三个导航都是一次性跳转（点一下就到对应页面），**没有"两种状态"**，
 * 所以不该走 morph 管线（方案 §5：硬塞是滥用）。
 */
const navItems = computed(() => [
  { path: '/library', label: t('nav.library'), icon: 'Gamepad2' as const },
  { path: '/engines', label: t('nav.engines'), icon: 'Settings' as const },
  { path: '/settings', label: t('nav.settings'), icon: 'Wrench' as const }
])

const appVersion = computed(() => (window.tsumi?.appVersion ? `v${window.tsumi.appVersion}` : ''))
const platform = computed(() => window.tsumi?.platform ?? '')

// ===== M5.0 S12：分类从侧边栏搬到了库页顶部的筛选栏 =====
//
// 原来这里是一整套分类的增删改 + 点选筛选（约 110 行）。用户 2026-11-05 的实测反馈
// 把这件事推翻了：侧边栏与「游戏库 / 引擎 / 设置」三个导航挤在一起，分类越攒越多，
// 导航项被挤得越远，而分类**只是库页的一种筛选** —— 在引擎页/设置页看着
// 一长条不可用的分类，等于用导航的可用度换了筛选器的可见度。
//
// 现在分类整体搬到 `components/CategoryFilterBar.vue`（由 LibraryPage 渲染），
// 侧边栏**只留导航**。语义一条没变（多归属 / 虚拟"未分类" / 删分类不删游戏，D31）。
//
// ⚠️ 这个文件里**不许再出现分类代码**：`sidebar-collapse.ts` 的 SIDEBAR_PARTS
//   曾经有 'categories' 这一块（折叠时收起），现在已经删掉了 ——
//   若把分类加回侧边栏，那条「每个侧边栏块恰好归到一边」的单测会先红。

onMounted(async () => {
  // 事件订阅先装（core 可能在 snapshot 之前就发 dialog）
  // M3.5：进程事件（gameStarted / gameExited）转给 library store —— 它是运行态的唯一投影。
  // 事件订阅仍然只装一次（task.install 内部判重）。
  task.install((event) => library.handleProcessEvent(event))
  coreDialogs.install()
  settings.initMeta(window.tsumi?.appVersion ?? '', '', window.tsumi?.platform ?? '')
  // system 外观要跟随系统变化
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', applyAppearanceOnChange)

  try {
    const snapshot = await api.snapshot()
    library.applySnapshot(snapshot)
    settings.applySnapshot(snapshot)
    engines.applySnapshot(snapshot)
    // M4.0 S6.5（D58）：数据目录切换的一次性说明。
    // 判定与「只提示一次」的标记都在主进程（data-dir-notice.ts），这里只负责展示。
    // 用 ElMessage.info（**不是 error**）：这不是故障，是「新目录是空的」这个事实。
    showDataDirNoticeOnce()
    // M2.5-C：多语言分组（纯本地计算、毫秒级）。失败不影响库页使用，故不阻塞也不报错。
    void library.loadLanguageGroups()
    if (snapshot.settings.checkModuleUpdatesOnStartup) {
      // 启动检查更新：失败静默（引擎页可以看到 warning）
      void task
        .run('startup-updates', api.checkEngineUpdates(false))
        .then((report) => {
          engines.engineUpdates = report
        })
        .catch(() => undefined)
    }
  } catch (error) {
    ElMessage.error(translateError(error, t))
  }
})

function applyAppearanceOnChange(): void {
  settings.applyAppearance()
}

/**
 * 弹一次「数据目录已切换」的说明（M4.0 S6.5 / D58）。
 *
 * 为什么文案来自主进程而不是 i18n：
 * 那句话是「事实陈述 + 用户该做什么」，判定条件（目录为空 / 未提示过 / 是 mac）
 * 也在主进程里（`data-dir-notice.ts`，有单测）。文案与判定放一处，
 * 否则加一个判定条件就得同时改两边、而且两边很容易对不上。
 *
 * 为什么 consume 之后要清空：同一个会话里 snapshot 可能被多次拉取
 * （保存设置也会返回 snapshot），不清空就会重复弹。
 */
function showDataDirNoticeOnce(): void {
  const notice = settings.dataDirNotice
  if (!notice) return
  ElMessage.info({ message: notice, duration: 12_000, showClose: true })
  settings.consumeDataDirNotice()
}

onBeforeUnmount(() => {
  window.matchMedia?.('(prefers-color-scheme: dark)').removeEventListener('change', applyAppearanceOnChange)
  task.dispose()
  coreDialogs.dispose()
})

function isActive(path: string): boolean {
  if (path === '/library') return route.path.startsWith('/library') || route.path.startsWith('/game')
  return route.path.startsWith(path)
}
</script>

<template>
  <div class="app-shell">
    <!-- M5.5：折叠态宽度由 shared/sidebar-collapse.ts 的判据算（展开 208 / 折叠 56）。
         `width` 与 `flex-basis` 必须同时给 —— 只给一个会出现"宽度变了但没变全"
         （flex 子项的 basis 优先于 width）。 -->
    <aside
      class="app-sidebar"
      :class="{ 'is-collapsed': sidebarCollapsed }"
      :style="{ width: sidebarPx + 'px', flexBasis: sidebarPx + 'px' }"
    >
      <!-- M5.5：品牌行 + 折叠按钮。
           ⚠️ **必须只有一个容器、不拆成 v-if/v-else 两个 div**：
           折叠时品牌文字收起，但折叠按钮**不能跟着重建** ——
           两个容器意味着按钮（连同里面的 MorphIcon）被销毁再挂载，
           用户看不到变形（这正是本鱼第一版犯的错，探针实测 `d` 属性没变）。
           所以：外层 div 永远在，只换 class 与内部文字的显隐。 -->
      <div :class="brandRowClass">
        <span v-if="brandVisible" class="app-brand-name">{{ t('app.name') }}</span>
        <span v-if="brandVisible" class="app-brand-tagline">{{ t('app.tagline') }}</span>
        <SidebarToggle
          :collapsed="sidebarCollapsed"
          :label="sidebarToggleLabel"
          :icon="sidebarToggleIcon"
          @toggle="toggleSidebar"
        />
      </div>

      <RouterLink
        v-for="item in navItems"
        :key="item.path"
        :to="item.path"
        class="app-nav-item"
        :class="{ 'is-active': isActive(item.path) }"
        :title="item.label"
      >
        <!-- 图标名是**常量**（三个导航都是一次性跳转，没有两种状态）→ 不 morph -->
        <AppIcon :name="item.icon" :size="18" />
        <span v-if="navLabelVisible">{{ item.label }}</span>
      </RouterLink>

      <!-- M5.0 S12：分类区**已从侧边栏移除**，搬到库页顶部的横向筛选栏
           （components/CategoryFilterBar.vue）。侧边栏只留导航 ——
           游戏库 / 引擎 / 设置三个入口不该被一串分类挤得东倒西歪。
           折叠态因此也少了一块要收的东西（见 shared/sidebar-collapse.ts）。 -->

      <!-- 折叠态收起：版本号/平台是两行短文本，56px 宽度放不下 -->
      <div v-if="footerVisible" class="app-sidebar-footer">
        <div>{{ appVersion }}</div>
        <div>{{ platform }}</div>
      </div>
    </aside>

    <main class="app-main">
      <RouterView />
    </main>

    <ProgressOverlay />
    <CoreDialogHost />
  </div>
</template>
