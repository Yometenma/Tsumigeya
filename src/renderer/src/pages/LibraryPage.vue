<script setup lang="ts">
// 游戏库：网格/列表（读 settings.listView）、搜索、标签过滤、空状态、编辑/删除（§4 LibraryPage.vue）。
//
// M2.6 起本页**不再有启动能力**（D38：启动按钮只在详情页）：
// - 点卡片 → 进详情页（`/game/:id`）
// - 三点菜单 → 编辑（`/game/:id/edit`）/ 重新获取元数据 / 删除
//
// 启动链路（含 M3 的诊断拦截与 M2.5-C 的语言切换确认）整体搬到了 GameDetailPage：
// 那套逻辑要弹诊断框、要问用户换不换语言版，属于「详情页才有的上下文」；
// 库页留一堆只为启动服务的状态，反而会让「点卡片到底会发生什么」变得模糊。
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import GameCard from '@/components/GameCard.vue'
import { translateError } from '@/api/client'
import { useLibraryStore } from '@/stores/library'
import { useSettingsStore } from '@/stores/settings'
import {
  deletableSelection,
  deleteConfirmPlan,
  selectAllState,
  selectedCount
} from '../../../shared/bulk-select'

const { t } = useI18n()
const router = useRouter()
const library = useLibraryStore()
const settings = useSettingsStore()

const listView = computed(() => settings.settings.listView)

// ===== M5.0 U1：批量模式 =====

/** 批量模式开关。关掉时清空选择（不让"看不见的选中"留到下次）。 */
const batchMode = ref(false)
/**
 * 选中的 id 集合。
 *
 * 用 Set 而不是数组：勾选/取消是高频操作，数组 includes 是 O(n)，
 * 而库里有几百个游戏时每次点击都扫一遍不划算。
 * 展示顺序一律由 `deletableSelection(selected, visible)` 决定（按当前可见顺序）。
 */
const selected = ref<Set<string>>(new Set())
/** 当前可见的游戏 id（按 `library.filtered` 的顺序）。 */
const visibleIds = computed(() => library.filtered.map((game) => game.id))
/** 「已选 N 个」——只数当前可见的（与真正会删的集合恒等）。 */
const selectedCountValue = computed(() => selectedCount(selected.value, visibleIds.value))
const allState = computed(() => selectAllState(selected.value, visibleIds.value))
/** 批量删除的进度（null = 没在跑）。 */
const batchProgress = ref<{ done: number; total: number } | null>(null)

/**
 * 进入批量模式。
 *
 * ⚠️ **同时清掉筛选**：批量模式的工具条不显示搜索/筛选控件，若不清掉，
 * 用户会看到"列表里只显示一部分游戏、但没有任何控件说明为什么"——那是纯困惑。
 * 而且筛选在批量模式下是误删的来源（勾了又被筛走看不见）。
 *
 * 退出批量时**不恢复**筛选：用户的筛选本来就该由他自己再设，
 * 我们"记得"上次筛选再偷偷还原，反而更难理解他在看什么。
 */
function enterBatch(): void {
  library.clearFilters()
  batchMode.value = true
  selected.value = new Set()
}

function exitBatch(): void {
  batchMode.value = false
  selected.value = new Set()
  batchProgress.value = null
}

/**
 * 切换单个选中。
 *
 * ⚠️ 必须**新建 Set**（不能就地 add/delete）：`selected` 是 ref<Set>，
 * 就地修改不会触发响应式更新（Set 的 mutation 不被 Vue 追踪）→ 勾选框纹丝不动。
 */
function toggleSelect(id: string): void {
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  selected.value = next
}

/** 全选 / 取消全选（**只作用于当前可见的**，被筛掉的不动）。 */
function toggleSelectAll(): void {
  const next = new Set(selected.value)
  if (allState.value === 'all') {
    for (const id of visibleIds.value) next.delete(id)
  } else {
    for (const id of visibleIds.value) next.add(id)
  }
  selected.value = next
}

/** 点卡片 → 详情页（M2.6 的新语义：点卡片不是启动，是看详情）。 */
function openDetail(id: string): void {
  void router.push(`/game/${id}`)
}

/** 三点菜单「编辑」→ 编辑页（路由拆成了 `/game/:id/edit`，见 §5.3）。 */
function edit(id: string): void {
  void router.push(`/game/${id}/edit`)
}

/**
 * 三点菜单「重新获取元数据」（等同编辑页原来的「刷新」）。
 *
 * 为什么放在卡片上：用户看卡片觉得信息旧了，就该能就地刷新，
 * 不必为了刷新专门进一趟编辑页。没有 RJ 时菜单项是 disabled 的（canRefreshMeta）。
 */
async function refreshMeta(id: string): Promise<void> {
  try {
    await library.refreshGameMeta(id, true)
    ElMessage.success(t('detail.refreshDone'))
  } catch (error) {
    ElMessage.error(translateError(error, t))
  }
}

