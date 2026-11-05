<script setup lang="ts">
// 引擎管理（§4 EnginesPage.vue）：已装/远程两栏、搜索、安装/更新/卸载、
// 检查更新、全部更新、依赖更新徽标；失败 warning 用 el-alert 展示。
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { translateError, type ModuleInfo, type RemoteModule } from '@/api/client'
import { useEnginesStore } from '@/stores/engines'
import { useTaskStore } from '@/stores/task'
import {
  installAllCount,
  installAllOutcome,
  pendingInstalls,
  runInstallAll,
  type InstallTarget
} from '../../../shared/install-all'
import { hasDependencies, installableTargets, isExperimental, toCardSources } from '../../../shared/engine-card'

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

// ===== M5.0 S8（U10）：全部安装 =====
//
// 与「全部更新」对称，但**失败策略刻意不同**（方案 §10 的「必须逐个 + 进度」）：
// `updateAllEngines` 是第一个失败就 throw，而这里**失败不中断**。
// 理由见 shared/install-all.ts 顶部 —— 一句话：四个引擎相互独立，
// 一次几百 MB 断在某一个是常态，不该把装好的那几个一起废掉。

/**
 * 判据输入：把 store 的 `available`（含 manifest `raw`）转成判据要的形状。
 *
 * 为什么要这一层：`shared/engine-card.ts` 是**零依赖纯函数**，它不能 import
 * 主进程的 registry（`tsconfig.web.json` 不含 `src/main/`，跨工程会 TS6307）。
 * 所以由这里把数据递进去，判据保持纯净、可单测。
 */
const cardSources = computed(() => toCardSources(engines.available))

/** 某张卡片要不要显示「安装」按钮。 */
function canInstall(folder: string): boolean {
  return hasDependencies(folder, cardSources.value)
}

/** 某张卡片要不要显示「实验性」标签。 */
function showExperimental(folder: string): boolean {
  return isExperimental(folder, cardSources.value)
}

/**
 * 还没装的引擎数（按钮上的数字与 disabled 判据）。
 *
 * ⚠️ M6.5：先过 `installableTargets` 排除**空依赖**的引擎（tyrano）。
 * 不排除的话，「全部安装」会把它算进去 → 装它的时候什么都没发生 →
 * 用户看到「装了 3 个」，其中一个其实没装。数字撒谎比按钮坏掉更难查。
 */
const installAllPending = computed(() =>
  installAllCount(
    installableTargets(engines.available, cardSources.value),
    new Set(engines.modules.map((module) => module.id))
  )
)

/** 全部安装的进度（null = 没在跑）。 */
const installAllProgress = ref<{ done: number; total: number } | null>(null)
/** 正在装的是哪个（卡片按钮的 loading）。 */
const installingNow = ref<string | null>(null)

/**
 * 「全部安装」。
 *
 * ===== 取消权交给进度浮层（不做第二套「停止」按钮）=====
 *
 * ProgressOverlay 已经有一个取消按钮，它走 `task.cancel()` → 主进程的 AbortController，
 * **正在下载的那一个也能立刻打断**。本鱼一开始想自己搞一个 `installAllCancelled` 标志，
 * 但那套只能在「引擎之间」生效 —— 用户在下一个 244MB 的 RTP 时点「停止」，
 * 得等到它下完才有反应，比浮层那个明显更差。
 *
 * 两套取消并存还会互相矛盾：浮层取消了一个、外层标志仍是 false，
 * 后面几个会接着装，用户以为停不了。
 *
 * 所以：**只保留浮层那一个入口**。这里的 `isCancelled` 检查的是 `task.isCancelled` 的
 * 语义 —— 即「上一层任务被用户取消了」。见下方 install 回调里的判断。
 */
