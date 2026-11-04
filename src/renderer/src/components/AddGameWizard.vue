<script setup lang="ts">
// 添加游戏向导（§4 AddGameWizard.vue）：选路径（拖拽/对话框）→ 识别+装引擎 → 完善信息保存。
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import GameInfoForm from '@/components/GameInfoForm.vue'
import { api, translateError, type DetectCandidate, type DetectFolderResult, type DlsiteWork } from '@/api/client'
import { buildImportAttempts, importOutcome, type ImportDetection } from '../../../shared/import-target'
import { canAdvanceEngineStep, engineOptionsFrom, engineSourceBadge } from '../../../shared/wizard-engine'
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
/**
 * M5.0 U6：引擎是不是**用户自己改的**（而不是自动识别出的）。
 *
 * 为什么要单独记：自动识别的结果会被「改引擎」下拉覆盖，而重新识别时
 * 又要把用户的选择让位给新的识别结果。分不清这两者就会出现
 * 「用户手选了 mkxp-z，一改路径又被自动改回 nwjs」这种气愤行为。
 */
const engineManual = ref(false)
/**
 * M5.0 U6：安装引擎失败过（断网 / 服务器抽风）。
 *
 * 与「跳过」的区别：跳过是**没试就放行**（用户根本不知道会出问题），
 * 而这里是他**点过安装、装了但没成功** —— 此时再把游戏卡死在这步毫无意义，
 * 不如让他存下来，稍后去引擎页重试。方案 §7.1 的容错路径。
 */
const installFailed = ref(false)

const title = ref('')
const tags = ref<string[]>([])
const iconPath = ref<string | undefined>(undefined)

/**
 * M5.0 S10（U7）：向导里选好的 DLsite 元数据（**暂存，还没落盘**）。
 *
 * 为什么需要这一份：向导里游戏**还没保存** → 没有 gameId → 元数据无处可挂。
 * 这正是原实现只能弹 `error.dlsiteGameRequired`（"先保存游戏"）的原因，
 * 也是用户抱怨的割裂感的来源：查到了元数据、点保存却被要求"先存游戏"。
 *
 * 现在由 `GameInfoForm` 的 **staged 模式**把动作都收在内存里，
 * 通过 `stage-change` 事件交到这里，等 `finish()` 建好游戏记录后再一起提交。
 */
const stagedMeta = ref<DlsiteWork | null>(null)
/** 表单实例（用来取「该提交的那份」）。 */
const infoForm = ref<InstanceType<typeof GameInfoForm> | null>(null)

/** 组件报上来的暂存元数据（null = 用户点了「清除」）。 */
function onStageChange(work: DlsiteWork | null): void {
  stagedMeta.value = work
}

const installedFolders = computed(() => new Set(engines.modules.map((module) => module.id)))

/** 引擎 id 是否已装（识别结果可能来自远端规则）。 */
function isInstalled(engineId: string | null): boolean {
  return !!engineId && installedFolders.value.has(engineId)
}

const canGoNext = computed(() => {
  if (step.value === 0) return !!gamePath.value
  // M5.0 U6：原来这里要求「引擎已装」才放行，配合「跳过，稍后安装」当逃生门。
  // 现在不设那个按钮了，逃生门改成「装过但失败了」：判据在 shared/wizard-engine.ts
  //（有单测：断网用户必须能往下走，否则整个添加流程在这台机器上彻底不可用）。
  if (step.value === 1) {
    return canAdvanceEngineStep({
      engine: engineFolder.value,
      installed: engineInstalled.value,
      installFailed: installFailed.value
    })
  }
  return !!title.value.trim()
})

/** 第 2 步那行「自动识别 / 已手动修改」徽标（判据同上）。 */
const engineBadge = computed(() => engineSourceBadge(engineManual.value, engineFolder.value))

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

/**
 * M5.0 U6：一打开向导就把「可安装引擎」列表拉下来。
 *
 * 为什么必须在这里拉：那个列表是**懒加载**的（正常只在引擎页拉）。
 * 而这一轮新加的「改引擎」下拉要列出四个引擎（含**还没装**的 —— 用户认出 nwjs
 * 但装的是 mkxp-z 时，他要能选到一个未装的项然后去装）。
 * 不提前拉的话，第一次用的人会看到下拉里只有已装的那一两个，甚至空着 ——
 * 那就是「修了个假的入口」。
 *
 * 失败不影响流程：loadRemote 自己 catch 掉并且只 console.warn（它读本地 registry、
 * 零网络），最坏情况就是下拉退回已装列表（engineOptionsFrom 的兜底）。
 */
