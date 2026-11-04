// M4.0 S3 单测：mkxp-z 的 mkxp.json 生成（含 RTP 推断复用 + 值类型转换）。
//
// 这个文件要钉住的是**写进磁盘的 JSON 内容**，因为 mkxp-z 读它是严格类型的：
// 类型错了不报错，只是某个选项静默失效（「设置无效」类问题最难查）。
//
// 重点覆盖：
//   · RTP 推断复用了 M3 的 decideWantedRtp（不重写一套）
//   · XP 的真实目录名是 Standard（不是 RPGXP）—— M4.0 实测纠正
//   · 用户显式设置 > 本地推断
//   · 字符串 → 布尔/数字/绝对路径的转换（表单出来都是字符串）
//   · prepare 真的把文件写到 Contents/Game/mkxp.json，且失败会抛
//   · 绝不写用户的游戏目录
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { RTP_BY_RGSS_VERSION, decideWantedRtp, normalizeRtpName, readGameIni } from '../src/main/diagnose'
import { mkxpzBinaryPath, mkxpzConfigPath, mkxpzRtpDir } from '../src/main/launchers/binary-paths'
import {
  buildMkxpConfig,
  coerceValue,
  expandTilde,
  mkxpzPlan,
  resolveRtp,
  RGSS_AUTO,
  pointsElsewhere,
  versionOfRtpName,
  writeMkxpConfig
} from '../src/main/launchers/mkxpz'
import type { LaunchContext } from '../src/main/launchers/types'

const HOME = path.join('/Users', 'tester')

