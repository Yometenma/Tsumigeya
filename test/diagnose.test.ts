// M3 诊断器的单测（docs/M3-实施方案.md §7）。全程离线、不依赖 GUI。
//
// 为什么要单独一个文件：诊断是「启动前自动跑」的，误报的代价极高——
// 一条错误的 fatal 会让本来能玩的游戏**没有绕过按钮**地启动不了（§9 R5）。
// 所以每条检测器的「该报」与「不该报」两面都必须钉死。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import {
  decideWantedRtp,
  detectEncryptedArchive,
  detectFontsPresent,
  detectMissingExecutable,
  detectMissingModule,
  detectMissingRtp,
  detectPathGone,
  diagnoseGame,
  findEncryptedArchives,
  hasBlocking,
  hasExtractedData,
  inferRgssVersionFromLibrary,
  inferRgssVersionFromScripts,
  isBlocking,
  parseArchiveMagic,
  readGameIni,
  resolveGameDir,
  sortDiagnoses,
  type Diagnosis
} from '../src/main/diagnose'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-diagnose-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

/** 造一个「RGSSAD\0 + 版本字节」的最小归档文件（§2.1 实测的真实魔数）。 */
function writeArchive(file: string, versionByte: number): void {
  fs.writeFileSync(file, Buffer.from([0x52, 0x47, 0x53, 0x53, 0x41, 0x44, 0x00, versionByte]))
}

/** 造一个只有 8 字节魔数的文件（不含版本字节）。 */
function writeTruncatedMagic(file: string): void {
  fs.writeFileSync(file, Buffer.from([0x52, 0x47, 0x53, 0x53, 0x41, 0x44, 0x00]))
}

// ===== §2.1 魔数解析 =====

describe('parseArchiveMagic（§2.1 实测的魔数规律）', () => {
  test('第 8 字节 0x01 → RPG Maker XP', () => {
    const file = path.join(dir, 'Game.rgssad')
    writeArchive(file, 0x01)
    expect(parseArchiveMagic(file)).toMatchObject({ isArchive: true, rgssVersion: 1 })
  })

  test('第 8 字节 0x02 → RPG Maker VX', () => {
    const file = path.join(dir, 'Game.rgss2a')
    writeArchive(file, 0x02)
    expect(parseArchiveMagic(file)).toMatchObject({ isArchive: true, rgssVersion: 2 })
  })

  test('第 8 字节 0x03 → RPG Maker VX Ace（用户真实样本 傭兵の冒険 就是这个）', () => {
    const file = path.join(dir, 'Game.rgss3a')
    writeArchive(file, 0x03)
    expect(parseArchiveMagic(file)).toMatchObject({ isArchive: true, rgssVersion: 3 })
  })

  test('普通文件不误判为归档', () => {
    const file = path.join(dir, 'readme.txt')
    fs.writeFileSync(file, 'hello world, definitely not a RGSS archive\n')
    expect(parseArchiveMagic(file)).toMatchObject({ isArchive: false, rgssVersion: null })
  })

  test('魔数只写了 7 字节（无版本字节）→ 不是归档，不硬猜版本', () => {
    const file = path.join(dir, 'Game.rgss3a')
    writeTruncatedMagic(file)
    expect(parseArchiveMagic(file)).toMatchObject({ isArchive: false, rgssVersion: null })
  })

  test('文件不存在 / 读不了 → 不抛错，按「不是归档」处理（诊断不能因一个读不到的文件崩掉）', () => {
    expect(() => parseArchiveMagic(path.join(dir, 'nope.rgss3a'))).not.toThrow()
    expect(parseArchiveMagic(path.join(dir, 'nope.rgss3a')).isArchive).toBe(false)
  })

  test('魔数对、但版本字节不认识（0x7f）→ 是归档、版本为 null（交给扩展名兜底）', () => {
    const file = path.join(dir, 'Game.rgss3a')
    writeArchive(file, 0x7f)
    expect(parseArchiveMagic(file)).toMatchObject({ isArchive: true, rgssVersion: null })
  })
})

// ===== ① detectEncryptedArchive =====

