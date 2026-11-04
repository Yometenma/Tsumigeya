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

/** M2.5-C：可识别的语言。 */
export type GameLanguage = 'zh' | 'ja' | 'en' | 'ko'

/** M2.5-C：语言偏好值（`none` = 不启用）。 */
export type LanguagePreference = GameLanguage | 'none'

export interface Settings {
  listView: boolean
  deletionConfirmation: boolean
  nonInstalledAutodetect: boolean
  checkModuleUpdatesOnStartup: boolean
  appearance: Appearance
  language: string
  /**
   * 是否在界面上显示 R18 作品的封面（默认 false = 打码）。
   *
   * 说明：**只影响渲染，不影响抓取与存储**。元数据照常拉取并落盘，
   * 开启后立刻可见，无需重新请求。覆盖面判定见 `isAdultWork()`。
   */
  showAdultCovers: boolean
  /** M2.5-C：首选语言（默认 zh）。 */
  preferredLanguage: LanguagePreference
  /** M2.5-C：次选语言（默认 ja）。 */
  fallbackLanguage: LanguagePreference
  /** M2.5-C：启动非偏好语言版时是否弹确认（可「不再询问」关掉）。 */
  languageSwitchPrompt: boolean
  /** M3：启动前是否自动跑故障诊断（默认 true）。 */
  diagnoseBeforeLaunch: boolean
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
  /** 数据目录被降级时非 null：{ requested, switchedTo, code }。 */
  dataDirWarning: { requested: string; switchedTo: string; code: string } | null
  nodeVersion: string
  engineUpdates: EngineUpdateReport | null
  /** M2：DLsite 旁挂元数据（键 = gameId）。没有元数据的游戏不会出现在这里。 */
  meta: Record<string, GameMeta>
  /** M3.5：正在运行的游戏（运行时状态，不落盘）。 */
  running: RunningGameLite[]
  /**
   * M4.0 S6.5（D58）：数据目录切换的一次性中文说明。
   * 有值 = 这次该给用户看（info，不是错误）；null = 不提示。
   */
  dataDirNotice: string | null
}

/** M3.5：运行态条目（snapshot 里的投影）。 */
export interface RunningGameLite {
  gameId: string
  pid: number
  startedAt: string
}

/** M3.5：进程表的完整条目（`runningGames` 命令返回）。 */
export interface RunningGame extends RunningGameLite {
  engine: string
  /** 上游传给 exec 的原始命令串（诊断用）。 */
  command: string
  /** 从命令串里抠出的可执行文件路径（无法解析时为 null）。 */
  execPath: string | null
}

/** M3.5：关闭游戏的结果（`stopGame`）。 */
export interface StopGameResult {
  ok: boolean
  /** `terminated` = SIGTERM 就退了；`killed` = 5 秒没退，走了 SIGKILL。 */
  action: 'terminated' | 'killed'
  /** i18n key（渲染层自己查 locales）。 */
  messageKey: string
}

/** M3.5：游玩记录（`play-stats.json` 里的条目）。 */
export interface PlayStat {
  lastPlayedAt: string
  playCount: number
  totalSeconds: number
}

// ===== M2：DLsite 元数据（docs/M2-实施方案.md §3.4）=====

/**
 * 一个作品的 DLsite 元数据。字段来源是页面末尾 `var contents` 的 JSON + og 标签。
 * **注意：没有 genre / 标签**——调研实测拿不到，M2 不承诺（方案 §1.3 N1）。
 */
