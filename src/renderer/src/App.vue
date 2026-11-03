<script setup lang="ts">
// 侧边栏布局 + 路由出口 + 全局挂载 ProgressOverlay / CoreDialogHost（§4 App.vue）。
// 首次 snapshot 在这里拉取，并把 settings 同步给 settings store。
import { computed, onBeforeUnmount, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import { ElMessage } from 'element-plus'
import ProgressOverlay from '@/components/ProgressOverlay.vue'
import CoreDialogHost from '@/components/CoreDialogHost.vue'
import { api, translateError } from '@/api/client'
import { useLibraryStore } from '@/stores/library'
import { useSettingsStore } from '@/stores/settings'
import { useEnginesStore } from '@/stores/engines'
import { useTaskStore } from '@/stores/task'
import { useCoreDialogsStore } from '@/stores/coreDialogs'

const { t } = useI18n()
const route = useRoute()
const library = useLibraryStore()
const settings = useSettingsStore()
const engines = useEnginesStore()
const task = useTaskStore()
const coreDialogs = useCoreDialogsStore()

const navItems = computed(() => [
  { path: '/library', label: t('nav.library'), icon: '🎮' },
  { path: '/engines', label: t('nav.engines'), icon: '⚙️' },
  { path: '/settings', label: t('nav.settings'), icon: '🛠️' }
])

const appVersion = computed(() => (window.tsumi?.appVersion ? `v${window.tsumi.appVersion}` : ''))
const platform = computed(() => window.tsumi?.platform ?? '')

onMounted(async () => {
  // 事件订阅先装（core 可能在 snapshot 之前就发 dialog）
  task.install()
  coreDialogs.install()
  settings.initMeta(window.tsumi?.appVersion ?? '', '', window.tsumi?.platform ?? '')
  // system 外观要跟随系统变化
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', applyAppearanceOnChange)

  try {
    const snapshot = await api.snapshot()
    library.applySnapshot(snapshot)
    settings.applySnapshot(snapshot)
    engines.applySnapshot(snapshot)
    if (snapshot.settings.checkModuleUpdatesOnStartup) {
      // 启动检查更新：失败静默（引擎页可以看到 warning）
      void task
        .run('startup-updates', api.checkEngineUpdates(false))
        .then((report) => {
          engines.engineUpdates = report
        })
        .catch(() => undefined)
    }
  } catch (error) {
    ElMessage.error(translateError(error, t))
  }
})

function applyAppearanceOnChange(): void {
  settings.applyAppearance()
}

onBeforeUnmount(() => {
  window.matchMedia?.('(prefers-color-scheme: dark)').removeEventListener('change', applyAppearanceOnChange)
  task.dispose()
  coreDialogs.dispose()
})

function isActive(path: string): boolean {
  if (path === '/library') return route.path.startsWith('/library') || route.path.startsWith('/game')
  return route.path.startsWith(path)
}
</script>

<template>
  <div class="app-shell">
    <aside class="app-sidebar">
      <div class="app-brand">
        <span class="app-brand-name">{{ t('app.name') }}</span>
        <span class="app-brand-tagline">{{ t('app.tagline') }}</span>
      </div>

      <RouterLink
        v-for="item in navItems"
        :key="item.path"
        :to="item.path"
        class="app-nav-item"
        :class="{ 'is-active': isActive(item.path) }"
      >
        <span>{{ item.icon }}</span>
        <span>{{ item.label }}</span>
      </RouterLink>

      <div class="app-sidebar-footer">
        <div>{{ appVersion }}</div>
        <div>{{ platform }}</div>
      </div>
    </aside>

    <main class="app-main">
      <RouterView />
    </main>

    <ProgressOverlay />
    <CoreDialogHost />
  </div>
</template>
