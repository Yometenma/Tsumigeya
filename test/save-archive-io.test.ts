// M4 S3/S4：存档导出与导入的**端到端**测试（读写真盘，不 mock fs）。
//
// ===== 为什么这些必须读写真盘 =====
//
// 这一条的失败面全是"看起来成功"：
//   · 导出：对着空目录成功返回一个空 zip（用户以为备份了，其实什么都没带）
//   · 导出漏文件：只打 file*.rpgsave，插件写的 lastsave.autobak 没进去
//     → 用户换机后游戏行为不一致，而他不会怀疑"包少了东西"
//   · 导入：sha256 校验不过却照样写（那就是拿用户的存档冒险）
//   · 导入：先写后备份（断电时剩下半新半旧，既不能玩也不能回退）
//
// 这些用 mock 都测不出来 —— mock 永远"成功"。所以真建临时目录、真写 zip。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { zipSync, unzipSync } from 'fflate'
import {
  defaultExportDir,
  exportSaveArchive,
  importSaveArchive,
  readSaveArchive,
  sha256Hex
} from '../src/main/save-archive-io'
import { SAVE_FILES_PREFIX, SAVE_MANIFEST_PATH, archiveFileName } from '../src/shared/save-archive'

let root: string
let saveDir: string
let outDir: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-savearch-'))
  saveDir = path.join(root, 'www', 'save')
  outDir = path.join(root, 'out')
  fs.mkdirSync(saveDir, { recursive: true })
  fs.mkdirSync(outDir, { recursive: true })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

/** 造用户真机上的那套文件（Karryn's Prison 实测：槽 + 配置 + 插件文件）。 */
function writeRealisticSaves(): void {
  fs.writeFileSync(path.join(saveDir, 'file1.rpgsave'), 'PK-A') // 假内容，只验字节搬运
  fs.writeFileSync(path.join(saveDir, 'file2.rpgsave'), 'PK-B')
  fs.writeFileSync(path.join(saveDir, 'config.rpgsave'), 'CFG')
  fs.writeFileSync(path.join(saveDir, 'global.rpgsave'), 'GLB')
  // ⚠️ 这两个是关键：**插件写的文件**，只打工况就会漏
  fs.writeFileSync(path.join(saveDir, 'lastsave.autobak'), 'AUTObak')
  fs.writeFileSync(path.join(saveDir, 'sync_data.rpgsave'), 'SYNC')
}

const at = new Date(2026, 10, 5, 14, 40)

