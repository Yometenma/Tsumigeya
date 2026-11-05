// 系统噪音文件的判据（Mac 真机实测时顺带发现的一处健壮性缺口）。
//
// ===== 这条防什么 =====
//
// macOS 会为每个文件生成 `._<name>` 的 AppleDouble 伴生文件（资源分叉镜像）。
// 而**不是**每次都看得见 —— 本鱼实测过：真机存档目录里 `readdirSync` 不返回它们
// （那些是 tar/zip 在传输途中生成的）。所以这是**防御性**判据，不是当前故障。
//
// 但它一旦出现，会同时污染两处，而且**都不报错**：
//
//  ① 存档列表：MV 的槽判据是「任意 .rpgsave 但排除 config/global」，
//     所以 `._file1.rpgsave` **会命中槽判据** → 列表里多一个幽灵存档
//     （点「在访达中显示」指向 163 字节的元数据镜像，用户完全没法理解）。
//  ② 导出包：整个目录打包会把它们带进去 → 包体积翻倍（114KB 存档 → 229KB），
//     而且跨到别的机器就是垃圾数据。
//
// 判据只能是「点开头」，**绝不能按扩展名白名单收窄** ——
// 那是 D81 明确拒绝的做法（插件写的 `lastsave.autobak` / `sync_data.rpgsave`
// 会被漏掉，用户换机后少东西而他不会怀疑"包少了东西"）。
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { classifySaveEntries, detectSaveLocation } from '../src/shared/save-locate'
import { isNoiseFile } from '../src/shared/save-archive'
import {
  exportSaveArchive,
  importSaveArchive
} from '../src/main/save-archive-io'

const dir = (entries: string[]) => ({ entries, isDir: true })

describe('★ isNoiseFile：点开头的都不是存档内容', () => {
  test('AppleDouble 伴生文件被认出', () => {
    expect(isNoiseFile('._file1.rpgsave')).toBe(true)
    expect(isNoiseFile('._config.rpgsave')).toBe(true)
    expect(isNoiseFile('._lastsave.autobak')).toBe(true)
  })

  test('.DS_Store 被认出', () => {
    expect(isNoiseFile('.DS_Store')).toBe(true)
  })

  test('★ 真正的存档数据一条都不许被误排（D81 的底线）', () => {
    // 这几个都是用户真机上**确实存在**的存档数据：
    //   file1.rpgsave       ← 存档槽
    //   config.rpgsave      ← 配置
    //   lastsave.autobak    ← 游戏插件写的「上次存档备份」
    //   sync_data.rpgsave   ← 游戏自己的同步数据
    // 按扩展名白名单收窄就会漏掉后两个 —— 那正是"换机少东西"的成因。
    for (const name of [
      'file1.rpgsave',
      'file2.rmmzsave',
      'config.rpgsave',
      'global.rpgsave',
      'lastsave.autobak',
      'sync_data.rpgsave',
      // 中文文件名也是正常数据（不能被点判据以外的任何规则误伤）
      '机场推荐.txt',
      '存档说明.md'
    ]) {
      expect(isNoiseFile(name), `${name} 被误判成噪音了`).toBe(false)
    }
  })
})

describe('★ 存档列表不许出现幽灵存档（._* 会命中 MV 的槽判据）', () => {
  test('MV 布局：._file1.rpgsave 被跳过，正常的都在', () => {
    const loc = detectSaveLocation({ engine: 'nwjs', wwwSave: dir(['file1.rpgsave']) })!
    const { slots, configs } = classifySaveEntries(
      [
        'file1.rpgsave',
        'file2.rpgsave',
        'config.rpgsave',
        // 下面两个是 AppleDouble 镜像：不跳过的话会出现在列表里
        '._file1.rpgsave',
        '._config.rpgsave',
        '.DS_Store'
      ],
      loc
    )
    expect(slots).toEqual(['file1.rpgsave', 'file2.rpgsave'])
    expect(configs).toEqual(['config.rpgsave'])
  })

  test('苍蓝星那种 save/ 布局同样跳过（4 种真机形态的第 4 种）', () => {
    const loc = detectSaveLocation({
      engine: 'nwjs',
      gameSave: dir(['file1.rpgsave', 'config.rpgsave'])
    })!
    const { slots } = classifySaveEntries(
      ['file1.rpgsave', 'config.rpgsave', '._file1.rpgsave', '机场推荐.txt'],
      loc
    )
    expect(slots).toEqual(['file1.rpgsave'])
  })
})

describe('★ 导出包不许带系统噪音（真写盘）', () => {
  const ROOT = path.join(process.cwd(), '.dev-noise-archive')
  const SAVE = path.join(ROOT, 'www', 'save')
  const OUT = path.join(ROOT, 'out')

  test('导出整目录时跳过 ._* 与 .DS_Store，但保留 lastsave.autobak', () => {
    fs.rmSync(ROOT, { recursive: true, force: true })
    fs.mkdirSync(SAVE, { recursive: true })

    // 真机上的 5 个文件 + 2 个噪音
    fs.writeFileSync(path.join(SAVE, 'file1.rpgsave'), 'SLOT')
    fs.writeFileSync(path.join(SAVE, 'config.rpgsave'), 'CONFIG')
    fs.writeFileSync(path.join(SAVE, 'lastsave.autobak'), 'PLUGIN-AUTOBAK')
    fs.writeFileSync(path.join(SAVE, 'sync_data.rpgsave'), 'PLUGIN-SYNC')
    fs.writeFileSync(path.join(SAVE, '._file1.rpgsave'), 'APPLEDOUBLE')
    fs.writeFileSync(path.join(SAVE, '.DS_Store'), 'DSSTORE')

    const result = exportSaveArchive({
      sourceDir: SAVE,
      gameTitle: 'Noise Test',
      engine: 'nwjs',
      layout: 'nwjs-mv',
      outDir: OUT
    })

    const names = result.manifest.files.map((f) => f.name)
    expect(names, `导出包里混进了噪音：${names.join(', ')}`).not.toContain('._file1.rpgsave')
    expect(names).not.toContain('.DS_Store')
    // 插件写的两个必须在（D81）
    expect(names).toContain('lastsave.autobak')
    expect(names).toContain('sync_data.rpgsave')
    expect(result.fileCount).toBe(4)

    // 导入回来也不该凭空多出噪音
    const target = path.join(ROOT, 'restored')
    fs.mkdirSync(target, { recursive: true })
    const imported = importSaveArchive({ file: result.file, targetDir: target })
    const restored = fs.readdirSync(target)
    expect(restored.sort()).toEqual(
      ['config.rpgsave', 'file1.rpgsave', 'lastsave.autobak', 'sync_data.rpgsave'].sort()
    )
    expect(imported.fileCount).toBe(4)

    fs.rmSync(ROOT, { recursive: true, force: true })
  })
})
