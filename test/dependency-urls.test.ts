// M6.5：引擎依赖地址的**静态**校验（不联网）。
//
// ===== 这个文件为什么存在 =====
//
// 2026-11-05 实测发现：本鱼写 siglus_rs 的下载地址时**是猜的**，实际是 404
// —— 而且**两处都错**（资产名不对、tag 不对：真实产物在 `pre-release`，
// 而 `latest` 指向的 1.0.0 一个资产都没有）。
//
// 这类错误的性质很糟：**所有单测全绿**，因为测试只断言「registry 里有这个字段」，
// 不会去请求 URL。而用户点了「安装」才知道失败 —— 且失败信息是 404，
// 看起来像网络问题，不像我们的配置写错。
//
// 所以这里补**离线**的结构性判据（能抓的那部分）：
//   ① 每个 dependency 必须**至少有一个架构条目**（universal 或 arm64 / x86_64）
//   ② 每个条目的 link 必须是 https、且指向 github 或已知站点（不许空、不许相对路径）
//   ③ `unzip` 必须显式是布尔（省了会让大文件被当成品直接落盘）
//   ④ **实测清单**：把本轮**验证过 HTTP 200/206 的地址**列出来，
//      谁改了地址就会红 —— 强迫下一个人**重新验一遍**而不是顺手改
//
// ⚠️ 这里**不联网**（CI 不该依赖网络）。真实验证靠人工执行，
//    但「地址被改过」这件事必须有测试守着。
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { ENGINES } from '../src/main/engines/registry'

/**
 * 本轮**经代理实测 HTTP 206（可下载）**的地址，及其真实体积。
 *
 * 数据来源：2026-11-05 用 `curl -r 0-1023 --proxy` 实测。
 * 体积极大/极小的变化往往意味着上游换了产物 —— 值得人看一眼。
 */
const VERIFIED_URLS: Record<string, { minMB: number; maxMB: number; note: string }> = {
  'https://tmkk.undo.jp/onscripter/onscripter-20230825bin.tar.bz2': {
    minMB: 1,
    maxMB: 20,
    note: 'ONScripter 二进制包（含 onscripter + onscripter-sdl2）'
  },
  'https://github.com/xmoezzz/siglus_rs/releases/download/pre-release/siglus-macos-arm64.app.tar.gz': {
    minMB: 5,
    maxMB: 40,
    note: 'siglus_rs arm64 app 包（实测 12MB）'
  },
  'https://github.com/xmoezzz/siglus_rs/releases/download/pre-release/siglus-macos-x86_64.app.tar.gz': {
    minMB: 5,
    maxMB: 40,
    note: 'siglus_rs x86_64 app 包'
  },
  'https://github.com/godotengine/godot-builds/releases/download/4.6.1-stable/Godot_v4.6.1-stable_macos.universal.zip': {
    minMB: 100,
    maxMB: 260,
    note: 'Godot 编辑器二进制（universal，实测 153MB）'
  },
  'https://github.com/krkrsdl2/krkrsdl2/releases/download/latest/krkrsdl2-macos.zip': {
    minMB: 1,
    maxMB: 30,
    note: 'krkrsdl2（⚠️ 浮动 tag，不是固定版本）'
  }
}

/** 已有的、久经验证的四个引擎地址（M4.x 就在用，不重复列入上面那张实测表）。 */
const LEGACY_ENGINES = new Set(['nwjs', 'mkxpz', 'easyrpg', 'renpy'])