void engines.loadRemote()

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
/**
 * 识别 + 决定引擎；未装则停在第 2 步让用户安装。
 *
 * M5.0 U5：target 现在**几乎总是文件**（选文件夹入口已删），所以这里要按
 * shared/import-target.ts 的顺序逐层试：先看文件本身，认不出再往上退（上限 2 层）。
 * 覆盖「选错文件」与「Ren'Py 的入口在 game/ 子目录」两个例外。
 * 用户手输的路径可能仍是目录 —— 那样第 0 层就能认出，退不到第二层。
 */
async function analyze(target: string): Promise<void> {
  const attempts = buildImportAttempts(target)
  if (!attempts.length) {
    ElMessage.error(translateError(new Error('empty path'), t))
    return
  }

  gamePath.value = target
  busy.value = true
  detection.value = null
  chosen.value = null
  engineFolder.value = ''
  engineInstalled.value = false
  // 重新识别时用户的手选让位给新的识别结果（否则改了个路径引擎还停留在旧的手选值上）
  engineManual.value = false
  const detections: ImportDetection[] = []
  let result: DetectFolderResult | null = null
  try {
    for (const attempt of attempts) {
      const found = await withTimeout(api.detectFolder(attempt.path, true), ANALYZE_TIMEOUT_MS)
      // 最后一层的 candidates 留着给候选列表用（哪怕它没认出引擎）
      result = found
      detections.push({
        level: attempt.level,
        engine: found.best?.engine ?? null,
        bestPath: found.best?.path ?? null
      })
      if (found.best?.engine) break
    }

    const outcome = importOutcome(target, attempts, detections)
    detection.value = result
    // ⚠️ 存盘路径取 outcome.gamePath（可能被上退纠正过），不是用户选的原值
    gamePath.value = outcome.gamePath
    if (outcome.engine) {
      chosen.value = result?.best ?? null
      engineFolder.value = outcome.engine
      engineInstalled.value = isInstalled(outcome.engine)
    }

    // 上退纠正过就要说一声：用户以为自己选对了文件，静默换路径会让他后面困惑
    if (outcome.ascended) {
      ElMessage.info(t('wizard.ascended', { path: outcome.gamePath }))
    }

    // 默认标题用路径最后一段
    if (!title.value) title.value = folderName(outcome.gamePath)

    if (engineFolder.value) step.value = 1
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

/**
 * M5.0 U6：手动改引擎。
 *
 * 方案 §7.2 查实的现状：`wizard.notDetectedHint` 文案写着「可以从下面的候选里手动选择」，
 * 但**识别成功时根本没有改的入口** —— 只有识别失败才有候选列表。识别错了（或者
 * 规则判歪了）用户就卡在那一步，只能先存下来再去编辑页改，白白多绕一圈。
 *
 * 改法：不管识别成功还是失败，都显示一行「引擎：xxx　[改]」，
 * 点开是一个**四选一的下拉**（registry 里那四个引擎的唯一来源是引擎页的「可安装」列表）。
 *
 * 为什么用下拉而不是候选列表：候选列表是「同一个游戏目录里的不同可执行文件」
 * （选错了入口 exe 的那种情况），而这里要改的是**引擎判定**本身 ——
 * 两者是不同的东西，不能混成一个控件。
 */
const engineOptions = computed(() =>
  // 选项来源与「下拉不能是空的」都在 shared/wizard-engine.ts（有单测）：
  // 可安装列表是懒加载的，向导可能先于引擎页打开，那时要退回已装列表。
  engineOptionsFrom(engines.remoteModules, engines.modules)
)

/** 用户从下拉里换了引擎。 */
function changeEngine(value: string): void {
  engineFolder.value = value
  engineInstalled.value = isInstalled(value)
  engineManual.value = true
  // 换了引擎就把「改选候选」的高亮清掉：候选是按旧引擎算出来的，留着会误导
  chosen.value = null
}

/**
 * M5.0 U6：引擎没装时**装**，不提供「跳过，稍后安装」。
 *
 * 删掉那个按钮的理由（用户说「感觉没必要」，本鱼同意）：
 * 引擎没装游戏**根本跑不起来**，让他跳过等于让他后面必踩一次「点启动失败」。
 * 不如就装。
 *
 * 但删按钮 ≠ 强制（方案 §7.1 的容错路径）：下载失败（断网 / 服务器抽风）时
 * 仍然要把游戏**先存下来**，提示改成「游戏已保存，引擎可稍后在引擎页安装」。
 * 所以这里失败时不是把用户卡住，而是把 `engineReady` 这类阻断解开 ——
 * 具体见下方 `canGoNext` 与 `installFailed`。
 */
async function installEngine(): Promise<void> {
  if (!engineFolder.value) return
  busy.value = true
  installFailed.value = false
  try {
    const snapshot = await task.run(
      engineFolder.value,
      api.moduleTask(engineFolder.value, 'install')
    )
    engines.applySnapshot(snapshot)
    engineInstalled.value = isInstalled(engineFolder.value)
    ElMessage.success(t('wizard.installed'))
  } catch (error) {
    if (!task.isCancelled(error)) {
      // 失败不卡住用户：显示提示，允许直接往下走（游戏先存下来）
      installFailed.value = true
      ElMessage.warning(translateError(error, t))
    }
  } finally {
    busy.value = false
  }
}

// ===== 第 3 步：保存 =====

/**
 * M5.0 S10（U7）：保存游戏 + **一起提交暂存的 DLsite 元数据**。
 *
 * 原流程的割裂就在这一步：用户在第 3 步查到了元数据，但那时没有 gameId，
 * 只能"先存游戏、再进编辑页重查一遍"。现在两步合并 —— 正是用户要的
 * 「导入游戏时就把元数据弄好」。
 *
 * ⚠️ 顺序不能反：**先 saveGame 拿到 id，再 saveGameMeta**。
 * 元数据挂的是 gameId；反过来主进程会报 error.dlsiteGameRequired。
 *
 * ⚠️ 元数据提交失败**不回滚游戏**：游戏本体已经存好了（那是主数据），
 * 丢一次元数据不该让用户整个重新添加。所以单独 catch、单独提示，
 * 用户可以去编辑页补（那时就有 id 了）。
 */
async function finish(): Promise<void> {
  if (!title.value.trim()) {
    ElMessage.warning(t('wizard.needTitle'))
    return
  }
  busy.value = true
  try {
    const before = new Set(library.games.map((item) => item.id))
    await library.saveGame(undefined, {
      gameTitle: title.value.trim(),
      gamePath: gamePath.value,
      gameEngine: engineFolder.value,
      iconPath: iconPath.value,
      tags: tags.value.filter((tag) => tag.trim()),
      gameArgs: {}
    })

    // 新建出来的那条记录的 id（saveGame 内部生成的）
    const created = library.games.find((item) => !before.has(item.id))
    const work = infoForm.value?.stagedMeta() ?? stagedMeta.value
    if (created && work) {
      try {
        await library.saveGameMeta(created.id, work)
      } catch (error) {
        // 游戏已经存好了 —— 元数据失败只提示、不阻断
        console.warn(`[tsumigeya] 提交 DLsite 元数据失败：${(error as Error).message}`)
        ElMessage.warning(t('wizard.metaSaveFailed'))
      }
    }

    ElMessage.success(t('wizard.saved', { title: title.value.trim() }))
    // M5.0 S10：存完直接进**该游戏的详情页**（能看到刚弄好的封面与信息），
    // 而不是回库页让他再找一遍。新建时 always 有 id（上面已拿到）。
    if (created) void router.push(`/game/${created.id}`)
    else void router.push('/library')
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
  stagedMeta.value = null
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
        <!-- M5.0 U5：只留「选择文件」，「选择文件夹」删掉。
             四个引擎的游戏入口都是「目录里有哪些文件」，所以选任何一个标志性文件
             （Game.ini / RPG_RT.ldb / Game.exe / package.json）都能反推目录；
             选了别的文件就按 import-target.ts 逐层上退，认不出才肯罢休。 -->
        <el-button type="primary" @click="pickFile">{{ t('wizard.chooseFile') }}</el-button>
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

    <!-- M5.0 U6：不管识别成功还是失败，都给出「改引擎」入口。
         原来只有识别失败才有候选列表，识别错了用户只能先存下来再去编辑页改。 -->
    <div class="settings-row">
      <div class="settings-row-main">
        <div class="settings-row-title">
          {{ t('wizard.engineLabel') }}
          <el-tag v-if="engineBadge === 'manual'" size="small" type="info" style="margin-left: 6px">
            {{ t('wizard.engineManual') }}
          </el-tag>
          <el-tag v-else-if="engineBadge === 'detected'" size="small" type="success" style="margin-left: 6px">
            {{ t('wizard.engineDetected') }}
          </el-tag>
        </div>
        <div v-if="engineFolder && !engineInstalled" class="settings-row-hint">
          {{ t('wizard.engineMissing', { engine: engineFolder }) }}
        </div>
        <div v-else-if="engineInstalled" class="settings-row-hint">{{ t('wizard.engineInstalled') }}</div>
      </div>
      <el-select
        :model-value="engineFolder"
        :placeholder="t('wizard.enginePick')"
        style="width: 180px"
        @update:model-value="changeEngine"
      >
        <el-option v-for="option in engineOptions" :key="option.value" :label="option.label" :value="option.value" />
      </el-select>
    </div>

    <!-- 装引擎：不装类按钮，失败后也不卡住 -->
    <div v-if="engineFolder && !engineInstalled" class="row">
      <el-button type="primary" :loading="busy" @click="installEngine">
        {{ t('wizard.installEngine') }}
      </el-button>
      <span v-if="installFailed" class="hint">{{ t('wizard.installFailedHint') }}</span>
    </div>

    <el-alert
      v-if="!engineFolder"
      :title="t('wizard.notDetected')"
      :description="t('wizard.notDetectedHint')"
      type="warning"
      :closable="false"
      show-icon
    />

    <!-- 候选列表：让用户改选**同目录下的不同可执行文件**（与上面「改引擎」是两回事） -->
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

    <!-- M5.0 U6：「跳过，稍后安装」按钮已删。
         引擎没装游戏根本跑不起来，让用户跳过等于让他后面必踩一次「点启动失败」。
         容错路径改为「装了但失败」时放行（见 canGoNext 与 installFailed）。 -->
  </section>

  <!-- 第 3 步：完善信息 -->
  <!-- M5.0 S10（U7）：这一步**复用编辑页的 GameInfoForm**（方案 §8 的「不要复制第二份」）。
       原来这里只有「标题 / 路径 / 引擎 / 标签 / 图标」五个裸字段，用户查 DLsite 得
       先存游戏 → 进编辑页 → 再搜一遍 —— 正是他说的「好割裂」。

       game-id 故意不传（新游戏还没保存）→ 组件进入 **staged 模式**：
       查询与字段编辑都只进内存，由 finish() 在 saveGame 之后一起提交。 -->
  <section v-else class="panel stack">
    <GameInfoForm
      ref="infoForm"
      v-model:title="title"
      :game-path="gamePath"
      :icon-path="iconPath"
      @stage-change="onStageChange"
    />

    <div class="settings-row">
      <div class="settings-row-main">
        <div class="settings-row-title">{{ t('wizard.pathLabel') }}</div>
        <div class="settings-row-hint" style="word-break: break-all">{{ gamePath }}</div>
      </div>
    </div>

    <div class="settings-row">
      <div class="settings-row-main">
        <div class="settings-row-title">{{ t('wizard.engineLabel') }}</div>
        <!-- M5.0 U6：第 3 步也留改的入口。原来这里是个只读 tag，
             用户在第 2 步没改、走到这一步才发现不对，就只能返回去。 -->
      </div>
      <el-select
        :model-value="engineFolder"
        :placeholder="t('wizard.enginePick')"
        style="width: 180px"
        @update:model-value="changeEngine"
      >
        <el-option v-for="option in engineOptions" :key="option.value" :label="option.label" :value="option.value" />
      </el-select>
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
