// B1 单测：版本号的唯一来源是**构建时注入**，不许再回落到运行时环境变量。
//
// ===== 为什么值得有测试 =====
//
// 这个 bug 的形态很刁：`process.env.npm_package_version ?? '0.0.0'`
// 在 `npm run dev` 下**完全正常**（npm 会把 version 塞进子进程 env），
// 只有打包成 .app、由 Finder 启动时才消失 → 恒显示 v0.0.0。
// 开发机上永远复现不了，所以只能靠**源码判据**钉住：
//
//   ① preload 里不许再出现 npm_package_version（那是「只在 dev 里对」的那条路）
//   ② define 必须在，且值来自 package.json 的 version（不是硬编码字面量）
//   ③ APP_VERSION 走的就是那个注入常量
//
// 没有这条测试，下个会话看到「preload 里读个版本号还要多一个文件」很容易顺手简化回去，
// 然后测试全绿、打包后又是 v0.0.0 —— 这正是 D68 说的「只删不守 = 迟早复发」的反向版本。
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const ROOT = process.cwd()
const read = (...parts: string[]): string => fs.readFileSync(path.join(ROOT, ...parts), 'utf8')

/** 递归收集某个目录下的 .ts/.vue（与 no-upstream-module 同款做法）。 */
function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const relative = path.join(dir, entry.name)
    if (entry.isDirectory()) collectSources(relative, out)
    else if (/\.(ts|vue|js|cjs|mjs)$/.test(entry.name)) out.push(relative)
  }
  return out
}

/** 去掉注释（避免「注释里解释为什么不用 npm_package_version」被判红）。 */
function stripComments(source: string): string {
  return source
    .replace(/^\s*\/\*[\s\S]*?\*\/\s*$/gm, '')
    .split('\n')
    .map((line) => {
      const index = line.indexOf('//')
      return index < 0 ? line : line.slice(0, index)
    })
    .join('\n')
}

describe('B1 版本号：构建时注入', () => {
  test('preload 与 renderer 的源码里不再出现 npm_package_version', () => {
    const files = [...collectSources('src/preload'), ...collectSources('src/renderer/src')]
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const code = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'))
      expect(code, `${file} 又读回了 npm_package_version`).not.toContain('npm_package_version')
    }
  })

  test('electron.vite.config.ts 用 package.json 的 version 注入 __APP_VERSION__', () => {
    const config = stripComments(read('electron.vite.config.ts'))
    expect(config).toContain('__APP_VERSION__')
    // 必须是 pkg.version，不能是硬编码的 '0.5.3' —— 否则改版本号时它会悄悄过期
    expect(config).toMatch(/__APP_VERSION__\s*:\s*JSON\.stringify\(pkg\.version\)/)
    expect(config).toContain("from './package.json'")
    // 三个块都要（main / preload / renderer），防止某块被漏掉后静默退化成 undefined
    expect(config.match(/define\b/g)?.length ?? 0).toBeGreaterThanOrEqual(3)
  })

  test('APP_VERSION 直接取注入常量，不套兜底默认值', () => {
    const source = stripComments(read('src', 'preload', 'app-version.ts'))
    expect(source).toContain('declare const __APP_VERSION__: string')
    // 关键：写成 `APP_VERSION = __APP_VERSION__`。加 `?? '0.0.0'` 就等于把 bug 又请回来了
    expect(source).toMatch(/export const APP_VERSION: string = __APP_VERSION__/)
    expect(source).not.toMatch(/__APP_VERSION__\s*\?\?/)
  })

  test('preload 暴露的 appVersion 来自 APP_VERSION', () => {
    const source = stripComments(read('src', 'preload', 'index.ts'))
    expect(source).toContain("import { APP_VERSION } from './app-version'")
    expect(source).toMatch(/appVersion: APP_VERSION/)
  })

  test('package.json 里有可用的 version（注入的原料）', () => {
    const pkg = JSON.parse(read('package.json')) as { version?: string }
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/)
  })
})
