// docs 章节引用的守卫（2026-11-05 精简 docs 时立的）。
//
// ===== 这个文件防什么 =====
//
// 代码注释里有 18 处 `// 契约：docs/M2-实施方案.md §3.4` 这样的引用。
// 它们指向**具体章节**，是"这里为什么这么实现"的唯一依据。
//
// 删掉/重排 docs 的章节会让这些引用**静默断链**：
//   · 没有编译错误（注释不参与构建）
//   · 没有测试会红（没人检查注释）
//   · 后果是下个会话按注释去查契约，翻到一份不存在那个章节的文档 ——
//     他要么以为"契约丢了"，要么按旁边的章节瞎猜。
//
// 本鱼清理 docs 时就删掉过 M1 的 §4（看起来只是文件清单，实际每行都带「关键点」，
// 而 `src/main/extract.ts` / `src/main/index.ts` 各有注释引用它）。
//
// 判据：**每一个被代码注释引用的 `文档 + §章节号`，在文档里都必须真实存在**。
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const ROOT = process.cwd()

/** 收集 `{ 文档名: Set(章节号) }`。 */
function collectReferences(): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>()
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(ts|vue)$/.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf8')
        // `docs/M2-实施方案.md §3.4` 形态（反引号或空白分隔都接受）
        for (const m of text.matchAll(/docs\/(M[0-9.A-Za-z-]+-?[^`\s）)]*\.md)[`\s]*§([A-Z0-9][0-9.A-Z]*)/g)) {
          const file = m[1]!
          const section = m[2]!
          if (!map.has(file)) map.set(file, new Set())
          map.get(file)!.add(section)
        }
      }
    }
  }
  for (const dir of ['src', 'test']) walk(path.join(ROOT, dir))
  return map
}

describe('★ 代码注释引用的 docs 章节必须真实存在（清理 docs 时容易静默断链）', () => {
  const refs = collectReferences()

  test('引用的文档文件都存在', () => {
    const missing: string[] = []
    for (const file of refs.keys()) {
      if (!fs.existsSync(path.join(ROOT, 'docs', file))) missing.push(file)
    }
    expect(missing, `这些文档被注释引用但文件不存在：${missing.join(', ')}`).toEqual([])
  })

  test('★ 每个被引用的章节号在对应文档里都能找到', () => {
    const broken: string[] = []
    for (const [file, sections] of refs) {
      const docPath = path.join(ROOT, 'docs', file)
      if (!fs.existsSync(docPath)) continue // 上一条已报
      const text = fs.readFileSync(docPath, 'utf8')
      for (const section of sections) {
        // 章节必须出现在某个标题里：`## 3.4 xxx` / `### 3.4` / `## C.2` / `### A.1`
        // ⚠️ 后面不可以紧跟数字（否则 §3.4 会误匹配 §3.45）
        const re = new RegExp(`^#+ ${section.replace(/\./g, '\\.')}[^0-9]`, 'm')
        if (!re.test(text)) broken.push(`${file} §${section}`)
      }
    }
    expect(broken, `这些注释引用断链了（章节被删或重编号）：${broken.join(', ')}`).toEqual([])
  })

  test('引用总数不为 0（判据自身还活着）', () => {
    // 防"这条测试因为正则失效而假绿"：如果一条引用都匹配不到，
    // 上面两条会永远通过 —— 那就等于没写。
    const total = [...refs.values()].reduce((sum, set) => sum + set.size, 0)
    expect(total, '一条 docs 章节引用都没匹配到 —— 正则可能失效了').toBeGreaterThanOrEqual(10)
  })
})
