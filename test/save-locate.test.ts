// M4 S1：存档位置探测的判据。
//
// 这些测试是照着**用户 Mac 上的真实目录结构**写的（2026-11-05 实测）：
//   Karryn's Prison（MV） → www/save/  + .rpgsave（main = www/index.html）
//   艾妮希雅（MZ）        → save/      + .rmmzsave
//   傭兵の冒険（MKXP-Z）  → Data/ 存在但还没有存档
//   苍蓝星（MV）          → www/save/（**用户还没存过档，所以目录还不存在**）
//                           ⚠️ 它的根 `save/` 里有 5 个 2022 年的 .rpgsave ——
//                           那是**作者打包时塞进去的残留**，不是用户的档。
//                           本鱼曾把它当成"MV 也可能放根 save"的证据，被用户当场纠正。
//                           见下方「作者塞进包里的残留存档」那条回归。
//
// 判据错了**不会报错**：列表空着，用户只会以为「我没存过档」；
// 更糟的是**列出别人的旧档**——那会让用户以为自己的档丢了。

import { describe, expect, test } from 'vitest'
import { classifySaveEntries, detectSaveLocation, naturalCompare } from '../src/shared/save-locate'

const dir = (entries: string[]) => ({ entries, isDir: true })
const missing = null

describe('nwjs：同一引擎两种布局（最容易踩的一条）', () => {
  test('MV 布局：www/save/ + file1.rpgsave → nwjs-mv', () => {
    const loc = detectSaveLocation({
      engine: 'nwjs',
      wwwSave: dir(['file1.rpgsave', 'config.rpgsave', 'global.rpgsave'])
    })
    expect(loc).toMatchObject({ layout: 'nwjs-mv', relativeDir: 'www/save' })
    expect(loc!.slotPattern.test('file1.rpgsave')).toBe(true)
    expect(loc!.configPattern.test('config.rpgsave')).toBe(true)
    expect(loc!.configPattern.test('global.rpgsave')).toBe(true)
  })

  test('MZ 布局：save/ + file1.rmmzsave → nwjs-mz', () => {
    const loc = detectSaveLocation({
      engine: 'nwjs',
      gameSave: dir(['file1.rmmzsave'])
    })
    expect(loc).toMatchObject({ layout: 'nwjs-mz', relativeDir: 'save' })
    expect(loc!.slotPattern.test('file1.rmmzsave')).toBe(true)
  })

  test('★ MVP：两种布局同时存在时，按实际后缀判定（不按目录名硬编码）', () => {
    // 用户真机上 MV 在 www/save、MZ 在 save —— 但如果某游戏两个目录都有呢？
    // 判据必须是「里面是什么后缀」，不是「目录叫什么」。
    const mv = detectSaveLocation({
      engine: 'nwjs',
      wwwSave: dir(['file1.rpgsave']),
      gameSave: dir(['file1.rmmzsave'])
    })
    expect(mv!.layout).toBe('nwjs-mv')

    const mz = detectSaveLocation({
      engine: 'nwjs',
      wwwSave: dir([]),
      gameSave: dir(['file1.rmmzsave'])
    })
    expect(mz!.layout).toBe('nwjs-mz')
  })

  test('★ 回归（Mac 真机）：作者塞进包里的残留存档不能当成用户的存档', () => {
    // ===== 这条是一个**判断错误**的回归（本鱼 2026-11-05 亲自踩的）=====
    //
    // 真机事实（`~/games/苍蓝星`）：
    //   www/            存在，main = www/index.html
    //   www/save/       **不存在**（用户没存过档）
    //   save/           存在，里面有 5 个 .rpgsave（**2022 年的时间戳**）
    //   save/ 目录本身  出生时间 = 解压那一刻（2026-11-05）
    //
    // 本鱼当时看到「根 save/ 里有 .rpgsave」就断言「MV 也可能把存档放在根 save/」，
    // 还加了一条判据让它们显示出来。用户一句「我没存过档」把整条判断推翻。
    //
    // 真相：MV 的 `StorageManager.localFileDirectoryPath()` 是
    //   path.join(path.dirname(process.mainModule.filename), 'save/')
    // main = `www/index.html` → 存档基准是 **www/** → 真实位置 `www/save/`。
    // 那几个文件是**作者打包时塞进去的旧档**，游戏运行时不读也不写它们。
    //
    // 若把它们当成"这个游戏的存档"，用户真玩到存档（写到 www/save）之后
    // 详情页仍显示这几份 2022 年别人的档，他自己的一个都看不到 ——
    // **比"列表为空"更糟：空列表只是没有，错的列表会让人以为档丢了**。
    const loc = detectSaveLocation({
      engine: 'nwjs',
      // www/save 不存在（用户还没存过档）
      wwwSave: null,
      // 根 save 里有残留的 .rpgsave
      gameSave: dir(['file1.rpgsave', 'file2.rpgsave', 'config.rpgsave']),
      // package.json 的 main 指向 www/
      packageMain: 'www/index.html'
    })
    expect(loc, '认不出位置').not.toBeNull()
    // 关键：位置必须是 **www/save**（引擎真实会写的那个），不是根 save
    expect(loc!.layout).toBe('nwjs-mv')
    expect(loc!.relativeDir, '把作者残留的存档目录当成了用户的存档位置').toBe('www/save')
  })

  test('★ main 就在根时（`"main": "index.html"`），存档确实在根 save/', () => {
    // 反向一半：有些 MV 包把 main 放在根，那时存档就在 `<游戏>/save/`
    const loc = detectSaveLocation({
      engine: 'nwjs',
      wwwSave: null,
      gameSave: dir(['file1.rpgsave']),
      packageMain: 'index.html'
    })
    expect(loc!.layout).toBe('nwjs-mv')
    expect(loc!.relativeDir).toBe('save')
  })

  test('读不到 package.json → 退回目录启发式（不会崩，也不会空）', () => {
    // 老包 / 被改过的包：没有 main 可读。这时只能靠目录判断 ——
    // 与 M4 S1 的「宁可多认，不能漏」一致（列表最多多一项，不会少）。
    const loc = detectSaveLocation({
      engine: 'nwjs',
      wwwSave: null,
      gameSave: dir(['file1.rpgsave']),
      packageMain: null
    })
    expect(loc).not.toBeNull()
    expect(loc!.relativeDir).toBe('save')
  })

  test('main 在 www/ 下时，即使 www/save 还不存在也指向它（用户还没存档）', () => {
    // 这一条最容易写成 bug：如果只按"哪个目录有文件"判，会掉进根 save 的残留
    const loc = detectSaveLocation({
      engine: 'nwjs',
      wwwSave: null,
      gameSave: null,
      packageMain: 'www/index.html'
    })
    expect(loc!.relativeDir).toBe('www/save')
  })

  test('目录空着（还没存过档）也报出来，但槽是空的', () => {
    // 这条的目的是让 UI 能说「存档会出现在这里」，而不是「这个游戏没有存档功能」
    const loc = detectSaveLocation({ engine: 'nwjs', wwwSave: dir([]) })
    expect(loc).toMatchObject({ layout: 'nwjs-mv' })
    const { slots } = classifySaveEntries([], loc!)
    expect(slots).toEqual([])
  })

  test('两级目录都不存在 → null（不是空对象）', () => {
    expect(detectSaveLocation({ engine: 'nwjs', wwwSave: missing, gameSave: missing })).toBeNull()
  })

  test('★ 用户真机的真实文件名（Karryn 的 www/save）一个都不能漏', () => {
    // 实测清单（2026-11-05）：
    //   config.rpgsave / global.rpgsave       ← 配置
    //   file1.rpgsave                          ← 槽
    //   lastsave.autobak / sync_data.rpgsave   ← 游戏插件写的备份与同步数据
    //
    // 后两者**不是引擎标准槽**，但确实是存档数据 —— 漏了会让「导出」少带走一部分。
    // 判据方向：宁可多认，不能漏（漏了用户看到「没有存档」而文件明明在那）。
    const entries = [
      'config.rpgsave',
      'global.rpgsave',
      'file1.rpgsave',
      'lastsave.autobak',
      'sync_data.rpgsave'
    ]
    const loc = detectSaveLocation({ engine: 'nwjs', wwwSave: dir(entries) })!
    const { slots, configs } = classifySaveEntries(entries, loc)
    expect(configs).toEqual(['config.rpgsave', 'global.rpgsave'])
    // lastsave.autobak 后缀是 .autobak（不是 .rpgsave）→ 不算槽，但它仍是存档数据，
    // 由「导出」那一步整体打包时包含（见 M4 方案 §3.3：导出原始文件，不按判据筛选）
    expect(slots).toEqual(['file1.rpgsave', 'sync_data.rpgsave'])
  })

  test('配置文件不算存档槽（否则用户以为是第 0 号存档）', () => {
    const loc = detectSaveLocation({
      engine: 'nwjs',
      gameSave: dir(['file1.rmmzsave', 'config.rmmzsave', 'global.rmmzsave'])
    })
    const { slots, configs } = classifySaveEntries(
      ['file1.rmmzsave', 'config.rmmzsave', 'global.rmmzsave'],
      loc!
    )
    expect(slots).toEqual(['file1.rmmzsave'])
    expect(configs).toEqual(['config.rmmzsave', 'global.rmmzsave'])
    // ⚠️ 顺序很重要：判据是「任意后缀但排除配置名」，
    // 若先判 slot 会把 config 也当成存档（有测试钉住，见下一条）
    expect(slots).not.toContain('config.rmmzsave')
  })
})

