<script setup lang="ts">
// 编辑 / 新建游戏（§4 GameEditPage.vue）：标题、路径、引擎、标签、图标 + DynamicArgsForm。
// 引擎切换时按新 manifest 重置 args（契约要求）。
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import DynamicArgsForm from '@/components/DynamicArgsForm.vue'
import VersionManagerDialog from '@/components/VersionManagerDialog.vue'
import { api, iconUrl, translateError, type DlsiteWork, type GameArgDef, type ManifestRaw } from '@/api/client'
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

const versionDialog = ref(false)
const versionArgKey = ref('')
const versionDef = ref<GameArgDef | null>(null)

// ===== M2：DLsite 元数据面板状态（方案 §6.1）=====
//
// ⚠️ 这些 ref 必须声明在 **fill() 之前**：下面的 `watch(..., { immediate: true })` 会在
// setup 期间立刻调用 fill()，而 fill() 要写 rjInput。放到后面会撞 TDZ
// （`ReferenceError: Cannot access 'rjInput' before initialization` —— 端到端探针实测踩到）。
// 当前组件里「先声明后使用」的顺序是隐式契约，加新 ref 时务必守住。

/** 用户填的 RJ 号。 */
const rjInput = ref('')
/** 从路径识别出的候选（可能多个，让用户选，不瞎猜）。 */
const rjCandidates = ref<string[]>([])
/** 查询到的作品（预览用；未保存时与库里无关）。 */
const preview = ref<DlsiteWork | null>(null)
const looking = ref(false)
const savingMeta = ref(false)

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
  // M2：把已存的 RJ 号回填到面板（元数据本身从 library.meta 读，不用再拷一份）
  rjInput.value = library.meta[gameId.value ?? '']?.rj ?? ''
  preview.value = null
  rjCandidates.value = []
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

async function chooseFolder(): Promise<void> {
  const picked = await api.pickPath('folder')
  if (!picked) return
  path.value = picked
  await autoDetect(picked)
}

async function chooseFile(): Promise<void> {
  const picked = await api.pickPath('file')
  if (!picked) return
  path.value = picked
  await autoDetect(picked)
}