describe('★ 导出：整个目录都要带走（含插件文件）', () => {
  test('「只打槽」会让用户换机后少东西 —— 这里必须 6 个文件全在', () => {
    writeRealisticSaves()
    const result = exportSaveArchive({
      sourceDir: saveDir,
      gameTitle: "Karryn's Prison",
      engine: 'nwjs',
      layout: 'nwjs-mv',
      outDir,
      at
    })
    expect(result.fileCount).toBe(6)
    const names = result.manifest.files.map((file) => file.name).sort()
    expect(names).toEqual(
      ['config.rpgsave', 'file1.rpgsave', 'file2.rpgsave', 'global.rpgsave', 'lastsave.autobak', 'sync_data.rpgsave'].sort()
    )
  })

  test('包内结构：manifest.json 在根，文件在 saves/ 下', () => {
    writeRealisticSaves()
    const result = exportSaveArchive({
      sourceDir: saveDir,
      gameTitle: 'Karryn',
      engine: 'nwjs',
      layout: 'nwjs-mv',
      outDir,
      at
    })
    const entries = Object.keys(unzipSync(fs.readFileSync(result.file))).sort()
    expect(entries).toContain(SAVE_MANIFEST_PATH)
    expect(entries).toContain(`${SAVE_FILES_PREFIX}file1.rpgsave`)
    expect(entries).toContain(`${SAVE_FILES_PREFIX}lastsave.autobak`)
    // manifest 不能在 saves/ 里（导入端按"根目录的 manifest"认）
    expect(entries).not.toContain(`${SAVE_FILES_PREFIX}manifest.json`)
  })

  test('⚠️ 原始文件一个字节不改（原样搬，不解析不加工）', () => {
    writeRealisticSaves()
    const result = exportSaveArchive({
      sourceDir: saveDir,
      gameTitle: 'Karryn',
      engine: 'nwjs',
      layout: 'nwjs-mv',
      outDir,
      at
    })
    const entries = unzipSync(fs.readFileSync(result.file))
    const got = new TextDecoder().decode(entries[`${SAVE_FILES_PREFIX}file1.rpgsave`]!)
    expect(got).toBe('PK-A')
    // sha256 与源文件一致（证明搬运没动内容）
    expect(result.manifest.files.find((f) => f.name === 'file1.rpgsave')!.sha256).toBe(
      sha256Hex(fs.readFileSync(path.join(saveDir, 'file1.rpgsave')))
    )
  })

  test('包名与内容时间戳跟着 at（测试可复现）', () => {
    writeRealisticSaves()
    const result = exportSaveArchive({
      sourceDir: saveDir,
      gameTitle: '艾妮希雅',
      engine: 'nwjs',
      layout: 'nwjs-mz',
      outDir,
      at
    })
    expect(path.basename(result.file)).toBe(archiveFileName('艾妮希雅', at))
    expect(path.basename(result.file)).toBe('tsumigeya-save-艾妮希雅-20261105-1440.zip')
    expect(fs.existsSync(result.file)).toBe(true)
  })

  test('空目录也能导出（用户可能只有配置文件）', () => {
    const result = exportSaveArchive({
      sourceDir: saveDir,
      gameTitle: 'Empty',
      engine: 'nwjs',
      layout: 'nwjs-mv',
      outDir,
      at
    })
    expect(result.fileCount).toBe(0)
    expect(result.manifest.files).toEqual([])
  })

  test('子目录不打包（存档目录是平铺的；硬塞子目录会让导入端塌名字）', () => {
    writeRealisticSaves()
    fs.mkdirSync(path.join(saveDir, 'nested'), { recursive: true })
    fs.writeFileSync(path.join(saveDir, 'nested', 'x.rpgsave'), 'NESTED')
    const result = exportSaveArchive({
      sourceDir: saveDir,
      gameTitle: 'Karryn',
      engine: 'nwjs',
      layout: 'nwjs-mv',
      outDir,
      at
    })
    expect(result.fileCount).toBe(6) // 还是 6，nested 不进去
    expect(result.manifest.files.map((f) => f.name)).not.toContain('nested/x.rpgsave')
  })
})

