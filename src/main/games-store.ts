// games.json / global-settings.json 的读写层。
// 契约：docs/M1-实施方案.md §3.1（数据文件）、§3.2（数据结构）。
// 注意：本文件**不 import electron**，dataDir 由调用方传入，因此可以在 vitest 里直接跑。
// 写文件规则照上游 worker.cjs:38-48：校验旧文件 → 备份 .bak → 写 .tmp → rename。
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** 主进程侧的宽松类型（渲染层唯一类型来源是 api/client.ts，那边是严格版）。 */
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

/** games.json 的磁盘形态：`{ "<id>": 不含 id 的记录 }`，与上游完全一致（D10）。 */
export type GameMap = Record<string, Omit<GameRecord, 'id'>>

export type Appearance = 'light' | 'dark' | 'system'

/** M2.5-C：可识别的语言（与 src/shared/game-language.ts 的 GameLanguage 一致）。 */
export type LanguagePreference = 'zh' | 'ja' | 'en' | 'ko'

/** M2.5-C：语言偏好值（`none` = 不启用该功能）。 */
export type LanguagePreferenceOrNone = LanguagePreference | 'none'

export interface Settings {
  listView: boolean
  deletionConfirmation: boolean
  nonInstalledAutodetect: boolean
  checkModuleUpdatesOnStartup: boolean
  appearance: Appearance
  language: string
  /**
   * M2.5-C：首选语言。启动「非首选语言版」时会提示切换到它（§C.4/C.5）。
   * 默认 zh（用户是中文用户）。
   */
  preferredLanguage: LanguagePreferenceOrNone
  /** M2.5-C：次选语言。没有首选版本时退而求其次。默认 ja（玩日系游戏）。 */
  fallbackLanguage: LanguagePreferenceOrNone
  /** M2.5-C：启动非偏好语言版时是否弹确认（用户可勾「不再询问」关掉它）。 */
  languageSwitchPrompt: boolean
  /**
   * M3：启动前是否自动跑故障诊断（默认 true）。
   *
   * 用户如果嫌慢可以关掉（方案 §4.3）。实测诊断是纯本地文件扫描、毫秒级，
   * 但没有大量样本前不承诺具体耗时，所以留这个开关作为逃生口。
   */
  diagnoseBeforeLaunch: boolean
  /** 保留上游 / 未来版本写入的未知键（例如旧的 darkTheme）。 */
  [key: string]: unknown
}

export interface Snapshot {
  games: GameRecord[]
  modules: unknown[]
  settings: Settings
  dataPath: string
  /** 数据目录被降级时填：{ requested, switchedTo, code }。正常时为 null（§3.2）。 */
  dataDirWarning: { requested: string; switchedTo: string; code: string } | null
  nodeVersion: string
  engineUpdates: unknown
  /** M2：DLsite 旁挂元数据（键 = gameId）。GameRecord 不动，这是新增字段（D18）。 */
  meta: Record<string, unknown>
  /**
   * M3.5：正在运行的游戏（**运行时状态，不落盘**，D50）。
   *
   * 为什么放进 snapshot：详情页/卡片要立刻知道「这个游戏在不在跑」，
   * 而它们本来就在读 snapshot。单独一条 `runningGames` 命令留给「正在运行时
   * 定时刷新」和探针；两者用同一份内存数据，不会不一致。
   */
  running: RunningGameLite[]
  /**
   * M4.0 S6.5（D58）：数据目录切换的一次性说明。
   *
   * 有值 = 这次启动该给用户看这句中文说明（**info，不是错误**）；
   * null = 不用提示（不是 mac / 已经提示过 / 目录里已经有数据）。
   *
   * 措辞与判定都在 `data-dir-notice.ts`；这里只负责下发。
   */
  dataDirNotice: string | null
  /**
   * M5.0 N1：游玩记录（键 = gameId，没有记录的游戏不出现）。
   *
   * 独立的 `play-stats.json`（D51），与 `meta` 同为旁挂数据：
   * 删了它只是丢掉统计，游戏照常启动。
   *
   * 为什么进 snapshot（而不是另开一条 IPC 命令）：这份数据只在启动/退出时变，
   * 而详情页本来就在读 snapshot —— 另开命令会让渲染层多一条「要记得刷新」的路径，
   * 那正是 D44 踩过两次的老毛病。
   */
  playStats: Record<string, unknown>
}