export interface DlsiteWork {
  /** 规范化大写，如 RJ294126。 */
  rj: string
  title: string
  titleFull?: string
  circle?: string
  circleId?: string
  seriesName?: string
  category?: string
  /** 作品类型（SOU 等），只是展示用，不是标签。 */
  workType?: string
  registDate?: string
  price?: number
  priceWithTax?: number
  officialPrice?: number
  discount?: number
  /** 已校验主机 ∈ img.dlsite.jp 的 https 绝对地址。 */
  coverUrl?: string
  /** `og:description` 原值（含站点广告尾巴，**不要直接渲染**）。 */
  description?: string
  /**
   * M2.6 §3.3：**清洗过**的简介（已剥掉「国内最大級の二次元…」那段站点自述）。
   * UI 一律渲染这个，不是 `description`。
   */
  summary?: string
  /** M2.6 §3.1：作者（只在搜索结果页有，详情页 `contents` 不含）。 */
  author?: string
  /** M2.6 §3.1：销量。 */
  salesCount?: number
  /** M2.6 §3.1：评分 0–5。缺省 = 无评分，**不是 0 分**。 */
  rating?: number
  fetchedAt: string
  /** M2.5-B：该条目是否被用户手动编辑过（由 editedFields 派生）。 */
  edited?: boolean
  /** M2.5-B：哪些字段是用户改的（后续刷新不覆盖这些字段，见 §B.2）。 */
  editedFields?: EditableField[]
}

/** 落盘的元数据条目（= DlsiteWork，单独起名方便 UI 读）。 */
export type GameMeta = DlsiteWork

// ===== M2.5-B：可编辑元数据（docs/M2.5-实施方案.md §B）=====

/**
 * 可被用户手动编辑的字段白名单（§B.3，用户 2026-11-04 确认这五个）。
 * **不含 `rj`**：改 RJ 等于换作品，应该走「重新搜索 / 填 RJ」流程。
 * 与主进程 `src/main/library-meta.ts` 的 EDITABLE_FIELDS 必须保持一致。
 */
export const EDITABLE_FIELDS = ['title', 'circle', 'coverUrl', 'registDate', 'price'] as const

export type EditableField = (typeof EDITABLE_FIELDS)[number]

// ===== M2.5-C：多语言版本偏好（docs/M2.5-实施方案.md §C）=====

/** 一个多语言版本组（算法见 src/shared/language-group.ts）。 */
export interface LanguageGroup {
  /** 归一化后的组标题（仅展示/调试用）。 */
  base: string
  /** 成员：游戏 id + 该成员识别出的语言。 */
  members: Array<{ id: string; lang: GameLanguage }>
}

// ===== M2.5-A：按名字搜索（docs/M2.5-实施方案.md §A.1）=====

/**
 * 一条搜索结果。
 * `title` 已经过滤掉 DLsite 页面上的噪音按钮文案（カートに追加 等）。
 * 搜索结果**精度一般**（实测搜「傭兵」首条不是目标作品），所以 UI 必须让用户自己点选。
 */
export interface DlsiteSearchHit {
  /** 规范化大写，如 RJ294126。 */
  rj: string
  title: string
  /** 从链接 URL 的 section 段推断：maniax / homepro / pro / books。 */
  category?: string
  /** 缩略图（已校验 host ∈ img.dlsite.jp）。 */
  coverUrl?: string
  /** M2.6 §3.1：作者（`maker_name` 里的 `<span class="author">`，不是社团）。 */
  author?: string
  /** M2.6 §3.1：销量。 */
  salesCount?: number
  /** M2.6 §3.1：评分 0–5（缺省 = 无评分）。 */
  rating?: number
}

export interface DlsiteSearchResult {
  keyword: string
  results: DlsiteSearchHit[]
}

// ===== M3：启动前诊断（docs/M3-实施方案.md §3.1 / §4）=====

export type DiagnosisLevel = 'fatal' | 'warning' | 'info'

/**
 * 诊断条目的稳定标识。UI 与 i18n 用它查文案（键是 `diagnose.<code>`）。
 * 与主进程 `src/main/diagnose.ts` 的 DiagnosisCode 必须保持一致。
 */
export type DiagnosisCode =
  | 'encryptedArchive'
  | 'missingRtp'
  | 'missingExecutable'
  | 'moduleMissing'
  | 'pathGone'
  | 'fontsPresent'

/**
 * 能一键修的动作。修不了（或只能引导用户自己动手）的条目没有 `fix`。
 * `openFolder` 只负责「打开目录让用户自己看」，**不是**「自动解包加密发行」（D34）。
 */
