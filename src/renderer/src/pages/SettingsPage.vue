<script setup lang="ts">
// 设置页（§4 SettingsPage.vue）：外观/语言/列表视图/删除确认/自动识别未装引擎/
// 启动检查更新、数据目录（打开/复制）、版本信息。改外观立即生效。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { api, translateError, type Appearance, type Settings } from '@/api/client'
import { useSettingsStore } from '@/stores/settings'

const { t } = useI18n()
const settings = useSettingsStore()

const appearance = computed<Appearance>(() => settings.settings.appearance)

const appearanceOptions = computed<Array<{ label: string; value: Appearance }>>(() => [
  { label: t('settings.appearanceSystem'), value: 'system' },
  { label: t('settings.appearanceLight'), value: 'light' },
  { label: t('settings.appearanceDark'), value: 'dark' }
])

async function patch(partial: Partial<Settings>): Promise<void> {
  try {
    await settings.save(partial)
    ElMessage.success(t('settings.saved'))
  } catch (error) {
    ElMessage.error(translateError(error, t))
  }
}

async function openDataDir(): Promise<void> {
  try {
    await api.openFolder(settings.dataPath)
  } catch (error) {
    ElMessage.error(translateError(error, t))
  }
}

async function copyDataPath(): Promise<void> {
  try {
    await navigator.clipboard.writeText(settings.dataPath)
    ElMessage.success(t('common.copied'))
  } catch {
    ElMessage.error(t('error.network'))
  }
}
</script>

<template>
  <h1 class="page-title">{{ t('settings.title') }}</h1>
  <p class="page-subtitle">{{ t('app.tagline') }}</p>

  <section class="panel">
    <div class="settings-row">
      <div class="settings-row-main">
        <div class="settings-row-title">{{ t('settings.appearance') }}</div>
      </div>
      <el-radio-group :model-value="appearance" @update:model-value="patch({ appearance: $event as Appearance })">
        <el-radio-button v-for="option in appearanceOptions" :key="option.value" :value="option.value">
          {{ option.label }}
        </el-radio-button>
      </el-radio-group>
    </div>

    <div class="settings-row">
      <div class="settings-row-main">
        <div class="settings-row-title">{{ t('settings.language') }}</div>
      </div>
      <el-select
        :model-value="settings.settings.language"
        style="width: 200px"
        @update:model-value="patch({ language: $event })"
      >
        <el-option :label="t('settings.languageSystem')" value="system" />
        <el-option label="简体中文" value="zh-CN" />
      </el-select>
    </div>

    <div class="settings-row">
      <div class="settings-row-main">
        <div class="settings-row-title">{{ t('settings.listView') }}</div>
        <div class="settings-row-hint">{{ t('settings.listViewHint') }}</div>
      </div>
      <el-switch
        :model-value="settings.settings.listView"
        @update:model-value="patch({ listView: $event === true })"
      />
    </div>

    <div class="settings-row">
      <div class="settings-row-main">
        <div class="settings-row-title">{{ t('settings.deletionConfirmation') }}</div>
      </div>
      <el-switch
        :model-value="settings.settings.deletionConfirmation"
        @update:model-value="patch({ deletionConfirmation: $event === true })"
      />
    </div>

    <div class="settings-row">
      <div class="settings-row-main">
        <div class="settings-row-title">{{ t('settings.nonInstalledAutodetect') }}</div>
        <div class="settings-row-hint">{{ t('settings.nonInstalledAutodetectHint') }}</div>
      </div>
      <el-switch
        :model-value="settings.settings.nonInstalledAutodetect"
        @update:model-value="patch({ nonInstalledAutodetect: $event === true })"
      />
    </div>

    <div class="settings-row">
      <div class="settings-row-main">
        <div class="settings-row-title">{{ t('settings.checkModuleUpdatesOnStartup') }}</div>
      </div>
      <el-switch
        :model-value="settings.settings.checkModuleUpdatesOnStartup"
        @update:model-value="patch({ checkModuleUpdatesOnStartup: $event === true })"
      />
    </div>
  </section>

  <section class="panel" style="margin-top: 16px">
    <div class="settings-row">
      <div class="settings-row-main">
        <div class="settings-row-title">{{ t('settings.dataDirectory') }}</div>
        <div class="settings-row-hint" style="word-break: break-all">{{ settings.dataPath || '—' }}</div>
      </div>
      <div class="row" style="flex: 0 0 auto">
        <el-button @click="openDataDir">{{ t('settings.openDataDirectory') }}</el-button>
        <el-button @click="copyDataPath">{{ t('settings.copyPath') }}</el-button>
      </div>
    </div>
    <el-alert
      v-if="settings.dataDirWarning"
      type="warning"
      :closable="false"
      style="margin-top: 10px"
      :title="t('settings.dataDirFallbackTitle')"
      :description="
        t('settings.dataDirFallbackDesc', {
          requested: settings.dataDirWarning.requested,
          code: settings.dataDirWarning.code
        })
      "
    />
  </section>

  <section class="panel" style="margin-top: 16px">
    <div class="settings-row-title" style="margin-bottom: 10px">{{ t('settings.about') }}</div>
    <div class="hint">{{ t('settings.version', { version: settings.appVersion || '—' }) }}</div>
    <div class="hint">{{ t('settings.node', { version: settings.nodeVersion || '—' }) }}</div>
    <div class="hint">{{ t('settings.platform', { platform: settings.platform || '—' }) }}</div>
  </section>
</template>
