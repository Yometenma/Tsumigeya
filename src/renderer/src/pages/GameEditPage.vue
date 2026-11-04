<script setup lang="ts">
// 编辑 / 新建游戏（§4 GameEditPage.vue）：标题、路径、引擎、标签、图标 + DynamicArgsForm。
// 引擎切换时按新 manifest 重置 args（契约要求）。
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import DynamicArgsForm from '@/components/DynamicArgsForm.vue'
import GameInfoForm from '@/components/GameInfoForm.vue'
import VersionManagerDialog from '@/components/VersionManagerDialog.vue'
import {
  api,
  iconUrl,
  translateError,
  EDITABLE_FIELDS,
  type Diagnosis,
  type DiagnosisFix,
  type DlsiteSearchHit,
  type DlsiteWork,
  type EditableField,
  type GameArgDef,
  type ManifestRaw
} from '@/api/client'
import { stripLanguageSuffix } from '../../../shared/game-language'
import { buildImportAttempts, importOutcome, type ImportDetection } from '../../../shared/import-target'
import { useLibraryStore } from '@/stores/library'
import { useEnginesStore } from '@/stores/engines'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const library = useLibraryStore()
const engines = useEnginesStore()

const isNew = computed(() => route.name === 'library-new')
const gameId = computed(() => (typeof route.params.id === 'string' ? route.params.id : undefined))

const title = ref('')
const path = ref('')
const engine = ref('')
const tags = ref<string[]>([])
const iconPath = ref<string | undefined>(undefined)
/** 引擎参数（DynamicArgsForm 双向绑定）。 */
const gameArgs = ref<Record<string, unknown>>({})
const saving = ref(false)
const notFound = ref(false)
/**
 * M2.6：新建保存成功后拿到的新 id。
 * 新建时 `gameId` 是 undefined，但保存后应该回**详情页**（§5.3），所以要记下这个 id。
 */
const newlySavedId = ref<string | undefined>(undefined)

const versionDialog = ref(false)
const versionArgKey = ref('')
const versionDef = ref<GameArgDef | null>(null)

// ===== M3：启动诊断面板（§6 文件清单：GameEditPage 的「启动诊断」面板）=====
//
// ⚠️ 同一条 TDZ 规矩：这些 ref 必须声明在 fill() 之前。
// 面板与自动诊断**共用同一份数据源**（diagnoseGame），区别只是触发时机：
//   · 启动时由 launch 自动跑（用户被动看到对话框）
//   · 这里由用户手动点「重新诊断」（编辑完路径/引擎后想看一眼）
/** 当前诊断结果（空数组 = 没发现问题，也 = 还没跑过；用 diagnosed 区分）。 */
const diagnoses = ref<Diagnosis[]>([])
/** 是否已经跑过一次（决定显示「没有发现问题」还是「点一下诊断」）。 */
const diagnosed = ref(false)
/** 诊断进行中。 */
const diagnosing = ref(false)
/** 正在修哪一条（fix.kind；null = 没有修复在跑）。 */
const repairingKind = ref<string | null>(null)

/** 当前引擎的 manifest（已装模块才有 raw）。 */
const manifest = computed<ManifestRaw | null>(() => {
  const module = engines.modules.find((item) => item.id === engine.value)
  return (module?.raw as ManifestRaw | undefined) ?? null
})

const engineOptions = computed(() =>
  engines.modules.map((module) => ({ label: module.name || module.id, value: module.id }))
)

const iconPreview = computed(() => iconUrl(iconPath.value))

/** 读已有游戏填表（编辑模式）。 */
function fill(): void {
  if (isNew.value) {
    title.value = ''
    path.value = ''
    engine.value = ''
    tags.value = []
    iconPath.value = undefined
    gameArgs.value = {}
    notFound.value = false
    return
  }
  const id = gameId.value
  const game = id ? library.byId(id) : undefined
  if (!game) {
    notFound.value = true
    return
  }
  notFound.value = false
  title.value = game.gameTitle
  path.value = game.gamePath
  engine.value = game.gameEngine
  tags.value = [...(game.tags ?? [])]
  iconPath.value = game.iconPath
  gameArgs.value = { ...(game.gameArgs ?? {}) }
}

watch([() => library.games.length, gameId, isNew], fill, { immediate: true })

/**
 * 引擎切换 → 按新 manifest 重置 args（只保留新 schema 里的键，缺省用 default）。
 */
