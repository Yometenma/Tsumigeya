// games-store 单测（§6）：不依赖网络、不依赖 GUI、不 import electron。
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createGameStore, readJSON, writeJSON, normalizeSettings } from '../src/main/games-store'

let dataDir: string
let store: ReturnType<typeof createGameStore>

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'tsmg-store-'))
  store = createGameStore(dataDir)
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

function draft(overrides: Record<string, unknown> = {}) {
  return {
    gameTitle: '测试游戏',
    gamePath: path.join(dataDir, 'game'),
    gameEngine: 'mkxpz',
    ...overrides
  }
}

describe('games.json 读写', () => {
  test('空目录读 games 得到空对象', () => {
    expect(store.loadGames()).toEqual({})
  })

  test('saveGame 后文件存在；第二次保存产生 .bak', () => {
    store.saveGame({ game: draft() })
    expect(existsSync(store.gamesFile)).toBe(true)
    // 第一次写之前没有旧文件，所以还没有 .bak
    expect(existsSync(`${store.gamesFile}.bak`)).toBe(false)

    store.saveGame({ id: '1', game: draft({ gameTitle: '第二个' }) })
    expect(existsSync(`${store.gamesFile}.bak`)).toBe(true)
  })

  test('磁盘格式与上游一致：不含 id 字段', () => {
    store.saveGame({ game: draft() })
    const onDisk = JSON.parse(readFileSync(store.gamesFile, 'utf8')) as Record<string, Record<string, unknown>>
    expect(Object.keys(onDisk)).toEqual(['1'])
    expect(onDisk['1']).not.toHaveProperty('id')
    expect(onDisk['1']).toMatchObject({ gameTitle: '测试游戏', gameEngine: 'mkxpz' })
  })

  test('新 ID 递增（取现有最大数字 + 1）', () => {
    store.saveGame({ game: draft({ gameTitle: 'A' }) })
    store.saveGame({ game: draft({ gameTitle: 'B' }) })
    store.saveGame({ game: draft({ gameTitle: 'C' }) })
    expect(Object.keys(store.loadGames()).sort()).toEqual(['1', '2', '3'])
  })

  test('保留旧记录里上游写入的未知字段', () => {
    // 模拟上游写入了我们不认识的字段
    writeJSON(store.gamesFile, {
      '1': {
        gameTitle: '旧游戏',
        gamePath: '/old',
        gameEngine: 'nwjs',
        someFutureField: { nested: true },
        lastPlayed: '2025-01-01'
      }
    })
    store.saveGame({ id: '1', game: draft({ gameTitle: '旧游戏' }) })
    const onDisk = JSON.parse(readFileSync(store.gamesFile, 'utf8')) as Record<string, Record<string, unknown>>
    expect(onDisk['1']).toMatchObject({ someFutureField: { nested: true }, lastPlayed: '2025-01-01' })
  })

  test('标题会被 trim 后写入', () => {
    store.saveGame({ game: draft({ gameTitle: '  带空格  ' }) })
    const onDisk = JSON.parse(readFileSync(store.gamesFile, 'utf8')) as Record<string, Record<string, unknown>>
    expect(onDisk['1']?.gameTitle).toBe('带空格')
  })
})

