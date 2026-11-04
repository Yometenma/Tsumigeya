// mkxp-z 的两个「非 ASCII 路径」陷阱（M5.2 实测，mac 上逐条验证过）。
//
// ===== 陷阱 1：mkxp.json 里写中文路径 → 解析失败 =====
//
// 实测（Mac, mkxp-z Z-Universal, 2026-11-04）：
//   gameFolder = "/tmp/mkxp-ascii-test"                    → ✅ RGSS version 3
//   gameFolder = ".../傭兵の冒険/傭兵の冒険_CHN"            → ❌ "Failed to parse mkxp.json : Unknown encoding"
//                                                             然后回落到 RGSS version 1 (XP) → 找不到 Scripts.rxdata
//                                                             → mkxp-z 弹窗 "No script file has been specified"
//
// 它的 JSON 读取器会先做一步「编码嗅探」，看到非 ASCII 字节就判失败
// （即使文件本身是合法 UTF-8）。
//
// 试过写成 `\uXXXX` 转义（整份文件纯 ASCII）→ **直接 crash**：
//   NSInvalidArgumentException: -[NSURL initFileURLWithPath:]: nil string parameter
//   at filesystemImpl::normalizePath  ← 它的解码器不认 \u 转义
//
// ⇒ 唯一可行的办法：**给游戏目录建一个纯 ASCII 名字的符号链接**，配置里写链接路径。
//    文件系统会沿链接找到真实的中文目录，mkxp-z 全程只看 ASCII 字符串。
//
// ===== 陷阱 2：Game.ini 的 Title 是 GBK → 整个 ini 读不出来 =====
//
// 实测日志：
//   Could not read Game.ini
//   Game.ini: Could not determine encoding of Game.Title
//
// 真实样本 `傭兵の冒険_CHN/Game.ini` 的 Title 字节是 `d3b6 b1f8 b5c4 c3b0 cfd5`（GBK）。
// mkxp-z 判断不出编码 → **整份 Game.ini 都读不到**（不只是这一行）。
//
// ⇒ 把 `Title=` 改成纯 ASCII 之后，Game.ini 能正常读，RGSS 版本也判对了。
//    （实测：改完 Title + ASCII 链接 → 游戏脚本全部加载、事件线程正常跑起来）

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

/**
 * 路径是否「对 mkxp-z 不安全」——只要含非 ASCII 字符就算。
 *
 * 保守判据：`/[^\x00-\x7F]/`。中文、日文、emoji、全角标点都会命中。
 */
export function needsAsciiAlias(target: string): boolean {
  return /[^\x00-\x7F]/.test(target)
}

/**
 * 给一个含非 ASCII 的路径生成稳定的 ASCII 别名路径（放在临时目录下）。
 *
 * 为什么用 hash 而不是序号：稳定 —— 同一个游戏每次启动拿到同一个链接名，
 * mkxp-z 的路径缓存（`path cache`）才不会每次都失效。
 */
export function asciiAliasPath(target: string, tmpRoot: string = os.tmpdir()): string {
  const hash = createHash('sha1').update(target).digest('hex').slice(0, 12)
  // 同时带上 basename 的 ASCII 部分（纯非 ASCII 时退化成一个固定前缀），便于排障时认得出
  const base = path
    .basename(target)
    .replace(/[^\x00-\x7F]/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .slice(0, 24)
  return path.join(tmpRoot, `tsumigeya-${base ? base + '-' : ''}${hash}`)
}

/** 确保符号链接存在且指向 `target`（已存在但指向别处 → 删掉重建）。 */
export function ensureAsciiAlias(target: string, alias: string): string {
  try {
    const st = fs.lstatSync(alias)
    if (st.isSymbolicLink()) {
      const current = fs.readlinkSync(alias)
      if (path.resolve(current) === path.resolve(target)) return alias
    }
    fs.rmSync(alias, { recursive: true, force: true })
  } catch {
    /* 不存在：下面建 */
  }
  // Windows 上建 symlink 需要管理员权限或开发者模式（否则 EPERM）。
  // 'junction' 目录联接不要求提权，且 node 会自己建目录。
  // mac / linux 上 'junction' 是非法值，必须用 'dir'。
  fs.symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
  return alias
}

/**
 * 把 `Game.ini` 里**无法解码**的 `Title=` 行换成纯 ASCII，返回是否改过。
 *
 * 只碰 `Title=` 这一行 —— 它是显示用的，不参与启动逻辑（`Scripts=` / `Library=` / `RTP=`
 * 都是 ASCII，本来就没问题）。改了不影响游戏内容。
 *
 * 幂等：已经是纯 ASCII 就一个字节都不写（避免每次启动都改文件时间戳）。
 * 备份：第一次修改前写 `Game.ini.tsumigeya-bak`（用户想还原时找得到）。
 */
export function sanitizeGameIniTitle(folder: string): { changed: boolean; backup?: string } {
  const file = path.join(folder, 'Game.ini')
  let raw: Buffer
  try {
    raw = fs.readFileSync(file)
  } catch {
    return { changed: false }
  }

  const lines = raw.toString('latin1').split(/\r?\n/)
  let touched = false
  const out = lines.map((line) => {
    if (!/^Title=/i.test(line)) return line
    // latin1 视角下，非 ASCII 字节表现为 0x80-0xFF 的字符
    const value = line.slice('Title='.length)
    if (/[^\x00-\x7F]/.test(value)) {
      touched = true
      // 用游戏目录名（已剥成 ASCII）当标题更有辨识度；剥完为空就写固定值
      const ascii = path
        .basename(folder)
        .replace(/[^\x00-\x7F]/g, '')
        .replace(/[^A-Za-z0-9._-]/g, '')
      return `Title=${ascii || 'Game'}`
    }
    return line
  })

  if (!touched) return { changed: false }

  const backup = `${file}.tsumigeya-bak`
  if (!fs.existsSync(backup)) {
    try {
      fs.copyFileSync(file, backup)
    } catch {
      /* 备份失败不阻塞：改 Title 本身风险低，且下面写失败会抛 */
    }
  }
  // 用 latin1 写回，保住原有的 CRLF 与其余字节
  fs.writeFileSync(file, out.join('\r\n'), 'latin1')
  return { changed: true, backup }
}