describe('detectEncryptedArchive（§3.2 ①，fatal）', () => {
  function makeGame(archiveName: string, versionByte: number): void {
    writeArchive(path.join(dir, archiveName), versionByte)
    fs.writeFileSync(path.join(dir, 'Game.exe'), 'MZ')
  }

  test('有 .rgss3a、没有 Data/ → fatal + VX Ace + openFolder', () => {
    makeGame('Game.rgss3a', 0x03)
    const result = detectEncryptedArchive(dir)
    expect(result).not.toBeNull()
    expect(result).toMatchObject({
      code: 'encryptedArchive',
      level: 'fatal',
      messageKey: 'diagnose.encryptedArchive',
      args: { file: 'Game.rgss3a', rgssVersion: 'VX Ace' }
    })
    expect(result?.fix).toEqual({ kind: 'openFolder', path: dir })
  })

  test('**已经解包**（有 Data/Scripts.rvdata2）时不报，哪怕 .rgss3a 还在', () => {
    makeGame('Game.rgss3a', 0x03)
    fs.mkdirSync(path.join(dir, 'Data'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'Data', 'Scripts.rvdata2'), '')
    expect(hasExtractedData(dir)).toBe(true)
    expect(detectEncryptedArchive(dir)).toBeNull()
  })

  test('.rgssad → XP；.rgss2a → VX（三个后缀都认，R3）', () => {
    makeGame('Game.rgssad', 0x01)
    expect(detectEncryptedArchive(dir)?.args?.rgssVersion).toBe('XP')

    fs.rmSync(path.join(dir, 'Game.rgssad'))
    makeGame('Game.rgss2a', 0x02)
    expect(detectEncryptedArchive(dir)?.args?.rgssVersion).toBe('VX')
  })

  test('XP 的 Data/Scripts.rxdata 也算已解包（R3：三个后缀都认）', () => {
    makeGame('Game.rgssad', 0x01)
    fs.mkdirSync(path.join(dir, 'Data'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'Data', 'Scripts.rxdata'), '')
    expect(detectEncryptedArchive(dir)).toBeNull()
  })

  test('没有归档文件 → 不报（普通 RPG Maker 目录）', () => {
    fs.writeFileSync(path.join(dir, 'Game.exe'), 'MZ')
    fs.mkdirSync(path.join(dir, 'Data'), { recursive: true })
    expect(findEncryptedArchives(dir)).toEqual([])
    expect(detectEncryptedArchive(dir)).toBeNull()
  })

  test('魔数不认识时退回扩展名（D33 的兜底方向：魔数优先，扩展名可靠）', () => {
    makeGame('Game.rgss3a', 0x7f)
    expect(detectEncryptedArchive(dir)?.args?.rgssVersion).toBe('VX Ace')
  })

  test('归档在子目录里也能找到（只扫一层，跳过点目录）', () => {
    fs.mkdirSync(path.join(dir, 'game'), { recursive: true })
    fs.mkdirSync(path.join(dir, '.hidden'), { recursive: true })
    writeArchive(path.join(dir, 'game', 'Game.rgss3a'), 0x03)
    writeArchive(path.join(dir, '.hidden', 'x.rgss3a'), 0x03)
    expect(findEncryptedArchives(dir)).toEqual([path.join(dir, 'game', 'Game.rgss3a')])
    expect(detectEncryptedArchive(dir)?.args?.file).toBe('game/Game.rgss3a')
  })
})

// ===== §2.5 Game.ini 编码 =====

