// 跨 contextBridge 的错误 key 编解码（preload 编码，渲染层解码）。
//
// 为什么需要这一层（M2 端到端探针实测踩到的真问题）：
// Electron 的 contextBridge 在**跨隔离边界 throw** 时只保留 message 与 stack，
// `error.key` 这类自定义属性会被**静默丢弃**。后果是渲染层的 translateError()
// 永远拿不到 key，所有中文错误文案退化成英文原文——而且不报任何错，
// 看起来只是「提示语没翻译」，极难排查。
//
// 所以把 key/arguments 编进 message 里带过桥，渲染层再解回来。
// 这个文件被 preload 与渲染层**两边共享**，标记常量只有一处定义，改一边不会写歪。
//
// ⚠️ 本文件必须保持「零依赖纯函数」：preload 只能 require('electron')，渲染层也不该拖进 Node 模块。

/** 标记串：用 \u0000 前缀，几乎不可能与正常 message 撞上。 */
export const KEY_MARKER = '\u0000tsumi-key:'

/** 主进程返回的错误载荷（与 preload 的 InvokeResponse.error 同形）。 */
export interface BridgeErrorPayload {
  message?: string
  key?: string
  arguments?: Record<string, unknown>
}

/** preload 侧：把载荷编成一个**只带 message** 的 Error（key 塞在 message 尾部）。 */
export function encodeBridgeError(payload: BridgeErrorPayload | undefined): Error {
  const message = payload?.message ?? 'IPC failed'
  if (!payload?.key) return new Error(message)
  const args = payload.arguments ? encodeURIComponent(JSON.stringify(payload.arguments)) : ''
  return new Error(`${message}${KEY_MARKER}${payload.key}:${args}`)
}

/**
 * 渲染层侧：把编进 message 的 key/arguments 解回 Error 属性上。
 * 解不出来（没有标记 / 已带 key）时**原样返回**，绝不抛。
 */
export function decodeBridgeError<T>(error: T): T {
  const candidate = error as (Error & { key?: string; arguments?: Record<string, unknown> }) | null | undefined
  if (!candidate || candidate.key) return error
  const message = candidate.message
  if (typeof message !== 'string') return error
  const index = message.lastIndexOf(KEY_MARKER)
  if (index === -1) return error
  const tail = message.slice(index + KEY_MARKER.length)
  const colon = tail.indexOf(':')
  const key = colon === -1 ? tail : tail.slice(0, colon)
  if (!key) return error

  const rawArgs = colon === -1 ? '' : tail.slice(colon + 1)
  let parsed: Record<string, unknown> | undefined
  if (rawArgs) {
    try {
      parsed = JSON.parse(decodeURIComponent(rawArgs)) as Record<string, unknown>
    } catch {
      parsed = undefined // arguments 坏了也要保住 key，文案能出、占位符留空
    }
  }

  const next = new Error(message.slice(0, index)) as Error & { key?: string; arguments?: Record<string, unknown> }
  next.key = key
  if (parsed) next.arguments = parsed
  if (candidate.stack) next.stack = candidate.stack
  return next as unknown as T
}
