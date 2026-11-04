<script setup lang="ts">
// 游戏卡片 / 列表行两种形态（§4 GameCard.vue）。图标走 iconUrl()，缺省占位。
// M2：封面优先用 DLsite 的 coverUrl（远程），失败再退到本地 iconPath，最后退字母占位。
// 三级降级都做成 computed，模板里不写任何类型断言（AGENTS.md 的「模板禁 TS 断言」）。
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { iconUrl, type GameLanguage, type GameMeta, type GameRecord } from '@/api/client'
import { isAdultWork } from '../../../shared/age-rating'
import { GAME_LANGUAGES, languageShortName } from '../../../shared/game-language'
import { useSettingsStore } from '@/stores/settings'

const props = defineProps<{
  game: GameRecord
  variant: 'card' | 'row'
  /** M2：DLsite 元数据（可选，没有就走原来的本地图标）。 */
  meta?: GameMeta
  /** M2.5-C：该游戏识别出的语言（没有则不显示语言标记）。 */
  language?: GameLanguage
  /** M2.5-C：同组的其他语言版本（用于「也有 zh 版」提示）。 */
  alternates?: Array<{ lang: GameLanguage }>
}>()

const emit = defineEmits<{
  launch: [id: string]
  edit: [id: string]
  remove: [id: string]
}>()

const { t } = useI18n()
const settings = useSettingsStore()

/** 远程封面加载失败（防盗链 / 引用过期 / 网络问题）——很常见，必须优雅降级。 */
const coverBroken = ref(false)
/** 本地图标加载失败（路径存在但文件坏掉）。 */
const iconBroken = ref(false)

/**
 * R18 封面打码。**只影响渲染，数据照常抓取并保存**（设置里关掉开关后立即可见）。
 * 判定依据是 DLsite 的 section（maniax / books），见 api/client.ts 的 isAdultWork。
 */
const adultMasked = computed(() => isAdultWork(props.meta) && !settings.settings.showAdultCovers)

const coverSrc = computed(() => (props.meta?.coverUrl && !coverBroken.value ? props.meta.coverUrl : undefined))
const iconSrc = computed(() => (!iconBroken.value ? iconUrl(props.game.iconPath) : undefined))
/** 最终显示哪一张：封面 → 本地图标 → 无。打码时不显示封面，直接退到本地图标。 */
const src = computed(() => (adultMasked.value ? iconSrc.value : coverSrc.value ?? iconSrc.value))

const tags = computed(() => (props.game.tags ?? []).filter((tag) => tag.trim()))
const placeholder = computed(() => props.game.gameTitle.trim().slice(0, 1).toUpperCase() || '?')
/** 副标题：有社团名就显示社团，否则退回引擎名（列表里更有信息量）。 */
const subtitle = computed(() => props.meta?.circle?.trim() || props.game.gameEngine)

/**
 * M2.5-C：该游戏自身的语言标记（如「中文」）。
 * 只在识别出语言时显示——没识别出来就什么都不标（绝不瞎猜，§C.2）。
 */
const ownLanguageLabel = computed(() => {
  if (!props.language) return ''
  return languageShortName(props.language)
})

/**
 * M2.5-C：「也有 zh 版」提示。
 * 组内其他语言版本的语言名（去重、按固定顺序），例如本条目是 ja、组里还有 zh → 「也有 中文 版」。
 */
const alternateLanguages = computed(() => {
  // ⚠️ 只保留**与自身不同**的语言：组里可能有两个中文版（重复安装），
  // 中文版提示「也有中文版」是废话，属于实测发现的 UI 瑕疵。
  const langs = (props.alternates ?? [])
    .map((item) => item.lang)
    .filter((lang) => lang !== props.language)
  if (langs.length === 0) return []
  // 去重 + 按 GAME_LANGUAGES 的固定顺序（避免渲染顺序随数据抖动）
  return [...new Set(langs)].sort(
    (a, b) => GAME_LANGUAGES.indexOf(a) - GAME_LANGUAGES.indexOf(b)
  )
})