describe('saveGame 校验', () => {
  test('标题 / 路径 / 引擎缺失 → error.requiredGame', () => {
    for (const key of ['gameTitle', 'gamePath', 'gameEngine']) {
      const game = draft({ [key]: '   ' })
      expect(() => store.saveGame({ game })).toThrow(
        expect.objectContaining({ translationKey: 'error.requiredGame' })
      )
    }
  })

  test('game 不是对象 → error.missingGame', () => {
    expect(() => store.saveGame({ game: undefined as never })).toThrow(
      expect.objectContaining({ translationKey: 'error.missingGame' })
    )
  })

  test('重名（忽略大小写）→ error.duplicateGame', () => {
    store.saveGame({ game: draft({ gameTitle: 'Game One' }) })
    expect(() => store.saveGame({ game: draft({ gameTitle: 'game one' }) })).toThrow(
      expect.objectContaining({ translationKey: 'error.duplicateGame' })
    )
    // 改名自己不算重名
    expect(() => store.saveGame({ id: '1', game: draft({ gameTitle: 'GAME ONE' }) })).not.toThrow()
  })

  test('id 不存在 / 非数字 → error.staleGame', () => {
    expect(() => store.saveGame({ id: '99', game: draft() })).toThrow(
      expect.objectContaining({ translationKey: 'error.staleGame' })
    )
    store.saveGame({ game: draft({ gameTitle: 'X' }) })
    expect(() => store.saveGame({ id: 'abc', game: draft({ gameTitle: 'Y' }) })).toThrow(
      expect.objectContaining({ translationKey: 'error.staleGame' })
    )
  })

  test('引擎名含路径分隔符 / .. → error.invalidComponent', () => {
    // 注意：空字符串会先被 requiredGame 拦下，不属于 component 的校验范围
    for (const engine of ['../evil', 'a/b', 'a\\b', '..', '.']) {
      expect(() => store.saveGame({ game: draft({ gameEngine: engine }) })).toThrow(
        expect.objectContaining({ translationKey: 'error.invalidComponent' })
      )
    }
  })

  test('空引擎名在 requiredGame 就被拦下（早于 component 校验）', () => {
    expect(() => store.saveGame({ game: draft({ gameEngine: '' }) })).toThrow(
      expect.objectContaining({ translationKey: 'error.requiredGame' })
    )
  })
})

describe('损坏文件的处理', () => {
  test('损坏的 games.json → writeJSON 抛错且原文件不变', () => {
    const corrupt = '{ this is not json'
    writeFileSync(store.gamesFile, corrupt, 'utf8')
    expect(() => store.saveGame({ game: draft() })).toThrow()
    // 原文件必须原样保留，且不能生成 .bak（我们从不静默覆盖损坏文件）
    expect(readFileSync(store.gamesFile, 'utf8')).toBe(corrupt)
    expect(existsSync(`${store.gamesFile}.bak`)).toBe(false)
  })

  test('JSON 是数组 / 标量 → error.invalidObject', () => {
    writeFileSync(store.gamesFile, '[1,2,3]', 'utf8')
    expect(() => readJSON(store.gamesFile)).toThrow(
      expect.objectContaining({ translationKey: 'error.invalidObject' })
    )
    writeFileSync(store.gamesFile, '"text"', 'utf8')
    expect(() => readJSON(store.gamesFile)).toThrow(
      expect.objectContaining({ translationKey: 'error.invalidObject' })
    )
  })

  test('写入时不会留下 .tmp 残留', () => {
    store.saveGame({ game: draft() })
    const files = readdirSync(dataDir)
    expect(files.some((name) => name.endsWith('.tmp'))).toBe(false)
  })
})

