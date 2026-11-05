// M4 S3/S4：存档导出包的判据（src/shared/save-archive.ts）。
//
// ===== 为什么"S3 的导出"要测"S4 的读" =====
//
// 导入端的规矩是「只接受我们导出的包」，依据只有一条：manifest 里的 sha256。
// 所以**算哈希的那一端与验哈希的那一端必须用同一份结构**。
// 分成两个文件各写一半，漂移的表现就是**自己导出的包自己拒收** ——
// 而报错文案只会说"校验不过"，用户和我们都查不出是算法/结构不同。
//
// 这里把两侧都测了，等于把这份契约钉在同一个文件里。
import { describe, expect, test } from 'vitest'
import {
  SAVE_ARCHIVE_EXT,
  SAVE_MANIFEST_PATH,
  archiveFileName,
  archiveTimestamp,
  exportBlocked,
  isSha256Hex,
  parseSaveManifest,
  safeArchiveNamePart,
  verifyManifestFiles,
  type SaveManifest
} from '../src/shared/save-archive'

describe('★ 包名：要能在访达里认出来，且两个游戏不会互相覆盖', () => {
  test('标准形态：tsumigeya-save-<名字>-<YYYYMMDD-HHMM>.zip', () => {
    const at = new Date(2026, 10, 5, 14, 40) // 本地时间 2026-11-05 14:40
    expect(archiveFileName("Karryn's Prison", at)).toBe(`tsumigeya-save-Karryn's-Prison-20261105-1440.zip`)
  })

  test('⚠️ 本地时间不是 UTC（否则包名与访达显示差一天）', () => {
    // 用明确的本地时刻构造：getHours() 读的就是本地时区
    const at = new Date(2026, 0, 1, 0, 5) // 本地 2026-01-01 00:05
    expect(archiveTimestamp(at)).toBe('20260101-0005')
  })

  test('⚠️ 月份是 1 基（忘了 +1 会让 11 月显示成 10 月）', () => {
    expect(archiveTimestamp(new Date(2026, 0, 1, 0, 0))).toBe('20260101-0000')
    expect(archiveTimestamp(new Date(2026, 11, 31, 23, 59))).toBe('20261231-2359')
  })

  test('时分补零（9 点 5 分要写成 0905 而不是 95）', () => {
    expect(archiveTimestamp(new Date(2026, 5, 1, 9, 5))).toBe('20260601-0905')
  })

  test('扩展名固定是 .zip（mac 上双击就能看内容）', () => {
    expect(SAVE_ARCHIVE_EXT).toBe('.zip')
  })
})

describe('safeArchiveNamePart：文件系统非法字符必须洗掉', () => {
  test('Windows 的保留字符全换下划线（`:` 会让创建文件直接失败）', () => {
    expect(safeArchiveNamePart('a:b')).toBe('a_b')
    expect(safeArchiveNamePart('a/b')).toBe('a_b')
    expect(safeArchiveNamePart('a\\b')).toBe('a_b')
    expect(safeArchiveNamePart('a*b?c"d<e>f|g')).toBe('a_b_c_d_e_f_g')
  })

  test('空白折成连字符（包名常被贴进命令行/聊天框，空格会被截断）', () => {
    expect(safeArchiveNamePart('Karryn s  Prison')).toBe('Karryn-s-Prison')
  })

  test('连续的分隔符压缩（a__-_-b 是噪音）', () => {
    expect(safeArchiveNamePart('a__-_-b')).toBe('a-b')
  })

  test('首尾的连字符/下划线/点去掉（点开头在某些工具里行为诡异）', () => {
    expect(safeArchiveNamePart('...a...')).toBe('a')
    expect(safeArchiveNamePart('--a--')).toBe('a')
  })

  test('控制字符直接去掉（连替换的价值都没有）', () => {
    expect(safeArchiveNamePart('a\u0000b\u001fc')).toBe('abc')
  })

  test('⚠️ 中文保留（用户的游戏名大多是中文，洗成拼音反而认不出来）', () => {
    expect(safeArchiveNamePart('艾妮希雅与契约纹')).toBe('艾妮希雅与契约纹')
  })

  test('过长的截断到 60 字符（访达里能看全，各平台都接受）', () => {
    const long = 'a'.repeat(100)
    expect(safeArchiveNamePart(long)).toHaveLength(60)
  })

  test('洗完是空 / 非字符串 → game（不能生成 tsumigeya-save--2026.zip 这种）', () => {
    expect(safeArchiveNamePart('')).toBe('game')
    expect(safeArchiveNamePart(null)).toBe('game')
    expect(safeArchiveNamePart(undefined)).toBe('game')
    expect(safeArchiveNamePart('---')).toBe('game')
  })

  test('两个不同的游戏标题不会洗成同一个（否则包会互相覆盖）', () => {
    const a = safeArchiveNamePart('甲/乙')
    const b = safeArchiveNamePart('甲 乙')
    expect(a).not.toBe(b)
  })
})

describe('★ exportBlocked：运行中禁止导出（S3 的硬要求）', () => {
  test('运行中 → running（导出的包会是半截文件）', () => {
    expect(exportBlocked({ running: true, hasLocation: true, empty: false })).toEqual({ kind: 'running' })
  })

  test('⚠️ 运行中优先于"找不到位置"（否则用户会去查目录而不是去关游戏）', () => {
    expect(exportBlocked({ running: true, hasLocation: false, empty: false })).toEqual({ kind: 'running' })
  })

  test('没位置 → noLocation', () => {
    expect(exportBlocked({ running: false, hasLocation: false, empty: false })).toEqual({ kind: 'noLocation' })
  })

  test('位置在但没存档 → empty（不是"打包成功但包里空着"）', () => {
    expect(exportBlocked({ running: false, hasLocation: true, empty: true })).toEqual({ kind: 'empty' })
  })

  test('都没问题 → null（可以导）', () => {
    expect(exportBlocked({ running: false, hasLocation: true, empty: false })).toBeNull()
  })
})

