// M4.1 S4 单测：渲染层清理（D60）。
//
// 这一层要钉死的是**「界面上只剩四个引擎」这件事真的成立**，而且要钉在**源码与数据**两层：
//
//   1. `remoteModules` 只返回四个（渲染层的「可安装」列表就这四行）
//   2. 渲染层**不再有第二份引擎名单**（`LAUNCHABLE_ENGINE_IDS` 镜像已删）
//   3. 引擎页不再画「不支持启动」的标灰（那个场景已经不存在）
//   4. 参数表单认得 `string`（上游写法）与 `text`（历史方言）两种 type
//
// 为什么用源码扫描而不是断言 DOM：
//   本机没有画面（无桌面会话），只能断言「页面里到底写了什么」。
//   源码扫描能抓住「代码回到旧形态」，DOM 断言在 CI 上跑不起来。
//   真正的界面观感仍然要在有画面的机器上人眼验收（写进 AGENTS.md 的待验证项）。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createCoreHost } from '../src/main/core-host'
import { createDispatcher } from '../src/main/ipc'
import { ENGINES, ENGINE_FOLDERS, findEngine } from '../src/main/engines/registry'

const RENDERER = path.join(process.cwd(), 'src', 'renderer', 'src')
const LOCALES = path.join(RENDERER, 'locales', 'zh-CN.json')

/** 读一个渲染层文件；不存在直接失败（改名了要立刻发现）。 */
function readRenderer(relative: string): string {
  const file = path.join(RENDERER, relative)
  if (!fs.existsSync(file)) throw new Error(`渲染层文件不见了：${relative}`)
  return fs.readFileSync(file, 'utf8')
}

/**
 * 去掉注释，避免「注释里解释为什么删掉」被误判成「还在用」。
 *
 * 三种注释都要剥：`<!-- -->`（模板）、`/* ... *\/`（块注释）、`//`（行注释）。
 * 少剥块注释会误伤 —— 本鱼第一版只剥了 `<!-- -->` 与 `//`，结果 EnginesPage 顶部
 * 那段解释「为什么删掉 isLaunchable」的块注释把测试搞红了。
 */
function stripComments(source: string): string {
  return source
    .replace(/<!--[\s\S]*?-->/g, '')
    // 块注释。**必须写成 \/\* ... \*\/**（不是 \/*）：少一个反斜杠只会匹配单个斜杠，
    // 于是把 `/*` 之后的一切（含真正的代码）全吃掉 —— 本鱼就踩了这个坑，
    // 表现为「测试说 EnginesPage 里没有 engines.desc.」，其实是代码被剥没了。
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const index = line.indexOf('//')
      return index < 0 ? line : line.slice(0, index)
    })
    .join('\n')
}

let dataDir: string
let host: ReturnType<typeof createCoreHost>
const created: string[] = []

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-s4-'))
  created.push(dataDir)
  host = createCoreHost({
    dataDir,
    fetchImpl: async () => {
      throw new Error('S4 不该联网')
    },
    onEvent: () => undefined
  })
})

