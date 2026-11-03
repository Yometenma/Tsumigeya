<script setup lang="ts">
// 添加游戏向导（§4 AddGameWizard.vue）：选路径（拖拽/对话框）→ 识别+装引擎 → 完善信息保存。
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api, translateError, type DetectCandidate, type DetectFolderResult } from '@/api/client'
import { useLibraryStore } from '@/stores/library'
import { useEnginesStore } from '@/stores/engines'
import { useTaskStore } from '@/stores/task'

const { t } = useI18n()
const router = useRouter()
const library = useLibraryStore()
const engines = useEnginesStore()
const task = useTaskStore()

type Step = 0 | 1 | 2

const step = ref<Step>(0)
const dragging = ref(false)
const busy = ref(false)

const gamePath = ref('')
const manualPath = ref('')
const detection = ref<DetectFolderResult | null>(null)
const chosen = ref<DetectCandidate | null>(null)
const engineFolder = ref('')
const engineInstalled = ref(false)

const title = ref('')
const tags = ref<string[]>([])
const iconPath = ref<string | undefined>(undefined)

const installedFolders = computed(() => new Set(engines.modules.map((module) => module.id)))

/** 引擎 id 是否已装（识别结果可能来自远端规则）。 */
function isInstalled(engineId: string | null): boolean {
  return !!engineId && installedFolders.value.has(engineId)
}

const canGoNext = computed(() => {
  if (step.value === 0) return !!gamePath.value
  if (step.value === 1) return !!engineFolder.value && engineInstalled.value
  return !!title.value.trim()
})

// ===== 第 1 步：选路径 =====

/**
 * 识别整体超时（毫秒）。后端 detectFolder 自带 3s 远端护栏，理论上 5s 内必回；
 * 这里再加一道**前端**护栏，是因为一旦 IPC 那头因任何原因不返回（对话框挂起、
 * 主进程队列异常），UI 会永远停在「正在识别引擎…」且没有任何出路。
 * 宁可报一个「识别超时」让用户重试，也不要无声地转圈。
 */
const ANALYZE_TIMEOUT_MS = 10_000

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`analyze timeout after ${ms}ms`)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

async function pickFolder(): Promise<void> {
  try {
    const picked = await api.pickPath('folder')
    if (picked) await analyze(picked)
  } catch (error) {
    ElMessage.error(translateError(error, t))
  }
}

async function pickFile(): Promise<void> {
  try {
    const picked = await api.pickPath('file')
    if (picked) await analyze(picked)
  } catch (error) {
    ElMessage.error(translateError(error, t))
  }
}

/** 手动输入的路径直接走识别（不依赖系统对话框）。 */
async function analyzeManual(): Promise<void> {
  const target = manualPath.value.trim()
  if (!target) return
  await analyze(target)
}

/** 上一步。写成函数是因为模板里不能写 TS 类型断言（`as Step` 会让模板编译报 SyntaxError）。 */
function goPrev(): void {
  if (step.value > 0) step.value = (step.value - 1) as Step
}

/** 拖入的路径：Electron 32+ 的 File.path 已移除，必须经 bridge 的 webUtils 取。 */
function handleDrop(event: DragEvent): void {
  dragging.value = false
  const file = event.dataTransfer?.files?.[0]
  if (!file) {
    ElMessage.warning(t('wizard.dropHint'))
    return
  }
  const dropped = window.tsumi?.pathForFile(file) ?? null
  if (!dropped) {
    ElMessage.warning(t('wizard.dropHint'))
    return
  }
  void analyze(dropped)
}

/** 识别 + 决定引擎；未装则停在第 2 步让用户安装。 */
async function analyze(target: string): Promise<void> {
  gamePath.value = target
  busy.value = true
  detection.value = null
  chosen.value = null
  engineFolder.value = ''
  engineInstalled.value = false
  try {
    const result = await withTimeout(api.detectFolder(target, true), ANALYZE_TIMEOUT_MS)
    detection.value = result
    const best = result.best ?? result.candidates.find((candidate) => candidate.engine) ?? null
    chosen.value = best
    engineFolder.value = best?.engine ?? ''
    engineInstalled.value = isInstalled(best?.engine ?? null)

    // 默认标题用路径最后一段
    if (!title.value) title.value = folderName(target)

    if (engineInstalled.value && step.value === 0) step.value = 1
    else if (engineFolder.value) step.value = 1
  } catch (error) {
    ElMessage.error(translateError(error, t))
  } finally {
    busy.value = false
  }
}

