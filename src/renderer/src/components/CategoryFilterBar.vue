<script setup lang="ts">
// M5.0 S12（U2 迁移）：库页顶部的**横向分类筛选栏**。
//
// ===== 为什么从侧边栏搬到这里（用户 2026-11-05 拍板）=====
//
// 原实现（M5.0 S7）把分类放在侧边栏，理由是「分类是用户的整理体系，属于导航层」。
// 实际用起来的问题是：侧边栏与「游戏库 / 引擎 / 设置」三个导航挤在一起，
// 分类越多，两个导航项就被挤得越远，而分类本身**只是库页的一种筛选**——
// 在引擎页/设置页看着一长条分类点不动，等于把筛选器的可见度换成了导航的可用度。
//
// 现在的分工：侧边栏只留导航（游戏库 / 引擎 / 设置），分类是**库页的筛选器**，
// 以横向筛选栏出现在库页顶部 —— 「全部 / 未分类 / 动作类 / …」，点一下即筛。
//
// ===== 为什么是独立组件而不是塞进 LibraryPage.vue =====
//
// 库页已经有 426 行（批量模式、删除确认、三种视图分支都在里面）。
// 分类这块单独有 ~110 行模板 + 6 个处理函数（新建/重命名/删除/计数/菜单分发），
// 塞进去只会让「点卡片会发生什么」更难读。与 S11 拆编辑页是同一取向。
//
// ===== 语义没变（这几条来自 S7，别改）=====
//
// · **多归属**：一个游戏可以同时属于多个分类 → 筛选判据是「命中任一归属即通过」
//   （判据在 shared/categories.ts 的 matchesCategory，有单测，不在模板里重写）。
// · 「未分类」是**虚拟分类**（UNCATEGORIZED_ID，不进定义表），判据是某个归属都没有。
// · 删分类**绝不删游戏**（D31）：二次确认里必须写明「游戏本身不会被删除」。
// · 正在筛某个分类时把它删掉 → 必须清掉筛选，否则筛一个不存在的分类 = 永远空列表。
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage, ElMessageBox } from 'element-plus'
import { translateError } from '@/api/client'
import { useLibraryStore } from '@/stores/library'
import { UNCATEGORIZED_ID } from '../../../shared/categories'

const { t } = useI18n()
const library = useLibraryStore()

/** 新建分类的输入框（null = 不在编辑态）。 */
const newCategoryName = ref<string | null>(null)
const categoryBusy = ref(false)

/**
 * 「全部」是否处于选中态。
 *
 * 判据是 `categoryFilter === null`（**只**看分类这一维）：搜索与「只看未绑定」
 * 是另外两维，用户筛了分类又搜了关键词时，「全部」仍应显示为选中
 * （它的意思是"所有分类"）。做成 computed 而不是模板里写 `=== null`
 * —— 模板禁复杂表达式（AGENTS.md 已知坑）。
 */
const allActive = computed(() => library.categoryFilter === null)

/** 「未分类」是否处于选中态。 */
const uncategorizedActive = computed(() => library.categoryFilter === UNCATEGORIZED_ID)

/** 某个分类是否处于选中态（模板里逐个判断用）。 */
function isCategoryActive(id: string): boolean {
  return library.categoryFilter === id
}

/** 点某个分类（`null` = 全部）。 */
function selectCategory(id: string | null): void {
  library.setCategoryFilter(id)
}

/** 打开新建分类的输入态（空串而不是 null：null 是"不在编辑态"）。 */
function startCreateCategory(): void {
  newCategoryName.value = ''
}

/** 取消新建。 */
function cancelCreateCategory(): void {
  newCategoryName.value = null
}

/** 提交新建。 */
async function submitCreateCategory(): Promise<void> {
  const name = (newCategoryName.value ?? '').trim()
  if (!name) {
    newCategoryName.value = null
    return
  }
  categoryBusy.value = true
  try {
    await library.createCategory(name)
    newCategoryName.value = null
    ElMessage.success(t('category.created', { name }))
  } catch (error) {
    ElMessage.error(translateError(error, t))
  } finally {
    categoryBusy.value = false
  }
}

/** 重命名（用 ElMessageBox 的 prompt：不新增一个对话框组件）。 */
async function renameCategory(id: string, current: string): Promise<void> {
  try {
    const result = await ElMessageBox.prompt(t('category.renamePrompt'), t('category.renameTitle'), {
      inputValue: current,
      confirmButtonText: t('common.ok'),
      cancelButtonText: t('common.cancel'),
      inputValidator: (value) => (!!value && !!value.trim() ? true : t('category.nameRequired'))
    })
    await library.renameCategory(id, result.value)
    ElMessage.success(t('category.renamed'))
  } catch {
    /* 用户取消（ElMessageBox 取消会抛 'cancel'）—— 什么都不做 */
  }
}

