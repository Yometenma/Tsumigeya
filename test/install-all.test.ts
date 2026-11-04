// M5.0 S8（U10）单测：「全部安装」的编排（src/shared/install-all.ts）。
//
// ===== 这轮测什么 =====
//
// 用户要的是「已安装那边有全部更新，可安装这边也该有全部安装」——对称。
// 但**失败策略必须不对称**，而这一点方案 §10 点明了：
//
//     「注意：一次装多个引擎会下载几百 MB，必须逐个 + 进度」
//
// 现有 `updateAllEngines` 是**第一个失败就 throw**。对更新尚可，
// 对安装是错的：四个引擎相互独立，nwjs 装失败不该让 mkxpz 不装；
// 一次几百 MB 断在某一个是常态；用户点「全部安装」的意图是"把能装的装上"。
//
// 而且 throw 之后连 snapshot 都不返回 → **已经下好的那几个也留不下来**。
//
// 所以这里钉的就是「失败不中断」这条。判反的后果：一次网络抖动废掉整个操作，
// 用户还得逐个重点一遍。
import { describe, expect, test } from 'vitest'
import {
  installAllCount,
  installAllOutcome,
  pendingInstalls,
  runInstallAll,
  type InstallTarget
} from '../src/shared/install-all'

const ALL: InstallTarget[] = [
  { folder: 'nwjs', name: 'NW.js' },
  { folder: 'mkxpz', name: 'mkxp-z' },
  { folder: 'easyrpg', name: 'EasyRPG' },
  { folder: 'renpy', name: 'RenPy' }
]

describe('pendingInstalls：只装还没装的', () => {
  test('一个都没装 → 全部四个', () => {
    expect(pendingInstalls(ALL, new Set()).map((x) => x.folder)).toEqual([
      'nwjs',
      'mkxpz',
      'easyrpg',
      'renpy'
    ])
  })

  test('装了一个 → 剩三个', () => {
    expect(pendingInstalls(ALL, new Set(['nwjs'])).map((x) => x.folder)).toEqual([
      'mkxpz',
      'easyrpg',
      'renpy'
    ])
  })

  test('已装齐 → 空（按钮该 disabled）', () => {
    expect(pendingInstalls(ALL, new Set(ALL.map((x) => x.folder)))).toEqual([])
  })

  test('⚠️ 顺序原样保留（不排序，否则"装到第几个"与卡片列表对不上）', () => {
    expect(pendingInstalls(ALL, new Set(['mkxpz'])).map((x) => x.folder)).toEqual([
      'nwjs',
      'easyrpg',
      'renpy'
    ])
  })

  test('已装集合里有未知 id（旧版残留）→ 不影响判定', () => {
    expect(pendingInstalls(ALL, new Set(['ruffle', 'wine']))).toHaveLength(4)
  })
})

describe('installAllCount：按钮上的数字', () => {
  test('按还没装的算，不是按 available 总数', () => {
    expect(installAllCount(ALL, new Set(['nwjs', 'mkxpz']))).toBe(2)
  })

  test('一个都没装 → 4', () => {
    expect(installAllCount(ALL, new Set())).toBe(4)
  })

  test('已装齐 → 0（渲染层据此 disabled）', () => {
    expect(installAllCount(ALL, new Set(ALL.map((x) => x.folder)))).toBe(0)
  })
})

