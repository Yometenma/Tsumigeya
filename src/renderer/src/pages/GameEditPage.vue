<script setup lang="ts">
// 编辑 / 新建游戏（§4 GameEditPage.vue）：标题、路径、引擎、标签、图标 + DynamicArgsForm。
// 引擎切换时按新 manifest 重置 args（契约要求）。
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import DynamicArgsForm from '@/components/DynamicArgsForm.vue'
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

// ===== M2.5-A：按名字搜索面板状态（§A.3）=====
//
// ⚠️ 同一条规矩：这些 ref 都必须声明在 fill() 之前（fill 由 immediate watch 调用，见上方注释）。
/** 搜索面板是否展开。 */
const searchOpen = ref(false)
/** 搜索关键词（默认用游戏目录名，剥离语言/版本后缀）。 */
const searchKeyword = ref('')
/** 搜索候选列表。**空数组 ≠ 未搜过**，用 searchedKeyword 区分。 */
const searchHits = ref<DlsiteSearchHit[]>([])
const searching = ref(false)
/** 搜过的关键词（用于「找到 N 个」之类提示，以及与当前输入区分）。 */
const searchedKeyword = ref('')

// ===== M2.5-B：可编辑元数据（§B.4）=====
//
// ⚠️ 同样必须声明在 fill() 之前（见上方 TDZ 注释）。
/** 正在编辑哪个字段（null = 没有打开编辑框）。 */
const editingField = ref<EditableField | null>(null)
/** 编辑框里的草稿值（字符串统一处理，price 保存时再转数字）。 */
const editDraft = ref('')
const savingField = ref(false)

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

// ===== M2.7：标题来源提示（§「DLsite 标题优先，允许手动覆盖」）=====
//
// `gameTitle`（games.json，上游 schema）与 `DlsiteWork.title`（旁挂元数据）是两份数据。
// 卡片/详情页显示时按「元数据优先」回落（见 shared/gamecard-info.ts）。
// 这里只负责**告诉用户当前标题从哪来**，并给一个「改用 DLsite 标题」的快捷按钮。

/** 用户是否手动改过标题（M2.5 的 editedFields 机制）。 */
const titleManuallyEdited = computed(() => (shownMeta.value?.editedFields ?? []).includes('title'))

/** DLsite 那边的标题（没有元数据时为 undefined）。 */
const dlsiteTitle = computed(() => shownMeta.value?.title?.trim() || undefined)

/**
 * 当前标题的来源：
 * - `manual`  用户手改过（以 `gameTitle` 为准）
 * - `dlsite`  没改过且有元数据（显示层会用 DLsite 标题）
 * - `dirname` 没有元数据，只有目录名/用户填的
 */
const titleSource = computed<'manual' | 'dlsite' | 'dirname'>(() => {
  if (titleManuallyEdited.value) return 'manual'
  if (dlsiteTitle.value) return 'dlsite'
  return 'dirname'
})

/** 「改用 DLsite 标题」是否可点（有 DLsite 标题且当前不是它）。 */
const canUseDlsiteTitle = computed(() => {
  const target = dlsiteTitle.value
  return !!target && title.value.trim() !== target
})

/** 把标题输入框改成 DLsite 的标题。 */
function useDlsiteTitle(): void {
  const target = dlsiteTitle.value
  if (target) title.value = target
}

// ===== M2.7：封面预览（合并「DLsite 封面 + 本地图标」两个概念）=====
//
// 用户提的冗余点：图标与封面在这一页里是两个独立区块，但卡片其实**只显示一个**。
// 现在合并成一个「封面预览」，让用户看到最终生效的是哪张，并说明来源。
//
// 优先级与 shared/gamecard-info.ts 保持一致：DLsite 封面 → 本地图标 → 首字母占位。

/** 当前生效的封面来源。 */
const coverSource = computed<'dlsite' | 'icon' | 'placeholder'>(() => {
  if (metaPreviewSrc.value) return 'dlsite'
  if (iconPreview.value) return 'icon'
  return 'placeholder'
})

/** 最终显示的图片地址（没有就 undefined，模板显示首字母占位）。 */
const effectiveCoverSrc = computed(() => metaPreviewSrc.value ?? iconPreview.value)

/** 首字母占位（与卡片一致）。 */
const coverPlaceholder = computed(() => title.value.trim().slice(0, 1).toUpperCase() || '?')

/** 图标设置是否展开（默认收起——卡片优先用封面，图标只是兜底）。 */
const iconSectionOpen = ref(false)

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

