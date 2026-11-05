// M4.1 S1 单测：四个引擎的硬编码定义（D60 / D61 / D62）。
//
// 这一层要钉死三件事：
//   1. **只有这四个**（ruffle / wine / macos 不是被过滤掉的，是在定义层面不存在）
//   2. autodetect 规则与上游实测**逐字段一致**（否则识别会静默错位）
//   3. 参数精简后仍然「自洽」（每个 type 渲染层都认得、默认值类型对得上）
//
// ⚠️ 关于第 1 条的测法：不能只断言 `ENGINES` 里没有那三个 —— 那只证明数组干净。
// 真正的判据是**源码里没有它们的定义/下载地址**（本文件最后一组：扫源码）。
// 否则下个会话完全可以在别处加一个 `const ruffle = {...}` 而测试全绿。
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  DATA_DIR_PLACEHOLDER,
  ENGINE_FOLDERS,
  ENGINES,
  buildManifest,
  expandDataDirInString,
  expandDataDirPlaceholders,
  findEngine
} from '../src/main/engines/registry'
import type { EngineDefinition } from '../src/main/engines/types'

// ===== 1. 清点：只有四个 =====

describe('S1 清点：ENGINES 只有四个引擎', () => {
  test('原有四个在前，顺序与展示顺序一致（M6 起允许追加）', () => {
    // 顺序是契约：引擎页按这个顺序展示。新引擎只能**往后追加**，不能插队。
        // 原有四个的顺序不许变（D60）；新引擎只能往后追加
    expect(ENGINES.map((engine) => engine.folder).slice(0, 4)).toEqual(["nwjs","mkxpz","easyrpg","renpy"])
  })

  test('ENGINE_FOLDERS 与 ENGINES 同源（不多不少）', () => {
    expect(ENGINE_FOLDERS).toEqual(ENGINES.map((engine) => engine.folder))
  })

  test('那三个不支持的引擎：查不到定义（不是被 filter 掉的）', () => {
    for (const gone of ['ruffle', 'wine', 'macos']) {
      expect(findEngine(gone)).toBeUndefined()
      expect(ENGINE_FOLDERS).not.toContain(gone)
    }
  })

  test('findEngine 精确匹配，不做大小写模糊（避免 "NWJS " 这种脏值被认成 nwjs）', () => {
    expect(findEngine('nwjs')?.folder).toBe('nwjs')
    expect(findEngine('NWJS')).toBeUndefined()
    expect(findEngine('nwjs ')).toBeUndefined()
  })

  test('每个定义都有 folder/name/version/description 四个必填项', () => {
    for (const engine of ENGINES) {
      expect(engine.folder).toMatch(/^[a-z0-9-]+$/)
      expect(engine.name.trim()).not.toBe('')
      expect(engine.version.trim()).not.toBe('')
      expect(engine.description.trim()).not.toBe('')
      expect(engine.descriptionKey).toMatch(/^engines\.desc\./)
    }
  })
})

// ===== 2. autodetect 与上游实测一致 =====
//
// 期望值**照抄实测**（docs/M4.1-实施方案.md §1.1，实施时对照上游 manifest 复核过）。
// 这组断言的意义：规则一旦被「顺手优化」，识别就静默错位 —— 用户添加游戏时引擎认不出来，
// 表现是「明明装了引擎却提示未识别」，查起来极难。

