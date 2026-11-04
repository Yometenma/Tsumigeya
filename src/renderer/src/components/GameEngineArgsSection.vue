<script setup lang="ts">
// M5.0 S11（U8）③：引擎参数区块（折叠，高级）。
//
// 从 GameEditPage 拆出来的。方案 §9.3 ② 要求它**折叠**：
// D61 已经把参数砍到最少（nwjs 1 / mkxpz 10 / easyrpg 6 / renpy 2），
// 大多数时候不用碰 —— 不该与身份信息抢版面。
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import DynamicArgsForm from '@/components/DynamicArgsForm.vue'
import type { GameArgDef, ManifestRaw } from '@/api/client'
import { useEnginesStore } from '@/stores/engines'

const props = defineProps<{
  /** 引擎参数（v-model）。 */
  gameArgs: Record<string, unknown>
  /** 当前引擎 id。 */
  engine: string
}>()

const emit = defineEmits<{
  'update:gameArgs': [value: Record<string, unknown>]
  /** 用户点了「管理版本」（多版本引擎才有）。 */
  'manage-versions': [argKey: string, definition: GameArgDef]
}>()

const { t } = useI18n()
const engines = useEnginesStore()

/** 默认收起（高级项）。 */
const open = ref(false)

/** 当前引擎的 manifest（已装模块才有 raw）。 */
const manifest = computed<ManifestRaw | null>(() => {
  const module = engines.modules.find((item) => item.id === props.engine)
  return (module?.raw as ManifestRaw | undefined) ?? null
})

/** 折叠开关写成函数（模板里不内联赋值，AGENTS.md 已知坑）。 */
function toggle(): void {
  open.value = !open.value
}

/**
 * 转发「管理版本」事件。
 *
 * 包成函数而不是在模板里写 `(a, b) => emit(...)`：
 * 模板里只留简单调用（AGENTS.md 已知坑，模板表达式最容易白屏）。
 */
function forwardManageVersions(argKey: string, definition: GameArgDef): void {
  emit('manage-versions', argKey, definition)
}
</script>

<template>
  <section class="panel stack">
    <button type="button" class="settings-group-head" @click="toggle">
      <span class="settings-group-caret" :class="{ 'is-open': open }">▸</span>
      <span class="settings-group-title">{{ t('game.engineArgs') }}</span>
    </button>
    <div v-if="open">
      <DynamicArgsForm
        :model-value="gameArgs"
        :manifest="manifest"
        :engine-folder="engine"
        @update:model-value="emit('update:gameArgs', $event)"
        @manage-versions="forwardManageVersions"
      />
    </div>
  </section>
</template>