afterAll(() => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ===== 1. 「可安装」列表只有四个 =====

describe('S4 可安装列表：天生只有四个引擎', () => {
  test('remoteModules 返回恰好四个，与 ENGINES 一一对应', async () => {
    const dispatcher = createDispatcher({ host })
    const modules = (await dispatcher.dispatch(
      'remoteModules',
      {},
      new AbortController().signal
    )) as Array<{ folder: string; name: string; version: string }>

    expect(modules.map((module) => module.folder)).toEqual(['nwjs', 'mkxpz', 'easyrpg', 'renpy'])
    expect(modules).toHaveLength(4)
    for (const module of modules) {
      expect(findEngine(module.folder)?.name).toBe(module.name)
      expect(findEngine(module.folder)?.version).toBe(module.version)
    }
  })

  test('那三个引擎在「可安装」列表里不存在（用户根本装不到）', async () => {
    const dispatcher = createDispatcher({ host })
    const modules = (await dispatcher.dispatch(
      'remoteModules',
      {},
      new AbortController().signal
    )) as Array<{ folder: string }>
    const folders = modules.map((module) => module.folder)
    for (const gone of ['ruffle', 'wine', 'macos']) {
      expect(folders).not.toContain(gone)
    }
  })
})

// ===== 2. 渲染层不再有第二份名单 =====

describe('S4 渲染层：不再有引擎名单的镜像', () => {
  test('EnginesPage.vue 里没有 LAUNCHABLE_ENGINE_IDS（镜像已删）', () => {
    const code = stripComments(readRenderer('pages/EnginesPage.vue'))
    expect(code).not.toContain('LAUNCHABLE_ENGINE_IDS')
    expect(code).not.toContain('isLaunchable')
  })

  test('整个渲染层都不许出现「可启动引擎名单」这类镜像（含引擎 folder 的硬编码数组）', () => {
    // 判据：不许在任何 .vue / .ts 里写一个只含这四个引擎名的字面量数组。
    // （正常代码不会这么写：需要引擎名单时应该走主进程下发的 modules/remoteModules。）
    const files = collectFiles(RENDERER)
    for (const file of files) {
      const code = stripComments(fs.readFileSync(file, 'utf8'))
      const literal = /\[\s*['"]nwjs['"]\s*,\s*['"]mkxpz['"]/i.test(code)
      expect(literal, `${path.relative(RENDERER, file)} 里硬编码了引擎名单`).toBe(false)
    }
  })

  test('渲染层里不出现 ruffle / wine 这两个引擎名（截图排查用）', () => {
    // `macos` 不算：它是平台词（例如 img/asset 路径、平台判断里会用到），
    // 引擎身份位由 registry 保证（见 engines-registry.test.ts）。
    for (const file of collectFiles(RENDERER)) {
      const code = stripComments(fs.readFileSync(file, 'utf8')).toLowerCase()
      expect(code, `${path.relative(RENDERER, file)}`).not.toContain('ruffle')
      expect(code, `${path.relative(RENDERER, file)}`).not.toContain("'wine'")
    }
  })
})

// ===== 3. 引擎页不再画「不支持启动」=====

describe('S4 引擎页：不再有「不支持启动」的标灰与提示', () => {
  test('模板里没有 notLaunchableBadge / notLaunchableHint', () => {
    const code = stripComments(readRenderer('pages/EnginesPage.vue'))
    expect(code).not.toContain('notLaunchableBadge')
    expect(code).not.toContain('notLaunchableHint')
  })

  test('i18n 里对应的两条文案也已删除（否则是死文案）', () => {
    const locales = JSON.parse(fs.readFileSync(LOCALES, 'utf8')) as Record<string, Record<string, unknown>>
    const engines = locales.engines as Record<string, unknown>
    expect(engines).not.toHaveProperty('notLaunchableBadge')
    expect(engines).not.toHaveProperty('notLaunchableHint')
  })

  test('但 error.engineNotLaunchable 必须保留（点启动时仍会报它）', () => {
    // 删 UI 上的标灰 ≠ 删错误文案。用户从旧版升级上来、modules 里还留着 ruffle 时，
    // 点启动仍然要得到一句可读的中文（D57）。
    const locales = JSON.parse(fs.readFileSync(LOCALES, 'utf8')) as Record<string, Record<string, unknown>>
    const errors = locales.error as Record<string, unknown>
    expect(errors).toHaveProperty('engineNotLaunchable')
    // 而且这句话里要列出支持的引擎
    expect(String(errors.engineNotLaunchable)).toContain('NW.js')
  })

  test('引擎页不再展示「远程列表来自本地缓存」（没有远端也就没有缓存）', () => {
    const code = stripComments(readRenderer('pages/EnginesPage.vue'))
    expect(code).not.toContain('cachedWarning')
    expect(code).not.toContain('cachedRemote')
  })

  test('引擎页不再展示「无法获取远程引擎列表」（列表来自本地 registry）', () => {
    const code = stripComments(readRenderer('pages/EnginesPage.vue'))
    expect(code).not.toContain('remoteUnavailable')
  })
})

// ===== 4. 参数表单认得 string 与 text =====

describe('S4 参数表单：string（上游写法）与 text（历史方言）都能渲染', () => {
  test('DynamicArgsForm 模板里两种 type 都走同一个输入框', () => {
    const code = readRenderer('components/DynamicArgsForm.vue')
    expect(code).toContain("field.type === 'text' || field.type === 'string'")
  })

  test('GameArgDef 的类型定义包含 string（否则 TS 会拒绝上游写法的 manifest）', () => {
    for (const relative of ['api/client.ts']) {
      const code = readRenderer(relative)
      expect(code, relative).toContain("'string'")
    }
    // 主进程侧也要有（core-host 的 GameArgDef 是 manifest 的类型来源）
    const coreHost = fs.readFileSync(path.join(process.cwd(), 'src', 'main', 'core-host.ts'), 'utf8')
    expect(coreHost).toContain("'string'")
  })

  test('引擎的字符串参数用的就是 string（不是只有 text 一种能显示）', () => {
    const stringParams = ENGINES.flatMap((engine) =>
      Object.entries(engine.gameArgs)
        .filter(([, spec]) => spec.type === 'string')
        .map(([key]) => `${engine.folder}.${key}`)
    )
    // 四个引擎里确实有 string 参数（若只剩 text，这条断言就没意义了）
    expect(stringParams.length).toBeGreaterThan(0)
    expect(stringParams).toContain('mkxpz.windowTitle')
    expect(stringParams).toContain('easyrpg.encoding')
    expect(stringParams).toContain('renpy.savedir')
  })

  test('参数的中文标签都有 i18n（args.<folder>.<key>）', () => {
    const locales = JSON.parse(fs.readFileSync(LOCALES, 'utf8')) as Record<string, Record<string, unknown>>
    const args = locales.args as Record<string, Record<string, unknown>>
    for (const engine of ENGINES) {
      const table = args[engine.folder] as Record<string, unknown> | undefined
      expect(table, `args.${engine.folder} 缺整张表`).toBeTruthy()
      for (const key of Object.keys(engine.gameArgs)) {
        expect(table!, `缺 args.${engine.folder}.${key}`).toHaveProperty(key)
      }
    }
  })

  test('引擎描述的中文文案都有（engines.desc.<folder>）', () => {
    const locales = JSON.parse(fs.readFileSync(LOCALES, 'utf8')) as Record<string, Record<string, unknown>>
    const desc = (locales.engines as Record<string, unknown>).desc as Record<string, unknown> | undefined
    expect(desc, 'engines.desc 缺整张表').toBeTruthy()
    for (const engine of ENGINES) {
      expect(desc!, `缺 engines.desc.${engine.folder}`).toHaveProperty(engine.folder)
    }
  })

  test('引擎页优先用中文描述（而不是 manifest 里的英文）', () => {
    const code = stripComments(readRenderer('pages/EnginesPage.vue'))
    expect(code).toContain('engines.desc.')
  })
})

// ===== 5. i18n 不允许 ICU 语法（老坑，新加文案必须复核）=====

describe('S4 i18n 新文案不含 ICU 语法', () => {
  test('新增的 desc / args 文案里没有复数语法', () => {
    const raw = fs.readFileSync(LOCALES, 'utf8')
    // 本项目只装了 vue-i18n、没装编译器 → `{count, plural, ...}` 会让整个组件白屏
    expect(raw).not.toMatch(/,\s*plural\s*,/)
    expect(raw).not.toMatch(/,\s*select\s*,/)
  })

  test('locales 是合法 JSON（手改文案时最容易漏逗号）', () => {
    expect(() => JSON.parse(fs.readFileSync(LOCALES, 'utf8'))).not.toThrow()
  })
})

/** 收集渲染层所有 .vue / .ts 文件（跳过 node_modules 与构建产物）。 */
function collectFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.vue') || entry.name.endsWith('.ts')) out.push(full)
    }
  }
  walk(root)
  return out
}