describe('S1 autodetect：与上游实测规则一致', () => {
  const EXPECTED: Record<string, EngineDefinition['autodetect']> = {
    nwjs: { files: ['nw.dll', 'package.json'], all_required: true },
    mkxpz: { files: ['Game.ini', 'System', 'Graphics', 'Audio'], all_required: true },
    easyrpg: { files: ['RPG_RT.ldb', 'RPG_RT.lmt', 'RPG_RT.ini'], all_required: false },
    renpy: { extensions: ['py', 'exe', 'sh'], files: ['renpy'], all_required: true }
  }

  test('四个引擎的 autodetect 逐字段一致', () => {
    for (const [folder, expected] of Object.entries(EXPECTED)) {
      expect(findEngine(folder)?.autodetect).toEqual(expected)
    }
  })

  test('all_required 的取值不能被「顺手统一」（easyrpg 是 false）', () => {
    // easyrpg 用 false 是有原因的：RPG_RT.ini 常常不存在（2003 的工程可能没有）
    expect(findEngine('easyrpg')?.autodetect.all_required).toBe(false)
    expect(findEngine('nwjs')?.autodetect.all_required).toBe(true)
  })

  test('extensions 不带点号（module.js 会自己剥，写 ".py" 也能跑但会双重剥离）', () => {
    for (const engine of ENGINES) {
      for (const ext of engine.autodetect.extensions ?? []) {
        expect(ext.startsWith('.')).toBe(false)
      }
    }
  })
})

// ===== 3. 参数精简（D61）=====
//
// 断言的是「数量上限 + 必须保留哪几个」，不是「恰好等于某个数」——
// 将来加回一个参数（D61 明确说加回是一行）不该让测试变红，
// 但**悄悄把 59 个全倒回来**必须变红。

describe('S1 参数：精简后的数量与必须保留项', () => {
  const MAX_ARGS: Record<string, number> = {
    nwjs: 2,
    mkxpz: 12,
    easyrpg: 8,
    renpy: 2,
    // M6 新增：Tyrano 几乎无用户可调参数（只有 fullscreen），吉里吉里同理
    tyrano: 1,
    kirikiri: 1,
    // M6.5 新增：NScripter / Siglus / Godot 同样只留 fullscreen（其余靠命令行默认）
    nscripter: 1,
    siglus: 1,
    godot: 1
  }

  const REQUIRED: Record<string, string[]> = {
    // nwjs 上游 4 个，我们只留 version（cheat 依赖「往游戏目录塞文件」，M4.0 不做）
    nwjs: ['version'],
    mkxpz: ['rgssVersion', 'fullscreen', 'vsync', 'RTP', 'preloadScript', 'midiSoundFont'],
    easyrpg: ['encoding', 'language', 'rtpPath', 'soundfontPath', 'vsync', 'showFps'],
    renpy: ['savedir', 'command'],
    tyrano: ['fullscreen'],
    kirikiri: ['fullscreen'],
    nscripter: ['fullscreen'],
    siglus: ['fullscreen'],
    godot: ['fullscreen']
  }

  test('每个引擎的参数数量不超上限（防「59 个全倒回来」）', () => {
    for (const engine of ENGINES) {
      const count = Object.keys(engine.gameArgs).length
      expect(count, `${engine.folder} 参数数量`).toBeLessThanOrEqual(MAX_ARGS[engine.folder])
      expect(count, `${engine.folder} 不能空`).toBeGreaterThan(0)
    }
  })

  test('必须保留的参数都在（这些是普通用户真会用的）', () => {
    for (const [folder, keys] of Object.entries(REQUIRED)) {
      const definition = findEngine(folder)
      expect(definition).toBeDefined()
      for (const key of keys) {
        expect(Object.keys(definition!.gameArgs), `${folder}.gameArgs`).toContain(key)
      }
    }
  })

  test('mkxpz 被砍掉的画质微调确实不在了（抽查 6 个典型）', () => {
    // 这些是上游 40 多个画质项的代表；它们留在表单里只会让人困惑
    for (const dropped of [
      'xbrzScalingFactor',
      'bicubicSharpness',
      'smoothScaling',
      'textureScalingFactor',
      'subImageFix',
      'dumpAtlas'
    ]) {
      expect(findEngine('mkxpz')!.gameArgs).not.toHaveProperty(dropped)
    }
  })

  test('easyrpg 被砍掉的调试参数确实不在了（抽查 4 个典型）', () => {
    for (const dropped of ['recordInput', 'replayInput', 'battleTest', 'loadGameId']) {
      expect(findEngine('easyrpg')!.gameArgs).not.toHaveProperty(dropped)
    }
  })

  test('nwjs 的 cheat 不在了（M4.0 不注入作弊菜单，留个无效开关比不显示更糟）', () => {
    expect(findEngine('nwjs')!.gameArgs).not.toHaveProperty('cheat')
    expect(findEngine('nwjs')!.gameArgs).not.toHaveProperty('disableProtection')
    expect(findEngine('nwjs')!.gameArgs).not.toHaveProperty('applyPixelPatch')
  })
})