describe('★ 读包：只接受我们导出的（sha256 全对上）', () => {
  test('正常包 → ok，manifest 与文件都在', () => {
    writeRealisticSaves()
    const exported = exportSaveArchive({
      sourceDir: saveDir,
      gameTitle: 'Karryn',
      engine: 'nwjs',
      layout: 'nwjs-mv',
      outDir,
      at
    })
    const read = readSaveArchive(exported.file)
    expect(read.ok).toBe(true)
    if (read.ok) {
      expect(read.manifest.gameTitle).toBe('Karryn')
      expect(read.files.size).toBe(6)
    }
  })

  test('不是 zip → notZip', () => {
    const file = path.join(root, 'nope.zip')
    fs.writeFileSync(file, 'this is not a zip')
    expect(readSaveArchive(file)).toMatchObject({ ok: false, reason: 'notZip' })
  })

  test('文件不存在 → notZip（不抛错，给可判断的结果）', () => {
    expect(readSaveArchive(path.join(root, 'missing.zip'))).toMatchObject({ ok: false, reason: 'notZip' })
  })

  test('普通 zip（没有 manifest）→ noManifest', () => {
    const file = path.join(root, 'plain.zip')
    fs.writeFileSync(file, zipSync({ 'other.txt': new TextEncoder().encode('x') }))
    expect(readSaveArchive(file)).toMatchObject({ ok: false, reason: 'noManifest' })
  })

  test('manifest 格式坏 → badManifest', () => {
    const file = path.join(root, 'bad.zip')
    fs.writeFileSync(
      file,
      zipSync({ [SAVE_MANIFEST_PATH]: new TextEncoder().encode('{"gameTitle":42}') })
    )
    expect(readSaveArchive(file)).toMatchObject({ ok: false, reason: 'badManifest' })
  })

  test('manifest 不是 JSON → badManifest（不崩）', () => {
    const file = path.join(root, 'bad2.zip')
    fs.writeFileSync(file, zipSync({ [SAVE_MANIFEST_PATH]: new TextEncoder().encode('not json at all') }))
    expect(readSaveArchive(file)).toMatchObject({ ok: false, reason: 'badManifest' })
  })

  test('⚠️ 文件内容被改过 → verifyFailed（这才是"包被改过"）', () => {
    writeRealisticSaves()
    const exported = exportSaveArchive({
      sourceDir: saveDir,
      gameTitle: 'Karryn',
      engine: 'nwjs',
      layout: 'nwjs-mv',
      outDir,
      at
    })
    // 用导出的 manifest + 一个被改过的文件重造一个包
    const entries = unzipSync(fs.readFileSync(exported.file))
    entries[`${SAVE_FILES_PREFIX}file1.rpgsave`] = new TextEncoder().encode('TAMPERED')
    const tampered = path.join(root, 'tampered.zip')
    fs.writeFileSync(tampered, zipSync(entries))
    expect(readSaveArchive(tampered)).toMatchObject({ ok: false, reason: 'verifyFailed' })
  })

  test('⚠️ 包里多一个文件 → verifyFailed（extra 也拒）', () => {
    writeRealisticSaves()
    const exported = exportSaveArchive({
      sourceDir: saveDir,
      gameTitle: 'Karryn',
      engine: 'nwjs',
      layout: 'nwjs-mv',
      outDir,
      at
    })
    const entries = unzipSync(fs.readFileSync(exported.file))
    entries[`${SAVE_FILES_PREFIX}evil.rpgsave`] = new TextEncoder().encode('EVIL')
    const extra = path.join(root, 'extra.zip')
    fs.writeFileSync(extra, zipSync(entries))
    expect(readSaveArchive(extra)).toMatchObject({ ok: false, reason: 'verifyFailed' })
  })

  test('⚠️ 包里少了文件 → verifyFailed', () => {
    writeRealisticSaves()
    const exported = exportSaveArchive({
      sourceDir: saveDir,
      gameTitle: 'Karryn',
      engine: 'nwjs',
      layout: 'nwjs-mv',
      outDir,
      at
    })
    const entries = unzipSync(fs.readFileSync(exported.file))
    delete entries[`${SAVE_FILES_PREFIX}file2.rpgsave`]
    const missing = path.join(root, 'missing.zip')
    fs.writeFileSync(missing, zipSync(entries))
    expect(readSaveArchive(missing)).toMatchObject({ ok: false, reason: 'verifyFailed' })
  })

  test('包内有 saves/ 下的子目录文件 → verifyFailed（同名不同路径的后门）', () => {
    const manifest = {
      gameTitle: 'K',
      engine: 'nwjs',
      layout: 'nwjs-mv',
      exportedAt: at.toISOString(),
      files: [{ name: 'file1.rpgsave', sha256: 'a'.repeat(64) }]
    }
    const file = path.join(root, 'nested.zip')
    fs.writeFileSync(
      file,
      zipSync({
        [SAVE_MANIFEST_PATH]: new TextEncoder().encode(JSON.stringify(manifest)),
        [`${SAVE_FILES_PREFIX}a/file1.rpgsave`]: new TextEncoder().encode('x')
      })
    )
    expect(readSaveArchive(file)).toMatchObject({ ok: false, reason: 'verifyFailed' })
  })
})

