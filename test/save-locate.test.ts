// M4 S1：存档位置探测的判据。
//
// 这些测试是照着**用户 Mac 上的真实目录结构**写的（2026-11-05 实测）：
//   Karryn's Prison（MV） → www/save/  + .rpgsave
//   艾妮希雅（MZ）        → save/      + .rmmzsave
//   傭兵の冒険（MKXP-Z）  → Data/ 存在但还没有存档
//   **苍蓝星（MV）**      → **save/（不是 www/save/）** + .rpgsave
//                          ↑ 这条是本轮实测才发现的第 4 种形态，见下方回归测试
//
// 判据错了**不会报错**：列表空着，用户只会以为「我没存过档」。

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

  test('★ 回归（Mac 真机）：MV 游戏把存档放在 <游戏>/save/（苍蓝星）', () => {
    // 真机实测 2026-11-05：`~/games/苍蓝星/` 有 www/，但 **www/save/ 不存在**；
    // 存档全在 `<游戏>/save/` 里，后缀是 `.rpgsave`（MV），不是 `.rmmzsave`。
    //
    // 修复前的表现（本鱼实测复现过）：走到「save/ 目录存在」那条兜底分支 →
    // 报 layout `nwjs-mz` + MZ 的判据 → 那一堆 `.rpgsave` **一个都匹配不上**
    // → 用户看到「目录已就绪，还没有存档」，而那儿躺着 20 多个档。
    // 不报错、只安静地少列东西 —— 本模块最怕的那一类。
    const loc = detectSaveLocation({
      engine: 'nwjs',
      wwwSave: null,
      gameSave: dir(['file1.rpgsave', 'file2.rpgsave', 'config.rpgsave', 'global.rpgsave'])
    })
    expect(loc, 'save/ 里有 .rpgsave 却没认出位置').not.toBeNull()
    // 关键：布局是 MV（后缀说的），相对路径是 save（目录说的）—— 两者独立
    expect(loc!.layout).toBe('nwjs-mv')
    expect(loc!.relativeDir).toBe('save')

    // 而且槽必须真的列出来（这才是用户能看到的那个判据）
    const { slots, configs } = classifySaveEntries(
      ['file1.rpgsave', 'file2.rpgsave', 'config.rpgsave', 'global.rpgsave'],
      loc!
    )
    expect(slots).toEqual(['file1.rpgsave', 'file2.rpgsave'])
    expect(configs.sort()).toEqual(['config.rpgsave', 'global.rpgsave'])
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
