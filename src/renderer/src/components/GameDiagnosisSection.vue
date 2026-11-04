<script setup lang="ts">
// M5.0 S11（U8）③：启动诊断区块（折叠）。
//
// 从 GameEditPage 拆出来的。方案 §9.3 ② 要求它**折叠**：
// 诊断不是"填表"的一部分 —— 用户只在出问题时才看。
//
// 与启动时自动诊断**共用同一份数据源**（diagnoseGame），区别只是触发时机：
//   · 启动时由 launch 自动跑（用户被动看到对话框）
//   · 这里由用户手动点「重新诊断」（改完路径/引擎后想看一眼）
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { translateError, type Diagnosis, type DiagnosisFix } from '@/api/client'
import { useLibraryStore } from '@/stores/library'
import { ElMessage } from 'element-plus'

const props = defineProps<{
  /** 游戏 id（诊断按 id 查库里的记录；新建时为空）。 */
  gameId?: string
  /** 是否新建流程（新游戏还没落盘，诊断读不到）。 */
  isNew: boolean
}>()

const { t } = useI18n()
const library = useLibraryStore()

/** 默认收起（它不是填表的一部分）。 */
const open = ref(false)

/** 当前诊断结果（空数组 = 没发现问题，也 = 还没跑过；用 diagnosed 区分）。 */
const diagnoses = ref<Diagnosis[]>([])
/** 是否已经跑过一次。 */
const diagnosed = ref(false)
const diagnosing = ref(false)
/** 正在修哪一条（fix.kind；null = 没有修复在跑）。 */
const repairingKind = ref<string | null>(null)

/** 折叠开关写成函数（模板里不内联赋值，AGENTS.md 已知坑）。 */
function toggle(): void {
  open.value = !open.value
}

/**
 * 手动跑一次诊断。
 *
 * 新游戏（还没保存）没有 id，诊断要按 gameId 查库里的记录，所以这里先要求先保存。
 * 这不是偷懒：诊断读的是**库里那条记录**的路径/引擎，而用户此刻屏幕上的输入
 * 可能还没落盘 —— 用一个「未保存的草稿」去诊断，结果会和他以为的不一样。
 */
async function runDiagnosis(): Promise<void> {
  if (props.isNew || !props.gameId) {
    ElMessage.info(t('diagnose.saveFirst'))
    return
  }
  diagnosing.value = true
  try {
    diagnoses.value = await library.diagnose(props.gameId)
    diagnosed.value = true
  } catch (error) {
    ElMessage.error(translateError(error, t))
  } finally {
    diagnosing.value = false
  }
}

/** 执行一条修复；修完用主进程回传的重诊断结果刷新面板。 */
async function repairDiagnosis(item: Diagnosis): Promise<void> {
  if (!item.fix || !props.gameId) return
  // 显式浅拷贝：Vue 的 reactive Proxy 过 contextBridge 会克隆失败（AGENTS.md 已知坑）
  const fix = { ...item.fix }
  repairingKind.value = fix.kind
  try {
    const result = await library.repair(props.gameId, fix)
    diagnoses.value = result.diagnoses
    diagnosed.value = true
    ElMessage.success(result.message || t('diagnose.repaired'))
  } catch (error) {
    ElMessage.error(translateError(error, t))
  } finally {
    repairingKind.value = null
  }
}

/** 级别 → Element Plus alert 类型（与 DiagnosisDialog 同一套映射）。 */
function diagnosisType(level: Diagnosis['level']): 'error' | 'warning' | 'info' {
  if (level === 'fatal') return 'error'
  if (level === 'warning') return 'warning'
  return 'info'
}

function diagnosisLabel(level: Diagnosis['level']): string {
  if (level === 'fatal') return t('diagnose.levelError')
  if (level === 'warning') return t('diagnose.levelWarning')
  return t('diagnose.levelInfo')
}

function diagnosisMessage(item: Diagnosis): string {
  return t(item.messageKey, item.args ?? {})
}

function diagnosisFixLabel(fix: DiagnosisFix): string {
  switch (fix.kind) {
    case 'installRtp':
      return t('diagnose.missingRtpFix')
    case 'installModule':
      return t('diagnose.fixInstallModule')
    case 'openFolder':
      return t('diagnose.fixOpenFolder')
    case 'repoint':
      return t('diagnose.fixRepoint')
    default:
      return t('diagnose.repair')
  }
}
</script>

<template>
  <section class="panel stack diagnosis-panel" style="margin-top: 16px">
    <button type="button" class="settings-group-head" @click="toggle">
      <span class="settings-group-caret" :class="{ 'is-open': open }">▸</span>
      <span class="settings-group-title">{{ t('diagnose.sectionTitle') }}</span>
    </button>

    <div v-if="open" class="stack">
      <div class="hint">{{ t('diagnose.sectionHint') }}</div>

      <div class="row" style="gap: 8px">
        <el-button type="primary" :loading="diagnosing" @click="runDiagnosis">
          {{ diagnosed ? t('diagnose.refresh') : t('diagnose.sectionTitle') }}
        </el-button>
        <span v-if="!diagnosed" class="hint">{{ t('diagnose.notRunYet') }}</span>
        <span v-else-if="diagnoses.length === 0" class="hint">{{ t('diagnose.noProblems') }}</span>
      </div>

      <el-alert
        v-for="(item, index) in diagnoses"
        :key="`${item.code}-${index}`"
        :type="diagnosisType(item.level)"
        :closable="false"
        show-icon
      >
        <template #title>
          <span class="diagnosis-level">{{ diagnosisLabel(item.level) }}</span>
        </template>
        <div class="diagnosis-message">{{ diagnosisMessage(item) }}</div>
        <div v-if="item.code === 'encryptedArchive'" class="diagnosis-hint">
          {{ t('diagnose.encryptedArchiveHint') }}
        </div>
        <div v-if="item.fix" class="diagnosis-actions">
          <el-button
            size="small"
            type="primary"
            :loading="repairingKind === item.fix.kind"
            @click="repairDiagnosis(item)"
          >
            {{ diagnosisFixLabel(item.fix) }}
          </el-button>
          <span v-if="repairingKind === item.fix.kind" class="hint" style="margin-left: 8px">
            {{ t('diagnose.repairing') }}
          </span>
        </div>
      </el-alert>
    </div>
  </section>
</template>