function folderName(target: string): string {
  const normalized = target.replace(/[\\/]+$/, '')
  const parts = normalized.split(/[\\/]/)
  const last = parts[parts.length - 1] ?? ''
  // 选的是可执行文件时，用它的父目录名当标题更贴近游戏名
  if (/\.[a-z0-9]{2,6}$/i.test(last) && parts.length > 1) return parts[parts.length - 2] ?? last
  return last || target
}

/** 用户改选另一个候选。 */
function selectCandidate(candidate: DetectCandidate): void {
  chosen.value = candidate
  engineFolder.value = candidate.engine ?? ''
  engineInstalled.value = isInstalled(candidate.engine)
}

// ===== 第 2 步：装引擎 =====

async function installEngine(): Promise<void> {
  if (!engineFolder.value) return
  busy.value = true
  try {
    const snapshot = await task.run(
      engineFolder.value,
      api.moduleTask(engineFolder.value, 'install')
    )
    engines.applySnapshot(snapshot)
    engineInstalled.value = isInstalled(engineFolder.value)
    ElMessage.success(t('wizard.installed'))
  } catch (error) {
    if (!task.isCancelled(error)) ElMessage.error(translateError(error, t))
  } finally {
    busy.value = false
  }
}

// ===== 第 3 步：保存 =====

async function finish(): Promise<void> {
  if (!title.value.trim()) {
    ElMessage.warning(t('wizard.needTitle'))
    return
  }
  busy.value = true
  try {
    await library.saveGame(undefined, {
      gameTitle: title.value.trim(),
      gamePath: gamePath.value,
      gameEngine: engineFolder.value,
      iconPath: iconPath.value,
      tags: tags.value.filter((tag) => tag.trim()),
      gameArgs: {}
    })
    ElMessage.success(t('wizard.saved', { title: title.value.trim() }))
    void router.push('/library')
  } catch (error) {
    ElMessage.error(translateError(error, t))
  } finally {
    busy.value = false
  }
}

async function chooseIcon(): Promise<void> {
  const picked = await api.pickPath('file')
  if (picked) iconPath.value = picked
}

function reset(): void {
  step.value = 0
  gamePath.value = ''
  detection.value = null
  chosen.value = null
  engineFolder.value = ''
  engineInstalled.value = false
  title.value = ''
  tags.value = []
  iconPath.value = undefined
}
</script>

