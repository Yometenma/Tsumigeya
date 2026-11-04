<script setup lang="ts">
// M2.6 §5.2：游戏详情页（**新**）。
//
// 为什么要有这一页（用户原话 U3）：「点击卡片进去就是显示元数据和各种信息，里面才有启动游戏」。
// 所以本页是**唯一的启动入口**（D38），也是**唯一明说「DLsite 不提供」**的地方（D37）。
//
// 三件必须守住的事：
// 1. 拿不到的字段**明说「暂无」**，不假装（D37）。这与卡片不同：卡片空间有限就不画，
//    详情页是信息页，必须交代清楚。
// 2. 启动链路完整搬过来：M2.5-C 的语言切换确认 + M3 的诊断拦截 + 「还是启动试试」绕过。
//    这些在库页删掉了（点卡片不再是启动），只能在这里。
// 3. R18 封面的打码规则沿用（与卡片同一份 shared/age-rating.ts 判定）。
//
// ⚠️ 模板禁 TS 类型断言（会白屏）；所有 ref/computed 都声明在任何 watch 之前（TDZ 白屏）。
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { ArrowLeft, Top, Bottom, Refresh } from '@element-plus/icons-vue'
import DiagnosisDialog from '@/components/DiagnosisDialog.vue'
import { api, iconUrl, translateError, type Diagnosis } from '@/api/client'
import { isAdultWork } from '../../../shared/age-rating'
import { languageShortName } from '../../../shared/game-language'
import { decideLaunchTarget } from '../../../shared/launch-language'
import { durationShape, hasValidPlayedAt, playTimeView } from '../../../shared/play-time'
import {
  buildDetailFields,
  canRefreshMeta,
  formatPrice,
  formatRating,
  formatSales,
  summaryNeedsCollapse,
  workTypeI18nSuffix
} from '../../../shared/gamecard-info'
import { useLibraryStore } from '@/stores/library'
import { useSettingsStore } from '@/stores/settings'

const props = defineProps<{ id: string }>()

const { t } = useI18n()
const router = useRouter()
const library = useLibraryStore()
const settings = useSettingsStore()

// ===== 状态（全部在 watch 之前声明，避免 TDZ）=====

/** 远程封面加载失败 → 退到本地图标 → 最后退字母占位。 */
const coverBroken = ref(false)
const iconBroken = ref(false)
/** 简介是否展开（§11-② 默认折 6 行）。 */
const summaryExpanded = ref(false)
/** 诊断框状态（M3 §4.2，从库页搬来）。 */
const diagnosisOpen = ref(false)
const diagnosisItems = ref<Diagnosis[]>([])
/** 「重新获取」进行中（防重复点击）。 */
const refreshing = ref(false)
/** M3.5：关闭游戏进行中（防重复点击；主进程最多等 5 秒）。 */
const stopping = ref(false)
/** M3.5：每秒刷新的「已运行多久」文本（只在运行时才有意义）。 */
const runningSince = ref(Date.now())
/** 定时器句柄（组件卸载时清掉，别让它在后台跑）。 */
let runningTimer: ReturnType<typeof setInterval> | null = null

// ===== 派生数据 =====

const game = computed(() => library.byId(props.id))
const meta = computed(() => library.meta[props.id])
const language = computed(() => library.languageOf[props.id])

const adultMasked = computed(() => isAdultWork(meta.value) && !settings.settings.showAdultCovers)
const coverSrc = computed(() => (meta.value?.coverUrl && !coverBroken.value ? meta.value.coverUrl : undefined))
const iconSrc = computed(() => (!iconBroken.value ? iconUrl(game.value?.iconPath) : undefined))
const src = computed(() => (adultMasked.value ? iconSrc.value : coverSrc.value ?? iconSrc.value))
const placeholder = computed(() => (game.value?.gameTitle ?? '').trim().slice(0, 1).toUpperCase() || '?')

/** 标题：优先用用户库里的标题（用户可能改过），不给 DLsite 原值抢位。 */
const title = computed(() => game.value?.gameTitle ?? '')

/** 「作品信息」表（顺序固定；拿不到的项 value=undefined，UI 明说「暂无」）。 */
const fields = computed(() => buildDetailFields(meta.value))

