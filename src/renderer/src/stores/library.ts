// 游戏库 store（§4 library.ts）：所有变更后用主进程返回的 Snapshot 覆盖本地状态。
// M2：额外维护旁挂的 DLsite 元数据（snapshot.meta），**GameRecord 本身保持不变**（D18）。
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  api,
  type DetectFolderResult,
  type DlsiteSearchHit,
  type DlsiteWork,
  type GameDraft,
  type GameMeta,
  type GameRecord,
  type Snapshot
} from '@/api/client'

export const useLibraryStore = defineStore('library', () => {
  const games = ref<GameRecord[]>([])
  const meta = ref<Record<string, GameMeta>>({})
  const loading = ref(false)
  const search = ref('')
  const tagFilter = ref<string | null>(null)
  /** 只看有封面的游戏（纯本地筛选，不新增 settings 键，方案 §6.3）。 */
  const onlyWithMeta = ref(false)

  /** 用 Snapshot 整体覆盖（唯一的状态来源）。 */
  function applySnapshot(snapshot: Snapshot): void {
    games.value = snapshot.games
    meta.value = snapshot.meta ?? {}
  }

  const tags = computed(() => {
    const set = new Set<string>()
    for (const game of games.value) {
      for (const tag of game.tags ?? []) if (tag.trim()) set.add(tag.trim())
    }
    return [...set].sort((a, b) => a.localeCompare(b))
  })

  const filtered = computed(() => {
    const keyword = search.value.trim().toLowerCase()
    return games.value.filter((game) => {
      const gameMeta = meta.value[game.id]
      if (onlyWithMeta.value && !gameMeta) return false
      if (tagFilter.value && !(game.tags ?? []).includes(tagFilter.value)) return false
      if (!keyword) return true
      if (game.gameTitle.toLowerCase().includes(keyword)) return true
      if ((game.tags ?? []).some((tag) => tag.toLowerCase().includes(keyword))) return true
      // M2：日文原名 / 社团名也可搜——用户库里存的常是中文译名，想搜原名就靠这条
      if (gameMeta?.title?.toLowerCase().includes(keyword)) return true
      if (gameMeta?.circle?.toLowerCase().includes(keyword)) return true
      if (gameMeta?.rj?.toLowerCase().includes(keyword)) return true
      return false
    })
  })

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
    const snapshot = await api.saveGame(id, draft)
    applySnapshot(snapshot)
    return snapshot
  }

  async function removeGame(id: string): Promise<void> {
    applySnapshot(await api.deleteGame(id))
  }

  async function launch(id: string): Promise<string> {
    const result = await api.launch(id)
    return result.message
  }

  async function detectFolder(path: string, includeRemote?: boolean): Promise<DetectFolderResult> {
    return api.detectFolder(path, includeRemote)
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
  async function saveGameMeta(gameId: string, work: DlsiteWork): Promise<Snapshot> {
    const snapshot = await api.saveGameMeta(gameId, { work })
    applySnapshot(snapshot)
    return snapshot
  }

  /** M2：按已存的 RJ 重新获取并落盘。 */
  async function refreshGameMeta(gameId: string, refresh?: boolean): Promise<Snapshot> {
    const snapshot = await api.refreshGameMeta(gameId, refresh)
    applySnapshot(snapshot)
    return snapshot
  }

  /** M2：清除该游戏的 DLsite 信息（不动游戏记录本身）。 */
  async function clearGameMeta(gameId: string): Promise<void> {
    applySnapshot(await api.clearGameMeta(gameId))
  }

  function clearFilters(): void {
    search.value = ''
    tagFilter.value = null
    onlyWithMeta.value = false
  }

  return {
    games,
    meta,
    loading,
    search,
    tagFilter,
    onlyWithMeta,
    tags,
    filtered,
    byId,
    metaFor,
    load,
    saveGame,
    removeGame,
    launch,
    detectFolder,
    detectRj,
    lookupRj,
    searchDlsite,
    saveGameMeta,
    refreshGameMeta,
    clearGameMeta,
    applySnapshot,
    clearFilters
  }
})
