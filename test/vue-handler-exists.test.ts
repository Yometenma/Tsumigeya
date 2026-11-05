// M5.0 S11（U8）：编辑页/向导的**模板-脚本一致性**回归测试。
//
// ===== 这个文件为什么存在 =====
//
// S10 抽 `GameInfoForm` 时，本鱼用脚本删掉编辑页的一大段代码，
// **连带把 `save()` 与 `goBack()` 一起删了**。
//
// 后果：编辑页底部的「保存」「返回」两个按钮变成**点了没反应**。
// 而这一整套检查全是绿的：
//   · `typecheck` 通过 —— 模板里的 `@click="save"` 是字符串，tsc 不检查它
//   · `build` 通过 —— Vue 编译把未定义的标识符当运行时属性
//   · `test` 通过 —— 没有任何测试在核对这件事
//
// 这是本轮**唯一一处会直接影响用户真实数据操作的回归**（保存按钮死了），
// 而且三道闸全部放过。所以必须补一条判据（D68 的同一取向：删掉/漏掉的东西要有测试守）。
//
// 判据很简单：模板里出现的 `@click="x"` / `v-model="x"` 等方法名，
// 必须在 `<script setup>` 里声明过（或是有意为之的副作用表达式）。
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const ROOT = process.cwd()
const SRC = path.join(ROOT, 'src', 'renderer', 'src')

/**
 * 读一个 SFC 并拆成 script / template 两半。
 *
 * ⚠️ template 必须取**最后一个** `</template>`：Vue 里 `<template #title>` 这类
 * 具名插槽会让"第一个 </template>"提前结束 —— 本鱼第一版就踩了，
 * 结果判据只看到页面开头一小段，`@click="save"` 根本没被扫到
 * （那条测试因此**假绿**，反向验证时才露馅）。
 */
function splitSfc(relativePath: string): { script: string; template: string } {
  const source = fs.readFileSync(path.join(SRC, relativePath), 'utf8')
  const scriptMatch = source.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  const templateStart = source.indexOf('<template')
  const templateEnd = source.lastIndexOf('</template>')
  const template =
    templateStart >= 0 && templateEnd > templateStart
      ? source.slice(source.indexOf('>', templateStart) + 1, templateEnd)
      : ''
  return { script: scriptMatch?.[1] ?? '', template }
}

/**
 * script 里声明过的方法名。
 *
 * 覆盖三种声明写法：`function foo(`、`const foo =`、`async function foo(`。
 */
function declaredNames(script: string): Set<string> {
  const names = new Set<string>()
  for (const match of script.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    names.add(match[1]!)
  }
  for (const match of script.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/g)) {
    names.add(match[1]!)
  }
  return names
}

/**
 * 从模板里抠出「必须是个方法」的标识符。
 *
 * 只看 `@xxx="name"` 与 `@xxx="name(...)"` 这两种形态（含常见修饰符 `@click.stop`）。
 * **刻意不检查**：
 *   · 内联表达式（`@click="x = !x"`、`@update:model-value="patch({...})"`）——
 *     那是合法且常见的写法，硬查会大量误报
 *   · 模板里的纯读取（`{{ foo }}`）—— 那种漏了会直接渲染出空白，肉眼可见
 */
function handlerNames(template: string): Set<string> {
  const names = new Set<string>()
  // @click="doSomething" / @click="doSomething($event)" / @click.stop="doSomething"
  for (const match of template.matchAll(/@[\w:.-]+(?:\.[\w-]+)*="([A-Za-z_$][\w$]*)\s*(?:\(|")/g)) {
    names.add(match[1]!)
  }
  return names
}

/** 检查一个 SFC；返回「被引用但没声明」的方法名。 */
function undeclaredHandlers(relativePath: string): string[] {
  const { script, template } = splitSfc(relativePath)
  const declared = declaredNames(script)
  return [...handlerNames(template)].filter((name) => !declared.has(name))
}

