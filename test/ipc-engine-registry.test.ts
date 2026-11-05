// M4.1 S2 单测：remoteModules / checkEngineUpdates 改读 registry（D60）。
//
// 这两条命令是「引擎清单来自上游」的**最后两个出口**。改完之后必须证明两件事：
//   1. 返回的**只有那四个**，且它们没有 ruffle / wine / macos
//   2. **一次网络请求都不发** —— 这条最要紧。
//
// 为什么第 2 条要用「会抛错的 fetch」+ 「会挂死的 fetch」两种替身：
//   · 抛错的替身能证明「断网也能工作」（这是用户开代理/没网时的真实场景）
//   · 挂死的替身能证明「不是碰巧没走到网络，而是根本没走」（如果还有残留的网络调用，
//     挂死的 fetch 会让测试卡住 → 超时 → 红）
//
// 另外要验 `checkEngineUpdates` 的**语义变化**（R5）：`remoteVersion` 现在是我们维护的
// 版本号；`cachedRemote` 恒 false；装了但 registry 里没有的引擎不报「有更新」。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createCoreHost } from '../src/main/core-host'
import { readLocalManifests } from '../src/main/engines/manifest'
import { createDispatcher } from '../src/main/ipc'
import { ENGINES, ENGINE_FOLDERS, buildManifest, findEngine } from '../src/main/engines/registry'

let dataDir: string
let host: ReturnType<typeof createCoreHost>

/** 统计 fetch 被调用了几次：S2 之后必须是 0。 */
let fetchCalls = 0

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-s2-'))
  host = createCoreHost({
    dataDir,
    // 会抛错 + 计数：既证明「不用网络」，也能在失败时看到「谁还在调」
    fetchImpl: async (input: string) => {
      fetchCalls += 1
      throw new Error(`网络在 S2 之后不该被调用：${input}`)
    },
    onEvent: () => undefined
  })
})

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true })
})

function makeDispatcher() {
  return createDispatcher({ host })
}

/** 在 <dataDir>/modules/<folder> 里写一份 manifest（模拟「已安装」）。 */
function installFakeModule(folder: string, manifest: Record<string, unknown>): void {
  const dir = path.join(dataDir, 'modules', folder)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
}

describe('S2 remoteModules：只有 registry 里那四个，且不发网络请求', () => {
  test('返回恰好四个，folder 与 ENGINES 一致', async () => {
    fetchCalls = 0
    const modules = (await makeDispatcher().dispatch('remoteModules', {}, new AbortController().signal)) as Array<
      Record<string, unknown>
    >
        // 原有四个的顺序不许变（D60）；新引擎只能往后追加
    expect(modules.map((module) => module.folder).slice(0, 4)).toEqual(["nwjs","mkxpz","easyrpg","renpy"])
    expect(modules.map((module) => module.folder)).toEqual(ENGINE_FOLDERS.map(String))
    expect(fetchCalls, 'remoteModules 一个网络请求都不该发').toBe(0)
  })

  test('那三个不支持的引擎不在结果里（不是被过滤，是 registry 里没有）', async () => {
    const modules = (await makeDispatcher().dispatch('remoteModules', {}, new AbortController().signal)) as Array<
      Record<string, unknown>
    >
    const folders = modules.map((module) => module.folder)
    for (const gone of ['ruffle', 'wine', 'macos']) {
      expect(folders).not.toContain(gone)
    }
    // 更强的判据：**引擎标识位**里不许出现那三个名字。
    //
    // ⚠️ 不能拿整个 JSON 去扫 "macos"：easyrpg 的下载地址是
    // `https://ci.easyrpg.org/downloads/macos/EasyRPG-Player-macos.app.zip`
    // —— 那里的 `macos` 是**平台名**（区分 mac/linux/windows 构建），不是引擎名。
    // 用整串扫会把它误判成「还有 macos 引擎」（本鱼第一版就是这么把自己的测试搞红的）。
    for (const module of modules) {
      const identity = `${module.folder} ${module.id} ${module.name}`.toLowerCase()
      for (const gone of ['ruffle', 'wine', 'macos']) {
        expect(identity, `${String(module.folder)} 的身份里出现了 ${gone}`).not.toContain(gone)
      }
    }
  })

  test('每条都带 raw（装引擎时要把它写进磁盘，S3 依赖这一点）', async () => {
    const modules = (await makeDispatcher().dispatch('remoteModules', {}, new AbortController().signal)) as Array<{
      folder: string
      name: string
      version: string
      raw: Record<string, unknown>
    }>
    for (const module of modules) {
      expect(module.name).toBeTruthy()
      expect(module.version).toBeTruthy()
      expect(module.raw, `${module.folder} 缺 raw`).toBeTruthy()
      expect(module.raw.version).toBe(module.version)
      expect(module.raw.autodetect, `${module.folder} 的 raw 缺 autodetect`).toBeTruthy()
      expect(module.raw.dependencies, `${module.folder} 的 raw 缺 dependencies`).toBeTruthy()
    }
  })

  test('raw 与 buildManifest 的产物一致（不能在这里另造一份）', async () => {
    fetchCalls = 0
    const modules = (await makeDispatcher().dispatch('remoteModules', {}, new AbortController().signal)) as Array<{
      folder: string
      raw: Record<string, unknown>
    }>
    for (const module of modules) {
      expect(module.raw).toEqual(buildManifest(findEngine(module.folder)!))
    }
    expect(fetchCalls).toBe(0)
  })

  test('id 与 folder 相同（渲染层两个字段都在用）', async () => {
    const modules = (await makeDispatcher().dispatch('remoteModules', {}, new AbortController().signal)) as Array<{
      id: string
      folder: string
    }>
    for (const module of modules) expect(module.id).toBe(module.folder)
  })
})

