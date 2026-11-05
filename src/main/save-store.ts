// M4 S2：存档读取（主进程侧 IO）。
//
// 这个文件只做「把目录读成快照 → 交给 shared/save-locate 判据 → 再把结果读成 SaveSlot」。
//
// ⚠️ **判据不在这里**：`detectSaveLocation` / `classifySaveEntries` 都在
// `shared/save-locate.ts`（纯函数，有单测）。这里只负责 fs。
// 这条分工的理由见那个文件的头注释：判据错了不会报错，必须有单测钉。
//
// ⚠️ 本文件不 import electron（vitest 直接跑）。
// ⚠️ 只读：本文件**不删不改**任何存档文件。导出与导入是后续步骤，且导入要「先备份」。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  classifySaveEntries,
  detectSaveLocation,
  type DirSnapshot,
  type SaveLayout
} from '../shared/save-locate'

/** 一个存档槽（或配置文件）的可展示元数据。 */
export interface SaveSlot {
  /** 绝对路径 */
  file: string
  /** 文件名（不含目录） */
  name: string
  /** 字节数 */
  size: number
  /** 最后修改时刻（ISO 8601） */
  mtime: string
  /** 槽还是配置（UI 要分开列，否则用户以为 config 是第 0 号存档） */
  kind: 'slot' | 'config'
}

/** 一次「列出存档」的结果。 */
export interface SaveListing {
  /**
   * 探测到的位置；`null` = **没有可靠的存档位置**（Ren'Py 在游戏目录外，或引擎未识别）。
   * 这不是"没存档"，是"不知道去哪找" —— UI 文案要区分这两件事。
   *
   * ⚠️ 只含**可序列化**的两个字段（`layout` / `relativeDir`）。
   *   绝不把整个 `SaveLocation` 放进去 —— 它含 `slotPattern` / `configPattern`
   *   （正则或函数），过 contextBridge 会抛 `An object could not be cloned.`
   *   （用户在 v0.6.1 上实测撞到）。
   */
  location: { layout: SaveLayout; relativeDir: string } | null
  /** 存档目录的绝对路径（`location` 为 null 时是 null）。 */
  dir: string | null
  /** 存档槽（按自然序）。 */
  slots: SaveSlot[]
  /** 配置文件（按自然序）。 */
  configs: SaveSlot[]
  /**
   * 存档目录存在但里面一个存档都没有。
   *
   * 与「目录不存在」要分开：前者可让 UI 说「玩到存档点后会出现」，
   * 后者只能说「不知道这个游戏的存档在哪」。
   */
  empty: boolean
  /**
   * 位置**找到了**，但那个目录读不进来（权限不足 / 被删 / 磁盘错误）。
   *
   * ⚠️ 这是第四种态，不能和 `location: null` 糊在一起（2026-11-05 真机审查发现）：
   *   · `location: null` → **不知道在哪**（引擎没识别 / Ren'Py 在游戏目录外）
   *     → UI 说「没找到存档位置（引擎还没识别）」
   *   · `dirReadable: false` → **知道在哪，但读不了**
   *     → UI 该说「位置找到了，但读不进来（检查权限）」
   * 糊了会把用户引向完全错误的方向（去查引擎识别，而问题在文件权限）。
   *
   * 省略（undefined）= 正常可读。只有读不到时是 `false`。
   */
  dirReadable?: boolean
}

// ===== 目录快照 =====

/** 读一个目录的条目；不存在 / 不是目录 / 无权限 → 一律 null。 */
function snapshot(dirPath: string): DirSnapshot | null {
  try {
    const st = fs.statSync(dirPath)
    if (!st.isDirectory()) return { entries: [], isDir: false }
    return { entries: fs.readdirSync(dirPath), isDir: true }
  } catch {
    return null
  }
}

/**
 * 读 `<游戏>/package.json` 的 `main`（决定 MV/MZ 的存档基准目录）。
 *
 * 为什么必须读它、而不是「看哪个目录有存档」：
 * MV 的存档路径是 `dirname(process.mainModule.filename) + '/save'`，
 * 而 `process.mainModule.filename` 就是 `package.json` 的 `main`。
 * 作者打包时**把自己的旧存档塞进包里**（真机实测：`苍蓝星` 的根 `save/` 里躺着
 * 5 个 2022 年的 `.rpgsave`，而那个目录是解压时新建的、游戏运行时根本不写它）
 * —— 按目录内容判会把别人的旧档当成用户的存档显示出来。
 *
 * 读不到 / 解析失败 → null（判据那边退回目录启发式，不会崩）。
 */
function readPackageMain(root: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(root, 'package.json'), 'utf8')
    const parsed = JSON.parse(raw) as { main?: unknown }
    return typeof parsed.main === 'string' ? parsed.main : null
  } catch {
    return null
  }
}