// ===== M2.5-A：按名字搜索（§A.3）=====
//
// 交互原则：搜索**只出候选列表**，点选后只填 RJ 输入框、不自动拉取
// （保持 M2 的「查 / 存分离」；也避免用户点错时白跑一次网络请求）。

/**
 * 从游戏路径生成默认搜索关键词：取目录名，剥掉语言标记与版本号。
 *
 * 直接复用 stripLanguageSuffix()（src/shared/game-language.ts），与 §C 的多语言识别
 * **同一套规则**。S2 阶段这里是临时内联的，内联版把裸数字当版本号剥，
 * 会把「傭兵の冒険2」的续作序号吃掉 → 搜到错的游戏；S7 统一到共享实现后隐患消失。
 */
function guessKeyword(filePath: string): string {
  const raw = filePath.trim()
  if (!raw) return ''
  // 兼容 / 与 \ 两种分隔符（Windows 路径在渲染层也可能是反斜杠）
  const segment = raw.split(/[\\/]+/).filter(Boolean).pop() ?? ''
  return stripLanguageSuffix(segment).base
}

/** 展开搜索面板（第一次展开时用目录名兜底关键词）。 */
function toggleSearch(): void {
  searchOpen.value = !searchOpen.value
  if (searchOpen.value && !searchKeyword.value.trim()) {
    searchKeyword.value = guessKeyword(path.value)
  }
}

/** 执行搜索：只出候选，不落盘、不自动选中。 */
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
    // 搜不到走 error.dlsiteSearchEmpty（主进程给 key，渲染层查文案）
    searchHits.value = []
    searchedKeyword.value = keyword
    ElMessage.error(translateError(error, t))
  } finally {
    searching.value = false
  }
}

/** 点选一条候选：只填 RJ，不自动查询（保持查存分离）。 */
function pickHit(hit: DlsiteSearchHit): void {
  rjInput.value = hit.rj
  searchOpen.value = false
}

