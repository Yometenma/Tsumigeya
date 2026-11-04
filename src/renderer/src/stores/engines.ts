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
  /**
   * 「可安装」的引擎 = 主进程 registry 里那四个（M4.1 D60）。
   *
   * ⚠️ 名字保留 `remoteModules` 是因为**契约不变**（IPC 命令名 / Snapshot 字段名都还叫这个），
   * 但语义已经变了：它不再是「从 GitHub 拉回来的远端列表」，而是「本地 registry 产出的清单」。
   * 改名的代价要动 preload / client.ts / Snapshot 三处，收益只是名字更准 —— 不值得。
   */
  const remoteModules = ref<RemoteModule[]>([])
  const engineUpdates = ref<EngineUpdateReport | null>(null)
  /**
   * 正在刷新「可安装」列表（刷新按钮的 loading）。
   *
   * M4.1 S6：原来的 `remoteError` 已删除 —— 列表现在来自本地 registry，
   * 「远程列表拉失败」这个场景不存在了（页面也不再展示那条告警）。
   * 拉取失败仍然 console.warn 留痕（见 loadRemote），只是不再给用户一条假警报。
   */
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
    () => (engineUpdates.value?.updates ?? []).filter((item) => item.moduleUpdate).length
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
    try {
      remoteModules.value = await api.remoteModules()
    } catch (error) {
      // M4.1 S6：这条命令**理论上不会失败**（读本地 registry，零网络）。
      // 真失败了就是代码问题，所以只留痕、不弹告警 —— 弹一条「无法获取远程引擎列表」
      // 会误导用户去查网络，而根本没有网络参与。
      console.warn(`[tsumigeya] 读取可安装引擎列表失败：${(error as Error).message}`)
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