const created: string[] = []
function tempDir(prefix = 'tsmg-s3-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  created.push(dir)
  return dir
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * 造一个 mkxpz 风格的游戏目录。
 *
 * `Game.ini` 用 **latin1 可读的 ASCII 结构行**（真实文件是 GBK，但我们只读 RTP=/Library=）。
 */
function makeGame(options: { ini?: string; folderName?: string } = {}): LaunchContext {
  const dataDir = tempDir('tsmg-s3-data-')
  const folder = path.join(tempDir('tsmg-s3-game-'), options.folderName ?? 'Game')
  fs.mkdirSync(folder, { recursive: true })
  if (options.ini !== undefined) fs.writeFileSync(path.join(folder, 'Game.ini'), options.ini)
  return {
    folder,
    gamePath: folder,
    gameArgs: {},
    gameTitle: '测试游戏',
    dataDir,
    platform: 'darwin',
    arch: 'arm64'
  }
}

// ===== 值类型转换 =====

describe('S3：值类型转换（表单出来都是字符串，mkxp.json 要真类型）', () => {
  test('"true"/"false" → 布尔', () => {
    expect(coerceValue('true', HOME)).toBe(true)
    expect(coerceValue('false', HOME)).toBe(false)
    expect(coerceValue(' TRUE ', HOME)).toBe(true)
  })

  test('整数串 → 数字（只有整数，不猜浮点）', () => {
    expect(coerceValue('3', HOME)).toBe(3)
    expect(coerceValue('-1', HOME)).toBe(-1)
    expect(coerceValue('60', HOME)).toBe(60)
    // 浮点串不转：无歧义地该转成数字的场景不存在，转了反而与表单默认值类型不一致
    expect(coerceValue('1.5', HOME)).toBe('1.5')
  })

  test('~/ 展开成绝对路径', () => {
    expect(coerceValue('~/fonts/a.ttf', HOME)).toBe(path.join(HOME, 'fonts', 'a.ttf'))
  })

  test('非字符串原样返回（数字/布尔/对象不重复处理）', () => {
    expect(coerceValue(3, HOME)).toBe(3)
    expect(coerceValue(true, HOME)).toBe(true)
    expect(coerceValue(null, HOME)).toBeNull()
  })

  test('数组与对象逐项转换', () => {
    expect(coerceValue(['1', 'true', '~/a'], HOME)).toEqual([1, true, path.join(HOME, 'a')])
    expect(coerceValue({ a: '1', b: '~/b' }, HOME)).toEqual({ a: 1, b: path.join(HOME, 'b') })
  })

  test('空串原样保留（不变成 0 / false —— 那会改变语义）', () => {
    expect(coerceValue('', HOME)).toBe('')
    expect(coerceValue('   ', HOME)).toBe('   ')
  })

  test('expandTilde 只处理 ~/ 开头', () => {
    expect(expandTilde('~/a', HOME)).toBe(path.join(HOME, 'a'))
    expect(expandTilde('/abs', HOME)).toBe('/abs')
    expect(expandTilde('~root/a', HOME)).toBe('~root/a')
  })
})

// ===== RTP 推断（复用 M3）=====

describe('S3：RTP 与 rgssVersion 的决策', () => {
  test('★ XP 的真实目录名是 Standard（不是 RPGXP，M4.0 实测纠正）', () => {
    expect(RTP_BY_RGSS_VERSION[1]).toBe('Standard')
    expect(RTP_BY_RGSS_VERSION[2]).toBe('RPGVX')
    expect(RTP_BY_RGSS_VERSION[3]).toBe('RPGVXace')
    // RPGXP 是 XP 的官方叫法，归一化后应指向真实目录 Standard
    expect(normalizeRtpName('RPGXP')).toBe('Standard')
  })

  test('用户显式选了 rgssVersion=3 → 用 RPGVXace 目录，不读 Game.ini', () => {
    const ctx = makeGame({ ini: '[Game]\r\nRTP=RPGVX\r\n' })
    ctx.gameArgs = { rgssVersion: '3' }
    const decision = resolveRtp(ctx, HOME)
    expect(decision.rgssVersion).toBe(3)
    expect(decision.rtpName).toBe('RPGVXace')
    expect(decision.rtpDirs).toEqual([mkxpzRtpDir(ctx.dataDir, 'RPGVXace')])
    expect(decision.source).toBe('gameArgs')
  })

  test('用户显式选了 1 → Standard；选了 2 → RPGVX', () => {
    for (const [version, expected] of [
      ['1', 'Standard'],
      ['2', 'RPGVX']
    ] as const) {
      const ctx = makeGame()
      ctx.gameArgs = { rgssVersion: version }
      const decision = resolveRtp(ctx, HOME)
      expect(decision.rgssVersion).toBe(Number(version))
      expect(decision.rtpName).toBe(expected)
      expect(decision.rtpDirs).toEqual([mkxpzRtpDir(ctx.dataDir, expected)])
    }
  })

  test('rgssVersion 是 "0"（自动）→ 走本地推断，不当作显式版本', () => {
    const ctx = makeGame({ ini: '[Game]\r\nRTP=RPGVXAce\r\n' })
    ctx.gameArgs = { rgssVersion: '0' }
    const decision = resolveRtp(ctx, HOME)
    expect(decision.rgssVersion).toBe(3) // 从 Game.ini 的 RTP=RPGVXAce 推出 VX Ace
    expect(decision.rtpName).toBe('RPGVXace')
    expect(decision.source).toBe('ini')
  })

  test('读 Game.ini 的 RTP= 复用 M3 的 decideWantedRtp（同一结论）', () => {
    const ctx = makeGame({ ini: '[Game]\r\nRTP=RPGVXace\r\nLibrary=System\\RGSS300.dll\r\n' })
    const decision = resolveRtp(ctx, HOME)
    const ini = readGameIni(ctx.folder)
    const wanted = decideWantedRtp(ctx.folder, ini)
    expect(decision.rtpName).toBe(wanted.rtp)
    expect(decision.rgssVersion).toBe(wanted.rgssVersion)
    expect(decision.rtpDirs).toEqual([mkxpzRtpDir(ctx.dataDir, wanted.rtp!)])
  })

  test('Game.ini 写 RTP=RPGXP（XP 官方叫法）→ 查到 Standard 目录', () => {
    const ctx = makeGame({ ini: '[Game]\r\nRTP=RPGXP\r\n' })
    const decision = resolveRtp(ctx, HOME)
    expect(decision.rtpName).toBe('Standard')
    expect(decision.rtpDirs).toEqual([mkxpzRtpDir(ctx.dataDir, 'Standard')])
  })

  test('读不到任何线索 → rgssVersion=0 且 RTP 空数组（**不兜底一个猜的版本**）', () => {
    const ctx = makeGame() // 没有 Game.ini
    const decision = resolveRtp(ctx, HOME)
    expect(decision.rgssVersion).toBe(RGSS_AUTO)
    expect(decision.rtpDirs).toEqual([])
    expect(decision.rtpName).toBeNull()
    expect(decision.source).toBe('unknown')
  })

  test('Game.ini 写了 RTP= 空值（明确不用 RTP）→ 不推断、RTP 为空', () => {
    const ctx = makeGame({ ini: '[Game]\r\nRTP=\r\n' })
    const decision = resolveRtp(ctx, HOME)
    expect(decision.rtpDirs).toEqual([])
    expect(decision.source).toBe('ini')
  })

  test('用户给的 RTP 数组优先，且 ~/ 被展开', () => {
    const ctx = makeGame({ ini: '[Game]\r\nRTP=RPGVXace\r\n' })
    ctx.gameArgs = { RTP: ['~/MyRTP/A', '/abs/B'] }
    const decision = resolveRtp(ctx, HOME)
    expect(decision.rtpDirs).toEqual([path.join(HOME, 'MyRTP', 'A'), '/abs/B'])
    // 但 rgssVersion 仍按本地推断（用户只是换了 RTP 位置，没说版本）
    expect(decision.rgssVersion).toBe(3)
  })

  test('用户给的空数组 RTP 不算「给了」（回落到推断）', () => {
    const ctx = makeGame({ ini: '[Game]\r\nRTP=RPGVXace\r\n' })
    ctx.gameArgs = { RTP: [] }
    expect(resolveRtp(ctx, HOME).rtpDirs).toEqual([mkxpzRtpDir(ctx.dataDir, 'RPGVXace')])
  })
})

// ===== mkxp.json 内容 =====

describe('S3：mkxp.json 的内容', () => {
  test('三项必备字段 + 其余原样透传', () => {
    const ctx = makeGame({ ini: '[Game]\r\nRTP=RPGVXace\r\n' })
    ctx.gameArgs = {
      smoothScaling: '2',
      vsync: 'true',
      windowTitle: '我的 游戏',
      fontSub: ['Arial>Open Sans']
    }
    const config = buildMkxpConfig(ctx, HOME)
    expect(config.gameFolder).toBe(ctx.folder)
    expect(config.rgssVersion).toBe(3)
    expect(config.RTP).toEqual([mkxpzRtpDir(ctx.dataDir, 'RPGVXace')])
    // 透传的键被转成真类型
    expect(config.smoothScaling).toBe(2)
    expect(config.vsync).toBe(true)
    expect(config.windowTitle).toBe('我的 游戏')
    expect(config.fontSub).toEqual(['Arial>Open Sans'])
  })

  test('rgssVersion 与 RTP 不会以原样的 form 值透传（由我们算出的值覆盖）', () => {
    const ctx = makeGame({ ini: '[Game]\r\nRTP=RPGVXace\r\n' })
    ctx.gameArgs = { rgssVersion: '3', RTP: ['/someone/else'] }
    const config = buildMkxpConfig(ctx, HOME)
    expect(config.rgssVersion).toBe(3) // 数字，不是字符串 "3"
    expect(config.RTP).toEqual(['/someone/else']) // 用户给的路径被保留
  })

  test('null / undefined 的 gameArgs 项被跳过（不写进 JSON）', () => {
    const ctx = makeGame()
    ctx.gameArgs = { windowTitle: null, iconPath: undefined, vsync: 'true' }
    const config = buildMkxpConfig(ctx, HOME)
    expect('windowTitle' in config).toBe(false)
    expect('iconPath' in config).toBe(false)
    expect(config.vsync).toBe(true)
  })

  test('默认值不写进 JSON 也能工作（mkxp-z 有自己的默认）', () => {
    const ctx = makeGame()
    const config = buildMkxpConfig(ctx, HOME)
    expect(Object.keys(config).sort()).toEqual(['RTP', 'gameFolder', 'rgssVersion'])
  })

  test('游戏目录含中文/空格时原样写进 gameFolder', () => {
    const ctx = makeGame({ folderName: '我的 mkxpz 游戏' })
    expect(buildMkxpConfig(ctx, HOME).gameFolder).toBe(ctx.folder)
    expect(buildMkxpConfig(ctx, HOME).gameFolder).not.toContain('"')
  })

  test('JSON 可序列化且能被解析回来（内容不丢）', () => {
    const ctx = makeGame({ ini: '[Game]\r\nRTP=RPGVXace\r\n' })
    ctx.gameArgs = { vsync: 'true', smoothScaling: '2' }
    const config = buildMkxpConfig(ctx, HOME)
    expect(JSON.parse(JSON.stringify(config))).toEqual(config)
  })
})

// ===== 启动方案 =====

describe('S3：mkxpz 启动方案', () => {
  test('binary 路径 + **空参数数组**（mkxp-z 不接受命令行参数）', () => {
    const ctx = makeGame()
    const plan = mkxpzPlan(ctx, HOME)
    expect(plan.binary).toBe(mkxpzBinaryPath(ctx.dataDir))
    expect(plan.args).toEqual([])
    expect(plan.engine).toBe('mkxpz')
  })

  test('prepare 把 mkxp.json 写到 app 包内的 Contents/Game/（mkxp-z 只读这里）', async () => {
    // 实测（Mac）：这份 Z-Universal 只读 app 包内那份配置，不看 cwd、也不看游戏目录。
    const ctx = makeGame({ ini: '[Game]\r\nRTP=RPGVXace\r\n' })
    await mkxpzPlan(ctx, HOME).prepare?.()

    const file = mkxpzConfigPath(ctx.dataDir)
    expect(fs.existsSync(file)).toBe(true)
    const written = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(written.gameFolder).toBe(ctx.folder)
    expect(written.rgssVersion).toBe(3)
    expect(written.RTP).toEqual([mkxpzRtpDir(ctx.dataDir, 'RPGVXace')])
  })

  test('★ 不往游戏目录里写 mkxp.json（v0.5.2 的错误方向，已回退）', async () => {
    const ctx = makeGame({ ini: '[Game]\r\nRTP=RPGVXace\r\n' })
    await mkxpzPlan(ctx, HOME).prepare?.()
    // Game.ini 可能被修正过（GBK Title），但**不该**出现 mkxp.json
    expect(fs.existsSync(path.join(ctx.folder, 'mkxp.json'))).toBe(false)
  })

  test('中文路径 → gameFolder 写成 ASCII 符号链接（中文会让 mkxp-z 解析失败）', async () => {
    // 实测：中文路径 → "Failed to parse mkxp.json : Unknown encoding" → 回落 RGSS 1 (XP)
    const cnDir = path.join(tempDir(), '傭兵の冒険')
    fs.mkdirSync(cnDir, { recursive: true })
    fs.writeFileSync(path.join(cnDir, 'Game.ini'), '[Game]\r\nRTP=RPGVXace\r\n')

    const ctx = {
      gamePath: cnDir,
      folder: cnDir,
      gameArgs: {},
      gameTitle: 'G',
      dataDir: tempDir('tsmg-cn-data-'),
      platform: 'darwin' as const,
      arch: 'arm64' as const
    }
    await mkxpzPlan(ctx, HOME).prepare?.()

    const written = JSON.parse(fs.readFileSync(mkxpzConfigPath(ctx.dataDir), 'utf8')) as Record<string, unknown>
    const folder = String(written.gameFolder)
    // 写出来的必须全是 ASCII
    expect(/[^\x00-\x7F]/.test(folder)).toBe(false)
    // 且是个能走到的符号链接（readlink 指回中文原目录）
    try {
      expect(path.resolve(fs.readlinkSync(folder))).toBe(path.resolve(cnDir))
    } catch {
      expect.fail(`gameFolder 不是符号链接：${folder}`)
    }
  })

  test('纯 ASCII 路径不建别名（gameFolder 就是真路径）', async () => {
    const asciiDir = path.join(tempDir(), 'plain-game')
    fs.mkdirSync(asciiDir, { recursive: true })
    fs.writeFileSync(path.join(asciiDir, 'Game.ini'), '[Game]\r\nRTP=RPGVXace\r\n')

    const ctx = {
      gamePath: asciiDir,
      folder: asciiDir,
      gameArgs: {},
      gameTitle: 'G',
      dataDir: tempDir('tsmg-ascii-data-'),
      platform: 'darwin' as const,
      arch: 'arm64' as const
    }
    await mkxpzPlan(ctx, HOME).prepare?.()
    const written = JSON.parse(fs.readFileSync(mkxpzConfigPath(ctx.dataDir), 'utf8')) as Record<string, unknown>
    expect(written.gameFolder).toBe(asciiDir)
  })

  test('写盘用 4 空格缩进（用户手改配置文件时能看懂）', () => {
    const dir = tempDir()
    const file = path.join(dir, 'mkxp.json')
    writeMkxpConfig(file, { gameFolder: '/g', RTP: [], rgssVersion: 0 })
    const text = fs.readFileSync(file, 'utf8')
    expect(text).toContain('\n    "gameFolder"')
  })

  test('写盘失败会抛（不能静默拉起一个读不到配置的 mkxp-z）', () => {
    // 让父路径是个文件 → mkdirSync 必失败
    const dir = tempDir()
    const blocker = path.join(dir, 'blocker')
    fs.writeFileSync(blocker, 'x')
    const file = path.join(blocker, 'sub', 'mkxp.json')
    expect(() => writeMkxpConfig(file, { gameFolder: '/g', RTP: [], rgssVersion: 0 })).toThrow()
  })

  test('重复 prepare 幂等（内容一样）', async () => {
    const ctx = makeGame({ ini: '[Game]\r\nRTP=RPGVXace\r\n' })
    const plan = mkxpzPlan(ctx, HOME)
    await plan.prepare?.()
    const first = fs.readFileSync(mkxpzConfigPath(ctx.dataDir), 'utf8')
    await plan.prepare?.()
    expect(fs.readFileSync(mkxpzConfigPath(ctx.dataDir), 'utf8')).toBe(first)
  })

  test('换游戏时同一个 mkxp.json 被覆盖（配置是「每次启动按当前设置重生成」）', async () => {
    // 配置只有一份（在 app 包里），所以换游戏必须覆盖 —— 不能叠加、不能沿用旧值
    const dataDir = tempDir('tsmg-s3-shared-')
    const gameA = path.join(tempDir('tsmg-s3-ga-'), 'A')
    const gameB = path.join(tempDir('tsmg-s3-gb-'), 'B')
    fs.mkdirSync(gameA, { recursive: true })
    fs.mkdirSync(gameB, { recursive: true })
    fs.writeFileSync(path.join(gameA, 'Game.ini'), '[Game]\r\nRTP=RPGVXace\r\n')
    fs.writeFileSync(path.join(gameB, 'Game.ini'), '[Game]\r\nRTP=RPGVX\r\n')

    const base = { gamePath: gameA, gameArgs: {}, gameTitle: 'G', platform: 'darwin' as const, arch: 'arm64' }
    await mkxpzPlan({ ...base, folder: gameA, dataDir }, HOME).prepare?.()
    await mkxpzPlan({ ...base, folder: gameB, dataDir }, HOME).prepare?.()

    const written = JSON.parse(fs.readFileSync(mkxpzConfigPath(dataDir), 'utf8')) as Record<string, unknown>
    expect(written.gameFolder).toBe(gameB)
    expect(written.rgssVersion).toBe(2)
    expect(written.RTP).toEqual([mkxpzRtpDir(dataDir, 'RPGVX')])
  })
})

// ===== 版本 ↔ RTP 目录名的双向映射（一边改了另一边会静默错位）=====

describe('S3：versionOfRtpName 反向映射', () => {
  test('三个规范名都能反查出正确版本', () => {
    expect(versionOfRtpName('Standard')).toBe(1)
    expect(versionOfRtpName('RPGVX')).toBe(2)
    expect(versionOfRtpName('RPGVXace')).toBe(3)
  })

  test('别名与大小写变体也能反查（RPGXP → Standard → 1）', () => {
    expect(versionOfRtpName('RPGXP')).toBe(1)
    expect(versionOfRtpName('standard')).toBe(1)
    expect(versionOfRtpName('RPGVXAce')).toBe(3)
  })

  test('未知名字返回 null（不瞎猜）', () => {
    expect(versionOfRtpName('SomeRtp')).toBeNull()
    expect(versionOfRtpName('')).toBeNull()
  })

  test('正向与反向一致（对每个版本：名字→版本→名字 应回到原值）', () => {
    for (const version of [1, 2, 3] as const) {
      const name = RTP_BY_RGSS_VERSION[version]
      expect(versionOfRtpName(name)).toBe(version)
    }
  })
})


// ===== 指向「别人家目录」的默认值：一律丢掉 =====
//
// 来源（上游 mkxpz/manifest.json 的 gameArgs.default，实测）：preloadScript 与
// midiSoundFont 的默认值写死了**另一套程序的数据目录**。它们会经
// reconcileAndPersistGameArgs 进 gameArgs，再被写进 mkxp.json，于是 mkxp-z 去读
// 一个不存在的路径——而且**不报错**（补丁层不生效 / MIDI 静音），
// 用户只会觉得「这游戏有点怪」，查不出原因。
//
// 规则：**不写死任何名字**。判据是「路径里 /modules/ 之前的那一段，是不是我们自己的
// 数据目录」。不是 → 别人的 → 丢掉。
describe('S3：指向别人家数据目录的默认值被丢掉', () => {
  const DATA = path.join('/Users', 'tester', 'Library', 'Application Support', 'Tsumigeya')
  // 故意用一个和本项目完全无关的目录名：证明判据不是写死某个名字
  const SOMEBODY = path.join('/Users', 'tester', 'Library', 'Application Support', 'SomeOtherApp')

  /** 造一个「别人家数据目录」下的模块内路径。 */
  const otherModulePath = (...rest: string[]): string => path.join(SOMEBODY, 'modules', 'mkxpz', 'deps', ...rest)
  /** 造一个「我们自己数据目录」下的模块内路径（注意必须用 ctx 的实际 dataDir）。 */
  const ownModulePath = (dataDir: string, ...rest: string[]): string =>
    path.join(dataDir, 'modules', 'mkxpz', 'deps', ...rest)

  test('别人家 modules/ 下的路径 → elseWhere', () => {
    expect(pointsElsewhere(otherModulePath('mkxpz', 'a.rb'), DATA)).toBe(true)
  })

  test('我们自己 dataDir 的 modules/ 下 → 不是（真能用，保留）', () => {
    expect(pointsElsewhere(ownModulePath(DATA, 'mkxpz', 'a.rb'), DATA)).toBe(false)
  })

  test('跟 modules 无关的路径一律保留（用户自己填的、系统音源等）', () => {
    expect(pointsElsewhere(path.join(SOMEBODY, 'x.rb'), DATA)).toBe(false)
    expect(pointsElsewhere('/opt/homebrew/share/fonts/a.ttf', DATA)).toBe(false)
    expect(pointsElsewhere(path.join('/Users', 'tester', 'MyStuff', 'preload.rb'), DATA)).toBe(false)
    expect(pointsElsewhere('preload.rb', DATA)).toBe(false)
    expect(pointsElsewhere('sub/a.rb', DATA)).toBe(false)
    expect(pointsElsewhere('', DATA)).toBe(false)
  })

  test('buildMkxpConfig 丢掉别人家的默认值，不写进 mkxp.json', () => {
    const ctx = makeGame()
    ctx.gameArgs = {
      preloadScript: [otherModulePath('kawariki', 'kawariki', 'preload.rb')],
      midiSoundFont: otherModulePath('soundfont', 'gmgsx-plus.sf2'),
      vsync: 'true'
    }
    const config = buildMkxpConfig(ctx, HOME)
    // 两个指向别人家的项整个不出现
    expect('preloadScript' in config).toBe(false)
    expect('midiSoundFont' in config).toBe(false)
    // 无关的配置项照常保留
    expect(config.vsync).toBe(true)
  })

  test('数组项被丢空后整项不写', () => {
    const ctx = makeGame()
    ctx.gameArgs = { rubyLoadpath: [otherModulePath('x.rb')], fontSub: [] }
    const config = buildMkxpConfig(ctx, HOME)
    expect('rubyLoadpath' in config).toBe(false)
    expect('fontSub' in config).toBe(false)
  })

  test('数组里混合 → 只丢别人家那个，自己的保留', () => {
    const ctx = makeGame()
    const mine = ownModulePath(ctx.dataDir, 'mine.rb')
    ctx.gameArgs = { preloadScript: [otherModulePath('theirs.rb'), mine] }
    expect(buildMkxpConfig(ctx, HOME).preloadScript).toEqual([mine])
  })

  test('用户自己填的普通路径不受影响', () => {
    const ctx = makeGame()
    const mine = path.join('/Users', 'tester', 'MyStuff', 'preload.rb')
    ctx.gameArgs = { preloadScript: [mine] }
    expect(buildMkxpConfig(ctx, HOME).preloadScript).toEqual([mine])
  })

  test('反斜杠风格的路径也被认出（判据不依赖分隔符）', () => {
    // Windows 上 path.join 产出反斜杠；这里用 String.fromCharCode 拼，避免源码里的转义麻烦
    const BS = String.fromCharCode(92)
    const ours = ['', 'Users', 'tester', 'Library', 'Application Support', 'Tsumigeya'].join(BS)
    const theirs = ['', 'Users', 'tester', 'Library', 'Application Support', 'SomeOtherApp'].join(BS)
    // 别人家：<theirs>/modules/mkxpz/deps/a.rb  → elsewhere
    expect(pointsElsewhere([theirs, 'modules', 'mkxpz', 'deps', 'a.rb'].join(BS), ours)).toBe(true)
    // 自己家：<ours>/modules/mkxpz/deps/a.rb  → 保留
    expect(pointsElsewhere([ours, 'modules', 'mkxpz', 'deps', 'a.rb'].join(BS), ours)).toBe(false)
  })
  })
