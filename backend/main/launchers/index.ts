// M4.0 S4：引擎 → 启动方案的入口（唯一分发点）。
//
// 调用方（ipc.ts 的 launch）只认识这一个函数。它做的事很少：
//
//   buildLaunchPlan(engine, ctx)  →  LaunchPlan | null
//
// 返回 null = **这个引擎我们不支持启动**（不是「出错了」）。
//
// 为什么不支持就返回 null 而不是抛错：判断「支不支持」是纯查表，
// 报错的措辞、错误码（D57 要求 `error.engineNotLaunchable` + 列出支持的 4 个引擎）
// 属于 IPC 层的事。让分发层保持纯粹，单测能毫秒级断言，文案改动也不用碰这里。
import { easyrpgPlan } from './easyrpg'
import { mkxpzPlan } from './mkxpz'
import { nwjsPlan } from './nwjs'
import { renpyPlan } from './renpy'
import type { EngineId } from './binary-paths'
import type { EnginePlanner, LaunchContext, LaunchPlan } from './types'

/**
 * 支持自实现启动的引擎（D57：只这四个，不回退）。
 *
 * 数组的顺序没有语义，但**导出它是为了给 UI 与错误文案用**：
 * 「本版本支持：NW.js（MV/MZ）、mkxp-z（XP/VX/VX Ace）、EasyRPG（2000/2003）、Ren'Py」
 * 那句话里的引擎名单必须来自这里，不能在两处各写一份（否则加引擎时必漏一处）。
 */
export const LAUNCHABLE_ENGINES: readonly EngineId[] = ['nwjs', 'mkxpz', 'easyrpg', 'renpy']

/** 引擎 → 实现。用 Map 而不是对象字面量：查表时不会撞上 `constructor` / `__proto__`。 */
const PLANNERS: ReadonlyMap<string, EnginePlanner> = new Map<string, EnginePlanner>([
  ['nwjs', nwjsPlan],
  ['mkxpz', mkxpzPlan],
  ['easyrpg', easyrpgPlan],
  ['renpy', renpyPlan]
])

/** 这个引擎能不能自实现启动（供 IPC 与 UI 共用的唯一判据）。 */
export function isLaunchable(engine: string): boolean {
  return PLANNERS.has(engine)
}

/**
 * 造启动方案。不认识的引擎返回 `null`（由调用方报可读错误）。
 *
 * `engine` 用 `unknown` 而不是 `string`：调用方拿到的值来自 games.json，
 * 理论上可能是任何东西（用户手改过、旧版数据）。这里做一次 trim + 小写归一化，
 * 免得 `"NWJS "` 这种脏值被当成未知引擎——那会让用户看到一个莫名其妙的「不支持」。
 */
export function buildLaunchPlan(engine: unknown, ctx: LaunchContext): LaunchPlan | null {
  if (typeof engine !== 'string') return null
  const key = engine.trim().toLowerCase()
  const planner = PLANNERS.get(key)
  if (!planner) return null
  return planner(ctx)
}
