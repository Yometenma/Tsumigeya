// M4.2 S3 单测：install.ts 的安装 / 更新 / 卸载 + 依赖下载（D66）。
//
// 方案 §5 S3 的验收标准：「多版本保留的 3 条不变量测试是重点」。
// 三条不变量（§3）：
//   ① 更新后 `deps/version/v0.106.1/` **必须还在**，内容（哈希）不变
//   ② 更新后 `deps/mkxpz/` 是**新版本**（被真的重下了一次）
//   ③ manifest 里的 `dependencies` 键集与 registry 一致
//
// ⚠️ 本文件的重点不是「函数能返回」，而是**更新这件事对用户磁盘的影响**：
// 旧的多版本运行时是用户花 100+ MB 流量装下来的，被删掉等于他其他 NW.js 游戏全坏。
// 所以这里的断言全是「文件还在不在 + 内容一不一样 + 什么时候被重下过」。
//
// ⚠️ 测试写法说明（与 engines-install.test.ts 保持一致，免得下个会话两套脚手架）：
//   · 依赖标了 `unzip: true` 的，`extractArchive` 会调系统 tar，所以假响应必须是**真 zip**
//   · 每个用例自己一份临时 dataDir（一个装过的模块会让下一个用例看到「已装」）
//   · fetch 只服务给定 URL，服务不到的**直接抛** —— 这条能抓到「偷偷多下了一个依赖」
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import {
  dependencyNames,
  installDependencies,
  installEngine,
  isMultiVersionDependency,
  moduleRoot,
  readManifestAt,
  safeDependencyPath,
  uninstallEngine,
  updateEngine
} from '../src/main/engines/install'
import { buildManifest, findEngine } from '../src/main/engines/registry'
import type { InstallOptions } from '../src/main/engines/install'
import type { EngineDefinition } from '../src/main/engines/types'

// ===== 测试辅助 =====

/**
 * 造一个**真能被 bsdtar 解开**的极小 zip（内容里带一个标记字符串）。
 *
 * `extractArchive` 走的是系统 tar，纯文本会报
 * `tar.exe: Error opening archive: Unrecognized archive format`。
 */
