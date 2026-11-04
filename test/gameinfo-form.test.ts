// M5.0 S10（U7）单测：`GameInfoForm` 的共用契约（src/shared/gameinfo-form.ts）。
//
// ===== 这轮测什么 =====
//
// 用户原话：「现在的还是好早之前的，好割裂，每次导入游戏之后还要专门编辑进去再查找对应的」
//
// 方案 §8：把「完善信息」重做成与编辑页**同一套组件**（`GameInfoForm.vue`，不复制第二份）。
//
// 但两处有一个本质差别 —— **数据有没有地方可挂**：
//   · 编辑页：游戏已存在，有 gameId → DLsite 元数据能立刻 saveGameMeta
//   · 向导：游戏**还没保存**，没 gameId → 元数据无处可挂
//
// 原实现在这种情况下只能弹 `error.dlsiteGameRequired`（"先保存游戏"）——
// 那正是用户抱怨的割裂感：查到了元数据、点保存，却被告诉"先存游戏"。
//
// 所以组件分两种模式：bound（立刻落盘）/ staged（只进内存，等游戏保存后一起提交）。
// 这两条判据改反了都不会报错，只是行为悄悄变成"另一个东西"：
//   · staged 误判成 bound → 元数据写进一个不存在的 gameId（主进程会拒绝，用户看到报错）
//   · bound 误判成 staged → 用户点了保存，其实什么都没存（**最糟**，静默丢数据）
import { describe, expect, test } from 'vitest'
import {
  applyStagedField,
  applyStagedReset,
  infoFormMode,
  saveLabel,
  shouldPersist,
  stagedMetaToCommit,
  type InfoFormAction
} from '../src/shared/gameinfo-form'

const ALL_ACTIONS: InfoFormAction[] = [
  'saveMeta',
  'refreshMeta',
  'forceRefresh',
  'clearMeta',
  'commitField',
  'resetField'
]

describe('infoFormMode：有没有 gameId 决定模式', () => {
  test('有 id → bound（立刻落盘，与原来编辑页一样）', () => {
    expect(infoFormMode('1')).toBe('bound')
    expect(infoFormMode('42')).toBe('bound')
  })

  test('没 id / undefined / null → staged', () => {
    expect(infoFormMode(undefined)).toBe('staged')
    expect(infoFormMode(null)).toBe('staged')
    expect(infoFormMode('')).toBe('staged')
  })

  test('⚠️ 空白字符串也算 staged（主进程要求 id 是数字，空串与没有等价）', () => {
    expect(infoFormMode('   ')).toBe('staged')
  })

  test('id 前后空白会被 trim（"  7  " 仍然是一个有效 id）', () => {
    expect(infoFormMode('  7  ')).toBe('bound')
  })
})

describe('★ shouldPersist：staged 下绝不写盘', () => {
  test('bound 模式下每个动作都写盘（与原来行为一致，不能少一个）', () => {
    for (const action of ALL_ACTIONS) {
      expect(shouldPersist('bound', action), `${action} 在 bound 下必须写盘`).toBe(true)
    }
  })

  test('⚠️ staged 模式下**一个都不写盘**（否则写进一个不存在的 gameId）', () => {
    for (const action of ALL_ACTIONS) {
      expect(shouldPersist('staged', action), `${action} 在 staged 下不该写盘`).toBe(false)
    }
  })
})

describe('saveLabel：两处措辞不能共用', () => {
  test('bound → 「保存」（落盘）', () => {
    expect(saveLabel('bound')).toBe('save')
  })

  test('⚠️ staged → 「用于新游戏」', () => {
    // 不说清的话，用户以为是立刻存进了库，而实际要等向导最后一步才提交
    // → "我保存了但库里没有" 的困惑
    expect(saveLabel('staged')).toBe('applyToNewGame')
  })
})

describe('stagedMetaToCommit：向导完成时要提交什么', () => {
  test('有预览 → 提交它（用户查到了就是选择）', () => {
    const work = { rj: 'RJ294126', title: '作品' }
    expect(stagedMetaToCommit(work)).toBe(work)
  })

  test('没有预览 → null（不提交）', () => {
    expect(stagedMetaToCommit(null)).toBeNull()
    expect(stagedMetaToCommit(undefined)).toBeNull()
    expect(stagedMetaToCommit([])).toBeNull()
    expect(stagedMetaToCommit('x')).toBeNull()
  })

  test('⚠️ 用户点「清除」把预览置空后 → 不提交（这就是"查到了但不要"的出口）', () => {
    // 若这里仍提交，用户就没法放弃已查到的元数据了
    expect(stagedMetaToCommit(null)).toBeNull()
  })
})

