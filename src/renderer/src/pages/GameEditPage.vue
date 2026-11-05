<script setup lang="ts">
// 编辑 / 新建游戏（§4 GameEditPage.vue）。
//
// ===== M5.0 S11（U8）之后：这里只是**容器** =====
//
// 用户原话：「感觉你是每次有新功能都是直接一股脑往后面塞，而没有好好让他们协调一下」。
// 原来这个文件有 1109 行、5 个 `<section>`。现在拆成 5 个组件 + 一个 293 行的容器：
//
//   GameInfoForm.vue          游戏身份（封面 + 标题 + RJ + 搜索 + 字段）← 也与向导共用
//   GameLocalSection.vue      本地信息（路径 + 引擎）
//   GameTagsSection.vue       分类与标签（含图标兜底）
//   GameEngineArgsSection.vue 引擎参数（折叠、高级）
//   GameDiagnosisSection.vue  启动诊断（折叠）
//
// 容器只负责：路由/保存/表单状态（title/path/engine/tags/iconPath/gameArgs）
// 与「唯一的保存」（游戏本体 + DLsite 元数据一起提交）。
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import GameInfoForm from '@/components/GameInfoForm.vue'
import GameLocalSection from '@/components/GameLocalSection.vue'
import GameTagsSection from '@/components/GameTagsSection.vue'
import GameEngineArgsSection from '@/components/GameEngineArgsSection.vue'
import GameDiagnosisSection from '@/components/GameDiagnosisSection.vue'
import VersionManagerDialog from '@/components/VersionManagerDialog.vue'
import {
  translateError,
  type DlsiteWork,
  type GameArgDef
} from '@/api/client'
import { toPlain } from '../../../shared/plain'
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

/**
 * 「管理版本」对话框的入口（引擎参数里的多版本项才有，当前只有 nwjs）。
 *
 * M5.0 S11：引擎参数区块已拆成 `GameEngineArgsSection`，但对话框本身留在这里 ——
 * 它是**页面级**模态（一个页面只该有一个实例，放进区块里会导致每个区块各持一份状态）。
 */
function manageVersions(argKey: string, definition: GameArgDef): void {
  versionArgKey.value = argKey
  versionDef.value = definition
  versionDialog.value = true
}

/**
 * M5.0 S11（U8）：DLsite 元数据的暂存。
 *
 * ===== 这一步解决的是用户点名的痛点 ① =====
 *
 * 原话：「保存都还需要 dlsite 信息卡片里面保存一次，整个编辑页面再保存一次」
 *
 * 原来 DLsite 面板是**自己一套保存**（走 saveGameMeta），主表单另一套（saveGame）——
 * 两个按钮做一件事。现在整个页面**只有一个保存**：
 *
 *   · 游戏本体（games.json）  → `library.saveGame`
 *   · DLsite 元数据（旁挂）   → `library.saveGameMeta`
 *
 * 两者在下面 `save()` 里一起提交。
 *
 * ===== 为什么能这么做 =====
 *
 * 靠 S10 抽出的 `GameInfoForm` 的 **staged 模式**：编辑页现在**不传 game-id**
 * （虽然游戏已存在），于是组件把查询/字段编辑都收在内存里，
 * 通过 `stage-change` 交给这里；`initialMeta` 把库里已存的那份带进来做初值。
 *
 * 这是有意的复用：同一个模式既服务"游戏还没有 id"的向导，也服务"全页一个保存"的编辑页。
 */
const stagedMeta = ref<DlsiteWork | null>(null)
/** 表单实例（取「该提交的那份」）。 */
const infoForm = ref<InstanceType<typeof GameInfoForm> | null>(null)

/** 库里已存的 DLsite 元数据（作为组件的初值）。 */
const savedMeta = computed(() => (gameId.value ? library.meta[gameId.value] : undefined))

/** 组件报上来的暂存元数据。 */
function onStageChange(work: DlsiteWork | null): void {
  stagedMeta.value = work
}

// ===== M3：启动诊断面板（§6 文件清单：GameEditPage 的「启动诊断」面板）=====
//
// ⚠️ 同一条 TDZ 规矩：这些 ref 必须声明在 fill() 之前。
// 面板与自动诊断**共用同一份数据源**（diagnoseGame），区别只是触发时机：
//   · 启动时由 launch 自动跑（用户被动看到对话框）
//   · 这里由用户手动点「重新诊断」（编辑完路径/引擎后想看一眼）
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

// ===== M5.0 S11（U8）：唯一的保存 =====

