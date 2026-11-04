// M5.0 S4（U6）单测：向导第 2 步的「改引擎」判定（src/shared/wizard-engine.ts）。
//
// ===== 这轮测什么 =====
//
// 用户原话：「识别到之后还是会有一个选项叫跳过，稍后安装的，感觉没必要。
// 然后这里万一要是识别错了应该能改到自己指定的引擎，现在好像并不能」
//
// 两件事：
//   ① 删「跳过，稍后安装」→ 但**不能把断网用户卡死**（方案 §7.1：删按钮 ≠ 强制）
//   ② 识别成功后也要有改引擎的入口 → 选项来源必须**真的非空**
//
// ②那条是最容易假修的地方：可安装列表是懒加载的，向导如果先于引擎页打开，
// 下拉就是空的 —— 用户点开发现没得选，等于修了个假的入口。
//
// 这两条改反了都不报错，只是安静地变成另一种行为（卡死 / 空下拉），
// 所以必须靠单测钉住。
import { describe, expect, test } from 'vitest'
import { canAdvanceEngineStep, engineOptionsFrom, engineSourceBadge } from '../src/shared/wizard-engine'

describe('engineOptionsFrom：改引擎下拉的选项来源', () => {
  const registry = [
    { id: 'nwjs', name: 'NW.js' },
    { id: 'mkxpz', name: 'mkxp-z' },
    { id: 'easyrpg', name: 'EasyRPG' },
    { id: 'renpy', name: 'RenPy' }
  ]
  const installed = [{ id: 'mkxpz', name: 'mkxp-z' }]

  test('可安装列表就绪时，用它（含未装的引擎，四个全在）', () => {
    const options = engineOptionsFrom(registry, installed)
    expect(options.map((item) => item.value)).toEqual(['nwjs', 'mkxpz', 'easyrpg', 'renpy'])
  })

  test('⚠️ 可安装列表还没加载（懒加载）→ 退回已装列表，下拉不能是空的', () => {
    // 这是本组最重要的一条：向导可能先于引擎页打开
    const options = engineOptionsFrom([], installed)
    expect(options).toHaveLength(1)
    expect(options[0]).toEqual({ label: 'mkxp-z', value: 'mkxpz' })
  })

  test('两份都空 → 空数组（调用方据此显示「没得选」而不是假选项）', () => {
    expect(engineOptionsFrom([], [])).toEqual([])
  })

  test('label 用 name，缺失时回落 id（不能让下拉出现空白的行）', () => {
    expect(engineOptionsFrom([{ id: 'nwjs', name: 'NW.js' }], [])[0]?.label).toBe('NW.js')
    expect(engineOptionsFrom([{ id: 'nwjs' }], [])[0]?.label).toBe('nwjs')
    expect(engineOptionsFrom([{ id: 'nwjs', name: '   ' }], [])[0]?.label).toBe('nwjs')
  })

  test('按 value 去重（同一 id 出现两次时只留一条，避免 el-select 行为诡异）', () => {
    const options = engineOptionsFrom([...registry, { id: 'nwjs', name: 'NW.js' }], [])
    expect(options.map((item) => item.value)).toEqual(['nwjs', 'mkxpz', 'easyrpg', 'renpy'])
  })

  test('空 id 被跳过（不给下拉留一个点不动的空行）', () => {
    const options = engineOptionsFrom([{ id: '' }, { id: '  ' }, { id: 'nwjs', name: 'NW.js' }], [])
    expect(options.map((item) => item.value)).toEqual(['nwjs'])
  })

  test('id 前后空白会被 trim（免得与已装的 id 比不上 → 显示"未安装"）', () => {
    expect(engineOptionsFrom([{ id: ' nwjs ', name: 'NW.js' }], [])[0]).toEqual({
      label: 'NW.js',
      value: 'nwjs'
    })
  })
})

describe('canAdvanceEngineStep：删掉「跳过」之后唯一的逃生门', () => {
  test('引擎已装 → 放行（正常路径）', () => {
    expect(canAdvanceEngineStep({ engine: 'mkxpz', installed: true, installFailed: false })).toBe(true)
  })

  test('⚠️ 装过但失败（断网）→ 也要放行，否则断网用户存不进游戏', () => {
    // 方案 §7.1 的容错路径：删按钮 ≠ 强制。
    // 卡死的代价比「带着未就绪的配置存盘」大得多 —— 后者用户稍后去引擎页补装即可，
    // 前者会让整个添加流程在这台机器上彻底不可用。
    expect(canAdvanceEngineStep({ engine: 'mkxpz', installed: false, installFailed: true })).toBe(true)
  })

  test('没装、也没试过安装 → 不放行（用户还不知道要装东西）', () => {
    expect(canAdvanceEngineStep({ engine: 'mkxpz', installed: false, installFailed: false })).toBe(false)
  })

  test('压根没选引擎 → 不放行（就算 installFailed 为 true 也不行）', () => {
    expect(canAdvanceEngineStep({ engine: '', installed: false, installFailed: true })).toBe(false)
    expect(canAdvanceEngineStep({ engine: '   ', installed: true, installFailed: false })).toBe(false)
  })
})

describe('engineSourceBadge：界面上标「自动识别」还是「已手动修改」', () => {
  test('没选引擎 → none（不显示徽标）', () => {
    expect(engineSourceBadge(false, '')).toBe('none')
    expect(engineSourceBadge(true, '')).toBe('none')
  })

  test('自动识别 → detected', () => {
    expect(engineSourceBadge(false, 'nwjs')).toBe('detected')
  })

  test('用户手改过 → manual（这个标记让用户知道自己覆盖了识别结果）', () => {
    expect(engineSourceBadge(true, 'mkxpz')).toBe('manual')
  })
})