describe('readGameIni（§2.5 实测：Game.ini 是 GBK 非 UTF-8）', () => {
  /** 造一个真样本那样的 Game.ini：结构行 ASCII + Title 是 GBK 的「傭兵の冒険」。 */
  function writeGbkIni(file: string, lines: string[]): void {
    const gbkTitle = Buffer.from([0xd3, 0xb6, 0xb1, 0xf8, 0xb5, 0xc4, 0xc3, 0xb0, 0xcf, 0xd5])
    fs.writeFileSync(
      file,
      Buffer.concat([
        Buffer.from(lines.join('\r\n') + '\r\n', 'latin1'),
        Buffer.from('Title=', 'latin1'),
        gbkTitle,
        Buffer.from('\r\n', 'latin1')
      ])
    )
  }

  test('GBK 的 Title 不会让解析失败，ASCII 结构行照常读出（不因非 UTF-8 报错）', () => {
    const ini = path.join(dir, 'Game.ini')
    writeGbkIni(ini, [
      '[Game]',
      'RTP=RPGVXAce',
      'Library=System\\RGSS300.dll',
      'Scripts=Data\\Scripts.rvdata2'
    ])
    // readFileSync 用 utf8 读这个文件会得到替换字符，但**我们只按 latin1 读**
    const result = readGameIni(dir)
    expect(result).toMatchObject({
      exists: true,
      rtp: 'RPGVXAce',
      hasRtpLine: true,
      library: 'System\\RGSS300.dll',
      scripts: 'Data\\Scripts.rvdata2'
    })
  })

  test('Title 的乱码绝不进入任何字段（绝不用 Title= 做判断）', () => {
    const ini = path.join(dir, 'Game.ini')
    writeGbkIni(ini, ['[Game]', 'RTP=RPGVXAce'])
    const result = readGameIni(dir)
    const serialized = JSON.stringify(result)
    // GBK 字节按 latin1 读会变成这些拉丁字符；它们不该出现在任何字段里
    expect(serialized).not.toContain('Ó¶±ø')
    expect(result.rtp).toBe('RPGVXAce')
  })

  test('RTP= 大小写不敏感、行首尾空白都能读（R1）', () => {
    const ini = path.join(dir, 'Game.ini')
    fs.writeFileSync(ini, '[Game]\n  rtp =  RPGVX  \n')
    expect(readGameIni(dir).rtp).toBe('RPGVX')
  })

  test('RTP= 空值 = 明确不使用 RTP，不是「缺失」', () => {
    const ini = path.join(dir, 'Game.ini')
    fs.writeFileSync(ini, '[Game]\nRTP=\nScripts=Data\\Scripts.rvdata2\n')
    const result = readGameIni(dir)
    expect(result.hasRtpLine).toBe(true)
    expect(result.rtp).toBeNull()
    // 关键：不能拿它去报 missingRtp
    expect(decideWantedRtp(dir, result)).toMatchObject({ rtp: null, source: 'ini' })
  })

  test('没有 RTP= 这一行 → hasRtpLine=false，交给后面的推断链', () => {
    const ini = path.join(dir, 'Game.ini')
    fs.writeFileSync(ini, '[Game]\nLibrary=System\\RGSS300.dll\n')
    expect(readGameIni(dir)).toMatchObject({ hasRtpLine: false, rtp: null })
  })

  test('只认 [Game] 段，别的段里的同名键不算数', () => {
    const ini = path.join(dir, 'Game.ini')
    fs.writeFileSync(ini, '[Game]\nTitle=x\n[Other]\nRTP=RPGVXace\n')
    expect(readGameIni(dir).rtp).toBeNull()
  })

  test('Game.ini 不存在 → exists=false，不抛错', () => {
    expect(readGameIni(dir)).toMatchObject({ exists: false, rtp: null, hasRtpLine: false })
  })
})

describe('RTP 版本推断链（R1 的兜底顺序）', () => {
  test('Library= 里的 RGSS<数字> 优先（游戏自己声明的加载目标）', () => {
    expect(inferRgssVersionFromLibrary('System\\RGSS300.dll')).toBe(3)
    expect(inferRgssVersionFromLibrary('RGSS202E.dll')).toBe(2)
    expect(inferRgssVersionFromLibrary('RGSS104E.dll')).toBe(1)
    expect(inferRgssVersionFromLibrary(null)).toBeNull()
    expect(inferRgssVersionFromLibrary('System\\foo.dll')).toBeNull()
  })

  test('Scripts= 的扩展名 → 版本（rvdata2/rvdata/rxdata）', () => {
    expect(inferRgssVersionFromScripts('Data\\Scripts.rvdata2')).toBe(3)
    expect(inferRgssVersionFromScripts('Data\\Scripts.rvdata')).toBe(2)
    expect(inferRgssVersionFromScripts('Data\\Scripts.rxdata')).toBe(1)
    expect(inferRgssVersionFromScripts(null)).toBeNull()
  })

  test('Game.ini 读到 RTP= 时直接用它的值', () => {
    fs.mkdirSync(path.join(dir, 'Data'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'Game.ini'), '[Game]\nRTP=RPGVXace\n')
    expect(decideWantedRtp(dir)).toMatchObject({ rtp: 'RPGVXace', source: 'ini' })
  })

  test('读不到 RTP= 时按 Library= 映射（§3.2 ② 的要求）', () => {
    fs.writeFileSync(path.join(dir, 'Game.ini'), '[Game]\nLibrary=System\\RGSS300.dll\n')
    expect(decideWantedRtp(dir)).toMatchObject({ rtp: 'RPGVXace', source: 'library', rgssVersion: 3 })
  })

  test('什么都没有但存在 .rgss3a → 按归档魔数映射', () => {
    writeArchive(path.join(dir, 'Game.rgss3a'), 0x03)
    expect(decideWantedRtp(dir)).toMatchObject({ rtp: 'RPGVXace', source: 'archive', rgssVersion: 3 })
  })

  test('完全无线索 → rtp=null（不瞎猜，猜错会让用户白下 244MB）', () => {
    expect(decideWantedRtp(dir)).toMatchObject({ rtp: null, source: 'unknown' })
  })

  test('RTP= 里带路径穿越的非法值直接丢弃（不能拼出越界路径）', () => {
    fs.writeFileSync(path.join(dir, 'Game.ini'), '[Game]\nRTP=..\\..\\evil\n')
    expect(decideWantedRtp(dir).rtp).toBeNull()
  })
})

