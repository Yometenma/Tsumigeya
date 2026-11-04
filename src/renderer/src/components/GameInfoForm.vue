<script setup lang="ts">
// M5.0 S10（U7）：游戏信息表单 —— **编辑页与添加向导共用的一处**。
//
// ===== 为什么要抽这个组件 =====
//
// 用户原话：「现在的还是好早之前的，好割裂，每次导入游戏之后还要专门编辑进去再查找对应的」
//
// 方案 §8 的结论：把「完善信息」重做成与编辑页**同一套组件**，**不复制第二份**。
// 复制的代价这时已经能预见：DLsite 面板有 300+ 行状态机（查/存分离、编辑标记、
// 搜索候选、封面回退），复制一份就必然分叉 —— 而分叉的表现是
// 「编辑页能搜索、向导不能」这种 Exactly 用户抱怨的割裂。
//
// ===== 这个组件最核心的设计：两种模式 =====
//
// 判据在 `shared/gameinfo-form.ts`（有 26 条单测）。一句话：
//
//   · **bound**   有 gameId：每个动作立刻落盘（与原来编辑页一模一样）
//   · **staged**  没有 gameId（向导里游戏还没保存）：动作只进内存，
//                 由父组件在保存游戏后一起提交
//
// 没有这一层抽象就没法"共用"：原实现遇到没有 id 的情况只能弹
// `error.dlsiteGameRequired`（"先保存游戏"）—— 那正是割裂感的来源。
//
// ===== ⚠️ 三条必须守的规矩 =====
//
// ① 过 contextBridge 一律 `toPlain()`（D44）：这里用 shared/plain 的通用递归版，
//    而不是像原实现那样逐字段手抄（逐字段拷贝**已经漏过两次**）。
// ② 所有 ref/computed 声明在任何 `watch({immediate:true})` 之前（TDZ 白屏）。
// ③ 模板里不写 TS 断言、不写复杂表达式（都会白屏）。
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import {
  api,
  iconUrl,
  translateError,
  EDITABLE_FIELDS,
  type DlsiteSearchHit,
  type DlsiteWork,
  type EditableField
} from '@/api/client'
import { stripLanguageSuffix } from '../../../shared/game-language'
import {
  applyStagedField,
  applyStagedReset,
  infoFormMode,
  saveLabel,
  shouldPersist,
  stagedMetaToCommit,
  type InfoFormMode
} from '../../../shared/gameinfo-form'
import { toPlain } from '../../../shared/plain'
import { useLibraryStore } from '@/stores/library'

const props = defineProps<{
  /**
   * 游戏 id。**空值 = staged 模式**（向导里游戏还没保存）。
   */
  gameId?: string
  /** 标题（v-model:title）。标题来源提示与封面占位都要它。 */
  title: string
  /** 游戏路径（识别 RJ、生成搜索关键词要用）。 */
  gamePath: string
  /** 本地图标路径（封面预览的兜底）。 */
  iconPath?: string
}>()

const emit = defineEmits<{
  'update:title': [value: string]
  /**
   * staged 模式下元数据变了（父组件据此在保存游戏后提交）。
   *
   * bound 模式下也会发（内容是该游戏的已存元数据），但父组件可以忽略它。
   */
  'stage-change': [work: DlsiteWork | null]
}>()

const { t } = useI18n()
const library = useLibraryStore()

// ===== 模式 =====
const mode = computed<InfoFormMode>(() => infoFormMode(props.gameId))

/** 「保存」按钮的文案身份（bound = 保存；staged = 用于新游戏）。 */
const saveLabelKey = computed(() => saveLabel(mode.value))

// ===== 状态（全部在 watch 之前声明，守 TDZ 规矩）=====

/** 用户填的 RJ 号。 */
const rjInput = ref('')
/** 从路径识别出的候选（可能多个，让用户选，不瞎猜）。 */
const rjCandidates = ref<string[]>([])
/**
 * 查到但**还没落盘**的作品。
 *
 * staged 模式下它就是"用户选好的那份"（父组件保存游戏后提交它）；
 * bound 模式下它只是预览，点保存才落盘。
 */
