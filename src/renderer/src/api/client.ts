// 渲染层唯一的类型来源 + IPC 调用封装（§3.2 数据结构、§3.5 桥、§3.9 错误本地化）。
// 主进程侧的同名类型是各自独立的实现，改动时三处同步：src/main/ipc.ts、src/preload/index.ts、本文件。

// ===== 数据结构（§3.2）=====

export interface GameRecord {
  id: string
  gameTitle: string
  gamePath: string
  iconPath?: string
  tags?: string[]
  gameEngine: string
  gameArgs?: Record<string, unknown>
}

export interface GameDraft extends Omit<GameRecord, 'id'> {
  id?: string
}

export type Appearance = 'light' | 'dark' | 'system'

export interface Settings {
  listView: boolean
  deletionConfirmation: boolean
  nonInstalledAutodetect: boolean
  checkModuleUpdatesOnStartup: boolean
  appearance: Appearance
  language: string
}

export interface GameArgDef {
  type: 'boolean' | 'text' | 'int' | 'float' | 'dropdown' | 'select' | 'multi-version' | 'array'
  label?: string
  default?: unknown
  options?: Array<{ label?: string; value?: string | number }> | string[]
  'version-script'?: string
}

export interface ManifestAutodetect {
  extensions?: string[]
  extension?: string
  files?: string[]
  all_required?: boolean
}

export interface ManifestRaw {
  name?: string
  version?: string
  author?: string
  description?: string
  autodetect?: ManifestAutodetect
  gameArgs?: Record<string, GameArgDef>
  [key: string]: unknown
}

export interface ModuleInfo {
  id: string
  name: string
  version: string
  author: string
  description: string
  raw: ManifestRaw
}

export interface RemoteModule {
  id: string
  folder: string
  name: string
  version: string
  author: string
  description: string
  raw: ManifestRaw
}

export interface EngineUpdate {
  id: string
  localVersion: string
  remoteVersion: string
  moduleUpdate: boolean
  dependencyUpdate: boolean
  checkFailed: boolean
}

export interface EngineUpdateReport {
  checkedAt: string
  cachedRemote: boolean
  warnings: string[]
  remoteModules: RemoteModule[]
  updates: EngineUpdate[]
}

export interface Snapshot {
  games: GameRecord[]
  modules: ModuleInfo[]
  settings: Settings
  dataPath: string
  nodeVersion: string
  engineUpdates: EngineUpdateReport | null
}

export interface DetectCandidate {
  path: string
  engine: string | null
  installed: boolean
}

export interface DetectFolderResult {
  path: string
  isFile: boolean
  best: DetectCandidate | null
  candidates: DetectCandidate[]
}

export interface CoreEvent {
  event: 'progress' | 'log' | 'dialog' | 'ready'
  requestID?: string
  name?: string
  key?: string
  detail?: unknown
  arguments?: Record<string, string>
  message?: string
  dialogID?: string
  kind?: 'alert' | 'confirm'
  title?: string
  nodeVersion?: string
}

// ===== 桥（§3.5）=====

export interface TsumiBridge {
  invoke<T>(method: string, params?: unknown): Promise<T>
  startTask<T>(method: string, params?: unknown): { requestId: string; promise: Promise<T> }
  cancel(requestId: string): void
  dialogReply(dialogId: string, accepted: boolean): void
  pickPath(kind: 'file' | 'folder'): Promise<string | null>
  /** 拖拽的 File → 绝对路径（Electron 32+ 必须走 webUtils，File.path 已移除）。 */
  pathForFile(file: File): string | null
  onEvent(listener: (event: CoreEvent) => void): () => void
  readonly platform: string
  readonly appVersion: string
}

/** 带翻译键的 IPC 错误。 */
export interface TsumiError extends Error {
  key?: string
  arguments?: Record<string, unknown>
}

export function bridge(): TsumiBridge {
  const value = (globalThis as unknown as { tsumi?: TsumiBridge }).tsumi
  if (!value) throw new Error('window.tsumi is unavailable (preload did not load)')
  return value
}

// ===== api.*（全部走同一条 invoke 路径）=====

export const api = {
  snapshot: (): Promise<Snapshot> => bridge().invoke<Snapshot>('snapshot'),

  saveGame: (id: string | undefined, game: GameDraft): Promise<Snapshot> =>
    bridge().invoke<Snapshot>('saveGame', { id, game }),

  saveSettings: (settings: Partial<Settings>): Promise<Snapshot> =>
    bridge().invoke<Snapshot>('saveSettings', settings),

  deleteGame: (id: string): Promise<Snapshot> => bridge().invoke<Snapshot>('deleteGame', { id }),

  launch: (id: string): Promise<{ message: string }> => bridge().invoke('launch', { id }),

  detect: (path: string, includeRemote?: boolean): Promise<{ engine: string | null; installed: boolean }> =>
    bridge().invoke('detect', { path, includeRemote }),

  detectFolder: (path: string, includeRemote?: boolean): Promise<DetectFolderResult> =>
    bridge().invoke<DetectFolderResult>('detectFolder', { path, includeRemote }),

  remoteModules: (): Promise<RemoteModule[]> => bridge().invoke<RemoteModule[]>('remoteModules'),

  /** 长任务：返回 requestId 供取消。 */
  checkEngineUpdates: (forceRefresh?: boolean) =>
    bridge().startTask<EngineUpdateReport>('checkEngineUpdates', { forceRefresh }),

  updateAllEngines: () => bridge().startTask<Snapshot>('updateAllEngines'),

  moduleTask: (folder: string, action: 'install' | 'update' | 'dependencies' | 'uninstall') =>
    bridge().startTask<Snapshot>('moduleTask', { folder, action }),

  installedVersions: (folder: string, argKey: string): Promise<string[]> =>
    bridge().invoke<string[]>('installedVersions', { folder, argKey }),

  versions: (
    folder: string,
    argKey: string
  ): Promise<{ installed: string[]; available: Record<string, unknown> }> =>
    bridge().invoke('versions', { folder, argKey }),

  installVersion: (folder: string, argKey: string, version: string) =>
    bridge().startTask<{ installed: string[]; available: Record<string, unknown> }>('installVersion', {
      folder,
      argKey,
      version
    }),

  removeVersion: (folder: string, argKey: string, version: string): Promise<{ installed: string[] }> =>
    bridge().invoke('removeVersion', { folder, argKey, version }),

  openFolder: (path: string): Promise<{ ok: true }> => bridge().invoke('openFolder', { path }),

  openExternal: (url: string): Promise<{ ok: true }> => bridge().invoke('openExternal', { url }),

  pickPath: (kind: 'file' | 'folder'): Promise<string | null> => bridge().pickPath(kind)
}

// ===== 图片 URL（§3.7）=====

/** 绝对路径 → tsmg:// 图片 URL；无路径返回 undefined（UI 走占位）。 */
export function iconUrl(filePath?: string): string | undefined {
  if (!filePath) return undefined
  return `tsmg://img/${encodeURIComponent(filePath)}`
}

// ===== 错误本地化（§3.9）=====

type Translate = (key: string, args?: Record<string, unknown>) => string

/**
 * 主进程只给 key；渲染层查 locales 的 error.*。
 * 查不到（或没有 key）时退回 message 原文。
 */
export function translateError(error: unknown, t: Translate): string {
  const candidate = error as TsumiError | undefined
  if (candidate?.key) {
    const translated = t(candidate.key, candidate.arguments)
    // vue-i18n 查不到时会原样返回 key，此时退回 message
    if (translated && translated !== candidate.key) return translated
  }
  return candidate?.message ?? String(error)
}