// ===== ② detectMissingRtp =====

describe('detectMissingRtp（§3.2 ②、§2.3 的目录结构）', () => {
  function makeEngineModules(rtpNames: string[]): string {
    const modulesDir = path.join(dir, 'modules')
    for (const name of rtpNames) {
      const target = path.join(modulesDir, 'mkxpz', 'deps', 'RTP', 'RTP', name)
      fs.mkdirSync(target, { recursive: true })
    }
    return modulesDir
  }

  test('deps/RTP/RTP/RPGVXace 不存在 → warning + installRtp（**不拦启动**）', () => {
    const modulesDir = makeEngineModules([])
    const result = detectMissingRtp(path.join(modulesDir, 'mkxpz'), 'mkxpz', 'RPGVXace')
    expect(result).toMatchObject({
      code: 'missingRtp',
      level: 'warning',
      args: { rtp: 'RPGVXace', engine: 'mkxpz' },
      fix: { kind: 'installRtp', engine: 'mkxpz' }
    })
    // warning 不是 fatal —— 缺 RTP 常常仍能跑，必须给「还是启动试试」
    expect(isBlocking(result as Diagnosis)).toBe(false)
  })

  test('目录存在且是目录时不报', () => {
    const modulesDir = makeEngineModules(['RPGVXace'])
    expect(detectMissingRtp(path.join(modulesDir, 'mkxpz'), 'mkxpz', 'RPGVXace')).toBeNull()
  })

  test('同名路径但不是目录（是个文件）→ 仍算缺失', () => {
    const modulesDir = path.join(dir, 'modules')
    fs.mkdirSync(path.join(modulesDir, 'mkxpz', 'deps', 'RTP', 'RTP'), { recursive: true })
    fs.writeFileSync(path.join(modulesDir, 'mkxpz', 'deps', 'RTP', 'RTP', 'RPGVXace'), '')
    expect(detectMissingRtp(path.join(modulesDir, 'mkxpz'), 'mkxpz', 'RPGVXace')).not.toBeNull()
  })

  test('wanted 为 null 时不检查（无法确定要哪个 RTP）', () => {
    expect(detectMissingRtp(path.join(dir, 'modules', 'mkxpz'), 'mkxpz', null)).toBeNull()
  })
})

// ===== ③④ 路径 / 模块 / 可执行 =====

describe('detectPathGone / detectMissingModule / detectMissingExecutable', () => {
  test('路径不存在 → fatal + repoint（让用户去编辑页重选）', () => {
    const result = detectPathGone(path.join(dir, 'gone'))
    expect(result).toMatchObject({ code: 'pathGone', level: 'fatal', fix: { kind: 'repoint' } })
    expect(isBlocking(result as Diagnosis)).toBe(true)
  })

  test('路径存在 → 不报', () => {
    expect(detectPathGone(dir)).toBeNull()
  })

  test('模块未安装 → fatal + installModule', () => {
    const result = detectMissingModule('mkxpz', ['nwjs'])
    expect(result).toMatchObject({
      code: 'moduleMissing',
      level: 'fatal',
      args: { engine: 'mkxpz' },
      fix: { kind: 'installModule', engine: 'mkxpz' }
    })
  })

  test('模块已安装 → 不报', () => {
    expect(detectMissingModule('mkxpz', ['mkxpz', 'nwjs'])).toBeNull()
  })

  test('引擎名为空 → 仍然 fatal（装不了模块就启动不了）', () => {
    const result = detectMissingModule('', [])
    expect(result).toMatchObject({ code: 'moduleMissing', level: 'fatal' })
  })

  test('目录里一个可执行候选都没有 → fatal + openFolder', () => {
    fs.writeFileSync(path.join(dir, 'readme.txt'), 'nothing runnable here')
    const result = detectMissingExecutable(dir)
    expect(result).toMatchObject({
      code: 'missingExecutable',
      level: 'fatal',
      fix: { kind: 'openFolder', path: dir }
    })
  })

  test('有 Game.exe → 不报（与添加游戏时的识别用同一套 scanCandidates）', () => {
    fs.writeFileSync(path.join(dir, 'Game.exe'), 'MZ')
    expect(detectMissingExecutable(dir)).toBeNull()
  })
})