// ===== 4. 每个参数的 schema 自洽（渲染层认得、默认值类型对）=====

describe('S1 参数 schema 自洽', () => {
  /** DynamicArgsForm.vue 认的所有 type（渲染层 switch 分支的并集）。 */
  const RENDERABLE = new Set(['boolean', 'text', 'string', 'int', 'float', 'dropdown', 'select', 'multi-version', 'array'])

  test('所有 type 都在渲染层能渲染的集合里（否则这个参数永远画不出来）', () => {
    for (const engine of ENGINES) {
      for (const [key, spec] of Object.entries(engine.gameArgs)) {
        expect(RENDERABLE.has(spec.type), `${engine.folder}.${key} 的 type`).toBe(true)
      }
    }
  })

  test('每个参数都有中文 labelKey（否则中文界面会退回英文 label）', () => {
    for (const engine of ENGINES) {
      for (const [key, spec] of Object.entries(engine.gameArgs)) {
        expect(spec.labelKey, `${engine.folder}.${key}`).toMatch(/^args\./)
        expect(spec.label, `${engine.folder}.${key} 必须保留上游英文名`).not.toBe('')
      }
    }
  })

  test('默认值的类型与声明类型对得上（类型错位在表单里表现为「值显示不出来」）', () => {
    for (const engine of ENGINES) {
      for (const [key, spec] of Object.entries(engine.gameArgs)) {
        const label = `${engine.folder}.${key}`
        switch (spec.type) {
          case 'boolean':
            expect(typeof spec.default, label).toBe('boolean')
            break
          case 'int':
            expect(typeof spec.default, label).toBe('number')
            expect(Number.isInteger(spec.default as number), label).toBe(true)
            break
          case 'float':
            expect(typeof spec.default, label).toBe('number')
            break
          case 'string':
          case 'multi-version':
            // multi-version 的默认值必须是「真实的目录名」或空串——
            // 上游兜底 "0.106.1"（不带 v）会拼出不存在的路径（见 registry 注释）
            expect(typeof spec.default, label).toBe('string')
            break
          case 'array':
            expect(Array.isArray(spec.default), label).toBe(true)
            break
          case 'dropdown':
          case 'select': {
            // 下拉的默认值必须在 options 里，否则 el-select 会显示一个空框
            const values = (spec.options ?? []).map((option) => option.value)
            expect(values, `${label} 的 default`).toContain(String(spec.default))
            break
          }
          default:
            throw new Error(`未覆盖的 type: ${String(spec.type)}`)
        }
      }
    }
  })

  test('dropdown 必须有 options（否则渲染成一个没有选项的空下拉）', () => {
    for (const engine of ENGINES) {
      for (const [key, spec] of Object.entries(engine.gameArgs)) {
        if (spec.type === 'dropdown' || spec.type === 'select') {
          expect(spec.options?.length, `${engine.folder}.${key}`).toBeGreaterThan(0)
        }
      }
    }
  })

  test('nwjs 的 version 默认值是空串，不是带 v 的假版本', () => {
    // 上游兜底 "0.106.1" 会拼 deps/version/0.106.1/...，而真实目录叫 v0.106.1
    expect(findEngine('nwjs')!.gameArgs.version.default).toBe('')
    expect(findEngine('nwjs')!.gameArgs.version['version-script']).toBe('nwjs.js')
  })
})

