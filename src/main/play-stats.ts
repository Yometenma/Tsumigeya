// play-stats.json：游玩记录的旁挂存储（M3.5 §4.3，D51）。
//
// 为什么**不**放进 games.json：D10 要求 GameRecord 与上游 schema 零改动
//   （上游读 games.json 时必须能完整理解，多一个字段就是破坏兼容）。
// 为什么**不**放进 library-meta.json：那是「DLsite 元数据」（标题/社团/封面/RJ…），
//   语义上与「用户什么时候玩过、玩了几次」完全不同。混在一起会让「清空 DLsite 信息」
//   顺手把游玩历史也清掉，那是两件不该互相牵连的事。
// 所以：独立的 play-stats.json，**可以单独删除**（删了只是丢掉统计，游戏照常启动）。
//
// ⚠️ 本文件不 import electron（vitest 直接跑）。
// ⚠️ 与 dlsite 缓存的区别：这里的损坏文件**绝不静默覆盖**（是用户数据），
//    复用 games-store 的 readJSON / writeJSON（原子写 + .bak 备份）。
import fs from 'node:fs'
import path from 'node:path'
import { component, readJSON, writeJSON } from './games-store'

/** 一条游戏的游玩记录。字段名照方案 §4.3 的 JSON 形态。 */
export interface PlayStat {
  /** 最后一次启动的时刻（ISO 8601）。 */
  lastPlayedAt: string
  /** 累计启动次数（每次「启动成功」+1，不是每次点按钮 +1——被诊断拦下的不算）。 */
  playCount: number
  /**
   * 累计游玩秒数。
   *
   * 只有「进程正常退出」才累加（`finish()`）。应用被强杀 / 崩溃时这个会话的时长
   * **不会**被记进去——宁可少记，也不要凭空编一个数字出来（D50 的同一精神：
   * 运行时事实不落盘，落盘的就必须是已经发生的事）。
   */
  totalSeconds: number
}

/** 磁盘形态：`{ "<gameId>": PlayStat }`。 */
export type PlayStatMap = Record<string, PlayStat>

export interface PlayStatsStore {
  readonly statsFile: string
  load(): PlayStatMap
  /** 一次游戏启动：`playCount` +1、`lastPlayedAt` 记为 startedAt。 */
  record(gameId: string, startedAt?: string): PlayStatMap
  /**
   * 一次游戏结束：把本次会话时长累加进 `totalSeconds`。
   *
   * `durationSeconds` 由调用方算（主进程持有 `startedAt`），这里只做归一化与累加。
   * 负数 / NaN / Infinity 一律按 0 处理：时钟回拨、系统休眠后再唤醒都可能给出怪值，
   * 而「负的游玩时长」一旦写进磁盘就再也没法分辨是数据坏了还是用户真的玩过。
   */
  finish(gameId: string, durationSeconds: number): PlayStatMap
  /** 删游戏时同步清记录（与 `library-meta` 的 remove 同理，避免孤儿条目）。 */
  remove(gameId: string): PlayStatMap
}

/**
 * 把任意输入收敛成合法字段：时长与次数都必须是**非负有限数**，
 * 时间必须是能解析的 ISO 串（解析不了就丢弃，而不是留下一串垃圾）。
 *
 * 为什么这么严：这个文件是「我们自己写、我们自己读」的，但用户可能手改、
 * 也可能是旧版本写的。一个 `totalSeconds: "abc"` 会让 UI 显示 `NaN 分钟`，
 * 而 NaN 一旦参与再累加就会永久污染（NaN + 1 = NaN）。宁可在入口处归零。
 */
export function normalizePlayStat(value: unknown): PlayStat | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  const count = typeof source.playCount === 'number' && Number.isFinite(source.playCount) ? source.playCount : 0
  const seconds =
    typeof source.totalSeconds === 'number' && Number.isFinite(source.totalSeconds) ? source.totalSeconds : 0
  const lastPlayedAt =
    typeof source.lastPlayedAt === 'string' && !Number.isNaN(Date.parse(source.lastPlayedAt))
      ? source.lastPlayedAt
      : ''
  return {
    lastPlayedAt,
    playCount: Math.max(0, Math.floor(count)),
    totalSeconds: Math.max(0, Math.floor(seconds))
  }
}

/**
 * 计算某次会话的时长（秒，非负整数）。
 *
 * 抽成纯函数是为了能单测「时钟回拨 / 非法时间」这些真实会发生的边界
 * （笔记本休眠再唤醒、用户手动改系统时间都会踩到）。
 */
export function sessionSeconds(startedAt: string | undefined, endedAt: number | Date = Date.now()): number {
  if (!startedAt) return 0
  const start = Date.parse(startedAt)
  if (Number.isNaN(start)) return 0
  const end = endedAt instanceof Date ? endedAt.getTime() : endedAt
  if (!Number.isFinite(end)) return 0
  const delta = Math.floor((end - start) / 1000)
  return delta > 0 ? delta : 0
}

export function createPlayStatsStore(dataDir: string): PlayStatsStore {
  const statsFile = path.join(dataDir, 'play-stats.json')

  /**
   * 读盘并逐条归一化。
   *
   * 与 `readJSON` 的分工：`readJSON` 只管「整个文件是不是合法 JSON 对象」，
   * 坏了就抛（绝不静默覆盖用户数据）。这里的归一化处理的是**单条记录内部**的脏值，
   * 那属于「可修正」而不是「已损坏」，逐条丢弃比让整个统计不可用更合适。
   */
  const load = (): PlayStatMap => {
    const raw = readJSON<Record<string, unknown>>(statsFile)
    const out: PlayStatMap = {}
    for (const [gameId, value] of Object.entries(raw)) {
      const stat = normalizePlayStat(value)
      if (stat) out[gameId] = stat
    }
    return out
  }

  /** 读 → 改 → 原子写。gameId 走 component() 校验，防止拼出目录外路径。 */
  function update(gameId: string, mutate: (previous: PlayStat | undefined) => PlayStat): PlayStatMap {
    const id = component(gameId, 'game id')
    const all = load()
    all[id] = mutate(all[id])
    writeJSON(statsFile, all)
    return all
  }

  function record(gameId: string, startedAt: string = new Date().toISOString()): PlayStatMap {
    return update(gameId, (previous) => ({
      lastPlayedAt: startedAt,
      playCount: (previous?.playCount ?? 0) + 1,
      totalSeconds: previous?.totalSeconds ?? 0
    }))
  }

  function finish(gameId: string, durationSeconds: number): PlayStatMap {
    const seconds = Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.floor(durationSeconds) : 0
    return update(gameId, (previous) => ({
      // 没有 lastPlayedAt 说明这条记录是异常的（先 finish 后 record），
      // 不编造一个时间出来；次数保持原样（可能是 0）。
      lastPlayedAt: previous?.lastPlayedAt ?? '',
      playCount: previous?.playCount ?? 0,
      totalSeconds: (previous?.totalSeconds ?? 0) + seconds
    }))
  }

  function remove(gameId: string): PlayStatMap {
    const id = component(gameId, 'game id')
    const all = load()
    if (!Object.hasOwn(all, id)) return all
    delete all[id]
    writeJSON(statsFile, all)
    return all
  }

  return { statsFile, load, record, finish, remove }
}

/** 该文件是否存在（UI 想在「没有记录」时省略整个区块时用）。 */
export function playStatsExists(dataDir: string): boolean {
  return fs.existsSync(path.join(dataDir, 'play-stats.json'))
}