// ===== ⑤ detectFontsPresent =====

describe('detectFontsPresent（§2.4 / D35：只提示不修）', () => {
  test('Fonts/*.ttf → info，**且没有 fix**（不做自动字体修复）', () => {
    fs.mkdirSync(path.join(dir, 'Fonts'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'Fonts', 'Lolita.ttf'), '')
    fs.writeFileSync(path.join(dir, 'Fonts', 'VL-Gothic-Regular.ttf'), '')
    const result = detectFontsPresent(dir)
    expect(result).toMatchObject({
      code: 'fontsPresent',
      level: 'info',
      args: { count: '2' }
    })
    expect(result?.fix).toBeUndefined()
    expect(isBlocking(result as Diagnosis)).toBe(false)
  })

  test('小写 fonts/ 与 .otf 也认', () => {
    fs.mkdirSync(path.join(dir, 'fonts'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'fonts', 'a.otf'), '')
    expect(detectFontsPresent(dir)?.args?.count).toBe('1')
  })

  test('没有 Fonts 目录 → 不报', () => {
    expect(detectFontsPresent(dir)).toBeNull()
  })

  test('Fonts/ 里没有字体文件（只有 txt）→ 不报', () => {
    fs.mkdirSync(path.join(dir, 'Fonts'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'Fonts', 'readme.txt'), '')
    expect(detectFontsPresent(dir)).toBeNull()
  })
})

// ===== 汇总 =====

