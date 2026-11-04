// M3.5 S1 单测：游玩记录（play-stats.json）。
//
// 这一层的价值不在「能写文件」，而在**它怎么处理脏数据**：
// 时间是用户可能手改的、时钟可能回拨、旧版本可能写过别的字段。
// 一旦 NaN 进了 totalSeconds，UI 会显示「NaN 分钟」，而且 NaN 参与再累加就永久污染。
// 所以这里大半测试是在钉边界，不是在钉 happy path。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  createPlayStatsStore,
  normalizePlayStat,
  playStatsExists,
  sessionSeconds,
  type PlayStatMap
} from '../src/main/play-stats'

let dataDir: string

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-play-'))
})

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

describe('sessionSeconds（会话时长计算）', () => {
  const start = '2026-11-04T13:00:00.000Z'
  const startMs = Date.parse(start)

  test('正常会话：取整数秒', () => {
    expect(sessionSeconds(start, startMs + 96_000)).toBe(96)
  })

  test('不足 1 秒算 0（不四舍五入成 1）', () => {
    expect(sessionSeconds(start, startMs + 400)).toBe(0)
  })

  test('时钟回拨（结束早于开始）→ 0，不给负数', () => {
    // 真实会踩到：笔记本休眠唤醒、用户手改系统时间
    expect(sessionSeconds(start, startMs - 60_000)).toBe(0)
  })

  test('开始时间缺失 / 非法 → 0', () => {
    expect(sessionSeconds(undefined, startMs)).toBe(0)
    expect(sessionSeconds('not-a-date', startMs)).toBe(0)
    expect(sessionSeconds('', startMs)).toBe(0)
  })

  test('结束时间是 Date 也可以', () => {
    expect(sessionSeconds(start, new Date(startMs + 5000))).toBe(5)
  })
})

describe('normalizePlayStat（脏数据归一化）', () => {
  test('非对象 / 数组 / null 一律丢弃（返回 null）', () => {
    for (const bad of [null, undefined, 42, 'x', [], [1, 2]]) {
      expect(normalizePlayStat(bad)).toBeNull()
    }
  })

  test('缺字段时补零，**不**补一个假时间', () => {
    const stat = normalizePlayStat({})
    expect(stat).toEqual({ lastPlayedAt: '', playCount: 0, totalSeconds: 0 })
  })

  test('NaN / Infinity / 字符串数字都不采信', () => {
    // 字符串 "12" 看起来像数字，但它是被手改的证据——不采信更安全
    const stat = normalizePlayStat({ playCount: '12', totalSeconds: '99' })
    expect(stat?.playCount).toBe(0)
    expect(stat?.totalSeconds).toBe(0)
  })

  test('负数与小数被夹到非负整数', () => {
    const stat = normalizePlayStat({ playCount: -3, totalSeconds: 12.7 })
    expect(stat?.playCount).toBe(0)
    expect(stat?.totalSeconds).toBe(12)
  })

  test('无法解析的 lastPlayedAt 被清空（不留垃圾串）', () => {
    expect(normalizePlayStat({ lastPlayedAt: 'yesterday' })?.lastPlayedAt).toBe('')
  })
})