function tinyZip(marker: string): Buffer {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-m42-zip-'))
  try {
    fs.writeFileSync(path.join(dir, 'payload.txt'), marker)
    const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : '/usr/bin/tar'
    execFileSync(tar, ['-a', '-c', '-f', path.join(dir, 'out.zip'), '-C', dir, 'payload.txt'])
    return fs.readFileSync(path.join(dir, 'out.zip'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const createdDirs: string[] = []
function tempDir(prefix = 'tsmg-m42-install-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  createdDirs.push(dir)
  return dir
}
afterAll(() => {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 假 fetch：把 URL 映射到一个带标记的 zip。
 *
 * `markers` 的键是 URL，值是「这个 URL 下载下来的内容标记」。
 * 服务不到的 URL 直接抛 —— 这样「多下了一个不该下的依赖」会立刻红，
 * 而不是安静地多跑 100 MB。
 */
function makeFetch(markers: Record<string, string>, counters?: Record<string, number>): InstallOptions['fetch'] {
  const archives = new Map<string, Buffer>()
  return async (input: string) => {
    if (counters) counters[input] = (counters[input] ?? 0) + 1
    const marker = markers[input]
    if (marker === undefined) throw new Error(`本测试不该请求：${input}`)
    let archive = archives.get(marker)
    if (!archive) {
      archive = tinyZip(marker)
      archives.set(marker, archive)
    }
    return new Response(archive, {
      status: 200,
      headers: { 'content-length': String(archive.byteLength) }
    })
  }
}

/**
 * 把引擎定义换成「测试专用」的下载地址（不碰 registry 的真实 GitHub 地址）。
 *
 * ⚠️ 只能改 `dependencies`：`gameArgs` / `autodetect` 必须保持 registry 原样，
 * 否则不变量③（键集与 registry 一致）就变成自说自话了。
 */
function testDefinition(folder: string, dependencies: EngineDefinition['dependencies']): EngineDefinition {
  const base = findEngine(folder)
  if (!base) throw new Error(`registry 里没有 ${folder}`)
  return { ...base, dependencies }
}

/** 目录内容指纹（递归，按相对路径排序；用来断言「内容哈希不变」）。 */
function treeFingerprint(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(absolute, relative)
      } else {
        out[relative] = createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')
      }
    }
  }
  walk(root, '')
  return out
}

// ===== 1. 路径与判据 =====

describe('S3 safeDependencyPath：放行斜杠、挡住越界', () => {
  test('普通名原样放行', () => {
    expect(safeDependencyPath('RTP')).toBe('RTP')
    expect(safeDependencyPath('soundfont')).toBe('soundfont')
  })

  test('带斜杠的依赖名放行（斜杠 = 子目录，上游就是这么用的）', () => {
    expect(safeDependencyPath('version/v0.106.1')).toBe('version/v0.106.1')
    expect(safeDependencyPath('a/b/c')).toBe('a/b/c')
  })

  test('.. 段被拒绝（防止爬出 deps 目录）', () => {
    expect(() => safeDependencyPath('..')).toThrow()
    expect(() => safeDependencyPath('a/../b')).toThrow()
    expect(() => safeDependencyPath('a/..')).toThrow()
  })

  test('绝对路径与盘符被拒绝', () => {
    expect(() => safeDependencyPath('/etc/passwd')).toThrow()
    expect(() => safeDependencyPath('C:evil')).toThrow()
  })

  test('反斜杠被拒绝（避免同一份清单在 win/mac 上跳向不同目录）', () => {
    expect(() => safeDependencyPath('a\\b')).toThrow()
  })

  test('空段被拒绝（a//b、结尾斜杠）', () => {
    expect(() => safeDependencyPath('a//b')).toThrow()
    expect(() => safeDependencyPath('a/')).toThrow()
    expect(() => safeDependencyPath('/a')).toThrow()
  })

  test('空值 / 非字符串被拒绝', () => {
    expect(() => safeDependencyPath('')).toThrow()
    expect(() => safeDependencyPath(null as unknown as string)).toThrow()
  })
})

describe('S3 isMultiVersionDependency：D66 的唯一判据', () => {
  test('`version/…` 形态判真（上游唯一的多版本形态）', () => {
    expect(isMultiVersionDependency('version/v0.106.1')).toBe(true)
    expect(isMultiVersionDependency('version/v0.119.2')).toBe(true)
  })

  test('普通依赖判假（四个引擎里其余依赖全是这种）', () => {
    for (const name of ['mkxpz', 'RTP', 'kawariki', 'soundfont', 'player', 'renpy']) {
      expect(isMultiVersionDependency(name)).toBe(false)
    }
  })

  test('非字符串判假（不抛错）', () => {
    expect(isMultiVersionDependency(undefined as unknown as string)).toBe(false)
  })

  test('D66 的判据不能退化成「有两层目录」（versionX/ 不是多版本）', () => {
    expect(isMultiVersionDependency('versionX/v1')).toBe(false)
  })
})

// ===== 2. 安装 =====

describe('S3 installEngine：写 manifest + 装依赖', () => {
  test('manifest 写在正确位置、字段来自 registry、依赖落到 deps/', async () => {
    const dataDir = tempDir()
    const folder = 'renpy'
    const def = testDefinition(folder, { renpy: { universal: { link: 'https://x.test/renpy.zip', unzip: true } } })
    const root = moduleRoot(dataDir, folder)

    const installed = await installEngine(root, def, { fetch: makeFetch({ 'https://x.test/renpy.zip': 'renpy' }) })

    const written = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')) as Record<string, unknown>
    expect(written.version).toBe(findEngine(folder)!.version)
    expect(written.autodetect).toEqual(findEngine(folder)!.autodetect)
    expect(installed).toEqual(['renpy'])
    expect(fs.existsSync(path.join(root, 'deps', 'renpy', 'payload.txt'))).toBe(true)
  })

  test('带斜杠的依赖名落到子目录 deps/version/v0.106.1/（NW.js 装不上的老 bug）', async () => {
    const dataDir = tempDir()
    const folder = 'nwjs'
    const def = testDefinition(folder, {
      'version/v0.106.1': { universal: { link: 'https://x.test/nwjs.zip', unzip: true } }
    })
    const root = moduleRoot(dataDir, folder)

    await installEngine(root, def, { fetch: makeFetch({ 'https://x.test/nwjs.zip': 'runtime' }) })

    const depDir = path.join(root, 'deps', 'version', 'v0.106.1')
    expect(fs.existsSync(depDir), '带斜杠的依赖必须落到子目录').toBe(true)
    expect(fs.existsSync(path.join(depDir, 'payload.txt'))).toBe(true)
  })

  test('不动已有的多版本运行时（用户另外装了 v0.119.2，安装不该删它）', async () => {
    const dataDir = tempDir()
    const folder = 'nwjs'
    const def = testDefinition(folder, {
      'version/v0.106.1': { universal: { link: 'https://x.test/nwjs.zip', unzip: true } }
    })
    const root = moduleRoot(dataDir, folder)
    const userRuntime = path.join(root, 'deps', 'version', 'v0.119.2', 'user.txt')
    fs.mkdirSync(path.dirname(userRuntime), { recursive: true })
    fs.writeFileSync(userRuntime, '用户自己装的另一个版本')

    await installEngine(root, def, { fetch: makeFetch({ 'https://x.test/nwjs.zip': 'runtime' }) })

    expect(fs.existsSync(userRuntime), '安装不该动用户已装的其它版本').toBe(true)
  })

  test('signal 已取消 → 立刻抛错（不静默装半个模块）', async () => {
    const dataDir = tempDir()
    const controller = new AbortController()
    controller.abort()
    const folder = 'renpy'
    const def = testDefinition(folder, { renpy: { universal: { link: 'https://x.test/r.zip', unzip: true } } })
    await expect(
      installEngine(moduleRoot(dataDir, folder), def, {
        fetch: makeFetch({ 'https://x.test/r.zip': 'renpy' }),
        signal: controller.signal
      })
    ).rejects.toThrow()
  })

  test('进度回调：prepare → download → done（渲染层的进度浮层靠它）', async () => {
    const dataDir = tempDir()
    const folder = 'renpy'
    const def = testDefinition(folder, { renpy: { universal: { link: 'https://x.test/r.zip', unzip: true } } })
    const keyed: string[] = []
    await installEngine(moduleRoot(dataDir, folder), def, {
      fetch: makeFetch({ 'https://x.test/r.zip': 'renpy' }),
      onProgress: (event) => {
        if (event.key) keyed.push(event.key)
      }
    })
    expect(keyed[0]).toBe('progress.prepare')
    expect(keyed).toContain('progress.download')
    expect(keyed[keyed.length - 1]).toBe('progress.done')
  })

  test('进度回调抛错不会打断安装（与 core 的 safeCall 同一条规矩）', async () => {
    const dataDir = tempDir()
    const folder = 'renpy'
    const def = testDefinition(folder, { renpy: { universal: { link: 'https://x.test/r.zip', unzip: true } } })
    await installEngine(moduleRoot(dataDir, folder), def, {
      fetch: makeFetch({ 'https://x.test/r.zip': 'renpy' }),
      onProgress: () => {
        throw new Error('UI 炸了')
      }
    })
    expect(fs.existsSync(path.join(moduleRoot(dataDir, folder), 'deps', 'renpy', 'payload.txt'))).toBe(true)
  })
})

// ===== 3. installDependencies 的取舍 =====

describe('S3 installDependencies：只装指定的、可选依赖可失败', () => {
  test('只装 wanted 列表里的依赖（不多下）', async () => {
    const root = path.join(tempDir(), 'modules', 'mkxpz')
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(
      path.join(root, 'manifest.json'),
      JSON.stringify({
        dependencies: {
          RTP: { universal: { link: 'https://x.test/rtp.zip', unzip: true } },
          soundfont: { universal: { link: 'https://x.test/sf.zip', unzip: false } }
        }
      })
    )
    const counters: Record<string, number> = {}
    const installed = await installDependencies(root, ['RTP'], {
      fetch: makeFetch({ 'https://x.test/rtp.zip': 'RTP', 'https://x.test/sf.zip': 'sf' }, counters)
    })
    expect(installed).toEqual(['RTP'])
    // 关键：soundfont 一次都没被请求
    expect(counters['https://x.test/sf.zip']).toBeUndefined()
  })

  test('manifest 里没有这个依赖 → 明确报错（不静默成功）', async () => {
    const root = path.join(tempDir(), 'modules', 'mkxpz')
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ dependencies: {} }))
    await expect(installDependencies(root, ['RTP'], { fetch: makeFetch({}) })).rejects.toMatchObject({
      translationKey: 'error.dependencyMissing'
    })
  })

  test('manifest 不存在 → error.moduleMissing', async () => {
    const root = path.join(tempDir(), 'modules', 'ghost')
    fs.mkdirSync(root, { recursive: true })
    await expect(installDependencies(root, ['RTP'], { fetch: makeFetch({}) })).rejects.toMatchObject({
      translationKey: 'error.moduleMissing'
    })
  })

  test('optional 依赖下载失败被跳过，安装继续（easyrpg 音源站的 Cloudflare 403）', async () => {
    const root = path.join(tempDir(), 'modules', 'easyrpg')
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(
      path.join(root, 'manifest.json'),
      JSON.stringify({
        dependencies: {
          player: { universal: { link: 'https://x.test/player.zip', unzip: true } },
          soundfont: { universal: { link: 'https://x.test/sf2', unzip: false }, optional: true }
        }
      })
    )
    const installed = await installDependencies(root, ['player', 'soundfont'], {
      fetch: async (input: string) => {
        if (input === 'https://x.test/player.zip') {
          const zip = tinyZip('player')
          return new Response(zip, { status: 200, headers: { 'content-length': String(zip.byteLength) } })
        }
        return new Response('', { status: 403 }) // 音源站的人机验证
      }
    })
    // 只装上了 player；soundfont 被跳过而不是让整个安装失败
    expect(installed).toEqual(['player'])
  })

  test('**非** optional 依赖下载失败 → 整个安装失败（不能装成「都成功了」）', async () => {
    const root = path.join(tempDir(), 'modules', 'mkxpz')
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(
      path.join(root, 'manifest.json'),
      JSON.stringify({ dependencies: { mkxpz: { universal: { link: 'https://x.test/m.zip', unzip: true } } } })
    )
    await expect(
      installDependencies(root, ['mkxpz'], { fetch: async () => new Response('', { status: 500 }) })
    ).rejects.toMatchObject({ translationKey: 'error.download' })
  })

  test('本机架构没有构建 → error.buildMissing（不静默跳过）', async () => {
    const root = path.join(tempDir(), 'modules', 'mkxpz')
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(
      path.join(root, 'manifest.json'),
      JSON.stringify({ dependencies: { mkxpz: { arm64: { link: 'https://x.test/arm.zip', unzip: true } } } })
    )
    await expect(
      installDependencies(root, ['mkxpz'], { fetch: makeFetch({}), arch: 'x86_64' })
    ).rejects.toMatchObject({ translationKey: 'error.buildMissing' })
  })

  test('arch 可注入：arm64 构建能被挑出来（CI 是 Linux x64，产品目标是 mac arm64）', async () => {
    const root = path.join(tempDir(), 'modules', 'mkxpz')
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(
      path.join(root, 'manifest.json'),
      JSON.stringify({
        dependencies: {
          mkxpz: {
            arm64: { link: 'https://x.test/arm.zip', unzip: true },
            x86_64: { link: 'https://x.test/intel.zip', unzip: true }
          }
        }
      })
    )
    const counters: Record<string, number> = {}
    await installDependencies(root, ['mkxpz'], {
      fetch: makeFetch({ 'https://x.test/arm.zip': 'arm', 'https://x.test/intel.zip': 'intel' }, counters),
      arch: 'arm64'
    })
    expect(counters['https://x.test/arm.zip']).toBe(1)
    expect(counters['https://x.test/intel.zip']).toBeUndefined()
  })
})

