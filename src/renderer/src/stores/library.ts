// 游戏库 store（§4 library.ts）：所有变更后用主进程返回的 Snapshot 覆盖本地状态。
// M2：额外维护旁挂的 DLsite 元数据（snapshot.meta），**GameRecord 本身保持不变**（D18）。
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  api,
  type DetectFolderResult,
  type Diagnosis,
  type DiagnosisFix,
  type DlsiteSearchHit,
  type DlsiteWork,
  type EditableField,
  type GameDraft,
  type GameLanguage,
  type GameMeta,
  type GameRecord,
  type LanguageGroup,
  type LaunchResult,
  type PlayStat,
  type CategoryDef,
  type RepairResult,
  type RunningGameLite,
  type Snapshot,
  type StopGameResult
} from '@/api/client'
// 过 contextBridge 前必须把 Vue 的响应式 Proxy 剥成纯值，否则 structured clone 抛
// `An object could not be cloned.`（症状：点保存没反应，只弹一句英文）。见 plain.ts 注释。
import { toPlain } from '../../../shared/plain'
import { filterGames, unboundCount, type LibraryFilter } from '../../../shared/library-filter'
import {
  matchesCategory,
  normalizeAssignments,
  sortedCategories
} from '../../../shared/categories'

export const useLibraryStore = defineStore('library', () => {
  const games = ref<GameRecord[]>([])
  const meta = ref<Record<string, GameMeta>>({})
  const loading = ref(false)
  const search = ref('')  /**
   * M5.0 U4：只看未绑定（还没关联 DLsite 作品的游戏）。
   *
   * 原先是 `onlyWithMeta`（只看**有**封面的）—— 那是个装饰性筛选：
   * 有封面的游戏没什么要做的，找它们没有目的。
   * 现在的语义反转成**待办清单**：哪些游戏还没去绑 DLsite 商品。
   * 判据见 shared/library-filter.ts 的 isBoundMeta（必须真有 rj，不能只看键存在）。
   */
  const onlyUnbound = ref(false)
  /** M2.5-C：每个游戏识别出的语言（来自 languageGroups）。 */
  const languageOf = ref<Record<string, GameLanguage>>({})
  /** M2.5-C：每个游戏同组的**其他**语言版本（用于「也有 zh 版」标记）。 */
  const alternatesOf = ref<Record<string, Array<{ id: string; lang: GameLanguage }>>>({})
  /**
   * M3.5：正在运行的游戏（键 = gameId）。
   *
   * 唯一来源是主进程的进程表（D50：状态只在内存），这里只是**它的投影**。
   * 所以本 store 绝不自己往里写"猜测"——点启动成功不等于进程活着
   * （正规来源是 `gameStarted` 事件 + snapshot.running）。
   */
  const running = ref<Record<string, RunningGameLite>>({})
  /**
   * M5.0 N1：游玩记录（键 = gameId）。
   *
   * 与 `running` 的区别要说清：`running` 是**现在**在不在跑（内存里的进程表，D50），
   * 这里是**过去**玩了多少（落盘的 play-stats.json，D51）。两个都来自主进程，
   * 渲染层一律只做投影，绝不自己累加（否则关掉应用再开就对不上了）。
   */
  const playStats = ref<Record<string, PlayStat>>({})
  /**
   * M5.0 S7：自定义分类 —— 定义表 + 归属表。
   *
   * 与 meta 一样是**主进程的投影**：这里只存从 snapshot 拿到的副本，
   * 任何改动都走 api 再拿新 snapshot 覆盖（绝不本地先改再同步 —— 那样
   * 「已删分类但归属还在」这类中间态会短暂显示出来）。
   */
  const categoryDefs = ref<Record<string, CategoryDef>>({})
  const categoryAssignments = ref<Record<string, string[]>>({})

  /** 用 Snapshot 整体覆盖（唯一的状态来源）。 */
  function applySnapshot(snapshot: Snapshot): void {
    games.value = snapshot.games
    meta.value = snapshot.meta ?? {}
    playStats.value = snapshot.playStats ?? {}
    categoryDefs.value = snapshot.categories?.defs ?? {}
    categoryAssignments.value = snapshot.categories?.assignments ?? {}
    running.value = indexRunning(snapshot.running ?? [])
  }

  /** 列表 → gameId 索引。 */
  function indexRunning(list: RunningGameLite[]): Record<string, RunningGameLite> {
    const map: Record<string, RunningGameLite> = {}
    for (const item of list) map[item.gameId] = item
    return map
  }

  /** 某个游戏是否在运行。 */
  function isRunning(id: string): boolean {
    return !!running.value[id]
  }

  /**
   * 处理进程事件（`gameStarted` / `gameExited`）。
   *
   * 为什么要单独处理事件而不是只靠 snapshot：
   * 游戏是我们**自己**起的，进程退出时没有"下一次 snapshot"会去告诉 UI
   * （用户可能一直停在详情页不动）。事件是唯一的即时信号。
   */
  function handleProcessEvent(event: {
    event: string
    gameId?: string
    pid?: number
    startedAt?: string
  }): void {
    const id = event.gameId
    if (!id) return
    if (event.event === 'gameStarted') {
      running.value = {
        ...running.value,
        [id]: { gameId: id, pid: event.pid ?? 0, startedAt: event.startedAt ?? new Date().toISOString() }
      }
      return
    }
    if (event.event === 'gameExited') {
      const next = { ...running.value }
      delete next[id]
      running.value = next
    }
  }

  /**
   * 已知标签集合（供编辑页/向导的标签下拉用）。
   *
   * M5.0 U3：**库页的「按标签筛选」下拉已删**（DLsite 拿不到 genre，D19/D40，
   * 标签是纯手工的、几乎没人填 → 筛选下拉永远空着或一两个，没有意义）。
   * 但这个计算本身留着：编辑页要给用户列出「库里已有的标签」方便复用，
   * `tags` 字段也保留（上游 schema，D10）。
   */
  const tags = computed(() => {
    const set = new Set<string>()
    for (const game of games.value) {
      for (const tag of game.tags ?? []) if (tag.trim()) set.add(tag.trim())
    }
    return [...set].sort((a, b) => a.localeCompare(b))
  })

  /** M5.0 S2：筛选条件（判据在 shared/library-filter.ts，有单测）。 */
  const filter = computed<LibraryFilter>(() => ({ keyword: search.value, onlyUnbound: onlyUnbound.value }))

  const filtered = computed(() => {
    const base = filterGames(games.value, meta.value, filter.value)
    // M5.0 S7：分类筛选叠在搜索/未绑定之上（多归属：命中任一归属即通过）
    if (!categoryFilter.value) return base
    const active = categoryFilter.value
    return base.filter((game) => matchesCategory(categoriesOf(game.id), active))
  })

  /** M5.0 U4：「未绑定」有多少个（工具栏显示待办规模）。 */
  const unboundTotal = computed(() => unboundCount(games.value, meta.value))

  function byId(id: string): GameRecord | undefined {
    return games.value.find((game) => game.id === id)
  }

  /** 某游戏的 DLsite 元数据（没有就是 undefined，UI 走占位）。 */
  function metaFor(id: string): GameMeta | undefined {
    return meta.value[id]
  }

  async function load(): Promise<void> {
    loading.value = true
    try {
      applySnapshot(await api.snapshot())
    } finally {
      loading.value = false
    }
  }

  async function saveGame(id: string | undefined, draft: GameDraft): Promise<Snapshot> {
    // ⚠️ 必须 toPlain：draft 里的 `gameArgs` 来自 DynamicArgsForm 的双向绑定，
    // 是 reactive 代理树；直接传会撞 structured clone 失败（用户看到「保存没反应」）。
    const snapshot = await api.saveGame(id, toPlain(draft))
    applySnapshot(snapshot)
    return snapshot
  }

  async function removeGame(id: string): Promise<void> {
    applySnapshot(await api.deleteGame(id))
  }

  /**
   * M5.0 U1：批量删除（**逐个执行**，一个失败不中断后续）。
   *
   * 为什么不是「一次 IPC 删 N 个」：
   *   · 方案 §4.1 明确要求「逐个执行 + 进度反馈，不能一个失败全崩」；
   *   · 每条 deleteGame 都要写盘（games.json / library-meta / play-stats），
   *     合并成一次批量写要么全成功要么全失败，中途出错会让磁盘状态与内存状态分叉；
   *   · 主进程那边的 deleteGame 已经在写盘前校验存在性，逐条调用的失败信息更精确
   *     （能告诉用户「第几个没删掉」而不是一个笼统的失败）。
   *
   * ⚠️ 每次 deleteGame 都返回完整 Snapshot，所以这里**只用最后一次的结果**
   * 覆盖一次（不是每条都 applySnapshot —— 那会让界面在中间态闪）。
   * 中途某条失败时，已成功的那些仍在磁盘上，为了不让界面显示"没删"，
   * 最后一次成功的结果**照样应用**。
   */
  async function removeGames(
    ids: readonly string[],
    onProgress?: (done: number, total: number) => void
  ): Promise<{ removed: number; failed: Array<{ id: string; error: unknown }> }> {
    const total = ids.length
    const failed: Array<{ id: string; error: unknown }> = []
    let removed = 0
    let lastSnapshot: Snapshot | null = null
    for (let index = 0; index < total; index += 1) {
      const id = ids[index]!
      try {
        lastSnapshot = await api.deleteGame(id)
        removed += 1
      } catch (error) {
        failed.push({ id, error })
      }
      onProgress?.(index + 1, total)
    }
    // 只应用最后一次成功的结果（中间态不必闪一次）
    if (lastSnapshot) applySnapshot(lastSnapshot)
    return { removed, failed }
  }

  /**
   * 启动游戏（M3 §4.2 起返回结构化结果，不再只有 message）。
   *
   * `diagnoseAllowed=false` 表示「诊断框已经看过了，别再拦」——
   * 用户点「还是启动试试」时必须传 false，否则会反复弹同一个框（§9 R5）。
   *
   * **不在这里弹诊断框**：store 只管数据，弹窗交给页面（LibraryPage），
   * 这样「谁能启动、被拦了怎么办」的决策点只有一处，也便于探针断言 DOM。
   */
  async function launch(id: string, diagnoseAllowed = true): Promise<LaunchResult> {
    return api.launch(id, diagnoseAllowed)
  }

  /** M3：跑一次启动前诊断（纯本地、只读、绕队列）。 */
  async function diagnose(id: string): Promise<Diagnosis[]> {
    return api.diagnoseGame(id)
  }

  /**
   * M3.5：关闭游戏（主进程 SIGTERM → 5s → SIGKILL）。
   *
   * 成功后**不在这里**更新 `running`：进程真正退出时主进程会发 `gameExited`，
   * 那是唯一可信的信号（D50 的精神）。这里如果抢先删除，就会出现
   * 「UI 说已关闭、但进程其实还在强杀等待中」的不一致。
   */
  async function stopGame(id: string): Promise<StopGameResult> {
    return api.stopGame(id)
  }

  /** M3.5：从主进程拉一次运行态（详情页定时刷新 / 探针用）。 */
  async function refreshRunning(): Promise<void> {
    try {
      running.value = indexRunning(await api.runningGames())
    } catch {
      // 拉不到不影响页面使用（它只是状态标记）
    }
  }

  /** M3：执行一键修复；返回修复后的重诊断结果（UI 用它刷新对话框）。 */
  async function repair(id: string, fix: DiagnosisFix): Promise<RepairResult> {
    return api.repairGame(id, fix)
  }

  async function detectFolder(path: string, includeRemote?: boolean): Promise<DetectFolderResult> {
    return api.detectFolder(path, includeRemote)
  }

  /** 某个游戏的分类归属（归一到已知分类，丢掉悬空 id）。 */
  function categoriesOf(gameId: string): string[] {
    return normalizeAssignments(categoryAssignments.value[gameId], new Set(Object.keys(categoryDefs.value)))
  }

  /**
   * M5.0 S7：当前选中的分类筛选（`null` = 不筛；`UNCATEGORIZED_ID` = 只看未分类）。
   *
   * 放在 store 而不是 URL：点侧边栏的分类不该改路由（用户还是停在库页），
   * 而库页与侧边栏要共享这一份状态 —— store 是唯一不重复的放处。
   */
  const categoryFilter = ref<string | null>(null)

  /** 侧边栏用的分类列表（已排序）。 */
  const categoryList = computed(() => sortedCategories(categoryDefs.value))

  /**
   * 「未分类」的游戏数（某个归属都没有的）。
   *
   * 为什么按 `categoriesOf`（归一后）算，而不是看 assignments 里有没有键：
   * 归属表可能残留指向已删分类的 id —— 那种游戏**实际**未分类，
   * 但按"有没有键"算会被当成已分类，侧边栏的计数就与点进去看到的对不上。
   */
  const uncategorizedTotal = computed(
    () => games.value.filter((game) => categoriesOf(game.id).length === 0).length
  )

  /** 点侧边栏的分类 → 只筛这类游戏。 */
  function setCategoryFilter(id: string | null): void {
    categoryFilter.value = id
  }

  // ===== M5.0 S7：分类的四条写操作（全部拿新 snapshot 覆盖）=====

  async function createCategory(name: string): Promise<void> {
    applySnapshot(await api.createCategory(name))
  }

  async function renameCategory(id: string, name: string): Promise<void> {
    applySnapshot(await api.renameCategory(id, name))
  }

  async function deleteCategory(id: string): Promise<void> {
    applySnapshot(await api.deleteCategory(id))
  }

  async function assignCategory(id: string, gameIds: string[], remove?: boolean): Promise<void> {
    // 空数组直接返回：主进程那边会走一遍读改写，纯浪费时间
    if (gameIds.length === 0) return
    applySnapshot(await api.assignCategory(id, gameIds, remove))
  }

  /** M2：从游戏路径识别 RJ 候选（毫秒级、只读本地、绕队列）。 */
  async function detectRj(gamePath: string): Promise<string[]> {
    const result = await api.dlsiteDetectRJ(gamePath)
    return result.candidates
  }

  /** M2：只查询不落盘（失败不污染库）。 */
  async function lookupRj(rj: string, refresh?: boolean): Promise<DlsiteWork> {
    return api.dlsiteLookup(rj, refresh)
  }

  /**
   * M2.5-A：按名字搜索 DLsite，返回候选列表（只读、不写盘）。
   * **不自动选第一条**——搜索精度一般（实测搜「傭兵」首条不是目标作品），要让用户自己点选。
   */
  async function searchDlsite(keyword: string, category?: string): Promise<DlsiteSearchHit[]> {
    const result = await api.dlsiteSearch(keyword, category)
    return result.results
  }

  /** M2：把查询结果落盘（用户点「保存」时才调）。 */
  async function saveGameMeta(
    gameId: string,
    work: DlsiteWork,
    editedFields?: EditableField[]
  ): Promise<Snapshot> {
    // 同上：work 也常来自响应式状态（编辑页的预览对象），统一剥成纯值。
    const snapshot = await api.saveGameMeta(gameId, { work: toPlain(work), editedFields })
    applySnapshot(snapshot)
    return snapshot
  }

  /**
   * M2：按已存的 RJ 重新获取并落盘。
   * `force:true` = §B.2 的「强制覆盖全部」（清空编辑标记，整体取 DLsite 值）。
   */
  async function refreshGameMeta(gameId: string, refresh?: boolean, force?: boolean): Promise<Snapshot> {
    const snapshot = await api.refreshGameMeta(gameId, refresh, force)
    applySnapshot(snapshot)
    return snapshot
  }

  /** M2：清除该游戏的 DLsite 信息（不动游戏记录本身）。 */
  async function clearGameMeta(gameId: string): Promise<void> {
    applySnapshot(await api.clearGameMeta(gameId))
  }

  /**
   * M2.5-C：多语言版本分组（纯本地计算、绕队列）。
   * 返回 groups 的同时派生两个查询用的 Map：
   * - `languageOf[id]` = 该游戏识别出的语言
   * - `alternatesOf[id]` = 同组的**其他**语言版本（用于卡片「也有 zh 版」标记）
   */
  async function loadLanguageGroups(threshold?: number): Promise<void> {
    try {
      const result = await api.languageGroups(threshold)
      applyLanguageGroups(result.groups)
    } catch {
      // 分组失败不能影响游戏库正常使用（它只是锦上添花的功能）
      applyLanguageGroups([])
    }
  }

  /** 纯本地更新（测试与探针可直接喂数据，不必走 IPC）。 */
  function applyLanguageGroups(groups: LanguageGroup[]): void {
    const language: Record<string, GameLanguage> = {}
    const alternates: Record<string, Array<{ id: string; lang: GameLanguage }>> = {}
    for (const group of groups) {
      for (const member of group.members) {
        language[member.id] = member.lang
        alternates[member.id] = group.members.filter((other) => other.id !== member.id)
      }
    }
    languageOf.value = language
    alternatesOf.value = alternates
  }

  /**
   * 清除全部筛选。
   *
   * M5.0 S7：**连分类筛选一起清**。侧边栏的分类是筛选的一种，
   * 用户点「清除筛选」时如果他正停在某个分类下，只清搜索的话
   * 列表看起来"还是空的"，那句「清除筛选」就等于没生效。
   */
  function clearFilters(): void {
    search.value = ''
    onlyUnbound.value = false
    categoryFilter.value = null
  }

  return {
    games,
    meta,
    running,
    loading,
    search,
    onlyUnbound,
    tags,
    filtered,
    unboundTotal,
    byId,
    metaFor,
    isRunning,
    playStats,
    categoryDefs,
    categoryFilter,
    setCategoryFilter,
    categoryList,
    categoriesOf,
    uncategorizedTotal,
    createCategory,
    renameCategory,
    deleteCategory,
    assignCategory,
    handleProcessEvent,
    refreshRunning,
    load,
    saveGame,
    removeGame,
    removeGames,
    launch,
    stopGame,
    diagnose,
    repair,
    detectFolder,
    detectRj,
    lookupRj,
    searchDlsite,
    languageOf,
    alternatesOf,
    loadLanguageGroups,
    applyLanguageGroups,
    saveGameMeta,
    refreshGameMeta,
    clearGameMeta,
    applySnapshot,
    clearFilters
  }
})