const preview = ref<DlsiteWork | null>(null)
const looking = ref(false)
const savingMeta = ref(false)

/** 搜索面板状态（方案 §A.3：只出候选，绝不自动选第一条）。 */
const searchOpen = ref(false)
const searchKeyword = ref('')
const searchHits = ref<DlsiteSearchHit[]>([])
const searching = ref(false)
const searchedKeyword = ref('')

/** 可编辑字段的就地编辑状态（方案 §B.4）。 */
const editingField = ref<EditableField | null>(null)
const editDraft = ref('')
const savingField = ref(false)

/** 预览图加载失败（防盗链/过期很常见）。 */
const metaCoverBroken = ref(false)

/** 库里已保存的元数据（bound 模式才有意义）。 */
const savedMeta = computed<DlsiteWork | undefined>(() => {
  const id = props.gameId?.trim()
  return id ? library.meta[id] : undefined
})

/**
 * 面板上显示的那一份：预览优先（覆盖已存的），否则显示已存的。
 *
 * staged 模式下 `savedMeta` 永远是 undefined，所以这里就是 preview ——
 * 也就是"用户查到的那份"，语义一致。
 */
const shownMeta = computed(() => preview.value ?? savedMeta.value)
const metaPreviewSrc = computed(() => shownMeta.value?.coverUrl)

/** 当前生效的封面来源（与 shared/gamecard-info.ts 的优先级一致）。 */
const coverSource = computed<'dlsite' | 'icon' | 'placeholder'>(() => {
  if (metaPreviewSrc.value) return 'dlsite'
  if (iconUrl(props.iconPath)) return 'icon'
  return 'placeholder'
})

const effectiveCoverSrc = computed(() => metaPreviewSrc.value ?? iconUrl(props.iconPath))
const coverPlaceholder = computed(() => props.title.trim().slice(0, 1).toUpperCase() || '?')

/** 标题是否被用户手动改过（M2.5 的 editedFields 机制）。 */
const titleManuallyEdited = computed(() => (shownMeta.value?.editedFields ?? []).includes('title'))
const dlsiteTitle = computed(() => shownMeta.value?.title?.trim() || undefined)

/**
 * 当前标题的来源：
 * · `manual`  用户手改过（以 gameTitle 为准）
 * · `dlsite`  没改过且有元数据（显示层会用 DLsite 标题）
 * · `dirname` 没有元数据
 */
const titleSource = computed<'manual' | 'dlsite' | 'dirname'>(() => {
  if (titleManuallyEdited.value) return 'manual'
  if (dlsiteTitle.value) return 'dlsite'
  return 'dirname'
})

/** 「改用 DLsite 标题」是否可点。 */
const canUseDlsiteTitle = computed(() => {
  const target = dlsiteTitle.value
  return !!target && props.title.trim() !== target
})

/** 有已保存的元数据且当前没有预览（决定「刷新 / 强制覆盖 / 清除」按钮显不显示）。 */
const canRefreshSaved = computed(() => !!savedMeta.value && !preview.value)
const hasEdits = computed(() => (shownMeta.value?.editedFields ?? []).length > 0)

/** 一进编辑页就把已存的 RJ 回填（bound 模式）。 */
watch(
  () => [props.gameId, library.meta] as const,
  () => {
    const id = props.gameId?.trim()
    rjInput.value = id ? (library.meta[id]?.rj ?? '') : ''
  },
  { immediate: true }
)

/** 换游戏就清空所有本地状态（否则上一个游戏的预览/候选会残留）。 */
watch(
  () => props.gameId,
  () => {
    preview.value = null
    rjCandidates.value = []
    searchOpen.value = false
    searchHits.value = []
    searchedKeyword.value = ''
    editingField.value = null
    editDraft.value = ''
  }
)

/** 封面换了就重置"加载失败"标记。 */
watch(
  () => shownMeta.value?.coverUrl,
  () => {
    metaCoverBroken.value = false
  }
)

