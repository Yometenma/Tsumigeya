/**
 * M5.0 S10（U7）：`GameInfoForm` 的共用契约 -- 纯函数，零依赖。
 *
 * ===== 这个文件解决的是 S10 最核心的那个问题 =====
 *
 * 用户原话：「现在的还是好早之前的，好割裂，每次导入游戏之后还要专门编辑进去再查找对应的」
 *
 * 方案 §8 的结论：把「完善信息」这一步重做成**与编辑页同一套组件**，
 * 抽成 `GameInfoForm.vue` 给两处共用（**不复制第二份**）。
 *
 * 但两处的差别不在长相，在**数据有没有地方可挂**：
 *
 *   · **编辑页**：游戏已存在 → 有 `gameId` → DLsite 元数据可以立刻 `saveGameMeta`
 *   · **向导**：游戏**还没保存** → 没有 `gameId` → 元数据**无处可挂**
 *
 * 这就是本文件存在的理由。原实现（M2 的 saveMeta）遇到这种情况只能弹
 * `error.dlsiteGameRequired`（"先保存游戏"）—— 正是用户抱怨的割裂感的来源：
 * 他在向导第 3 步查到了元数据、点保存却被告诉"先存游戏"。
 *
 * 共用组件必须能同时服务两种模式：
 *
 *   · `bound`   有 gameId：每个动作立刻落盘（与原来编辑页一模一样）
 *   · `staged`  没有 gameId：动作**只进内存暂存**，等向导保存游戏后一起提交
 *
 * ⚠️ 零依赖：不 import vue / pinia / i18n / api-client。
 * 文案不进这里（规矩：文案一律进 locales），这里只返回结构。
 */

/** 组件的工作模式。 */
export type InfoFormMode = 'bound' | 'staged'

/** 由当前的 gameId 决定模式。 */
export function infoFormMode(gameId: string | undefined | null): InfoFormMode {
  // ⚠️ 空串也算 staged：`gameId: ''` 与 undefined 在"元数据能不能落盘"这件事上等价
  // （主进程 saveGameMeta 要求 id 必须存在且是数字）
  const id = typeof gameId === 'string' ? gameId.trim() : ''
  return id ? 'bound' : 'staged'
}

/**
 * 某个动作在当前模式下**要不要真的写盘**。
 *
 * 只有 `bound` 模式会写。`staged` 一律不写 —— 那正是"先预览、后统一提交"。
 *
 * 为什么写成白名单而不是"if bound"：将来加动作时，这里会提醒你重新想一遍
 * "它在 staged 下该怎么办"。
 */
export type InfoFormAction =
  | 'saveMeta' // 保存预览结果
  | 'refreshMeta' // 用已存 RJ 重新拉取
  | 'forceRefresh' // 强制覆盖全部
  | 'clearMeta' // 清除 DLsite 信息
  | 'commitField' // 保存单个可编辑字段
  | 'resetField' // 重置单个字段

export function shouldPersist(mode: InfoFormMode, action: InfoFormAction): boolean {
  if (mode === 'bound') return true
  // staged 模式下，这些落盘动作全部转为内存操作（见 staged-work.ts 的 applyStaged*）
  switch (action) {
    case 'saveMeta':
    case 'refreshMeta':
    case 'forceRefresh':
    case 'clearMeta':
    case 'commitField':
    case 'resetField':
      return false
  }
}

/** 「保存」按钮上的文案身份（两处措辞不同，不能共用同一句）。 */
export type SaveLabel = 'save' | 'applyToNewGame'

/**
 * 「保存」按钮该显示什么。
 *
 * · bound   → 「保存」（就是落盘）
 * · staged  → 「用于新游戏」——不说清的话，用户以为是立刻存进了库，
 *             而实际上要等向导最后那一步才提交（那会产生"我保存了但库里没有"的困惑）
 */
export function saveLabel(mode: InfoFormMode): SaveLabel {
  return mode === 'bound' ? 'save' : 'applyToNewGame'
}

