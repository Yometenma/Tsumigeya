<script setup lang="ts">
// 设置页（§4 SettingsPage.vue）：外观/语言/列表视图/删除确认/自动识别未装引擎/
// 启动检查更新、数据目录（打开/复制）、版本信息。改外观立即生效。
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from 'element-plus'
import { api, translateError, type Appearance, type Settings } from '@/api/client'
import { useSettingsStore } from '@/stores/settings'
import { SETTINGS_GROUPS, groupHasCustom, isEmptyGroup, type SettingsGroupId } from '../../../shared/settings-groups'
import { SAVE_SYNC_MODES, needsManualDisclaimer, saveSyncModeLabelKey, type SaveSyncMode } from '../../../shared/save-sync'

const { t } = useI18n()
const settings = useSettingsStore()

/**
 * M5.0 S9（U9）：分组的展开状态。
 *
 * 初始值来自 `SETTINGS_GROUPS[i].defaultOpen`（判据在 shared/settings-groups.ts，有单测）。
 * 用对象而不是数组：展开状态与分组 id 绑定，将来增删分组时不会错位。
 */
const openGroups = ref<Record<string, boolean>>(
  Object.fromEntries(SETTINGS_GROUPS.map((group) => [group.id, group.defaultOpen]))
)

/** 折叠组里有没有"非默认值"（收起的组若被改过，要有提示，否则用户以为没生效）。 */
function toggleGroup(id: SettingsGroupId): void {
  openGroups.value = { ...openGroups.value, [id]: !openGroups.value[id] }
}

/**
 * 某个分组里是否有**偏离默认值**的设置（收起的组若被改过，标题上挂个圆点）。
 *
 * ⚠️ 默认值的唯一来源是 `shared/settings-groups.ts` 的 `BOOL_DEFAULTS`
 * —— 本鱼第一版在这里手抄了一份，**抄错了** `checkModuleUpdatesOnStartup`
 * （真实默认是 true，抄成了 false）。手抄的镜像迟早漂，所以搬去 shared
 * 并加了一条源码级核对测试（与主进程 DEFAULT_SETTINGS 逐项比对）。
 */
function groupHasCustomById(groupId: SettingsGroupId): boolean {
  const group = SETTINGS_GROUPS.find((item) => item.id === groupId)
  if (!group) return false
  return groupHasCustom(group, settings.settings as unknown as Record<string, unknown>)
}

const appearance = computed<Appearance>(() => settings.settings.appearance)

const appearanceOptions = computed<Array<{ label: string; value: Appearance }>>(() => [
  { label: t('settings.appearanceSystem'), value: 'system' },
  { label: t('settings.appearanceLight'), value: 'light' },
  { label: t('settings.appearanceDark'), value: 'dark' }
])

async function patch(partial: Partial<Settings>): Promise<void> {
  try {
    await settings.save(partial)
    ElMessage.success(t('settings.saved'))
  } catch (error) {
    ElMessage.error(translateError(error, t))
  }
}

/** M2.5-C：语言偏好选项（首个是"不启用"，让用户可以整体关掉这个功能）。 */
const languageOptions = computed<Array<{ label: string; value: string }>>(() => [
  { label: t('settings.languageNone'), value: 'none' },
  { label: t('settings.languageZh'), value: 'zh' },
  { label: t('settings.languageJa'), value: 'ja' },
  { label: t('settings.languageEn'), value: 'en' },
  { label: t('settings.languageKo'), value: 'ko' }
])

/**
 * 外观切换。写成函数而不是在模板里内联 `$event as Appearance`：
 * 模板表达式里不能写 TS 类型断言，否则该页面整块渲染会抛 SyntaxError 而白屏。
 */
function onAppearanceChange(value: unknown): void {
  void patch({ appearance: value as Appearance })
}

async function openDataDir(): Promise<void> {
  try {
    await api.openFolder(settings.dataPath)
  } catch (error) {
    ElMessage.error(translateError(error, t))
  }
}

async function copyDataPath(): Promise<void> {
  try {
    await navigator.clipboard.writeText(settings.dataPath)
    ElMessage.success(t('common.copied'))
  } catch {
    ElMessage.error(t('error.network'))
  }
}

// ===== M4 S5：存档同步（**占位**，不接任何云）=====

/**
 * 下拉选项（标签走 i18n，值来自 shared/save-sync.ts 的唯一清单）。
 *
 * ⚠️ 这里**只有两个选项**，没有第三个。方案 §3.5 与 D31：只留接口不实现云同步。
 * 加第三个之前先读 `shared/save-sync.ts` 的文件头（那里面写了为什么不能接）。
 */
const saveSyncOptions = computed<Array<{ label: string; value: SaveSyncMode }>>(() =>
  SAVE_SYNC_MODES.map((mode) => ({ label: t(saveSyncModeLabelKey(mode)), value: mode }))
)

/** 选 `manual` 时显示一句「不会上传任何东西」—— 让用户明白我们没偷偷联网。 */
const showSyncDisclaimer = computed(() => needsManualDisclaimer(settings.settings.saveSyncMode))

