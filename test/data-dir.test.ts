// M4.0 S6.5 单测：数据目录切到 Tsumigeya（D58）+ 切换说明的判定。
//
// 两件事要钉死：
//   1. **数据目录是 `Tsumigeya`，且代码里不再出现别的程序的目录名**（防回归）
//   2. **切换说明只在「确实是空的」且「没提示过」且「是 mac」时给一次**
//      —— 写错的表现是「每次启动都弹一句莫名其妙的话」，或「真的丢了数据却什么都不说」
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { resolveDataDir } from '../src/main/core-host'
import {
  DATA_DIR_NOTICE_KEY,
  DATA_DIR_NOTICE_TEXT,
  isEmptyDataDir,
  shouldShowDataDirNotice
} from '../src/main/data-dir-notice'

const created: string[] = []
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-s65-'))
  created.push(dir)
  return dir
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

const HOME = path.join('/Users', 'tester')

describe('S6.5：macOS 数据目录是 Tsumigeya', () => {
  test('darwin → ~/Library/Application Support/Tsumigeya', () => {
    expect(resolveDataDir({ env: {}, platform: 'darwin', homedir: HOME })).toBe(
      path.join(HOME, 'Library', 'Application Support', 'Tsumigeya')
    )
  })

  test('★ 拼出来的路径里不含任何别的程序的目录名', () => {
    const resolved = resolveDataDir({ env: {}, platform: 'darwin', homedir: HOME })
    expect(resolved.toLowerCase()).not.toContain('xenolauncher')
  })

  test('darwin 下 userData 不参与（不会误用 Electron 的 userData）', () => {
    const resolved = resolveDataDir({
      env: {},
      platform: 'darwin',
      homedir: HOME,
      userData: '/Users/tester/Library/Application Support/Electron'
    })
    expect(resolved).toBe(path.join(HOME, 'Library', 'Application Support', 'Tsumigeya'))
  })

  test('TSUMIGEYA_DATA_DIR 仍然最高优先（调试隔离用）', () => {
    expect(resolveDataDir({ env: { TSUMIGEYA_DATA_DIR: '/tmp/custom' }, platform: 'darwin', homedir: HOME })).toBe(
      path.resolve('/tmp/custom')
    )
  })

  test('Windows 分支没被带坏（仍是 %APPDATA%/tsumigeya）', () => {
    expect(resolveDataDir({ env: {}, platform: 'win32', homedir: 'C:\\Users\\tester' })).toBe(
      path.join('C:\\Users\\tester', 'AppData', 'Roaming', 'tsumigeya')
    )
  })
})

describe('S6.5：isEmptyDataDir（判据：既没 modules 也没 games.json）', () => {
  test('空目录 → 算空', () => {
    expect(isEmptyDataDir(tempDir())).toBe(true)
  })

  test('没有这个目录本身 → 也算空（首次运行）', () => {
    expect(isEmptyDataDir(path.join(os.tmpdir(), 'tsmg-not-exist-' + Date.now()))).toBe(true)
  })

  test('有 modules → 不算空（引擎装过了）', () => {
    const dir = tempDir()
    fs.mkdirSync(path.join(dir, 'modules'))
    expect(isEmptyDataDir(dir)).toBe(false)
  })

  test('有 games.json → 不算空（游戏库有东西）', () => {
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'games.json'), '{}')
    expect(isEmptyDataDir(dir)).toBe(false)
  })

  test('只有 play-stats.json 之类 → 仍算空（那是附属数据，不代表用起来了）', () => {
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'play-stats.json'), '{}')
    writeSettings(dir)
    expect(isEmptyDataDir(dir)).toBe(true)
  })
})

/** 造一份「已提示过」的 global-settings.json（模拟二次启动）。 */
function writeSettings(dir: string, extra: Record<string, unknown> = {}): void {
  fs.writeFileSync(path.join(dir, 'global-settings.json'), JSON.stringify(extra))
}

describe('S6.5：shouldShowDataDirNotice（三个条件全满足才提示）', () => {
  test('mac + 空目录 + 没提示过 → 提示', () => {
    expect(
      shouldShowDataDirNotice({ dataDir: tempDir(), settings: {}, platform: 'darwin' })
    ).toBe(true)
  })

  test('★ 已经提示过 → 不再提示（否则每次启动都弹）', () => {
    expect(
      shouldShowDataDirNotice({
        dataDir: tempDir(),
        settings: { [DATA_DIR_NOTICE_KEY]: true },
        platform: 'darwin'
      })
    ).toBe(false)
  })

  test('★ 目录里已经有数据 → 不提示（那是正常使用的用户，不是刚升级上来的）', () => {
    const dir = tempDir()
    fs.mkdirSync(path.join(dir, 'modules'))
    expect(shouldShowDataDirNotice({ dataDir: dir, settings: {}, platform: 'darwin' })).toBe(false)
  })

  test('非 mac（Windows 开发机）→ 永不提示（数据目录没变过）', () => {
    for (const platform of ['win32', 'linux'] as const) {
      expect(shouldShowDataDirNotice({ dataDir: tempDir(), settings: {}, platform })).toBe(false)
    }
  })

  test('标记是 true 才算「提示过」（别的真值不误判）', () => {
    // 例如手改成的字符串 "true" 不该当作已提示（那样会漏提示）
    expect(
      shouldShowDataDirNotice({ dataDir: tempDir(), settings: { [DATA_DIR_NOTICE_KEY]: 'true' }, platform: 'darwin' })
    ).toBe(true)
  })
})

describe('S6.5：提示文案', () => {
  test('说得清「切换了」「要重新装」「旧数据没被删」', () => {
    expect(DATA_DIR_NOTICE_TEXT).toContain('切换')
    expect(DATA_DIR_NOTICE_TEXT).toContain('重新')
    // 这条很重要：用户最怕的是「我的东西被删了」
    expect(DATA_DIR_NOTICE_TEXT).toContain('不会被删除')
  })

  test('★ 不含 ICU 语法（vue-i18n 没装编译器，ICU 会让组件白屏）', () => {
    expect(DATA_DIR_NOTICE_TEXT).not.toMatch(/\{[^}]*,\s*plural/)
    expect(DATA_DIR_NOTICE_TEXT).not.toMatch(/\{[^}]*,\s*select/)
  })
})

// ===== 防回归：整个 src/ 里不再出现别的程序的目录名 =====
//
// 这条比单点断言更狠：它扫**所有生产代码**（剥掉注释后），
// 保证没有人把旧目录名、或别的程序的路径写回来。
// 注释里允许出现（那是 D58 的历史记录，删掉它下个会话就会重新发明一遍）。
describe('S6.5：src/ 全量扫描（数据目录不再沾别的程序）', () => {
  const SRC = path.join(process.cwd(), 'src')

  /** 递归收集 src 下所有 .ts 文件（跳过 .vue：那是模板，判据不适用）。 */
  function allTs(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) allTs(full, out)
      else if (entry.name.endsWith('.ts')) out.push(full)
    }
    return out
  }

  /** 剥掉注释（与 launchers-decoupling.test.ts 同一套朴素做法）。 */
  function stripComments(source: string): string {
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

  test('★ src/ 的代码里没有 xenolauncher 字面量（只在注释里作为历史说明出现）', () => {
    for (const file of allTs(SRC)) {
      const code = stripComments(fs.readFileSync(file, 'utf8'))
      expect(code.toLowerCase()).not.toContain('xenolauncher')
    }
  })
})
