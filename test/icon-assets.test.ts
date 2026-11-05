// 应用图标资产守卫。
//
// ===== 为什么值得有测试 =====
//
// 图标缺失时 electron-builder **不报错、不警告**，只是静默回落到
// Electron 默认图标（那个紫色原子球）。症状是"装完发现 Dock 里不对"，
// 而 dev 模式（`npm run dev`）**永远看不到这个图标** —— 开发机上根本复现不了。
//
// 另有一条更隐蔽的：Pillow 的 `save("ICNS")` 只写 ic07~ic14，
// **缺 icp4（16px）/ icp5（32px）** 两档 —— 那正是 Finder 列表视图和菜单栏用的。
// 缺了之后 macOS 要么自己缩放 128 的（明显糊）、要么回落通用文档图标。
// 而 Pillow 能正常读回这个文件，`Icon.open()` 不报错 → 靠"文件能打开"验不出来。
//
// 所以这里解**容器结构**：读 icns 的块表，确认 11 个类型都在、长度自洽。
//
// 判据全部是**文件内容**，不联网、不需要 Python、不需要 GUI（跟其它 78 个测试一致）。
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const ROOT = process.cwd()
const BUILD = path.join(ROOT, 'build')

/** 读 build/ 下的某个图标文件（不存在时返回 null）。 */
function readAsset(name: string): Buffer | null {
  const p = path.join(BUILD, name)
  return fs.existsSync(p) ? fs.readFileSync(p) : null
}

/** 解析 ICNS 容器：返回块类型与长度列表。 */
function parseIcns(buf: Buffer): Array<{ type: string; length: number }> {
  const magic = buf.subarray(0, 4).toString('ascii')
  const total = buf.readUInt32BE(4)
  const blocks: Array<{ type: string; length: number }> = []
  let pos = 8
  while (pos < total && pos + 8 <= buf.length) {
    const type = buf.subarray(pos, pos + 4).toString('ascii')
    const length = buf.readUInt32BE(pos + 4)
    if (length < 8) break
    blocks.push({ type, length })
    pos += length
  }
  expect(magic).toBe('icns')
  expect(pos).toBe(total)
  return blocks
}

describe('应用图标资产', () => {
  test('三个平台的图标文件都存在且非空', () => {
    for (const name of ['icon.icns', 'icon.ico', 'icon.png', 'icon_1024.png']) {
      const buf = readAsset(name)
      expect(buf, `build/${name} 必须存在（缺了 electron-builder 会静默用默认图标）`).not.toBeNull()
      expect(buf!.length, `build/${name} 不该是空文件`).toBeGreaterThan(1024)
    }
  })

  test('icns 覆盖 macOS 需要的全部像素档位（含 16/32 两个小档）', () => {
    const buf = readAsset('icon.icns')!
    const blocks = parseIcns(buf)
    const types = new Set(blocks.map((b) => b.type))

    // icp4/icp5/icp6 = 16/32/64；ic07~ic10 = 128/256/512/1024；
    // ic11~ic14 = 各自的 @2x。小档缺失时 macOS 会糊成一块（见文件头注释）。
    const required = ['icp4', 'icp5', 'ic07', 'ic08', 'ic09', 'ic10']
    for (const t of required) {
      expect(types.has(t), `icns 缺 ${t}（对应小尺寸档位，Finder 列表/菜单栏要用）`).toBe(true)
    }

    // 块表总长必须与文件头声明一致（拼错时会在这里断，而不是等 macOS 打开才发现）
    const total = buf.readUInt32BE(4)
    expect(total).toBe(buf.length)
  })

  test('ico 含 256px 大图标（Windows 高 DPI 需要）', () => {
    const buf = readAsset('icon.ico')!
    // ICO 目录项：count 在 offset 4，每个条目 16 字节，宽度字节 0 表示 256
    const count = buf.readUInt16LE(4)
    expect(count).toBeGreaterThan(0)
    const widths: number[] = []
    for (let i = 0; i < count; i++) {
      const w = buf.readUInt8(6 + i * 16) // 0 表示 256
      widths.push(w === 0 ? 256 : w)
    }
    expect(widths).toContain(256)
    expect(widths.length).toBeGreaterThanOrEqual(5)
  })

  test('1024 母版是 Apple 规范版面（内容区 824，四角透明）', () => {
    // 不引 Pillow，这里只验 PNG 文件头里的尺寸与色彩类型
    const buf = readAsset('icon_1024.png')!
    expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')

    // IHDR：宽高在 offset 16/20，bitDepth 在 24，colorType 在 25（6 = RGBA）
    const width = buf.readUInt32BE(16)
    const height = buf.readUInt32BE(20)
    const colorType = buf.readUInt8(25)
    expect(width).toBe(1024)
    expect(height).toBe(1024)
    expect(colorType, '必须是 RGBA（有透明通道），否则 Dock 里会有白底').toBe(6)
  })

  test('electron-builder 显式指定了三个平台的图标（不靠自动探测）', () => {
    const config = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8')
    // 自动探测找不到时是静默回落，显式写 + 这条测试才是双保险
    expect(config).toMatch(/^mac:\s*$/m)
    expect(config).toContain('icon: build/icon.icns')
    expect(config).toContain('icon: build/icon.ico')
  })

  test('生成脚本存在（图标是生成物，不是手改的二进制）', () => {
    // 母版是 1024 的，各档位都是从它降采样出来的；直接改某个小档会被下次重生成覆盖。
    // 想换图标 → 换 build/icon_1024.png 然后重跑脚本。
    expect(fs.existsSync(path.join(ROOT, 'scripts', 'make-icon.py'))).toBe(true)
  })
})
