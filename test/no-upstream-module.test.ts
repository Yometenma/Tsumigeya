// M4.2 S5 单测：上游 module.js 真的没了，而且不能偷偷回来（D63）。
//
// ===== 为什么值得单独一个文件 =====
//
// 「删掉一行」是最容易复发的重构：下个会话遇到「咦这里缺个能力」，
// 顺手从 `_xeno_probe/app/module.js` 抄回来，测试全绿 —— 因为**没有任何测试在盯着
// 「它不该存在」这件事**。M4.1 已经用源码扫描守住过「ruffle/wine/macos 不会回来」
// （见 engines-registry.test.ts 最后一组），这里用的是同一套手法。
//
// 三道闸（缺一不可）：
//   ① 文件不存在
//   ② 全源码里没有装载它的入口（`loadCoreFactory` / `createRequire` 装载 / `TSUMIGEYA_CORE_PATH`）
//   ③ 打包配置不再把它塞进安装包（CI 也反向断言了，但那是 mac/win 才跑；这里本机就能验）
//
// 顺带守一条「别把 FORK-NOTES 也顺手删了」：它是 GPL 要求的来源说明，
// 而且 electron-builder 的 extraResources 指着它（删了打包配置就指向一个不存在的文件）。
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const ROOT = process.cwd()
const MODULE_JS = path.join(ROOT, 'resources', 'core', 'module.js')
const FORK_NOTES = path.join(ROOT, 'resources', 'core', 'FORK-NOTES.md')

/** 递归收集源码/配置（跳过依赖与构建产物，也不碰只读参考 clone）。 */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '_xeno_probe') continue
    if (entry.name === 'out' || entry.name === 'dist' || entry.name === '.dev-data') continue
    const relative = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collectSources(relative, out)
    } else if (/\.(ts|js|cjs|mjs|json|yml|yaml)$/.test(entry.name)) {
      out.push(relative)
    }
  }
  return out
}

/**
 * 去掉注释再匹配。
 *
 * 为什么必须先去注释：M4.2 之后**很多文件会在注释里提到 module.js**（解释
 * 「原来这里调 core 的什么、现在是自实现」）。那些是**历史说明**，不是调用点。
 * 直接 grep 会把这些说明当成违规，于是这条测试变成「不许写注释」，那就废了。
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
}

describe('S5 上游 module.js 已删除（D63）', () => {
  test('resources/core/module.js 不存在', () => {
    expect(fs.existsSync(MODULE_JS), '上游 module.js 必须已被删除（D63）').toBe(false)
  })

  test('resources/core/ 只剩 FORK-NOTES.md（不多也不少）', () => {
    const entries = fs.readdirSync(path.join(ROOT, 'resources', 'core')).sort()
    expect(entries).toEqual(['FORK-NOTES.md'])
  })

  test('FORK-NOTES.md 保留（GPL 来源说明）且写明了已删除这件事', () => {
    expect(fs.existsSync(FORK_NOTES)).toBe(true)
    const notes = fs.readFileSync(FORK_NOTES, 'utf8')
    // 只保留「历史记录」这个定位必须写在文件里，否则下个会话会以为它还活着
    expect(notes).toContain('已被删除')
    expect(notes).toContain('D63')
  })
})

describe('S5 没有装载它的入口（防止偷偷抄回来）', () => {
  /**
   * ⚠️ **只扫 src / scripts（不扫 test）**。理由：下面每个用例的断言里都写着
   * 这些名字的**字面形式**（它们是被搜索的模式，不是违规代码），而其它测试文件
   * （如 engines-cleanup）也会在 test 标题里提到这些名字。扫 test 会把
   * 「测试在讨论某件事」当成「代码在做那件事」—— 判据应该落在生产代码上。
   */
  const sources = [...collectSources('src'), ...collectSources('scripts')]

  test('没有 loadCoreFactory / CoreApi（装载 core 脚本的入口）', () => {
    const offenders: string[] = []
    for (const file of sources) {
      const body = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'))
      if (/\bloadCoreFactory\b|\bCoreApi\b/.test(body)) offenders.push(file)
    }
    expect(offenders, `这些文件里还有 core 装载入口：${offenders.join(', ')}`).toEqual([])
  })

  test('没有 resolveCorePath / TSUMIGEYA_CORE_PATH（找 core 脚本在哪）', () => {
    const offenders: string[] = []
    for (const file of sources) {
      const body = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'))
      if (/\bresolveCorePath\b|TSUMIGEYA_CORE_PATH/.test(body)) offenders.push(file)
    }
    expect(offenders, `这些文件还在找 core 脚本：${offenders.join(', ')}`).toEqual([])
  })

  test('没有 host.core 调用点（`host.core` 只剩注释里的历史说明）', () => {
    const offenders: string[] = []
    for (const file of sources) {
      const body = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'))
      if (/host\.core\./.test(body)) offenders.push(file)
    }
    expect(offenders, `这些文件还在调 host.core：${offenders.join(', ')}`).toEqual([])
  })

  test('没有 new Function 手工执行源码（那是装载 core 脚本的唯一手法）', () => {
    // 注意：`new Function(` 出现在**非 test** 的源码里就是可疑的。test 里聚合管道等地方
    // 可能有正当用法，所以只扫 src。
    const offenders: string[] = []
    for (const file of collectSources('src')) {
      const body = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'))
      if (/new Function\s*\(/.test(body)) offenders.push(file)
    }
    expect(offenders, `这些文件用 new Function 执行代码：${offenders.join(', ')}`).toEqual([])
  })
})

describe('S5 打包配置不再携带上游脚本', () => {
  const config = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8')

  test('extraResources 只带 FORK-NOTES.md，不带整个 core 目录', () => {
    // 「from: resources/core」（目录级）会把 module.js 一起带上 —— 那是 D63 要删的东西
    expect(config).not.toMatch(/from:\s*resources\/core\s*$/m)
    expect(config).toMatch(/from:\s*resources\/core\/FORK-NOTES\.md/)
  })

  test('CI 反向断言 module.js 不存在（否则将来有人加回来 CI 也是绿的）', () => {
    const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build.yml'), 'utf8')
    // mac：`test ! -f .../module.js`；win：`if (Test-Path $core) { Write-Error`
    expect(workflow).toMatch(/test ! -f "\$APP\/Contents\/Resources\/core\/module\.js"/)
    expect(workflow).toMatch(/Test-Path \$core\)/i)
  })
})
