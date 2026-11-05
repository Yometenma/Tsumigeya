// M4 S3/S4：存档**导出包**的读写（主进程侧 IO）。
//
// ===== 这个文件只做三件事 =====
//
//   ① `exportSaveArchive`  把**整个存档目录**打成 zip（含插件文件）
//   ② `readSaveArchive`    读一个包并**逐文件校验 sha256**（S4 导入的依据）
//   ③ `importSaveArchive`  还原到目标目录，**先把现有文件加 .tsumigeya-bak**
//
// ===== 三条设计决定（都写在注释里了，改之前先读）=====
//
// ⚠️ **打整个目录，不是只打槽**。
//    用户真机上 `Karryn's Prison/www/save/` 里有 `lastsave.autobak` /
//    `sync_data.rpgsave` 这类**游戏插件写的文件**。只打 `file*.rpgsave`
//    会让用户换机后少东西（插件数据丢了，游戏行为就不一样了）。
//    这也是 S1 的判据为什么是「宁可多认，不能漏」——两处取向一致。
//
// ⚠️ **一个字节都不改**。
//    存档是游戏的格式，我们不解析也不加工（方案 §6）。打包 = `readFileSync`
//    原样塞进 zip，导入 = 原样写回。唯一的"加工"是**备份**（那是为了能回退）。
//
// ⚠️ **导出与解包用同一份 `fflate`**。
//    不用 `node:zlib` 的 zip 封装（它没有）；也不用系统 `zip` 命令
//    （Windows 上 `tar.exe` 的行为与参数不同，且在 mac 上要另写一条）。
//    纯 JS 实现两边一致，单测也能直接跑（不依赖系统工具）。
//
// ⚠️ 本文件不 import electron（vitest 直接跑），只 import node 内置 + fflate。

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { zipSync, unzipSync, type Zippable } from 'fflate'
import {
  SAVE_FILES_PREFIX,
  SAVE_MANIFEST_PATH,
  SAVE_MANIFEST_VERSION,
  archiveFileName,
  parseSaveManifest,
  verifyManifestFiles,
  type SaveManifest
} from '../shared/save-archive'

/** 导出的结果（IPC 直接回给渲染层）。 */
export interface ExportSaveResult {
  /** 写出的 zip 绝对路径。 */
  file: string
  /** 打包进去的文件数（含配置与插件文件）。 */
  fileCount: number
  /** zip 的字节数。 */
  size: number
  /** 包内 manifest 的内容（便于 UI 显示"导出了什么"）。 */
  manifest: SaveManifest
}

/** 导入的结果。 */
export interface ImportSaveResult {
  /** 还原到的目录。 */
  dir: string
  /** 写回的文件数。 */
  fileCount: number
  /** 备份出来的文件名（`<原名>.tsumigeya-bak`）—— 用户想回退时找得到。 */
  backups: string[]
  /** 包里的 manifest（UI 可以显示"这个包是什么时候导的"）。 */
  manifest: SaveManifest
}

/** sha256（小写十六进制）。导入端校验用同一个算法 —— 必须一致，否则自己的包自己拒收。 */
export function sha256Hex(input: Uint8Array): string {
  return crypto.createHash('sha256').update(input).digest('hex')
}

// ===== 导出 =====

/**
 * 把存档目录打成 zip。
 *
 * @param sourceDir 存档目录（`listSaves` 给的 `dir`）
 * @param meta      写进 manifest 的元信息（gameTitle / engine / layout）
 * @param outDir    输出目录（调用方决定：用户选的位置，或数据目录下的 exports/）
 * @param at        导出时刻（测试注入；默认 now）
 */