/** snapshot 里的运行态条目（比主进程内部的 RunningGame 少几个字段：UI 用不到命令串）。 */
export interface RunningGameLite {
  gameId: string
  pid: number
  startedAt: string
}

/** 带翻译键的错误：主进程只给 key，渲染层查 locales（§3.9）。 */
export interface AppError extends Error {
  translationKey?: string
  translationArguments?: Record<string, unknown>
}

export function failure(key: string, message: string, args: Record<string, unknown> = {}): Error {
  return Object.assign(new Error(message), { translationKey: key, translationArguments: args })
}

/** 校验一个「文件/目录名」片段，挡住 ../ 与分隔符（照 worker.cjs:52-55）。 */
export function component(value: unknown, label = 'name'): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value === '.' ||
    value === '..' ||
    /[\\/\u0000-\u001f]/.test(value)
  ) {
    throw failure('error.invalidComponent', `Invalid ${label}`, { label })
  }
  return value
}

export function validLanguage(value: unknown): value is string {
  return typeof value === 'string' && (value === 'system' || /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(value))
}

/**
 * 读 JSON 对象；文件不存在返回 fallback。
 * 文件损坏（非 JSON / 非对象）**直接抛错**——绝不静默覆盖损坏文件（§3.1）。
 */
export function readJSON<T extends Record<string, unknown>>(file: string, fallback: T = {} as T): T {
  if (!fs.existsSync(file)) return fallback
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw failure('error.invalidObject', `Invalid JSON object: ${path.basename(file)}`, {
      file: path.basename(file)
    })
  }
  return value as T
}