describe('settings', () => {
  test('默认值（无文件时）', () => {
    expect(store.settings()).toEqual({
      listView: false,
      deletionConfirmation: true,
      nonInstalledAutodetect: true,
      checkModuleUpdatesOnStartup: true,
      appearance: 'system',
      language: 'system',
      // R18 封面保护默认开启（打码）；只影响渲染，元数据照常抓取与保存。
      showAdultCovers: false,
      // M2.5-C：§7-① 用户确认 —— 首选中文、次选日文；
      // §7-⑤ 默认弹确认（用户可「不再询问」）
      preferredLanguage: 'zh',
      fallbackLanguage: 'ja',
      languageSwitchPrompt: true,
      // M3 §4.3：启动前自动诊断默认开（嫌慢可在设置页关掉）
      diagnoseBeforeLaunch: true
    })
  })

  test('上游 darkTheme 兼容：true → dark，false → light', () => {
    writeJSON(store.settingsFile, { darkTheme: true })
    expect(store.settings().appearance).toBe('dark')
    writeJSON(store.settingsFile, { darkTheme: false })
    expect(store.settings().appearance).toBe('light')
  })

  test('saveSettings({appearance:"system"}) 会删掉 darkTheme', () => {
    writeJSON(store.settingsFile, { appearance: 'dark', darkTheme: true })
    store.saveSettings({ appearance: 'system' })
    const raw = JSON.parse(readFileSync(store.settingsFile, 'utf8')) as Record<string, unknown>
    expect(raw).not.toHaveProperty('darkTheme')
    expect(raw.appearance).toBe('system')
  })

  test('saveSettings({appearance:"dark"}) 写回 darkTheme=true（上游兼容）', () => {
    store.saveSettings({ appearance: 'dark' })
    const raw = JSON.parse(readFileSync(store.settingsFile, 'utf8')) as Record<string, unknown>
    expect(raw.darkTheme).toBe(true)
  })

  test('非法 appearance / language 被拒', () => {
    expect(() => store.saveSettings({ appearance: 'neon' })).toThrow(
      expect.objectContaining({ translationKey: 'error.appearance' })
    )
    expect(() => store.saveSettings({ language: 'no spaces allowed' })).toThrow(
      expect.objectContaining({ translationKey: 'error.language' })
    )
    // 合法值
    expect(() => store.saveSettings({ language: 'zh-CN' })).not.toThrow()
    expect(() => store.saveSettings({ language: 'system' })).not.toThrow()
  })

  test('normalizeSettings 保留未知键', () => {
    const normalized = normalizeSettings({ appearance: 'dark', futureOption: 42 })
    expect(normalized.appearance).toBe('dark')
    expect((normalized as Record<string, unknown>).futureOption).toBe(42)
  })

  test('settings 在 snapshot 里合并为完整对象', () => {
    writeJSON(store.settingsFile, { listView: true })
    const snapshot = store.snapshot()
    expect(snapshot.settings.listView).toBe(true)
    expect(snapshot.settings.deletionConfirmation).toBe(true) // 默认值补上
  })
})

describe('snapshot 与 removeGame', () => {
  test('snapshot 把 games 映射成数组并带 id', () => {
    store.saveGame({ game: draft({ gameTitle: 'A' }) })
    store.saveGame({ game: draft({ gameTitle: 'B' }) })
    const snapshot = store.snapshot()
    expect(snapshot.games).toHaveLength(2)
    expect(snapshot.games.map((game) => game.id).sort()).toEqual(['1', '2'])
    expect(snapshot.dataPath).toBe(dataDir)
    expect(snapshot.nodeVersion).toBe(process.version)
    expect(snapshot.engineUpdates).toBeNull()
  })

  test('snapshot 接受注入的 modules / engineUpdates', () => {
    const snapshot = store.snapshot({ modules: [{ id: 'nwjs' }], engineUpdates: { checkedAt: 'x' } })
    expect(snapshot.modules).toEqual([{ id: 'nwjs' }])
    expect(snapshot.engineUpdates).toEqual({ checkedAt: 'x' })
  })

  test('snapshot 默认带空的 meta（M2：GameRecord 不动，这是新增的旁挂字段）', () => {
    store.saveGame({ game: draft() })
    const snapshot = store.snapshot()
    expect(snapshot.meta).toEqual({})
    // 关键：games 里绝不能出现 DLsite 字段（D18 / D10）
    expect(snapshot.games[0]).not.toHaveProperty('rj')
    expect(snapshot.games[0]).not.toHaveProperty('coverUrl')
    expect(snapshot.games[0]).not.toHaveProperty('circle')
  })

  test('snapshot 接受注入的 meta', () => {
    const snapshot = store.snapshot({ meta: { '1': { rj: 'RJ294126', title: 'x' } } })
    expect(snapshot.meta['1']).toEqual({ rj: 'RJ294126', title: 'x' })
  })

  test('removeGame 删除并落盘；不存在 → error.gameNotFound', () => {
    store.saveGame({ game: draft() })
    store.removeGame('1')
    expect(store.loadGames()).toEqual({})
    expect(() => store.removeGame('1')).toThrow(
      expect.objectContaining({ translationKey: 'error.gameNotFound' })
    )
  })

  test('数据目录不存在时会自动创建', () => {
    const nested = path.join(dataDir, 'deep', 'deeper')
    mkdirSync(nested, { recursive: true })
    const nestedStore = createGameStore(nested)
    nestedStore.saveGame({ game: draft() })
    expect(existsSync(path.join(nested, 'games.json'))).toBe(true)
  })
})