// ===== 4. 🔴 三条不变量（方案 §3，D66 的核心验收）=====

describe('S3 updateEngine：多版本保留的三条不变量（D66）', () => {
  /**
   * 标准场景：
   *   旧 manifest：`version/v0.106.1` + `mkxpz`（两个依赖）
   *   磁盘：用户装好了 v0.106.1（内容 = 'user-runtime-v0.106.1'）+ 旧版 mkxpz（'old-mkxpz'）
   *   更新：registry 给出新的 dependencies（mkxpz 换一个地址 = 新版本）
   */
  function setup(): {
    dataDir: string
    folder: string
    root: string
    def: EngineDefinition
    links: Record<string, string>
  } {
    const dataDir = tempDir()
    const folder = 'nwjs'
    const root = moduleRoot(dataDir, folder)

    // 旧 manifest（有 `version/…` 与一个普通依赖）
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(
      path.join(root, 'manifest.json'),
      JSON.stringify(
        {
          name: 'NW.js',
          version: '0.9.0',
          dependencies: {
            'version/v0.106.1': { universal: { link: 'https://old.test/nwjs.zip', unzip: true } },
            mkxpz: { universal: { link: 'https://old.test/body.zip', unzip: true } }
          }
        },
        null,
        2
      )
    )

    // 用户已装的运行时内容（要被原样保住）
    const runtime = path.join(root, 'deps', 'version', 'v0.106.1')
    fs.mkdirSync(runtime, { recursive: true })
    fs.writeFileSync(path.join(runtime, 'runtime.txt'), 'user-runtime-v0.106.1')
    // 包内的二级目录（验证「整个子树」都被保住，不是只保住顶层）
    fs.mkdirSync(path.join(runtime, 'nwjs.app', 'Contents'), { recursive: true })
    fs.writeFileSync(path.join(runtime, 'nwjs.app', 'Contents', 'Info.plist'), 'plist-v0.106.1')

    // 旧版 mkxpz（更新后应被换成新内容）
    const body = path.join(root, 'deps', 'mkxpz')
    fs.mkdirSync(body, { recursive: true })
    fs.writeFileSync(path.join(body, 'body.txt'), 'old-mkxpz')

    // registry 侧的新定义：mkxpz 换个地址（= 新版本），多版本依赖的地址也换（但不该被下载）
    const def = testDefinition(folder, {
      'version/v0.106.1': { universal: { link: 'https://new.test/nwjs.zip', unzip: true } },
      mkxpz: { universal: { link: 'https://new.test/body-v2.zip', unzip: true } }
    })
    return {
      dataDir,
      folder,
      root,
      def,
      links: { 'https://new.test/body-v2.zip': 'new-mkxpz' }
    }
  }

  test('不变量①：多版本目录还在，且内容哈希不变', async () => {
    const { root, def, links } = setup()
    const before = treeFingerprint(path.join(root, 'deps', 'version', 'v0.106.1'))

    await updateEngine(root, def, { fetch: makeFetch(links) })

    const after = treeFingerprint(path.join(root, 'deps', 'version', 'v0.106.1'))
    expect(after, 'deps/version/v0.106.1 必须还在').toEqual(before)
    // 明确断言两个内容（不是只靠指纹相同）
    expect(fs.readFileSync(path.join(root, 'deps', 'version', 'v0.106.1', 'runtime.txt'), 'utf8')).toBe(
      'user-runtime-v0.106.1'
    )
    expect(
      fs.readFileSync(path.join(root, 'deps', 'version', 'v0.106.1', 'nwjs.app', 'Contents', 'Info.plist'), 'utf8')
    ).toBe('plist-v0.106.1')
  })

  test('不变量②：普通依赖（mkxpz）被真的重下了一遍（内容是新的）', async () => {
    const { root, def, links } = setup()
    const counters: Record<string, number> = {}

    const result = await updateEngine(root, def, { fetch: makeFetch(links, counters) })

    // 新版内容落地（假 zip 里带的是 payload.txt，内容标记 new-mkxpz）
    expect(fs.readFileSync(path.join(root, 'deps', 'mkxpz', 'payload.txt'), 'utf8')).toBe('new-mkxpz')
    // ⚠️ 旧版本的残留文件**必须**没了。
    // 这条是 S3 实施时抓到的真 bug：原来 updateEngine 直接调 installDependencies，
    // 它只做「下载 + 解压 + 覆盖同名文件」，于是旧版本的其它文件留在原地 →
    // 变成「新 manifest + 旧二进制叠加」，界面上显示已更新、启动却加载旧二进制。
    expect(fs.existsSync(path.join(root, 'deps', 'mkxpz', 'body.txt')), '旧版本文件不能残留').toBe(false)
    expect(result.installed).toEqual(['mkxpz'])
    expect(result.kept).toEqual(['version/v0.106.1'])
    // 新地址确实被请求了 1 次
    expect(counters['https://new.test/body-v2.zip']).toBe(1)
    // 旧地址一次都没被请求（旧 manifest 里的地址不该还在用）
    expect(counters['https://old.test/body.zip']).toBeUndefined()
  })

  test('不变量②的反面：**多版本依赖不该被重下**（否则每次更新白下 100+ MB）', async () => {
    const { root, def, links } = setup()
    // 只服务 mkxpz 的地址；多版本 URL 若被下载就会抛「本测试不该请求」
    await updateEngine(root, def, { fetch: makeFetch(links) })
    // 走到这里没抛错，就证明 `https://new.test/nwjs.zip` 一次都没被请求
  })

  test('不变量③：manifest 的 dependencies 键集与 registry 一致', async () => {
    const { root, def, links } = setup()
    await updateEngine(root, def, { fetch: makeFetch(links) })

    expect(dependencyNames(root)).toEqual(Object.keys(def.dependencies))
    const written = readManifestAt(root)!
    // 版本号也换成 registry 的（否则「检查更新」永远提示有更新）
    expect(written.version).toBe(def.version)
    // 键集与 buildManifest 完全一致（不是「差不多」）
    expect(Object.keys((written.dependencies ?? {}) as object).sort()).toEqual(
      Object.keys((buildManifest(def).dependencies ?? {}) as object).sort()
    )
  })

  test('保留目录的中转站不留垃圾（`.update-preserve` 更新后必须消失）', async () => {
    const { root, def, links } = setup()
    await updateEngine(root, def, { fetch: makeFetch(links) })
    expect(fs.existsSync(path.join(root, '.update-preserve'))).toBe(false)
  })

  test('用户压根没装多版本时也能更新（保留列表为空，不抛）', async () => {
    const dataDir = tempDir()
    const folder = 'mkxpz'
    const root = moduleRoot(dataDir, folder)
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ dependencies: {} }))
    const def = testDefinition(folder, { RTP: { universal: { link: 'https://x.test/rtp.zip', unzip: true } } })

    const result = await updateEngine(root, def, { fetch: makeFetch({ 'https://x.test/rtp.zip': 'RTP' }) })
    expect(result.kept).toEqual([])
    expect(result.installed).toEqual(['RTP'])
  })

  test('更新失败（下载 500）时多版本目录**也要搬回来**（否则用户运行时留在中转站等于全坏）', async () => {
    const { root, def } = setup()
    await expect(
      updateEngine(root, def, { fetch: async () => new Response('', { status: 500 }) })
    ).rejects.toThrow()

    // 关键断言：失败路径下运行时也回到原位、内容没丢
    const runtime = path.join(root, 'deps', 'version', 'v0.106.1', 'runtime.txt')
    expect(fs.existsSync(runtime), '失败时也必须搬回（finally 的责任）').toBe(true)
    expect(fs.readFileSync(runtime, 'utf8')).toBe('user-runtime-v0.106.1')
    expect(fs.existsSync(path.join(root, '.update-preserve')).valueOf()).toBe(false)
  })
})