/** 键 → i18n 标签（模板里不查动态键，避免写复杂表达式）。 */
const FIELD_LABELS: Record<string, string> = {
  rj: 'detail.fieldRj',
  circle: 'detail.fieldCircle',
  series: 'detail.fieldSeries',
  released: 'detail.fieldReleased',
  type: 'detail.fieldType',
  price: 'detail.fieldPrice',
  sales: 'detail.fieldSales',
  rating: 'detail.fieldRating',
  author: 'detail.staffAuthor'
}

/** 简介：只认清洗过的 summary（`description` 带站点广告尾巴，绝不渲染）。 */
const summary = computed(() => meta.value?.summary?.trim() || '')
const summaryCollapsible = computed(() => summaryNeedsCollapse(summary.value))

/** 「重新获取元数据」能否点（没有 RJ 就无从重拉）。 */
const refreshable = computed(() => canRefreshMeta(meta.value))

/** 作品类型的中文名（不认识的代码退回原代码，不假装翻译过）。 */
const workTypeLabel = computed(() => {
  const code = meta.value?.workType?.trim().toUpperCase()
  if (!code) return ''
  const suffix = workTypeI18nSuffix(code)
  if (!suffix) return code
  return t(`detail.workType.${suffix}`)
})

/** 价格 / 销量 / 评分的展示串（各自独立，缺失时为空串）。 */
const priceText = computed(() => formatPrice(meta.value))
const salesText = computed(() => formatSales(meta.value?.salesCount))
const ratingText = computed(() => formatRating(meta.value?.rating))

/** DLsite 作品页地址（在浏览器打开）。RJ 是唯一稳定标识。 */
const dlsiteUrl = computed(() => {
  const rj = meta.value?.rj?.trim()
  if (!rj) return ''
  const section = meta.value?.category?.trim() || 'homepro'
  return `https://www.dlsite.com/${section}/work/=/product_id/${rj}.html`
})

/** 该条目识别出的语言（如「中文」）。没识别出来就什么都不标。 */
const languageLabel = computed(() => (language.value ? languageShortName(language.value) : ''))

// ===== M3.5：运行状态（唯一来源是主进程的进程表，D50）=====

/** 这个游戏是否正在运行。 */
const runningNow = computed(() => library.isRunning(props.id))

/**
 * 「已运行 12 分钟」里的那个时长文案。
 *
 * 注意：这里读 `runningSince` 是为了让 computed 依赖它、从而**每秒重算**——
 * 如果只依赖 `library.running[props.id].startedAt`，进程启动后文本就再也不变了。
 */
const runningDurationText = computed(() => {
  if (!runningNow.value) return ''
  const startedAt = library.running[props.id]?.startedAt
  if (!startedAt) return ''
  const start = Date.parse(startedAt)
  if (Number.isNaN(start)) return ''
  const seconds = Math.max(0, Math.floor((runningSince.value - start) / 1000))
  return formatDuration(seconds)
})
// ===== M5.0 N1：游玩时间统计（放在启动按钮下方）=====

/**
 * 这个游戏的游玩记录（没有就是 undefined → 显示「暂无记录」）。
 *
 * 数据来源是 snapshot 里的 playStats（主进程读 play-stats.json，D51）。
 * 渲染层**绝不自己累加**：关掉应用再开就对不上了（那也是 D50 的同一精神）。
 */
const playTime = computed(() => playTimeView(library.playStats[props.id]))

/**
 * 时长文案。这里把 DurationShape 套上 i18n 键 ——
 * **结构判断在 shared/play-time.ts（有单测），文案进 locales**（协作规矩 2）。
 *
 * 余分为 0 时不显示「X 小时 0 分钟」：那个 "0 分钟" 是噪音。
 */
const playDurationText = computed(() => {
  const view = playTime.value
  if (view.kind !== 'stats') return ''
  const shape = view.duration
  if (shape.unit === 'seconds') return t('library.runningSeconds', { seconds: shape.seconds })
  if (shape.unit === 'minutes') return t('library.runningMinutes', { minutes: shape.minutes })
  return shape.minutes > 0
    ? t('library.runningHoursMinutes', { hours: shape.hours, minutes: shape.minutes })
    : t('library.runningHours', { hours: shape.hours })
})