/**
 * 删分类。
 *
 * ⚠️ 二次确认里必须说清「**游戏不会被删**」——这是用户最容易误解的一点：
 * 删掉一个分类看起来像"删掉这一类"，而里面的游戏一个都不该少（D31）。
 */
async function deleteCategory(id: string, name: string, gameCount: number): Promise<void> {
  try {
    await ElMessageBox.confirm(
      gameCount > 0
        ? t('category.deleteConfirmWithGames', { name, count: gameCount })
        : t('category.deleteConfirm', { name }),
      t('category.deleteTitle'),
      { type: 'warning', confirmButtonText: t('common.delete'), cancelButtonText: t('common.cancel') }
    )
  } catch {
    return
  }
  try {
    await library.deleteCategory(id)
    // 正在筛这个分类的话要清掉筛选（否则筛一个不存在的分类 = 永远空列表）
    if (library.categoryFilter === id) library.setCategoryFilter(null)
    ElMessage.success(t('category.deleted', { name }))
  } catch (error) {
    ElMessage.error(translateError(error, t))
  }
}

/** 某个分类下有几个游戏（删确认与标签计数用）。 */
function countInCategory(id: string): number {
  return library.games.filter((game) => library.categoriesOf(game.id).includes(id)).length
}

/**
 * 分类 ⋯ 菜单的分发。
 *
 * ⚠️ 写成函数而不是在模板里写箭头函数：模板里只留简单调用，
 * 复杂表达式进 `<script setup>`（AGENTS.md 已知坑，模板表达式最容易白屏）。
 */
function onCategoryMenu(category: { id: string; name: string }, command: string): void {
  if (command === 'rename') void renameCategory(category.id, category.name)
  else if (command === 'delete') void deleteCategory(category.id, category.name, countInCategory(category.id))
}
</script>

<template>
  <!-- 横向筛选栏：分类一多就换行（**不横向滚动**）。
       横向滚动会把超出的分类藏起来，而藏起来的那几个正是用户找不到的
       —— 「这个分类去哪了」是最难自解释的困惑。换行至少都看得见。 -->
  <div class="category-bar">
    <button
      type="button"
      class="category-chip"
      :class="{ 'is-active': allActive }"
      @click="selectCategory(null)"
    >
      <span class="category-chip-name">{{ t('category.all') }}</span>
    </button>

    <button
      type="button"
      class="category-chip"
      :class="{ 'is-active': uncategorizedActive }"
      @click="selectCategory(UNCATEGORIZED_ID)"
    >
      <span class="category-chip-name">{{ t('category.uncategorized') }}</span>
      <span v-if="library.uncategorizedTotal > 0" class="category-chip-count">
        {{ library.uncategorizedTotal }}
      </span>
    </button>

    <!-- 用户自己的分类（多归属）。⋯ 只在 hover 那一行出现（不 hover 时是纯视觉噪音）。 -->
    <div
      v-for="category in library.categoryList"
      :key="category.id"
      class="category-chip category-chip-group"
      :class="{ 'is-active': isCategoryActive(category.id) }"
    >
      <button type="button" class="category-chip-main" @click="selectCategory(category.id)">
        <span class="category-chip-name">{{ category.name }}</span>
        <span v-if="countInCategory(category.id) > 0" class="category-chip-count">
          {{ countInCategory(category.id) }}
        </span>
      </button>
      <!-- ⋯ 菜单：重命名 / 删除。
           传的是 category 对象本身，不在模板里拼箭头函数（AGENTS.md：模板禁复杂表达式）。 -->
      <el-dropdown trigger="click" placement="bottom-start" @command="onCategoryMenu(category, $event)">
        <span class="category-chip-more" :title="t('library.moreActions')">⋯</span>
        <template #dropdown>
          <el-dropdown-menu>
            <el-dropdown-item command="rename">{{ t('category.rename') }}</el-dropdown-item>
            <el-dropdown-item command="delete" divided>{{ t('category.delete') }}</el-dropdown-item>
          </el-dropdown-menu>
        </template>
      </el-dropdown>
    </div>

    <!-- 新建分类：输入态与按钮态两种。用 inline input 而不是弹窗
         —— 建分类是高频小动作，弹窗只为收一个名字太重。 -->
    <div v-if="newCategoryName !== null" class="category-new">
      <el-input
        v-model="newCategoryName"
        :placeholder="t('category.namePlaceholder')"
        size="small"
        style="width: 180px"
        :disabled="categoryBusy"
        @keyup.enter.prevent="submitCreateCategory"
        @keyup.esc.prevent="cancelCreateCategory"
      />
      <el-button size="small" type="primary" :loading="categoryBusy" @click="submitCreateCategory">
        {{ t('common.ok') }}
      </el-button>
      <el-button size="small" text :disabled="categoryBusy" @click="cancelCreateCategory">
        {{ t('common.cancel') }}
      </el-button>
    </div>
    <button v-else type="button" class="category-chip category-chip-add" @click="startCreateCategory">
      {{ t('category.create') }}
    </button>
  </div>
</template>