/** staged 模式下把当前这份元数据同步给父组件（让它能在保存游戏后提交）。 */
watch(
  () => preview.value,
  (next) => {
    if (mode.value !== 'staged') return
    emit('stage-change', next)
  },
  { deep: false }
)

/** 父组件要用它取「该提交的那份」。 */
function stagedMeta(): DlsiteWork | null {
  return stagedMetaToCommit(preview.value) as DlsiteWork | null
}

defineExpose({ stagedMeta })

// ===== 动作 =====

/** 从路径生成默认搜索关键词（剥语言标记与版本号，与多语言识别同一套规则）。 */
function guessKeyword(filePath: string): string {
  const raw = filePath.trim()
  if (!raw) return ''
  const segment = raw.split(/[\\/]+/).filter(Boolean).pop() ?? ''
  return stripLanguageSuffix(segment).base
}

/** 认一个 RJ 号（只识别、只填框，不自动查询 —— 识别毫秒级、查询要等网络）。 */
async function detectRj(): Promise<void> {
  if (!props.gamePath.trim()) {
    ElMessage.warning(t('wizard.needPath'))
    return
  }
  try {
    rjCandidates.value = await library.detectRj(props.gamePath.trim())
    if (rjCandidates.value.length === 0) {
      ElMessage.info(t('dlsite.notDetected'))
      return
    }
    rjInput.value = rjCandidates.value[0]!
    ElMessage.success(t('dlsite.detected', { count: rjCandidates.value.length }))
  } catch (error) {
    ElMessage.error(translateError(error, t))
  }
}

/** 展开/收起搜索面板（第一次展开用目录名兜底关键词）。 */
function toggleSearch(): void {
  searchOpen.value = !searchOpen.value
  if (searchOpen.value && !searchKeyword.value.trim()) {
    searchKeyword.value = guessKeyword(props.gamePath)
  }
}

/** 执行搜索：只出候选，不落盘、不自动选中（D24）。 */
async function runSearch(): Promise<void> {
  const keyword = searchKeyword.value.trim()
  if (!keyword) {
    ElMessage.warning(t('dlsite.searchNoKeyword'))
    return
  }
  searching.value = true
  try {
    const hits = await library.searchDlsite(keyword)
    searchHits.value = hits
    searchedKeyword.value = keyword
    if (hits.length === 0) ElMessage.info(t('dlsite.searchEmpty', { keyword }))
  } catch (error) {
    searchHits.value = []
    searchedKeyword.value = keyword
    ElMessage.error(translateError(error, t))
  } finally {
    searching.value = false
  }
}

/** 点选候选：只填 RJ，不自动查询（保持查/存分离）。 */
function pickHit(hit: DlsiteSearchHit): void {
  rjInput.value = hit.rj
  searchOpen.value = false
}

/** 拉取元数据到预览（**不落盘**）。 */
async function lookup(): Promise<void> {
  const target = rjInput.value.trim()
  if (!target) {
    ElMessage.warning(t('dlsite.rjPlaceholder'))
    return
  }
  looking.value = true
  try {
    preview.value = await library.lookupRj(target)
    rjInput.value = preview.value.rj
  } catch (error) {
    preview.value = null
    ElMessage.error(translateError(error, t))
  } finally {
    looking.value = false
  }
}

/**
 * 保存预览结果。
 *
 * ⚠️ 两个模式在这里分叉：
 * · bound  → `saveGameMeta`（落盘）
 * · staged → **只发 stage-change**，不动盘（父组件保存游戏后提交）
 */