// ===== 5. 依赖地址与数量 =====

describe('S1 依赖：地址齐全、可选标记正确', () => {
  test('每个依赖至少有一个架构的 link（否则安装时「没有可用构建」）', () => {
    for (const engine of ENGINES) {
      for (const [name, dependency] of Object.entries(engine.dependencies)) {
        const builds = [dependency.universal, dependency.arm64, dependency.x86_64].filter(Boolean)
        expect(builds.length, `${engine.folder}.${name} 至少一个构建`).toBeGreaterThan(0)
        for (const build of builds) {
          expect(build!.link, `${engine.folder}.${name}`).toMatch(/^https:\/\//)
        }
      }
    }
  })

  test('nwjs 只有运行时依赖（那 5 个注入脚本随 M4.0 的「不改游戏文件」一起删了）', () => {
    const deps = Object.keys(findEngine('nwjs')!.dependencies)
    expect(deps).toEqual(['version/v0.106.1'])
    for (const dropped of ['cheat-js', 'cheat-css', 'bg', 'disable-child', 'disable-net']) {
      expect(deps).not.toContain(dropped)
    }
  })

  test('nwjs 运行时两个架构的地址都对（arm64 / x86_64）', () => {
    const dep = findEngine('nwjs')!.dependencies['version/v0.106.1']
    expect(dep.arm64!.link).toContain('nwjs-sdk-v0.106.1-osx-arm64.zip')
    expect(dep.x86_64!.link).toContain('nwjs-sdk-v0.106.1-osx-x64.zip')
    expect(dep.arm64!.unzip).toBe(true)
    expect(dep.x86_64!.unzip).toBe(true)
  })

  test('mkxpz 四个依赖都在（mkxpz 本体 / RTP / kawariki / soundfont）', () => {
    expect(Object.keys(findEngine('mkxpz')!.dependencies).sort()).toEqual([
      'RTP',
      'kawariki',
      'mkxpz',
      'soundfont'
    ])
  })

  test('easyrpg 的 soundfont 必须是 optional（否则 403 会让 EasyRPG 永远装不上）', () => {
    // musical-artifacts.com 有 Cloudflare 人机验证，程序化请求恒 403
    expect(findEngine('easyrpg')!.dependencies.soundfont.optional).toBe(true)
    // 其余依赖不能顺手标 optional —— 那会把真正的失败藏起来
    expect(findEngine('easyrpg')!.dependencies.player.optional).toBeUndefined()
    for (const engine of ENGINES) {
      for (const [name, dependency] of Object.entries(engine.dependencies)) {
        if (engine.folder === 'easyrpg' && name === 'soundfont') continue
        expect(dependency.optional, `${engine.folder}.${name} 不该是 optional`).toBeUndefined()
      }
    }
  })

  test('unzip 标记与文件类型一致（.zip 要解压，.sf2 单文件不要）', () => {
    const build = (folder: string, name: string) => {
      const dependency = findEngine(folder)!.dependencies[name]
      return (dependency.universal ?? dependency.arm64 ?? dependency.x86_64)!
    }
    expect(build('mkxpz', 'soundfont').unzip).toBe(false)
    expect(build('easyrpg', 'soundfont').unzip).toBe(false)
    expect(build('mkxpz', 'mkxpz').unzip).toBe(true)
    expect(build('easyrpg', 'player').unzip).toBe(true)
    expect(build('renpy', 'renpy').unzip).toBe(true)
  })
})

// ===== 6. 不再有硬编码的别人家数据目录（方案 §1.2 + §2.4）=====
//
// 这是 M4.1 里最容易漏的一处：上游 manifest 的**默认值**里写死了
// `~/Library/Application Support/xenolauncher/...`。D58 之后那个目录已废弃，
// 照抄会让程序去读不存在的文件（而且**不报错**）。
//
// 判据用「序列化整个 ENGINES 再扫字符串」——比逐个字段找漏得少。

describe('S1 不再有硬编码的 xenolauncher 路径', () => {
  const serialized = JSON.stringify(ENGINES)

  test('整个 ENGINES 序列化后不含 xenolauncher（大小写不敏感）', () => {
    expect(serialized.toLowerCase()).not.toContain('xenolauncher')
  })

  test('三处已知的硬编码路径都换成了占位符，且层级正确', () => {
    // ⚠️ 层级必须带 `modules/<引擎>/` 这两层。
    // 方案 §2.4 的示例写成 `<dataDir>/deps/…`（少了这两层），照抄会让 MKXP-Z
    // 去找一个不存在的文件 —— 而它**不报错**，只是静默失效（本鱼在 S1 踩过一次）。
    // 依赖永远落在 `<数据目录>/modules/<引擎>/deps/` 下（见 binary-paths.ts 的 depsDir）。
    expect(findEngine('mkxpz')!.gameArgs.preloadScript.default).toEqual([
      `${DATA_DIR_PLACEHOLDER}/modules/mkxpz/deps/kawariki/kawariki/preload.rb`
    ])
    expect(findEngine('mkxpz')!.gameArgs.midiSoundFont.default).toBe(
      `${DATA_DIR_PLACEHOLDER}/modules/mkxpz/deps/soundfont/gmgsx-plus.sf2`
    )
    // 方案 §1.2 只列了 mkxpz 的两处，**漏了 renpy 的 savedir**（S1 验收报告里说明）
    expect(findEngine('renpy')!.gameArgs.savedir.default).toBe(`${DATA_DIR_PLACEHOLDER}/renpysaves/`)
  })

  test('依赖下载地址里也不许出现别人的家目录（只该是 https 的公开地址）', () => {
    for (const engine of ENGINES) {
      for (const dependency of Object.values(engine.dependencies)) {
        for (const build of [dependency.universal, dependency.arm64, dependency.x86_64]) {
          if (!build) continue
          expect(build.link.startsWith('https://')).toBe(true)
          expect(build.link).not.toContain('~/')
        }
      }
    }
  })
})

// ===== 7. 占位符展开 =====

describe('S1 占位符展开', () => {
  test('expandDataDirInString 替换所有出现的位置', () => {
    expect(expandDataDirInString(`${DATA_DIR_PLACEHOLDER}/a/${DATA_DIR_PLACEHOLDER}/b`, '/tmp/data')).toBe(
      '/tmp/data/a//tmp/data/b'
    )
  })

  test('展开 mkxpz 的两个默认值后指向我们的数据目录', () => {
    const expanded = expandDataDirPlaceholders(
      { preloadScript: [`${DATA_DIR_PLACEHOLDER}/deps/kawariki/kawariki/preload.rb`], midiSoundFont: `${DATA_DIR_PLACEHOLDER}/deps/soundfont/gmgsx-plus.sf2` },
      '/tmp/our-data'
    )
    expect(expanded.preloadScript).toEqual(['/tmp/our-data/deps/kawariki/kawariki/preload.rb'])
    expect(expanded.midiSoundFont).toBe('/tmp/our-data/deps/soundfont/gmgsx-plus.sf2')
  })

  test('展开 renpy 的 savedir 后是我们的目录', () => {
    const expanded = expandDataDirPlaceholders(
      { savedir: `${DATA_DIR_PLACEHOLDER}/renpysaves/` },
      '/tmp/our-data'
    )
    expect(expanded.savedir).toBe('/tmp/our-data/renpysaves/')
  })

  test('递归展开数组与嵌套对象', () => {
    const expanded = expandDataDirPlaceholders(
      { list: [`${DATA_DIR_PLACEHOLDER}/a`, { inner: `${DATA_DIR_PLACEHOLDER}/b` }], plain: 'nope' },
      '/data'
    )
    expect(expanded.list).toEqual(['/data/a', { inner: '/data/b' }])
    expect(expanded.plain).toBe('nope')
  })

  test('**不改入参**（展开是纯函数，否则 manifest 里的占位符会被第一次启动吃掉）', () => {
    const input = { preloadScript: [`${DATA_DIR_PLACEHOLDER}/x.rb`] }
    const before = JSON.stringify(input)
    expandDataDirPlaceholders(input, '/data')
    expect(JSON.stringify(input)).toBe(before)
  })

  test('非字符串 / null / undefined 原样保留（不能让展开把布尔值变成字符串）', () => {
    const expanded = expandDataDirPlaceholders({ flag: true, count: 3, empty: null }, '/data')
    expect(expanded.flag).toBe(true)
    expect(expanded.count).toBe(3)
    expect(expanded.empty).toBeNull()
  })

  test('不含占位符的普通字符串一个字符都不改（用户自己填的路径不能被碰）', () => {
    const expanded = expandDataDirPlaceholders({ custom: '/Users/me/MySaves/' }, '/data')
    expect(expanded.custom).toBe('/Users/me/MySaves/')
  })
})

// ===== 8. 生成的 manifest 与上游兼容（D62）=====

describe('S1 buildManifest：字段名与上游兼容', () => {
  test('顶层字段就是上游认的那几个', () => {
    for (const engine of ENGINES) {
      const manifest = buildManifest(engine)
      expect(manifest.name).toBe(engine.name)
      expect(manifest.version).toBe(engine.version)
      expect(typeof manifest.description).toBe('string')
      expect(typeof manifest.author).toBe('string')
      expect(typeof manifest.license).toBe('string')
      expect(manifest.autodetect).toEqual(engine.autodetect)
      expect(typeof manifest.dependencies).toBe('object')
      expect(typeof manifest.gameArgs).toBe('object')
    }
  })

  test('gameArgs 里**没有**我们自己的 labelKey（上游读到的必须是纯 schema）', () => {
    for (const engine of ENGINES) {
      const manifest = buildManifest(engine) as { gameArgs: Record<string, Record<string, unknown>> }
      for (const [key, spec] of Object.entries(manifest.gameArgs)) {
        expect(spec, `${engine.folder}.${key}`).not.toHaveProperty('labelKey')
        // 上游认的字段只有这几个
        for (const field of Object.keys(spec)) {
          expect(['type', 'label', 'default', 'options', 'version-script'], `${engine.folder}.${key}.${field}`).toContain(
            field
          )
        }
      }
    }
  })

  test('生成的 manifest 能 JSON 往返（写盘再读回来一模一样）', () => {
    for (const engine of ENGINES) {
      const manifest = buildManifest(engine)
      const roundTrip = JSON.parse(JSON.stringify(manifest))
      expect(roundTrip).toEqual(manifest)
    }
  })

  test('生成的 manifest 里保留 <dataDir> 占位符（不在生成时展开）', () => {
    // manifest 属于「引擎定义」，数据目录属于「这台机器的安装」——生成时展开会让
    // 用户换数据目录后 manifest 里的值全部失效
    const manifest = buildManifest(findEngine('mkxpz')!) as {
      gameArgs: Record<string, { default: unknown }>
    }
    expect(JSON.stringify(manifest.gameArgs.preloadScript.default)).toContain(DATA_DIR_PLACEHOLDER)
  })

  test('multi-version 的 version-script 名字被带过去（否则版本管理弹窗拿不到列表）', () => {
    const manifest = buildManifest(findEngine('nwjs')!) as {
      gameArgs: Record<string, { 'version-script'?: string }>
    }
    expect(manifest.gameArgs.version['version-script']).toBe('nwjs.js')
  })
})

// ===== 9. 源码层面：那三个引擎在整个 main 侧不存在 =====
//
// 这条比「数组里没有」强得多：它扫的是**磁盘上的源码**。
// 谁想加回 ruffle，只要写一个定义/地址就会被这条抓住。
//
// ⚠️ 扫的是 `src/main/engines/` 这个目录（本步的范围）。全仓扫描放在 S5
// （那时才能把 ipc/core-host/渲染层里的残留一起清掉）。

describe('S1 源码：engines 目录里没有那三个引擎的任何痕迹', () => {
  const ENGINE_DIR = path.join(process.cwd(), 'src', 'main', 'engines')

  function sourceFiles(dir: string): string[] {
    const out: string[] = []
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) out.push(...sourceFiles(full))
      else if (entry.name.endsWith('.ts')) out.push(full)
    }
    return out
  }

  /** 去掉注释，避免「注释里提到 ruffle 解释为什么不做」被误判。 */
  function stripComments(source: string): string {
    return source
      .replace(/^\s*\/\*[\s\S]*?\*\/\s*$/gm, '')
      .split('\n')
      .map((line) => {
        const lineComment = line.indexOf('//')
        if (lineComment < 0) return line
        // 保留行内的字符串字面量里的 // 太麻烦；这里的源码没有那种写法
        return line.slice(0, lineComment)
      })
      .join('\n')
      .replace(/\uFEFF/g, '')
  }

  test('剥掉注释后，engines/ 的代码里不出现 ruffle / wine 这两个名字', () => {
    // 为什么不含 `macos`：它是**平台词**，在 easyrpg 的下载地址
    // （`https://ci.easyrpg.org/downloads/macos/...`）与 versions.ts 的文案
    // （「没有可用的 macOS SDK 构建」）里都**必然**出现，扫它只会制造假红。
    // macos 引擎的判据放在下面那条「引擎身份位」测试里（文件夹名 / 展示名）。
    const files = sourceFiles(ENGINE_DIR)
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const code = stripComments(fs.readFileSync(file, 'utf8')).toLowerCase()
      for (const gone of ['ruffle', 'wine']) {
        expect(code, `${path.basename(file)} 里出现了 ${gone}`).not.toContain(gone)
      }
    }
  })

  // ⚠️ `macos` 这个词天然会和「平台名」撞车：
  //    · easyrpg 的下载地址是 `https://ci.easyrpg.org/downloads/macos/...`
  //    · versions.ts 的文案是「没有可用的 macOS SDK 构建」
  //   这两处都是**平台**，不是「macos 引擎」。
  //
  // 所以真正的判据不能是「整个文件扫字符串」，而是**扫「引擎身份位」**：
  // 谁能被当成引擎，看的是三种地方 —— ENGINES 的定义、findEngine 的返回值、数据目录名。
  // 本鱼第一版就是整串扫，被上面两处平台词搞红过两次（S2 一次、S3 一次）。
  test('引擎身份位里没有那三个（平台词 macos 不算）', () => {
    // ENGINES 的 folder / name 是「什么算一个引擎」的唯一答案
    const identities = ENGINES.flatMap((engine) => [engine.folder, engine.name]).join(' ').toLowerCase()
    for (const gone of ['ruffle', 'wine', 'macos']) {
      expect(identities).not.toContain(gone)
    }
    // 而 ENGINE_FOLDERS 是 gameEngine 字段的合法值集合
    expect(ENGINE_FOLDERS).not.toContain('ruffle')
    expect(ENGINE_FOLDERS).not.toContain('wine')
    expect(ENGINE_FOLDERS).not.toContain('macos')
  })

  test('engines/ 里不出现 xenolauncher 字面量（注释除外）', () => {
    for (const file of sourceFiles(ENGINE_DIR)) {
      const code = stripComments(fs.readFileSync(file, 'utf8')).toLowerCase()
      expect(code, `${path.basename(file)}`).not.toContain('xenolauncher')
    }
  })
})
