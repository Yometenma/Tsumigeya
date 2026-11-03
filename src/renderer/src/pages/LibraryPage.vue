<script setup lang="ts">
// 游戏库：网格/列表（读 settings.listView）、搜索、标签过滤、空状态、启动/编辑/删除（§4 LibraryPage.vue）。
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

async function launch(id: string): Promise<void> {
  const game = library.byId(id)
  try {
    await library.launch(id)
    ElMessage.success(t('library.launchSent', { title: game?.gameTitle ?? '' }))
  } catch (error) {
    ElMessage.error(translateError(error, t))
  }
}

function edit(id: string): void {
  void router.push(`/game/${id}`)
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
        <template v-if="library.tagFilter"> · {{ t('library.tagFilterActive', { tag: library.tagFilter }) }}</template>
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
    <el-select
      :model-value="library.tagFilter ?? ''"
      :placeholder="t('library.filterTag')"
      clearable
      style="width: 180px"
      @update:model-value="library.tagFilter = $event || null"
    >
      <el-option :label="t('library.allTags')" value="" />
      <el-option v-for="tag in library.tags" :key="tag" :label="tag" :value="tag" />
    </el-select>

    <el-button v-if="library.search || library.tagFilter" text @click="library.clearFilters()">
      {{ t('library.clearFilter') }}
    </el-button>

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
      variant="row"
      @launch="launch"
      @edit="edit"
      @remove="remove"
    />
  </div>

  <div v-else class="game-grid">
    <GameCard
      v-for="game in library.filtered"
      :key="game.id"
      :game="game"
      variant="card"
      @launch="launch"
      @edit="edit"
      @remove="remove"
    />
  </div>
</template>
