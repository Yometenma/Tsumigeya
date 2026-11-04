// M5.0 S6（U1）单测：库页批量模式的选择集与二次确认文案（src/shared/bulk-select.ts）。
//
// ===== 这轮测什么 =====
//
// 方案 §4.1 的原话：「批量删除**必须二次确认**，且弹窗里要列出被删的标题
// （≥3 个时只列前 3 + 「等 N 个」）」。
//
// 两类静默错误：
//
// ① **「列几条 + 等几个」差一位**。删 3 个却写「等 0 个」→ 一个没意义的后缀；
//    删 4 个列 3 个写「等 1 个」→ 数字对但读起来别扭。当场看不出来。
//
// ② **选择集与筛选的关系**：批量模式开着时用户改了筛选，被筛走的卡片看不见了。
//    如果删除直接用「选中集」，他会删掉自己**以为没选**的游戏 —— 这是误删的直接来源，
//    而且事后无法恢复（游戏从库里没了，元数据也清了）。
//
// 判据：**选择集保留**（切筛选不丢），但**确认与执行只看当前可见的交集**，
// 被筛掉的在弹窗里提示出来让用户有机会取消。
import { describe, expect, test } from 'vitest'
import {
  CONFIRM_LIST_LIMIT,
  deletableSelection,
  deleteConfirmPlan,
  selectAllState,
  selectedCount
} from '../src/shared/bulk-select'

describe('deleteConfirmPlan：列几条 + 等几个', () => {
  test('1 个 → 列 1 个，无省略', () => {
    const plan = deleteConfirmPlan(['A'])
    expect(plan).toEqual({ listed: ['A'], omitted: 0, hiddenCount: 0 })
  })

  test('3 个整 → 全列出来，⚠️ omitted 必须是 0（不能冒出「等 0 个」）', () => {
    // 这是边界：正好等于上限时不省略。差一位就会写成「等 0 个」，一个没意义的后缀
    expect(CONFIRM_LIST_LIMIT).toBe(3)
    const plan = deleteConfirmPlan(['A', 'B', 'C'])
    expect(plan.listed).toEqual(['A', 'B', 'C'])
    expect(plan.omitted).toBe(0)
  })

  test('4 个 → 列前 3 个 + 等 1 个', () => {
    const plan = deleteConfirmPlan(['A', 'B', 'C', 'D'])
    expect(plan.listed).toEqual(['A', 'B', 'C'])
    expect(plan.omitted).toBe(1)
  })

  test('10 个 → 列前 3 个 + 等 7 个', () => {
    const plan = deleteConfirmPlan(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'])
    expect(plan.listed).toHaveLength(3)
    expect(plan.omitted).toBe(7)
  })

  test('⚠️ 按调用方给的顺序截取（要让前三个与屏幕上看到的一致，不能乱序）', () => {
    const plan = deleteConfirmPlan(['第一个', '第二个', '第三个', '第四个'])
    expect(plan.listed).toEqual(['第一个', '第二个', '第三个'])
  })

  test('空列表 → 空计划（不该被调用，但别崩）', () => {
    expect(deleteConfirmPlan([])).toEqual({ listed: [], omitted: 0, hiddenCount: 0 })
  })

  test('hiddenCount 透传（提示「其中 N 个当前不可见」）', () => {
    const plan = deleteConfirmPlan(['A', 'B', 'C', 'D'], 2)
    expect(plan.hiddenCount).toBe(2)
  })

  test('hiddenCount 超界时被夹到列表长度（不出现「其中 5 个不可见」但只有 4 个的事）', () => {
    expect(deleteConfirmPlan(['A'], 5).hiddenCount).toBe(1)
    expect(deleteConfirmPlan([], 5).hiddenCount).toBe(0)
  })

  test('hiddenCount 为负按 0', () => {
    expect(deleteConfirmPlan(['A', 'B'], -3).hiddenCount).toBe(0)
  })
})

describe('deletableSelection：选中集 ∩ 当前可见集', () => {
  test('全部可见且都选中 → 全删', () => {
    const selected = new Set(['1', '2', '3'])
    expect(deletableSelection(selected, ['1', '2', '3'])).toEqual(['1', '2', '3'])
  })

  test('⚠️ 筛掉了的选中项**不在删除集里**（这是防误删的核心）', () => {
    // 用户选了 1/2/3，然后改了筛选，屏幕上只剩 1
    const selected = new Set(['1', '2', '3'])
    expect(deletableSelection(selected, ['1'])).toEqual(['1'])
  })

  test('结果按 visible 的顺序（不是 Set 的插入顺序）', () => {
    const selected = new Set(['3', '1'])
    expect(deletableSelection(selected, ['1', '2', '3'])).toEqual(['1', '3'])
  })

  test('没选 → 空', () => {
    expect(deletableSelection(new Set<string>(), ['1', '2'])).toEqual([])
  })

  test('可见集为空 → 空（不会退化成"删全库"）', () => {
    expect(deletableSelection(new Set(['1', '2']), [])).toEqual([])
  })

  test('选中集里的陈旧 id（已删掉的游戏）被自动忽略', () => {
    const selected = new Set(['1', 'gone'])
    expect(deletableSelection(selected, ['1', '2'])).toEqual(['1'])
  })
})

describe('selectAllState：三态全选框', () => {
  test('一个都没选 → none', () => {
    expect(selectAllState(new Set(), ['1', '2'])).toBe('none')
  })

  test('⚠️ 部分选中 → partial（不能显示成全选，也不能显示成未选）', () => {
    // 勾了 3 个中的 1 个：全选框显示"已勾选"会让他以为全选了
    expect(selectAllState(new Set(['1']), ['1', '2', '3'])).toBe('partial')
  })

  test('全选中 → all', () => {
    expect(selectAllState(new Set(['1', '2', '3']), ['1', '2', '3'])).toBe('all')
  })

  test('⚠️ 只在"当前可见"的范围内判（筛掉的不参与）', () => {
    // 选了 1/2/3，当前只看到 1 → 相对可见集是 all，不是 partial
    expect(selectAllState(new Set(['1', '2', '3']), ['1'])).toBe('all')
  })

  test('可见集为空 → none（避免空库时全选框是勾上的）', () => {
    expect(selectAllState(new Set(['1']), [])).toBe('none')
  })
})

describe('selectedCount：「已选 N 个」', () => {
  test('与 deletableSelection 的长度恒等（两个数不能分叉）', () => {
    // 工具栏说「已选 3 个」而实际删了 5 个，是最糟的那种不一致
    const selected = new Set(['1', '2', '3', '4', '5'])
    const visible = ['1', '2', '3']
    expect(selectedCount(selected, visible)).toBe(3)
    expect(deletableSelection(selected, visible)).toHaveLength(3)
  })

  test('没选 → 0', () => {
    expect(selectedCount(new Set(), ['1'])).toBe(0)
  })
})
