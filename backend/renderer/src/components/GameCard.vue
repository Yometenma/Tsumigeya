<script setup lang="ts">
// 游戏卡片 / 列表行两种形态（M2.6 §5.1 重写）。
//
// M2.6 的核心改动（用户 2026-11-04 拍板，D36–D38）：
// ① **卡片上没有启动按钮**——点卡片任意位置 = 进详情页，启动只在详情页（D38）；
// ② 卡片右上角只有三点菜单：编辑 / 重新获取元数据 / 删除（@click.stop 防止误进详情）；
// ③ 封面**保持 4:3 横版**（D36：源图 560×420，套 2:3 会左右各裁约 40%）；
// ④ 信息密度靠「简介 2 行 + 作品类型 + 语言标记」提上去（U1），不靠改宽高比。
//
// 取值逻辑全部走 shared/gamecard-info.ts 的纯函数（有单测），模板里只贴标签：
// 那里有一条硬规矩——**没有就不画那一行**，绝不填空串冒充有内容。
//
// ⚠️ 模板禁 TS 类型断言（会白屏）；所有 ref/computed 都声明在任何 watch 之前（TDZ 白屏）。
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { MoreFilled } from '@element-plus/icons-vue'
import { iconUrl, type GameLanguage, type GameMeta, type GameRecord } from '@/api/client'
import { isAdultWork } from '../../../shared/age-rating'
import { GAME_LANGUAGES, languageShortName } from '../../../shared/game-language'
import { buildCardInfo, canRefreshMeta, workTypeI18nSuffix } from '../../../shared/gamecard-info'
import { useSettingsStore } from '@/stores/settings'

const props = defineProps<{
  game: GameRecord
  variant: 'card' | 'row'
  /** M2：DLsite 元数据（可选，没有就走原来的本地图标）。 */
  meta?: GameMeta
  /** M2.5-C：该游戏识别出的语言（没有则不显示语言标记）。 */
  language?: GameLanguage
  /** M2.5-C：同组的其他语言版本（用于「也有 zh 版」提示）。 */
  alternates?: Array<{ lang: GameLanguage }>
  /**
   * M3.5：该游戏是否正在运行（画一个绿点，**不给关闭按钮**）。
   * 卡片空间有限，且 D41 的精神是「卡片是浏览入口不是操作面」。
   */
  running?: boolean
}>()

const emit = defineEmits<{
  /** M2.6：点卡片 → 进详情页（**不是启动**）。 */
  open: [id: string]
  edit: [id: string]
  /** M2.6：三点菜单的「重新获取元数据」（等同编辑页原来的「刷新」）。 */
  refresh: [id: string]
  remove: [id: string]
}>()

const { t } = useI18n()
const settings = useSettingsStore()

/** 远程封面加载失败（防盗链 / 引用过期 / 网络问题）——很常见，必须优雅降级。 */
const coverBroken = ref(false)
/** 本地图标加载失败（路径存在但文件坏掉）。 */
const iconBroken = ref(false)

/**
 * R18 封面打码。**只影响渲染，数据照常抓取并保存**（设置里关掉开关后立即可见）。
 * 判定依据是 DLsite 的 section（maniax / books），见 shared/age-rating.ts。
 */
const adultMasked = computed(() => isAdultWork(props.meta) && !settings.settings.showAdultCovers)

const coverSrc = computed(() => (props.meta?.coverUrl && !coverBroken.value ? props.meta.coverUrl : undefined))
const iconSrc = computed(() => (!iconBroken.value ? iconUrl(props.game.iconPath) : undefined))
/** 最终显示哪一张：封面 → 本地图标 → 无。打码时不显示封面，直接退到本地图标。 */
const src = computed(() => (adultMasked.value ? iconSrc.value : coverSrc.value ?? iconSrc.value))

const tags = computed(() => (props.game.tags ?? []).filter((tag) => tag.trim()))
const placeholder = computed(() => props.game.gameTitle.trim().slice(0, 1).toUpperCase() || '?')

