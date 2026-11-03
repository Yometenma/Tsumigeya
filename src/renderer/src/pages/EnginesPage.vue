<script setup lang="ts">
// 引擎管理（§4 EnginesPage.vue）：已装/远程两栏、搜索、安装/更新/卸载、
// 检查更新、全部更新、依赖更新徽标；失败 warning 用 el-alert 展示。
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { translateError, type ModuleInfo, type RemoteModule } from '@/api/client'
import { useEnginesStore } from '@/stores/engines'
import { useTaskStore } from '@/stores/task'

const { t, d } = useI18n()
const engines = useEnginesStore()
const task = useTaskStore()

const tab = ref<'installed' | 'remote'>('installed')
/** 正在跑任务的引擎 folder（用按钮 loading）。 */
const pending = ref<string | null>(null)

const updateCount = computed(() => engines.updateCount)
const warnings = computed(() => engines.engineUpdates?.warnings ?? [])
const checkedAt = computed(() => engines.engineUpdates?.checkedAt ?? '')
const cachedRemote = computed(() => engines.engineUpdates?.cachedRemote === true)

onMounted(async () => {
  if (engines.modules.length === 0) await engines.load()
  // 远程列表单独拉；失败不崩（store 里存 remoteError）
  if (engines.remoteModules.length === 0) await engines.loadRemote()
})

function displayName(module: ModuleInfo | RemoteModule): string {
  const raw = 'raw' in module ? module.raw : undefined
  return (raw?.name as string | undefined)?.trim() || module.name?.trim() || ('folder' in module ? module.folder : '') || module.id
}

function moduleVersion(module: ModuleInfo | RemoteModule): string {
  const raw = 'raw' in module ? module.raw : undefined
  return (raw?.version as string | undefined) || module.version || t('common.unknown')
}

function moduleDescription(module: ModuleInfo | RemoteModule): string {
  const raw = 'raw' in module ? module.raw : undefined
  return (raw?.description as string | undefined) || module.description || ''
}

function updateFor(folder: string) {
  return engines.updatesById.get(folder)
}

/** 跑一个模块任务并刷新快照。 */
async function runModule(folder: string, action: 'install' | 'update' | 'dependencies' | 'uninstall', name: string) {
  pending.value = folder
  try {
    const snapshot = await task.run(name, engines.runTask({ folder, action, label: name }))
    engines.applySnapshot(snapshot)
    const toast =
      action === 'uninstall'
        ? t('engines.uninstalledToast', { name })
        : action === 'install'
          ? t('engines.installedToast', { name })
          : t('engines.updatedToast', { name })
    ElMessage.success(toast)
    if (action === 'install' || action === 'uninstall') await engines.loadRemote()
  } catch (error) {
    if (!task.isCancelled(error)) ElMessage.error(translateError(error, t))
  } finally {
    pending.value = null
  }
}

async function install(module: RemoteModule): Promise<void> {
  await runModule(module.folder, 'install', displayName(module))
}

async function update(module: ModuleInfo): Promise<void> {
  const entry = updateFor(module.id)
  const action = entry?.moduleUpdate === false && entry.dependencyUpdate ? 'dependencies' : 'update'
  await runModule(module.id, action, displayName(module))
}

async function updateDependencies(module: ModuleInfo): Promise<void> {
  await runModule(module.id, 'dependencies', displayName(module))
}

async function uninstall(module: ModuleInfo): Promise<void> {
  try {
    await ElMessageBox.confirm(
      t('engines.uninstallConfirmMessage', { name: displayName(module) }),
      t('engines.uninstallConfirmTitle'),
      { type: 'warning', confirmButtonText: t('engines.uninstall'), cancelButtonText: t('common.cancel') }
    )
  } catch {
    return
  }
  await runModule(module.id, 'uninstall', displayName(module))
}

async function checkUpdates(): Promise<void> {
  try {
    const report = await task.run(t('engines.checkUpdates'), engines.checkUpdates())
    engines.engineUpdates = report
    const count = report.updates.filter((item) => item.moduleUpdate || item.dependencyUpdate).length
    ElMessage.success(count === 0 ? t('engines.upToDate') : t('engines.checkDone', { count }))
  } catch (error) {
    if (!task.isCancelled(error)) ElMessage.error(translateError(error, t))
  }
}

async function updateAll(): Promise<void> {
  const count = updateCount.value
  if (count === 0) {
    ElMessage.info(t('engines.upToDate'))
    return
  }
  try {
    await ElMessageBox.confirm(
      t('engines.updateAllConfirmMessage', { count }),
      t('engines.updateAllConfirmTitle'),
      { type: 'info', confirmButtonText: t('engines.updateAll'), cancelButtonText: t('common.cancel') }
    )
  } catch {
    return
  }
  try {
    const snapshot = await task.run(t('engines.updateAll'), engines.updateAll())
    engines.applySnapshot(snapshot)
    ElMessage.success(t('engines.checkDone', { count }))
  } catch (error) {
    if (!task.isCancelled(error)) ElMessage.error(translateError(error, t))
  }
}

function formattedCheckedAt(): string {
  if (!checkedAt.value) return t('common.never')
  const value = new Date(checkedAt.value)
  return Number.isNaN(value.getTime()) ? checkedAt.value : d(value, 'long')
}
</script>

