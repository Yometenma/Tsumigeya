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
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import GameCard from '@/components/GameCard.vue'
import { translateError } from '@/api/client'
import { useLibraryStore } from '@/stores/library'
import { useSettingsStore } from '@/stores/settings'

const { t } = useI18n()
const router = useRouter()
const library = useLibraryStore()
const settings = useSettingsStore()

const listView = computed(() => settings.settings.listView)

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

  <div class="toolbar">
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

    <el-radio-group :model-value="listView" @update:model-value="toggleView($event === true)">
      <el-radio-button :value="false">{{ t('library.gridView') }}</el-radio-button>
      <el-radio-button :value="true">{{ t('library.listView') }}</el-radio-button>
    </el-radio-group>
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
      @open="openDetail"
      @edit="edit"
      @refresh="refreshMeta"
      @remove="remove"
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
      @open="openDetail"
      @edit="edit"
      @refresh="refreshMeta"
      @remove="remove"
    />
  </div>
</template>