/**
 * M2.5-C：该游戏自身的语言标记（如「中文」）。
 * 只在识别出语言时显示——没识别出来就什么都不标（绝不瞎猜，§C.2）。
 */
const ownLanguageLabel = computed(() => (props.language ? languageShortName(props.language) : ''))

/**
 * M2.5-C：「也有 zh 版」提示。
 * 组内其他语言版本的语言名（去重、按固定顺序），例如本条目是 ja、组里还有 zh → 「也有 中文 版」。
 */
const alternateLanguages = computed(() => {
  // ⚠️ 只保留**与自身不同**的语言：组里可能有两个中文版（重复安装），
  // 中文版提示「也有中文版」是废话，属于实测发现的 UI 瑕疵。
  const langs = (props.alternates ?? []).map((item) => item.lang).filter((lang) => lang !== props.language)
  if (langs.length === 0) return []
  // 去重 + 按 GAME_LANGUAGES 的固定顺序（避免渲染顺序随数据抖动）
  return [...new Set(langs)].sort((a, b) => GAME_LANGUAGES.indexOf(a) - GAME_LANGUAGES.indexOf(b))
})

/** 把语言列表拼成「中文 / 英文」这样的展示串（模板里不写复杂表达式）。 */
const alternateText = computed(() => alternateLanguages.value.map((lang) => languageShortName(lang)).join(' / '))

/** M2.6：卡片要渲染的那几项，全部由纯函数给出（没有的项是 undefined，模板据此不画）。 */
const info = computed(() =>
  buildCardInfo({
    gameTitle: props.game.gameTitle,
    gameEngine: props.game.gameEngine,
    meta: props.meta,
    languageLabel: ownLanguageLabel.value,
    alternateLabel: alternateLanguages.value.length ? alternateText.value : undefined
  })
)

/**
 * 作品类型的展示文案。
 * 认识的代码走 i18n（`detail.workType.SOU`）；**不认识的代码退回原代码**——不假装翻译过。
 */
const workTypeLabel = computed(() => {
  const code = info.value.workType
  if (!code) return ''
  const suffix = workTypeI18nSuffix(code)
  if (!suffix) return code
  return t(`detail.workType.${suffix}`)
})

/** 「重新获取元数据」能否用：按已存的 RJ 重拉，没有 RJ 就无从拉取。 */
const refreshable = computed(() => canRefreshMeta(props.meta))

/** 换了游戏或换了封面地址就重置失败标记，否则改了元数据还显示占位。 */
watch(
  () => [props.game.id, props.meta?.coverUrl] as const,
  () => {
    coverBroken.value = false
    iconBroken.value = false
  }
)

/** 封面 404 时退到本地图标；本地图标也坏掉才显示字母。 */
function onImageError(): void {
  if (coverBroken.value) iconBroken.value = true
  else coverBroken.value = true
}

/** 点卡片主体 → 进详情页。三点菜单自己 stop，不会走到这里（R4：防误触）。 */
function openDetail(): void {
  emit('open', props.game.id)
}

/**
 * 三点菜单的命令分发。
 * command 的类型写在函数签名里（模板里只传字符串常量，不写断言——AGENTS.md「模板禁 TS 断言」）。
 */
function onMenuCommand(command: string): void {
  if (command === 'edit') emit('edit', props.game.id)
  else if (command === 'refresh') emit('refresh', props.game.id)
  else if (command === 'remove') emit('remove', props.game.id)
}
</script>

