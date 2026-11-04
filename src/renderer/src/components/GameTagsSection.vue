<script setup lang="ts">
// M5.0 S11（U8）③：分类与标签区块。
//
// 从 GameEditPage 拆出来的。管的是**用户自己的整理体系**：
// 标签（上游 schema，D10 保留）+ 图标（没有 DLsite 封面时的兜底）。
//
// ⚠️ 标签必须保留：DLsite 拿不到 genre（D19/D40 实测），这是唯一的标签来源。
// 封面预览已经搬到 GameInfoForm（D45：图标与封面合并成一个概念，用户要看到
// 「卡片上到底显示哪张」）。
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, iconUrl, translateError } from '@/api/client'
import { useLibraryStore } from '@/stores/library'
import { ElMessage } from 'element-plus'

const props = defineProps<{
  /** 已选标签（v-model:tags）。 */
  tags: string[]
  /** 本地图标路径（v-model:icon-path）。 */
  iconPath?: string
}>()

const emit = defineEmits<{
  'update:tags': [value: string[]]
  'update:iconPath': [value: string | undefined]
}>()

const { t } = useI18n()
const library = useLibraryStore()

/** 图标设置是否展开（默认收起 —— 卡片优先用封面，图标只是兜底）。 */
const iconSectionOpen = ref(false)

const iconPreview = computed(() => iconUrl(props.iconPath))

/** 折叠开关写成函数（模板里不内联赋值，AGENTS.md 已知坑）。 */
function toggleIcon(): void {
  iconSectionOpen.value = !iconSectionOpen.value
}

async function chooseIcon(): Promise<void> {
  const picked = await api.pickPath('file')
  if (picked) emit('update:iconPath', picked)
}

function clearIcon(): void {
  emit('update:iconPath', undefined)
}
</script>

<template>
  <section class="panel stack" style="margin-bottom: 16px">
    <div>
      <h3 style="margin: 0">{{ t('game.tagsSection') }}</h3>
      <div class="hint">{{ t('game.tagsSectionHint') }}</div>
    </div>

    <!-- 标签：**保留**。DLsite 不提供 genre（M2.6 D40 实测），这是唯一的标签来源。 -->
    <div class="settings-row">
      <div class="settings-row-main">
        <div class="settings-row-title">{{ t('game.tagsLabel') }}</div>
        <div class="settings-row-hint">{{ t('game.tagsHint') }}</div>
      </div>
      <el-select
        :model-value="tags"
        multiple
        filterable
        allow-create
        default-first-option
        :placeholder="t('wizard.tagsPlaceholder')"
        style="width: 320px"
        @update:model-value="emit('update:tags', $event)"
      >
        <el-option v-for="tag in library.tags" :key="tag" :label="tag" :value="tag" />
      </el-select>
    </div>

    <!-- 图标：折叠（卡片优先用封面，图标只是没有元数据时的兜底） -->
    <div class="settings-row">
      <div class="settings-row-main">
        <div class="settings-row-title">
          <el-button text size="small" class="icon-toggle" @click="toggleIcon">
            {{ iconSectionOpen ? '▾' : '▸' }} {{ t('game.iconAdvanced') }}
          </el-button>
        </div>
        <div class="settings-row-hint">{{ t('game.iconAdvancedHint') }}</div>
      </div>
    </div>

    <div v-if="iconSectionOpen" class="settings-row">
      <div class="settings-row-main">
        <div class="settings-row-title">{{ t('game.iconLabel') }}</div>
        <div class="settings-row-hint" style="word-break: break-all">{{ iconPath || t('game.iconNone') }}</div>
      </div>
      <div class="row" style="flex: 0 0 auto">
        <img v-if="iconPreview" :src="iconPreview" alt="" style="width: 40px; height: 40px; border-radius: 8px" />
        <el-button @click="chooseIcon">{{ t('game.changeIcon') }}</el-button>
        <el-button v-if="iconPath" text @click="clearIcon">{{ t('game.clearIcon') }}</el-button>
      </div>
    </div>
  </section>
</template>
