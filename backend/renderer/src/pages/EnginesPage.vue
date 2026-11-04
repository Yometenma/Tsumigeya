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

// ===== M4.1 S4：`LAUNCHABLE_ENGINE_IDS` 与「标灰」一并删除 =====
//
// 原来这里有一份镜像名单（`['nwjs','mkxpz','easyrpg','renpy']`）+ `isLaunchable()`
// + 卡片上的「不支持启动」标灰 + `test/launchable-engines-consistency.test.ts`
// （专门比对渲染层镜像与主进程 `LAUNCHABLE_ENGINES` 是否一致）。
//
// 为什么现在全删（而不是留着）：
//   · 「可安装」列表来自主进程的 `ENGINES`，**天生只有那四个**（D60）
//   · 用户装的旧引擎（ruffle/wine/macos）在主进程侧已经不受支持：
//     registry 里没有它 → `checkEngineUpdates` 会把它列进 warnings，
//     点启动会明确报 `error.engineNotLaunchable`（D57）
//   · 于是 `isLaunchable()` 在这张页面上**恒为 true** —— 一个永远返回 true 的判断
//     就是死代码，而「两份名单必须一致」的测试也失去了比对对象
//
// 换句话说：标灰是为了「别让用户装完才发现不能用」，而现在根本**装不到**不能用的引擎
// （可安装列表里没有它们），所以这个提醒没有存在的场景了。

const updateCount = computed(() => engines.updateCount)
const warnings = computed(() => engines.engineUpdates?.warnings ?? [])
const checkedAt = computed(() => engines.engineUpdates?.checkedAt ?? '')
// M4.1 S4：`cachedRemote` 删除。主进程侧它已恒为 false（没有远端清单也就没有远端缓存），
// 留着它会让用户以为「列表可能来自旧缓存」——而那个场景已经不存在了。
// 字段本身在 Snapshot/EngineUpdateReport 里保留（不破坏数据结构），只是页面不再展示。

onMounted(async () => {
  if (engines.modules.length === 0) await engines.load()
  // 「可安装」列表：来自主进程 registry（零网络，毫秒级；失败只 console.warn，不弹告警）
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

/**
 * 引擎的一句话说明。
 *
 * M4.1 S4：优先用**中文**（i18n 的 `engines.desc.<folder>`），
 * 而不是 manifest 里的英文 `description`。
 *
 * 为什么改：manifest 的 description 现在是 registry 里那段英文
 * （"A module to launch NW.js native games…"）。那是一份**兼容字段**
 * （原版 Xenolauncher 也读它），不该是展示给中文用户的文案。
 * 中文没有对应 key 时才回退到英文（保留兜底，不让描述整块消失）。
 */
function moduleDescription(module: ModuleInfo | RemoteModule): string {
  const folder = 'folder' in module ? module.folder : module.id
  const key = `engines.desc.${folder}`
  const translated = t(key)
  // vue-i18n 缺 key 时会原样返回 key 本身（不是空串），据此判断有没有翻译
  if (translated && translated !== key) return translated
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
  await runModule(module.id, 'update', displayName(module))
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
    const count = report.updates.filter((item) => item.moduleUpdate).length
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

  <!-- M4.1 S4：原来的两条告警已删
       · `engines.remoteError`（「无法获取远程引擎列表」）—— 可安装列表现在来自本地 registry，
         不再有「远程列表拉失败」这回事
       · `engines.cachedWarning`（「远程列表来自本地缓存」）—— 没有远端也就没有缓存 -->

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
          <el-tag v-if="updateFor(module.id)?.checkFailed" size="small" type="info">
            {{ t('engines.checkFailed') }}
          </el-tag>
        </div>

        <!-- M4.1 S4：原来的「不支持启动」标灰与提示已删除（理由见 script 顶部的注释）。
             现在能装到的引擎天生都是能启动的 —— 可安装列表只有 registry 那四个。 -->

        <div v-if="moduleDescription(module)" class="engine-card-desc">{{ moduleDescription(module) }}</div>
        <div class="hint">{{ module.id }}</div>

        <div class="engine-card-actions">
          <!-- M4.2 S7（D64）：原来这里有三个分支（更新 / 更新依赖 / 兜底更新）。
               现在只剩一个：没有远端清单之后「依赖更新」没有比较对象，
               `dependencyUpdate` 恒为 false，「更新依赖」按钮永远不出现 —— 留着就是空壳。
               「更新」按钮本身无条件显示：它的语义是「把引擎刷新到 registry 的版本」（D66）。 -->
          <el-button
            size="small"
            :type="updateFor(module.id)?.moduleUpdate ? 'primary' : 'default'"
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
