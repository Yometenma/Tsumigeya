<script setup lang="ts">
// 游戏库：网格/列表（读 settings.listView）、搜索、标签过滤、空状态、启动/编辑/删除（§4 LibraryPage.vue）。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import GameCard from '@/components/GameCard.vue'
import { translateError } from '@/api/client'
import { languageShortName } from '../../../shared/game-language'
import { decideLaunchTarget } from '../../../shared/launch-language'
import { useLibraryStore } from '@/stores/library'
import { useSettingsStore } from '@/stores/settings'

const { t } = useI18n()
const router = useRouter()
const library = useLibraryStore()
const settings = useSettingsStore()

const listView = computed(() => settings.settings.listView)

/**
 * 启动游戏（§C.5）。
 *
 * 关键行为：如果当前条目**不是**偏好语言版、而库里还有同组的偏好版本，
 * 就先弹确认问「要不要启动那个？」。用户可勾「不再询问」把 `languageSwitchPrompt` 关掉。
 *
 * 三条不能越界的规矩：
 * 1. **不自动改用户的选择**：用户点的是哪个就启动哪个——除非他明确点了「启动偏好版本」；
 * 2. **绝不删除/隐藏**其他语言版（那是用户数据，§C.5 明令不代删）；
 * 3. 设置里关掉提示（preferred= none 或 languageSwitchPrompt=false）时**直接启动**，不问。
 */
async function launch(id: string): Promise<void> {
  const game = library.byId(id)
  const target = await resolveLaunchTarget(id)
  try {
    await library.launch(target)
    const targetGame = library.byId(target)
    ElMessage.success(t('library.launchSent', { title: targetGame?.gameTitle ?? game?.gameTitle ?? '' }))
  } catch (error) {
    ElMessage.error(translateError(error, t))
  }
}

/**
 * 决定最终要启动哪个 id。返回原 id 表示「按用户点的那个启动」。
 *
 * 判定偏好语言：首选 → 次选（§C.4）。两者都 `none` 时整个功能不生效。
 */
/**
 * 决定最终要启动哪个 id（§C.5）。返回原 id 表示「按用户点的那个启动」。
 *
 * 判定逻辑抽在 lib/launch-language.ts（纯函数、有单测覆盖），这里只负责：
 * 取数据 → 问用户 → 返回结果。这样「会不会启动错游戏」的风险点被单测钉住。
 */
async function resolveLaunchTarget(id: string): Promise<string> {
  const prefs = settings.settings
  const decision = decideLaunchTarget({
    current: library.languageOf[id],
    alternates: library.alternatesOf[id] ?? [],
    preferred: prefs.preferredLanguage,
    fallback: prefs.fallbackLanguage,
    prompt: prefs.languageSwitchPrompt
  })
  if (decision.action === "launch" || !decision.targetId) return id

  const current = library.languageOf[id]
  const targetGame = library.byId(decision.targetId)
  const targetLang = library.languageOf[decision.targetId]
  try {
    // 「不再询问」是设置页的开关（§7-⑤ 用户确认的形态）：
    // 放在设置页用户随时能重新打开，不用靠「当时勾了没」去猜。
    await ElMessageBox.confirm(
      t("library.languageSwitchMessage", {
        current: current ? languageShortName(current) : "",
        preferred: targetLang ? languageShortName(targetLang) : "",
        title: targetGame?.gameTitle ?? decision.targetId
      }),
      t("library.languageSwitchTitle"),
      {
        type: "info",
        confirmButtonText: t("library.launchPreferred", { lang: targetLang ? languageShortName(targetLang) : "" }),
        cancelButtonText: t("library.launchCurrent")
      }
    )
    return decision.targetId
  } catch {
    // 取消 = 坚持启动当前这个（用户的选择优先，绝不自作主张）
    return id
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

    <el-button v-if="library.search || library.tagFilter || library.onlyWithMeta" text @click="library.clearFilters()">
      {{ t('library.clearFilter') }}
    </el-button>

    <el-checkbox v-model="library.onlyWithMeta" :label="t('dlsite.onlyWithMeta')" />

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
      :meta="library.meta[game.id]"
      :language="library.languageOf[game.id]"
      :alternates="library.alternatesOf[game.id]"
      variant="card"
      @launch="launch"
      @edit="edit"
      @remove="remove"
    />
  </div>
</template>
