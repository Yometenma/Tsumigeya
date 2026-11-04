<script setup lang="ts">
// M3 §4.2：启动诊断对话框。
//
// 设计要点（都是被踩过的坑换来的）：
// 1. **不用 ElMessageBox**：它只支持一段文本 + 1~2 个按钮，扛不住「多条诊断 + 每条的
//    级别图标 + 每条自己的修复按钮 + 修完要刷新」。硬塞进去会让文案变成一整坨纯文本。
// 2. **fatal 不给「还是启动试试」**（§11-② 用户拍板）：给了就等于把诊断变成摆设——
//    用户点了绕过后依旧看到 mkxp-z 的英文报错，体验比现在更差（§9 R5）。
//    warning/info 才给绕过按钮。
// 3. **一份 fix 一次只处理一条**（§11-③ 暂定）：第一条修完可能让后面的诊断失效
//    （例如重选路径后目录变了），所以点修复后立刻用主进程回传的重诊断结果刷新列表。
// 4. 所有文案走 i18n，模板里**不写 TS 类型断言**（AGENTS.md 已知坑：会白屏）。
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { api, translateError, type Diagnosis, type DiagnosisFix } from '@/api/client'

const props = defineProps<{
  /** 是否显示（v-model）。 */
  modelValue: boolean
  /** 正在诊断的游戏 id。 */
  gameId: string
  /** 主进程回传的初始诊断结果。 */
  diagnoses: Diagnosis[]
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** 用户选择「还是启动试试」（仅非 fatal 时可见）。 */
  proceed: []
}>()

const { t } = useI18n()

/** 对话框标题：被拦下时是「暂时无法启动」，只是提示时是「启动诊断」。 */
const blocked = computed(() => props.diagnoses.some((item) => item.level === 'fatal'))

const visible = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit('update:modelValue', value)
})

/** 当前列表（修复后会被主进程的重诊断结果替换）。 */
const items = ref<Diagnosis[]>([])

// ⚠️ 这里**不能用 `immediate: true`**：items 必须在 watch 之前声明（否则 TDZ 白屏，AGENTS.md 已知坑）。
// 初始值在同一条 watch 的非 immediate 分支里给：打开时同步一次。
watch(
  () => props.modelValue,
  (open) => {
    if (open) items.value = props.diagnoses
  }
)

const repairing = ref<DiagnosisFix['kind'] | null>(null)

/** 级别 → Element Plus 的 alert 类型（fatal 红 / warning 黄 / info 灰）。 */
function levelType(level: Diagnosis['level']): 'error' | 'warning' | 'info' {
  if (level === 'fatal') return 'error'
  if (level === 'warning') return 'warning'
  return 'info'
}

function levelLabel(level: Diagnosis['level']): string {
  if (level === 'fatal') return t('diagnose.levelError')
  if (level === 'warning') return t('diagnose.levelWarning')
  return t('diagnose.levelInfo')
}

/** 一条诊断的正文（i18n 查表；args 是主进程给的占位符）。 */
function messageOf(item: Diagnosis): string {
  return t(item.messageKey, item.args ?? {})
}

/** 加密发行额外那句「我们不会自动解包」（D34 的法律风险提示，必须让用户看到）。 */
function hintOf(item: Diagnosis): string {
  return item.code === 'encryptedArchive' ? t('diagnose.encryptedArchiveHint') : ''
}

/** 修复动作的按钮文字。 */
function fixLabel(fix: DiagnosisFix): string {
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

/**
 * 执行这条修复。`fix` 是**普通对象**（不是 Vue Proxy）——它来自主进程 JSON，
 * 但为保险起见这里显式浅拷贝一层（AGENTS.md：Proxy 过 contextBridge 会克隆失败）。
 */
async function repair(item: Diagnosis): Promise<void> {
  if (!item.fix) return
  const fix: DiagnosisFix = { ...item.fix }
  repairing.value = fix.kind
  try {
    const result = await api.repairGame(props.gameId, fix)
    items.value = result.diagnoses
    ElMessage.success(result.message || t('diagnose.repaired'))
  } catch (error) {
    ElMessage.error(translateError(error, t))
  } finally {
    repairing.value = null
  }
}

/** 重新跑一次诊断（用户手动改过目录 / 装完东西后）。 */
async function refresh(): Promise<void> {
  try {
    items.value = await api.diagnoseGame(props.gameId)
  } catch (error) {
    ElMessage.error(translateError(error, t))
  }
}

function proceedAnyway(): void {
  visible.value = false
  emit('proceed')
}
</script>

<template>
  <el-dialog
    v-model="visible"
    :title="blocked ? t('diagnose.blockedTitle') : t('diagnose.sectionTitle')"
    width="620px"
    class="diagnosis-dialog"
  >
    <div class="stack" style="gap: 10px">
      <el-alert
        v-for="(item, index) in items"
        :key="`${item.code}-${index}`"
        :type="levelType(item.level)"
        :closable="false"
        show-icon
      >
        <template #title>
          <span class="diagnosis-level">{{ levelLabel(item.level) }}</span>
        </template>
        <div class="diagnosis-message">{{ messageOf(item) }}</div>
        <div v-if="hintOf(item)" class="diagnosis-hint">{{ hintOf(item) }}</div>
        <div v-if="item.fix" class="diagnosis-actions">
          <el-button
            size="small"
            type="primary"
            :loading="repairing === item.fix.kind"
            @click="repair(item)"
          >
            {{ fixLabel(item.fix) }}
          </el-button>
        </div>
      </el-alert>

      <div v-if="items.length === 0" class="diagnosis-empty">{{ t('diagnose.noProblems') }}</div>

      <!-- 修复进行中的整体提示（方案 §5 要求的 repairing 文案）：修复可能下 244MB，不能只有按钮转圈 -->
      <div v-if="repairing" class="diagnosis-hint">{{ t('diagnose.repairing') }}</div>
    </div>

    <template #footer>
      <div class="row" style="gap: 8px">
        <el-button text @click="refresh">{{ t('diagnose.refresh') }}</el-button>
        <div style="flex: 1" />
        <!-- fatal 不给绕过（§11-②）：给了只会让用户多撞一次英文报错 -->
        <el-button v-if="!blocked" type="warning" plain @click="proceedAnyway">
          {{ t('diagnose.ratherTry') }}
        </el-button>
        <el-button @click="visible = false">{{ t('common.close') }}</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<style scoped>
.diagnosis-level {
  font-weight: 600;
}
.diagnosis-message {
  margin-top: 4px;
  line-height: 1.6;
}
.diagnosis-hint {
  margin-top: 6px;
  font-size: 12px;
  opacity: 0.75;
  line-height: 1.5;
}
.diagnosis-actions {
  margin-top: 8px;
}
.diagnosis-empty {
  padding: 12px 0;
  opacity: 0.7;
}
</style>