async function remove(id: string): Promise<void> {
  const game = library.byId(id)
  if (!game) return
  if (settings.settings.deletionConfirmation) {
    try {
      await ElMessageBox.confirm(
        t('library.deleteConfirmMessage', { title: game.gameTitle }),
        t('library.deleteConfirmTitle'),
        { type: 'warning', confirmButtonText: t('common.delete'), cancelButtonText: t('common.cancel') }
      )
    } catch {
      return // 用户取消
    }
  }
  try {
    await library.removeGame(id)
    ElMessage.success(t('library.deleted', { title: game.gameTitle }))
  } catch (error) {
    ElMessage.error(translateError(error, t))
  }
}

/** 列表/网格切换直接落盘（settings.listView）。 */
async function toggleView(next: boolean): Promise<void> {
  try {
    await settings.save({ listView: next })
  } catch (error) {
    ElMessage.error(translateError(error, t))
  }
}

/**
 * M5.0 U1：批量删除。
 *
 * 方案 §4.1 的三条硬约束：
 *  ① **必须二次确认**，且列出被删标题（≥3 个只列前 3 + 「等 N 个」）
 *  ② 逐个执行 + 进度反馈（一个失败不整体崩）
 *  ③ 只删**当前可见**的选中项（被筛走的不删，但如果存在要在弹窗里提示）
 *
 * 关于 ③：进入批量时已经清了筛选，所以正常情况下"选中集 == 可见集"。
 * 但交集判据**仍然保留**——它是防御性的：
 *   · 将来若在批量模式下放开筛选，这条判据直接把误删挡住；
 *   · 选中集里可能有陈旧 id（游戏在另一个窗口被删掉了），交集自然过滤。
 * 直接删「选中集」而不用交集，是本鱼见过最常见的误删实现。
 *
 * 判据（`deleteConfirmPlan` / `deletableSelection`）在 shared/bulk-select.ts，
 * 有 22 条单测 —— 尤其是「正好 3 个时不能冒出『等 0 个』」与「筛掉了的不能误删」。
 */
async function removeSelected(): Promise<void> {
  const ids = deletableSelection(selected.value, visibleIds.value)
  if (ids.length === 0) {
    ElMessage.warning(t('library.bulkNothingSelected'))
    return
  }

  // ① 二次确认：列出将被删的标题
  const titles = ids.map((id) => library.byId(id)?.gameTitle ?? id)
  const plan = deleteConfirmPlan(titles)
  // 被筛掉但仍在选中集里的个数 —— 提示出来，让用户知道"这些不会删"
  const hidden = selected.value.size - ids.length

  const message = buildConfirmMessage(plan, hidden)
  try {
    await ElMessageBox.confirm(message, t('library.bulkDeleteTitle'), {
      type: 'warning',
      confirmButtonText: t('library.bulkDeleteConfirm', { count: ids.length }),
      cancelButtonText: t('common.cancel'),
      // 列标题可能较长，弹窗放宽一点
      customClass: 'tsmg-bulk-confirm',
      dangerouslyUseHTMLString: false
    })
  } catch {
    return // 用户取消
  }

  // ② 逐个执行 + 进度
  batchProgress.value = { done: 0, total: ids.length }
  try {
    const result = await library.removeGames(ids, (done, total) => {
      batchProgress.value = { done, total }
    })
    if (result.failed.length === 0) {
      ElMessage.success(t('library.bulkDeleted', { count: result.removed }))
    } else {
      // 部分失败：说清"删了几个、还剩几个没删"，不要笼统报错
      ElMessage.warning(
        t('library.bulkDeletePartial', { removed: result.removed, failed: result.failed.length })
      )
      console.warn(
        `[tsumigeya] 批量删除部分失败：${result.failed.map((item) => item.id).join(' / ')}`,
        result.failed
      )
    }
    // 删完把成功的那些从选中集里去掉（失败的留着，用户可重试）
    const next = new Set(selected.value)
    for (const id of ids) if (!result.failed.some((item) => item.id === id)) next.delete(id)
    selected.value = next
    if (next.size === 0) batchMode.value = false
  } finally {
    batchProgress.value = null
  }
}

/**
 * 二次确认的正文。
 *
 * 用换行拼而不是模板字符串里塞多语言：**每一句都走 locales**（协作规矩 2），
 * 这里只负责把它们按顺序接起来。ICU 语法一律不用（会让整块组件白屏）。
 */
function buildConfirmMessage(plan: ReturnType<typeof deleteConfirmPlan>, hidden: number): string {
  const lines: string[] = []
  lines.push(t('library.bulkDeleteMessage', { count: plan.listed.length + plan.omitted }))
  for (const title of plan.listed) lines.push(`· ${title}`)
  if (plan.omitted > 0) lines.push(t('library.bulkDeleteMore', { count: plan.omitted }))
  if (hidden > 0) lines.push(t('library.bulkDeleteHidden', { count: hidden }))
  return lines.join('\n')
}
</script>