// ===== 6. 端到端：装了旧引擎的用户在页面上看到什么 =====

describe('S4 snapshot 的 modules 必须带 raw（修一个 M1 就存在的真 bug）', () => {
  test('modules[] 每一项都同时有 raw 与摊平字段', async () => {
    // ⚠️ 这条钉的是一个**静默失败**（M1 时代就存在，M4.1 S4 端到端探针抓到）：
    //
    //   `ModuleInfo.raw` 的类型声明写的是 `raw: ManifestRaw`，
    //   但主进程 `snapshot()` 原来只写 `{ ...value, id }` —— manifest 内容**摊平在顶层**，
    //   **没有 raw 字段**。于是 `GameEditPage` 的 `manifest = module?.raw ?? null`
    //   永远是 null → 引擎参数表单对所有引擎都显示「该引擎没有可配置参数」。
    //
    //   TS 检查通过、页面不报错、单测抓不到（没人断言 snapshot 的形状）——
    //   只有端到端探针能发现。所以这条必须存在。
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-s4-raw-'))
    created.push(localDir)
    const moduleDir = path.join(localDir, 'modules', 'mkxpz')
    fs.mkdirSync(moduleDir, { recursive: true })
    const manifest = {
      name: 'mkxp-z',
      version: '1.1.5',
      autodetect: { files: ['Game.ini'], all_required: true },
      gameArgs: {
        windowTitle: { type: 'string', label: 'Window Title Override', default: '' },
        fullscreen: { type: 'boolean', label: 'Start in Fullscreen', default: false }
      }
    }
    fs.writeFileSync(path.join(moduleDir, 'manifest.json'), JSON.stringify(manifest))

    const localHost = createCoreHost({
      dataDir: localDir,
      fetchImpl: async () => {
        throw new Error('S4 不该联网')
      },
      onEvent: () => undefined
    })
    const dispatcher = createDispatcher({ host: localHost })
    const snapshot = (await dispatcher.dispatch('snapshot', {}, new AbortController().signal)) as {
      modules: Array<Record<string, unknown>>
    }

    const module = snapshot.modules.find((item) => item.id === 'mkxpz')
    expect(module, 'snapshot 里应该有 mkxpz').toBeTruthy()
    // ① raw 必须存在，且带 gameArgs（参数表单靠它）
    expect(module!.raw, 'modules[] 缺 raw → 参数表单会显示「没有可配置参数」').toBeTruthy()
    const raw = module!.raw as Record<string, unknown>
    expect(raw.version).toBe('1.1.5')
    expect(raw.gameArgs).toBeTruthy()
    expect(Object.keys(raw.gameArgs as Record<string, unknown>)).toEqual(['windowTitle', 'fullscreen'])
    // ② 摊平字段也要保留（引擎页的 displayName/moduleVersion 在读它们）
    expect(module!.name).toBe('mkxp-z')
    expect(module!.version).toBe('1.1.5')
  })

  test('raw 里的参数是上游写法（string），不是我们自己的 labelKey', () => {
    // 参数表单要认的是 `string`（见 DynamicArgsForm 的注释）
    expect(ENGINES.some((engine) => Object.values(engine.gameArgs).some((spec) => spec.type === 'string'))).toBe(
      true
    )
  })
})

