// library-meta.json：DLsite 元数据的旁挂存储（M2 §3.2）。
// 为什么单独一个文件：D10 要求 GameRecord 与上游 schema 零改动，删掉本文件游戏库照常能启动。
//
// ⚠️ 本文件不 import electron（vitest 直接跑）。
// 与 dlsite 缓存的区别：这里的损坏文件**绝不静默覆盖**（是用户数据），缓存则可重建（见 dlsite.ts）。
import fs from 'node:fs'
import path from 'node:path'
import { component, readJSON, writeJSON } from './games-store'
import type { DlsiteWork } from './dlsite'

/** 一条游戏的 DLsite 元数据。字段即 DlsiteWork（含 rj / fetchedAt）。 */
export type GameMeta = DlsiteWork

/** 磁盘形态：`{ "<gameId>": GameMeta }`。 */
export type GameMetaMap = Record<string, GameMeta>

export interface LibraryMetaStore {
  readonly metaFile: string
  load(): GameMetaMap
  save(gameId: string, meta: GameMeta): GameMetaMap
  remove(gameId: string): GameMetaMap
}

function requireGameId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw Object.assign(new Error('Invalid game id'), {
      translationKey: 'error.dlsiteGameRequired',
      translationArguments: {}
    })
  }
  // 与 games-store 的 component 同规则：挡掉 ../ 与分隔符，防止拼出目录外的路径
  return component(value, 'game id')
}

/**
 * 只保留已知字段 + 必填校验：外部（页面）数据写进库之前必须过一遍，
 * 免得 DLsite 哪天多塞个奇怪字段就把我们的 JSON 撑变形。
 */
function sanitize(gameId: string, meta: unknown): GameMeta {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    throw Object.assign(new Error(`Invalid DLsite metadata for game ${gameId}`), {
      translationKey: 'error.dlsiteParse',
      translationArguments: { rj: '' }
    })
  }
  const source = meta as Record<string, unknown>
  const rj = typeof source.rj === 'string' ? source.rj.trim() : ''
  if (!rj) {
    throw Object.assign(new Error('DLsite metadata is missing rj'), {
      translationKey: 'error.dlsiteInvalidRj',
      translationArguments: { rj: '' }
    })
  }
  const text = (key: string): string | undefined => {
    const value = source[key]
    return typeof value === 'string' && value.trim() ? value.trim() : undefined
  }
  const num = (key: string): number | undefined => {
    const value = source[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }
  return {
    rj,
    title: text('title') ?? rj,
    titleFull: text('titleFull'),
    circle: text('circle'),
    circleId: text('circleId'),
    seriesName: text('seriesName'),
    category: text('category'),
    workType: text('workType'),
    registDate: text('registDate'),
    price: num('price'),
    priceWithTax: num('priceWithTax'),
    officialPrice: num('officialPrice'),
    discount: num('discount'),
    coverUrl: text('coverUrl'),
    description: text('description'),
    fetchedAt: text('fetchedAt') ?? new Date().toISOString()
  }
}

export function createLibraryMetaStore(dataDir: string): LibraryMetaStore {
  const metaFile = path.join(dataDir, 'library-meta.json')

  /** 损坏文件会抛 error.invalidObject（由 readJSON 抛），原文件保持不动。 */
  const load = (): GameMetaMap => readJSON<GameMetaMap>(metaFile)

  function save(gameId: string, meta: GameMeta): GameMetaMap {
    const id = requireGameId(gameId)
    const all = load()
    all[id] = sanitize(id, meta)
    writeJSON(metaFile, all)
    return all
  }

  function remove(gameId: string): GameMetaMap {
    const id = requireGameId(gameId)
    if (!fs.existsSync(metaFile)) return {}
    const all = load()
    // 不存在也算成功：删游戏时顺手清 meta，不该因为「本来就没有」而报错
    if (!Object.hasOwn(all, id)) return all
    delete all[id]
    writeJSON(metaFile, all)
    return all
  }

  return { metaFile, load, save, remove }
}
