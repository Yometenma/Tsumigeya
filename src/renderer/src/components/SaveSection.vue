<script setup lang="ts">
// M4 S2：详情页「存档」区块。
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

const props = defineProps<{
  /** 游戏 id（换游戏要重拉列表）。 */
  gameId: string
  /** 这个游戏是否正在运行（运行中禁止导出，S3 的保护）。 */
  running: boolean
}>()

const { t } = useI18n()

// ===== 状态（全部在 watch 之前声明，避免 TDZ）=====

/** 最近一次列出来的结果；null = 还没拉到 / 拉失败。 */
const listing = ref<SaveListing | null>(null)
/** 是否正在拉（首次进入 + 手动刷新）。 */
const loading = ref(false)

// ===== 派生数据 =====

/** 三种形态（unknown / empty / list）的唯一判据。 */
const view = computed(() => saveSectionView(listing.value))

/** 「还没有存档」和「不知道在哪」的文案必须分开 —— 见文件头。 */
const unknownText = computed(() => t('detail.savesUnknown'))
const emptyText = computed(() => t('detail.savesEmpty'))

/** 有位置时才有「在访达中显示」可点（没位置就无从打开）。 */
const canReveal = computed(() => {
  const kind = view.value.kind
  return kind !== 'unknown'
})

/** 当前目录（unknown 时是空串，不给按钮传 undefined）。 */
const dirPath = computed(() => {
  const kind = view.value
  return kind.kind === 'unknown' ? '' : kind.dir
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

// 换游戏就重拉（否则上一个游戏的存档列表会残留）。
// ⚠️ `immediate: true` 在这里是安全的：上面所有 ref/computed 都已声明完。
watch(() => props.gameId, () => void load(), { immediate: true })
</script>

<template>
  <section class="detail-section save-section">
    <h2 class="detail-section-title">{{ t('detail.saves') }}</h2>

    <!-- ① 不知道存档在哪（故障态：不是"没存档"） -->
    <template v-if="view.kind === 'unknown'">
      <div class="detail-missing">{{ unknownText }}</div>
    </template>

    <!-- ② 位置找到了，但还没存过档（正常态：给下一步动作） -->
    <template v-else-if="view.kind === 'empty'">
      <div class="detail-missing">{{ emptyText }}</div>
    </template>

    <!-- ③ 有内容：槽与配置**分开列**（config 不是第 0 号存档） -->
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
    </div>
  </section>
</template>