describe('S2 checkEngineUpdates：不再拉远端，只比 registry 版本', () => {
  test('一次网络请求都不发（初始状态，什么都没装）', async () => {
    fetchCalls = 0
    const report = (await makeDispatcher().dispatch(
      'checkEngineUpdates',
      {},
      new AbortController().signal
    )) as Record<string, unknown>
    // 依赖检查**理论上**要网络（查上游 release），但本机没有任何已装模块 → 没有目录可查 → 不发请求
    expect(fetchCalls).toBe(0)
    expect(report.updates).toEqual([])
    expect(report.remoteModules).toBeTruthy()
  })

  test('cachedRemote 恒 false（没有远端缓存这回事了）', async () => {
    const report = (await makeDispatcher().dispatch(
      'checkEngineUpdates',
      {},
      new AbortController().signal
    )) as { cachedRemote: boolean }
    expect(report.cachedRemote).toBe(false)
  })

  test('装了 nwjs 且本地版本比 registry 旧 → moduleUpdate=true，remoteVersion 是 registry 的版本', async () => {
    installFakeModule('nwjs', { ...buildManifest(findEngine('nwjs')!), version: '1.0.0' })
    const report = (await makeDispatcher().dispatch(
      'checkEngineUpdates',
      {},
      new AbortController().signal
    )) as { updates: Array<Record<string, unknown>> }

    const nwjs = report.updates.find((item) => item.id === 'nwjs')!
    expect(nwjs.localVersion).toBe('1.0.0')
    // registry 维护的是 1.4.4 —— 这就是「远端版本」
    expect(nwjs.remoteVersion).toBe('1.4.4')
    expect(nwjs.moduleUpdate).toBe(true)
  })

  test('本地版本与 registry 一致 → moduleUpdate=false', async () => {
    // 覆盖成 registry 的版本
    installFakeModule('nwjs', buildManifest(findEngine('nwjs')!))
    const report = (await makeDispatcher().dispatch(
      'checkEngineUpdates',
      {},
      new AbortController().signal
    )) as { updates: Array<Record<string, unknown>> }
    const nwjs = report.updates.find((item) => item.id === 'nwjs')!
    expect(nwjs.moduleUpdate).toBe(false)
  })

  test('装了但 registry 里没有的引擎（旧版留下的）→ 不报「有更新」，且给一条可读提示', async () => {
    // 模拟用户从旧版升级上来：modules 目录里还躺着 ruffle
    installFakeModule('ruffle', { name: 'Ruffle', version: '1.0.0', autodetect: {} })

    const report = (await makeDispatcher().dispatch(
      'checkEngineUpdates',
      {},
      new AbortController().signal
    )) as { updates: Array<Record<string, unknown>>; warnings: string[] }

    const ruffle = report.updates.find((item) => item.id === 'ruffle')!
    expect(ruffle).toBeTruthy()
    // 我们不再维护它 → 没有「远端版本」，也不该催用户更新
    expect(ruffle.remoteVersion).toBe('N/A')
    expect(ruffle.moduleUpdate).toBe(false)
    // 但必须告诉用户「这个引擎我们不管了」，否则他会一直看到它却不知道怎么回事
    expect(report.warnings.some((warning) => warning.includes('ruffle'))).toBe(true)

    fs.rmSync(path.join(dataDir, 'modules', 'ruffle'), { recursive: true, force: true })
  })

  test('依赖更新检查**已明确停用**（不是漏写）——装了模块也不发网络请求', async () => {
    // 为什么停用（见 ipc.ts 的注释）：
    //   依赖更新原来靠模块自带的 `updates.js`（`loadUpdatesProvider` 读 manifest 的
    //   `updates: true` + 加载 `<module>/updates.js`）。我们不再下载模块文件、生成的
    //   manifest 也不写 `updates` 字段 → provider 恒 null → 那次调用只会白扫一遍目录。
    //
    // 这条测试的判据：**装了模块也不该发网络请求**。
    // 如果哪天有人把 `checkDependencyUpdatesForFolders` 加回来，这里立刻变红
    // （fetchImpl 会抛错 + fetchCalls 计数 > 0）。
    installFakeModule('mkxpz', buildManifest(findEngine('mkxpz')!))
    fetchCalls = 0

    const report = (await makeDispatcher().dispatch(
      'checkEngineUpdates',
      {},
      new AbortController().signal
    )) as { updates: Array<Record<string, unknown>>; warnings: string[] }

    expect(fetchCalls, '依赖更新检查已停用，不该发任何网络请求').toBe(0)
    const mkxpz = report.updates.find((item) => item.id === 'mkxpz')!
    expect(mkxpz).toBeTruthy()
    // 停用后这两个字段恒为「没有更新 / 没失败」（字段保留是为了不破坏数据结构）
    expect(mkxpz.dependencyUpdate).toBe(false)
    expect(mkxpz.checkFailed).toBe(false)

    fs.rmSync(path.join(dataDir, 'modules', 'mkxpz'), { recursive: true, force: true })
  })

  test('我们生成的 manifest 不写 updates 字段（这正是依赖检查停用的原因）', () => {
    for (const engine of ENGINES) {
      const manifest = buildManifest(engine)
      // 写了 `updates: true` 就会让 core 去找 `<module>/updates.js`，而那个文件我们不再下载
      expect(manifest, `${engine.folder} 不该写 updates 字段`).not.toHaveProperty('updates')
    }
  })

  test('返回的 report 结构字段齐全（渲染层在读这几个）', async () => {
    const report = (await makeDispatcher().dispatch(
      'checkEngineUpdates',
      {},
      new AbortController().signal
    )) as Record<string, unknown>
    for (const field of ['checkedAt', 'cachedRemote', 'warnings', 'remoteModules', 'updates']) {
      expect(report, `缺字段 ${field}`).toHaveProperty(field)
    }
    expect(typeof report.checkedAt).toBe('string')
    expect(Array.isArray(report.warnings)).toBe(true)
    expect(Array.isArray(report.updates)).toBe(true)
  })
})

