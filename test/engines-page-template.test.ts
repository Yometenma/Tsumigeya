// M6.5：引擎页**模板可编译 + 判据真有定义**的静态验证。
//
// ===== 这个文件补的是什么缺口 =====
//
// 单测（`engine-card.test.ts`）只能验两件事：
//   ① 判据函数本身算得对
//   ② 模板源码里**出现过** `v-if="canInstall(...)"` 这个字符串
//
// 但它**看不到**最要命的那种错：**模板调用了 script 里不存在的函数**。
// AGENTS.md 记过这个坑（S10：把 `save`/`goBack` 删掉、保存按钮变死键，
// 而 tsc / build / 单测**全部放过** —— 模板里的标识符是字符串，编译器不认识）。
//
// 所以这里用 Vue 官方的 SFC 编译器**真的编译一遍模板**，再逐个核对
// 「模板里调用的判据函数」在 `<script setup>` 里**确实有定义**。
//
// ⚠️ 这不是 e2e —— 它编译模板但不执行。真机 DOM 验证要靠
//    `scripts/probe-engine-page.cjs`（需要能起 GUI 的机器）。
//    本轮本机 Electron 连 `--version` 都崩（0x80000003），所以那一步留待真机。
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { parse, compileTemplate } from '@vue/compiler-sfc'

const PAGE = path.join(process.cwd(), 'src', 'renderer', 'src', 'pages', 'EnginesPage.vue')

/** 取出 SFC 的主 template 块。 */
function mainTemplate(src: string): string {
  // ⚠️ 必须用 lastIndexOf：
  //   SFC 里可能有 `<template #title>` 这样的具名插槽，
  //   用 indexOf/matches 取第一个 `</template>` 会**提前截断**，
  //   于是扫模板的测试会**假绿**（AGENTS.md 记过，S11 实测踩到）。
  const firstOpen = src.indexOf('<template>')
  const lastClose = src.lastIndexOf('</template>')
  if (firstOpen < 0 || lastClose < 0 || lastClose <= firstOpen) {
    throw new Error('找不到主 template 块')
  }
  return src.slice(firstOpen + '<template>'.length, lastClose)
}

describe('EnginesPage 模板', () => {
  const source = fs.readFileSync(PAGE, 'utf8')

  test('SFC 能被正常解析（无结构性错误）', () => {
    const { errors } = parse(source, { filename: PAGE })
    expect(errors).toEqual([])
  })

  test('主 template 块能被 Vue 编译器编译（语法错误会在这里暴露）', () => {
    // 这一条能抓到「模板里写了非法表达式」这类只有运行时才会白屏的错。
    const result = compileTemplate({
      source: mainTemplate(source),
      filename: PAGE,
      id: 'engine-page-probe'
    })
    expect(result.errors, `模板编译失败：${JSON.stringify(result.errors)}`).toEqual([])
  })
})

describe('⚠️ 模板调用的判据函数必须在 script setup 里有定义', () => {
  const source = fs.readFileSync(PAGE, 'utf8')
  const template = mainTemplate(source)
  const script = parse(source, { filename: PAGE }).descriptor.scriptSetup?.content ?? ''

  /** 模板里以 `名字(` 形式出现的调用（排除标签名与属性名）。 */
  const CANDIDATES = ['canInstall', 'warningOf', 'installableTargets', 'toCardSources']

  test('script setup 存在', () => {
    expect(script.length).toBeGreaterThan(0)
  })

  for (const name of CANDIDATES) {
    test(`${name}：模板若调用它，script 里必须有定义`, () => {
      const usedInTemplate = template.includes(`${name}(`)
      if (!usedInTemplate) {
        // 没用到就不要求定义 —— 但也别把它写进 CANDIDATES 白占位
        return
      }
      // 定义形式：`function name(` 或 `const name =`
      const defined = new RegExp(`(function\\s+${name}\\b|const\\s+${name}\\s*=|let\\s+${name}\\s*=)`).test(
        script
      )
      expect(defined, `模板调用了 ${name}() 但 script setup 里没有定义（点了会没反应）`).toBe(true)
    })
  }

  test('这两个判据确实**被模板用到**了（否则就是"写了没用"）', () => {
    // 反向守卫：函数定义了但模板里不调用 → 功能等于没写
    expect(template).toContain('canInstall(')
    expect(template).toContain('warningOf(')
  })
})

describe('i18n 键在模板里被引用时必须真的存在', () => {
  const source = fs.readFileSync(PAGE, 'utf8')
  const locales = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'src', 'renderer', 'src', 'locales', 'zh-CN.json'), 'utf8')
  )

  /** 取 `t('a.b.c')` 形式的 key。 */
  const usedKeys = [...source.matchAll(/t\('([a-zA-Z][a-zA-Z0-9_.]*\.[a-zA-Z0-9_.]+)'/g)].map(
    (m) => m[1]
  )

  test('引擎页里有 i18n 引用（防空扫）', () => {
    expect(usedKeys.length).toBeGreaterThan(0)
  })

  test('每个引用的 key 都在 locales 里真实存在（vue-i18n 查不到会原样画 key 且不报错）', () => {
    const missing: string[] = []
    for (const key of usedKeys) {
      let cursor = locales
      for (const part of key.split('.')) {
        cursor = cursor?.[part]
        if (cursor === undefined) break
      }
      if (typeof cursor !== 'string') missing.push(key)
    }
    expect(missing, `这些 i18n key 不存在：${missing.join(', ')}`).toEqual([])
  })

  test('本轮新增的三个 key 都在（且旧的合并 key 已删）', () => {
    const engines = locales.engines
    expect(engines).toHaveProperty('experimentalUpstream')
    expect(engines).toHaveProperty('experimentalUnverified')
    expect(engines).toHaveProperty('noDependencies')
    expect(engines).not.toHaveProperty('experimental')
  })
})