async function saveMeta(): Promise<void> {
  const work = preview.value
  if (!work) return

  if (!shouldPersist(mode.value, 'saveMeta')) {
    // staged：把这份"选好了"的元数据交给父组件（它会在保存游戏后提交）
    emit('stage-change', work)
    ElMessage.success(t('dlsite.stagedSaved'))
    return
  }

  savingMeta.value = true
  try {
    // ⚠️ toPlain：preview 是 Vue 的响应式 Proxy，直接传会撞
    // "An object could not be cloned."（D44，已经踩过两次）
    await library.saveGameMeta(props.gameId!, toPlain(work))
    preview.value = null
    ElMessage.success(t('dlsite.saved'))
  } catch (error) {
    ElMessage.error(translateError(error, t))
  } finally {
    savingMeta.value = false
  }
}

/** 用已存的 RJ 重新拉取并直接落盘（bound 专用）。 */
async function refreshMeta(): Promise<void> {
  if (!shouldPersist(mode.value, 'refreshMeta')) return
  const id = props.gameId?.trim()
  if (!id) return
  looking.value = true
  try {
    await library.refreshGameMeta(id, true)
    preview.value = null
    ElMessage.success(t('dlsite.saved'))
  } catch (error) {
    ElMessage.error(translateError(error, t))
  } finally {
    looking.value = false
  }
}

/** 强制覆盖全部（丢掉编辑标记）。 */
async function forceRefresh(): Promise<void> {
  if (!shouldPersist(mode.value, 'forceRefresh')) return
  const id = props.gameId?.trim()
  if (!id) return
  looking.value = true
  try {
    await library.refreshGameMeta(id, true, true)
    preview.value = null
    ElMessage.success(t('dlsite.forceRefreshed'))
  } catch (error) {
    ElMessage.error(translateError(error, t))
  } finally {
    looking.value = false
  }
}

/** 清除 DLsite 信息（不动游戏记录）。staged 下就是清掉预览。 */
async function clearMeta(): Promise<void> {
  preview.value = null
  rjInput.value = ''
  if (mode.value === 'staged') {
    emit('stage-change', null)
    return
  }
  const id = props.gameId?.trim()
  if (!id) return
  try {
    await library.clearGameMeta(id)
    ElMessage.success(t('dlsite.cleared'))
  } catch (error) {
    ElMessage.error(translateError(error, t))
  }
}

/** 在 DLsite 打开（只允许 https）。 */
async function openOnDlsite(): Promise<void> {
  const rj = shownMeta.value?.rj
  if (!rj) return
  try {
    await api.openExternal(`https://www.dlsite.com/maniax/work/=/product_id/${rj}.html`)
  } catch (error) {
    ElMessage.error(translateError(error, t))
  }
}

/** 标题改成 DLsite 的标题。 */
function useDlsiteTitle(): void {
  const target = dlsiteTitle.value
  if (target) emit('update:title', target)
  if (searchOpen.value) return
  // 注：只改标题输入框；是否落进 games.json 由父组件的保存决定（D46：
  // 「标记为手动改过」靠 editedFields，这里不擅自写 meta）
}

/** 预览图加载失败 → 退成占位。 */
function onMetaCoverError(): void {
  metaCoverBroken.value = true
}

// ===== 字段编辑（§B.4）=====

function isFieldEdited(field: EditableField): boolean {
  return (shownMeta.value?.editedFields ?? []).includes(field)
}

/** 某字段当前显示的值（统一转字符串）。 */
function fieldValue(field: EditableField): string {
  const meta = shownMeta.value
  if (!meta) return ''
  const value = meta[field]
  if (value === undefined || value === null) return ''
  return String(value)
}

/** 字段的中文标签（模板里不写三元链）。 */
function fieldLabel(field: EditableField): string {
  const labels: Record<EditableField, string> = {
    title: t('dlsite.fieldTitle'),
    circle: t('dlsite.fieldCircle'),
    coverUrl: t('dlsite.fieldCover'),
    registDate: t('dlsite.fieldReleased'),
    price: t('dlsite.fieldPriceBase')
  }
  return labels[field]
}

function beginEdit(field: EditableField): void {
  editingField.value = field
  editDraft.value = fieldValue(field)
}

function cancelEdit(): void {
  editingField.value = null
  editDraft.value = ''
}

