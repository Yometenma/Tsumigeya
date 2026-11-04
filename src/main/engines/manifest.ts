// M4.2 S2-①：读本地 manifest + 合并 gameArgs 缺省值（D63 的自实现判决）。
//
// ===== 这个文件替代了什么 =====
//
// `module.js` 的两个 API（方案 §1.1 判「自实现」）：
//   · `readLocalManifests()`  → 读到 `{ <folder>: <manifest 原文> }`
//   · `reconcileAndPersistGameArgs(gameId)` 的内部一半：
//     `mergeGameArgsWithSchema(current, schema)`（「按 schema 补缺省值」那部分）
//
// 「落盘」那半留在 ipc.ts —— 它要动 games-store，而本文件是**叶子**
// （只依赖 node:fs / node:path 与 engines 的类型）。engines 不 import ipc，防循环（R5）。
//
// ===== 读本地 manifest 为什么不能「读不到就抛」=====
//
// 上游 `readLocalManifests` 的行为是：manifest 坏了就 `console.error` 然后**跳过**，
// 其余模块照常返回。必须照抄，因为：
//   · snapshot / detectFolder / 引擎页都调它
//   · 一个用户手改坏的 manifest.json 让启动界面整个白屏，是最糟的失败方式
//   · 「跳过坏的」至少让其它三个引擎还能用（引擎页会显示「未安装」）
//
// ===== 类型：为什么这里有一份 `ManifestRaw` =====
//
// core-host.ts 里原本声明了 `ManifestRaw`（描述「从磁盘读到的 manifest 长什么样」），
// 但 core-host 要收缩到 ~200 行、且不再 import 任何 core 相关的东西（S4），
// 所以「读 manifest」这本职工作连同它的类型一起搬到 engines。
//
// 这里的形状**必须与既有声明逐字段兼容**（ipc.ts / 渲染层 / 测试都在用）：
//   name / version / author / description / autodetect / gameArgs / 其余任意字段
import fs from 'node:fs'
import path from 'node:path'
import type { EngineArgSpec } from './types'

// ===== 类型 =====

/** manifest 的 `autodetect` 块（磁盘上的形状）。 */
export interface ManifestAutodetect {
  extensions?: string[]
  /** 单数写法（上游老 manifest 用过）。`module.js` 的 `normalizeExt` 会把它当 `extensions` 处理。 */
  extension?: string
  files?: string[]
  all_required?: boolean
}

/** manifest 的 `gameArgs` 里单个参数的形状（磁盘上的形状，比 `EngineArgSpec` 宽松）。 */
export interface GameArgDef {
  /**
   * `string` 与 `text` 是同一个控件的两个写法（M4.1 D62）：上游 manifest 一律写
   * `"string"`（nwjs/mkxpz/easyrpg/renpy 全部如此），历史代码写 `"text"`。
   * 这里两种都收 —— 我们生成的 manifest 用上游那种写法。
   */
  type: 'boolean' | 'text' | 'string' | 'int' | 'float' | 'dropdown' | 'select' | 'multi-version' | 'array'
  label?: string
  default?: unknown
  options?: Array<{ label?: string; value?: string | number }> | string[]
  'version-script'?: string
}

/** 从磁盘读到的 manifest（**读**的方向；生成用的 `EngineDefinition` 是**写**的方向）。 */
export interface ManifestRaw {
  name?: string
  version?: string
  author?: string
  description?: string
  autodetect?: ManifestAutodetect
  gameArgs?: Record<string, GameArgDef>
  dependencies?: Record<string, unknown>
  /** 上游老写法：`deps` 与 `dependencies` 两处都出现过（见 installDependencies 的注释）。 */
  deps?: Record<string, unknown>
  [key: string]: unknown
}

// ===== 读 =====

/** `<数据目录>/modules`。 */
export function modulesDirOf(dataDir: string): string {
  return path.join(dataDir, 'modules')
}

/**
 * 读 `<dataDir>/modules/<folder>/manifest.json` 全部（`{ <folder>: <原文> }`）。
 *
 * 三个行为**照抄上游**（不要「顺手优化」）：
 *   ① `modules` 目录不存在 → 返回 `{}`，不抛
 *   ② 子条目不是目录（比如用户手放的 `.DS_Store`）→ 跳过
 *   ③ manifest 缺失 / JSON 坏 → **跳过这一个**，其余照常返回（见文件头的理由）
 *
 * 坏 manifest 会打 `console.warn` 而不是 `console.error`：它不是程序错误，
 * 是「用户目录里有个坏文件」这种可预期状态，日志级别不该吓人。
 */