/** 「玩过 N 次」；N 为 0 时返回空串（不画一个「玩过 0 次」出来）。 */
const playCountText = computed(() => {
  const view = playTime.value
  if (view.kind !== 'stats' || view.playCount <= 0) return ''
  return t('detail.playCount', { count: view.playCount })
})

/**
 * 「最后游玩」那一句。
 *
 * 用 `toLocaleString()` 而不是自己拼：日期格式跟着系统区域走才是对的。
 * 但**必须先判它能不能解析**（hasValidPlayedAt）—— 否则坏数据会画出英文
 * "Invalid Date"（`new Date('').toLocaleString()` 就是这个结果）。
 */
const lastPlayedText = computed(() => {
  const view = playTime.value
  if (view.kind !== 'stats' || !hasValidPlayedAt(view.lastPlayedAt)) return ''
  return t('detail.lastPlayed', { at: new Date(view.lastPlayedAt).toLocaleString() })
})

/** 同组其他语言版本（用于「也有 xx 版」）。 */const alternateText = computed(() => {
  const alternates = (library.alternatesOf[props.id] ?? []).filter((item) => item.lang !== language.value)
  if (alternates.length === 0) return ''
  const langs = [...new Set(alternates.map((item) => item.lang))]
  return langs.map((lang) => languageShortName(lang)).join(' / ')
})

/** 字段展示值：拿不到时统一显示「暂无」（D37：不假装）。合并价格/评分等格式化值。 */
function fieldValue(key: string, value: string | undefined): string {
  if (key === 'price' && value) return t('detail.priceYen', { price: value })
  if (key === 'rating' && value) return t('detail.ratingOutOfFive', { rating: value })
  return value ?? ''
}

/** 该字段是否拿到了值（模板据此决定显示值还是「暂无」）。 */
function hasValue(value: string | undefined): boolean {
  return !!value
}

/**
 * 秒 → 「12 分钟 / 3 小时 5 分钟 / 45 秒」。
 *
 * 用普通拼接而不是 ICU 复数（AGENTS.md 的已知坑：文案里写 ICU 会让组件白屏）。
 * 这里的数字与单位之间不加空格，中文本来也不加。
 */
function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return t('library.runningSeconds', { seconds: totalSeconds })
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return t('library.runningMinutes', { minutes })
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest > 0
    ? t('library.runningHoursMinutes', { hours, minutes: rest })
    : t('library.runningHours', { hours })
}

/** 换了游戏就重置所有视图状态（否则上一个游戏的封面失败标记会残留）。 */
watch(
  () => props.id,
  () => {
    coverBroken.value = false
    iconBroken.value = false
    summaryExpanded.value = false
    diagnosisOpen.value = false
    diagnosisItems.value = []
    stopping.value = false
    runningSince.value = Date.now()
    // 进详情页时立刻对一次运行态（用户可能是从外面启动的，或退回本页）
    void library.refreshRunning()
  },
  { immediate: true }
)

/**
 * M3.5：运行时每秒刷新一次「已运行多久」。
 *
 * 只在这一页跑，且卸载时清掉——常驻的 setInterval 在渲染层白白烧 CPU，
 * 而这个文案只在详情页可见。
 */
function startRunningTicker(): void {
  stopRunningTicker()
  runningTimer = setInterval(() => {
    runningSince.value = Date.now()
  }, 1_000)
}

function stopRunningTicker(): void {
  if (runningTimer) {
    clearInterval(runningTimer)
    runningTimer = null
  }
}

onMounted(startRunningTicker)
onBeforeUnmount(stopRunningTicker)

function onImageError(): void {
  if (coverBroken.value) iconBroken.value = true
  else coverBroken.value = true
}

function backToLibrary(): void {
  void router.push('/library')
}

function toEdit(): void {
  void router.push(`/game/${props.id}/edit`)
}

function toggleSummary(): void {
  summaryExpanded.value = !summaryExpanded.value
}