/**
 * 保存单个字段。
 *
 * bound  → saveGameMeta（整条写 + editedFields 并集）
 * staged → 就地改内存里那份（判据在 shared/gameinfo-form.ts 的 applyStagedField）
 */
async function commitEdit(): Promise<void> {
  const field = editingField.value
  const meta = shownMeta.value
  if (!field || !meta) return

  if (mode.value === 'staged') {
    const result = applyStagedField(plainMeta(meta), field, editDraft.value)
    if ('error' in result) {
      ElMessage.warning(result.error === 'invalid-cover' ? t('dlsite.invalidCover') : t('dlsite.invalidPrice'))
      return
    }
    preview.value = result.next as DlsiteWork
    editingField.value = null
    editDraft.value = ''
    emit('stage-change', preview.value)
    ElMessage.success(t('dlsite.fieldSaved'))
    return
  }

  // bound：沿用原来的"整条写"策略（最不容易漏字段，见 library-meta 的 save 注释）
  const draft = editDraft.value.trim()
  let next: DlsiteWork = plainMeta(meta)
  if (field === 'price') {
    if (draft === '') next = { ...next, price: undefined }
    else {
      // ⚠️ 与 shared/gameinfo-form.ts 同一处陷阱：剥完为空要当非法，
      // 否则 `Number('') === 0` 会把 "abc" 静默存成价格 0
      const digits = draft.replace(/[^\d.-]/g, '')
      if (!digits) {
        ElMessage.warning(t('dlsite.invalidPrice'))
        return
      }
      const parsed = Number(digits)
      if (!Number.isFinite(parsed)) {
        ElMessage.warning(t('dlsite.invalidPrice'))
        return
      }
      next = { ...next, price: parsed }
    }
  } else if (field === 'coverUrl') {
    if (draft && !/^https:\/\/img\.dlsite\.jp\//i.test(draft)) {
      ElMessage.warning(t('dlsite.invalidCover'))
      return
    }
    next = { ...next, coverUrl: draft || undefined }
  } else {
    next = { ...next, [field]: draft || undefined }
  }

  const fields: EditableField[] = [...(next.editedFields ?? [])]
  if (!fields.includes(field)) fields.push(field)

  savingField.value = true
  try {
    await library.saveGameMeta(props.gameId!, toPlain(next), fields)
    editingField.value = null
    editDraft.value = ''
    ElMessage.success(t('dlsite.fieldSaved'))
  } catch (error) {
    ElMessage.error(translateError(error, t))
  } finally {
    savingField.value = false
  }
}

/** 重置单个字段（下次刷新取回 DLsite 值）。 */
async function resetField(field: EditableField): Promise<void> {
  const meta = shownMeta.value
  if (!meta) return

  if (mode.value === 'staged') {
    const result = applyStagedReset(plainMeta(meta), field)
    if (!result) return
    preview.value = result.next as DlsiteWork
    emit('stage-change', preview.value)
    ElMessage.success(t('dlsite.fieldReset'))
    return
  }

  savingField.value = true
  try {
    const fields = (meta.editedFields ?? []).filter((item) => item !== field)
    await library.saveGameMeta(props.gameId!, toPlain(plainMeta(meta)), fields)
    ElMessage.success(t('dlsite.fieldReset'))
  } catch (error) {
    ElMessage.error(translateError(error, t))
  } finally {
    savingField.value = false
  }
}

/**
 * 把（可能是响应式 Proxy 的）元数据条目剥成纯对象。
 *
 * ⚠️ M5.0 S10：这里**不再逐字段手抄**（原实现那份 30 行的 plainWork）。
 * 逐字段拷贝踩过两次（D44 的原话），而 `toPlain()` 是通用递归版、在 store 层统一使用。
 * 仍保留这个薄壳是因为类型要收窄成 `DlsiteWork`，而不是 `Record<string, unknown>`。
 */
function plainMeta(meta: DlsiteWork): DlsiteWork {
  return toPlain(meta) as DlsiteWork
}
</script>

