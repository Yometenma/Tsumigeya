<script setup lang="ts">
// 游戏卡片 / 列表行两种形态（§4 GameCard.vue）。图标走 iconUrl()，缺省占位。
// M2：封面优先用 DLsite 的 coverUrl（远程），失败再退到本地 iconPath，最后退字母占位。
// 三级降级都做成 computed，模板里不写任何类型断言（AGENTS.md 的「模板禁 TS 断言」）。
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { iconUrl, type GameMeta, type GameRecord } from '@/api/client'

const props = defineProps<{
  game: GameRecord
  variant: 'card' | 'row'
  /** M2：DLsite 元数据（可选，没有就走原来的本地图标）。 */
  meta?: GameMeta
}>()

const emit = defineEmits<{
  launch: [id: string]
  edit: [id: string]
  remove: [id: string]
}>()

const { t } = useI18n()

/** 远程封面加载失败（防盗链 / 引用过期 / 网络问题）——很常见，必须优雅降级。 */
const coverBroken = ref(false)
/** 本地图标加载失败（路径存在但文件坏掉）。 */
const iconBroken = ref(false)

const coverSrc = computed(() => (props.meta?.coverUrl && !coverBroken.value ? props.meta.coverUrl : undefined))
const iconSrc = computed(() => (!iconBroken.value ? iconUrl(props.game.iconPath) : undefined))
/** 最终显示哪一张：封面 → 本地图标 → 无。 */
const src = computed(() => coverSrc.value ?? iconSrc.value)

const tags = computed(() => (props.game.tags ?? []).filter((tag) => tag.trim()))
const placeholder = computed(() => props.game.gameTitle.trim().slice(0, 1).toUpperCase() || '?')
/** 副标题：有社团名就显示社团，否则退回引擎名（列表里更有信息量）。 */
const subtitle = computed(() => props.meta?.circle?.trim() || props.game.gameEngine)

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
      <div v-if="!coverSrc && meta" class="game-card-cover-hint">{{ t('dlsite.coverMissing') }}</div>
    </div>
    <div class="game-card-body">
      <div class="game-card-title" :title="game.gameTitle">{{ game.gameTitle }}</div>
      <div class="game-card-meta">{{ subtitle }}</div>
      <div v-if="meta?.registDate" class="game-card-meta">{{ t('dlsite.fieldReleased') }} {{ meta.registDate }}</div>
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
