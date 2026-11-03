<script setup lang="ts">
// 游戏卡片 / 列表行两种形态（§4 GameCard.vue）。图标走 iconUrl()，缺省占位。
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { iconUrl, type GameRecord } from '@/api/client'

const props = defineProps<{
  game: GameRecord
  variant: 'card' | 'row'
}>()

const emit = defineEmits<{
  launch: [id: string]
  edit: [id: string]
  remove: [id: string]
}>()

const { t } = useI18n()

const src = computed(() => iconUrl(props.game.iconPath))
/** 图标加载失败时退回占位（路径存在但文件坏掉的情况）。 */
const broken = ref(false)
const showImage = computed(() => !!src.value && !broken.value)

const tags = computed(() => (props.game.tags ?? []).filter((tag) => tag.trim()))
const placeholder = computed(() => props.game.gameTitle.trim().slice(0, 1).toUpperCase() || '?')
</script>

<template>
  <article v-if="variant === 'card'" class="game-card">
    <div class="game-card-icon">
      <img v-if="showImage" :src="src" :alt="game.gameTitle" @error="broken = true" />
      <span v-else>{{ placeholder }}</span>
    </div>
    <div class="game-card-body">
      <div class="game-card-title" :title="game.gameTitle">{{ game.gameTitle }}</div>
      <div class="game-card-meta">{{ game.gameEngine }}</div>
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
      <img v-if="showImage" :src="src" :alt="game.gameTitle" @error="broken = true" />
      <span v-else>{{ placeholder }}</span>
    </div>
    <div class="game-row-main">
      <div class="game-row-title" :title="game.gameTitle">{{ game.gameTitle }}</div>
      <div class="game-row-meta">
        {{ game.gameEngine }}
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
