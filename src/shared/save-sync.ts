// M4 S5：存档同步的**接口占位** -- 只声明契约，不实现任何一家云。
//
// ===== 用户原话与这个文件的边界 =====
//
// 「可以统一管理存档之类的，可以**预留**一下一些同步方案，给玩家自行选择之类的」
//
// 「预留」到什么程度（方案 §3.5 已定）：**只留接口，不实现**。
//
// ⚠️ **不接任何云**（Dropbox / iCloud / 自建服务器都不接）。
//    理由（D31 的精神：绝不动用户的东西）：
//      · 云要账号、要处理冲突、要传用户的存档（那里面可能有他不想上传的东西）
//      · 大多数人不需要 —— 手动导入导出（S3/S4）已经能解决"换机防丢档"
//      · 一个"半成品云同步"比没有更糟：用户会以为存档在云上，从而不再手动备份
//
// 所以这一层是**纯类型 + 纯判据**：设置页能选「无 / 手动导入导出」，
// 选「手动」时也只是把 S3/S4 那两个按钮的文案说清楚一点，**不做任何网络请求**。
//
// ⚠️ 零依赖：不 import vue / pinia / i18n / electron / fs（不碰网络也不碰盘）。
//    这样它能被纯 Node 的 vitest 直接测，也保证"没有实现"这件事是**结构性的**
//    —— 这个文件里没有任何 IO 能力可用。

/**
 * 一个同步方案提供方。
 *
 * ⚠️ **现在没有任何实现类**，这是刻意的（见文件头）。留着这份声明是为了：
 *   · 将来真要接某个方案时，形状已经定好（`pull` / `push` 双向）
 *   · 让"设置页那个下拉的选项"与"接口"从一开始就是同一套词汇
 *
 * 真要实现时，`pull` / `push` 必须遵守三条（先记在这里，免得将来走偏）：
 *   ① `pull` **不得**在游戏运行中执行（与 S3 导出同一个理由：半截文件）
 *   ② `push` 之前**必须**先在本地留一份（与 S4 导入的先备份同一条精神）
 *   ③ 任何失败都要能**降级到"手动模式"**，绝不能让用户的存档卡在一个半同步状态
 */
export interface SaveSyncProvider {
  /** 唯一 id（存设置里用，如 `manual`）。 */
  id: string
  /** i18n 键（设置页下拉的文案来源）。 */
  labelKey: string
  /**
   * 把某个游戏的存档**拉下来**到 `targetDir`。
   *
   * 语义：「用远端的覆盖本地」。实现方负责事务性（失败不留半截）。
   */
  pull(gameId: string, targetDir: string): Promise<void>
  /**
   * 把某个游戏的存档**推上去**。
   *
   * 语义：「用本地的覆盖远端」。
   */
  push(gameId: string, sourceDir: string): Promise<void>
}

/**
 * 同步模式的取值。
 *
 * `none`    = 不启用（默认）
 * `manual`  = 手动导入导出（**就是 S3/S4 那两个按钮**，没有别的）
 */
export type SaveSyncMode = 'none' | 'manual'

/** 默认模式：`none`。理由与"不接任何云"完全一致 —— 默认不该替用户做主。 */
export const DEFAULT_SAVE_SYNC_MODE: SaveSyncMode = 'none'

/** 全部可选模式（设置页下拉的选项来源，顺序 = 下拉里的顺序）。 */
export const SAVE_SYNC_MODES: readonly SaveSyncMode[] = ['none', 'manual'] as const

/**
 * 模式的 i18n 键。
 *
 * ⚠️ 这里是 `saveSyncModes.<mode>` 而不是 `saveSync.<mode>`：`saveSync` 本身是
 * 那个设置行的**标题**（字符串），不能再当对象用 —— 同一个键既做标题又做命名空间，
 * 在 JSON 里是重复键（后者覆盖前者），渲染出来是 `[object Object]`。
 */
export function saveSyncModeLabelKey(mode: SaveSyncMode): string {
  return `settings.saveSyncModes.${mode}`
}

/**
 * 校验一个来自磁盘/UI 的模式值。
 *
 * 与 `games-store.ts` 里 `validLanguagePreference` 同一取向：**非法值不报错，
 * 静默落回默认**。理由：这个开关不影响数据安全（它只是 UI 提示），
 * 而一个坏值让整个设置页读不出来才是更糟的降级。
 *
 * ⚠️ 与语言偏好那几项**刻意不同**：那几项决定"启动时会不会被提示"，
 * 静默改正会让用户以为设置没保存，所以那边是显式报错。
 */
export function validSaveSyncMode(value: unknown): SaveSyncMode {
  return value === 'manual' ? 'manual' : DEFAULT_SAVE_SYNC_MODE
}

/**
 * 这个模式下要不要显示导出/导入按钮。
 *
 * `none` 时**仍然显示**（这是本节最关键的一个决定）：
 * 把按钮藏起来等于让用户以为"没有导出功能"，而手动导入导出本来就是
 * 唯一真正能防丢档的手段。`none` 的语义是"我不需要同步方案"，
 * 不是"我不想备份"。
 *
 * ⇒ 所以这个函数对两个合法模式**恒返回 true**，存在的意义是：
 * ① 把"按钮永远在"写成**判据**而不是散落在模板里
 * ② 将来真加了云模式时，这里就是该分叉的地方（有测试守着它现在是恒 true）
 */
export function showsManualButtons(_mode: SaveSyncMode): boolean {
  return true
}

/**
 * 设置页那条提示文案要不要带「占位」说明。
 *
 * 只在 `manual` 时显示一句「这只是手动，不会上传任何东西」——
 * 让用户明白我们**没有**偷偷联网。`none` 时不需要（什么都没发生）。
 */
export function needsManualDisclaimer(mode: SaveSyncMode): boolean {
  return mode === 'manual'
}
