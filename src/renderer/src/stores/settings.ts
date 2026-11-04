// 设置 store（§4 settings.ts）：settings / dataPath / 保存（外观即时生效）。
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api, type Settings, type Snapshot } from '@/api/client'

const DEFAULT_SETTINGS: Settings = {
  listView: false,
  deletionConfirmation: true,
  nonInstalledAutodetect: true,
  checkModuleUpdatesOnStartup: true,
  appearance: 'system',
  language: 'system',
  // 与主进程 games-store.ts 的 DEFAULT_SETTINGS 保持一致：默认打码。
  showAdultCovers: false,
  // M2.5-C：§7-① 用户确认 —— 首选中文（中文用户）、次选日文（玩日系游戏）。
  preferredLanguage: 'zh',
  fallbackLanguage: 'ja',
  // §7-⑤ 用户确认：弹确认，但可以「不再询问」。
  languageSwitchPrompt: true,
  // M3：启动前自动诊断，默认开（方案 §4.3；嫌慢可在设置页关掉）。
  diagnoseBeforeLaunch: true
}

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<Settings>({ ...DEFAULT_SETTINGS })
  const dataPath = ref('')
  const dataDirWarning = ref<Snapshot['dataDirWarning']>(null)
  /**
   * M4.0 S6.5（D58）：数据目录切换的一次性说明。
   *
   * 主进程在 snapshot 里下发「该不该提示」的结论（判定与「只提示一次」的标记都在主进程，
   * 见 data-dir-notice.ts）。这里**只负责收集**，不判断。
   * 页面读到非 null 就弹一次 info，然后把本地值清空（避免同一会话里重复弹）。
   */
  const dataDirNotice = ref<string | null>(null)
  const appVersion = ref('')
  const nodeVersion = ref('')
  const platform = ref('')

  /** 把 appearance 落到 <html class="dark">（§4 SettingsPage：改外观立即生效）。 */
  function applyAppearance(): void {
    if (typeof document === 'undefined') return
    const prefersDark =
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-color-scheme: dark)').matches
        : false
    const dark = settings.value.appearance === 'dark' || (settings.value.appearance === 'system' && prefersDark)
    document.documentElement.classList.toggle('dark', dark)
  }

  function applySnapshot(snapshot: Snapshot): void {
    settings.value = snapshot.settings
    dataPath.value = snapshot.dataPath
    dataDirWarning.value = snapshot.dataDirWarning ?? null
    // 只在**还没有值时**赋值：后续 save() 拿到的 snapshot 里这一项恒为 null
    // （主进程已经落过标记），不该把已经收到的提示清掉。
    if (snapshot.dataDirNotice && !dataDirNotice.value) dataDirNotice.value = snapshot.dataDirNotice
    nodeVersion.value = snapshot.nodeVersion
    applyAppearance()
  }

  async function load(): Promise<void> {
    applySnapshot(await api.snapshot())
  }

  async function save(partial: Partial<Settings>): Promise<void> {
    const snapshot = await api.saveSettings(partial)
    applySnapshot(snapshot)
  }

  function initMeta(version: string, node: string, os: string): void {
    appVersion.value = version
    nodeVersion.value = node
    platform.value = os
  }

  /** 页面消费完提示后调用，避免同一会话重复弹。 */
  function consumeDataDirNotice(): void {
    dataDirNotice.value = null
  }

  return {
    settings,
    dataPath,
    dataDirWarning,
    dataDirNotice,
    consumeDataDirNotice,
    appVersion,
    nodeVersion,
    platform,
    applyAppearance,
    applySnapshot,
    load,
    save,
    initMeta
  }
})