describe('★ 模板里的 @click 方法必须在 script 里声明过', () => {
  test('GameEditPage：save / goBack 等都必须真的存在（S10 曾把这两个删掉）', () => {
    const missing = undeclaredHandlers('pages/GameEditPage.vue')
    expect(missing, `编辑页模板引用了不存在的处理函数：${missing.join(', ')}`).toEqual([])
  })

  test('GameEditPage 显式包含 save 与 goBack（保存按钮是这一页的核心操作）', () => {
    const { script } = splitSfc('pages/GameEditPage.vue')
    expect(script).toMatch(/(?:async\s+)?function\s+save\s*\(/)
    expect(script).toMatch(/(?:async\s+)?function\s+goBack\s*\(/)
  })

  test('AddGameWizard：finish / chooseIcon / changeEngine 等都必须存在', () => {
    const missing = undeclaredHandlers('components/AddGameWizard.vue')
    expect(missing, `向导模板引用了不存在的处理函数：${missing.join(', ')}`).toEqual([])
  })

  test('GameInfoForm：新增的 refreshMeta / commitEdit 等都必须存在', () => {
    const missing = undeclaredHandlers('components/GameInfoForm.vue')
    expect(missing, `信息表单模板引用了不存在的处理函数：${missing.join(', ')}`).toEqual([])
  })

  test('LibraryPage / SettingsPage / EnginesPage / App 同样要一致', () => {
    for (const file of [
      'pages/LibraryPage.vue',
      'pages/SettingsPage.vue',
      'pages/EnginesPage.vue',
      'pages/GameDetailPage.vue',
      'App.vue'
    ]) {
      const missing = undeclaredHandlers(file)
      expect(missing, `${file} 模板引用了不存在的处理函数：${missing.join(', ')}`).toEqual([])
    }
  })

  test('SaveSection：导出/导入/在访达中显示/刷新都必须存在（M4 S3/S4 的按钮）', () => {
    // ⚠️ 这四个按钮是**用户真实数据操作**的入口（导出存档、覆盖现存档）。
    // 一个死键的表现是"点了没反应"，而 tsc / build / 其它测试全都放过 ——
    // 正是这个文件存在的理由（S10 曾把 save/goBack 删掉，保存按钮变死键）。
    const missing = undeclaredHandlers('components/SaveSection.vue')
    expect(missing, `存档区块模板引用了不存在的处理函数：${missing.join(', ')}`).toEqual([])
    const { script } = splitSfc('components/SaveSection.vue')
    for (const name of ['exportSaves', 'importSaves', 'revealInFinder', 'load']) {
      expect(script, `SaveSection 里缺少 ${name} 的声明`).toMatch(
        new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`)
      )
    }
  })
})

describe('判据本身要能抓到问题（反向验证）', () => {
  test('人为删掉声明的函数 → handlerNames 会把它挑出来', () => {
    const template = '<el-button @click="save">{{ x }}</el-button>'
    const script = 'const saving = ref(false)' // 故意没有 save
    const declared = declaredNames(script)
    const missing = [...handlerNames(template)].filter((name) => !declared.has(name))
    expect(missing).toEqual(['save'])
  })

  test('带修饰符与带参数的写法都能识别', () => {
    const template = '<div @click.stop="toggle" @keyup.enter="onEnter($event)" />'
    expect([...handlerNames(template)].sort()).toEqual(['onEnter', 'toggle'])
  })

  test('内联表达式不会被误判成方法名', () => {
    // `@click="x = !x"` 与 `@update:model-value="patch({...})"` 都是合法写法
    const template =
      '<el-button @click="openSection = !openSection" /><el-radio-group @update:model-value="patch({ listView: $event })" />'
    const names = handlerNames(template)
    // 内联赋值那一侧的 `openSection` 不该被当成"方法缺失"（它不是 @xxx="name(" 的形态）
    expect(names.has('openSection')).toBe(false)
    // 而 `patch(...)` 是方法调用形态，要能被识别到
    expect(names.has('patch')).toBe(true)
  })
})
