<script setup lang="ts">
// 侧边栏布局 + 路由出口 + 全局挂载 ProgressOverlay / CoreDialogHost（§4 App.vue）。
// 首次 snapshot 在这里拉取，并把 settings 同步给 settings store。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import AppIcon from '@/components/AppIcon.vue'
import SidebarToggle from '@/components/SidebarToggle.vue'
import ProgressOverlay from '@/components/ProgressOverlay.vue'
import CoreDialogHost from '@/components/CoreDialogHost.vue'
import { api, translateError } from '@/api/client'
import { UNCATEGORIZED_ID } from '../../shared/categories'
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
const router = useRouter()
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
const categoriesVisible = computed(() => sidebarPartVisible('categories', sidebarCollapsed.value))
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

// ===== M5.0 S7（U2）：侧边栏的分类 =====
//
// 分类是「用户自己的整理体系」，所以它出现在**侧边栏**（导航层）而不是库页的工具栏：
// 那是它与「标签」（卡片上的小标记）在语义上的区别 —— 方案 §4.2 特意分开了这两者。
//
// 点分类 → 设 `library.categoryFilter` 并确保回到库页；不改路由参数
// （用户点了分类还是停在库页，URL 不该为了筛选而变复杂）。

/** 新建分类的输入框（null = 不在编辑态）。 */
const newCategoryName = ref<string | null>(null)
const categoryBusy = ref(false)

/** 当前是否停在库页（分类筛选只在那儿有意义）。 */
const onLibrary = computed(() => route.path === '/library' || route.path.startsWith('/game'))

/** 点某个分类。 */
function selectCategory(id: string | null): void {
  library.setCategoryFilter(id)
  // 不在库页就跳回去（在详情/编辑页点分类时，用户想看的是「这一类有哪些游戏」）
  if (!onLibrary.value) void router.push('/library')
}

/** 打开新建分类的输入态。 */
function startCreateCategory(): void {
  newCategoryName.value = ''
}

/** 提交新建。 */
async function submitCreateCategory(): Promise<void> {
  const name = (newCategoryName.value ?? '').trim()
  if (!name) {
    newCategoryName.value = null
    return
  }
  categoryBusy.value = true
  try {
    await library.createCategory(name)
    newCategoryName.value = null
    ElMessage.success(t('category.created', { name }))
  } catch (error) {
    ElMessage.error(translateError(error, t))
  } finally {
    categoryBusy.value = false
  }
}

/** 重命名（用 ElMessageBox 的 prompt：不新增一个对话框组件）。 */
async function renameCategory(id: string, current: string): Promise<void> {
  try {
    const result = await ElMessageBox.prompt(t('category.renamePrompt'), t('category.renameTitle'), {
      inputValue: current,
      confirmButtonText: t('common.ok'),
      cancelButtonText: t('common.cancel'),
      inputValidator: (value) => (!!value && !!value.trim() ? true : t('category.nameRequired'))
    })
    await library.renameCategory(id, result.value)
    ElMessage.success(t('category.renamed'))
  } catch {
    /* 用户取消（ElMessageBox 取消会抛 'cancel'）—— 什么都不做 */
  }
}

/**
 * 删分类。
 *
 * ⚠️ 二次确认里必须说清「**游戏不会被删**」——这是用户最容易误解的一点：
 * 删掉一个分类看起来像"删掉这一类"，而里面的游戏一个都不该少（方案 §4.2.2 / D31）。
 */
async function deleteCategory(id: string, name: string, gameCount: number): Promise<void> {
  try {
    await ElMessageBox.confirm(
      gameCount > 0
        ? t('category.deleteConfirmWithGames', { name, count: gameCount })
        : t('category.deleteConfirm', { name }),
      t('category.deleteTitle'),
      { type: 'warning', confirmButtonText: t('common.delete'), cancelButtonText: t('common.cancel') }
    )
  } catch {
    return
  }
  try {
    await library.deleteCategory(id)
    // 正在筛这个分类的话要清掉筛选（否则筛一个不存在的分类 = 空列表）
    if (library.categoryFilter === id) library.setCategoryFilter(null)
    ElMessage.success(t('category.deleted', { name }))
  } catch (error) {
    ElMessage.error(translateError(error, t))
  }
}