watch(engine, (next, previous) => {
  if (!next || next === previous) return
  const schema = engines.modules.find((module) => module.id === next)?.raw?.gameArgs as
    | Record<string, GameArgDef>
    | undefined
  const reset: Record<string, unknown> = {}
  for (const [key, definition] of Object.entries(schema ?? {})) {
    reset[key] = definition.default
  }
  gameArgs.value = reset
})

async function chooseFile(): Promise<void> {
  const picked = await api.pickPath('file')
  if (!picked) return
  path.value = picked
  await autoDetect(picked)
}

/**
 * 选了路径就顺手识别一次引擎（未装引擎的提示交给向导，这里只填已装的）。
 *
 * M5.0 U5：与向导共用 `shared/import-target.ts` 的逐层上退 —— 这里也只能选文件了，
 * 选了 `readme.txt` 或 Ren'Py 的 `game/script.rpy` 时要能退到真正的游戏根，
 * 否则引擎下拉不会被自动填上。**两处必须同一套判据**，不能各写一份。
 */
async function autoDetect(target: string): Promise<void> {
  try {
    const attempts = buildImportAttempts(target)
    const detections: ImportDetection[] = []
    for (const attempt of attempts) {
      const result = await api.detectFolder(attempt.path, false)
      detections.push({
        level: attempt.level,
        engine: result.best?.engine ?? null,
        bestPath: result.best?.path ?? null
      })
      if (result.best?.engine) break
    }
    const outcome = importOutcome(target, attempts, detections)
    // 上退纠正过就跟着改路径，别让「显示的路径」与「实际存的路径」分叉
    path.value = outcome.gamePath
    if (outcome.engine) engine.value = outcome.engine
  } catch {
    /* 识别失败不阻塞编辑 */
  }
}

async function chooseIcon(): Promise<void> {
  const picked = await api.pickPath('file')
  if (picked) iconPath.value = picked
}

function manageVersions(argKey: string, definition: GameArgDef): void {
  versionArgKey.value = argKey
  versionDef.value = definition
  versionDialog.value = true
}

// ===== M3：启动诊断面板的交互 =====

/**
 * 手动跑一次诊断。
 *
 * 新游戏（还没保存）没有 id，诊断要按 gameId 查库里的记录，所以这里先要求先保存。
 * 这不是偷懒：诊断读的是**库里那条记录**的路径/引擎，而用户此刻屏幕上的输入可能还没落盘——
 * 用一个「未保存的草稿」去诊断，结果会和他以为的不一样。
 */
async function runDiagnosis(): Promise<void> {
  if (isNew.value || !gameId.value) {
    ElMessage.info(t('diagnose.saveFirst'))
    return
  }
  diagnosing.value = true
  try {
    diagnoses.value = await library.diagnose(gameId.value)
    diagnosed.value = true
  } catch (error) {
    ElMessage.error(translateError(error, t))
  } finally {
    diagnosing.value = false
  }
}

