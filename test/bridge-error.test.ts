// 跨 contextBridge 的错误编码单测。
//
// 背景：Electron 的 contextBridge 跨隔离边界抛错时**只保留 message/stack**，
// `error.key` 会被静默丢弃 —— 渲染层 translateError 因此永远拿不到 key，
// 所有中文错误文案退化成英文原文，而且不报任何错（M2 端到端探针实测踩到）。
//
// 编解码实现只有一份（src/shared/bridge-error.ts），preload 与渲染层共享，
// 这里直接测那份实现 + translateError 的接线。
import { describe, expect, test } from 'vitest'
import { decodeBridgeError, encodeBridgeError, KEY_MARKER } from '../src/shared/bridge-error'

// 注意：translateError 的接线测试在 test/translate-error.test.ts。
// 那个函数在 src/renderer 里，跨 tsconfig 项目引用会让 typecheck 报 TS6307，
// 所以两个文件各测各的边界：这里测纯编解码，那边测「解码 → 查 locales」。

describe('decodeBridgeError', () => {
  test('从编码后的 message 里解出 key（这是中文文案能出来的唯一原因）', () => {
    const error = decodeBridgeError(encodeBridgeError({ message: 'Invalid RJ', key: 'error.dlsiteInvalidRj' })) as {
      key?: string
      message: string
    }
    expect(error.key).toBe('error.dlsiteInvalidRj')
    // message 里的标记必须被剥掉，否则会显示成怪字符串
    expect(error.message).toBe('Invalid RJ')
  })

  test('解出 arguments（文案里的占位符靠它）', () => {
    const error = decodeBridgeError(
      encodeBridgeError({ message: 'bad', key: 'error.dlsiteNotFound', arguments: { rj: 'RJ294126' } })
    ) as { key?: string; arguments?: Record<string, unknown> }
    expect(error.arguments).toEqual({ rj: 'RJ294126' })
  })

  test('已带 key 的普通 Error 原样返回（不重复解码）', () => {
    const plain = Object.assign(new Error('x'), { key: 'error.cancelled' })
    expect((decodeBridgeError(plain) as { key?: string }).key).toBe('error.cancelled')
  })

  test('没有标记的普通 Error 原样返回', () => {
    const plain = new Error('plain failure')
    const decoded = decodeBridgeError(plain) as { message: string; key?: string }
    expect(decoded.message).toBe('plain failure')
    expect(decoded.key).toBeUndefined()
  })

  test('非 Error 值原样返回（不炸）', () => {
    expect(decodeBridgeError('string error')).toBe('string error')
    expect(decodeBridgeError(undefined)).toBeUndefined()
    expect(decodeBridgeError(null)).toBeNull()
  })

  test('arguments 损坏时降级为只解 key（不抛）', () => {
    const error = new Error(`bad${KEY_MARKER}error.dlsiteNetwork:%E0%A4%A`)
    const decoded = decodeBridgeError(error) as { key?: string; arguments?: unknown }
    expect(decoded.key).toBe('error.dlsiteNetwork')
    expect(decoded.arguments).toBeUndefined()
  })

  test('日语/中文 message 里的标记仍能正确剥离（不会被内容干扰）', () => {
    const encoded = encodeBridgeError({ message: '无法解析 RJ294126 的页面数据', key: 'error.dlsiteParse' })
    const decoded = decodeBridgeError(encoded) as { message: string; key?: string }
    expect(decoded.message).toBe('无法解析 RJ294126 的页面数据')
    expect(decoded.key).toBe('error.dlsiteParse')
  })
})

describe('解码后的 key 能驱动文案（不依赖渲染层，避免跨项目 TS6307）', () => {
  /** 假 i18n：只认几个 key，查不到时原样返回（与 vue-i18n 行为一致）。 */
  const t = (key: string, args?: Record<string, unknown>): string => {
    const dict: Record<string, string> = {
      'error.dlsiteInvalidRj': 'RJ 号格式不正确：{rj}',
      'error.dlsiteNotFound': 'DLsite 上找不到作品 {rj}'
    }
    const template = dict[key]
    if (!template) return key
    return template.replace(/\{(\w+)\}/g, (_whole, name: string) => String(args?.[name] ?? ''))
  }

  test('带占位符的中文文案能正确渲染（这就是修 contextBridge 丢 key 的收益）', () => {
    const decoded = decodeBridgeError(
      encodeBridgeError({ message: 'Invalid RJ', key: 'error.dlsiteNotFound', arguments: { rj: 'RJ999999' } })
    ) as { key?: string; arguments?: Record<string, unknown> }
    expect(t(decoded.key ?? '', decoded.arguments)).toBe('DLsite 上找不到作品 RJ999999')
  })

  test('key 查不到时退回英文原文（不显示裸 key）', () => {
    const decoded = decodeBridgeError(encodeBridgeError({ message: 'boom', key: 'error.noSuchKey' })) as {
      key?: string
      message: string
    }
    const translated = t(decoded.key ?? '')
    // 查不到 → t 原样返回 key → 调用方据此退回 message
    expect(translated).toBe('error.noSuchKey')
    expect(decoded.message).toBe('boom')
  })
})