/** 某个分类下有几个游戏（删确认要用）。 */
function countInCategory(id: string): number {
  return library.games.filter((game) => library.categoriesOf(game.id).includes(id)).length
}

/**
 * 分类 ⋯ 菜单的分发。
 *
 * ⚠️ 写成函数而不是在模板里写箭头函数：模板里只留简单调用，
 * 复杂表达式进 `<script setup>`（AGENTS.md 已知坑，模板表达式最容易白屏）。
 */
function onCategoryMenu(category: { id: string; name: string }, command: string): void {
  if (command === 'rename') void renameCategory(category.id, category.name)
  else if (command === 'delete') void deleteCategory(category.id, category.name, countInCategory(category.id))
}

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

      <!-- M5.0 S7（U2）：分类区（侧边栏 = 用户的整理体系，与"标签"是不同的东西）。
           多归属：一个游戏可同时出现在多个分类下。
           「未分类」是**虚拟分类**（不进定义表），判据是某个归属都没有。
           M5.5：折叠态整块收起 —— 56px 宽度里分类名 / 计数 / 「新建分类」
           全都放不下（不收起只会溢出或被裁，而且**不报错**，
           判据见 shared/sidebar-collapse.ts 的 SIDEBAR_HIDDEN_WHEN_COLLAPSED）。 -->
      <div v-if="categoriesVisible" class="app-categories">
        <div class="app-categories-title">{{ t('category.sidebarTitle') }}</div>

        <button
          type="button"
          class="app-category-item"
          :class="{ 'is-active': onLibrary && library.categoryFilter === null }"
          @click="selectCategory(null)"
        >
          <span class="app-category-name">{{ t('category.all') }}</span>
        </button>

        <button
          type="button"
          class="app-category-item"
          :class="{ 'is-active': onLibrary && library.categoryFilter === UNCATEGORIZED_ID }"
          @click="selectCategory(UNCATEGORIZED_ID)"
        >
          <span class="app-category-name">{{ t('category.uncategorized') }}</span>
          <span v-if="library.uncategorizedTotal > 0" class="app-category-count">
            {{ library.uncategorizedTotal }}
          </span>
        </button>

        <div class="app-categories-divider" />

        <div v-for="category in library.categoryList" :key="category.id" class="app-category-row">
          <button
            type="button"
            class="app-category-item"
            :class="{ 'is-active': onLibrary && library.categoryFilter === category.id }"
            @click="selectCategory(category.id)"
          >
            <span class="app-category-name">{{ category.name }}</span>
            <span v-if="countInCategory(category.id) > 0" class="app-category-count">
              {{ countInCategory(category.id) }}
            </span>
          </button>
          <!-- ⋯ 菜单：重命名 / 删除（方案 §4.2.3）。
               传的是 category 对象本身，不在模板里拼箭头函数（AGENTS.md：模板禁复杂表达式）。 -->
          <el-dropdown trigger="click" placement="right" @command="onCategoryMenu(category, $event)">            <span class="app-category-more">{{ t('library.moreActions') }}</span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="rename">{{ t('category.rename') }}</el-dropdown-item>
                <el-dropdown-item command="delete" divided>{{ t('category.delete') }}</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>

        <!-- 新建分类：输入态与按钮态两种。用 inline input 而不是弹窗
             —— 建分类是高频小动作，弹窗只为收一个名字太重。 -->
        <div v-if="newCategoryName !== null" class="app-category-new">
          <el-input
            v-model="newCategoryName"
            :placeholder="t('category.namePlaceholder')"
            size="small"
            :disabled="categoryBusy"
            @keyup.enter.prevent="submitCreateCategory"
            @keyup.esc.prevent="newCategoryName = null"
          />
          <div class="app-category-new-actions">
            <el-button size="small" type="primary" :loading="categoryBusy" @click="submitCreateCategory">
              {{ t('common.ok') }}
            </el-button>
            <el-button size="small" text :disabled="categoryBusy" @click="newCategoryName = null">
              {{ t('common.cancel') }}
            </el-button>
          </div>
        </div>
        <button v-else type="button" class="app-category-add" @click="startCreateCategory">
          {{ t('category.create') }}
        </button>
      </div>

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
