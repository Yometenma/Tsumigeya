// M2.5-C：启动时的语言切换决策（§C.5）——纯函数，零依赖。
//
// 为什么单独抽一个文件：
// ① 这段逻辑直接决定「点启动会不会启动另一个游戏」，是本功能里风险最高的地方；
// ② 抽成纯函数就能用单测钉死（不必靠端到端探针碰运气）；
// ③ 渲染层与主进程若将来都需要，逻辑只有一处。
//
// ⚠️ 零依赖：不 import vue / pinia / element-plus / api-client，
// 语言类型在这里就地声明（与 src/shared/game-language.ts 的 GameLanguage 同构），
// 这样纯 Node 的 vitest 工程能直接跑它，不必跨 tsconfig 工程引用渲染层代码。

/** 可识别的语言（与 shared/game-language.ts 的 GameLanguage 保持一致）。 */
export type LaunchLanguage = 'zh' | 'ja' | 'en' | 'ko'

/** 语言偏好值（`none` = 未设置）。 */
export type LaunchLanguagePreference = LaunchLanguage | 'none'

/** 启动决策的输入。 */
export interface LaunchDecisionInput {
  /** 用户点的那个游戏识别出的语言（推不出来就是 undefined）。 */
  current: LaunchLanguage | undefined
  /** 同组里**其他**语言版本。 */
  alternates: ReadonlyArray<{ id: string; lang: LaunchLanguage }>
  /** 首选语言（'none' = 未设置）。 */
  preferred: LaunchLanguagePreference
  /** 次选语言（'none' = 未设置）。 */
  fallback: LaunchLanguagePreference
  /** 设置里「启动非偏好语言版时提示」是否开启。 */
  prompt: boolean
}

export type LaunchDecisionReason =
  | 'preferred'
  | 'no-better'
  | 'unknown-language'
  | 'no-alternates'
  | 'prompt-disabled'
  | 'feature-disabled'
  | 'better-available'

export interface LaunchDecision {
  /** `prompt` = 需要问用户；`launch` = 直接启动。 */
  action: 'launch' | 'prompt'
  /** action=prompt 时，建议切换到的游戏 id。 */
  targetId?: string
  /** 为什么是这个结论（便于测试与排查，不参与 UI）。 */
  reason: LaunchDecisionReason
}

/**
 * 决定「点启动」时要不要先问用户换版本。
 *
 * 核心原则（§C.5）：**绝不自动改变用户的选择**。
 * 只有当库里确实存在「比当前更符合偏好」的同组版本时才提示；
 * 用户点「就启动这个」时，永远尊重他的选择。
 *
 * `none` 的处理：`preferred` 与 `fallback` 都是 `none` 时功能整体不生效（直接启动）。
 * 只有一个是 `none` 时，另一个顶上来当首选（不浪费用户已经设过的那一档）。
 */
export function decideLaunchTarget(input: LaunchDecisionInput): LaunchDecision {
  const direct = (reason: LaunchDecisionReason): LaunchDecision => ({ action: 'launch', targetId: undefined, reason })

  if (!input.prompt) return direct('prompt-disabled')

  // ① 偏好顺序：首选 → 次选（过滤掉 none）
  const order: LaunchLanguage[] = []
  for (const value of [input.preferred, input.fallback]) {
    if (value === 'none') continue
    if (!order.includes(value)) order.push(value)
  }
  if (order.length === 0) return direct('feature-disabled')

  // ② 当前条目没识别出语言 → 无从比较，不打扰
  if (!input.current) return direct('unknown-language')

  // ③ 已经是首选 → 不提示
  if (order.indexOf(input.current) === 0) return direct('preferred')

  // ④ 没有同组其他版本 → 直接启动
  if (input.alternates.length === 0) return direct('no-alternates')

  // ⑤ 在候选里找排名比当前更靠前的
  //    当前不在偏好列表里 → 当前排名视为「最差」（order.length），任何偏好语言都算更好
  const currentRank = order.indexOf(input.current)
  const threshold = currentRank === -1 ? order.length : currentRank
  let best: { id: string; lang: LaunchLanguage } | undefined
  let bestRank = threshold
  for (const alternate of input.alternates) {
    const rank = order.indexOf(alternate.lang)
    if (rank === -1) continue // 不在偏好里，不比当前更好
    if (rank < bestRank) {
      bestRank = rank
      best = alternate
    }
  }
  if (!best) return direct('no-better')

  return { action: 'prompt', targetId: best.id, reason: 'better-available' }
}
