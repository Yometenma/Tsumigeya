<script setup lang="ts">
// 多版本引擎的版本管理（§4 VersionManagerDialog.vue）：已装列表 + 可下载列表 + 安装/删除。
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, translateError } from '@/api/client'
import { useTaskStore } from '@/stores/task'

const props = defineProps<{
  modelValue: boolean
  folder: string
  argKey: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  changed: []
}>()

const { t } = useI18n()
const task = useTaskStore()

const loading = ref(false)
const installed = ref<string[]>([])
const available = ref<Record<string, unknown>>({})
const error = ref<string | null>(null)

/** 当前架构（用于挑选构建）。与主进程 installVersion 的挑法一致。 */
const arch = computed(() => {
  const platform = window.tsumi?.platform
  return platform === 'x64' ? 'x86_64' : 'arm64'
})

const availableRows = computed(() =>
  Object.entries(available.value)
    .map(([version, builds]) => {
      const spec = builds as Record<string, unknown> | undefined
      const build = (spec?.universal ?? spec?.[arch.value]) as { link?: string } | undefined
      return { version, downloadable: !!build?.link }
    })
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
)

async function refresh(): Promise<void> {
  if (!props.folder || !props.argKey) return
  loading.value = true
  error.value = null
  try {
    const result = await api.versions(props.folder, props.argKey)
    installed.value = result.installed
    available.value = result.available
  } catch (caught) {
    error.value = translateError(caught, t)
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.modelValue, props.folder, props.argKey] as const,
  ([visible]) => {
    if (visible) void refresh()
  },
  { immediate: true }
)

async function install(version: string): Promise<void> {
  try {
    const result = await task.run(
      `${props.folder} ${version}`,
      api.installVersion(props.folder, props.argKey, version)
    )
    installed.value = result.installed
    available.value = result.available
    ElMessage.success(t('versions.installedToast', { version }))
    emit('changed')
  } catch (caught) {
    if (!task.isCancelled(caught)) ElMessage.error(translateError(caught, t))
  }
}

async function remove(version: string): Promise<void> {
  try {
    await ElMessageBox.confirm(
      t('versions.removeConfirmMessage', { version }),
      t('versions.removeConfirmTitle'),
      { type: 'warning', confirmButtonText: t('common.delete'), cancelButtonText: t('common.cancel') }
    )
  } catch {
    return
  }
  try {
    const result = await api.removeVersion(props.folder, props.argKey, version)
    installed.value = result.installed
    ElMessage.success(t('versions.removedToast', { version }))
    emit('changed')
  } catch (caught) {
    ElMessage.error(translateError(caught, t))
  }
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    :title="t('versions.title', { key: argKey })"
    width="520px"
    align-center
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon style="margin-bottom: 12px" />

    <el-skeleton v-if="loading" :rows="3" animated />

    <template v-else>
      <h4 style="margin: 0 0 8px">{{ t('versions.installed') }}</h4>
      <el-empty v-if="installed.length === 0" :description="t('args.noInstalledVersion')" :image-size="48" />
      <div v-else class="stack" style="gap: 6px">
        <div v-for="version in installed" :key="version" class="row">
          <span style="flex: 1">{{ version }}</span>
          <el-button size="small" text type="danger" @click="remove(version)">
            {{ t('versions.remove') }}
          </el-button>
        </div>
      </div>

      <h4 style="margin: 18px 0 8px">{{ t('versions.available') }}</h4>
      <el-empty v-if="availableRows.length === 0" :description="t('versions.noAvailable')" :image-size="48" />
      <div v-else class="stack" style="gap: 6px">
        <div v-for="row in availableRows" :key="row.version" class="row">
          <span style="flex: 1">{{ row.version }}</span>
          <span v-if="!row.downloadable" class="hint">{{ t('versions.noArch') }}</span>
          <el-button
            v-else
            size="small"
            type="primary"
            :disabled="installed.includes(row.version)"
            @click="install(row.version)"
          >
            {{ installed.includes(row.version) ? t('common.installed') : t('versions.install') }}
          </el-button>
        </div>
      </div>
    </template>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">{{ t('common.close') }}</el-button>
    </template>
  </el-dialog>
</template>
