// 游戏库 store（§4 library.ts）：所有变更后用主进程返回的 Snapshot 覆盖本地状态。
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { api, type DetectFolderResult, type GameDraft, type GameRecord, type Snapshot } from '@/api/client'

export const useLibraryStore = defineStore('library', () => {
  const games = ref<GameRecord[]>([])
  const loading = ref(false)
  const search = ref('')
  const tagFilter = ref<string | null>(null)

  /** 用 Snapshot 整体覆盖（唯一的状态来源）。 */
  function applySnapshot(snapshot: Snapshot): void {
    games.value = snapshot.games
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
      if (tagFilter.value && !(game.tags ?? []).includes(tagFilter.value)) return false
      if (!keyword) return true
      if (game.gameTitle.toLowerCase().includes(keyword)) return true
      return (game.tags ?? []).some((tag) => tag.toLowerCase().includes(keyword))
    })
  })

  function byId(id: string): GameRecord | undefined {
    return games.value.find((game) => game.id === id)
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

  function clearFilters(): void {
    search.value = ''
    tagFilter.value = null
  }

  return {
    games,
    loading,
    search,
    tagFilter,
    tags,
    filtered,
    byId,
    load,
    saveGame,
    removeGame,
    launch,
    detectFolder,
    applySnapshot,
    clearFilters
  }
})
