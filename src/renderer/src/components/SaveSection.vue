<script setup lang="ts">
// M4 S2/S3/S4：详情页「存档」区块（列表 + 导出 + 导入）。
//
// ===== 这个组件唯一要防的错误：把两个"没有存档"糊成一句 =====
//
// 主进程给的 `location: null`（**不知道在哪**）与 `empty: true`（**还没存过档**）
// 是两个不同的状态。糊成一句的后果不是崩溃，而是用户**永远查不出问题**：
// 他把"我们没找到"当成"我还没玩到"，于是永远等着一个不会出现的存档。
//
// ⇒ 三种分支的判据全在 `shared/save-view.ts`（纯函数，18 条单测），
//    这里只负责把结构画出来 + 查 i18n 键。**绝不在这里判**（写在组件里就没法单测）。
//
// ===== 导出/导入的两条硬约束（方案 §3.3/§3.4）=====
//
// ① **运行中禁止导出**：游戏正在写存档时读出来的是半截文件，用户带着它换机会丢档。
//    主进程会再拦一次（`error.saveExportRunning`），这里只是"提前把按钮禁掉"，
//    让用户不必点了才知道。**主进程那一层不能省**（UI 拦不住所有路径）。
// ② **导入先备份**：主进程的顺序是「校验 sha256 → 备份 → 才写」，
//    全部在 `save-archive-io.ts` 里（有 26 条读写真盘的测试）。
//
// ===== 三条已知坑（AGENTS.md）=====
// ① 模板禁 TS 类型断言、禁复杂表达式（都会白屏）→ 判据都在 script 里
// ② 所有 ref/computed 在任何 `watch({immediate:true})` 之前声明（TDZ 白屏）
// ③ 「在访达中显示」复用 `api.openFolder` —— 主进程有 `isPathAllowed` 白名单
//    （数据目录 或 已登记游戏的目录内），这里**不自己判路径**，只把路径交出去
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import AppIcon from '@/components/AppIcon.vue'
import { api, translateError, type SaveListing } from '@/api/client'
import { saveSectionView } from '../../../shared/save-view'
import { showsManualButtons, validSaveSyncMode } from '../../../shared/save-sync'
import { useSettingsStore } from '@/stores/settings'

const props = defineProps<{
  /** 游戏 id（换游戏要重拉列表）。 */
  gameId: string
  /** 这个游戏是否正在运行（运行中禁止导出，S3 的保护）。 */
  running: boolean
}>()

const { t } = useI18n()
const settings = useSettingsStore()

// ===== 状态（全部在 watch 之前声明，避免 TDZ）=====

/** 最近一次列出来的结果；null = 还没拉到 / 拉失败。 */
const listing = ref<SaveListing | null>(null)
/** 是否正在拉（首次进入 + 手动刷新）。 */
const loading = ref(false)
/** 导出/导入进行中（按钮 loading + 防重复点击）。 */
const exporting = ref(false)
const importing = ref(false)

// ===== 派生数据 =====

/** 三种形态（unknown / empty / list）的唯一判据。 */
const view = computed(() => saveSectionView(listing.value))

/** 「不知道在哪」/「知道在哪但读不了」/「还没存档」三种文案必须分开 —— 见文件头。 */
const unknownText = computed(() => t('detail.savesUnknown'))
const unreadableText = computed(() => t('detail.savesUnreadable'))
const emptyText = computed(() => t('detail.savesEmpty'))

/** 有位置时才有「在访达中显示」可点（没位置就无从打开）。 */
const canReveal = computed(() => view.value.kind !== 'unknown')

/**
 * 导出/导入这两个按钮要不要画（M4 S5 的同步模式判据）。
 *
 * ===== 为什么走 shared 而不是直接 `v-if="true"` =====
 *
 * 「`none` 模式也照样显示按钮」是一个**刻意的决定**（判据在
 * `shared/save-sync.ts` 的 `showsManualButtons`）：`none` 的语义是
 * "我不需要同步方案"，**不是**"我不想备份"。把按钮藏起来等于让用户
 * 以为没有这个功能，而手动导入导出本来就是唯一真能防丢档的手段。
 *
 * 写成判据（而不是模板里恒真的 `v-if`）的好处：将来真加了云模式时，
 * 这里就是该分叉的地方，而现有那条「每个合法模式都是 true」的测试会当场变红。
 */