export function readLocalManifests(dataDir: string): Record<string, ManifestRaw> {
  const root = modulesDirOf(dataDir)
  const out: Record<string, ManifestRaw> = {}
  if (!fs.existsSync(root)) return out

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch (error) {
    // 目录存在但读不动（权限）：同样降级成空表，不能让 snapshot 整个崩
    console.warn(`[tsumigeya] 读 modules 目录失败（按空处理）：${(error as Error).message}`)
    return out
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = path.join(root, entry.name, 'manifest.json')
    if (!fs.existsSync(file)) continue
    try {
      out[entry.name] = JSON.parse(fs.readFileSync(file, 'utf8')) as ManifestRaw
    } catch (error) {
      console.warn(
        `[tsumigeya] 跳过坏 manifest：modules/${entry.name}/manifest.json —— ${(error as Error).message}`
      )
    }
  }
  return out
}

/**
 * 读**单个**引擎的 manifest（不存在返回 null，不抛）。
 *
 * 与 `readLocalManifests()` 的区别：这个是「我知道我要哪个引擎」的场景（更新、
 * 启动前读 schema），不必把整个 modules 目录扫一遍。
 */
export function readManifest(dataDir: string, folder: string): ManifestRaw | null {
  const file = path.join(modulesDirOf(dataDir), folder, 'manifest.json')
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ManifestRaw
  } catch (error) {
    console.warn(`[tsumigeya] 读 manifest 失败：modules/${folder}/manifest.json —— ${(error as Error).message}`)
    return null
  }
}

// ===== 合并缺省值 =====

/**
 * 按 schema 给 gameArgs 补缺省值（`mergeGameArgsWithSchema` 的等价物）。
 *
 * 四条语义（每一条都有现实依据，改一条用户的既有配置就会变）：
 *
 *   ① **只补缺、不覆盖**：用户填过 `fullscreen: true`，schema 默认 false → 保留 true。
 *      判据是 `Object.hasOwn`，不是 `??=` —— 因为**已存的值可能是 `false` / `''` / `0`
 *      这种合法空值**，用 `??` 会把它们当「没填」覆盖掉。
 *
 *   ② **未知键原样保留**：manifest 里已经没有的参数（我们砍掉的那 49 个）留在
 *      `gameArgs` 里不会被删。理由：那是用户磁盘上的数据，删掉等于替用户做决定；
 *      而且启动时 `buildLaunchPlan` 只读它认识的键，留着无害。
 *
 *   ③ **`multi-version` 不补默认值**：nwjs 的 `version` 默认是空串，而真实目录名
 *      是 `v0.106.1`（见 registry 的注释 + `reconcileVersionArgs`）。补默认值会让
 *      「用户什么都没选」变成「用户选了 0.106.1」→ 拼出不存在的路径 → 点启动没反应。
 *      **补空串也一样有害**，所以这一类整个跳过，由 `reconcileVersionArgs` 探测真实目录。
 *
 *   ④ **`changed` 只表示「真的补了东西」**：调用方据此决定要不要落盘。
 *      「值已经是对的」不算 changed —— 否则每次启动都会写一次 games.json。
 */
export function reconcileGameArgs(
  gameArgs: Record<string, unknown> | null | undefined,
  schema: Record<string, unknown> | null | undefined
): { merged: Record<string, unknown>; changed: boolean } {
  const current: Record<string, unknown> = gameArgs && typeof gameArgs === 'object' ? { ...gameArgs } : {}
  if (!schema || typeof schema !== 'object') return { merged: current, changed: false }

  let changed = false
  for (const [key, rawDef] of Object.entries(schema)) {
    const def = rawDef as GameArgDef | null | undefined
    if (!def || typeof def !== 'object') continue
    if (def.type === 'multi-version') continue // 见上面第 ③ 条
    if (Object.hasOwn(current, key)) continue // 见上面第 ① 条
    if (!Object.hasOwn(def, 'default')) continue // schema 没写默认值：不猜
    current[key] = cloneDefault(def.default)
    changed = true
  }
  return { merged: current, changed }
}

/**
 * 拷一份默认值。
 *
 * 为什么不是直接赋值：默认值里有**数组**（mkxpz 的 `RTP` / `preloadScript` / `fontSub`）。
 * 直接赋值会让两份 gameArgs 共享同一个数组对象 —— 用户改了一个游戏的 RTP，
 * 另一个游戏的 RTP 跟着变（而 `saveGame` 又把同一份引用写进 store）。
 * 这是 M1 时代「编辑页改 A 游戏影响 B 游戏」那类 bug 的成因，这里从源头堵住。
 */
function cloneDefault(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneDefault)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = cloneDefault(item)
    }
    return out
  }
  return value
}

/**
 * registry 的 `EngineArgSpec` → manifest 里的 `gameArgs` 形状（给上面的 reconcile 吃）。
 *
 * 这层转换存在的原因：`reconcileGameArgs` 要能同时吃「磁盘读到的 manifest」
 * （键可选、类型宽松）和「registry 定义」（键必填），所以入参是 `Record<string, unknown>`。
 * 这个函数只是把前者**显式**转成后者，避免调用方各自 `as any`。
 */
export function schemaFromDefinition(
  definition: { gameArgs: Record<string, EngineArgSpec> }
): Record<string, unknown> {
  return definition.gameArgs as unknown as Record<string, unknown>
}
