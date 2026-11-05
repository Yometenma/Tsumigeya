// `listSaves` 对「存档目录的三种物理状态」的判据（2026-11-05 真机审查发现）。
//
// ===== 这个文件防的是什么 =====
//
// 存档目录在磁盘上有**三种**可能的状态，它们是三件不同的事：
//
//   ① **不存在**（ENOENT）  → 正常：用户还没玩到存档点，游戏还没建那个目录
//                             UI 该说「玩到能存档的地方就有了」
//   ② **存在但读不了**      → 故障：权限不足 / 磁盘错误
//                             UI 该说「位置找到了，但读不进来（查权限）」
//   ③ **存在且可读**        → 正常：列出内容（可能空 = 还没存档，也可能有档）
//
// 原来 `snapshot()` 对 ①② 都返回 null，下游就拿着一句
// 「没找到存档位置（引擎还没识别出来）」糊过去 —— 用户会被引去查引擎识别，
// 而真正的问题（权限）或者根本不是问题（还没存档）就永远说不清。
//
// ⚠️ 真机实例：`苍蓝星` 的 `www/save/` 压根没创建（用户没存过档）。
//    若报成"读不进来，请检查权限"，用户会去查一个**不存在的权限问题**。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { listSaves } from '../src/main/save-store'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-dirstate-'))
})

afterEach(() => {
  // 权限改回来再删（否则 rmSync 可能失败）
  try {
    fs.chmodSync(path.join(root, 'game', 'www', 'save'), 0o755)
  } catch {
    /* 目录可能不存在 */
  }
  fs.rmSync(root, { recursive: true, force: true })
})

/** 造一个 MV 游戏目录（`main` 指向 www/ → 位置是 www/save）。 */
function makeGame(withPackageJson = true): string {
  const dir = path.join(root, 'game')
  fs.mkdirSync(path.join(dir, 'www'), { recursive: true })
  if (withPackageJson) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ main: 'www/index.html' }))
  }
  return dir
}

describe('★ ① 目录不存在 = 正常（还没存档），不是故障', () => {
  test('www/save 没创建 → empty:true，**不是** dirReadable:false', () => {
    const dir = makeGame()
    const listing = listSaves(dir, 'nwjs', '苍蓝星')

    // 位置是知道的（main 指向 www → www/save）
    expect(listing.location).not.toBeNull()
    expect(listing.location!.relativeDir).toBe('www/save')
    // 关键：这是"还没存档"，不是"读不了"
    expect(listing.empty, '目录不存在被报成"有存档"了').toBe(true)
    expect(listing.dirReadable, '目录不存在被报成"读不进来"了（用户会去查一个不存在的权限问题）').toBe(
      undefined
    )
  })

  test('目录不存在时 UI 会走 empty 分支（不是 unreadable / unknown）', () => {
    // 与 shared/save-view 联动验一次：这里直接断言形态
    const dir = makeGame()
    const listing = listSaves(dir, 'nwjs', '苍蓝星')
    expect(listing.empty).toBe(true)
    expect(listing.dirReadable).toBeUndefined()
    expect(listing.location).not.toBeNull()
  })
})

describe('★ ② 目录存在但读不了 = 故障（去查权限）', () => {
  // ⚠️ `chmod 000` 只在 POSIX 上真的挡住读取：
  //   · Windows 上 chmod 是空操作（NTFS 用 ACL，Node 的 chmodSync 不映射）
  //   · root 用户无视权限位
  // 所以这条只在「非 Windows + 非 root」时跑 —— 在 CI（ubuntu，普通用户）上是生效的。
  const canTestUnreadable =
    process.platform !== 'win32' && !(typeof process.getuid === 'function' && process.getuid() === 0)

  test.skipIf(!canTestUnreadable)('chmod 000 → dirReadable:false + 位置仍然给出', () => {
    const dir = makeGame()
    const saveDir = path.join(dir, 'www', 'save')
    fs.mkdirSync(saveDir, { recursive: true })
    fs.writeFileSync(path.join(saveDir, 'file1.rpgsave'), 'PK')

    fs.chmodSync(saveDir, 0o000)
    const listing = listSaves(dir, 'nwjs', '存档')
    // 关键：位置**照实给出**（不是 null —— null 会被 UI 说成"引擎还没识别"）
    expect(listing.location, '读不了时把位置也丢了 → UI 会误报"引擎没识别"').not.toBeNull()
    expect(listing.location!.relativeDir).toBe('www/save')
    expect(listing.dir).toBeTruthy()
    // 关键：明确告诉 UI 这是"读不了"
    expect(listing.dirReadable, '读不了却没标记 dirReadable').toBe(false)
    // 别把读不了说成"还没存档"（那样用户以为自己没存过档）
    expect(listing.empty).toBe(false)
  })

  // 跨平台都能跑的等价判据：**路径存在但是个文件**（stat 成功、readdir 必失败）
  test('★ 路径指向文件（不是目录）→ 不崩，且不报成"有存档"', () => {
    const dir = makeGame()
    const saveDir = path.join(dir, 'www', 'save')
    fs.mkdirSync(saveDir, { recursive: true })
    fs.rmdirSync(saveDir)
    // 把 save 换成一个同名文件：stat 成功但不是目录
    fs.writeFileSync(saveDir, 'I am a file, not a dir')

    const listing = listSaves(dir, 'nwjs', '存档')
    // 这种异常不该崩（用户游戏目录可能被人手改成奇怪的样子）
    expect(listing.location).not.toBeNull()
    // `not-dir` 在 inspectDir 里归到"没东西可列"—— 不该报有存档，也不该报读不了
    expect(listing.slots).toEqual([])
    expect(listing.empty).toBe(true)
  })
})

describe('★ ③ 存在且可读 = 正常列出', () => {
  test('有档 → 槽列出来，dirReadable 缺省（正常）', () => {
    const dir = makeGame()
    const saveDir = path.join(dir, 'www', 'save')
    fs.mkdirSync(saveDir, { recursive: true })
    fs.writeFileSync(path.join(saveDir, 'file1.rpgsave'), 'PK')
    fs.writeFileSync(path.join(saveDir, 'config.rpgsave'), 'CFG')

    const listing = listSaves(dir, 'nwjs', '正常')
    expect(listing.slots.map((s) => s.name)).toEqual(['file1.rpgsave'])
    expect(listing.configs.map((s) => s.name)).toEqual(['config.rpgsave'])
    expect(listing.empty).toBe(false)
    expect(listing.dirReadable).toBeUndefined()
  })

  test('目录存在但空着 → empty:true（"玩到存档点就有了"）', () => {
    const dir = makeGame()
    fs.mkdirSync(path.join(dir, 'www', 'save'), { recursive: true })
    const listing = listSaves(dir, 'nwjs', '空目录')
    expect(listing.empty).toBe(true)
    expect(listing.dirReadable).toBeUndefined()
  })
})

describe('★ 位置真的不知道时才是 location:null', () => {
  test('引擎名不认识 → location:null（这才是"不知道在哪"）', () => {
    const dir = makeGame()
    const listing = listSaves(dir, 'unknown-engine-xyz', '未知')
    expect(listing.location).toBeNull()
    expect(listing.dir).toBeNull()
    // 这种才是 unknown 文案该出现的地方
    expect(listing.dirReadable).toBeUndefined()
  })
})