/** 原子写：先校验旧文件 → 备份 → 写 tmp → rename；tmp 在 finally 里清掉。 */
export function writeJSON(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  readJSON(file) // 旧文件损坏时在这里抛错，原文件保持不变
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`)
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 })
    fs.renameSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

const DEFAULT_SETTINGS: Omit<
  Settings,
  | 'appearance'
  | 'language'
  | 'preferredLanguage'
  | 'fallbackLanguage'
  | 'languageSwitchPrompt'
  | 'diagnoseBeforeLaunch'
> = {
  listView: false,
  deletionConfirmation: true,
  nonInstalledAutodetect: true,
  checkModuleUpdatesOnStartup: true,
  // R18 封面保护默认**开启**（即打码）。只影响渲染，元数据照常抓取与保存。
  showAdultCovers: false
}

/** M2.5-C：语言偏好默认值（§7-① 用户 2026-11-04 确认：首选 zh、次选 ja）。 */
const DEFAULT_PREFERRED_LANGUAGE: LanguagePreferenceOrNone = 'zh'
const DEFAULT_FALLBACK_LANGUAGE: LanguagePreferenceOrNone = 'ja'

/** 校验语言偏好值：非法值一律回落到默认（不信任磁盘上的任意字符串）。 */
export function validLanguagePreference(value: unknown, fallback: LanguagePreferenceOrNone): LanguagePreferenceOrNone {
  if (value === 'none') return 'none'
  if (typeof value === 'string' && (value === 'zh' || value === 'ja' || value === 'en' || value === 'ko')) {
    return value
  }
  return fallback
}

/** 把磁盘上的原始 settings 归一化（含上游 darkTheme 兼容，照 worker.cjs:173-177）。 */
export function normalizeSettings(saved: Record<string, unknown> = {}): Settings {
  const appearance: Appearance = ['light', 'dark', 'system'].includes(saved.appearance as string)
    ? (saved.appearance as Appearance)
    : typeof saved.darkTheme === 'boolean'
      ? saved.darkTheme
        ? 'dark'
        : 'light'
      : 'system'
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    appearance,
    language: validLanguage(saved.language) ? saved.language : 'system',
    // M2.5-C：语言偏好。旧库（M2 时期）没有这三个键 → 落到默认值（首选 zh、次选 ja）。
    preferredLanguage: validLanguagePreference(saved.preferredLanguage, DEFAULT_PREFERRED_LANGUAGE),
    fallbackLanguage: validLanguagePreference(saved.fallbackLanguage, DEFAULT_FALLBACK_LANGUAGE),
    // 默认 true = 弹确认（§7-⑤ 用户确认「弹，可不再询问」）
    languageSwitchPrompt: saved.languageSwitchPrompt === false ? false : true,
    // M3：启动前诊断默认开（§4.3）。旧库没有这个键 → true。
    diagnoseBeforeLaunch: saved.diagnoseBeforeLaunch === false ? false : true
  } as Settings
}

export interface GameStore {
  readonly dataDir: string
  readonly gamesFile: string
  readonly settingsFile: string
  loadGames(): GameMap
  saveGames(all: GameMap): void
  loadSettingsRaw(): Record<string, unknown>
  settings(): Settings
  saveSettings(partial: Record<string, unknown>): Settings
  saveGame(input: { id?: string; game: GameDraft }): GameMap
  removeGame(id: string): GameMap
  /** 组装 Snapshot；modules / engineUpdates / dataDirWarning / meta 由 core-host / ipc 传进来。 */
  snapshot(extra?: {
    modules?: unknown[]
    nodeVersion?: string
    engineUpdates?: unknown
    dataDirWarning?: Snapshot['dataDirWarning']
    meta?: Record<string, unknown>
    /** M3.5：进程表的只读投影（不传 = 没有正在运行的游戏）。 */
    running?: RunningGameLite[]
    /** M4.0 S6.5（D58）：数据目录切换的一次性说明（不传 = 不提示）。 */
    dataDirNotice?: string | null
    /** M5.0 N1：游玩记录（不传 = 没有记录）。 */
    playStats?: Record<string, unknown>
  }): Snapshot
}

export function createGameStore(dataDir: string): GameStore {
  const gamesFile = path.join(dataDir, 'games.json')
  const settingsFile = path.join(dataDir, 'global-settings.json')

  const loadGames = (): GameMap => readJSON<GameMap>(gamesFile)
  const saveGames = (all: GameMap): void => writeJSON(gamesFile, all)
  const loadSettingsRaw = (): Record<string, unknown> => readJSON(settingsFile)

  function saveGame({ id, game }: { id?: string; game: GameDraft }): GameMap {
    if (!game || typeof game !== 'object') throw failure('error.missingGame', 'Missing game')
    for (const key of ['gameTitle', 'gamePath', 'gameEngine'] as const) {
      const value = game[key]
      if (typeof value !== 'string' || !value.trim()) {
        throw failure('error.requiredGame', 'Game title, path and engine are required.')
      }
    }
    component(game.gameEngine, 'engine')

    const all = loadGames()
    if (id != null && (!/^\d+$/.test(String(id)) || !Object.hasOwn(all, id))) {
      throw failure('error.staleGame', 'Game no longer exists. Refresh the library.')
    }
    const wanted = game.gameTitle.trim().toLowerCase()
    if (Object.entries(all).some(([other, g]) => other !== id && g.gameTitle?.toLowerCase() === wanted)) {
      throw failure('error.duplicateGame', 'A game with this name already exists.')
    }

    const nextID = id || String(Math.max(0, ...Object.keys(all).map((n) => Number(n) || 0)) + 1)
    // 浅合并：保留旧记录里上游 / 新版本写入的未知字段（§6 测试项）。
    const merged: Record<string, unknown> = { ...(all[nextID] ?? {}) }
    for (const [key, value] of Object.entries(game)) {
      if (value !== undefined) merged[key] = value
    }
    merged.gameTitle = game.gameTitle.trim()
    delete merged.id
    all[nextID] = merged as Omit<GameRecord, 'id'>
    saveGames(all)
    return all
  }

  function removeGame(id: string): GameMap {
    const all = loadGames()
    if (!Object.hasOwn(all, id)) throw failure('error.gameNotFound', 'Game not found')
    delete all[id]
    saveGames(all)
    return all
  }

  function saveSettings(partial: Record<string, unknown>): Settings {
    const current = loadSettingsRaw()
    const next: Record<string, unknown> = { ...current, ...partial }
    if (Object.hasOwn(partial, 'appearance')) {
      if (!['light', 'dark', 'system'].includes(partial.appearance as string)) {
        throw failure('error.appearance', 'Invalid appearance mode')
      }
      // 与上游一致：system 时删掉遗留的 darkTheme，显式 light/dark 时同步写回。
      if (partial.appearance === 'system') delete next.darkTheme
      else next.darkTheme = partial.appearance === 'dark'
    }
    if (Object.hasOwn(partial, 'language') && !validLanguage(partial.language)) {
      throw failure('error.language', 'Invalid language preference')
    }
    // M2.5-C：语言偏好显式校验（非法值报错而不是静默落回默认——
    // 因为这三个键决定「启动时会不会被提示」，静默改正会让用户以为设置没保存）
    for (const key of ['preferredLanguage', 'fallbackLanguage'] as const) {
      if (Object.hasOwn(partial, key)) {
        const value = partial[key]
        if (value !== 'none' && !['zh', 'ja', 'en', 'ko'].includes(value as string)) {
          throw failure('error.languagePreference', 'Invalid language preference', { value: String(value) })
        }
      }
    }
    if (Object.hasOwn(partial, 'languageSwitchPrompt') && typeof partial.languageSwitchPrompt !== 'boolean') {
      throw failure('error.languagePreference', 'Invalid language prompt flag', {
        value: String(partial.languageSwitchPrompt)
      })
    }
    // M3：诊断开关也要显式校验（静默改正会让用户以为设置没保存）
    if (Object.hasOwn(partial, 'diagnoseBeforeLaunch') && typeof partial.diagnoseBeforeLaunch !== 'boolean') {
      throw failure('error.languagePreference', 'Invalid diagnose flag', {
        value: String(partial.diagnoseBeforeLaunch)
      })
    }
    writeJSON(settingsFile, next)
    return normalizeSettings(next)
  }

  function settings(): Settings {
    return normalizeSettings(loadSettingsRaw())
  }

  function snapshot(extra: {
    modules?: unknown[]
    nodeVersion?: string
    engineUpdates?: unknown
    dataDirWarning?: Snapshot['dataDirWarning']
    meta?: Record<string, unknown>
    running?: RunningGameLite[]
    /** M4.0 S6.5（D58）：由 ipc 层算好传进来（它知道平台与 dataDir）。 */
    dataDirNotice?: string | null
    /** M5.0 N1：游玩记录（不传 = 没有记录）。由 ipc 层读 play-stats.json 后传入。 */
    playStats?: Record<string, unknown>
  } = {}): Snapshot {
    return {
      games: Object.entries(loadGames()).map(([id, value]) => ({ ...value, id })),
      modules: extra.modules ?? [],
      settings: settings(),
      dataPath: dataDir,
      dataDirWarning: extra.dataDirWarning ?? null,
      nodeVersion: extra.nodeVersion ?? process.version,
      engineUpdates: extra.engineUpdates ?? null,
      meta: extra.meta ?? {},
      // M3.5：默认空数组（不传 = 没有正在运行的游戏）。**绝不**在这里落盘任何东西（D50）。
      running: extra.running ?? [],
      dataDirNotice: extra.dataDirNotice ?? null,
      // M5.0 N1：默认空对象（不传 = 还没有任何游玩记录）。
      playStats: extra.playStats ?? {}
    }
  }

  return {
    dataDir,
    gamesFile,
    settingsFile,
    loadGames,
    saveGames,
    loadSettingsRaw,
    settings,
    saveSettings,
    saveGame,
    removeGame,
    snapshot
  }
}