describe('runInstallAll：逐个执行 + 进度', () => {
  test('全部成功 → installed 四个，failed 空', async () => {
    const calls: string[] = []
    const progress: Array<[number, number]> = []
    const result = await runInstallAll(ALL, {
      install: async (target) => {
        calls.push(target.folder)
      },
      onProgress: (done, total) => progress.push([done, total])
    })
    expect(calls).toEqual(['nwjs', 'mkxpz', 'easyrpg', 'renpy'])
    expect(result.installed).toEqual(['nwjs', 'mkxpz', 'easyrpg', 'renpy'])
    expect(result.failed).toEqual([])
    expect(result.cancelled).toBe(false)
    expect(progress).toEqual([
      [1, 4],
      [2, 4],
      [3, 4],
      [4, 4]
    ])
  })

  test('★★ 一个失败**不中断**其余（与 updateAllEngines 的关键区别）', async () => {
    const calls: string[] = []
    const result = await runInstallAll(ALL, {
      install: async (target) => {
        calls.push(target.folder)
        if (target.folder === 'mkxpz') throw new Error('network down')
      }
    })
    // 四个都被尝试过
    expect(calls).toEqual(['nwjs', 'mkxpz', 'easyrpg', 'renpy'])
    expect(result.installed).toEqual(['nwjs', 'easyrpg', 'renpy'])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]?.folder).toBe('mkxpz')
    expect(result.failed[0]?.name).toBe('mkxp-z')
  })

  test('★ 全失败也要把每个都试过（不是第一个失败就停）', async () => {
    const calls: string[] = []
    const result = await runInstallAll(ALL, {
      install: async (target) => {
        calls.push(target.folder)
        throw new Error('fail')
      }
    })
    expect(calls).toHaveLength(4)
    expect(result.installed).toEqual([])
    expect(result.failed).toHaveLength(4)
  })

  test('进度在失败之后**照样上报**（否则界面会卡在"正在装第 2 个"）', async () => {
    const progress: number[] = []
    await runInstallAll(ALL.slice(0, 2), {
      install: async () => {
        throw new Error('x')
      },
      onProgress: (done) => progress.push(done)
    })
    expect(progress).toEqual([1, 2])
  })

  test('空目标列表 → 什么都不做（不调 install）', async () => {
    let called = false
    const result = await runInstallAll([], {
      install: async () => {
        called = true
      }
    })
    expect(called).toBe(false)
    expect(result).toEqual({ installed: [], failed: [], cancelled: false })
  })

  test('⚠️ 取消是**引擎之间**的检查：当前这个装完才停', async () => {
    let cancelAfter = 0
    const calls: string[] = []
    const result = await runInstallAll(ALL, {
      install: async (target) => {
        calls.push(target.folder)
        cancelAfter += 1
      },
      // 装完第一个后返回 true
      isCancelled: () => cancelAfter >= 1
    })
    // 第一个装完了（不打断正在下的那个），然后停下
    expect(calls).toEqual(['nwjs'])
    expect(result.cancelled).toBe(true)
    expect(result.installed).toEqual(['nwjs'])
  })

  test('取消时已装成功的仍在结果里（用户看得到自己已经拿到什么）', async () => {
    let done = 0
    const result = await runInstallAll(ALL, {
      install: async () => {
        done += 1
      },
      isCancelled: () => done >= 2
    })
    expect(result.installed).toEqual(['nwjs', 'mkxpz'])
    expect(result.cancelled).toBe(true)
  })

  test('一开始就取消 → 一个都不装', async () => {
    const result = await runInstallAll(ALL, {
      install: async () => {
        throw new Error('should not be called')
      },
      isCancelled: () => true
    })
    expect(result.installed).toEqual([])
    expect(result.cancelled).toBe(true)
  })
})

describe('installAllOutcome：汇总该报什么颜色', () => {
  test('全成功 → all-success（绿色）', () => {
    expect(installAllOutcome({ installed: ['a'], failed: [], cancelled: false })).toBe('all-success')
  })

  test('⚠️ 部分失败 → partial（**warning 不是 error**）', () => {
    // 报 error 会让用户以为全废了，然后去重装一遍已装好的
    expect(
      installAllOutcome({ installed: ['a'], failed: [{ folder: 'b', name: 'B', error: null }], cancelled: false })
    ).toBe('partial')
  })

  test('全失败 → all-failed', () => {
    expect(
      installAllOutcome({
        installed: [],
        failed: [
          { folder: 'a', name: 'A', error: null },
          { folder: 'b', name: 'B', error: null }
        ],
        cancelled: false
      })
    ).toBe('all-failed')
  })

  test('⚠️ 取消优先于一切（用户自己的决定，不该报红）', () => {
    expect(
      installAllOutcome({ installed: ['a'], failed: [{ folder: 'b', name: 'B', error: null }], cancelled: true })
    ).toBe('cancelled')
    expect(installAllOutcome({ installed: [], failed: [], cancelled: true })).toBe('cancelled')
  })
})