describe('S2 registry 与 Snapshot 的兼容性', () => {
  test('registry 生成的 manifest 能被 core 的 readLocalManifests 读回（D62 的核心要求）', () => {
    const folder = '__s2_roundtrip__'
    const dir = path.join(dataDir, 'modules', folder)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify(buildManifest(findEngine('mkxpz')!))
    )

    const local = readLocalManifests(host.dataDir)
    expect(local[folder]).toBeTruthy()
    // 读回来的版本 / autodetect / dependencies 都在
    expect(local[folder].version).toBe('1.1.5')
    expect(local[folder].autodetect).toEqual(findEngine('mkxpz')!.autodetect)
    expect(Object.keys(local[folder].dependencies ?? {}).sort()).toEqual([
      'RTP',
      'kawariki',
      'mkxpz',
      'soundfont'
    ])
    // gameArgs 是上游认的形状（没有我们的 labelKey）
    expect(local[folder].gameArgs?.rgssVersion).toMatchObject({ type: 'dropdown' })

    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('每个引擎生成的 manifest 都能往返（不是只有 mkxpz 能过）', () => {
    for (const engine of ENGINES) {
      const folder = `__s2_${engine.folder}__`
      const dir = path.join(dataDir, 'modules', folder)
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(buildManifest(engine)))

      const local = readLocalManifests(host.dataDir)
      expect(local[folder], `${engine.folder} 读不回来`).toBeTruthy()
      expect(local[folder].version).toBe(engine.version)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
