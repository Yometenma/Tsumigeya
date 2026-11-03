<script setup lang="ts">
// 编辑 / 新建游戏（§4 GameEditPage.vue）：标题、路径、引擎、标签、图标 + DynamicArgsForm。
// 引擎切换时按新 manifest 重置 args（契约要求）。
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import DynamicArgsForm from '@/components/DynamicArgsForm.vue'
import VersionManagerDialog from '@/components/VersionManagerDialog.vue'
import { api, iconUrl, translateError, type GameArgDef, type ManifestRaw } from '@/api/client'
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