<template>
  <header class="row" style="margin-bottom: 4px">
    <div style="flex: 1">
      <h1 class="page-title">{{ t('library.title') }}</h1>
      <p class="page-subtitle">
        {{ t('library.count', { count: library.filtered.length }) }}
        <template v-if="library.onlyUnbound"> · {{ t('library.onlyUnboundActive') }}</template>
      </p>
    </div>
    <el-button type="primary" @click="router.push('/library/new')">{{ t('library.addGame') }}</el-button>
  </header>

  <!-- M5.0 U1：批量模式下**整条普通工具条隐藏**（不是只藏两个按钮）。
       理由：批量模式开着时还能改搜索/筛选，就会出现「选中了 A，但 A 被筛走了看不见」的
       状态 —— 那正是批量删除最容易误删的场景。**批量时不筛**，退出批量后再恢复筛选。 -->
  <div v-if="!batchMode" class="toolbar">
    <el-input
      v-model="library.search"
      :placeholder="t('library.searchPlaceholder')"
      clearable
      style="width: 260px"
    />
    <el-button v-if="library.search || library.onlyUnbound" text @click="library.clearFilters()">
      {{ t('library.clearFilter') }}
    </el-button>

    <!-- M5.0 U3：「按标签筛选」下拉已删。
         DLsite 拿不到 genre（D19/D40），标签全靠手工填 → 下拉常年空着或一两个，
         选出来什么都筛不到。tags 字段与编辑页的标签复用下拉**保留**（D10 上游 schema）。 -->
    <!-- M5.0 U4：只看「未绑定」——把筛选从装饰性的「看有封面的」变成待办清单：
         哪些游戏还没去绑 DLsite 商品。数量挂在标签上，一眼知道还有几件要做。 -->
    <el-checkbox v-model="library.onlyUnbound">
      {{ t('library.onlyUnbound') }}
      <span v-if="library.unboundTotal > 0" class="unbound-count">{{ t('library.unboundTip', { count: library.unboundTotal }) }}</span>
    </el-checkbox>

    <div class="toolbar-spacer" />

    <!-- M5.0 U1：批量模式开关 -->
    <el-button v-if="!batchMode" :disabled="library.filtered.length === 0" @click="enterBatch">
      {{ t('library.batchMode') }}
    </el-button>

    <el-radio-group v-if="!batchMode" :model-value="listView" @update:model-value="toggleView($event === true)">
      <el-radio-button :value="false">{{ t('library.gridView') }}</el-radio-button>
      <el-radio-button :value="true">{{ t('library.listView') }}</el-radio-button>
    </el-radio-group>
  </div>

  <!-- M5.0 U1：批量模式工具条。取代原来的搜索区（批量时不筛，免得"选中集 vs 可见集"更绕） -->
  <div v-if="batchMode" class="toolbar batch-toolbar">
    <el-checkbox
      :model-value="allState === 'all'"
      :indeterminate="allState === 'partial'"
      @update:model-value="toggleSelectAll"
    >
      {{ t('library.bulkSelectAll') }}
    </el-checkbox>
    <span class="batch-count">{{ t('library.bulkSelectedCount', { count: selectedCountValue }) }}</span>

    <div class="toolbar-spacer" />

    <span v-if="batchProgress" class="hint">
      {{ t('library.bulkProgress', { done: batchProgress.done, total: batchProgress.total }) }}
    </span>
    <el-button
      type="danger"
      :disabled="selectedCountValue === 0"
      :loading="!!batchProgress"
      @click="removeSelected"
    >
      {{ t('library.bulkDelete') }}
    </el-button>
    <el-button :disabled="!!batchProgress" @click="exitBatch">{{ t('library.bulkExit') }}</el-button>
  </div>

  <el-skeleton v-if="library.loading" :rows="4" animated />

  <div v-else-if="library.filtered.length === 0" class="empty-state">
    <div class="empty-state-title">
      {{ library.games.length === 0 ? t('library.emptyTitle') : t('common.empty') }}
    </div>
    <div>{{ library.games.length === 0 ? t('library.emptyHint') : t('library.clearFilter') }}</div>
    <el-button v-if="library.games.length === 0" type="primary" @click="router.push('/library/new')">
      {{ t('library.addGame') }}
    </el-button>
  </div>

  <div v-else-if="listView" class="stack">
    <GameCard
      v-for="game in library.filtered"
      :key="game.id"
      :game="game"
      :meta="library.meta[game.id]"
      :language="library.languageOf[game.id]"
      :alternates="library.alternatesOf[game.id]"
      :running="library.isRunning(game.id)"
      variant="row"
      :batch-mode="batchMode"
      :selected="selected.has(game.id)"
      @open="openDetail"
      @edit="edit"
      @refresh="refreshMeta"
      @remove="remove"
      @toggle-select="toggleSelect"
    />
  </div>

  <div v-else class="game-grid">
    <GameCard
      v-for="game in library.filtered"
      :key="game.id"
      :game="game"
      :meta="library.meta[game.id]"
      :language="library.languageOf[game.id]"
      :alternates="library.alternatesOf[game.id]"
      :running="library.isRunning(game.id)"
      variant="card"
      :batch-mode="batchMode"
      :selected="selected.has(game.id)"
      @open="openDetail"
      @edit="edit"
      @refresh="refreshMeta"
      @remove="remove"
      @toggle-select="toggleSelect"
    />
  </div>
</template>
