// 过 contextBridge 前把响应式 Proxy 剥成纯值（见 src/shared/plain.ts）。
//
// 这个工具的由来：同一个 bug 踩了两次。
//   M2.5：`saveGameMeta` 传 DLsite 元数据 → 写了逐字段的 `plainWork()` 修掉
//   本轮：`saveGame` 传 `gameArgs`（DynamicArgsForm 双向绑定的 reactive 对象）→ 又炸
// 逐字段方案的问题就是「新路径没人记得套上」，所以改成通用递归 + **在 store 层统一使用**：
// 页面/组件不用记得叫它，只要走 store 就一定会被剥干净。
//
// 顺带证明：`structuredClone()` 会抛，`structuredClone(toPlain(x))` 不抛。
import { describe, expect, test } from 'vitest'
import { reactive, ref, computed } from 'vue'
import { toPlain } from '../src/shared/plain'

/** 构造一个嵌套得很深的响应式对象（模拟 DynamicArgsForm 写进去的 gameArgs）。 */
function makeReactiveDraft() {
  return reactive({
    gameTitle: '测试游戏',
    gamePath: 'E:/Game/RPG/傭兵の冒険',
    gameEngine: 'mkxpz',
    iconPath: undefined,
    tags: ['中文', 'RPG'],
    gameArgs: reactive({
      fullscreen: true,
      scale: 2,
      nested: reactive({ foo: 'bar', list: [1, 2, { deep: 'x' }] })
    })
  })
}

describe('toPlain（剥掉 Vue 响应式 Proxy）', () => {
  test('★ 原始 reactive 对象 structuredClone 会抛（证明 bug 真实存在）', () => {
    const draft = makeReactiveDraft()
    expect(() => structuredClone(draft)).toThrow()
  })

  test('★ toPlain 之后 structuredClone 不抛', () => {
    const draft = makeReactiveDraft()
    expect(() => structuredClone(toPlain(draft))).not.toThrow()
  })

  test('剥完之后数据完全一致（不能丢字段）', () => {
    const draft = makeReactiveDraft()
    const plain = toPlain(draft)
    expect(plain).toEqual({
      gameTitle: '测试游戏',
      gamePath: 'E:/Game/RPG/傭兵の冒険',
      gameEngine: 'mkxpz',
      iconPath: undefined,
      tags: ['中文', 'RPG'],
      gameArgs: {
        fullscreen: true,
        scale: 2,
        nested: { foo: 'bar', list: [1, 2, { deep: 'x' }] }
      }
    })
  })

  test('ref / computed 包出来的值也能剥', () => {
    const r = ref({ a: 1, b: [2, 3] })
    const c = computed(() => r.value.b)
    expect(() => structuredClone(toPlain(r.value))).not.toThrow()
    expect(() => structuredClone(toPlain(c.value))).not.toThrow()
    expect(toPlain(r.value)).toEqual({ a: 1, b: [2, 3] })
  })

  test('数组元素里的 Proxy 也要剥（浅拷贝救不了深层）', () => {
    const list = reactive([reactive({ id: 1 }), reactive({ id: 2 })])
    const plain = toPlain(list)
    expect(() => structuredClone(plain)).not.toThrow()
    expect(plain).toEqual([{ id: 1 }, { id: 2 }])
  })

  test('函数被丢弃（IPC 参数里不该有函数，也不该因此崩）', () => {
    const withFn = { a: 1, fn: () => 1, b: 'x' }
    const plain = toPlain(withFn) as Record<string, unknown>
    expect(plain).toEqual({ a: 1, b: 'x' })
    expect(() => structuredClone(plain)).not.toThrow()
  })

  test('Date 转 ISO 字符串', () => {
    const d = new Date('2020-08-30T00:00:00.000Z')
    expect(toPlain({ d })).toEqual({ d: '2020-08-30T00:00:00.000Z' })
  })

  test('基本类型原样返回（不误伤 string/number/boolean/null）', () => {
    expect(toPlain('x')).toBe('x')
    expect(toPlain(2)).toBe(2)
    expect(toPlain(true)).toBe(true)
    expect(toPlain(null)).toBeNull()
  })

  test('循环引用不卡死（切断而不是死循环）', () => {
    const cyclic: Record<string, unknown> = { name: 'x' }
    cyclic.self = cyclic
    const plain = toPlain(cyclic) as Record<string, unknown>
    expect(plain.name).toBe('x')
    expect(() => structuredClone(plain)).not.toThrow()
  })

  test('★ 空对象 / 全 undefined 的 gameArgs（新游戏没填参数时）不崩', () => {
    expect(() => structuredClone(toPlain({ gameArgs: {} }))).not.toThrow()
    expect(() => structuredClone(toPlain({ gameArgs: undefined }))).not.toThrow()
  })
})
