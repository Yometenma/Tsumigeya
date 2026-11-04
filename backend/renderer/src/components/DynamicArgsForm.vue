<script setup lang="ts">
// 按 GameArgDef.type 动态渲染引擎参数表单（§4 DynamicArgsForm.vue）。
// 支持：boolean / string（别名 text）/ int / float / dropdown / select / multi-version / array。
//
// ⚠️ `string` 与 `text` 是**同一个控件**：上游 manifest 一律写 "string"，
// core-host 的 GameArgDef 历史方言写 "text"。两处都得认，否则有一侧的参数会渲染成空白行。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { GameArgDef, ManifestRaw } from '@/api/client'

const props = defineProps<{
  manifest: ManifestRaw | null
  /** v-model：参数键值。 */
  modelValue: Record<string, unknown>
  /**
   * 引擎 folder（M4.1 S4）——用来查参数的中文标签 `args.<folder>.<key>`。
   *
   * 为什么要显式传：manifest 里**没有 folder**（我们生成的 manifest 刻意不含 labelKey，
   * 见 argLabel 的注释），而不同引擎有同名参数（`vsync` 在 mkxpz 与 easyrpg 都有），
   * 所以中文文案必须按引擎分开查，不能只按参数键。
   *
   * 可选：老调用方不传时退回 manifest 的英文 label（不让组件直接报错）。
   */
  engineFolder?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: Record<string, unknown>]
  manageVersions: [argKey: string, def: GameArgDef]
}>()

const { t } = useI18n()

interface Field {
  key: string
  definition: GameArgDef
  label: string
  type: GameArgDef['type']
  options: Array<{ label: string; value: string | number }>
  value: unknown
}

/**
 * 参数的中文标签（M4.1 S4）。
 *
 * ⚠️ **不能从 manifest 里取**：我们生成的 manifest 刻意**不写** `labelKey`
 * （那是我们自己的字段，上游只认 `label`；写了会污染与上游兼容的 schema，见 D62）。
 * 所以中文标签只能用「引擎 folder + 参数键」在 i18n 里查：
 *   `args.<folder>.<key>`  → 没翻译时退回 manifest 的英文 `label` → 再退回键名本身。
 *
 * 三级降级是有意的：宁可显示一个英文标签（用户还看得懂 "RGSS Version"），
 * 也不能显示一个空白标题（用户不知道这一行是什么）。
 */
function argLabel(folder: string, key: string, definition: GameArgDef): string {
  if (folder) {
    const candidate = `args.${folder}.${key}`
    const translated = t(candidate)
    // vue-i18n 缺 key 时返回 key 本身，据此判断有没有翻译
    if (translated && translated !== candidate) return translated
  }
  return definition.label?.trim() || key
}

/** manifest.gameArgs → 有序字段列表（保持 manifest 里的顺序）。 */
const fields = computed<Field[]>(() => {
  const schema = props.manifest?.gameArgs
  if (!schema) return []
  // 引擎 folder 从 manifest 的 name 拿不到，所以显式传进 props（见 defineProps）
  const folder = props.engineFolder ?? ''
  return Object.entries(schema).map(([key, definition]) => ({
    key,
    definition,
    label: argLabel(folder, key, definition),
    type: definition.type,
    options: normalizeOptions(definition.options),
    value: props.modelValue?.[key] ?? definition.default
  }))
})

function normalizeOptions(options: GameArgDef['options']): Array<{ label: string; value: string | number }> {
  if (!options) return []
  if (Array.isArray(options) && options.every((item) => typeof item === 'string')) {
    return (options as string[]).map((item) => ({ label: item, value: item }))
  }
  return (options as Array<{ label?: string; value?: string | number }>).map((item) => ({
    label: item.label ?? String(item.value ?? ''),
    value: item.value ?? ''
  }))
}

function update(key: string, value: unknown): void {
  emit('update:modelValue', { ...(props.modelValue ?? {}), [key]: value })
}

// ===== array 类型：字符串列表 =====

function arrayOf(field: Field): string[] {
  const value = field.value
  return Array.isArray(value) ? value.map((item) => String(item)) : []
}

function updateArray(field: Field, index: number, text: string): void {
  const next = arrayOf(field).slice()
  next[index] = text
  update(field.key, next)
}

