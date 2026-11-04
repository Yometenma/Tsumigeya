// 把 Vue 响应式对象剥成「可以过 contextBridge 的纯值」。
//
// 为什么需要（两次踩同一个坑）：
// Electron 的 contextBridge 用 **structured clone** 传参，而 Vue 的 `reactive`/`ref`
// 包出来的是 **Proxy**，structured clone 直接抛
//   `An object could not be cloned.`
//
// 第一次（M2.5）：`saveGameMeta` 传 DLsite 元数据 → 写了 `plainWork()` 逐字段取值。
// 第二次（本文件）：**保存基本游戏信息**时把 `gameArgs`（引擎参数，DynamicArgsForm 双向绑定
//   的 reactive 对象）整个传过去 → 同样炸，症状是「点保存没反应，只弹一句英文」。
//   逐字段手写 `plainWork` 只覆盖了元数据那条路径，**这条路径漏了**。
//
// 所以这次不再手写逐字段版本，改成一个通用的 `toPlain()`：
// 递归处理对象/数组，把 Proxy 全部展开成普通值。新增字段不用再改它。
//
// ⚠️ 只处理「普通数据」（对象/数组/基本类型）。遇到函数、Date、Map 等 exotic 对象时：
// - 函数 → 丢弃（IPC 参数里不该有函数）
// - Date → 转 ISO 字符串（JSON 化的自然结果）
// - 其它对象 → 谨慎地按 plain object 处理
//
// 零依赖纯函数，可被 main / renderer / vitest 三处共用。

/** 判断是否是「可当纯对象处理」的值（排除 null/数组/Date 等）。 */
function isPlainishObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 递归把值转成可 structured-clone 的纯值。
 *
 * - `undefined` 保留（stub 里 `gameArgs` 允许 undefined）
 * - 函数被丢弃（copy 时跳过该键）
 * - 循环引用会被切断（用 seen WeakSet 防止死循环）
 */
export function toPlain<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || typeof value !== 'object') {
    // 基本类型直接返回；函数在**对象拷贝**时跳过，这里返回 undefined 交给上层处理
    return typeof value === 'function' ? (undefined as unknown as T) : value
  }

  const object = value as unknown as object
  if (seen.has(object)) {
    // 循环引用：切断，避免 JSON/structuredClone 卡死
    return undefined as unknown as T
  }

  if (value instanceof Date) return value.toISOString() as unknown as T

  seen.add(object)

  if (Array.isArray(value)) {
    const out = value.map((item) => toPlain(item, seen))
    // 数组里允许 undefined（structuredClone 支持），但函数已被转成 undefined
    return out as unknown as T
  }

  if (isPlainishObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'function') continue // 函数不传过桥
      out[key] = toPlain(item, seen)
    }
    return out as unknown as T
  }

  return value
}