export function exportSaveArchive(input: {
  sourceDir: string
  gameTitle: string
  engine: string
  layout: string
  outDir: string
  at?: Date
}): ExportSaveResult {
  const at = input.at ?? new Date()
  const stat = fs.statSync(input.sourceDir)
  if (!stat.isDirectory()) throw new Error(`存档位置不是目录：${input.sourceDir}`)

  // ⚠️ 只收**平铺文件**。存档目录实测是平的；遇到子目录整体跳过并计数，
  //    由调用方报给用户（而不是悄悄少带——那正是"换机少东西"的成因）。
  const entries = fs
    .readdirSync(input.sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())

  const files: SaveManifest['files'] = []
  const zippable: Zippable = {}
  for (const entry of entries) {
    const full = path.join(input.sourceDir, entry.name)
    const data = fs.readFileSync(full)
    const digest = sha256Hex(data)
    files.push({ name: entry.name, sha256: digest })
    // level 0（不压缩）：存档里已经是压缩/二进制，再压一遍只是白烧 CPU，
    // 而那些 `.rpgsave` 本身就是 JSON 的 LZ 压缩体。
    zippable[`${SAVE_FILES_PREFIX}${entry.name}`] = [data, { level: 0 }]
  }

  const manifest: SaveManifest = {
    gameTitle: input.gameTitle,
    engine: input.engine,
    layout: input.layout,
    exportedAt: at.toISOString(),
    files
  }
  // manifest 用 mtime 之前的固定时间：让同一内容重复导出得到**字节相同**的包
  // （便于用户确认"这两个包是不是同一份"）。
  zippable[SAVE_MANIFEST_PATH] = [
    new TextEncoder().encode(JSON.stringify({ ...manifest, manifestVersion: SAVE_MANIFEST_VERSION }, null, 2)),
    { level: 6 }
  ]

  const zipped = zipSync(zippable, { mtime: at })
  fs.mkdirSync(input.outDir, { recursive: true })
  const file = path.join(input.outDir, archiveFileName(input.gameTitle, at))
  fs.writeFileSync(file, zipped)
  return { file, fileCount: files.length, size: zipped.byteLength, manifest }
}

// ===== 读包（S4 的第一步）=====

/** 读包的结果：要么成功给 manifest + 文件内容，要么给出**可翻译的拒绝原因**。 */
export type ReadArchiveResult =
  | { ok: true; manifest: SaveManifest; files: Map<string, Uint8Array> }
  | { ok: false; reason: 'notZip' | 'noManifest' | 'badManifest' | 'verifyFailed'; detail?: string }

/**
 * 读一个导出包并**逐文件校验**。
 *
 * 校验口径（`verifyManifestFiles`，三个都要空）：missing / extra / mismatch。
 * `extra` 也拒 —— 只接受我们导出的包，包里多一个文件就不是。
 *
 * ⚠️ **解压炸弹**：这里先看 zip 的条目数与总大小，超阈值直接拒。
 *    一个几十 KB 的 zip 能解出几十 GB（zip 格式允许高压缩比的重复内容），
 *    解到一半磁盘满了会把用户的数据目录也撑坏。
 */
export function readSaveArchive(file: string): ReadArchiveResult {
  let raw: Uint8Array
  try {
    raw = fs.readFileSync(file)
  } catch (error) {
    return { ok: false, reason: 'notZip', detail: (error as Error).message }
  }

  let unzipped: Record<string, Uint8Array>
  try {
    unzipped = unzipSync(raw)
  } catch (error) {
    return { ok: false, reason: 'notZip', detail: (error as Error).message }
  }

  const names = Object.keys(unzipped)
  // 解压炸弹护栏：存档不该有几万个文件，也不该解出几十 GB
  const MAX_ENTRIES = 2000
  const MAX_BYTES = 256 * 1024 * 1024
  if (names.length > MAX_ENTRIES) {
    return { ok: false, reason: 'notZip', detail: `条目过多（${names.length}）` }
  }
  let total = 0
  for (const name of names) total += unzipped[name]!.byteLength
  if (total > MAX_BYTES) {
    return { ok: false, reason: 'notZip', detail: `解压后过大（${total} 字节）` }
  }

  const manifestRaw = unzipped[SAVE_MANIFEST_PATH]
  if (!manifestRaw) return { ok: false, reason: 'noManifest' }
  let manifest: SaveManifest | null
  try {
    manifest = parseSaveManifest(JSON.parse(new TextDecoder().decode(manifestRaw)))
  } catch {
    manifest = null
  }
  if (!manifest) return { ok: false, reason: 'badManifest' }

  // 包内实际文件（只认 saves/ 前缀，且**只取文件名部分**）
  const actual: Array<{ name: string; sha256: string }> = []
  const files = new Map<string, Uint8Array>()
  for (const name of names) {
    if (!name.startsWith(SAVE_FILES_PREFIX)) continue
    const bare = name.slice(SAVE_FILES_PREFIX.length)
    if (!bare) continue
    // ⚠️ 子目录一律不收：`basename` 化的写法会让两个不同路径塌成同名，
    //    那正是"同名不同路径"的后门（见 verifyManifestFiles 的 extra 判据）。
    if (bare.includes('/')) return { ok: false, reason: 'verifyFailed', detail: `包内有子目录文件：${name}` }
    const data = unzipped[name]!
    actual.push({ name: bare, sha256: sha256Hex(data) })
    files.set(bare, data)
  }

  const result = verifyManifestFiles(manifest, actual)
  if (result.missing.length || result.extra.length || result.mismatch.length) {
    const parts: string[] = []
    if (result.missing.length) parts.push(`缺 ${result.missing.join(', ')}`)
    if (result.extra.length) parts.push(`多 ${result.extra.join(', ')}`)
    if (result.mismatch.length) parts.push(`内容不符 ${result.mismatch.join(', ')}`)
    return { ok: false, reason: 'verifyFailed', detail: parts.join('；') }
  }

  return { ok: true, manifest, files }
}

