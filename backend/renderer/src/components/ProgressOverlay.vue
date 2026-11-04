<script setup lang="ts">
// 进度浮层：订阅 task store（§4 ProgressOverlay.vue）。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTaskStore } from '@/stores/task'

const { t } = useI18n()
const task = useTaskStore()

const label = computed(() => {
  const current = task.current
  if (!current) return ''
  // 优先用 key 查文案，没有就退回 name / 标签（§3.4）
  if (current.key) {
    const translated = t(current.key, (current.detail as Record<string, unknown>) ?? {})
    if (translated && translated !== current.key) return translated
  }
  return current.label || t('task.running')
})

/** 下载进度百分比；没有 total 时不显示数字。 */
const percent = computed<number | undefined>(() => {
  const detail = task.current?.detail as { downloadedBytes?: number; totalBytes?: number } | undefined
  if (!detail?.totalBytes || !detail.downloadedBytes) return undefined
  return Math.min(100, Math.round((detail.downloadedBytes / detail.totalBytes) * 100))
})

const tailLogs = computed(() => task.logs.slice(-6))
</script>

<template>
  <transition name="el-fade-in">
    <div v-if="task.running" class="progress-overlay">
      <div class="progress-overlay-head">
        <span class="progress-overlay-label">{{ label }}</span>
        <el-button
          size="small"
          :disabled="!task.current?.cancellable"
          @click="task.cancel()"
        >
          {{ task.current?.cancellable ? t('task.cancel') : t('task.cancelling') }}
        </el-button>
      </div>

      <el-progress
        :percentage="percent ?? 0"
        :indeterminate="percent === undefined"
        :show-text="percent !== undefined"
        :duration="2"
      />

      <div v-if="tailLogs.length" class="progress-overlay-logs">
        <div v-for="(line, index) in tailLogs" :key="index">{{ line }}</div>
      </div>
    </div>
  </transition>
</template>