/** 把语言列表拼成「中文 / 英文」这样的展示串（模板里不写复杂表达式）。 */
const alternateText = computed(() => alternateLanguages.value.map((lang) => languageShortName(lang)).join(' / '))

/** 换了游戏或换了封面地址就重置失败标记，否则改了元数据还显示占位。 */
watch(
  () => [props.game.id, props.meta?.coverUrl] as const,
  () => {
    coverBroken.value = false
    iconBroken.value = false
  }
)

/** 封面 404 时退到本地图标；本地图标也坏掉才显示字母。 */
function onImageError(): void {
  if (coverBroken.value) iconBroken.value = true
  else coverBroken.value = true
}
</script>

<template>
  <article v-if="variant === 'card'" class="game-card">
    <div class="game-card-icon" :class="{ 'has-cover': !!coverSrc }">
      <img v-if="src" :src="src" :alt="game.gameTitle" @error="onImageError" />
      <span v-else>{{ placeholder }}</span>
      <div v-if="adultMasked" class="game-card-cover-hint">{{ t('dlsite.adultCoverHidden') }}</div>
      <div v-else-if="!coverSrc && meta" class="game-card-cover-hint">{{ t('dlsite.coverMissing') }}</div>
    </div>
    <div class="game-card-body">
      <div class="game-card-title" :title="game.gameTitle">{{ game.gameTitle }}</div>
      <div class="game-card-meta">{{ subtitle }}</div>
      <div v-if="meta?.registDate" class="game-card-meta">{{ t('dlsite.fieldReleased') }} {{ meta.registDate }}</div>
      <!-- M2.5-C：语言标记 + 「也有 zh 版」（只在本条识别出语言时显示） -->
      <div v-if="ownLanguageLabel || alternateLanguages.length" class="game-card-lang">
        <el-tag v-if="ownLanguageLabel" size="small">{{ ownLanguageLabel }}</el-tag>
        <el-tag v-if="alternateLanguages.length" size="small" type="info">
          {{ t('library.alsoHas', { langs: alternateText }) }}
        </el-tag>
      </div>
      <div class="row" style="margin-top: 8px; gap: 6px">
        <el-button size="small" type="primary" @click="emit('launch', game.id)">{{ t('library.launch') }}</el-button>
        <el-button size="small" @click="emit('edit', game.id)">{{ t('library.edit') }}</el-button>
        <el-button size="small" text type="danger" @click="emit('remove', game.id)">
          {{ t('library.delete') }}
        </el-button>
      </div>
    </div>
  </article>

  <div v-else class="game-row">
    <div class="game-row-icon">
      <img v-if="src" :src="src" :alt="game.gameTitle" @error="onImageError" />
      <span v-else>{{ placeholder }}</span>
    </div>
    <div class="game-row-main">
      <div class="game-row-title" :title="game.gameTitle">{{ game.gameTitle }}</div>
      <div class="game-row-meta">
        {{ subtitle }}
        <template v-if="tags.length"> · {{ tags.join(' / ') }}</template>
      </div>
      <!-- M2.5-C：语言标记 + 「也有 zh 版」 -->
      <div v-if="ownLanguageLabel || alternateLanguages.length" class="game-row-lang">
        <el-tag v-if="ownLanguageLabel" size="small">{{ ownLanguageLabel }}</el-tag>
        <el-tag v-if="alternateLanguages.length" size="small" type="info">
          {{ t('library.alsoHas', { langs: alternateText }) }}
        </el-tag>
      </div>
    </div>
    <div class="game-row-actions">
      <el-button size="small" type="primary" @click="emit('launch', game.id)">{{ t('library.launch') }}</el-button>
      <el-button size="small" @click="emit('edit', game.id)">{{ t('library.edit') }}</el-button>
      <el-button size="small" text type="danger" @click="emit('remove', game.id)">
        {{ t('library.delete') }}
      </el-button>
    </div>
  </div>
</template>