/** 下拉变更（写成函数而不是在模板里内联断言，见外观那一段的注释）。 */
function onSaveSyncChange(value: unknown): void {
  void patch({ saveSyncMode: value as SaveSyncMode })
}</script>

<template>
  <h1 class="page-title">{{ t('settings.title') }}</h1>
  <p class="page-subtitle">{{ t('app.tagline') }}</p>

  <!-- M5.0 S9（U9）：分组化。原来 13 条设置项平铺在一个 panel 里 ——
       用户的抱怨就是"一条条平铺"，所以只把最常改的两组默认展开，其余收起。
       分组定义在 shared/settings-groups.ts（**数据**），有 16 条单测核对
       「每个 Settings 字段都恰好被某个分组列一次」——
       搬家的漏项不会报错，只会让用户找不到那个开关（D68 的同一取向）。 -->
  <section v-for="group in SETTINGS_GROUPS" :key="group.id" class="panel settings-group">
    <!-- 「数据与版本」组没有开关，不做成可折叠的：里面没有开关，收起只是多一次点击 -->
    <template v-if="isEmptyGroup(group)">
      <div class="settings-group-title-flat">{{ t('settings.group.' + group.id) }}</div>
      <div class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-title">{{ t('settings.dataDirectory') }}</div>
          <div class="settings-row-hint" style="word-break: break-all">{{ settings.dataPath || '—' }}</div>
        </div>
        <div class="row" style="flex: 0 0 auto">
          <el-button @click="openDataDir">{{ t('settings.openDataDirectory') }}</el-button>
          <el-button @click="copyDataPath">{{ t('settings.copyPath') }}</el-button>
        </div>
      </div>
      <el-alert
        v-if="settings.dataDirWarning"
        type="warning"
        :closable="false"
        style="margin-top: 10px"
        :title="t('settings.dataDirFallbackTitle')"
        :description="
          t('settings.dataDirFallbackDesc', {
            requested: settings.dataDirWarning.requested,
            code: settings.dataDirWarning.code
          })
        "
      />
      <div class="settings-row-title" style="margin: 14px 0 8px">{{ t('settings.about') }}</div>
      <div class="hint">{{ t('settings.version', { version: settings.appVersion || '—' }) }}</div>
      <div class="hint">{{ t('settings.node', { version: settings.nodeVersion || '—' }) }}</div>
      <div class="hint">{{ t('settings.platform', { platform: settings.platform || '—' }) }}</div>
    </template>

    <template v-else>
      <button type="button" class="settings-group-head" @click="toggleGroup(group.id)">
        <span class="settings-group-caret" :class="{ 'is-open': openGroups[group.id] }">▸</span>
        <span class="settings-group-title">{{ t('settings.group.' + group.id) }}</span>
        <!-- 收起的组若被改过（与默认不一致），给个小圆点：否则用户以为这里是默认状态 -->
        <span v-if="!openGroups[group.id] && groupHasCustomById(group.id)" class="settings-group-dot" />
        <span class="settings-group-count">{{ t('settings.groupCount', { count: group.keys.length }) }}</span>
      </button>

      <div v-if="openGroups[group.id]" class="settings-group-body">
        <!-- ===== 外观 ===== -->
        <div v-if="group.id === 'appearance'" class="settings-row">
          <div class="settings-row-main">
            <div class="settings-row-title">{{ t('settings.appearance') }}</div>
          </div>
          <el-radio-group :model-value="appearance" @update:model-value="onAppearanceChange($event)">
            <el-radio-button v-for="option in appearanceOptions" :key="option.value" :value="option.value">
              {{ option.label }}
            </el-radio-button>
          </el-radio-group>
        </div>
        <div v-if="group.id === 'appearance'" class="settings-row">
          <div class="settings-row-main">
            <div class="settings-row-title">{{ t('settings.listView') }}</div>
            <div class="settings-row-hint">{{ t('settings.listViewHint') }}</div>
          </div>
          <el-switch
            :model-value="settings.settings.listView"
            @update:model-value="patch({ listView: $event === true })"
          />
        </div>

        <!-- ===== 游戏库 ===== -->
        <div v-if="group.id === 'library'" class="settings-row">
          <div class="settings-row-main">
            <div class="settings-row-title">{{ t('settings.deletionConfirmation') }}</div>
          </div>
          <el-switch
            :model-value="settings.settings.deletionConfirmation"
            @update:model-value="patch({ deletionConfirmation: $event === true })"
          />
        </div>
        <!-- R18 封面保护：默认关闭（打码）。只影响显示，元数据照常抓取与保存。 -->
        <div v-if="group.id === 'library'" class="settings-row">
          <div class="settings-row-main">
            <div class="settings-row-title">{{ t('settings.showAdultCovers') }}</div>
            <div class="settings-row-hint">{{ t('settings.showAdultCoversHint') }}</div>
          </div>
          <el-switch
            :model-value="settings.settings.showAdultCovers"
            @update:model-value="patch({ showAdultCovers: $event === true })"
          />
        </div>
        <!-- M4 S5：存档同步**占位**（不接任何云，方案 §3.5 / D31）。
             只有「无 / 手动导入导出」两个值 —— 手动那两个入口就是详情页的
             导出/导入按钮，这里只是让用户选"要不要那个概念"。
             ⚠️ `none` 也照样显示那两个按钮（showsManualButtons 恒 true）：
             `none` 的语义是"我不需要同步方案"，**不是**"我不想备份"。 -->
        <div v-if="group.id === 'library'" class="settings-row">
          <div class="settings-row-main">
            <div class="settings-row-title">{{ t('settings.saveSync') }}</div>
            <div class="settings-row-hint">{{ t('settings.saveSyncHint') }}</div>
          </div>
          <el-select
            :model-value="settings.settings.saveSyncMode"
            style="width: 200px"
            @update:model-value="onSaveSyncChange($event)"
          >
            <el-option
              v-for="option in saveSyncOptions"
              :key="option.value"
              :label="option.label"
              :value="option.value"
            />
          </el-select>
        </div>
        <div v-if="group.id === 'library' && showSyncDisclaimer" class="settings-row">
          <div class="settings-row-hint">{{ t('settings.saveSyncManualDisclaimer') }}</div>
        </div>

        <!-- ===== 语言 ===== -->
        <div v-if="group.id === 'language'" class="settings-row">
          <div class="settings-row-main">
            <div class="settings-row-title">{{ t('settings.language') }}</div>
          </div>
          <el-select
            :model-value="settings.settings.language"
            style="width: 200px"
            @update:model-value="patch({ language: $event })"
          >
            <el-option :label="t('settings.languageSystem')" value="system" />
            <el-option label="简体中文" value="zh-CN" />
          </el-select>
        </div>
        <!-- M2.5-C：多语言版本偏好（§C.4）。与 DLsite 无关，是本地多个语言版本文件夹的事。
             三个参数（首选/次选/启动时提示）放同一组：它们是同一件事的三个参数。 -->
        <div v-if="group.id === 'language'" class="settings-row">
          <div class="settings-row-main">
            <div class="settings-row-title">{{ t('settings.preferredLanguage') }}</div>
            <div class="settings-row-hint">{{ t('settings.languagePreferenceHint') }}</div>
          </div>
          <div class="row" style="flex: 0 0 auto; gap: 8px">
            <el-select
              :model-value="settings.settings.preferredLanguage"
              style="width: 120px"
              @update:model-value="patch({ preferredLanguage: $event })"
            >
              <el-option v-for="option in languageOptions" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
            <span class="hint">{{ t('settings.fallbackLanguage') }}</span>
            <el-select
              :model-value="settings.settings.fallbackLanguage"
              style="width: 120px"
              @update:model-value="patch({ fallbackLanguage: $event })"
            >
              <el-option v-for="option in languageOptions" :key="option.value" :label="option.label" :value="option.value" />
            </el-select>
          </div>
        </div>
        <div v-if="group.id === 'language'" class="settings-row">
          <div class="settings-row-main">
            <div class="settings-row-title">{{ t('settings.languageSwitchPrompt') }}</div>
            <div class="settings-row-hint">{{ t('settings.languageSwitchPromptHint') }}</div>
          </div>
          <el-switch
            :model-value="settings.settings.languageSwitchPrompt"
            @update:model-value="patch({ languageSwitchPrompt: $event === true })"
          />
        </div>

        <!-- ===== 启动与引擎 ===== -->
        <div v-if="group.id === 'launch'" class="settings-row">
          <div class="settings-row-main">
            <div class="settings-row-title">{{ t('settings.nonInstalledAutodetect') }}</div>
            <div class="settings-row-hint">{{ t('settings.nonInstalledAutodetectHint') }}</div>
          </div>
          <el-switch
            :model-value="settings.settings.nonInstalledAutodetect"
            @update:model-value="patch({ nonInstalledAutodetect: $event === true })"
          />
        </div>
        <!-- M3 §4.3：启动前自动诊断的逃生口（诊断是本地只读扫描，但给用户关掉的余地） -->
        <div v-if="group.id === 'launch'" class="settings-row">
          <div class="settings-row-main">
            <div class="settings-row-title">{{ t('settings.diagnoseBeforeLaunch') }}</div>
            <div class="settings-row-hint">{{ t('settings.diagnoseBeforeLaunchHint') }}</div>
          </div>
          <el-switch
            :model-value="settings.settings.diagnoseBeforeLaunch"
            @update:model-value="patch({ diagnoseBeforeLaunch: $event === true })"
          />
        </div>
        <div v-if="group.id === 'launch'" class="settings-row">
          <div class="settings-row-main">
            <div class="settings-row-title">{{ t('settings.checkModuleUpdatesOnStartup') }}</div>
          </div>
          <el-switch
            :model-value="settings.settings.checkModuleUpdatesOnStartup"
            @update:model-value="patch({ checkModuleUpdatesOnStartup: $event === true })"
          />
        </div>
      </div>
    </template>
  </section>
</template>
