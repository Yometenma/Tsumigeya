// extract 单测（§6）：路径安全校验 + 系统 tar 真实打包解包。不依赖网络与 GUI。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { assertSafeEntry, extractArchive, hasSystemTar, tarBinary } from '../src/main/extract'

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), 'tsmg-extract-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

/** 断言某条路径被当作不安全拒绝。 */
function expectUnsafe(entry: string): void {
  expect(() => assertSafeEntry(entry)).toThrow(
    expect.objectContaining({ translationKey: 'error.unsafeArchive' })
  )
}

describe('assertSafeEntry 拒绝不安全路径', () => {
  test('绝对路径', () => {
    expectUnsafe('/abs')
    expectUnsafe('/etc/passwd')
    expectUnsafe('/')
  })

  test('父目录穿越', () => {
    expectUnsafe('../x')
    expectUnsafe('a/../../x')
    expectUnsafe('../../../../etc/passwd')
    expectUnsafe('a/b/../../..')
  })

  test('Windows 盘符绝对路径', () => {
    expectUnsafe('C:/x')
    expectUnsafe('C:\\x')
    expectUnsafe('d:/Windows/system32')
  })

  test('反斜杠分隔（Windows 风格路径混进来）', () => {
    expectUnsafe('a\\b')
    expectUnsafe('..\\x')
  })

  test('NUL 与控制字符', () => {
    expectUnsafe('a\u0000b')
    expectUnsafe('a\u0001b')
    expectUnsafe('line\nbreak')
    expectUnsafe('tab\there')
    expectUnsafe('\u007f')
  })

  test('空字符串', () => {
    expectUnsafe('')
  })
})

describe('assertSafeEntry 放行正常路径', () => {
  test('普通相对路径', () => {
    expect(() => assertSafeEntry('file.txt')).not.toThrow()
    expect(() => assertSafeEntry('dir/file.txt')).not.toThrow()
    expect(() => assertSafeEntry('a/b/c/d.bin')).not.toThrow()
  })

  test('中文名与空格', () => {
    expect(() => assertSafeEntry('游戏目录/启动器.exe')).not.toThrow()
    expect(() => assertSafeEntry('my game/data file.bin')).not.toThrow()
    expect(() => assertSafeEntry('中文 空格/文件 名.dat')).not.toThrow()
  })

  test('以点开头的合法相对路径（不是 ..）', () => {
    expect(() => assertSafeEntry('.hidden/file')).not.toThrow()
    expect(() => assertSafeEntry('a/./b')).not.toThrow()
  })

  test('文件名里出现 .. 但不是独立路径段', () => {
    expect(() => assertSafeEntry('file..name.txt')).not.toThrow()
    expect(() => assertSafeEntry('a..b/c..d')).not.toThrow()
  })
})

describe('系统 tar 往返', () => {
  test('tarBinary 在支持的平台指向存在的可执行文件', () => {
    if (!hasSystemTar()) return // 某些环境没有 tar
    expect(existsSync(tarBinary())).toBe(true)
  })

  test('tar -cf 打包 → extractArchive 解包，内容一致', () => {
    if (!hasSystemTar()) {
      // §6：本机没有 tar 则跳过
      return
    }
    const source = path.join(workDir, 'source')
    mkdirSync(path.join(source, 'data'), { recursive: true })
    mkdirSync(path.join(source, '音乐'), { recursive: true })
    writeFileSync(path.join(source, 'Game.exe'), 'binary-ish-content')
    writeFileSync(path.join(source, 'data', 'System.rvdata2'), 'data-content')
    writeFileSync(path.join(source, '中文 文件名.txt'), 'unicode content')
    writeFileSync(path.join(source, '音乐', 'bgm.ogg'), 'audio')

    const archive = path.join(workDir, 'bundle.tar')
    execFileSync(tarBinary(), ['-cf', archive, '-C', source, '.'], { stdio: 'pipe' })

    const destination = path.join(workDir, 'extracted')
    return extractArchive(archive, destination).then(() => {
      expect(readFileSync(path.join(destination, 'Game.exe'), 'utf8')).toBe('binary-ish-content')
      expect(readFileSync(path.join(destination, 'data', 'System.rvdata2'), 'utf8')).toBe('data-content')
      expect(readFileSync(path.join(destination, '中文 文件名.txt'), 'utf8')).toBe('unicode content')
      expect(readFileSync(path.join(destination, '音乐', 'bgm.ogg'), 'utf8')).toBe('audio')
    })
  })

  test('归档不存在 → error.download', async () => {
    await expect(
      extractArchive(path.join(workDir, 'nope.tar'), path.join(workDir, 'out'))
    ).rejects.toMatchObject({ translationKey: 'error.download' })
  })

  test('中止信号生效（signal.throwIfAborted）', async () => {
    const controller = new AbortController()
    controller.abort()
    const archive = path.join(workDir, 'whatever.tar')
    writeFileSync(archive, '')
    await expect(extractArchive(archive, path.join(workDir, 'out'), { signal: controller.signal })).rejects.toThrow()
  })

  test('目标目录不存在时会自动创建', () => {
    if (!hasSystemTar()) return
    const source = path.join(workDir, 'src2')
    mkdirSync(source, { recursive: true })
    writeFileSync(path.join(source, 'a.txt'), 'x')
    const archive = path.join(workDir, 'b2.tar')
    execFileSync(tarBinary(), ['-cf', archive, '-C', source, '.'], { stdio: 'pipe' })

    const destination = path.join(workDir, 'deep', 'nested', 'out')
    return extractArchive(archive, destination).then(() => {
      expect(readdirSync(destination).length).toBeGreaterThan(0)
    })
  })
})
