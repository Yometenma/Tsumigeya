// M4.1 S5 单测：把「上游清单」相关代码删干净，并防止它们回来。
//
// ===== 这一层为什么必须存在 =====
//
// D60 的要求是「ruffle / wine / macos 在代码里**彻底不存在**」，不是「被 filter 挡住」。
// 而这类「删干净」的工作有个共同弱点：**下个会话很容易顺手接回去**。
// 原因往往是善意的 ——
//   · 「core 里明明有这个 API，为什么不接上？」（因为那个 API 拉的是 7 个模块）
//   · 「加个 try/catch 更稳」（接上了就得处理网络失败，越写越像原来那套）
//
// 所以这里不靠人肉 review，而是**扫源码 + 扫接口声明**：
//   · 主进程不许出现这些名字（注释除外）
//   · `CoreApi` 接口里不许有这些方法的声明（留着声明 = 留着一条随时能接上的口子）
//   · 渲染层不许出现那三个引擎名
//
// ⚠️ 范围内的例外（不是漏删）：
//   · `resources/core/module.js` 里仍有这些实现 —— 那是 GPL fork 的整文件，
//     删 API 属于 M4.2 的范围（见 docs/盘点-还留着哪些上游依赖.md），本步只保证
//     **我们这边没有调用点，也没有接口声明**
//   · 注释里允许提到它们（解释「为什么删掉」是必要的）
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { createCoreHost } from '../src/main/core-host'
import { createDispatcher } from '../src/main/ipc'
import { ENGINES, ENGINE_FOLDERS } from '../src/main/engines/registry'

const MAIN = path.join(process.cwd(), 'src', 'main')
const RENDERER = path.join(process.cwd(), 'src', 'renderer', 'src')

const created: string[] = []
afterAll(() => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

/** 收集某目录下的 .ts 文件。 */
function collectTs(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.ts')) out.push(full)
    }
  }
  walk(root)
  return out
}

/**
 * 剥掉注释（块注释 + 行注释），只留代码。
 *
 * `\/\*` 与 `\*\/` 的反斜杠**必须写全**：少写一个只会匹配单个斜杠，
 * 于是把注释之后的一切（含真正的代码）全吃掉（本鱼在 S4 踩过这个坑）。
 */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const index = line.indexOf('//')
      return index < 0 ? line : line.slice(0, index)
    })
    .join('\n')
}

// ===== 1. 主进程里不许出现「拉上游清单」的调用 =====

describe('S5 主进程：不再有拉上游清单的调用点', () => {
  /**
   * 要禁的**函数名**（精确到调用括号，不做裸子串匹配）。
   *
   * ⚠️ 为什么必须带 `(`：`preloadScript` 里含 `loadScript` 这个子串
   * （registry 的 mkxpz 参数名就是 `preloadScript`）。裸子串匹配会把
   * 「合法的参数名」误判成「残留的 API 调用」——本鱼第一版就是这么搞红的。
   * 带 `(` 之后判据变成「有没有**调用**它」，这才是真正要禁的。
   */
  const FORBIDDEN_CALLS = [
    'fetchRemoteManifestsList(',
    'fetchModulesForAutodetect(',
    'installModuleWithProgress(',
    'updateModulePreservingMultiversionsWithProgress(',
    'loadScript(',
    'scriptPath('
  ]

  test('src/main 的代码里不出现这些调用（注释除外）', () => {
    for (const file of collectTs(MAIN)) {
      const code = codeOnly(fs.readFileSync(file, 'utf8'))
      for (const banned of FORBIDDEN_CALLS) {
        expect(code, `${path.relative(MAIN, file)} 里出现了 ${banned}`).not.toContain(banned)
      }
    }
  })

  test('CoreApi 接口里不再声明这些方法（声明 = 留一条随时能接上的口子）', () => {
    const source = fs.readFileSync(path.join(MAIN, 'core-host.ts'), 'utf8')
    const code = codeOnly(source)
    for (const banned of FORBIDDEN_CALLS) {
      expect(code, `core-host.ts 里还有 ${banned} 的声明`).not.toContain(banned)
    }
  })

  test('那三个引擎在 src/main 的**身份位**里不存在', () => {
    // 身份位 = registry 的 folder / name（「什么算一个引擎」的唯一答案）。
    // `macos` 是平台词（下载地址里到处都是），不能用整串扫。
    const identities = ENGINES.flatMap((engine) => [engine.folder, engine.name]).join(' ').toLowerCase()
    for (const gone of ['ruffle', 'wine', 'macos']) {
      expect(identities).not.toContain(gone)
    }
    for (const gone of ['ruffle', 'wine', 'macos']) {
      expect(ENGINE_FOLDERS).not.toContain(gone)
    }
  })

  test('源码里（注释除外）不出现 ruffle / wine 这两个引擎名', () => {
    for (const file of collectTs(MAIN)) {
      const code = codeOnly(fs.readFileSync(file, 'utf8')).toLowerCase()
      for (const gone of ['ruffle', 'wine']) {
        expect(code, `${path.relative(MAIN, file)} 里出现了 ${gone}`).not.toContain(gone)
      }
    }
  })
})