// ===== 导入（S4）=====

/**
 * 把包还原到目标目录。
 *
 * ===== 顺序不能变（这是 S4 的硬要求）=====
 *
 *   ① **先校验**（读包 + sha256 全部对上）—— 校验不过就一个字节都不写
 *   ② **再备份现有文件**（每个要覆盖的 `<原名>.tsumigeya-bak`）—— 只要它已存在
 *   ③ 最后才写
 *
 * 为什么备份必须在写之前：写和备份的交界处出问题（磁盘满、断电），
 * 用户手上还剩什么？如果先写后备份，剩下的是**半新半旧**的一堆文件，
 * 既不能玩也不能回退。先备份的话，最坏情况是"没导进来，但原来的都还在"。
 *
 * 备份名沿用 `Game.ini.tsumigeya-bak` 的既有约定（D71 起的同一个后缀），
 * 用户想回退时知道去哪找，也不会因为多了一套命名规则而困惑。
 *
 * ⚠️ **不删多余文件**：目标目录里包内没有的文件（比如用户后来新存的第 6 号档）
 * 原样留着。导入是"把包里的补进去"，不是"把目录变成包的样子"——
 * 后者会删掉用户的存档，那是不可逆的（方案 §6：绝不动用户的东西）。
 */
export function importSaveArchive(input: {
  file: string
  targetDir: string
}): ImportSaveResult {
  const read = readSaveArchive(input.file)
  if (!read.ok) {
    // 用可翻译的键：渲染层要能给中文提示（拒绝原因分四种，见 ReadArchiveResult）
    const error = Object.assign(new Error(`存档包校验失败：${read.reason}`), {
      // 首字母大写：'notZip' → 'NotZip'（locales 的 error.saveArchiveNotZip）
      translationKey: `error.saveArchive${read.reason.charAt(0).toUpperCase()}${read.reason.slice(1)}`,
      translationArguments: { detail: read.detail ?? '' }
    })
    throw error
  }

  fs.mkdirSync(input.targetDir, { recursive: true })

  // ② 备份（**写之前**）：只备份会被覆盖的那些
  const backups: string[] = []
  for (const name of read.files.keys()) {
    const target = path.join(input.targetDir, name)
    if (!fs.existsSync(target)) continue
    const backup = `${target}.tsumigeya-bak`
    // 幂等：已有备份就不覆盖（否则第二次导入会把**上一次导入前**的真存档
    // 覆盖成"上一次导入后的版本"——那等于把退路弄丢了）
    if (fs.existsSync(backup)) continue
    try {
      fs.copyFileSync(target, backup)
      backups.push(path.basename(backup))
    } catch {
      // 备份失败要**中止**（不能带着"没退路"的风险继续写）
      throw Object.assign(new Error(`无法备份 ${name}，已中止导入`), {
        translationKey: 'error.saveBackupFailed',
        translationArguments: { name }
      })
    }
  }

  // ③ 写（原样字节，一个字节不改）
  for (const [name, data] of read.files) {
    fs.writeFileSync(path.join(input.targetDir, name), data)
  }

  return { dir: input.targetDir, fileCount: read.files.size, backups, manifest: read.manifest }
}

/**
 * 默认的导出目录：**用户的下载目录**（不是我们的数据目录）。
 *
 * 为什么：导出的目的就是"带走"。放数据目录里等于又造了一个
 * "用户找不到的第二份"（方案 §6 反对的正是这个）。
 * 拿不到下载目录时退回临时目录 —— 但那种情况极少（mac/Windows 都有 Downloads）。
 */
export function defaultExportDir(homedir: string = os.homedir()): string {
  const downloads = path.join(homedir, 'Downloads')
  return fs.existsSync(downloads) ? downloads : os.tmpdir()
}