export type DiagnosisFix =
  | { kind: 'installRtp'; engine: string }
  | { kind: 'installModule'; engine: string }
  | { kind: 'openFolder'; path: string }
  | { kind: 'repoint' }

export interface Diagnosis {
  code: DiagnosisCode
  level: DiagnosisLevel
  /** i18n key（不是原文）。 */
  messageKey: string
  /** 文案占位符（只允许 `{simpleIdentifier}` 形式）。 */
  args?: Record<string, string>
  /** 能一键修的话指向哪个动作。 */
  fix?: DiagnosisFix
}

/**
 * `launch` 的返回（M3 §4.2 扩展）。
 * 用联合类型让调用方**必须**先判 `blocked`，否则读不到 `message`（TS 会报错）。
 */
export type LaunchResult = { message: string } | { blocked: true; diagnoses: Diagnosis[] }

/** `repairGame` 的返回：修完立刻带一份重诊断结果，UI 不用再请求一次。 */
export interface RepairResult {
  ok: boolean
  action: DiagnosisFix['kind']
  message: string
  diagnoses: Diagnosis[]
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
  event: 'progress' | 'log' | 'dialog' | 'ready' | 'gameStarted' | 'gameExited'
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
  /** M3.5：进程事件的字段（gameStarted / gameExited）。 */
  gameId?: string
  pid?: number
  engine?: string
  startedAt?: string
  exitCode?: number | null
  signal?: string | null
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

// key 的跨桥编解码实现放在 src/shared/bridge-error.ts（preload 与这里共享同一份），
// 原因：contextBridge 跨边界 throw 时会丢弃自定义属性，key 必须编进 message 才能活下来。
import { decodeBridgeError } from '../../../shared/bridge-error'

export { decodeBridgeError }

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

  /**
   * `launch`：正常返回 `{ message }`；被 fatal 诊断拦下时返回 `{ blocked, diagnoses }`。
   * **不抛错**——诊断框需要结构化数据，抛错会被 contextBridge 截断（见 bridge-error）。
   *
   * `diagnose:false` = 「诊断框已经看过了，别再拦」（用户点「还是启动试试」时用），
   * 否则会反复弹同一个框，绕过按钮等于没用（§9 R5）。
   */
  launch: (id: string, diagnose = true): Promise<LaunchResult> =>
    bridge().invoke('launch', { id, diagnose }),

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

  pickPath: (kind: 'file' | 'folder'): Promise<string | null> => bridge().pickPath(kind),

  // ===== M2：DLsite 元数据（全部走既有 tsumi:invoke，无新 preload channel）=====

  /** 从游戏路径猜 RJ 号（只读本地文件、绕队列，毫秒级）。可能返回多个候选，让用户选。 */
  dlsiteDetectRJ: (path: string): Promise<{ candidates: string[] }> =>
    bridge().invoke<{ candidates: string[] }>('dlsiteDetectRJ', { path }),

  /** 只查不存：查失败不会污染游戏库（方案 §5.1）。成功后由调用方决定是否 saveGameMeta。 */
  dlsiteLookup: (rj: string, refresh?: boolean): Promise<DlsiteWork> =>
    bridge().invoke<DlsiteWork>('dlsiteLookup', { rj, refresh }),

  /**
   * M2.5-A：按名字搜索 DLsite，返回候选列表（最多 20 条）。
   * 只读网络、不写盘；搜不到走 `error.dlsiteSearchEmpty`。
   * **不自动选第一条**——搜索精度一般，必须让用户点选（§1.3）。
   */
  dlsiteSearch: (keyword: string, category?: string): Promise<DlsiteSearchResult> =>
    bridge().invoke<DlsiteSearchResult>('dlsiteSearch', { keyword, category }),

  /** 落盘元数据。传 work 直接存；只传 rj 则由主进程拉一次再存。 */
  saveGameMeta: (
    gameId: string,
    input: { rj?: string; work?: DlsiteWork; editedFields?: EditableField[] }
  ): Promise<Snapshot> => bridge().invoke<Snapshot>('saveGameMeta', { gameId, ...input }),

