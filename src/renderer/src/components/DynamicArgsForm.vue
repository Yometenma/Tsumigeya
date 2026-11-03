<script setup lang="ts">
// 按 GameArgDef.type 动态渲染引擎参数表单（§4 DynamicArgsForm.vue）。
// 支持：boolean / text / int / float / dropdown / select / multi-version / array。
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { GameArgDef, ManifestRaw } from '@/api/client'

const props = defineProps<{
  manifest: ManifestRaw | null
  /** v-model：参数键值。 */
  modelValue: Record<string, unknown>
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

/** manifest.gameArgs → 有序字段列表（保持 manifest 里的顺序）。 */
const fields = computed<Field[]>(() => {
  const schema = props.manifest?.gameArgs
  if (!schema) return []
  return Object.entries(schema).map(([key, definition]) => ({
    key,
    definition,
    label: definition.label?.trim() || key,
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

          <!-- text -->
          <el-input
            v-else-if="field.type === 'text'"
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