// ===== 2. 渲染层同样干净 =====

describe('S5 渲染层：不出现那三个引擎名', () => {
  test('.vue / .ts 里没有 ruffle 与 wine', () => {
    const files: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.vue') || entry.name.endsWith('.ts')) files.push(full)
      }
    }
    walk(RENDERER)
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8')
      // .vue 的模板注释是 <!-- -->，先去那种
      const code = codeOnly(source.replace(/<!--[\s\S]*?-->/g, '')).toLowerCase()
      expect(code, `${path.relative(RENDERER, file)} 里出现了 ruffle`).not.toContain('ruffle')
      expect(code, `${path.relative(RENDERER, file)} 里出现了 wine`).not.toContain("'wine'")
    }
  })

  test('删除的一致性测试文件确实不在了（没有两份名单也就没有比对对象）', () => {
    const gone = path.join(process.cwd(), 'test', 'launchable-engines-consistency.test.ts')
    expect(fs.existsSync(gone), 'launchable-engines-consistency.test.ts 应该已删除').toBe(false)
  })
})

// ===== 3. 三个命令的最终行为（改完之后仍然对） =====

describe('S5 三个引擎相关命令的最终行为', () => {
  function makeHost(): { host: ReturnType<typeof createCoreHost>; dir: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-s5-'))
    created.push(dir)
    const host = createCoreHost({
      dataDir: dir,
      fetchImpl: async () => {
        throw new Error('S5 不该联网')
      },
      onEvent: () => undefined
    })
    return { host, dir }
  }

  test('remoteModules：四个，零网络', async () => {
    const { host } = makeHost()
    const modules = (await createDispatcher({ host }).dispatch(
      'remoteModules',
      {},
      new AbortController().signal
    )) as Array<{ folder: string }>
    // M6 起引擎会增加（tyrano / kirikiri），但**原有四个的顺序是契约**
    // 原有四个的顺序不许变（D60）；新引擎只能往后追加
    expect(modules.map((module) => module.folder).slice(0, 4)).toEqual(["nwjs","mkxpz","easyrpg","renpy"])
    expect(modules.map((module) => module.folder)).toEqual(ENGINE_FOLDERS.map(String))
  })

  test('detect：未装引擎时用 registry 规则认（零网络、同步完成）', async () => {
    const { host } = makeHost()
    const fixtures = path.join(process.cwd(), 'test', 'fixtures')
    // 传一个**空的 dataDir**（什么都没装）→ 只能靠 registry 规则
    const result = (await createDispatcher({ host }).dispatch(
      'detect',
      { path: path.join(fixtures, 'rpg-vxace', 'Game.exe') },
      new AbortController().signal
    )) as { engine: string | null; installed: boolean }

    expect(result.engine).toBe('mkxpz')
    expect(result.installed, '没装引擎 → installed 必须是 false').toBe(false)
  })

  test('detect 的 includeRemote:false 不用 registry 规则', async () => {
    const { host } = makeHost()
    const fixtures = path.join(process.cwd(), 'test', 'fixtures')
    const result = (await createDispatcher({ host }).dispatch(
      'detect',
      { path: path.join(fixtures, 'rpg-vxace', 'Game.exe'), includeRemote: false },
      new AbortController().signal
    )) as { engine: string | null }
    expect(result.engine).toBeNull()
  })

  test('detectFolder 与 detect 用的是**同一套规则**（四个引擎都能认出来）', async () => {
    const { host } = makeHost()
    const fixtures = path.join(process.cwd(), 'test', 'fixtures')
    const cases: Array<[string, string, string]> = [
      ['rpg-mv', 'Game.exe', 'nwjs'],
      ['rpg-vxace', 'Game.exe', 'mkxpz'],
      ['rpg-2000', 'RPG_RT.exe', 'easyrpg'],
      ['renpy', 'Game.exe', 'renpy']
    ]
    const dispatcher = createDispatcher({ host })
    for (const [dir, exe, expected] of cases) {
      // detect 命令（走 engineDefinitionsFromRegistry）
      const viaDetect = (await dispatcher.dispatch(
        'detect',
        { path: path.join(fixtures, dir, exe) },
        new AbortController().signal
      )) as { engine: string | null }
      // detectFolder（走同一份规则）
      const viaFolder = await host.detectFolder({ path: path.join(fixtures, dir) })
      expect(viaDetect.engine, `${dir} 走 detect`).toBe(expected)
      expect(viaFolder.best?.engine, `${dir} 走 detectFolder`).toBe(expected)
    }
  })

  test('checkEngineUpdates：零网络、cachedRemote 恒 false、报告结构不变', async () => {
    const { host } = makeHost()
    const report = (await createDispatcher({ host }).dispatch(
      'checkEngineUpdates',
      {},
      new AbortController().signal
    )) as Record<string, unknown>
    expect(report.cachedRemote).toBe(false)
    for (const field of ['checkedAt', 'warnings', 'remoteModules', 'updates']) {
      expect(report).toHaveProperty(field)
    }
  })
})