// ===== 5. 卸载 =====

describe('S3 uninstallEngine：幂等、整目录删', () => {
  test('删掉整个模块目录（含 deps 里的运行时）', () => {
    const root = path.join(tempDir(), 'modules', 'nwjs')
    fs.mkdirSync(path.join(root, 'deps', 'version', 'v0.106.1'), { recursive: true })
    uninstallEngine(root)
    expect(fs.existsSync(root)).toBe(false)
  })

  test('目录不存在时静默成功（卸载本该幂等）', () => {
    const root = path.join(tempDir(), 'modules', 'ghost')
    expect(() => uninstallEngine(root)).not.toThrow()
    expect(fs.existsSync(root)).toBe(false)
  })
})

// ===== 6. 指纹辅助的自检 =====
//
// 上面「内容哈希不变」用的是 treeFingerprint。它自己错了会让不变量①变成假绿，
// 所以这里反过来验一下：**内容变了它必须能看出来**。

describe('S3 测试脚手架自检：treeFingerprint 真的能看出内容变化', () => {
  test('改一个字节 → 指纹不同（否则不变量①是假绿）', () => {
    const dir = tempDir('tsmg-m42-fp-')
    fs.writeFileSync(path.join(dir, 'a.txt'), 'same')
    const before = treeFingerprint(dir)
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed')
    const after = treeFingerprint(dir)
    expect(after).not.toEqual(before)
  })

  test('新增文件 → 指纹多一条', () => {
    const dir = tempDir('tsmg-m42-fp2-')
    fs.writeFileSync(path.join(dir, 'a.txt'), 'same')
    const before = treeFingerprint(dir)
    fs.writeFileSync(path.join(dir, 'b.txt'), 'new')
    const after = treeFingerprint(dir)
    expect(Object.keys(after).length).toBe(Object.keys(before).length + 1)
  })
})
