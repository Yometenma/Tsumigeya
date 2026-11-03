// 引擎 store（§4 engines.ts）：modules / remoteModules / engineUpdates / 长任务走 task store。
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import {
  api,
  type EngineUpdateReport,
  type ModuleInfo,
  type RemoteModule,
  type Snapshot
} from '@/api/client'

export interface EngineAction {
  folder: string
  action: 'install' | 'update' | 'dependencies' | 'uninstall'
  label: string
}

export const useEnginesStore = defineStore('engines', () => {
  const modules = ref<ModuleInfo[]>([])
  const remoteModules = ref<RemoteModule[]>([])
  const engineUpdates = ref<EngineUpdateReport | null>(null)
  const remoteError = ref<string | null>(null)
  const loadingRemote = ref(false)
  const search = ref('')

  const installedFolders = computed(() => new Set(modules.value.map((module) => module.id)))

  const installed = computed(() => {
    const keyword = search.value.trim().toLowerCase()
    return modules.value.filter((module) => match(module.name, module.id, keyword))
  })

  const available = computed(() => {
    const keyword = search.value.trim().toLowerCase()
    return remoteModules.value
      .filter((module) => !installedFolders.value.has(module.folder))
      .filter((module) => match(module.name, module.folder, keyword))
  })

  const updatesById = computed(() => {
    const map = new Map<string, EngineUpdateReport['updates'][number]>()
    for (const item of engineUpdates.value?.updates ?? []) map.set(item.id, item)
    return map
  })

  const updateCount = computed(
    () => (engineUpdates.value?.updates ?? []).filter((item) => item.moduleUpdate || item.dependencyUpdate).length
  )

  function match(name: string | undefined, folder: string | undefined, keyword: string): boolean {
    if (!keyword) return true
    return (name ?? '').toLowerCase().includes(keyword) || (folder ?? '').toLowerCase().includes(keyword)
  }

  function applySnapshot(snapshot: Snapshot): void {
    modules.value = snapshot.modules
    if (snapshot.engineUpdates) engineUpdates.value = snapshot.engineUpdates
  }

  async function load(): Promise<void> {
    applySnapshot(await api.snapshot())
  }

  async function loadRemote(): Promise<void> {
    loadingRemote.value = true
    remoteError.value = null
    try {
      remoteModules.value = await api.remoteModules()
    } catch (error) {
      remoteError.value = (error as Error).message
    } finally {
      loadingRemote.value = false
    }
  }

  /**
   * 跑一个模块任务。label 用于进度浮层的文案。
   * 返回的 Snapshot 会覆盖 modules。
   */
  function runTask(entry: EngineAction): { requestId: string; promise: Promise<Snapshot> } {
    return api.moduleTask(entry.folder, entry.action)
  }

  function checkUpdates(): { requestId: string; promise: Promise<EngineUpdateReport> } {
    return api.checkEngineUpdates(false)
  }

  function updateAll(): { requestId: string; promise: Promise<Snapshot> } {
    return api.updateAllEngines()
  }

  return {
    modules,
    remoteModules,
    engineUpdates,
    remoteError,
    loadingRemote,
    search,
    installedFolders,
    installed,
    available,
    updatesById,
    updateCount,
    applySnapshot,
    load,
    loadRemote,
    runTask,
    checkUpdates,
    updateAll
  }
})