  /**
   * 按已存的 RJ 重新拉取并落盘。
   * `force:true` = §B.2 的「强制覆盖全部」：清空编辑标记，整体取 DLsite 值。
   */
  refreshGameMeta: (gameId: string, refresh?: boolean, force?: boolean): Promise<Snapshot> =>
    bridge().invoke<Snapshot>('refreshGameMeta', { gameId, refresh, force }),

  /**
   * M2.5-C：多语言版本分组（纯本地计算、绕队列、毫秒级）。
   * 只认「两者都识别出语言且不同 + 标题相似度过阈值」的游戏，
   * 绝不把没有语言标记的游戏拉进组（§C.2）。
   */
  languageGroups: (threshold?: number): Promise<{ groups: LanguageGroup[] }> =>
    bridge().invoke<{ groups: LanguageGroup[] }>('languageGroups', { threshold }),

  clearGameMeta: (gameId: string): Promise<Snapshot> => bridge().invoke<Snapshot>('clearGameMeta', { gameId }),

  // ===== M3：故障自愈（全部走既有 tsumi:invoke，无新 preload channel）=====

  /**
   * M3：启动前诊断（纯本地、只读、毫秒级，绕开串行队列）。
   * 返回按 fatal → warning → info 排序的数组；空数组 = 没发现问题。
   */
  diagnoseGame: (gameId: string): Promise<Diagnosis[]> =>
    bridge().invoke<Diagnosis[]>('diagnoseGame', { gameId }),

  /**
   * M3：一键修复（进队列——可能触发 244MB 的 RTP 下载）。
   * 只处理传入的那**一条** fix（§11-③：第一版不并行处理多条）。
   */
  repairGame: (gameId: string, fix: DiagnosisFix): Promise<RepairResult> =>
    bridge().invoke<RepairResult>('repairGame', { gameId, fix }),

  // ===== M3.5：进程管理（全部走既有 tsumi:invoke，无新 preload channel）=====

  /**
   * M3.5：正在运行的游戏（只读内存里的进程表、绕队列、毫秒级）。
   * UI 平时读 `snapshot.running`；这条命令留给「运行中定时刷新」与探针。
   */
  runningGames: (): Promise<RunningGame[]> => bridge().invoke<RunningGame[]>('runningGames'),

  /**
   * M3.5：关闭游戏（进队列——要等进程退出，最多 5 秒）。
   * 目标没在运行时抛 `error.gameNotRunning`（不是静默成功）。
   */
  stopGame: (gameId: string): Promise<StopGameResult> => bridge().invoke<StopGameResult>('stopGame', { gameId })
}

// ===== 图片 URL（§3.7）=====

/** 绝对路径 → tsmg:// 图片 URL；无路径返回 undefined（UI 走占位）。 */
export function iconUrl(filePath?: string): string | undefined {
  if (!filePath) return undefined
  return `tsmg://img/${encodeURIComponent(filePath)}`
}

// 年龄分级判定已抽到 src/shared/age-rating.ts（主进程 / 渲染层 / 测试共用一份）。
export { isAdultWork } from '../../../shared/age-rating'

// ===== 错误本地化（§3.9）=====

type Translate = (key: string, args?: Record<string, unknown>) => string

/**
 * 主进程只给 key；渲染层查 locales 的 error.*。
 * 查不到（或没有 key）时退回 message 原文。
 */
export function translateError(error: unknown, t: Translate): string {
  // preload 的 key 走 message 编码过来的，先解回来（否则中文文案永远出不来）
  const decoded = decodeBridgeError(error)
  const candidate = decoded as TsumiError | undefined
  if (candidate?.key) {
    const translated = t(candidate.key, candidate.arguments)
    // vue-i18n 查不到时会原样返回 key，此时退回 message
    if (translated && translated !== candidate.key) return translated
  }
  return candidate?.message ?? String(error)
}
