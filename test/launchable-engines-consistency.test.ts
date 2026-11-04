// M4.0 S7：引擎名单的一致性（主进程与渲染层必须对得上）。
//
// 为什么会有两份名单：
//   · 主进程 `src/main/launchers/index.ts` 的 `LAUNCHABLE_ENGINES` 是**唯一来源**
//     （`buildLaunchPlan` 用它判断支不支持）
//   · 渲染层 `EnginesPage.vue` 需要把不支持的引擎标灰，但**不能 import 主进程代码**
//     （contextBridge 隔离），只能放一份镜像
//
// 两份不一致的后果：
//   · 引擎页说「支持」→ 用户装了 → 点启动报「不支持」，比明说更糟
//   · 引擎页说「不支持」→ 其实支持 → 用户以为用不了，白装了引擎
//
// 所以这里**直接读源码文本**比对两个数组的内容，不做任何转述。
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { LAUNCHABLE_ENGINES } from '../src/main/launchers'

const PAGE = path.join(process.cwd(), 'src', 'renderer', 'src', 'pages', 'EnginesPage.vue')

/** 从 EnginesPage.vue 里抠出 `LAUNCHABLE_ENGINE_IDS = [...]` 的内容。 */
function rendererEngineIds(): string[] {
  const text = fs.readFileSync(PAGE, 'utf8')
  const match = /const LAUNCHABLE_ENGINE_IDS = \[([^\]]*)\]/.exec(text)
  if (!match) throw new Error('渲染层找不到 LAUNCHABLE_ENGINE_IDS（是不是改名了？）')
  return match[1]
    .split(',')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
}

describe('M4.0 S7：主进程与引擎页的「可启动引擎」名单一致', () => {
  test('★ 两份名单逐项相同（顺序无关，内容必须对齐）', () => {
    const renderer = rendererEngineIds()
    expect([...renderer].sort()).toEqual([...LAUNCHABLE_ENGINES].sort())
  })

  test('渲染层名单正好四个（防止漏一个或多一个）', () => {
    expect(rendererEngineIds()).toHaveLength(LAUNCHABLE_ENGINES.length)
  })

  test('三个不做的引擎（ruffle / wine / macos）两份都不在名单里', () => {
    for (const engine of ['ruffle', 'wine', 'macos']) {
      expect(LAUNCHABLE_ENGINES).not.toContain(engine)
      expect(rendererEngineIds()).not.toContain(engine)
    }
  })
})
