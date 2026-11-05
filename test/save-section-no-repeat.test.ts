// 「同一句话在详情页出现两遍」的守卫（2026-11-05 真机评估抓到）。
//
// ===== 这条防什么 =====
//
// `SaveSection.vue` 有两个地方会输出「存档区块说明」：
//   ① 正文（`view.kind` 的 unknown / unreadable / empty 三个分支各有一行 `.detail-missing`）
//   ② 底部「按钮为什么是灰的」（`exportBlockedHint`）
//
// 原实现里 ② 在 `empty` / `unknown` 时也各返回一句 —— 而那两句**正文已经画过了**。
// 真机上的表现是同一句话出现两遍：
//
//     存档
//     没找到这个游戏的存档位置（……）
//     [刷新] [导出存档] [导入存档]
//     没找到这个游戏的存档位置（……）      ← 重复
//
// 用户不会报这个 bug，只会觉得这页做得糙。tsc / build / 单测全绿 —— 因为
// 没有任何判据在管「同一语义不许重复出现」。
//
// 判据：`exportBlockedHint` 的文案来源必须**只**包含正文没讲过的那件事
// （游戏在跑 = `error.saveExportRunning`），不许复用三种空态的文案。
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const SRC = path.join(process.cwd(), 'src', 'renderer', 'src')
const SFC = path.join(SRC, 'components', 'SaveSection.vue')

/** 取 SFC 里 `exportBlockedHint` 的 computed 定义体。 */
function blockedHintBody(source: string): string {
  const idx = source.indexOf('const exportBlockedHint')
  if (idx < 0) throw new Error('找不到 exportBlockedHint 的定义')
  // 取到下一个 '})' 结束（computed(() => { ... })）
  const end = source.indexOf('})', idx)
  return source.slice(idx, end)
}

describe('★ 存档区块：同一句话不许出现两遍', () => {
  const source = fs.readFileSync(SFC, 'utf8')

  test('exportBlockedHint 不许复用三种空态的文案（正文已经画过了）', () => {
    const body = blockedHintBody(source)
    for (const key of ['detail.savesUnknown', 'detail.savesUnreadable', 'detail.savesEmpty']) {
      expect(
        body,
        `exportBlockedHint 又用了 ${key} —— 正文那三个分支已经各画了一次，用户会看到两遍`
      ).not.toContain(key)
    }
  })

  test('★ 只有「有列表」时才可能给按钮说明（三种空态正文已足够）', () => {
    const body = blockedHintBody(source)
    // 必须在 kind === 'list' 上收口 —— 否则又会掉回「空态也解释一遍」
    expect(body, 'exportBlockedHint 没有在 kind=list 上收口').toMatch(/kind\s*!==\s*'list'/)
  })

  test('「游戏在跑」的说明要保留（那是正文没提过的唯一原因）', () => {
    // 这条是防「修重复时把该留的也删了」：有列表但按钮灰的唯一原因就是运行中
    const body = blockedHintBody(source)
    expect(body, '运行中的说明被删了 → 用户看到灰按钮却不知道为什么').toContain(
      'error.saveExportRunning'
    )
  })

  test('正文三个空态分支各自只画一次（不许多加一处）', () => {
    const template = source.slice(source.indexOf('<template>'))
    // 每个文案在模板里恰好出现一次
    for (const [key, count] of [
      ['unknownText', 1],
      ['unreadableText', 1],
      ['emptyText', 1]
    ] as const) {
      const occurrences = template.split(key).length - 1
      expect(occurrences, `模板里 ${key} 出现了 ${occurrences} 次（应为 ${count} 次）`).toBe(count)
    }
  })
})