describe('mkxpz（RGSS 系列）：靠公认约定枚举，不靠猜', () => {
  test('Data/Save1.rvdata2 → rgss-data（VX Ace 默认）', () => {
    const loc = detectSaveLocation({ engine: 'mkxpz', dataDir: dir(['Save1.rvdata2', 'Actors.rvdata2']) })
    expect(loc).toMatchObject({ layout: 'rgss-data', relativeDir: 'Data' })
    expect(loc!.slotPattern.test('Save1.rvdata2')).toBe(true)
    // 不是存档的文件不能命中
    expect(loc!.slotPattern.test('Actors.rvdata2')).toBe(false)
  })

  test('三种世代扩展名都认（XP .rxdata / VX .rvdata / VX Ace .rvdata2）', () => {
    const loc = detectSaveLocation({ engine: 'mkxpz', dataDir: dir(['Save1.rvdata2']) })!
    expect(loc.slotPattern.test('Save1.rxdata')).toBe(true)
    expect(loc.slotPattern.test('Save1.rvdata')).toBe(true)
    expect(loc.slotPattern.test('Save1.rvdata2')).toBe(true)
    expect(loc.slotPattern.test('Save1.rvdata3')).toBe(false)
  })

  test('作者改到根目录 → rgss-root', () => {
    const loc = detectSaveLocation({
      engine: 'mkxpz',
      root: dir(['Save1.rvdata2', 'Game.exe']),
      dataDir: dir(['Actors.rvdata2'])
    })
    expect(loc).toMatchObject({ layout: 'rgss-root', relativeDir: '' })
  })

  test('Save/ 子目录 → rgss-save', () => {
    const loc = detectSaveLocation({
      engine: 'mkxpz',
      root: dir(['Game.exe']),
      dataDir: dir(['Actors.rvdata2']),
      saveDir: dir(['Save1.rvdata2'])
    })
    expect(loc).toMatchObject({ layout: 'rgss-save', relativeDir: 'Save' })
  })

  test('★ 用户真机场景：Data/ 在但还没有任何存档 → 报默认位置（不是 null）', () => {
    // 傭兵の冒険 就是这个状态：Data/ 有 168 个 .rvdata2，但一个 Save* 都没有
    const loc = detectSaveLocation({
      engine: 'mkxpz',
      dataDir: dir(['Actors.rvdata2', 'Map001.rvdata2', 'Scripts.rvdata2'])
    })
    expect(loc).toMatchObject({ layout: 'rgss-data', relativeDir: 'Data' })
    expect(classifySaveEntries(['Actors.rvdata2'], loc!).slots).toEqual([])
  })

  test('Data/ 都没有 → null（那不是 RGSS 游戏）', () => {
    expect(detectSaveLocation({ engine: 'mkxpz', root: dir(['Game.exe']), dataDir: missing })).toBeNull()
  })
})