/**
 * 用系统浏览器打开 DLsite 作品页。
 * 主进程已有 openExternal 的白名单（只允许 https），这里只传地址。
 */
async function openOnDlsite(): Promise<void> {
  if (!dlsiteUrl.value) return
  try {
    await api.openExternal(dlsiteUrl.value)
  } catch (error) {
    ElMessage.error(translateError(error, t))
  }
}

/**
 * 重新获取元数据（三点菜单那条能力在这里也有，因为详情页也该能就地刷新）。
 * 老数据的 author/salesCount/rating 只能靠这一步补（§9 R2：不自动全库重拉）。
 */
async function refreshMeta(): Promise<void> {
  if (!refreshable.value || refreshing.value) return
  refreshing.value = true
  try {
    await library.refreshGameMeta(props.id, true)
    ElMessage.success(t('detail.refreshDone'))
  } catch (error) {
    ElMessage.error(translateError(error, t))
  } finally {
    refreshing.value = false
  }
}

// ===== 启动（从 LibraryPage 整体搬来，逻辑一字不改）=====

/**
 * 启动游戏。**本页是唯一的启动入口**（D38）。
 *
 * 三条不能越界的规矩（M2.5-C §C.5）：
 * 1. **不自动改用户的选择**：用户点的是哪个就启动哪个——除非他明确点了「启动偏好版本」；
 * 2. **绝不删除/隐藏**其他语言版（那是用户数据，§C.5 明令不代删）；
 * 3. 设置里关掉提示时**直接启动**，不问。
 */
async function launch(): Promise<void> {
  await launchTarget(props.id, true)
}

/**
 * 启动流程（M3 §4.2）。
 *
 * `diagnoseAllowed` 的意义：**只有第一次启动**才拦 fatal 诊断。
 * 用户在诊断框里点「还是启动试试」后，`proceed` 会带 `false` 再来一次——
 * 那次绝不重复诊断（否则绕过按钮等于没用，§9 R5）。
 */
async function launchTarget(id: string, diagnoseAllowed: boolean): Promise<void> {
  const gameRecord = library.byId(id)
  const target = await resolveLaunchTarget(id)
  try {
    const result = await library.launch(target, diagnoseAllowed)
    if ('blocked' in result) {
      // 被 fatal 诊断拦下 → 弹中文诊断框，**不出现英文报错**
      diagnosisItems.value = result.diagnoses
      diagnosisOpen.value = true
      return
    }
    const targetGame = library.byId(target)
    ElMessage.success(t('library.launchSent', { title: targetGame?.gameTitle ?? gameRecord?.gameTitle ?? '' }))
  } catch (error) {
    ElMessage.error(translateError(error, t))
  }
}

/**
 * 用户在诊断框里点了「还是启动试试」。
 * 用 `diagnoseAllowed=false` 重走一次：诊断框已经看过了，不能再拦一次（§9 R5）。
 */
async function launchAnyway(): Promise<void> {
  diagnosisOpen.value = false
  await launchTarget(props.id, false)
}

/**
 * M3.5：关闭游戏（SIGTERM → 5s → SIGKILL，D52）。
 *
 * 成功后**不**手动把 running 抹掉：`gameExited` 事件是唯一可信信号。
 * 但如果进程早就没了、主进程报「未运行」，这里要把本地的陈旧状态清一下
 * ——否则 UI 会一直显示「运行中」而按关闭没反应。
 */
async function stopGame(): Promise<void> {
  if (stopping.value) return
  stopping.value = true
  try {
    const result = await library.stopGame(props.id)
    ElMessage.success(t(result.messageKey))
  } catch (error) {
    ElMessage.error(translateError(error, t))
    // 目标其实没在跑 / 号被别的进程占用 → 主进程已清掉脏记录，这里同步一次
    await library.refreshRunning()
  } finally {
    stopping.value = false
  }
}

/**
 * 决定最终要启动哪个 id（§C.5）。返回原 id 表示「按用户点的那个启动」。
 * 判定逻辑抽在 shared/launch-language.ts（纯函数、有单测），这里只负责取数据 → 问用户 → 返回结果。
 */