describe('diagnoseGame（§3.3）', () => {
  test('fatal → warning → info 排序', () => {
    const modulesDir = path.join(dir, 'modules')
    const gamePath = path.join(dir, 'game')
    fs.mkdirSync(gamePath, { recursive: true })
    fs.writeFileSync(path.join(gamePath, 'Game.exe'), 'MZ')
    fs.mkdirSync(path.join(gamePath, 'Fonts'), { recursive: true })
    fs.writeFileSync(path.join(gamePath, 'Fonts', 'a.ttf'), '')
    writeArchive(path.join(gamePath, 'Game.rgss3a'), 0x03)

    const diagnoses = diagnoseGame({
      game: { gamePath, gameEngine: 'mkxpz' },
      modulesDir,
      installedModules: ['mkxpz']
    })
    expect(diagnoses.map((item) => item.level)).toEqual(['fatal', 'warning', 'info'])
    expect(diagnoses.map((item) => item.code)).toEqual([
      'encryptedArchive',
      'missingRtp',
      'fontsPresent'
    ])
    expect(hasBlocking(diagnoses)).toBe(true)
  })

  test('空目录不崩（目录里什么都没有 → pathGone 之外不该有垃圾数据）', () => {
    const empty = path.join(dir, 'empty')
    fs.mkdirSync(empty, { recursive: true })
    expect(() =>
      diagnoseGame({ game: { gamePath: empty, gameEngine: 'mkxpz' }, modulesDir: path.join(dir, 'modules'), installedModules: [] })
    ).not.toThrow()
  })

  test('gamePath 不存在 → 直接只返回 pathGone（后续目录检查全是噪音）', () => {
    const diagnoses = diagnoseGame({
      game: { gamePath: path.join(dir, 'gone'), gameEngine: 'mkxpz' },
      modulesDir: path.join(dir, 'modules'),
      installedModules: []
    })
    expect(diagnoses).toHaveLength(1)
    expect(diagnoses[0].code).toBe('pathGone')
  })

  test('模块没装时不报 missingRtp（否则用户不知道该点哪个按钮）', () => {
    const gamePath = path.join(dir, 'game')
    fs.mkdirSync(gamePath, { recursive: true })
    fs.writeFileSync(path.join(gamePath, 'Game.exe'), 'MZ')
    fs.writeFileSync(path.join(gamePath, 'Game.ini'), '[Game]\nRTP=RPGVXace\n')
    const diagnoses = diagnoseGame({
      game: { gamePath, gameEngine: 'mkxpz' },
      modulesDir: path.join(dir, 'modules'),
      installedModules: []
    })
    expect(diagnoses.map((item) => item.code)).toContain('moduleMissing')
    expect(diagnoses.map((item) => item.code)).not.toContain('missingRtp')
  })

  test('非 RGSS 引擎（nwjs）不查 RTP', () => {
    const gamePath = path.join(dir, 'game')
    fs.mkdirSync(path.join(gamePath, 'www'), { recursive: true })
    fs.writeFileSync(path.join(gamePath, 'nw.exe'), 'MZ')
    fs.writeFileSync(path.join(gamePath, 'www', 'package.json'), '{}')
    const diagnoses = diagnoseGame({
      game: { gamePath, gameEngine: 'nwjs' },
      modulesDir: path.join(dir, 'modules'),
      installedModules: ['nwjs']
    })
    expect(diagnoses).toEqual([])
  })

  test('gamePath 是文件时按它所在目录检查，且不再报 missingExecutable', () => {
    const gamePath = path.join(dir, 'game')
    fs.mkdirSync(gamePath, { recursive: true })
    const exe = path.join(gamePath, 'Game.exe')
    fs.writeFileSync(exe, 'MZ')
    expect(resolveGameDir(exe)).toBe(gamePath)
    const diagnoses = diagnoseGame({
      game: { gamePath: exe, gameEngine: 'mkxpz' },
      modulesDir: path.join(dir, 'modules'),
      installedModules: ['mkxpz']
    })
    expect(diagnoses.map((item) => item.code)).not.toContain('missingExecutable')
  })

  test('sortDiagnoses 不改原数组（纯函数）', () => {
    const list: Diagnosis[] = [
      { code: 'fontsPresent', level: 'info', messageKey: 'diagnose.fontsPresent' },
      { code: 'pathGone', level: 'fatal', messageKey: 'diagnose.pathGone' }
    ]
    const sorted = sortDiagnoses(list)
    expect(sorted.map((item) => item.level)).toEqual(['fatal', 'info'])
    expect(list[0].level).toBe('info')
  })
})

// ===== 真实样本回归（§2.2：傭兵の冒険 的结构）=====

describe('真实样本回归：test/fixtures/encrypted-rgss3a', () => {
  const fixture = path.join(process.cwd(), 'test', 'fixtures', 'encrypted-rgss3a')

  test('拿到 encryptedArchive + rgssVersion=VX Ace，且 fatal', () => {
    const result = detectEncryptedArchive(fixture)
    expect(result).toMatchObject({
      code: 'encryptedArchive',
      level: 'fatal',
      args: { file: 'Game.rgss3a', rgssVersion: 'VX Ace' }
    })
    expect(hasBlocking([result as Diagnosis])).toBe(true)
  })

  test('fixture 的 Game.ini 是 GBK 的 Title + ASCII 结构行（与真实样本一致）', () => {
    const ini = readGameIni(fixture)
    expect(ini.exists).toBe(true)
    expect(ini.rtp).toBe('RPGVXAce')
    expect(ini.scripts).toBe('Data\\Scripts.rvdata2')
    expect(ini.library).toBe('System\\RGSS300.dll')
    // 魔数与 ini 两个信号一致指向 VX Ace
    expect(parseArchiveMagic(path.join(fixture, 'Game.rgss3a')).rgssVersion).toBe(3)
  })

  test('整套诊断在真实样本上给出 encryptedArchive + missingRtp（模块未装 RTP 时）', () => {
    const diagnoses = diagnoseGame({
      game: { gamePath: fixture, gameEngine: 'mkxpz' },
      modulesDir: path.join(dir, 'modules'),
      installedModules: ['mkxpz']
    })
    expect(diagnoses.map((item) => item.code)).toEqual(['encryptedArchive', 'missingRtp'])
    expect(diagnoses[1].args?.rtp).toBe('RPGVXAce')
  })
})