describe('easyrpg', () => {
  test('Save/ 目录 → easyrpg（目录存在就报，哪怕空）', () => {
    const loc = detectSaveLocation({ engine: 'easyrpg', saveDir: dir([]) })
    expect(loc).toMatchObject({ layout: 'easyrpg', relativeDir: 'Save' })
    expect(loc!.slotPattern.test('Save1.lsd')).toBe(true)
    expect(loc!.slotPattern.test('Save01.lsd')).toBe(true)
  })

  test('没有 Save/ → null', () => {
    expect(detectSaveLocation({ engine: 'easyrpg', saveDir: missing })).toBeNull()
  })
})

describe('renpy：存档不在游戏目录（明确返回 null 表示"不在游戏目录里"）', () => {
  test('renpy 一律返回 null，由主进程走 ~/Library/RenPy/ 分支', () => {
    expect(detectSaveLocation({ engine: 'renpy', root: dir(['Game.exe']), saveDir: dir([]) })).toBeNull()
  })
})

describe('排序：file2 要排在 file10 前', () => {
  test('自然排序（不是字典序）', () => {
    expect(naturalCompare('file2.rmmzsave', 'file10.rmmzsave')).toBeLessThan(0)
    expect(naturalCompare('file10.rmmzsave', 'file2.rmmzsave')).toBeGreaterThan(0)
    expect(naturalCompare('Save1.rvdata2', 'Save2.rvdata2')).toBeLessThan(0)
  })

  test('classifySaveEntries 的结果按自然序', () => {
    const loc = detectSaveLocation({ engine: 'nwjs', gameSave: dir(['file10.rmmzsave']) })!
    const { slots } = classifySaveEntries(
      ['file10.rmmzsave', 'file2.rmmzsave', 'file1.rmmzsave'],
      loc
    )
    expect(slots).toEqual(['file1.rmmzsave', 'file2.rmmzsave', 'file10.rmmzsave'])
  })
})

describe('边界：不是目录的条目不该被当成目录', () => {
  test('isDir=false（路径存在但是文件）→ 视为不存在', () => {
    expect(
      detectSaveLocation({
        engine: 'nwjs',
        wwwSave: { entries: ['file1.rpgsave'], isDir: false }
      })
    ).toBeNull()
  })
})