async function resolveLaunchTarget(id: string): Promise<string> {
  const prefs = settings.settings
  const decision = decideLaunchTarget({
    current: library.languageOf[id],
    alternates: library.alternatesOf[id] ?? [],
    preferred: prefs.preferredLanguage,
    fallback: prefs.fallbackLanguage,
    prompt: prefs.languageSwitchPrompt
  })
  if (decision.action === 'launch' || !decision.targetId) return id

  const current = library.languageOf[id]
  const targetGame = library.byId(decision.targetId)
  const targetLang = library.languageOf[decision.targetId]
  try {
    // 「不再询问」是设置页的开关（D30）：放设置页用户随时能重新打开。
    await ElMessageBox.confirm(
      t('library.languageSwitchMessage', {
        current: current ? languageShortName(current) : '',
        preferred: targetLang ? languageShortName(targetLang) : '',
        title: targetGame?.gameTitle ?? decision.targetId
      }),
      t('library.languageSwitchTitle'),
      {
        type: 'info',
        confirmButtonText: t('library.launchPreferred', { lang: targetLang ? languageShortName(targetLang) : '' }),
        cancelButtonText: t('library.launchCurrent')
      }
    )
    return decision.targetId
  } catch {
    // 取消 = 坚持启动当前这个（用户的选择优先，绝不自作主张）
    return id
  }
}
</script>