// ===== 4. 全仓库 grep 取证（含文档）=====

describe('S5 文档与注释里的说明仍然在（删了代码不等于删了知识）', () => {
  test('M4.1 方案文档仍然记录了这次为什么这么改', () => {
    const doc = fs.readFileSync(path.join(process.cwd(), 'docs', 'M4.1-实施方案.md'), 'utf8')
    for (const decision of ['D60', 'D61', 'D62']) {
      expect(doc, `方案里应当有 ${decision}`).toContain(decision)
    }
  })

  test('registry.ts 里写明了「为什么 nwjs 只剩一个参数」（避免下个会话以为是漏了）', () => {
    const source = fs.readFileSync(path.join(MAIN, 'engines', 'registry.ts'), 'utf8')
    // 注释里要交代 cheat 被删的理由，否则下个会话会「好心」加回来
    expect(source).toContain('作弊菜单') // cheat 的解释
    expect(source).toContain('不改写用户的游戏文件')
  })

  test('registry.ts 里写明了 mkxpz/renpy 硬编码路径的修正（含「方案漏了 renpy」）', () => {
    const source = fs.readFileSync(path.join(MAIN, 'engines', 'registry.ts'), 'utf8')
    // 三处占位符都要有注释交代（路径层级 + 方案漏掉 renpy 这一处）
    expect(source).toContain('modules/mkxpz/deps/kawariki')
    expect(source).toContain('modules/mkxpz/deps/soundfont')
    // 方案 §1.2 只列了 mkxpz 两处，renpy 的 savedir 是漏的 —— 注释里必须说明
    expect(source).toContain('漏掉的第二处硬编码')
  })
})