<template>
  <!-- ===== 游戏身份：标题 + 封面预览 ===== -->
  <div class="settings-row">
    <div class="settings-row-main">
      <div class="settings-row-title">{{ t('game.titleLabel') }}</div>
      <!-- 告诉用户当前标题从哪来，别让人以为「改了没生效」 -->
      <div class="settings-row-hint title-source-hint">
        <template v-if="titleSource === 'manual'">{{ t('game.titleFromManual') }}</template>
        <template v-else-if="titleSource === 'dlsite'">{{ t('game.titleFromDlsite') }}</template>
        <template v-else>{{ t('game.titleFromDirname') }}</template>
      </div>
    </div>
    <div class="row" style="flex: 0 0 auto">
      <el-input
        :model-value="title"
        :placeholder="t('wizard.titlePlaceholder')"
        style="width: 320px"
        @update:model-value="emit('update:title', $event)"
      />
      <el-button v-if="canUseDlsiteTitle" size="small" :title="dlsiteTitle" @click="useDlsiteTitle">
        {{ t('game.useDlsiteTitle') }}
      </el-button>
    </div>
  </div>

  <!-- 封面预览：让用户看清「卡片上到底会显示哪张」（D45：图标与封面合并成一个概念） -->
  <div class="settings-row">
    <div class="settings-row-main">
      <div class="settings-row-title">{{ t('game.coverPreview') }}</div>
      <div class="settings-row-hint">
        <template v-if="coverSource === 'dlsite'">{{ t('game.coverFromDlsite') }}</template>
        <template v-else-if="coverSource === 'icon'">{{ t('game.coverFromIcon') }}</template>
        <template v-else>{{ t('game.coverPlaceholder') }}</template>
      </div>
    </div>
    <div class="cover-preview">
      <img v-if="effectiveCoverSrc" :src="effectiveCoverSrc" :alt="title" />
      <span v-else class="cover-preview-fallback">{{ coverPlaceholder }}</span>
    </div>
  </div>

  <!-- ===== DLsite：RJ + 内联搜索 + 候选 ===== -->
  <div class="settings-row">
    <div class="settings-row-main">
      <div class="settings-row-title">{{ t('dlsite.rjLabel') }}</div>
      <div v-if="rjCandidates.length > 1" class="settings-row-hint">
        {{ t('dlsite.detected', { count: rjCandidates.length }) }}
        <el-button v-for="candidate in rjCandidates" :key="candidate" size="small" text @click="rjInput = candidate">
          {{ candidate }}
        </el-button>
      </div>
    </div>
    <div class="row" style="flex: 0 0 auto">
      <el-input v-model="rjInput" :placeholder="t('dlsite.rjPlaceholder')" style="width: 180px" />
      <el-button :disabled="!gamePath" @click="detectRj">{{ t('dlsite.detect') }}</el-button>
      <el-button @click="toggleSearch">{{ t('dlsite.search') }}</el-button>
      <el-button type="primary" :loading="looking" :disabled="!rjInput" @click="lookup">
        {{ t('dlsite.lookup') }}
      </el-button>
    </div>
  </div>

  <!-- 按名字搜索（候选列表让用户自己点选，绝不自动选第一条，D24） -->
  <div v-if="searchOpen" class="search-panel">
    <div class="row" style="gap: 8px">
      <el-input
        v-model="searchKeyword"
        :placeholder="t('dlsite.searchKeywordPlaceholder')"
        style="flex: 1"
        @keyup.enter="runSearch"
      />
      <el-button type="primary" :loading="searching" @click="runSearch">
        {{ t('dlsite.searchSubmit') }}
      </el-button>
      <el-button text @click="toggleSearch">{{ t('dlsite.searchClose') }}</el-button>
    </div>
    <div class="hint">{{ t('dlsite.searchHint') }}</div>

    <div v-if="searching" class="hint">{{ t('dlsite.searching') }}</div>

    <template v-else-if="searchHits.length > 0">
      <div class="hint">
        <template v-if="searchHits.length >= 20">
          {{ t('dlsite.searchTruncated', { count: searchHits.length }) }}
        </template>
        <template v-else>{{ t('dlsite.searchResultsCount', { count: searchHits.length }) }}</template>
      </div>
      <div class="search-hits">
        <div
          v-for="hit in searchHits"
          :key="hit.rj"
          class="search-hit"
          :class="{ 'search-hit-active': hit.rj === rjInput }"
          role="button"
          tabindex="0"
          @click="pickHit(hit)"
          @keyup.enter="pickHit(hit)"
        >
          <img v-if="hit.coverUrl" :src="hit.coverUrl" :alt="hit.title" class="search-hit-cover" />
          <div v-else class="search-hit-cover search-hit-no-cover" />
          <div class="search-hit-main">
            <div class="search-hit-title">{{ hit.title }}</div>
            <div class="hint">{{ hit.rj }}</div>
          </div>
        </div>
      </div>
    </template>

    <div v-else-if="searchedKeyword" class="hint">
      {{ t('dlsite.searchEmpty', { keyword: searchedKeyword }) }}
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
    <div class="stack" style="gap: 6px; flex: 1">
      <!-- 可编辑字段：值 + 铅笔 + 已修改标记 + 重置（§B.4） -->
      <div v-for="field in EDITABLE_FIELDS" :key="field" class="meta-field">
        <div class="meta-field-main">
          <div v-if="editingField === field" class="meta-field-edit">
            <span class="meta-field-label">{{ fieldLabel(field) }}</span>
            <el-input
              v-model="editDraft"
              size="small"
              :placeholder="t('dlsite.editField') + fieldLabel(field)"
              @keyup.enter="commitEdit"
              @keyup.esc="cancelEdit"
            />
            <el-button size="small" type="primary" :loading="savingField" @click="commitEdit">
              {{ t('common.save') }}
            </el-button>
            <el-button size="small" text @click="cancelEdit">{{ t('common.cancel') }}</el-button>
          </div>
          <div v-else class="meta-field-view">
            <span class="meta-field-label">{{ fieldLabel(field) }}</span>
            <span class="meta-field-value">{{ fieldValue(field) || '—' }}</span>
            <el-tag v-if="isFieldEdited(field)" size="small" type="warning">
              {{ t('dlsite.editedBadge') }}
            </el-tag>
            <el-button size="small" text @click="beginEdit(field)">{{ t('dlsite.editField') }}</el-button>
            <el-button v-if="isFieldEdited(field)" size="small" text @click="resetField(field)">
              {{ t('dlsite.resetField') }}
            </el-button>
          </div>
        </div>
      </div>

      <!-- 只读字段（rj 不给改：改它等于换作品，§B.3） -->
      <div v-if="shownMeta.seriesName" class="hint">
        {{ t('dlsite.fieldSeries') }}：{{ shownMeta.seriesName }}
      </div>
      <div v-if="shownMeta.workType" class="hint">{{ t('dlsite.fieldType') }}：{{ shownMeta.workType }}</div>
      <div class="hint">{{ t('dlsite.editHint') }}</div>
    </div>
  </div>

  <div v-else class="hint">{{ t('dlsite.noMeta') }}</div>

  <div class="row" style="gap: 8px">
    <el-button v-if="preview" type="primary" :loading="savingMeta" @click="saveMeta">
      {{ t(`dlsite.${saveLabelKey}`) }}
    </el-button>
    <el-button v-if="canRefreshSaved" :loading="looking" @click="refreshMeta">
      {{ t('dlsite.refresh') }}
    </el-button>
    <el-button v-if="canRefreshSaved && hasEdits" :loading="looking" @click="forceRefresh">
      {{ t('dlsite.forceRefresh') }}
    </el-button>
    <el-button v-if="canRefreshSaved" text type="danger" @click="clearMeta">{{ t('dlsite.clear') }}</el-button>
    <el-button v-if="shownMeta" text @click="openOnDlsite">{{ t('dlsite.openOnDlsite') }}</el-button>
  </div>
</template>