function pushArray(field: Field): void {
  update(field.key, [...arrayOf(field), ''])
}

function removeArray(field: Field, index: number): void {
  const next = arrayOf(field).slice()
  next.splice(index, 1)
  update(field.key, next)
}

/** select 的值可能是标量也可能是数组，统一成数组给 el-select multiple。 */
function selectValues(field: Field): Array<string | number> {
  const value = field.value
  if (Array.isArray(value)) return value as Array<string | number>
  if (value === undefined || value === null || value === '') return []
  return [value as string | number]
}
</script>

<template>
  <div v-if="fields.length === 0" class="hint">{{ t('game.noArgs') }}</div>

  <div v-else class="args-list">
    <div v-for="field in fields" :key="field.key" class="args-field">
      <div class="settings-row">
        <div class="settings-row-main">
          <div class="settings-row-title">{{ field.label }}</div>
        </div>

        <div class="row" style="flex: 0 0 auto">
          <!-- boolean -->
          <el-switch
            v-if="field.type === 'boolean'"
            :model-value="field.value === true"
            @update:model-value="update(field.key, $event)"
          />

          <!-- text / string：同一个单行输入框 -->
          <!-- ⚠️ 两种 type 名都要认（M4.1 D62）：
               上游 manifest 的字符串参数一律写 "type": "string"
               （nwjs / mkxpz / easyrpg / renpy 的 manifest 全部如此），
               而 core-host 的 GameArgDef 与历史代码用 "text"。
               只认 'text' 的后果：我们自己生成的 manifest（用 string）里
               所有字符串参数**渲染成一个空白行**——不报错，只是输入框不见了。
               反过来只认 'string' 会让用户手改过的旧 games.json 里的 text 参数消失。 -->
          <el-input
            v-else-if="field.type === 'text' || field.type === 'string'"
            :model-value="String(field.value ?? '')"
            style="width: 220px"
            @update:model-value="update(field.key, $event)"
          />

          <!-- int / float -->
          <el-input-number
            v-else-if="field.type === 'int'"
            :model-value="Number(field.value ?? 0)"
            :precision="0"
            style="width: 160px"
            @update:model-value="update(field.key, $event)"
          />
          <el-input-number
            v-else-if="field.type === 'float'"
            :model-value="Number(field.value ?? 0)"
            :step="0.1"
            style="width: 160px"
            @update:model-value="update(field.key, $event)"
          />

          <!-- dropdown（单选） -->
          <el-select
            v-else-if="field.type === 'dropdown'"
            :model-value="(field.value as string | number) ?? ''"
            style="width: 220px"
            @update:model-value="update(field.key, $event)"
          >
            <el-option
              v-for="option in field.options"
              :key="String(option.value)"
              :label="option.label"
              :value="option.value"
            />
          </el-select>

          <!-- select：多值 -->
          <el-select
            v-else-if="field.type === 'select'"
            :model-value="selectValues(field)"
            multiple
            style="width: 240px"
            @update:model-value="update(field.key, $event)"
          >
            <el-option
              v-for="option in field.options"
              :key="String(option.value)"
              :label="option.label"
              :value="option.value"
            />
          </el-select>

          <!-- multi-version：管理入口 -->
          <el-button
            v-else-if="field.type === 'multi-version'"
            @click="emit('manageVersions', field.key, field.definition)"
          >
            {{ t('args.manageVersions') }}
          </el-button>
        </div>
      </div>

      <!-- array：字符串列表编辑（独立一块，不挤在 settings-row 里） -->
      <div v-if="field.type === 'array'" class="args-array">
        <div v-for="(item, index) in arrayOf(field)" :key="index" class="row" style="margin-bottom: 6px">
          <el-input :model-value="item" style="flex: 1" @update:model-value="updateArray(field, index, $event)" />
          <el-button text type="danger" @click="removeArray(field, index)">{{ t('args.removeItem') }}</el-button>
        </div>
        <el-button size="small" @click="pushArray(field)">{{ t('args.addItem') }}</el-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.args-field + .args-field {
  margin-top: 4px;
}

.args-array {
  padding: 0 0 12px;
  border-bottom: 1px solid var(--tsmg-border);
}

.args-field:last-child .args-array {
  border-bottom: none;
}
</style>
