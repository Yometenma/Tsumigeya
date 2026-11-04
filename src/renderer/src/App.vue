<script setup lang="ts">
// 侧边栏布局 + 路由出口 + 全局挂载 ProgressOverlay / CoreDialogHost（§4 App.vue）。
// 首次 snapshot 在这里拉取，并把 settings 同步给 settings store。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import ProgressOverlay from '@/components/ProgressOverlay.vue'
import CoreDialogHost from '@/components/CoreDialogHost.vue'
import { api, translateError } from '@/api/client'
import { UNCATEGORIZED_ID } from '../../shared/categories'
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

const navItems = computed(() => [
  { path: '/library', label: t('nav.library'), icon: '🎮' },
  { path: '/engines', label: t('nav.engines'), icon: '⚙️' },
  { path: '/settings', label: t('nav.settings'), icon: '🛠️' }
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
    <aside class="app-sidebar">
      <div class="app-brand">
        <span class="app-brand-name">{{ t('app.name') }}</span>
        <span class="app-brand-tagline">{{ t('app.tagline') }}</span>
      </div>

      <RouterLink
        v-for="item in navItems"
        :key="item.path"
        :to="item.path"
        class="app-nav-item"
        :class="{ 'is-active': isActive(item.path) }"
      >
        <span>{{ item.icon }}</span>
        <span>{{ item.label }}</span>
      </RouterLink>

      <!-- M5.0 S7（U2）：分类区（侧边栏 = 用户的整理体系，与"标签"是不同的东西）。
           多归属：一个游戏可同时出现在多个分类下。
           「未分类」是**虚拟分类**（不进定义表），判据是某个归属都没有。 -->
      <div class="app-categories">
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

      <div class="app-sidebar-footer">
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