/** 拉取元数据到预览（不落盘）。 */
async function lookup(rj?: string, refresh = false): Promise<void> {  const target = (rj ?? rjInput.value).trim()
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
    // preview 也可能是响应式对象，统一剥成纯对象再传（见 plainWork 的注释）
    await library.saveGameMeta(gameId.value, plainWork(work))
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

// ===== M2.5-B：字段编辑逻辑（§B.4）=====
//
// 关键设计：编辑是**就地改 work 再整条保存**，而不是拼一个 patch 对象。
// 因为 library-meta 的 save 语义是「整条写 + 标记并集」（见 src/main/library-meta.ts），
// 整条传过去最不容易出现「某个字段被漏写」的错。

/** 该字段当前是否被用户编辑过（用来显示「已修改」角标 + 是否可重置）。 */
function isFieldEdited(field: EditableField): boolean {
  return (shownMeta.value?.editedFields ?? []).includes(field)
}

/** 某字段当前显示的值（统一转成字符串给编辑框用）。 */
function fieldValue(field: EditableField): string {
  const meta = shownMeta.value
  if (!meta) return ''
  const value = meta[field]
  if (value === undefined || value === null) return ''
  return String(value)
}

/** 字段的中文标签（模板里不写三元链，避免模板里出现类型断言式的复杂表达式）。 */
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

/** 打开某字段的编辑框（草稿 = 当前值）。 */
function beginEdit(field: EditableField): void {
  editingField.value = field
  editDraft.value = fieldValue(field)
}

/** 取消编辑（不动任何数据）。 */
function cancelEdit(): void {
  editingField.value = null
  editDraft.value = ''
}

/**
 * 把（可能是 Vue 响应式 Proxy 的）元数据条目剥成**纯对象**再交给 IPC。
 *
 * ⚠️ 这是一条真 bug 的修复（S4 端到端探针实测抓到）：
 * 直接 `{ ...meta }` 只做了浅拷贝，`editedFields` 数组仍是 Proxy，
 * contextBridge 结构化克隆时报 **"An object could not be cloned."**，
 * 用户点「保存」会静默失败（只有一行英文报错，字段看起来没动）。
 * 所以这里逐字段取值 + 复制数组，保证传出去的全是普通值。
 */
function plainWork(meta: DlsiteWork): DlsiteWork {
  return {
    rj: meta.rj,
    title: meta.title,
    titleFull: meta.titleFull,
    circle: meta.circle,
    circleId: meta.circleId,
    seriesName: meta.seriesName,
    category: meta.category,
    workType: meta.workType,
    registDate: meta.registDate,
    price: meta.price,
    priceWithTax: meta.priceWithTax,
    officialPrice: meta.officialPrice,
    discount: meta.discount,
    coverUrl: meta.coverUrl,
    description: meta.description,
    fetchedAt: meta.fetchedAt,
    editedFields: [...(meta.editedFields ?? [])]
  }
}

/**
 * 保存单个字段。
 *
 * 与「保存 DLsite 信息」按钮的区别：这里改的是**用户自己的值**，
 * 所以无论如何都要进 editedFields（否则下次刷新会被 DLsite 值冲掉）。
 */
async function commitEdit(): Promise<void> {
  const field = editingField.value
  const meta = shownMeta.value
  if (!field || !meta) return
  if (!gameId.value) {
    // 新游戏还没有 id → 元数据无处可挂（与 saveMeta 同一条提示）
    ElMessage.warning(t('error.dlsiteGameRequired'))
    return
  }

  const draft = editDraft.value.trim()
  // 空值 = 让用户清空这个字段（price 存 undefined，文本存 ''→会被 sanitize 转成 undefined）
  let next: DlsiteWork = plainWork(meta)
  if (field === 'price') {
    if (draft === '') {
      next = { ...next, price: undefined }
    } else {
      const parsed = Number(draft.replace(/[^\d.-]/g, ''))
      if (!Number.isFinite(parsed)) {
        ElMessage.warning(t('dlsite.invalidPrice'))
        return
      }
      next = { ...next, price: parsed }
    }
  } else if (field === 'coverUrl') {
    // 封面地址必须是 img.dlsite.jp（D22 在保存时也会再校一次，这里提前给友好提示）
    if (draft && !/^https:\/\/img\.dlsite\.jp\//i.test(draft)) {
      ElMessage.warning(t('dlsite.invalidCover'))
      return
    }
    next = { ...next, coverUrl: draft || undefined }
  } else {
    next = { ...next, [field]: draft || undefined }
  }

  // editedFields：保留已有的 + 本次这个字段
  const fields: EditableField[] = [...(next.editedFields ?? [])]
  if (!fields.includes(field)) fields.push(field)

  savingField.value = true
  try {
    await library.saveGameMeta(gameId.value, next, fields)
    editingField.value = null
    editDraft.value = ''
    ElMessage.success(t('dlsite.fieldSaved'))
  } catch (error) {
    ElMessage.error(translateError(error, t))
  } finally {
    savingField.value = false
  }
}

/** 重置单个字段：从 editedFields 移除，下次刷新会取回 DLsite 值（§B.2）。 */
async function resetField(field: EditableField): Promise<void> {
  const meta = shownMeta.value
  if (!meta || !gameId.value) return
  const fields = (meta.editedFields ?? []).filter((item) => item !== field)
  savingField.value = true
  try {
    // 同样要剥成纯对象再传（Proxy 过不了 contextBridge，见 plainWork 的注释）
    await library.saveGameMeta(gameId.value, plainWork(meta), fields)
    ElMessage.success(t('dlsite.fieldReset'))
  } catch (error) {
    ElMessage.error(translateError(error, t))
  } finally {
    savingField.value = false
  }
}

/** 「强制覆盖全部」：清空所有编辑标记后整体刷新（§B.2）。 */
async function forceRefresh(): Promise<void> {
  if (!gameId.value) return
  looking.value = true
  try {
    await library.refreshGameMeta(gameId.value, true, true)
    preview.value = null
    ElMessage.success(t('dlsite.forceRefreshed'))
  } catch (error) {
    ElMessage.error(translateError(error, t))
  } finally {
    looking.value = false
  }
}

/** 当前条目是否有任何被编辑过的字段（决定「强制覆盖全部」按钮是否值得显示）。 */
const hasEdits = computed(() => (shownMeta.value?.editedFields ?? []).length > 0)

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
    const before = new Set(library.games.map((item) => item.id))
    await library.saveGame(gameId.value, {
      gameTitle: title.value.trim(),
      gamePath: path.value.trim(),
      gameEngine: engine.value,
      iconPath: iconPath.value,
      tags: tags.value.filter((tag) => tag.trim()),
      gameArgs: gameArgs.value
    })
    // 新建时会多出一条记录——记下它的 id，好让「保存后回详情页」有页面可回。
    if (!gameId.value) {
      const added = library.games.find((item) => !before.has(item.id))
      newlySavedId.value = added?.id
    }
    ElMessage.success(t('game.saved'))
    // M2.6 §5.3：保存后回**详情页**（不是库页）——用户改完元数据，最想看到的是改完的样子。
    // 新建时还没有 id 的变化（saveGame 内部已生成了新 id），所以重新取一次 id。
    goBack()
  } catch (error) {
    ElMessage.error(translateError(error, t))
  } finally {
    saving.value = false
  }
}