/** 探测一台游戏上的存档位置并且读出来。 */
export function listSaves(gamePath: string, engine: string, gameTitle = ''): SaveListing {
  // `gamePath` 可能是目录也可能是可执行文件（games.json 里两种都见过）。
  // 统一成目录：与 diagnose.resolveGameDir 同一语义（但这里自己算，不 import，免得绕一圈）
  const root = resolveGameDir(gamePath)

  // Ren'Py 的存档**不在游戏目录**，要先找到它可能的位置再传给判据
  const renpyCandidates = engine === 'renpy' ? renpySaveDirs(gameTitle) : []
  let renpyDir: string | null = null
  let renpySnap: DirSnapshot | null = null
  for (const candidate of renpyCandidates) {
    const snap = snapshot(candidate)
    if (snap?.isDir && snap.entries.length > 0) {
      renpyDir = candidate
      renpySnap = snap
      break
    }
  }

  const location = detectSaveLocation({
    engine,
    root: snapshot(root),
    wwwSave: snapshot(path.join(root, 'www', 'save')),
    gameSave: snapshot(path.join(root, 'save')),
    dataDir: snapshot(path.join(root, 'Data')),
    saveDir: snapshot(path.join(root, 'Save')),
    external: renpySnap,
    packageMain: readPackageMain(root)
  })

  if (!location) {
    return { location: null, dir: null, slots: [], configs: [], empty: false }
  }

  // ⚠️ external 的位置不能 path.join(root, relativeDir) —— 那会拼回游戏目录
  const dir = location.external ? (renpyDir ?? '') : path.join(root, location.relativeDir)
  if (!dir) {
    return { location: null, dir: null, slots: [], configs: [], empty: false }
  }

  const snap = snapshot(dir)
  if (!snap?.isDir) {
    // ===== ⚠️ 「位置知道，但目录读不到」必须与「不知道在哪」分开 =====
    //
    // 这里能走到，说明 detectSaveLocation **已经成功**判出了位置（location 非 null、
    // dir 也拼出来了），只是那个目录现在读不到 —— 权限不足 / 被删 / 磁盘错误。
    //
    // 原来的写法返回 `location: null`，注释还写着「当作没找到」。那就是把两件事糊了：
    //   · `location: null` 的 UI 文案是「没找到这个游戏的存档位置（引擎还没识别出来）」
    //     → 把用户引向**完全错误的方向**：引擎识别得好好的，目录就是访问不了。
    //   · 而这正是 `shared/save-view.ts` 开篇明确反对的：「三种没有存档被糊成一句，
    //     用户就永远查不出问题」。
    //
    // 现在返回 `location` **照实给出**（位置是知道的），slots/configs 空，
    // 并带上 `dirReadable: false` 让 UI 说第四种话：「位置找到了（就在这），但读不进」。
    return {
      location: { layout: location.layout, relativeDir: location.relativeDir },
      dir,
      slots: [],
      configs: [],
      empty: false,
      dirReadable: false
    }
  }

  const { slots, configs } = classifySaveEntries(snap.entries, location)
  return {
    // ⚠️ **绝不能直接返回 location**：它含 `slotPattern` / `configPattern`
    //   （正则或函数），过 contextBridge 会抛
    //   `An object could not be cloned.` —— 这正是用户报的那个错。
    //   渲染层只需要「布局名 + 相对路径」两个字段（见 client.ts 的 SaveListing）。
    location: { layout: location.layout, relativeDir: location.relativeDir },
    dir,
    slots: slots.map((name) => describe(dir, name, 'slot')),
    configs: configs.map((name) => describe(dir, name, 'config')),
    empty: slots.length === 0
  }
}

/** 统计一个文件的大小与修改时间；读不到就退化（不让列存档因为一个坏文件整体失败）。 */
function describe(dir: string, name: string, kind: 'slot' | 'config'): SaveSlot {
  const file = path.join(dir, name)
  try {
    const st = fs.statSync(file)
    return { file, name, size: st.size, mtime: st.mtime.toISOString(), kind }
  } catch {
    return { file, name, size: 0, mtime: '', kind }
  }
}

/**
 * `gamePath` → 目录。
 *
 * 与 `diagnose.resolveGameDir` 是同一逻辑，但**刻意写了第二份**（而不是 import）：
 *   诊断那边是「给诊断用的」，这里是「给存档用的」。两者共用会让
 *   「改诊断的路径规则」意外改变 M4 的存档位置 —— 那种耦合比一处重复更危险。
 *   一旦规则真的需要变，两处都该被看到（有测试分别钉住）。
 */
export function resolveGameDir(gamePath: string): string {
  try {
    if (fs.statSync(gamePath).isFile()) return path.dirname(gamePath)
  } catch {
    /* 不存在：按目录处理 */
  }
  return gamePath
}

/**
 * Ren'Py 的存档位置（**在游戏目录之外**）。
 *
 * mac 上是 `~/Library/RenPy/<游戏名>/`；但我们自己的 `renpy` launcher 会给
 * `--savedir`（见 registry 的 `savedir` 默认值 = `<数据目录>/renpysaves/`），
 * 所以**实际落点取决于那条参数**。
 *
 * ⇒ 这个函数只用于「用户没改 savedir 时的兜底探测」，调用方拿到空列表是正常的。
 */
export function renpySaveDirs(gameTitle: string, homedir: string = os.homedir()): string[] {
  const base = path.join(homedir, 'Library', 'RenPy')
  const safe = gameTitle.replace(/[/\\:*?"<>|]/g, '_')
  return [path.join(base, safe), base]
}