describe('applyStagedField：就地改暂存的那份（不落盘）', () => {
  const work = { rj: 'RJ1', title: '旧标题', cycle: undefined, editedFields: ['circle'] }

  test('改文本字段 → 值更新', () => {
    const result = applyStagedField(work, 'title', '新标题')
    expect('next' in result).toBe(true)
    if (!('next' in result)) throw new Error('unreachable')
    expect(result.next.title).toBe('新标题')
  })

  test('⚠️ editedFields 是**并集**（不是替换）—— 漏掉会让用户改的字段被刷新冲掉（D26）', () => {
    const result = applyStagedField(work, 'title', '新标题')
    if (!('next' in result)) throw new Error('unreachable')
    expect(result.editedFields).toEqual(['circle', 'title'])
    expect(result.editedFields).toContain('circle')
  })

  test('重复改同一个字段 → 不产生重复条目', () => {
    const result = applyStagedField({ ...work, editedFields: ['title'] }, 'title', '又改了')
    if (!('next' in result)) throw new Error('unreachable')
    expect(result.editedFields).toEqual(['title'])
  })

  test('清空文本 = 让用户主动清掉这个值（存 undefined，不是空串）', () => {
    const result = applyStagedField(work, 'title', '   ')
    if (!('next' in result)) throw new Error('unreachable')
    expect(result.next.title).toBeUndefined()
  })

  test('price：合法数字被保存为**数字**而不是字符串', () => {
    const result = applyStagedField(work, 'price', '1234')
    if (!('next' in result)) throw new Error('unreachable')
    expect(result.next.price).toBe(1234)
    expect(typeof result.next.price).toBe('number')
  })

  test('price：清空 → undefined', () => {
    const result = applyStagedField(work, 'price', '')
    if (!('next' in result)) throw new Error('unreachable')
    expect(result.next.price).toBeUndefined()
  })

  test('⚠️ price：非法输入报 invalid-price（不能存进 NaN）', () => {
    expect(applyStagedField(work, 'price', 'abc')).toEqual({ error: 'invalid-price' })
  })

  test('⚠️ coverUrl：非 img.dlsite.jp 域名报 invalid-cover', () => {
    expect(applyStagedField(work, 'coverUrl', 'https://evil.example/x.jpg')).toEqual({
      error: 'invalid-cover'
    })
  })

  test('coverUrl：合法域名通过', () => {
    const result = applyStagedField(work, 'coverUrl', 'https://img.dlsite.jp/a.jpg')
    if (!('next' in result)) throw new Error('unreachable')
    expect(result.next.coverUrl).toBe('https://img.dlsite.jp/a.jpg')
  })

  test('coverUrl：清空 → undefined（允许移除封面）', () => {
    const result = applyStagedField(work, 'coverUrl', '')
    if (!('next' in result)) throw new Error('unreachable')
    expect(result.next.coverUrl).toBeUndefined()
  })

  test('work 为空 → 报错而不是崩', () => {
    expect(applyStagedField(null, 'title', 'x')).toEqual({ error: 'invalid-price' })
  })
})

describe('applyStagedReset：staged 下重置单个字段', () => {
  test('从 editedFields 摘掉该字段（下次刷新会取回 DLsite 值）', () => {
    const result = applyStagedReset({ rj: 'RJ1', title: 'x', editedFields: ['title', 'circle'] }, 'title')
    expect(result?.editedFields).toEqual(['circle'])
  })

  test('重置不存在的字段 → 不变', () => {
    const result = applyStagedReset({ rj: 'RJ1', editedFields: ['circle'] }, 'title')
    expect(result?.editedFields).toEqual(['circle'])
  })

  test('work 为空 → null（调用方据此不做任何事）', () => {
    expect(applyStagedReset(null, 'title')).toBeNull()
  })

  test('⚠️ 都是纯函数，不就地改入参', () => {
    const original = { rj: 'RJ1', editedFields: ['title'] }
    applyStagedReset(original, 'title')
    applyStagedField(original, 'circle', '社团')
    expect(original.editedFields).toEqual(['title'])
  })
})
