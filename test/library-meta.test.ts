// library-meta.json 单测（M2 §9）：不依赖网络、不依赖 GUI、不 import electron。
// 与 dlsite 缓存的策略差异是重点：**用户数据绝不静默覆盖**。
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createLibraryMetaStore } from '../src/main/library-meta'
import { writeJSON, readJSON } from '../src/main/games-store'
import type { DlsiteWork } from '../src/main/dlsite'

let dataDir: string
let store: ReturnType<typeof createLibraryMetaStore>

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'tsmg-meta-'))
  store = createLibraryMetaStore(dataDir)
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

function work(overrides: Partial<DlsiteWork> = {}): DlsiteWork {
  return {
    rj: 'RJ294126',
    title: '純愛おま○こ当番【アップデート版】',
    circle: '青春×フェティシズム',
    circleId: 'RG51931',
    coverUrl: 'https://img.dlsite.jp/modpub/images2/work/doujin/RJ295000/RJ294126_img_main.jpg',
    fetchedAt: '2026-11-04T00:00:00.000Z',
    ...overrides
  }
}

describe('基本读写', () => {
  test('文件不存在 → 空对象', () => {
    expect(store.load()).toEqual({})
  })

  test('save 后 load 能读回，且写入磁盘', () => {
    store.save('1', work())
    expect(store.load()['1'].title).toBe('純愛おま○こ当番【アップデート版】')
    expect(existsSync(store.metaFile)).toBe(true)
  })

  test('第二次写入产生 .bak', () => {
    store.save('1', work())
    expect(existsSync(`${store.metaFile}.bak`)).toBe(false)
    store.save('2', work({ rj: 'RJ111111' }))
    expect(existsSync(`${store.metaFile}.bak`)).toBe(true)
  })

  test('多个游戏互不影响', () => {
    store.save('1', work())
    store.save('2', work({ rj: 'RJ111111', title: '第二作' }))
    expect(Object.keys(store.load()).sort()).toEqual(['1', '2'])
    expect(store.load()['2'].title).toBe('第二作')
  })

  test('不残留 .tmp', () => {
    store.save('1', work())
    expect(readdirSync(dataDir).some((name) => name.endsWith('.tmp'))).toBe(false)
  })
})

describe('校验与清洗', () => {
  test('空 / 非法 gameId → error.dlsiteGameRequired', () => {
    expect(() => store.save('', work())).toThrow(
      expect.objectContaining({ translationKey: 'error.dlsiteGameRequired' })
    )
    for (const id of ['../evil', 'a/b', 'a\\b', '..']) {
      expect(() => store.save(id, work())).toThrow(
        expect.objectContaining({ translationKey: 'error.invalidComponent' })
      )
    }
  })

  test('缺 rj → error.dlsiteInvalidRj', () => {
    expect(() => store.save('1', { title: 'x' } as never)).toThrow(
      expect.objectContaining({ translationKey: 'error.dlsiteInvalidRj' })
    )
  })

  test('非对象 → error.dlsiteParse', () => {
    expect(() => store.save('1', [] as never)).toThrow(
      expect.objectContaining({ translationKey: 'error.dlsiteParse' })
    )
    expect(() => store.save('1', 'text' as never)).toThrow(
      expect.objectContaining({ translationKey: 'error.dlsiteParse' })
    )
  })

  test('未知字段不会写进库里（只保留白名单字段）', () => {
    store.save('1', { ...work(), evil: '<script>', nested: { a: 1 } } as never)
    const onDisk = JSON.parse(readFileSync(store.metaFile, 'utf8')) as Record<string, Record<string, unknown>>
    expect(onDisk['1']).not.toHaveProperty('evil')
    expect(onDisk['1']).not.toHaveProperty('nested')
  })

  test('类型不对的字段被丢弃（数值写成字符串不会被污染）', () => {
    store.save('1', { ...work(), price: '750' } as never)
    expect(store.load()['1'].price).toBeUndefined()
  })
})

describe('删除', () => {
  test('remove 删掉条目并落盘', () => {
    store.save('1', work())
    store.remove('1')
    expect(store.load()).toEqual({})
  })

  test('删除不存在的条目算成功（删游戏时顺手清，不该报错）', () => {
    expect(() => store.remove('99')).not.toThrow()
    expect(store.load()).toEqual({})
  })

  test('文件不存在时 remove 也不报错', () => {
    expect(() => store.remove('1')).not.toThrow()
  })
})

describe('损坏文件（用户数据绝不静默覆盖）', () => {
  test('损坏的 library-meta.json → writeJSON 抛错且原文件不变', () => {
    const corrupt = '{ this is not json'
    writeFileSync(store.metaFile, corrupt, 'utf8')
    expect(() => store.save('1', work())).toThrow()
    expect(readFileSync(store.metaFile, 'utf8')).toBe(corrupt)
    expect(existsSync(`${store.metaFile}.bak`)).toBe(false)
  })

  test('JSON 是数组 → load 抛 error.invalidObject', () => {
    writeFileSync(store.metaFile, '[1,2,3]', 'utf8')
    expect(() => store.load()).toThrow(expect.objectContaining({ translationKey: 'error.invalidObject' }))
  })

  test('readJSON 与 writeJSON 的复用是同一套规则（间接验证）', () => {
    writeJSON(store.metaFile, { '1': work() })
    expect(Object.keys(readJSON(store.metaFile))).toEqual(['1'])
  })
})
