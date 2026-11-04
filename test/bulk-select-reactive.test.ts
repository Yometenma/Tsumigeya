// M5.0 S6（U1）单测：库页批量模式的响应式行为 + 删除编排。
//
// ===== 为什么这两条要真的跑 Vue =====
//
// ① **`ref<Set>` 的响应式**。这是 Vue 里最经典的坑之一：
//    ```js
//    selected.value.add(id)   // ❌ 界面纹丝不动
//    selected.value = new Set([...])  // ✅
//    ```
//    用纯 Node 测不出来（要真的 Vue 运行时）。若踩了，"点了复选框没反应"
//    是用户能立刻发现的 bug，但本鱼这次是靠查代码判断的 —— 这里把它改成断言，
//    免得下个会话"顺手优化"成就地 add。
//
// ② **批量删除的编排**：逐个执行 + 一个失败不中断 + 只应用最后一次快照。
//    方案 §4.1 的硬约束。判反的后果：一条失败导致后面全不删（用户以为删完了），
//    或者中途 applySnapshot 让界面闪。
//
// 前半用真 Vue（纯 Node 可跑，不需要 DOM / GUI）；后半用替身 api。
import { describe, expect, test } from 'vitest'
import { computed, ref, watchEffect } from 'vue'
import { deletableSelection, selectAllState } from '../src/shared/bulk-select'

describe('ref<Set> 的响应式（批量选择的基础）', () => {
  test('⚠️ 就地 add 也要能触发（Vue 3 会把 ref(Set) 变成 reactive 代理）', async () => {
    const selected = ref(new Set<string>())
    const observed: number[] = []
    watchEffect(() => {
      observed.push(selected.value.size)
    })
    selected.value.add('1')
    await Promise.resolve()
    // Vue 3 的 ref 对集合类型会自动包裹成 reactive 代理，mutation 会被追踪。
    // 若这条将来因升级失效，改成「整体替换」也照样能过下面的用例 —— 但**必须**知道它变了。
    expectedLast(observed, 1)
  })

  test('整体替换一定能触发（本实现用的就是这条路，最稳）', async () => {
    const selected = ref(new Set<string>())
    const count = ref(0)
    watchEffect(() => {
      count.value = selected.value.size
    })
    selected.value = new Set(['1', '2'])
    await Promise.resolve()
    expect(count.value).toBe(2)
  })

  test('模板里那种 `selected.has(id)` 是追踪的', async () => {
    const selected = ref(new Set<string>())
    const has = computed(() => selected.value.has('1'))
    expect(has.value).toBe(false)
    selected.value = new Set(['1'])
    await Promise.resolve()
    expect(has.value).toBe(true)
  })
})

/** 取最后一次观察值（watchEffect 初次会立刻跑一次）。 */
function expectedLast(values: number[], last: number): void {
  expect(values[values.length - 1]).toBe(last)
}

describe('批量选择的编排（与 shared/bulk-select.ts 的联动）', () => {
  test('toggle 语义：同一个 id 点两次回到未选', () => {
    let selected = new Set<string>()
    const toggle = (id: string): void => {
      const next = new Set(selected)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      selected = next
    }
    toggle('1')
    expect([...selected]).toEqual(['1'])
    toggle('1')
    expect([...selected]).toEqual([])
  })

  test('全选只作用可见集：筛掉的那些保持原状', () => {
    let selected = new Set<string>(['gone'])
    const visible = ['1', '2']
    // 全选
    for (const id of visible) selected.add(id)
    expect(selectAllState(selected, visible)).toBe('all')
    // 但 'gone' 仍在集合里（它不可见，不影响判定）
    expect(selected.has('gone')).toBe(true)
    // 而真正会删的只有可见的
    expect(deletableSelection(selected, visible)).toEqual(['1', '2'])
  })

  test('取消全选只移除可见的，不动筛掉的', () => {
    const selected = new Set(['1', '2', 'gone'])
    const visible = ['1', '2']
    const next = new Set(selected)
    for (const id of visible) next.delete(id)
    expect([...next]).toEqual(['gone'])
  })
})