/**
 * 向导完成后要提交的元数据。
 *
 * `staged` 模式下用户可能查了元数据但**没点任何保存** —— 那时该不该提交？
 *
 * 判断：**只要有预览结果就提交**。理由：
 *   · 用户查到并看到了"这是对的游戏"这个动作本身就是选择
 *   · 若不提交，他会在库页看到一条没有封面的记录，又得回编辑页重查一遍 ——
 *     正是 U7 要消灭的那种来回
 *   · 而"查到了但故意不要"的场景：他可以点「清除」把 preview 置空
 */
export function stagedMetaToCommit(preview: unknown): unknown | null {
  // ⚠️ 必须挡数组：`typeof [] === 'object'`，空数组会被当成一个"有效元数据"提交上去，
  // 而主进程的 sanitize 会把它判成 error.dlsiteParse（报错但用户不知道哪里来的）
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return null
  return preview
}

/**
 * staged 模式下的字段编辑「提交」该怎么落。
 *
 * 在 bound 模式下，`commitEdit` 会 `saveGameMeta`（整条写 + editedFields 并集）。
 * staged 模式下没有落盘对象，所以只能**就地改内存里的那一份**。
 *
 * ⚠️ 这里返回的是「next work」而不是原地改：调用方（Vue 组件）需要拿到新对象
 * 才能触发响应式更新（改 reactive 对象的字段也行，但返回新对象更明确）。
 *
 * 注意 `editedFields` 的语义与主进程一致：**并集**，不是替换。
 * 漏掉这一点会导致"用户改了标题，下次刷新被 DLsite 值冲掉"（那正是 D26 要防的）。
 */
export function applyStagedField(
  work: unknown,
  field: string,
  draft: string
): { next: Record<string, unknown>; editedFields: string[] } | { error: 'invalid-price' | 'invalid-cover' } {
  if (!work || typeof work !== 'object' || Array.isArray(work)) return { error: 'invalid-price' }
  const source = { ...(work as Record<string, unknown>) }
  const trimmed = draft.trim()

  if (field === 'price') {
    if (trimmed === '') source.price = undefined
    else {
      // ⚠️ 先剥非数字再判，但**剥完为空要当非法**：
      // `'abc'.replace(/[^\d.-]/g,'')` → `''`，而 `Number('') === 0` ——
      // 于是「abc」会被静默存成价格 0（最糟的那种错：不报错、数字还是"合理"的）。
      // 原实现（编辑页 commitEdit）有同样的隐患，这里一并修掉。
      const digits = trimmed.replace(/[^\d.-]/g, '')
      if (!digits) return { error: 'invalid-price' }
      const parsed = Number(digits)
      if (!Number.isFinite(parsed)) return { error: 'invalid-price' }
      source.price = parsed
    }
  } else if (field === 'coverUrl') {
    // 封面必须是 img.dlsite.jp（D22 保存时也会再校一次；这里提前给友好提示）
    if (trimmed && !/^https:\/\/img\.dlsite\.jp\//i.test(trimmed)) return { error: 'invalid-cover' }
    source.coverUrl = trimmed || undefined
  } else {
    source[field] = trimmed || undefined
  }

  const previous = Array.isArray(source.editedFields)
    ? source.editedFields.filter((item): item is string => typeof item === 'string')
    : []
  const editedFields = previous.includes(field) ? previous : [...previous, field]
  source.editedFields = editedFields
  return { next: source, editedFields }
}

/** staged 模式下的「重置单个字段」：从 editedFields 里摘掉它。 */
export function applyStagedReset(
  work: unknown,
  field: string
): { next: Record<string, unknown>; editedFields: string[] } | null {
  if (!work || typeof work !== 'object' || Array.isArray(work)) return null
  const source = { ...(work as Record<string, unknown>) }
  const previous = Array.isArray(source.editedFields)
    ? source.editedFields.filter((item): item is string => typeof item === 'string')
    : []
  const editedFields = previous.filter((item) => item !== field)
  source.editedFields = editedFields
  return { next: source, editedFields }
}