/**
 * M2.6 §5.3：编辑页的「返回」回**详情页**而不是库页。
 *
 * 新建流程（`/library/new`、或库里没有这个 id）没有详情页可回，仍然回库页。
 */
function goBack(): void {
  const id = gameId.value ?? newlySavedId.value
  if (id && library.byId(id)) void router.push(`/game/${id}`)
  else void router.push('/library')
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
          <div class="settings-row-title">{{ t('game.titleLabel') }}</div>
          <!-- M2.7：告诉用户当前标题从哪来，别让人以为「改了没生效」 -->
          <div class="settings-row-hint title-source-hint">
            <template v-if="titleSource === 'manual'">{{ t('game.titleFromManual') }}</template>
            <template v-else-if="titleSource === 'dlsite'">{{ t('game.titleFromDlsite') }}</template>
            <template v-else>{{ t('game.titleFromDirname') }}</template>
          </div>
        </div>
        <div class="row" style="flex: 0 0 auto">
          <el-input v-model="title" :placeholder="t('wizard.titlePlaceholder')" style="width: 320px" />
          <el-button v-if="canUseDlsiteTitle" size="small" :title="dlsiteTitle" @click="useDlsiteTitle">
            {{ t('game.useDlsiteTitle') }}
          </el-button>
        </div>
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
    </section>

    <!-- ===== M2.7：封面与标签（合并原来分散的「标签」与「图标」两个区块）===== -->
    <section class="panel stack" style="margin-bottom: 16px">
      <div>
        <h3 style="margin: 0">{{ t('game.coverAndTags') }}</h3>
        <div class="hint">{{ t('game.coverAndTagsHint') }}</div>
      </div>

      <!-- 封面预览：让用户看清「卡片上到底会显示哪张」 -->
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
          <el-button @click="toggleSearch">{{ t('dlsite.search') }}</el-button>
          <el-button type="primary" :loading="looking" :disabled="!rjInput" @click="lookup()">
            {{ t('dlsite.lookup') }}
          </el-button>
        </div>
      </div>

      <!-- M2.5-A：按名字搜索（候选列表让用户自己点选，绝不自动选第一条） -->
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
            {{
              searchHits.length >= 20
                ? t('dlsite.searchTruncated', { count: searchHits.length })
                : t('dlsite.searchResultsCount', { count: searchHits.length })
            }}
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
          <!-- M2.5-B：可编辑字段。每个字段：值 + 铅笔 + 已修改标记 + 重置 -->
          <div v-for="field in EDITABLE_FIELDS" :key="field" class="meta-field">
            <div class="meta-field-main">
              <!-- 编辑态：输入框 + 保存 / 取消 -->
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
              <!-- 展示态 -->
              <div v-else class="meta-field-view">
                <span class="meta-field-label">{{ fieldLabel(field) }}</span>
                <span class="meta-field-value">
                  {{ fieldValue(field) || '—' }}
                </span>
                <el-tag v-if="isFieldEdited(field)" size="small" type="warning">
                  {{ t('dlsite.editedBadge') }}
                </el-tag>
                <el-button size="small" text @click="beginEdit(field)">
                  {{ t('dlsite.editField') }}
                </el-button>
                <el-button v-if="isFieldEdited(field)" size="small" text @click="resetField(field)">
                  {{ t('dlsite.resetField') }}
                </el-button>
              </div>
            </div>
          </div>

          <!-- 不可编辑的只读字段（rj 不给改：改它等于换作品，§B.3） -->
          <div v-if="shownMeta.seriesName" class="hint">
            {{ t('dlsite.fieldSeries') }}：{{ shownMeta.seriesName }}
          </div>
          <div v-if="shownMeta.workType" class="hint">
            {{ t('dlsite.fieldType') }}：{{ shownMeta.workType }}
          </div>
          <div class="hint">{{ t('dlsite.editHint') }}</div>
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
        <el-button v-if="hasEdits && savedMeta && !preview" :loading="looking" @click="forceRefresh">
          {{ t('dlsite.forceRefresh') }}
        </el-button>
        <el-button v-if="savedMeta && !preview" text type="danger" @click="clearMeta">
          {{ t('dlsite.clear') }}
        </el-button>
        <el-button v-if="shownMeta" text @click="openOnDlsite">{{ t('dlsite.openOnDlsite') }}</el-button>
      </div>
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
