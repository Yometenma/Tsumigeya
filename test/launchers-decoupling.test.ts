// M4.0 S2/S3 防回归：`src/main/launchers/` **代码**必须不与上游耦合（用户 2026-11-04 明确要求
// 「尽量不想要和上游还有关系」）。
//
// 为什么要有这条测试：M4.0 的全部意义是「不再和上游还有关系」。这类退化是**静默**的——
// 代码能跑、功能正常、其它测试全绿，只是我们又把上游的路径 / 上游的怪规则写回来了。
// 等到用户在 mac 上发现「存档还写在旧目录」或「路径指向 xenolauncher」才暴露，
// 而那时早没人记得原因。
//
// ⚠️ 判据是**剥掉注释后的代码文本**：
//   · 注释里提到上游是**好事**（「上游这里会改写游戏 js/main.js，我们不做」这类说明
//     是决策的载体，删掉它下个会话就会重新发明一遍）
//   · 但代码里（字符串字面量 / import / 调用）不许沾上游
//
// 所以这里先去掉行注释与块注释，再扫：
//   1. 没有 `xenolauncher` 字面量（大小写不敏感）
//   2. 没有硬编码的 home 绝对路径（数据目录必须由 ctx.dataDir 决定）
//   3. 不引用上游 `launcher.js` / 不调 `loadScript`
//   4. 不 import `node:child_process`、不出现 `exec(` 调用（D54：只用 spawn + args 数组）
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const LAUNCHERS_DIR = path.join(process.cwd(), 'src', 'main', 'launchers')

/**
 * 去掉注释（保留字符串字面量不动）。
 *
 * 刻意写得很朴素：只处理 `//` 与块注释两种，不追求完整的词法分析器。
 * 它只需要在这几个我们自己写的文件上正确——而它们没有模板字符串里的 `//`、
 * 也没有正则字面量里的星号斜杠组合。真出现了那种写法，宁可让测试误报（人再看一眼），
 * 也不要让它漏报。
 *
 * ⚠️ 本文件顶部的注释里**不要写出注释定界符的字面形式**：那会把外面的块注释
 * 提前闭合掉，整份文件直接语法错误（本鱼踩过一次，报错是 `Invalid Character `。``）。
 */
export function stripComments(source: string): string {
  let out = ''
  let index = 0
  let inBlock = false
  let inLine = false
  let quote: string | null = null

  while (index < source.length) {
    const char = source[index]
    const next = source[index + 1]

    if (inLine) {
      if (char === '\n') {
        inLine = false
        out += char
      }
      index += 1
      continue
    }
    if (inBlock) {
      if (char === '*' && next === '/') {
        inBlock = false
        index += 2
        continue
      }
      index += 1
      continue
    }
    if (quote) {
      // 字符串内部原样保留（含转义）
      if (char === '\\') {
        out += source.slice(index, index + 2)
        index += 2
        continue
      }
      if (char === quote) quote = null
      out += char
      index += 1
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      out += char
      index += 1
      continue
    }
    if (char === '/' && next === '/') {
      inLine = true
      index += 2
      continue
    }
    if (char === '/' && next === '*') {
      inBlock = true
      index += 2
      continue
    }
    out += char
    index += 1
  }
  return out
}

function launcherSources(): Array<{ name: string; code: string }> {
  return fs
    .readdirSync(LAUNCHERS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => ({
      name: entry.name,
      code: stripComments(fs.readFileSync(path.join(LAUNCHERS_DIR, entry.name), 'utf8'))
    }))
}

describe('stripComments（测试自己的工具，先钉住它）', () => {
  test('去掉行注释与块注释', () => {
    const source = ['const a = 1 // 行注释', '/* 块', '注释 */', 'const b = 2'].join('\n')
    const out = stripComments(source)
    expect(out).not.toContain('行注释')
    expect(out).not.toContain('块')
    expect(out).toContain('const a = 1')
    expect(out).toContain('const b = 2')
  })

  test('字符串里的 // 与 /* 不被当成注释（否则会把真实代码吃掉）', () => {
    const source = `const url = 'https://example.com/a'\nconst glob = '/*.ts'\n`
    const out = stripComments(source)
    expect(out).toContain('https://example.com/a')
    expect(out).toContain('/*.ts')
  })

  test('模板字符串与转义引号不破坏剥离', () => {
    const source = ['const t = `a // b`', "const q = 'it\\'s // not comment'", 'const z = 1'].join('\n')
    const out = stripComments(source)
    expect(out).toContain('a // b')
    expect(out).toContain('const z = 1')
  })
})