describe('S4 端到端：旧引擎残留时的表现', () => {
  test('modules 里有 ruffle → 它出现在「已安装」里，但不在「可安装」里，且给一条提示', async () => {
    const localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-s4-legacy-'))
    created.push(localDir)
    const ruffleDir = path.join(localDir, 'modules', 'ruffle')
    fs.mkdirSync(ruffleDir, { recursive: true })
    fs.writeFileSync(
      path.join(ruffleDir, 'manifest.json'),
      JSON.stringify({ name: 'Ruffle', version: '1.0.0', autodetect: { files: [] } })
    )

    const legacyHost = createCoreHost({
      dataDir: localDir,
      fetchImpl: async () => {
        throw new Error('S4 不该联网')
      },
      onEvent: () => undefined
    })
    const dispatcher = createDispatcher({ host: legacyHost })

    const snapshot = (await dispatcher.dispatch('snapshot', {}, new AbortController().signal)) as {
      modules: Array<{ id: string }>
    }
    const remote = (await dispatcher.dispatch('remoteModules', {}, new AbortController().signal)) as Array<{
      folder: string
    }>
    const report = (await dispatcher.dispatch(
      'checkEngineUpdates',
      {},
      new AbortController().signal
    )) as { warnings: string[] }

    // 已安装列表照常显示它（那是用户磁盘上的事实，不能装作看不见）
    expect(snapshot.modules.map((module) => module.id)).toContain('ruffle')
    // 但「可安装」列表里没有它（用户不能再装它）
    expect(remote.map((module) => module.folder)).not.toContain('ruffle')
    // 并且给一条可读提示（用户从旧版升级上来要知道这是怎么回事）
    expect(report.warnings.some((warning) => warning.includes('ruffle'))).toBe(true)
  })

  test('四个引擎的 folder 集合就是 ENGINE_FOLDERS（渲染层与主进程只有这一个来源）', () => {
    expect(ENGINE_FOLDERS).toEqual(['nwjs', 'mkxpz', 'easyrpg', 'renpy'])
  })
})