describe('依赖地址的结构性校验', () => {
  test('每个引擎的每个 dependency 都至少有一个架构条目', () => {
    for (const engine of ENGINES) {
      for (const [depName, dep] of Object.entries(engine.dependencies)) {
        const hasAny = dep.universal ?? dep.arm64 ?? dep.x86_64
        expect(hasAny, `${engine.folder}.${depName} 没有任何架构条目`).toBeDefined()
      }
    }
  })

  test('每个 link 都是 https 绝对地址（不许空、不许相对路径）', () => {
    for (const engine of ENGINES) {
      for (const [depName, dep] of Object.entries(engine.dependencies)) {
        for (const arch of ['universal', 'arm64', 'x86_64'] as const) {
          const build = dep[arch]
          if (!build) continue
          const link = build.link
          expect(typeof link, `${engine.folder}.${depName}[${arch}].link 不是字符串`).toBe('string')
          expect(link.trim(), `${engine.folder}.${depName}[${arch}].link 是空的`).not.toBe('')
          expect(link.startsWith('https://'), `${engine.folder}.${depName}[${arch}] 不是 https：${link}`).toBe(
            true
          )
        }
      }
    }
  })

  test('每个 build 的 unzip 都是显式布尔（省了会让大文件被当成品直接落盘）', () => {
    for (const engine of ENGINES) {
      for (const [depName, dep] of Object.entries(engine.dependencies)) {
        for (const arch of ['universal', 'arm64', 'x86_64'] as const) {
          const build = dep[arch]
          if (!build) continue
          expect(
            typeof build.unzip,
            `${engine.folder}.${depName}[${arch}].unzip 必须是布尔（当前是 ${typeof build.unzip}）`
          ).toBe('boolean')
        }
      }
    }
  })
})

describe('⚠️ 实测过的地址不许被随手改掉', () => {
  test('registry 里的每个 link，要么在实测清单里，要么属于老的四个引擎', () => {
    const unknown: string[] = []
    for (const engine of ENGINES) {
      if (LEGACY_ENGINES.has(engine.folder)) continue
      for (const dep of Object.values(engine.dependencies)) {
        for (const arch of ['universal', 'arm64', 'x86_64'] as const) {
          const build = dep[arch]
          if (!build) continue
          if (!(build.link in VERIFIED_URLS)) unknown.push(`${engine.folder}: ${build.link}`)
        }
      }
    }
    // 这条红的时候，说明有人加了/改了地址 —— **请先用 curl 实测 200/206**，
    // 再把它加进 VERIFIED_URLS 并写清真实体积。别直接把地址粘进来就完事：
    // 本鱼就是这么写出一个 404 的。
    expect(unknown, `这些地址没有实测记录：\n${unknown.join('\n')}`).toEqual([])
  })

  test('实测清单里的每条都写清了来源与体积区间', () => {
    for (const [url, meta] of Object.entries(VERIFIED_URLS)) {
      expect(url.startsWith('https://'), `清单里的地址不是 https：${url}`).toBe(true)
      expect(meta.minMB, `${url} 的 minMB 不合理`).toBeGreaterThan(0)
      expect(meta.maxMB, `${url} 的 maxMB 必须大于 minMB`).toBeGreaterThan(meta.minMB)
      expect(meta.note.trim(), `${url} 没有写 note`).not.toBe('')
    }
  })
})

describe('浮动 tag 的登记（这条是「已知风险」的守卫）', () => {
  test('krkrsdl2 用的是 latest 浮动 tag —— 必须被显式登记，不能悄悄改成固定版本又没实测', () => {
    const kirikiri = ENGINES.find((engine) => engine.folder === 'kirikiri')!
    const link = kirikiri.dependencies.krkrsdl2!.universal!.link
    // 上游根本不给固定版本，所以这里**只能**是 latest。若哪天改成固定版本，
    // 说明上游发版了 —— 那时要重新实测，不该一声不响地换掉。
    expect(link).toContain('/releases/download/latest/')
    expect(link).toBe('https://github.com/krkrsdl2/krkrsdl2/releases/download/latest/krkrsdl2-macos.zip')
  })

  test('这条守卫存在本身说明它是个已知风险（不是"已经解决了"）', () => {
    // 读 registry 源码，确认注释里记了这个风险 —— 以防有人删掉注释只留地址
    const source = fs.readFileSync(path.join('src', 'main', 'engines', 'registry.ts'), 'utf8')
    expect(source).toContain('浮动 tag')
    expect(source).toContain('无法 pin')
  })
})