describe('★ 导入：先校验 → 再备份 → 才写', () => {
  test('正常导入把文件还原（字节一致）', () => {
    writeRealisticSaves()
    const exported = exportSaveArchive({
      sourceDir: saveDir,
      gameTitle: 'Karryn',
      engine: 'nwjs',
      layout: 'nwjs-mv',
      outDir,
      at
    })
    // 模拟换机：目标是一个新目录
    const target = path.join(root, 'newmachine', 'www', 'save')
    const result = importSaveArchive({ file: exported.file, targetDir: target })
    expect(result.fileCount).toBe(6)
    expect(result.backups).toEqual([]) // 目标空着 → 没覆盖任何东西
    expect(fs.readFileSync(path.join(target, 'file1.rpgsave'), 'utf8')).toBe('PK-A')
    expect(fs.readFileSync(path.join(target, 'lastsave.autobak'), 'utf8')).toBe('AUTObak')
  })

  test('⚠️ 覆盖现有文件前先加 .tsumigeya-bak（用户想回退时找得到）', () => {
    writeRealisticSaves()
    const exported = exportSaveArchive({
      sourceDir: saveDir,
      gameTitle: 'Karryn',
      engine: 'nwjs',
      layout: 'nwjs-mv',
      outDir,
      at
    })
    // 目标目录里已有不同内容的同名牌（模拟"我玩了一会儿，现在想换回旧档"）
    const target = path.join(root, 'target')
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'file1.rpgsave'), 'CURRENT-1')
    fs.writeFileSync(path.join(target, 'config.rpgsave'), 'CURRENT-CFG')

    const result = importSaveArchive({ file: exported.file, targetDir: target })
    expect(result.backups.sort()).toEqual(['config.rpgsave.tsumigeya-bak', 'file1.rpgsave.tsumigeya-bak'])
    // 备份里是**导入前**的内容
    expect(fs.readFileSync(path.join(target, 'file1.rpgsave.tsumigeya-bak'), 'utf8')).toBe('CURRENT-1')
    // 主文件换成了包里的
    expect(fs.readFileSync(path.join(target, 'file1.rpgsave'), 'utf8')).toBe('PK-A')
  })

  test('⚠️ 备份幂等：第二次导入不覆盖第一次留下的备份（否则退路丢了）', () => {
    writeRealisticSaves()
    const exported = exportSaveArchive({
      sourceDir: saveDir,
      gameTitle: 'Karryn',
      engine: 'nwjs',
      layout: 'nwjs-mv',
      outDir,
      at
    })
    const target = path.join(root, 'target')
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'file1.rpgsave'), 'ORIGINAL')

    importSaveArchive({ file: exported.file, targetDir: target })
    // 第二次：此时主文件是包里的 PK-A。**已有备份的项必须跳过**（否则 ORIGINAL 会被
    // 覆盖成 PK-A —— 退路就丢了）。其它项（第一次导入时才新建、本来没备份）照常备一份。
    const second = importSaveArchive({ file: exported.file, targetDir: target })
    expect(second.backups).not.toContain('file1.rpgsave.tsumigeya-bak')
    expect(fs.readFileSync(path.join(target, 'file1.rpgsave.tsumigeya-bak'), 'utf8')).toBe('ORIGINAL')
  })

  test('⚠️ 校验不过 → 一个字节都不写（含已有文件、含新建）', () => {
    writeRealisticSaves()
    const exported = exportSaveArchive({
      sourceDir: saveDir,
      gameTitle: 'Karryn',
      engine: 'nwjs',
      layout: 'nwjs-mv',
      outDir,
      at
    })
    const entries = unzipSync(fs.readFileSync(exported.file))
    entries[`${SAVE_FILES_PREFIX}file1.rpgsave`] = new TextEncoder().encode('TAMPERED')
    const tampered = path.join(root, 'tampered.zip')
    fs.writeFileSync(tampered, zipSync(entries))

    const target = path.join(root, 'target')
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(target, 'file1.rpgsave'), 'EXISTING')

    expect(() => importSaveArchive({ file: tampered, targetDir: target })).toThrow()
    // 关键三条：原文件没变、没有备份生成、包里的其它文件没被写进来
    expect(fs.readFileSync(path.join(target, 'file1.rpgsave'), 'utf8')).toBe('EXISTING')
    expect(fs.existsSync(path.join(target, 'file1.rpgsave.tsumigeya-bak'))).toBe(false)
    expect(fs.existsSync(path.join(target, 'file2.rpgsave'))).toBe(false)
  })

  test('校验失败的错误带可翻译的键（渲染层能出中文）', () => {
    writeRealisticSaves()
    const exported = exportSaveArchive({
      sourceDir: saveDir,
      gameTitle: 'Karryn',
      engine: 'nwjs',
      layout: 'nwjs-mv',
      outDir,
      at
    })
    const entries = unzipSync(fs.readFileSync(exported.file))
    entries[`${SAVE_FILES_PREFIX}file1.rpgsave`] = new TextEncoder().encode('TAMPERED')
    const tampered = path.join(root, 'tampered.zip')
    fs.writeFileSync(tampered, zipSync(entries))

    try {
      importSaveArchive({ file: tampered, targetDir: path.join(root, 't') })
      throw new Error('应当抛错')
    } catch (error) {
      expect((error as { translationKey?: string }).translationKey).toBe('error.saveArchiveVerifyFailed')
    }
  })

  test('⚠️ 不删目标目录里包内没有的文件（那是用户的存档，不可逆）', () => {
    writeRealisticSaves()
    const exported = exportSaveArchive({
      sourceDir: saveDir,
      gameTitle: 'Karryn',
      engine: 'nwjs',
      layout: 'nwjs-mv',
      outDir,
      at
    })
    const target = path.join(root, 'target')
    fs.mkdirSync(target, { recursive: true })
    // 用户后来新存的第 3 号档：包里没有，导入不该删掉
    fs.writeFileSync(path.join(target, 'file3.rpgsave'), 'NEWER')

    importSaveArchive({ file: exported.file, targetDir: target })
    expect(fs.existsSync(path.join(target, 'file3.rpgsave'))).toBe(true)
    expect(fs.readFileSync(path.join(target, 'file3.rpgsave'), 'utf8')).toBe('NEWER')
  })

  test('目标目录不存在 → 建出来（换机后存档目录本来就没有）', () => {
    writeRealisticSaves()
    const exported = exportSaveArchive({
      sourceDir: saveDir,
      gameTitle: 'Karryn',
      engine: 'nwjs',
      layout: 'nwjs-mv',
      outDir,
      at
    })
    const target = path.join(root, 'brand', 'new', 'dir')
    const result = importSaveArchive({ file: exported.file, targetDir: target })
    expect(result.dir).toBe(target)
    expect(fs.existsSync(path.join(target, 'file1.rpgsave'))).toBe(true)
  })
})