const showManualButtons = computed(() => showsManualButtons(validSaveSyncMode(settings.settings.saveSyncMode)))

/** 当前目录（unknown 时是空串，不给按钮传 undefined）。 */
const dirPath = computed(() => {
  const kind = view.value
  return kind.kind === 'unknown' ? '' : kind.dir
})

/**
 * 能不能导出。
 *
 * 三个条件缺一不可：
 *   · 有存档可导（`list` 形态；unknown/empty 时导出只会得到一个空包）
 *   · 游戏没在跑（**硬约束**：运行中的存档可能正在写 → 包是半截的）
 *   · 当前没有正在进行的导入/导出
 */
const canExport = computed(() => {
  if (props.running) return false
  if (exporting.value || importing.value) return false
  return view.value.kind === 'list'
})

/**
 * 「按钮为什么是灰的」的说明。
 *
 * 一个禁用按钮没有任何说明，用户只会觉得坏了 —— 所以必须能解释。
 */
const exportBlockedHint = computed(() => {
  if (view.value.kind === 'empty') return t('detail.savesEmpty')
  if (view.value.kind === 'unknown') return t('detail.savesUnknown')
  if (props.running) return t('error.saveExportRunning')
  return ''
})

/**
 * 每项的修改时间文案。
 *
 * 用 `toLocaleString()` 让日期格式跟着系统区域走（这是对的），
 * 但**必须先判可解析**：`new Date('').toLocaleString()` 会画出英文 "Invalid Date"。
 * 判据 `timeValid` 来自 shared/save-view.ts（有单测）。
 */
function timeText(timeValid: boolean, mtime: string): string {
  if (!timeValid) return ''
  return new Date(mtime).toLocaleString()
}

// ===== 动作 =====

/** 拉一次存档列表（进详情页 / 换游戏时调用）。 */
async function load(): Promise<void> {
  if (!props.gameId) return
  loading.value = true
  try {
    listing.value = await api.listSaves(props.gameId)
  } catch (error) {
    // 拉失败就是「不知道在哪」：不编造一个空列表（那会被读成"还没存档"）
    listing.value = null
    ElMessage.error(translateError(error, t))
  } finally {
    loading.value = false
  }
}

/**
 * 「在访达中显示」。
 *
 * 复用 `openFolder`：主进程的 `isPathAllowed` 白名单只放行
 * 「数据目录内 或 某个已登记游戏的目录内」的路径。游戏运行中**也能打开**
 * —— 看文件不是危险动作，只有导出要拦（S3）。
 */
async function revealInFinder(): Promise<void> {
  if (!dirPath.value) return
  try {
    await api.openFolder(dirPath.value)
  } catch (error) {
    ElMessage.error(translateError(error, t))
  }
}

/**
 * 导出（S3）。
 *
 * 主进程会弹目录选择框（默认落在下载目录），所以这里不自己选路径 ——
 * 选目录的逻辑（含"不选就用默认"）只有主进程那一份。
 *
 * 失败时的文案来自 `translateError`：运行中那条是 `error.saveExportRunning`
 * （"请先关闭游戏"），与"没存档"/"找不到位置"分开 —— 用户能据此知道该做什么。
 */
async function exportSaves(): Promise<void> {
  if (!canExport.value || exporting.value) return
  exporting.value = true
  try {
    const result = await api.exportSaves(props.gameId)
    // ⚠️ **取消要单独判**（真机实测的 bug）：用户在系统目录框点「取消」时
    //    主进程一个字节都不写，返回 cancelled。此时**不能**弹「已导出」。
    //    原来没有这条：取消 → 落到 ~/Downloads 照样导了，还弹成功。
    if (result.cancelled) return
    // 用「已导出：<文件名>」而不是「导出成功」：用户要知道包在哪、叫什么
    ElMessage.success(t('detail.exportDone', { name: filenameOf(result.file) }))
    await load()
  } catch (error) {
    ElMessage.error(translateError(error, t))
  } finally {
    exporting.value = false
  }
}

/**
 * 导入（S4）。
 *
 * 只接受我们导出的包（主进程按 manifest 的 sha256 逐文件校验）。
 * 导入后重拉列表：用户要立刻看到"档回来了"。
 */
