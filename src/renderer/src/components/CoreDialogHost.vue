<script setup lang="ts">
// core 对话框 host：把 coreDialogs store 的队列渲染成弹窗（§4 CoreDialogHost.vue）。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useCoreDialogsStore } from '@/stores/coreDialogs'

const { t } = useI18n()
const coreDialogs = useCoreDialogsStore()

const title = computed(() => {
  const dialog = coreDialogs.current
  if (!dialog) return ''
  // core 给的 title 优先（多为英文原文），空则用本地化兜底
  if (dialog.title) return dialog.title
  return dialog.kind === 'confirm' ? t('dialog.confirmTitle') : t('dialog.alertTitle')
})
</script>

<template>
  <el-dialog
    :model-value="coreDialogs.visible"
    :title="title"
    width="440px"
    align-center
    :close-on-click-modal="false"
    :close-on-press-escape="false"
    :show-close="false"
    append-to-body
  >
    <p class="dialog-message">{{ coreDialogs.current?.message }}</p>

    <template #footer>
      <el-button v-if="coreDialogs.current?.kind === 'confirm'" @click="coreDialogs.dismiss()">
        {{ t('common.cancel') }}
      </el-button>
      <el-button type="primary" @click="coreDialogs.accept()">
        {{ coreDialogs.current?.kind === 'confirm' ? t('common.confirm') : t('common.ok') }}
      </el-button>
    </template>
  </el-dialog>
</template>

<style scoped>
.dialog-message {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.65;
}
</style>