describe('M4.0：launchers 代码与上游脱钩', () => {
  test('剥掉注释后没有任何 xenolauncher 字面量', () => {
    for (const source of launcherSources()) {
      expect(source.code.toLowerCase()).not.toContain('xenolauncher')
    }
  })

  test('没有硬编码的 home 绝对路径（数据目录必须由 ctx.dataDir 决定）', () => {
    for (const source of launcherSources()) {
      expect(source.code).not.toMatch(/['"]\/Users\//)
      expect(source.code).not.toMatch(/['"]\/home\//)
    }
  })

  test('不引用上游 launcher.js、不调 loadScript', () => {
    for (const source of launcherSources()) {
      expect(source.code).not.toMatch(/launcher\.js/)
      expect(source.code).not.toContain('loadScript')
    }
  })

  // M4.0 S5：`spawn.ts` 是**唯一允许**碰 child_process 的文件（它是集中调用 spawn 的那一处）。
  // 其余引擎实现不许自己起进程：它们只返回「该怎么启动」的纯数据（LaunchPlan），
  // 真正执行的那一步必须集中在 spawnGame 里，否则「detached + unref」这三件套
  // 会在四个文件里各写一遍，漏一个 = 关掉启动器把游戏一起杀掉（D55）。
  const SPAWN_FILE = 'spawn.ts'
  const engineSources = (): Array<{ name: string; code: string }> =>
    launcherSources().filter((source) => source.name !== SPAWN_FILE)

  test('除 spawn.ts 外不 import child_process（起进程只允许发生在那一处）', () => {
    for (const source of engineSources()) {
      expect(source.code).not.toMatch(/from 'node:child_process'/)
    }
  })

  test('整个 launchers 目录里**不出现 exec**（D54：只用 spawn + args 数组）', () => {
    for (const source of launcherSources()) {
      // spawn.ts 里允许出现 `spawn`，但 `exec` 一律不许（那是上游的写法）
      expect(source.code).not.toMatch(/\bexec\s*\(/)
      expect(source.code).not.toMatch(/\bexecFile\s*\(/)
    }
  })

  test('★ spawn.ts 里的三件套必须齐全（detached + stdio:ignore + unref，D55）', () => {
    const spawnSource = launcherSources().find((source) => source.name === SPAWN_FILE)
    expect(spawnSource).toBeDefined()
    const code = spawnSource!.code
    // 缺任何一个都会导致「关掉 Tsumigeya 游戏也被杀」
    expect(code).toMatch(/detached\s*:\s*true/)
    expect(code).toMatch(/stdio\s*:\s*'ignore'/)
    expect(code).toMatch(/\.unref\(\)/)
  })
})

// ===== M4.0 S6：启动路径彻底不再经过上游 launcher.js =====
//
// S6 删掉了 exec-inject.ts 与 core-host 的 loadScript hook。这条测试锁住「删干净了」：
// 以后谁要是又调 `loadScript(engine, 'launcher.js')`，或者把注入那套加回来，
// 这里立刻红。判据直接扫**生产代码**（不含测试与文档）。
describe('M4.0 S6：生产代码不再加载 launcher.js', () => {
  const SRC_MAIN = path.join(process.cwd(), 'src', 'main')

  /** src/main 下所有 .ts 的（剥注释后的）代码。 */
  function mainSources(): Array<{ name: string; code: string }> {
    return fs
      .readdirSync(SRC_MAIN, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => ({
        name: entry.name,
        code: stripComments(fs.readFileSync(path.join(SRC_MAIN, entry.name), 'utf8'))
      }))
  }

  test('src/main 里没有任何地方加载 launcher.js', () => {
    for (const source of mainSources()) {
      expect(source.code).not.toMatch(/launcher\.js/)
    }
  })

  test('exec-inject.ts 已删除，且没有任何地方 import 它', () => {
    expect(fs.existsSync(path.join(SRC_MAIN, 'exec-inject.ts'))).toBe(false)
    for (const source of mainSources()) {
      expect(source.code).not.toContain('exec-inject')
      expect(source.code).not.toContain('execInterceptor')
      expect(source.code).not.toContain('loadScriptWithInjection')
    }
  })

  test('★ src/main 里没有从 child_process 拿 exec（启动只用 spawn + args 数组）', () => {
    for (const source of mainSources()) {
      // 判据只针对 child_process 的 exec。
      // ⚠️ 不能简单扫 `exec(`：dlsite.ts / diagnose.ts 里有大量正则字面量的
      //   `/x/.exec(html)`，那不是起进程（本鱼第一版就是这么误报的）。
      expect(source.code).not.toMatch(
        /import\s*\{[^}]*\bexec\b[^}]*\}\s*from\s*['"]node:child_process['"]/
      )
      expect(source.code).not.toMatch(
        /const\s*\{[^}]*\bexec\b[^}]*\}\s*=\s*require\s*\(\s*['"]node:child_process['"]/
      )
      expect(source.code).not.toMatch(/require\s*\(\s*['"]node:child_process['"]\s*\)\.exec\s*\(/)
    }
  })

  test('起进程只走 launchers/spawn.ts（ipc 通过注入的 spawnImpl 调用）', () => {
    const ipc = mainSources().find((source) => source.name === 'ipc.ts')
    expect(ipc).toBeDefined()
    const code = ipc?.code ?? ''
    expect(code).toContain('spawnImpl')
    expect(code).toContain('spawnGame')
  })
})
