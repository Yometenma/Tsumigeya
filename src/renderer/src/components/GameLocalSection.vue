<script setup lang="ts">
// M5.0 S11（U8）③：本地信息区块（路径 + 引擎）。
//
// 从 GameEditPage 拆出来的（方案 §9.3 ③ 的 5 文件方案）。
// 这一块管的是**游戏在本机的样子**：它放在哪个目录、用哪个引擎跑。
// 与「游戏身份」（DLsite 那边的标题/封面/社团）刻意分开 ——
// 前者是本机事实，后者是作品信息，混在一起正是原来那块"一股脑往后塞"的问题。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { api, translateError } from '@/api/client'
import { buildImportAttempts, importOutcome, type ImportDetection } from '../../../shared/import-target'
import { useEnginesStore } from '@/stores/engines'
import { ElMessage } from 'element-plus'

const props = defineProps<{
  /** 游戏路径（v-model:path）。 */
  path: string
  /** 当前引擎 id（v-model:engine）。 */
  engine: string
}>()

const emit = defineEmits<{
  'update:path': [value: string]
  'update:engine': [value: string]
}>()

const { t } = useI18n()
const engines = useEnginesStore()

const engineOptions = computed(() =>
  engines.modules.map((module) => ({ label: module.name || module.id, value: module.id }))
)

/**
 * 选文件 → 反推游戏目录 → 顺手识别引擎。
 *
 * ⚠️ 与向导共用 `shared/import-target.ts` 的逐层上退判据（上限 2 层）。
 * 两处**必须同一套**，否则会出现「向导能认出、编辑页认不出」这种分叉
 * —— 那正是 U7 要消灭的那类割裂。
 */
async function chooseFile(): Promise<void> {
  const picked = await api.pickPath('file')
  if (!picked) return
  let nextPath = picked
  let nextEngine = ''

  try {
    const attempts = buildImportAttempts(picked)
    const detections: ImportDetection[] = []
    for (const attempt of attempts) {
      const result = await api.detectFolder(attempt.path, false)
      detections.push({
        level: attempt.level,
        engine: result.best?.engine ?? null,
        bestPath: result.best?.path ?? null
      })
      if (result.best?.engine) break
    }
    const outcome = importOutcome(picked, attempts, detections)
    // 上退纠正过就跟着改路径，别让「显示的路径」与「实际存的路径」分叉
    nextPath = outcome.gamePath
    nextEngine = outcome.engine ?? ''
  } catch {
    /* 识别失败不阻塞编辑（路径仍然填进去） */
  }

  emit('update:path', nextPath)
  if (nextEngine) emit('update:engine', nextEngine)
  else if (nextEngine === '' && !props.engine) ElMessage.info(t('game.engineNotDetected'))
}
</script>

<template>
  <section class="panel stack" style="margin-bottom: 16px">
    <h3 style="margin: 0">{{ t('game.localSection') }}</h3>

    <div class="settings-row">
      <div class="settings-row-main">
        <div class="settings-row-title">{{ t('game.pathLabel') }}</div>
        <div class="settings-row-hint" style="word-break: break-all">{{ path || '—' }}</div>
      </div>
      <div class="row" style="flex: 0 0 auto">
        <!-- M5.0 U5：只留「选择文件」（选文件能反推目录，见 import-target.ts） -->
        <el-button @click="chooseFile">{{ t('wizard.chooseFile') }}</el-button>
      </div>
    </div>

    <div class="settings-row">
      <div class="settings-row-main">
        <div class="settings-row-title">{{ t('game.engineLabel') }}</div>
        <div class="settings-row-hint">{{ t('game.engineSwitchHint') }}</div>
      </div>
      <el-select
        :model-value="engine"
        style="width: 220px"
        :placeholder="t('common.unknown')"
        @update:model-value="emit('update:engine', $event)"
      >
        <el-option v-for="option in engineOptions" :key="option.value" :label="option.label" :value="option.value" />
      </el-select>
    </div>
  </section>
</template>