/** 选了路径就顺手识别一次引擎（未装引擎的提示交给向导，这里只填已装的）。 */
async function autoDetect(target: string): Promise<void> {
  try {
    const result = await api.detectFolder(target, false)
    if (result.best?.engine) engine.value = result.best.engine
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

// ===== M2：DLsite 元数据面板逻辑（方案 §6.1）=====
//
// 交互原则：**先预览、点保存才落盘**（§5.1）。查询失败绝不写库，
// 所以 `lookup` 与 `saveMeta` 是两个独立动作，中间隔着一个用户确认。
// （状态声明在上面，必须在 fill() 之前，见那段注释。）

/** 库里已保存的元数据（编辑模式才有）。 */
const savedMeta = computed(() => (gameId.value ? library.meta[gameId.value] : undefined))
/** 面板上显示的那一份：预览优先（覆盖已存的），否则显示已存的。 */
const shownMeta = computed(() => preview.value ?? savedMeta.value)
const metaPreviewSrc = computed(() => shownMeta.value?.coverUrl)

/**
 * 认一个 RJ 号并自动查询一次。
 * 注意：这里**只查询**，落盘要用户再点「保存」——见 saveMeta。
 */
async function detectRj(): Promise<void> {
  if (!path.value.trim()) {
    ElMessage.warning(t('wizard.needPath'))
    return
  }
  try {
    rjCandidates.value = await library.detectRj(path.value.trim())
    if (rjCandidates.value.length === 0) {
      ElMessage.info(t('dlsite.notDetected'))
      return
    }
    // 只识别不自动查询：识别是毫秒级本地操作，查询要等网络，混在一起用户会以为「卡了」
    rjInput.value = rjCandidates.value[0]
    ElMessage.success(t('dlsite.detected', { count: rjCandidates.value.length }))
  } catch (error) {
    ElMessage.error(translateError(error, t))
  }
}

/** 拉取元数据到预览（不落盘）。 */
async function lookup(rj?: string, refresh = false): Promise<void> {
  const target = (rj ?? rjInput.value).trim()
  if (!target) {
    ElMessage.warning(t('dlsite.rjPlaceholder'))
    return
  }
  looking.value = true
  try {
    preview.value = await library.lookupRj(target, refresh)
    rjInput.value = preview.value.rj
  } catch (error) {
    // 查询失败 → 什么都不写；预览也清掉，避免显示上一次的旧数据
    preview.value = null
    ElMessage.error(translateError(error, t))
  } finally {
    looking.value = false
  }
}

/** 保存预览结果到 library-meta.json（这里才真的动库）。 */
async function saveMeta(): Promise<void> {
  const work = preview.value
  if (!work) return
  if (!gameId.value) {
    // 新游戏还没有 id，元数据无处可挂——提示先保存游戏（方案 §5.4 error.dlsiteGameRequired）
    ElMessage.warning(t('error.dlsiteGameRequired'))
    return
  }
  savingMeta.value = true
  try {
    await library.saveGameMeta(gameId.value, work)
    preview.value = null
    ElMessage.success(t('dlsite.saved'))
  } catch (error) {
    ElMessage.error(translateError(error, t))
  } finally {
    savingMeta.value = false
  }
}

/** 用已存的 RJ 重新拉取并直接落盘（刷新场景不需要再确认，数据是覆盖同一个游戏）。 */
async function refreshMeta(): Promise<void> {
  if (!gameId.value) return
  looking.value = true
  try {
    await library.refreshGameMeta(gameId.value, true)
    preview.value = null
    ElMessage.success(t('dlsite.saved'))
  } catch (error) {
    ElMessage.error(translateError(error, t))
  } finally {
    looking.value = false
  }
}

/** 清除该游戏的 DLsite 信息（不动游戏记录）。 */
async function clearMeta(): Promise<void> {
  if (!gameId.value) return
  try {
    await library.clearGameMeta(gameId.value)
    preview.value = null
    rjInput.value = ''
    ElMessage.success(t('dlsite.cleared'))
  } catch (error) {
    ElMessage.error(translateError(error, t))
  }
}

/** 在 DLsite 打开（走既有 openExternal，只允许 https）。 */
async function openOnDlsite(): Promise<void> {
  const rj = shownMeta.value?.rj
  if (!rj) return
  try {
    await api.openExternal(`https://www.dlsite.com/maniax/work/=/product_id/${rj}.html`)
  } catch (error) {
    ElMessage.error(translateError(error, t))
  }
}

/** 预览图加载失败（防盗链/过期很常见）——退成占位，不留空白块。 */
const metaCoverBroken = ref(false)
function onMetaCoverError(): void {
  metaCoverBroken.value = true
}
watch(
  () => shownMeta.value?.coverUrl,
  () => {
    metaCoverBroken.value = false
  }
)

async function save(): Promise<void> {
  if (!title.value.trim()) {
    ElMessage.warning(t('wizard.needTitle'))
    return
  }
  if (!path.value.trim()) {
    ElMessage.warning(t('wizard.needPath'))
    return
  }
  if (!engine.value) {
    ElMessage.warning(t('wizard.notDetected'))
    return
  }
  saving.value = true
  try {
    await library.saveGame(gameId.value, {
      gameTitle: title.value.trim(),
      gamePath: path.value.trim(),
      gameEngine: engine.value,
      iconPath: iconPath.value,
      tags: tags.value.filter((tag) => tag.trim()),
      gameArgs: gameArgs.value
    })
    ElMessage.success(t('game.saved'))
    void router.push('/library')
  } catch (error) {
    ElMessage.error(translateError(error, t))
  } finally {
    saving.value = false
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
      <el-button @click="router.push('/library')">{{ t('common.back') }}</el-button>
    </header>

    <section class="panel stack" style="margin-bottom: 16px">
      <h3 style="margin: 0">{{ t('game.basicInfo') }}</h3>

      <div class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-title">{{ t('game.titleLabel') }}</div>
        </div>
        <el-input v-model="title" :placeholder="t('wizard.titlePlaceholder')" style="width: 320px" />
      </div>

      <div class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-title">{{ t('game.pathLabel') }}</div>
          <div class="settings-row-hint" style="word-break: break-all">{{ path || '—' }}</div>
        </div>
        <div class="row" style="flex: 0 0 auto">
          <el-button @click="chooseFolder">{{ t('wizard.chooseFolder') }}</el-button>
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

      <div class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-title">{{ t('game.tagsLabel') }}</div>
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
          <div class="settings-row-title">{{ t('game.iconLabel') }}</div>
          <div class="settings-row-hint" style="word-break: break-all">{{ iconPath || '—' }}</div>
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
        @manage-versions="manageVersions"
      />
    </section>

    <!-- M2：DLsite 信息（只挂在编辑页；新游戏还没有 id，所以只能预览不能保存） -->
    <section class="panel stack" style="margin-top: 16px">
      <div>
        <h3 style="margin: 0">{{ t('dlsite.sectionTitle') }}</h3>
        <div class="hint">{{ t('dlsite.sectionHint') }}</div>
      </div>

      <div class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-title">{{ t('dlsite.rjLabel') }}</div>
          <div v-if="rjCandidates.length > 1" class="settings-row-hint">
            {{ t('dlsite.detected', { count: rjCandidates.length }) }}
            <el-button
              v-for="candidate in rjCandidates"
              :key="candidate"
              size="small"
              text
              @click="rjInput = candidate"
            >
              {{ candidate }}
            </el-button>
          </div>
        </div>
        <div class="row" style="flex: 0 0 auto">
          <el-input v-model="rjInput" :placeholder="t('dlsite.rjPlaceholder')" style="width: 180px" />
          <el-button :disabled="!path" @click="detectRj">{{ t('dlsite.detect') }}</el-button>
          <el-button type="primary" :loading="looking" :disabled="!rjInput" @click="lookup()">
            {{ t('dlsite.lookup') }}
          </el-button>
        </div>
      </div>

      <el-skeleton v-if="looking" :rows="2" animated />

      <div v-else-if="shownMeta" class="dlsite-preview">
        <div class="dlsite-cover">
          <img
            v-if="metaPreviewSrc && !metaCoverBroken"
            :src="metaPreviewSrc"
            :alt="shownMeta.title"
            @error="onMetaCoverError"
          />
          <span v-else>{{ t('dlsite.coverMissing') }}</span>
        </div>
        <div class="stack" style="gap: 4px; flex: 1">
          <div class="dlsite-title">{{ shownMeta.title }}</div>
          <div v-if="shownMeta.circle" class="hint">
            {{ t('dlsite.fieldCircle') }}：{{ shownMeta.circle }}
          </div>
          <div v-if="shownMeta.seriesName" class="hint">
            {{ t('dlsite.fieldSeries') }}：{{ shownMeta.seriesName }}
          </div>
          <div v-if="shownMeta.registDate" class="hint">
            {{ t('dlsite.fieldReleased') }}：{{ shownMeta.registDate }}
          </div>
          <div v-if="shownMeta.priceWithTax" class="hint">
            {{ t('dlsite.fieldPrice') }}：{{ t('dlsite.priceYen', { price: shownMeta.priceWithTax }) }}
          </div>
          <div v-if="shownMeta.workType" class="hint">
            {{ t('dlsite.fieldType') }}：{{ shownMeta.workType }}
          </div>
        </div>
      </div>

      <div v-else class="hint">{{ t('dlsite.noMeta') }}</div>

      <div class="row" style="gap: 8px">
        <el-button v-if="preview" type="primary" :loading="savingMeta" @click="saveMeta">
          {{ t('common.save') }}
        </el-button>
        <el-button v-if="savedMeta && !preview" :loading="looking" @click="refreshMeta">
          {{ t('dlsite.refresh') }}
        </el-button>
        <el-button v-if="savedMeta && !preview" text type="danger" @click="clearMeta">
          {{ t('dlsite.clear') }}
        </el-button>
        <el-button v-if="shownMeta" text @click="openOnDlsite">{{ t('dlsite.openOnDlsite') }}</el-button>
      </div>
    </section>

    <div class="form-actions">
      <el-button type="primary" :loading="saving" @click="save">{{ t('common.save') }}</el-button>
      <el-button @click="router.push('/library')">{{ t('common.cancel') }}</el-button>
    </div>

    <VersionManagerDialog
      v-model="versionDialog"
      :folder="engine"
      :arg-key="versionArgKey"
    />
  </template>
</template>