<template>
  <article v-if="variant === 'card'" class="game-card" @click="openDetail">
    <div class="game-card-cover">
      <img v-if="src" :src="src" :alt="game.gameTitle" @error="onImageError" />
      <span v-else class="game-card-placeholder">{{ placeholder }}</span>
      <div v-if="adultMasked" class="game-card-cover-hint">{{ t('dlsite.adultCoverHidden') }}</div>
      <div v-else-if="!coverSrc && meta" class="game-card-cover-hint">{{ t('dlsite.coverMissing') }}</div>

      <!-- M2.6：三点菜单（右上角浮层）。@click.stop 必须留在这一层，
           否则点它等于点卡片，会被带进详情页（R4）。 -->
      <!-- M3.5 §7.2：运行中的卡片加一个绿点（**不放关闭按钮**，D41 的精神）。 -->
      <div v-if="running" class="game-card-running" :title="t('library.runningBadge')">
        <span class="game-card-running-dot" aria-hidden="true" />
      </div>

      <div class="game-card-menu" @click.stop>
        <el-dropdown trigger="click" placement="bottom-end" @command="onMenuCommand">
          <span class="game-card-menu-trigger" :title="t('library.moreActions')">
            <el-icon><MoreFilled /></el-icon>
          </span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="edit">{{ t('common.editMeta') }}</el-dropdown-item>
              <el-dropdown-item command="refresh" :disabled="!refreshable">
                {{ t('common.refreshMeta') }}
              </el-dropdown-item>
              <el-dropdown-item command="remove" divided>{{ t('common.deleteGame') }}</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </div>
    </div>

    <div class="game-card-body">
      <div class="game-card-title" :title="game.gameTitle">{{ game.gameTitle }}</div>
      <div class="game-card-meta" :class="{ 'is-engine': !info.hasCircle }" :title="info.subtitle">
        {{ info.subtitle }}
      </div>
      <div v-if="info.releasedAt" class="game-card-meta">{{ info.releasedAt }}</div>

      <!-- M2.6 U1：简介前 2 行。**没有简介就整行不画**（不留空白，§5.1 空数据表现）。 -->
      <div v-if="info.summary" class="game-card-summary" :title="info.summary">{{ info.summary }}</div>

      <!-- 作品类型 + 语言标记。都没有时整块不画（卡片上不显示「暂无标签」，§5.1）。 -->
      <div v-if="workTypeLabel || info.languageLabel || info.alternateLabel" class="game-card-tags">
        <el-tag v-if="workTypeLabel" size="small" type="info">{{ workTypeLabel }}</el-tag>
        <el-tag v-if="info.languageLabel" size="small">{{ info.languageLabel }}</el-tag>
        <el-tag v-if="info.alternateLabel" size="small" type="info">
          {{ t('library.alsoHas', { langs: info.alternateLabel }) }}
        </el-tag>
      </div>
    </div>
  </article>

  <div v-else class="game-row" @click="openDetail">
    <div class="game-row-icon">
      <img v-if="src" :src="src" :alt="game.gameTitle" @error="onImageError" />
      <span v-else>{{ placeholder }}</span>
    </div>
    <div class="game-row-main">
      <div class="game-row-title" :title="game.gameTitle">{{ game.gameTitle }}</div>
      <div class="game-row-meta">
        {{ info.subtitle }}
        <template v-if="tags.length"> · {{ tags.join(' / ') }}</template>
        <template v-if="workTypeLabel"> · {{ workTypeLabel }}</template>
      </div>
      <!-- M2.5-C：语言标记 + 「也有 zh 版」 -->
      <div v-if="info.languageLabel || info.alternateLabel" class="game-row-lang">
        <el-tag v-if="info.languageLabel" size="small">{{ info.languageLabel }}</el-tag>
        <el-tag v-if="info.alternateLabel" size="small" type="info">
          {{ t('library.alsoHas', { langs: info.alternateLabel }) }}
        </el-tag>
      </div>
    </div>
    <!-- M2.6：列表行同样只有三点菜单，没有启动按钮（D38）。 -->
    <div class="game-row-actions" @click.stop>
      <el-dropdown trigger="click" placement="bottom-end" @command="onMenuCommand">
        <span class="game-card-menu-trigger" :title="t('library.moreActions')">
          <el-icon><MoreFilled /></el-icon>
        </span>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="edit">{{ t('common.editMeta') }}</el-dropdown-item>
            <el-dropdown-item command="refresh" :disabled="!refreshable">
              {{ t('common.refreshMeta') }}
            </el-dropdown-item>
            <el-dropdown-item command="remove" divided>{{ t('common.deleteGame') }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>
  </div>
</template>