<template>
  <header class="row" style="margin-bottom: 4px">
    <div style="flex: 1">
      <h1 class="page-title">{{ t('wizard.title') }}</h1>
    </div>
    <el-button @click="router.push('/library')">{{ t('common.cancel') }}</el-button>
  </header>

  <el-steps :active="step" align-center class="wizard-steps">
    <el-step :title="t('wizard.step1')" />
    <el-step :title="t('wizard.step2')" />
    <el-step :title="t('wizard.step3')" />
  </el-steps>

  <!-- 第 1 步：选路径 -->
  <section v-if="step === 0" class="panel stack">
    <div
      class="drop-zone"
      :class="{ 'is-over': dragging }"
      @dragover.prevent="dragging = true"
      @dragleave.prevent="dragging = false"
      @drop.prevent="handleDrop"
    >
      <div>{{ t('wizard.dropHint') }}</div>
      <div class="hint" style="margin-top: 12px">{{ t('wizard.dropOr') }}</div>
      <div class="row" style="justify-content: center; margin-top: 12px">
        <el-button type="primary" @click="pickFolder">{{ t('wizard.chooseFolder') }}</el-button>
        <el-button @click="pickFile">{{ t('wizard.chooseFile') }}</el-button>
      </div>
    </div>

    <div v-if="gamePath" class="hint" style="word-break: break-all">{{ gamePath }}</div>
    <div v-if="busy" class="hint">{{ t('wizard.detecting') }}</div>

    <!-- 手输路径兜底：系统对话框在某些环境（远程桌面 / 沙箱 / 安全软件）可能不响应，
         不能让用户除了拖拽和对话框之外完全没辙。 -->
    <div class="row" style="gap: 8px; align-items: center">
      <el-input
        v-model="manualPath"
        :placeholder="t('wizard.manualPathPlaceholder')"
        clearable
        style="flex: 1 1 auto"
        :disabled="busy"
        @keyup.enter.prevent="analyzeManual"
      />
      <el-button :disabled="!manualPath.trim() || busy" @click="analyzeManual">
        {{ t('wizard.manualPathGo') }}
      </el-button>
    </div>
  </section>

  <!-- 第 2 步：识别 + 装引擎 -->
  <section v-else-if="step === 1" class="panel stack">
    <el-alert v-if="busy" :title="t('wizard.detecting')" type="info" :closable="false" show-icon />

    <template v-if="engineFolder">
      <el-alert
        :title="
          engineInstalled
            ? t('wizard.detected', { engine: engineFolder })
            : t('wizard.detectedRemote', { engine: engineFolder })
        "
        :type="engineInstalled ? 'success' : 'warning'"
        :closable="false"
        show-icon
      />

      <div v-if="!engineInstalled" class="row">
        <el-button type="primary" :loading="busy" @click="installEngine">
          {{ t('wizard.installEngine') }}
        </el-button>
        <span class="hint">{{ t('wizard.engineMissing', { engine: engineFolder }) }}</span>
      </div>
      <div v-else class="hint">{{ t('wizard.engineInstalled') }}</div>
    </template>

    <el-alert
      v-else
      :title="t('wizard.notDetected')"
      :description="t('wizard.notDetectedHint')"
      type="warning"
      :closable="false"
      show-icon
    />

    <!-- 候选列表：让用户改选 -->
    <div v-if="detection && detection.candidates.length" class="stack" style="gap: 6px">
      <div class="settings-row-title">{{ t('wizard.candidates', { count: detection.candidates.length }) }}</div>
      <el-radio-group
        :model-value="chosen?.path"
        class="stack"
        style="gap: 6px; display: flex; flex-direction: column"
        @update:model-value="
          (value) => {
            const found = detection?.candidates.find((candidate) => candidate.path === value)
            if (found) selectCandidate(found)
          }
        "
      >
        <el-radio v-for="candidate in detection.candidates" :key="candidate.path" :value="candidate.path">
          <span style="word-break: break-all">{{ candidate.path }}</span>
          <el-tag v-if="candidate.engine" size="small" style="margin-left: 8px">{{ candidate.engine }}</el-tag>
          <el-tag v-if="candidate.installed" size="small" type="success" style="margin-left: 4px">
            {{ t('common.installed') }}
          </el-tag>
        </el-radio>
      </el-radio-group>
    </div>

    <div class="row">
      <el-button :disabled="!engineFolder" @click="step = 2">{{ t('wizard.skipInstall') }}</el-button>
    </div>
  </section>

  <!-- 第 3 步：完善信息 -->
  <section v-else class="panel stack">
    <div class="settings-row">
      <div class="settings-row-main">
        <div class="settings-row-title">{{ t('wizard.titleLabel') }}</div>
      </div>
      <el-input v-model="title" :placeholder="t('wizard.titlePlaceholder')" style="width: 320px" />
    </div>

    <div class="settings-row">
      <div class="settings-row-main">
        <div class="settings-row-title">{{ t('wizard.pathLabel') }}</div>
        <div class="settings-row-hint" style="word-break: break-all">{{ gamePath }}</div>
      </div>
    </div>

    <div class="settings-row">
      <div class="settings-row-main">
        <div class="settings-row-title">{{ t('wizard.engineLabel') }}</div>
      </div>
      <el-tag>{{ engineFolder || t('common.unknown') }}</el-tag>
    </div>

    <div class="settings-row">
      <div class="settings-row-main">
        <div class="settings-row-title">{{ t('wizard.tagsLabel') }}</div>
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

    <div class="settings-row">
      <div class="settings-row-main">
        <div class="settings-row-title">{{ t('wizard.iconLabel') }}</div>
        <div class="settings-row-hint" style="word-break: break-all">{{ iconPath || '—' }}</div>
      </div>
      <el-button @click="chooseIcon">{{ t('wizard.chooseIcon') }}</el-button>
    </div>
  </section>

  <div class="form-actions">
    <el-button v-if="step > 0" @click="goPrev">{{ t('wizard.prev') }}</el-button>
    <el-button v-if="step === 0" type="primary" :disabled="!gamePath || busy" @click="step = 1">
      {{ t('wizard.next') }}
    </el-button>
    <el-button v-else-if="step === 1" type="primary" :disabled="!canGoNext" @click="step = 2">
      {{ t('wizard.next') }}
    </el-button>
    <el-button v-else type="primary" :loading="busy" @click="finish">{{ t('wizard.finish') }}</el-button>
    <el-button v-if="step > 0" text @click="reset">{{ t('common.retry') }}</el-button>
  </div>
</template>