<template>
  <div v-if="!game" class="empty-state">
    <div class="empty-state-title">{{ t('common.empty') }}</div>
    <el-button @click="backToLibrary">{{ t('detail.backToLibrary') }}</el-button>
  </div>

  <template v-else>
    <header class="detail-header">
      <el-button text :icon="ArrowLeft" @click="backToLibrary">{{ t('detail.backToLibrary') }}</el-button>
      <div class="toolbar-spacer" />
      <el-button :icon="Refresh" :loading="refreshing" :disabled="!refreshable" @click="refreshMeta">
        {{ t('common.refreshMeta') }}
      </el-button>
      <el-button type="primary" plain @click="toEdit">{{ t('detail.edit') }}</el-button>
    </header>

    <div class="detail-layout">
      <!-- 左栏：封面 + 启动按钮（D38：启动只在这里） -->
      <div class="detail-cover-col">
        <div class="detail-cover">
          <img v-if="src && !adultMasked" :src="src" :alt="title" @error="onImageError" />
          <div v-else-if="src" class="detail-cover-masked">
            <img :src="src" :alt="title" @error="onImageError" />
            <div class="detail-cover-masked-label">{{ t('dlsite.adultCoverHidden') }}</div>
          </div>
          <span v-else class="detail-cover-placeholder">{{ placeholder }}</span>
        </div>

        <!-- M3.5 §7.1：未运行 → 启动按钮；运行中 → 运行态 + 关闭游戏 -->
        <template v-if="runningNow">
          <div class="detail-running">
            <span class="detail-running-dot" aria-hidden="true" />
            <span class="detail-running-text">
              {{ t('library.runningSince', { duration: runningDurationText }) }}
            </span>
          </div>
          <el-button class="detail-launch" :loading="stopping" @click="stopGame">
            {{ t('library.stopGame') }}
          </el-button>
        </template>
        <el-button v-else class="detail-launch" type="primary" size="large" @click="launch">
          {{ t('detail.launch') }}
        </el-button>

        <!-- M5.0 N1：游玩时间统计（用户要求放在启动按钮下方）。
             没有记录时明说「暂无」而不是显示 0 —— 一个假的「0 分钟」看起来像真统计，
             用户会以为自己的历史被清空了（D37 的同一精神）。 -->
        <div class="detail-playtime">
          <div class="detail-playtime-title">{{ t('detail.playTime') }}</div>
          <div v-if="playTime.kind === 'none'" class="detail-playtime-empty">
            {{ t('detail.playTimeEmpty') }}
          </div>
          <template v-else>
            <div class="detail-playtime-main">
              <span class="detail-playtime-duration">{{ playDurationText }}</span>
              <span v-if="playCountText" class="detail-playtime-count"> · {{ playCountText }}</span>
            </div>
            <div v-if="lastPlayedText" class="detail-playtime-last">{{ lastPlayedText }}</div>
          </template>
        </div>

        <div v-if="languageLabel || alternateText" class="detail-lang">
          <el-tag v-if="languageLabel" size="small">{{ languageLabel }}</el-tag>
          <el-tag v-if="alternateText" size="small" type="info">
            {{ t('library.alsoHas', { langs: alternateText }) }}
          </el-tag>
        </div>
      </div>

      <!-- 右栏：标题 / 元数据 / 简介 / 标签 / 制作 / RJ -->
      <div class="detail-main-col">
        <h1 class="detail-title">{{ title }}</h1>
        <div class="detail-subline">
          <span v-if="meta?.circle">{{ meta.circle }}</span>
          <span v-if="meta?.circle && meta?.seriesName"> · </span>
          <span v-if="meta?.seriesName">{{ t('detail.fieldSeries') }}：{{ meta.seriesName }}</span>
        </div>
        <div class="detail-subline">
          <span v-if="meta?.registDate">{{ meta.registDate }}</span>
          <template v-if="priceText"><span v-if="meta?.registDate"> · </span>{{ t('detail.priceYen', { price: priceText }) }}</template>
          <template v-if="workTypeLabel"> · {{ workTypeLabel }}</template>
        </div>

        <!-- 简介（清洗版，可展开）。没有就明说「暂无」（D37）。 -->
        <section class="detail-section">
          <h2 class="detail-section-title">{{ t('detail.summary') }}</h2>
          <template v-if="summary">
            <div class="detail-summary" :class="{ 'is-collapsed': summaryCollapsible && !summaryExpanded }">
              {{ summary }}
            </div>
            <el-button v-if="summaryCollapsible" text size="small" @click="toggleSummary">
              <el-icon><Top v-if="summaryExpanded" /><Bottom v-else /></el-icon>
              {{ summaryExpanded ? t('detail.collapseSummary') : t('detail.expandSummary') }}
            </el-button>
          </template>
          <div v-else class="detail-missing">{{ t('detail.noSummary') }}</div>
        </section>

        <!-- 标签：**实测拿不到**（D37：不建空字段，明说 DLsite 不提供） -->
        <section class="detail-section">
          <h2 class="detail-section-title">{{ t('detail.tags') }}</h2>
          <div class="detail-missing">{{ t('detail.noTags') }}</div>
        </section>

        <!-- 制作人员：**实测拿不到**（作品情報不在返回的 HTML 里） -->
        <section class="detail-section">
          <h2 class="detail-section-title">{{ t('detail.credits') }}</h2>
          <div v-if="meta?.author" class="detail-info-row">
            <span class="detail-info-key">{{ t('detail.staffAuthor') }}</span>
            <span class="detail-info-value">{{ meta.author }}</span>
          </div>
          <div class="detail-missing">{{ t('detail.noCredits') }}</div>
        </section>

        <!-- 作品信息表（顺序固定；拿不到的项明说「暂无」） -->
        <section class="detail-section">
          <h2 class="detail-section-title">{{ t('detail.info') }}</h2>
          <div v-if="!meta" class="detail-missing">{{ t('detail.metaMissing') }}</div>
          <template v-else>
            <div v-for="field in fields" :key="field.key" class="detail-info-row">
              <span class="detail-info-key">{{ t(FIELD_LABELS[field.key]) }}</span>
              <span v-if="hasValue(field.value)" class="detail-info-value">
                {{ fieldValue(field.key, field.value) }}
              </span>
              <span v-else class="detail-info-value is-missing">{{ t('detail.noValue') }}</span>
            </div>
            <el-button v-if="dlsiteUrl" text size="small" @click="openOnDlsite">
              {{ t('detail.openOnDlsite') }}
            </el-button>
          </template>
        </section>
      </div>
    </div>

    <!-- M3 §4.2：启动诊断框（被 fatal 拦下时出现；不出现英文报错） -->
    <DiagnosisDialog
      v-model="diagnosisOpen"
      :game-id="id"
      :diagnoses="diagnosisItems"
      @proceed="launchAnyway"
    />
  </template>
</template>