<template>
  <header class="row" style="margin-bottom: 4px">
    <div style="flex: 1">
      <h1 class="page-title">{{ t('engines.title') }}</h1>
      <p class="page-subtitle">{{ t('engines.checkedAt', { time: formattedCheckedAt() }) }}</p>
    </div>
    <div class="row">
      <el-button :loading="task.running" @click="checkUpdates">{{ t('engines.checkUpdates') }}</el-button>
      <el-button type="primary" :disabled="updateCount === 0" @click="updateAll">
        {{ t('engines.updateAll') }}
        <el-badge v-if="updateCount" :value="updateCount" type="danger" style="margin-left: 6px" />
      </el-button>
    </div>
  </header>

  <el-alert
    v-if="engines.remoteError"
    :title="t('engines.remoteUnavailable')"
    :description="engines.remoteError"
    type="error"
    :closable="false"
    show-icon
    style="margin-bottom: 12px"
  />

  <el-alert
    v-if="cachedRemote"
    :title="t('engines.cachedWarning')"
    type="warning"
    :closable="false"
    show-icon
    style="margin-bottom: 12px"
  />

  <div v-if="warnings.length" class="panel" style="margin-bottom: 12px">
    <h4 style="margin: 0 0 8px">{{ t('engines.warnings') }}</h4>
    <div v-for="(warning, index) in warnings" :key="index" class="hint" style="word-break: break-all">
      · {{ warning }}
    </div>
  </div>

  <div class="toolbar">
    <el-radio-group v-model="tab">
      <el-radio-button value="installed">
        {{ t('engines.installedTab') }} ({{ engines.modules.length }})
      </el-radio-button>
      <el-radio-button value="remote">
        {{ t('engines.remoteTab') }} ({{ engines.available.length }})
      </el-radio-button>
    </el-radio-group>
    <el-input
      v-model="engines.search"
      :placeholder="t('engines.searchPlaceholder')"
      clearable
      style="width: 240px"
    />
    <div class="toolbar-spacer" />
    <el-button text :loading="engines.loadingRemote" @click="engines.loadRemote()">
      {{ t('common.refresh') }}
    </el-button>
  </div>

  <!-- 已安装 -->
  <template v-if="tab === 'installed'">
    <div v-if="engines.installed.length === 0" class="empty-state">
      <div class="empty-state-title">{{ t('engines.noneInstalled') }}</div>
      <div>{{ t('engines.noneInstalledHint') }}</div>
      <el-button @click="tab = 'remote'">{{ t('engines.remoteTab') }}</el-button>
    </div>

    <div v-else class="engine-grid">
      <article v-for="module in engines.installed" :key="module.id" class="engine-card">
        <div class="engine-card-head">
          <span class="engine-card-name" :title="displayName(module)">{{ displayName(module) }}</span>
          <el-tag size="small">{{ moduleVersion(module) }}</el-tag>
          <el-tag v-if="updateFor(module.id)?.moduleUpdate" size="small" type="danger">
            {{ t('engines.hasUpdate', { version: updateFor(module.id)?.remoteVersion ?? '' }) }}
          </el-tag>
          <el-tag v-else-if="updateFor(module.id)?.dependencyUpdate" size="small" type="warning">
            {{ t('engines.dependencyBadge') }}
          </el-tag>
          <el-tag v-if="updateFor(module.id)?.checkFailed" size="small" type="info">
            {{ t('engines.checkFailed') }}
          </el-tag>
        </div>

        <div v-if="moduleDescription(module)" class="engine-card-desc">{{ moduleDescription(module) }}</div>
        <div class="hint">{{ module.id }}</div>

        <div class="engine-card-actions">
          <el-button
            v-if="updateFor(module.id)?.moduleUpdate"
            size="small"
            type="primary"
            :loading="pending === module.id"
            @click="update(module)"
          >
            {{ t('engines.update') }}
          </el-button>
          <el-button
            v-if="updateFor(module.id)?.dependencyUpdate"
            size="small"
            :loading="pending === module.id"
            @click="updateDependencies(module)"
          >
            {{ t('engines.dependencies') }}
          </el-button>
          <el-button
            v-if="!updateFor(module.id)?.moduleUpdate && !updateFor(module.id)?.dependencyUpdate"
            size="small"
            :loading="pending === module.id"
            @click="update(module)"
          >
            {{ t('engines.update') }}
          </el-button>
          <el-button size="small" text type="danger" :loading="pending === module.id" @click="uninstall(module)">
            {{ t('engines.uninstall') }}
          </el-button>
        </div>
      </article>
    </div>
  </template>

  <!-- 可安装 -->
  <template v-else>
    <el-skeleton v-if="engines.loadingRemote" :rows="3" animated />

    <div v-else-if="engines.available.length === 0" class="empty-state">
      <div class="empty-state-title">{{ t('engines.noneRemote') }}</div>
      <el-button @click="engines.loadRemote()">{{ t('common.retry') }}</el-button>
    </div>

    <div v-else class="engine-grid">
      <article v-for="module in engines.available" :key="module.folder" class="engine-card">
        <div class="engine-card-head">
          <span class="engine-card-name" :title="displayName(module)">{{ displayName(module) }}</span>
          <el-tag size="small">{{ moduleVersion(module) }}</el-tag>
        </div>
        <div v-if="moduleDescription(module)" class="engine-card-desc">{{ moduleDescription(module) }}</div>
        <div class="hint">{{ module.folder }}</div>
        <div class="engine-card-actions">
          <el-button size="small" type="primary" :loading="pending === module.folder" @click="install(module)">
            {{ t('engines.install') }}
          </el-button>
        </div>
      </article>
    </div>
  </template>
</template>