describe('createPlayStatsStore', () => {
  test('record：首次启动 → playCount=1、totalSeconds=0、lastPlayedAt 落盘', () => {
    const store = createPlayStatsStore(dataDir)
    const at = '2026-11-04T13:00:00.000Z'
    const map = store.record('1', at)
    expect(map['1']).toEqual({ lastPlayedAt: at, playCount: 1, totalSeconds: 0 })
    // 真的落盘了（不是只在内存）
    expect(fs.existsSync(path.join(dataDir, 'play-stats.json'))).toBe(true)
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'play-stats.json'), 'utf8'))['1'].playCount).toBe(1)
  })

  test('record：第二次启动 → playCount 累加，totalSeconds 保留', () => {
    const store = createPlayStatsStore(dataDir)
    store.record('1', '2026-11-04T13:00:00.000Z')
    store.finish('1', 7200)
    const map = store.record('1', '2026-11-05T13:00:00.000Z')
    expect(map['1'].playCount).toBe(2)
    expect(map['1'].totalSeconds).toBe(7200)
    expect(map['1'].lastPlayedAt).toBe('2026-11-05T13:00:00.000Z')
  })

  test('finish：累加时长，playCount 不变', () => {
    const store = createPlayStatsStore(dataDir)
    store.record('1')
    const map = store.finish('1', 3600)
    expect(map['1'].playCount).toBe(1)
    expect(map['1'].totalSeconds).toBe(3600)
  })

  test('finish：两次会话时长累加（不是覆盖）', () => {
    const store = createPlayStatsStore(dataDir)
    store.record('1')
    store.finish('1', 600)
    store.finish('1', 900)
    expect(store.load()['1'].totalSeconds).toBe(1500)
  })

  test('finish：非法时长按 0 记（NaN / 负数 / Infinity）', () => {
    const store = createPlayStatsStore(dataDir)
    store.record('1')
    store.finish('1', Number.NaN)
    store.finish('1', -50)
    store.finish('1', Number.POSITIVE_INFINITY)
    expect(store.load()['1'].totalSeconds).toBe(0)
  })

  test('finish：没有该记录时**不**编一个 lastPlayedAt', () => {
    const store = createPlayStatsStore(dataDir)
    const map = store.finish('9', 30)
    expect(map['9']).toEqual({ lastPlayedAt: '', playCount: 0, totalSeconds: 30 })
  })

  test('多游戏互不影响', () => {
    const store = createPlayStatsStore(dataDir)
    store.record('1')
    store.record('2')
    const map: PlayStatMap = store.load()
    expect(Object.keys(map).sort()).toEqual(['1', '2'])
    expect(map['1'].playCount).toBe(1)
    expect(map['2'].playCount).toBe(1)
  })

  test('remove：清掉一条，别的留着；文件仍然合法', () => {
    const store = createPlayStatsStore(dataDir)
    store.record('1')
    store.record('2')
    const map = store.remove('2')
    expect(Object.keys(map)).toEqual(['1'])
    expect(store.load()['1'].playCount).toBe(1)
  })

  test('remove 不存在的 id 不报错也不写盘', () => {
    const store = createPlayStatsStore(dataDir)
    store.record('1')
    const file = path.join(dataDir, 'play-stats.json')
    const before = fs.readFileSync(file, 'utf8')
    store.remove('999')
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })

  test('文件不存在时 load 返回空对象（不是抛错）', () => {
    expect(createPlayStatsStore(dataDir).load()).toEqual({})
    expect(playStatsExists(dataDir)).toBe(false)
  })

  test('文件整体损坏（非 JSON）→ 抛错，**不静默覆盖**用户数据', () => {
    const file = path.join(dataDir, 'play-stats.json')
    fs.writeFileSync(file, '{ this is broken')
    const store = createPlayStatsStore(dataDir)
    expect(() => store.load()).toThrow()
    // 关键：原文件必须原样还在（用户还有机会手工救回来）
    expect(fs.readFileSync(file, 'utf8')).toBe('{ this is broken')
  })

  test('单条记录内部脏值 → 该条被归一化，整个文件仍可用', () => {
    // 这是「可修正」而非「已损坏」：不能让一条坏记录废掉整份统计
    const file = path.join(dataDir, 'play-stats.json')
    fs.writeFileSync(
      file,
      JSON.stringify({
        '1': { lastPlayedAt: '2026-11-04T13:00:00.000Z', playCount: 3, totalSeconds: 120 },
        '2': { playCount: 'oops', totalSeconds: -9 },
        '3': 'garbage'
      })
    )
    const map = createPlayStatsStore(dataDir).load()
    expect(map['1']).toEqual({ lastPlayedAt: '2026-11-04T13:00:00.000Z', playCount: 3, totalSeconds: 120 })
    expect(map['2']).toEqual({ lastPlayedAt: '', playCount: 0, totalSeconds: 0 })
    expect(map['3']).toBeUndefined()
  })

  test('gameId 的路径穿越被挡住（不写出目录外）', () => {
    const store = createPlayStatsStore(dataDir)
    expect(() => store.record('../evil')).toThrow()
    expect(() => store.remove('a/b')).toThrow()
  })

  test('原子写：写完后没有残留的 .tmp 文件', () => {
    const store = createPlayStatsStore(dataDir)
    store.record('1')
    const leftovers = fs.readdirSync(dataDir).filter((name) => name.endsWith('.tmp'))
    expect(leftovers).toEqual([])
  })

  test('playStatsExists 在有记录后变 true', () => {
    const store = createPlayStatsStore(dataDir)
    store.record('1')
    expect(playStatsExists(dataDir)).toBe(true)
  })
})