/**
 * 保存游戏本体 + DLsite 元数据（**一次点击，两件一起**）。
 *
 * 这是用户点名的痛点：「保存都还需要 dlsite 信息卡片里面保存一次，
 * 整个编辑页面再保存一次」。现在只有一个按钮、一次提交。
 *
 * ⚠️ 顺序与容错：
 *   ① `saveGame` 先（它生成本体与 id；失败就是真失败，直接报错）
 *   ② `saveGameMeta` 后（挂 gameId）
 *   ③ 元数据失败**不回滚游戏**——游戏本体是主数据，丢一次元数据不该让用户重填整页；
 *      单独提示「可再点一次保存」即可（那时本体已存在，重试没有副作用）
 *
 * ⚠️ 全部走 `toPlain()`：gameArgs 来自 DynamicArgsForm 的双向绑定，
 * 是 reactive 代理树；直接传会撞 "An object could not be cloned."（D44，踩过两次）。
 */
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
      gameArgs: toPlain(gameArgs.value)
    })

    // 新建时会多出一条记录 —— 记下它的 id，好让「保存后回详情页」有页面可回
    if (!gameId.value) {
      const added = library.games.find((item) => !before.has(item.id))
      newlySavedId.value = added?.id
    }

    // ② 元数据：与本体一起提交（这是"保存合一"的实质）
    const targetId = gameId.value ?? newlySavedId.value
    const work = infoForm.value?.stagedMeta() ?? stagedMeta.value
    if (targetId && work) {
      try {
        await library.saveGameMeta(targetId, toPlain(work))
      } catch (error) {
        // 游戏已存好，元数据单独失败：提示、不阻断（用户可以再点一次保存）
        console.warn(`[tsumigeya] 保存 DLsite 元数据失败：${(error as Error).message}`)
        ElMessage.warning(t('game.metaSaveFailed'))
      }
    }

    ElMessage.success(t('game.saved'))
    // M2.6 §5.3：保存后回**详情页**（用户改完元数据，最想看到的就是改完的样子）
    goBack()
  } catch (error) {
    ElMessage.error(translateError(error, t))
  } finally {
    saving.value = false
  }
}

/**
 * M2.6 §5.3：编辑页的「返回」回**详情页**而不是库页。
 * 新建流程没有详情页可回，仍然回库页。
 */
function goBack(): void {
  const id = gameId.value ?? newlySavedId.value
  if (id && library.byId(id)) void router.push(`/game/${id}`)
  else void router.push('/library')
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


    <!-- ===== M2.7：封面与标签（合并原来分散的「标签」与「图标」两个区块）===== -->


    <!-- M3：启动诊断面板（§4.2 / §6）。与自动诊断共用同一份数据源，这里是手动刷新入口。 -->

    <!-- ===== M5.0 S10（U7）：游戏信息表单（编辑页与添加向导**共用**同一个组件）=====
         原来这三块（标题来源提示 / 封面预览 / DLsite 面板）是一长段只属于本页的代码，
         向导那边只能自己再写一套「完善信息」，于是两处越来越像两个产品 ——
         正是用户说的「好割裂」。抽成 GameInfoForm.vue 后两处共用同一份实现。

         组件有两种模式（判据在 shared/gameinfo-form.ts）:
           · bound  有 gameId → 每个动作立刻落盘（与原来行为一致）
           · staged 没有 gameId → 只进内存，由向导保存游戏后一起提交 -->

    <!-- ⚠️⚠️ 这个 <section> 曾经在 S11b 拆组件时**被整体删掉**，只剩下上面这段注释。
         后果：编辑页里再也找不到 DLsite 相关的任何东西（RJ 输入 / 按名字搜索 /
         封面预览 / 标题来源），用户没法手动补或改元数据 —— 而组件本身还在、
         还在被 import、`infoForm` ref 也还在，所以 tsc / build / 单测全绿。
         守它的测试：test/edit-page-sections.test.ts（模板里必须真的有 <GameInfoForm）。 -->
    <section class="panel stack" style="margin-bottom: 16px">
      <div>
        <h3 style="margin: 0">{{ t('game.identitySection') }}</h3>
        <div class="hint">{{ t('game.identitySectionHint') }}</div>
      </div>
      <GameInfoForm
        ref="infoForm"
        :initial-meta="savedMeta"
        v-model:title="title"
        :game-path="path"
        :icon-path="iconPath"
        @stage-change="onStageChange"
      />
    </section>

    <!-- M5.0 S11（U8）③：本地信息拆成独立组件（路径 + 引擎） -->
    <GameLocalSection v-model:path="path" v-model:engine="engine" />

    <!-- M5.0 S11（U8）③：分类与标签拆成独立组件 -->
    <GameTagsSection v-model:tags="tags" v-model:icon-path="iconPath" />

    <!-- M5.0 S11（U8）③：引擎参数拆成独立组件（折叠、高级） -->
    <GameEngineArgsSection v-model:game-args="gameArgs" :engine="engine" @manage-versions="manageVersions" />

    <!-- M5.0 S11（U8）③：诊断拆成独立组件（折叠、只在出问题时看） -->
    <GameDiagnosisSection :game-id="gameId" :is-new="isNew" />

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