async function importSaves(): Promise<void> {
  if (importing.value || props.running) return
  const file = await api.pickPath('file')
  if (!file) return
  importing.value = true
  try {
    const result = await api.importSaves(props.gameId, file)
    // 有备份就把备份数说出来 —— 用户要知道"我的旧档还在，去哪找"
    ElMessage.success(
      result.backups.length > 0
        ? t('detail.importDoneWithBackup', { count: result.backups.length })
        : t('detail.importDone', { count: result.fileCount })
    )
    await load()
  } catch (error) {
    ElMessage.error(translateError(error, t))
  } finally {
    importing.value = false
  }
}

/** 绝对路径 → 文件名（提示里只显示名字，全路径太长）。 */
function filenameOf(file: string): string {
  const parts = file.split(/[/\\]/)
  return parts[parts.length - 1] || file
}

// 换游戏就重拉（否则上一个游戏的存档列表会残留）。
// ⚠️ `immediate: true` 在这里是安全的：上面所有 ref/computed 都已声明完。
watch(() => props.gameId, () => void load(), { immediate: true })
</script>

<template>
  <section class="detail-section save-section">
    <h2 class="detail-section-title">{{ t('detail.saves') }}</h2>

    <!-- ① 不知道存档在哪（故障态：不是"没存档"，该去查引擎识别） -->
    <template v-if="view.kind === 'unknown'">
      <div class="detail-missing">{{ unknownText }}</div>
    </template>

    <!-- ② **位置找到了，但目录读不进来**（故障态：该去查文件权限，不是查引擎识别）。
         必须排在 empty 之前 —— 读不到时机器上 slots 也是空，不先判就会画成"没有存档"。 -->
    <template v-else-if="view.kind === 'unreadable'">
      <div class="detail-missing">{{ unreadableText }}</div>
      <div class="hint" style="word-break: break-all">{{ view.dir }}</div>
    </template>

    <!-- ③ 位置找到了，但还没存过档（正常态：给下一步动作） -->
    <template v-else-if="view.kind === 'empty'">
      <div class="detail-missing">{{ emptyText }}</div>
    </template>

    <!-- ④ 有内容：槽与配置**分开列**（config 不是第 0 号存档） -->
    <template v-else>
      <div class="save-table">
        <div v-for="item in view.slots" :key="item.name" class="save-row">
          <span class="save-name">{{ item.name }}</span>
          <span class="save-size">{{ item.sizeText }}</span>
          <span class="save-time">{{ timeText(item.timeValid, item.mtime) }}</span>
        </div>
      </div>

      <div v-if="view.hasConfigs" class="save-configs">
        <div class="save-configs-title">{{ t('detail.savesConfigsTitle') }}</div>
        <div v-for="item in view.configs" :key="item.name" class="save-row is-config">
          <span class="save-name">{{ item.name }}</span>
          <span class="save-size">{{ item.sizeText }}</span>
          <span class="save-time">{{ timeText(item.timeValid, item.mtime) }}</span>
        </div>
      </div>
    </template>

    <div class="save-actions">
      <el-button v-if="canReveal" text size="small" :loading="loading" @click="revealInFinder">
        <template #icon><AppIcon name="FolderOpen" :size="16" :stroke-width="1.75" /></template>
        {{ t('detail.revealInFinder') }}
      </el-button>
      <el-button text size="small" :loading="loading" @click="load">
        <template #icon><AppIcon name="RefreshCw" :size="16" :stroke-width="1.75" /></template>
        {{ t('common.refresh') }}
      </el-button>
      <el-button
        v-if="showManualButtons"
        text
        size="small"
        :loading="exporting"
        :disabled="!canExport"
        @click="exportSaves"
      >
        {{ t('detail.exportSaves') }}
      </el-button>
      <el-button v-if="showManualButtons" text size="small" :loading="importing" :disabled="running" @click="importSaves">
        {{ t('detail.importSaves') }}
      </el-button>
    </div>

    <!-- 按钮为什么是灰的：一个禁用按钮没有任何说明，用户只会觉得坏了 -->
    <div v-if="exportBlockedHint" class="hint save-blocked-hint">{{ exportBlockedHint }}</div>
  </section>
</template>