/** 执行一条修复；修完用主进程回传的重诊断结果刷新面板。 */
async function repairDiagnosis(item: Diagnosis): Promise<void> {
  if (!item.fix || !gameId.value) return
  // 显式浅拷贝：Vue 的 reactive Proxy 过 contextBridge 会克隆失败（AGENTS.md 已知坑）
  const fix = { ...item.fix }
  repairingKind.value = fix.kind
  try {
    const result = await library.repair(gameId.value, fix)
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
  <div v-if="notFound" class="empty-state">
    <div class="empty-state-title">{{ t('game.notFound') }}</div>
    <el-button @click="router.push('/library')">{{ t('game.backToLibrary') }}</el-button>
  </div>

  <template v-else>
    <header class="row" style="margin-bottom: 4px">
      <div style="flex: 1">
        <h1 class="page-title">{{ isNew ? t('game.newTitle') : t('game.title') }}</h1>
      </div>
      <el-button @click="goBack">{{ t('common.back') }}</el-button>
    </header>

    <section class="panel stack" style="margin-bottom: 16px">
      <h3 style="margin: 0">{{ t('game.basicInfo') }}</h3>

      <div class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-title">{{ t('game.pathLabel') }}</div>
          <div class="settings-row-hint" style="word-break: break-all">{{ path || '—' }}</div>
        </div>
        <div class="row" style="flex: 0 0 auto">
          <!-- M5.0 U5：只留「选择文件」，与向导一致（选文件能反推目录，见 import-target.ts） -->
          <el-button @click="chooseFile">{{ t('wizard.chooseFile') }}</el-button>
        </div>
      </div>

      <div class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-title">{{ t('game.engineLabel') }}</div>
          <div class="settings-row-hint">{{ t('game.engineSwitchHint') }}</div>
        </div>
        <el-select v-model="engine" style="width: 220px" :placeholder="t('common.unknown')">
          <el-option v-for="option in engineOptions" :key="option.value" :label="option.label" :value="option.value" />
        </el-select>
      </div>
    </section>

    <!-- ===== M2.7：封面与标签（合并原来分散的「标签」与「图标」两个区块）===== -->
    <section class="panel stack" style="margin-bottom: 16px">
      <div>
        <h3 style="margin: 0">{{ t('game.coverAndTags') }}</h3>
        <div class="hint">{{ t('game.coverAndTagsHint') }}</div>
      </div>

      <!-- 标签：**保留**。DLsite 不提供 genre（M2.6 D40 实测），这是唯一的标签来源。 -->
      <div class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-title">{{ t('game.tagsLabel') }}</div>
          <div class="settings-row-hint">{{ t('game.tagsHint') }}</div>
        </div>
        <el-select
          v-model="tags"
          multiple
          filterable
          allow-create
          default-first-option
          :placeholder="t('wizard.tagsPlaceholder')"
          style="width: 320px"
        >
          <el-option v-for="tag in library.tags" :key="tag" :label="tag" :value="tag" />
        </el-select>
      </div>

      <!-- 图标：折叠（卡片优先用封面，图标只是没有元数据时的兜底） -->
      <div class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-title">
            <el-button text size="small" class="icon-toggle" @click="iconSectionOpen = !iconSectionOpen">
              {{ iconSectionOpen ? '▾' : '▸' }} {{ t('game.iconAdvanced') }}
            </el-button>
          </div>
          <div class="settings-row-hint">{{ t('game.iconAdvancedHint') }}</div>
        </div>
      </div>

      <div v-if="iconSectionOpen" class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-title">{{ t('game.iconLabel') }}</div>
          <div class="settings-row-hint" style="word-break: break-all">{{ iconPath || t('game.iconNone') }}</div>
        </div>
        <div class="row" style="flex: 0 0 auto">
          <img v-if="iconPreview" :src="iconPreview" alt="" style="width: 40px; height: 40px; border-radius: 8px" />
          <el-button @click="chooseIcon">{{ t('game.changeIcon') }}</el-button>
          <el-button v-if="iconPath" text @click="iconPath = undefined">{{ t('game.clearIcon') }}</el-button>
        </div>
      </div>
    </section>

    <section class="panel">
      <h3 style="margin: 0 0 8px">{{ t('game.engineArgs') }}</h3>
      <DynamicArgsForm
        v-model="gameArgs"
        :manifest="manifest"
        :engine-folder="engine"
        @manage-versions="manageVersions"
      />
    </section>

    <!-- M3：启动诊断面板（§4.2 / §6）。与自动诊断共用同一份数据源，这里是手动刷新入口。 -->
    <section class="panel stack diagnosis-panel" style="margin-top: 16px">
      <div>
        <h3 style="margin: 0">{{ t('diagnose.sectionTitle') }}</h3>
        <div class="hint">{{ t('diagnose.sectionHint') }}</div>
      </div>

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
    </section>

    <!-- ===== M5.0 S10（U7）：游戏信息表单（编辑页与添加向导**共用**同一个组件）=====
         原来这三块（标题来源提示 / 封面预览 / DLsite 面板）是一长段只属于本页的代码，
         向导那边只能自己再写一套「完善信息」，于是两处越来越像两个产品 ——
         正是用户说的「好割裂」。抽成 GameInfoForm.vue 后两处共用同一份实现。

         组件有两种模式（判据在 shared/gameinfo-form.ts）:
           · bound  有 gameId → 每个动作立刻落盘（与原来行为一致）
           · staged 没有 gameId → 只进内存，由向导保存游戏后一起提交 -->
    <section class="panel stack" style="margin-top: 16px">
      <div>
        <h3 style="margin: 0">{{ t('dlsite.sectionTitle') }}</h3>
        <div class="hint">{{ t('dlsite.sectionHint') }}</div>
      </div>
      <GameInfoForm
        :game-id="gameId"
        v-model:title="title"
        :game-path="path"
        :icon-path="iconPath"
      />
    </section>

    <div class="form-actions">
      <el-button type="primary" :loading="saving" @click="save">{{ t('common.save') }}</el-button>
      <el-button @click="goBack">{{ t('common.cancel') }}</el-button>
    </div>

    <VersionManagerDialog
      v-model="versionDialog"
      :folder="engine"
      :arg-key="versionArgKey"
    />
  </template>
</template>