async function installAll(): Promise<void> {
  // M6.5：同样先排除空依赖的引擎（理由见 installAllPending 的注释）
  const targets = pendingInstalls(
    installableTargets(engines.available, cardSources.value),
    new Set(engines.modules.map((module) => module.id))
  )
  if (targets.length === 0) {
    ElMessage.info(t('engines.noneToInstall'))
    return
  }
  try {
    await ElMessageBox.confirm(
      t('engines.installAllConfirmMessage', { count: targets.length }),
      t('engines.installAllConfirmTitle'),
      { type: 'info', confirmButtonText: t('engines.installAll'), cancelButtonText: t('common.cancel') }
    )
  } catch {
    return
  }

  /** 用户在浮层点了取消（某个 install 抛 error.cancelled 时置位）。 */
  let userCancelled = false
  installAllProgress.value = { done: 0, total: targets.length }
  const result = await runInstallAll(targets, {
    install: async (target: InstallTarget) => {
      installingNow.value = target.folder
      try {
        const snapshot = await task.run(
          target.name,
          engines.runTask({ folder: target.folder, action: 'install', label: target.name })
        )
        engines.applySnapshot(snapshot)
      } catch (error) {
        // 用户取消不是"失败"：要让 runInstallAll 停下来而不是继续装下一个
        if (task.isCancelled(error)) userCancelled = true
        throw error
      }
    },
    onProgress: (done, total) => {
      installAllProgress.value = { done, total }
    },
    isCancelled: () => userCancelled
  })
  installingNow.value = null
  installAllProgress.value = null

  // 「可安装」列表要随已装数变化而刷新（引擎页靠它画卡片）
  await engines.loadRemote()

  const outcome = installAllOutcome(result)
  if (outcome === 'all-success') {
    ElMessage.success(t('engines.installAllDone', { count: result.installed.length }))
  } else if (outcome === 'partial') {
    // ⚠️ warning 而不是 error：有一部分**真的装上了**，报红会让用户去重装一遍已装好的
    ElMessage.warning(
      t('engines.installAllPartial', { installed: result.installed.length, failed: result.failed.length })
    )
    console.warn(
      `[tsumigeya] 全部安装部分失败：${result.failed.map((item) => item.folder).join(' / ')}`,
      result.failed.map((item) => item.error)
    )
  } else if (outcome === 'all-failed') {
    ElMessage.error(t('engines.installAllFailed', { count: result.failed.length }))
  } else {
    ElMessage.info(t('engines.installAllCancelled', { count: result.installed.length }))
  }
}
</script>

<template>
  <header class="row" style="margin-bottom: 4px">
    <div style="flex: 1">
      <h1 class="page-title">{{ t('engines.title') }}</h1>
      <p class="page-subtitle">{{ t('engines.checkedAt', { time: formattedCheckedAt() }) }}</p>
    </div>
    <div class="row">
      <el-button :loading="task.running" :disabled="!!installAllProgress || task.running" @click="checkUpdates">
        {{ t('engines.checkUpdates') }}
      </el-button>
      <!-- M5.0 S8：与「全部安装」互斥 —— 两套批量任务同时跑会往同一个队列里塞，
           进度浮层也会互相覆盖。 -->
      <el-button
        type="primary"
        :disabled="updateCount === 0 || !!installAllProgress"
        @click="updateAll"
      >
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

    <!-- M5.0 S8（U10）：可安装标签页的「全部安装」——与已安装页的「全部更新」对称。
         只在可安装标签下出现：已装的那个页签里"全部安装"没有意义（都已经装了）。

         ⚠️ 这里**没有自建的「停止」按钮**：取消走 ProgressOverlay 那个（`task.cancel()`），
         它能打断**正在下载的那一个**；自建一套只能在引擎之间生效，
         用户在下一个 244MB 的 RTP 时点停止要等它下完，明显更差，而且两套并存会互相矛盾。 -->
    <template v-if="tab === 'remote'">
      <span v-if="installAllProgress" class="hint">
        {{ t('engines.installAllProgress', { done: installAllProgress.done, total: installAllProgress.total }) }}
      </span>
      <el-button
        v-else
        type="primary"
        :disabled="installAllPending === 0 || task.running"
        @click="installAll"
      >
        {{ t('engines.installAll') }}
        <el-badge v-if="installAllPending" :value="installAllPending" type="info" style="margin-left: 6px" />
      </el-button>
    </template>

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
          <!-- M6.5：实验性引擎（目前只有吉里吉里）。
               为什么不藏起来：它**照常可用**，藏起来等于骗人；
               但也不该让用户以为这是本项目官方承诺的能力（上游明写不支援商用游戏）。 -->
          <el-tag v-if="showExperimental(module.folder)" size="small" type="warning">
            {{ t('engines.experimental') }}
          </el-tag>
        </div>
        <div v-if="moduleDescription(module)" class="engine-card-desc">{{ moduleDescription(module) }}</div>
        <div class="hint">{{ module.folder }}</div>
        <div class="engine-card-actions">
          <!-- ===== M6.5：**没有依赖的引擎不显示「安装」按钮** =====
               TyranoScript 复用 NW.js 的运行时，它自己 dependencies 是**空对象**（有意为之）。
               原来这里无条件显示「安装」，于是用户点它 → 主进程发现没有依赖可装 →
               要么报错、要么"装完了但什么都没发生"。
               两者都是 D60 说的「不起作用的开关」：**比不显示更糟**。
               改成：空依赖就显示「无需单独下载」并禁用按钮。 -->
          <template v-if="canInstall(module.folder)">
            <el-button
              size="small"
              type="primary"
              :loading="pending === module.folder || installingNow === module.folder"
              :disabled="!!installAllProgress || task.running"
              @click="install(module)"
            >
              {{ t('engines.install') }}
            </el-button>
          </template>
          <span v-else class="hint">{{ t('engines.noDependencies') }}</span>
        </div>
      </article>
    </div>
  </template>
</template>