describe('导出→导入往返：字节完全一致（这一条是整条链的验收）', () => {
  test('导出再导入到空目录，所有文件内容与原始一模一样', () => {
    writeRealisticSaves()
    const exported = exportSaveArchive({
      sourceDir: saveDir,
      gameTitle: 'Karryn',
      engine: 'nwjs',
      layout: 'nwjs-mv',
      outDir,
      at
    })
    const target = path.join(root, 'roundtrip')
    importSaveArchive({ file: exported.file, targetDir: target })

    for (const name of fs.readdirSync(saveDir)) {
      expect(fs.readFileSync(path.join(target, name))).toEqual(fs.readFileSync(path.join(saveDir, name)))
    }
  })
})

describe('defaultExportDir：导出是为了带走，不能落在数据目录', () => {
  test('有 Downloads 就用它', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-home-'))
    fs.mkdirSync(path.join(home, 'Downloads'))
    expect(defaultExportDir(home)).toBe(path.join(home, 'Downloads'))
    fs.rmSync(home, { recursive: true, force: true })
  })

  test('没有 Downloads → 退回临时目录（不让导出直接失败）', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-home2-'))
    expect(defaultExportDir(home)).toBe(os.tmpdir())
    fs.rmSync(home, { recursive: true, force: true })
  })
})