describe('isSha256Hex：哈希格式必须严格', () => {
  const valid = 'a'.repeat(64)

  test('64 位小写十六进制 → true', () => {
    expect(isSha256Hex(valid)).toBe(true)
    expect(isSha256Hex('0123456789abcdef'.repeat(4))).toBe(true)
  })

  test('大写 / 位数不对 / 非十六进制 / 非字符串 → false', () => {
    // ⚠️ 大写也拒：主进程算出来是小写，比较时区分大小写最省事（不必归一化）
    expect(isSha256Hex(valid.toUpperCase())).toBe(false)
    expect(isSha256Hex('a'.repeat(63))).toBe(false)
    expect(isSha256Hex('a'.repeat(65))).toBe(false)
    expect(isSha256Hex('z'.repeat(64))).toBe(false)
    expect(isSha256Hex(123)).toBe(false)
    expect(isSha256Hex(null)).toBe(false)
  })
})

describe('parseSaveManifest：只接受完整的包（缺字段就拒，不去猜）', () => {
  const good: SaveManifest = {
    gameTitle: 'Karryn',
    engine: 'nwjs',
    layout: 'nwjs-mv',
    exportedAt: '2026-11-05T06:40:00.000Z',
    files: [{ name: 'file1.rpgsave', sha256: 'b'.repeat(64) }]
  }

  test('完整 → 原样返回', () => {
    expect(parseSaveManifest(good)).toEqual(good)
  })

  test('文件列表可以是空（目录里只有配置文件时仍要能导）', () => {
    expect(parseSaveManifest({ ...good, files: [] })).toMatchObject({ files: [] })
  })

  test.each([
    ['缺 gameTitle', { ...good, gameTitle: undefined }],
    ['缺 engine', { ...good, engine: undefined }],
    ['缺 layout', { ...good, layout: undefined }],
    ['缺 exportedAt', { ...good, exportedAt: undefined }],
    ['files 不是数组', { ...good, files: 'nope' }],
    ['files 项缺 name', { ...good, files: [{ sha256: 'b'.repeat(64) }] }],
    ['files 项 name 是空串', { ...good, files: [{ name: '', sha256: 'b'.repeat(64) }] }],
    ['files 项 sha256 不是 64 位', { ...good, files: [{ name: 'x', sha256: 'abc' }] }]
  ])('%s → null（拒绝，不猜）', (_label, raw) => {
    expect(parseSaveManifest(raw)).toBeNull()
  })

  test('不是对象 → null', () => {
    expect(parseSaveManifest(null)).toBeNull()
    expect(parseSaveManifest('nope')).toBeNull()
    expect(parseSaveManifest(42)).toBeNull()
  })

  test('多带字段不拒绝（将来的版本加字段时旧版本仍能读）', () => {
    const withExtra = { ...good, manifestVersion: 2, note: 'x' }
    expect(parseSaveManifest(withExtra)).toMatchObject({ gameTitle: 'Karryn' })
  })
})

describe('★ verifyManifestFiles：三种不一致都要拒', () => {
  const manifest: SaveManifest = {
    gameTitle: 'Karryn',
    engine: 'nwjs',
    layout: 'nwjs-mv',
    exportedAt: '2026-11-05T06:40:00.000Z',
    files: [
      { name: 'file1.rpgsave', sha256: 'a'.repeat(64) },
      { name: 'config.rpgsave', sha256: 'b'.repeat(64) }
    ]
  }

  test('完全一致 → 三个空数组', () => {
    expect(verifyManifestFiles(manifest, manifest.files)).toEqual({ missing: [], extra: [], mismatch: [] })
  })

  test('包内少一个 → missing', () => {
    expect(verifyManifestFiles(manifest, [manifest.files[0]!])).toEqual({
      missing: ['config.rpgsave'],
      extra: [],
      mismatch: []
    })
  })

  test('⚠️ 名字对上但内容变了 → mismatch（这才是"存档被改过"的那一条）', () => {
    expect(
      verifyManifestFiles(manifest, [
        { name: 'file1.rpgsave', sha256: 'c'.repeat(64) },
        manifest.files[1]!
      ])
    ).toEqual({ missing: [], extra: [], mismatch: ['file1.rpgsave'] })
  })

  test('⚠️ 包内多一个 → extra 也要拒（只查"都在"等于给同名不同路径留后门）', () => {
    expect(verifyManifestFiles(manifest, [...manifest.files, { name: 'evil.rpgsave', sha256: 'd'.repeat(64) }])).toEqual(
      { missing: [], extra: ['evil.rpgsave'], mismatch: [] }
    )
  })

  test('三种同时出现时都报（方便一次性排障）', () => {
    const result = verifyManifestFiles(manifest, [{ name: 'evil.rpgsave', sha256: 'd'.repeat(64) }])
    expect(result.missing.sort()).toEqual(['config.rpgsave', 'file1.rpgsave'])
    expect(result.extra).toEqual(['evil.rpgsave'])
  })
})

describe('路径常量与导出端一致（S3 写、S4 读同一份）', () => {
  test('manifest 在包根目录，存档在 saves/ 下', () => {
    // 改了这两个常量就等于换了包格式 —— 旧包会读不出来。
    // S3/S4 都从这里取，不许各自写字面量。
    expect(SAVE_MANIFEST_PATH).toBe('manifest.json')
    expect(SAVE_MANIFEST_PATH).not.toContain('/')
  })
})
