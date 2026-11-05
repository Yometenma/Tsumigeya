// 解压服务：系统 bsdtar（mac /usr/bin/tar，Windows %SystemRoot%\System32\tar.exe）。
// 契约：docs/M1-实施方案.md §4（extract.ts 行）与 §6（extract 测试）。
// 流程：先 `-tf` 列出全部条目逐条校验 → 再 `-xf -C dest`；Windows 是 bsdtar，不能传 GNU 专属参数。
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { failure } from './games-store'

const runFile = promisify(execFile)

/** 解压进程的等待上限（大引擎包给足时间）。 */
const MAX_BUFFER = 32 * 1024 * 1024

/**
 * 定位系统的 bsdtar。
 *
 * 平台差异（**CI 首次发版实测炸在这**）：
 * - macOS：`/usr/bin/tar` 就是 bsdtar
 * - Windows：必须用 `%SystemRoot%\System32\tar.exe`（bsdtar）。PATH 上的 `tar` 是 GNU 版，
 *   会把 `C:\...` 当远程主机名报 `tar: Cannot connect to C: resolve failed`
 * - **Linux**（CI 跑 vitest、未来若有 linux 构建）：以前这里没有分支，
 *   `process.env.SystemRoot` 是 undefined 就回落到 `C:\\Windows\\System32\\tar.exe`
 *   → Linux 上直接 **ENOENT**。现在显式：非 Windows 一律走 PATH 上的 `tar`
 */
export function tarBinary(): string {
  if (process.platform === 'darwin') return '/usr/bin/tar'
  if (process.platform !== 'win32') return 'tar'
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows'
  return path.join(systemRoot, 'System32', 'tar.exe')
}

/**
 * 单条归档路径的安全校验（照上游 safeArchiveEntryPath 的判定，再加控制字符）：
 * 拒绝绝对路径、盘符绝对路径、任何 `..` 段、反斜杠、NUL 与控制字符。
 * 纯函数，便于单测直接断言。
 */
export function assertSafeEntry(entry: string): void {
  if (typeof entry !== 'string' || !entry) throw failure('error.unsafeArchive', 'Unsafe path in archive')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(entry)) throw failure('error.unsafeArchive', 'Unsafe path in archive')
  if (entry.includes('\\')) throw failure('error.unsafeArchive', 'Unsafe path in archive')
  if (entry.startsWith('/')) throw failure('error.unsafeArchive', 'Unsafe path in archive')
  if (/^[A-Za-z]:/.test(entry)) throw failure('error.unsafeArchive', 'Unsafe path in archive')
  if (entry.split('/').filter(Boolean).includes('..')) {
    throw failure('error.unsafeArchive', 'Unsafe path in archive')
  }
}

export interface ExtractOptions {
  signal?: AbortSignal
}

/**
 * 解压 archive 到 destination。
 * 注意：core 会以 `services.extractArchive(archive, dest, { signal })` 调用（见 FORK-NOTES patch 说明）。
 */
export async function extractArchive(
  archive: string,
  destination: string,
  { signal }: ExtractOptions = {}
): Promise<void> {
  signal?.throwIfAborted()
  if (!fs.existsSync(archive)) throw failure('error.download', `Archive not found: ${path.basename(archive)}`)

  const tar = tarBinary()
  // ⚠️ ENV 必须带 LANG —— 见 tarEnv() 的注释。这是 mac 真机实测抓到的真 bug。
  const env = tarEnv()
  const listing = await runFile(tar, ['-tf', archive], { signal, maxBuffer: MAX_BUFFER, env })
  for (const entry of listing.stdout.split(/\r?\n/).filter(Boolean)) assertSafeEntry(entry)

  fs.mkdirSync(destination, { recursive: true })
  const args = ['-xf', archive, '-C', destination]
  // `--no-same-owner` 只有 GNU/bsdtar 在 unix 上才安全；Windows 的 tar.exe 不加（§8 已知坑）。
  if (process.platform === 'darwin') args.splice(2, 0, '--no-same-owner')
  await runFile(tar, args, { signal, maxBuffer: MAX_BUFFER, env })
}

/**
 * 给 tar 子进程用的环境变量 —— **必须显式带上 UTF-8 的 LANG**。
 *
 * ===== 这条是 mac 真机实测抓到的真 bug（M6.5，2026-11-05）=====
 *
 * 症状：`test/extract.test.ts` 里「tar 打包 → 解包」那条在 mac 上**必失败**，
 * 报 `Unsafe path in archive`，而 Windows 上一直绿。
 *
 * 根因（实测）：
 *   bsdtar 在**没有 LANG / LC_ALL** 的环境下，会把**非 ASCII 文件名**输出成
 *   **八进制转义**而不是原文：
 *
 *       $ env -u LANG /usr/bin/tar -tf x.tar
 *       ./                      ← ASCII 正常
 *       ./\344\270\255...txt    ← 中文变成八进制转义！
 *
 *   而 `assertSafeEntry` 有一条「**拒绝反斜杠**」的规则（防 Windows 路径穿越），
 *   于是**任何含中文文件名的压缩包都会被判成恶意路径而拒绝解压**。
 *
 * 更隐蔽的是**触发条件**：SSH 会话 / launchctl / 图形应用里 `LANG` 常常是**空的**。
 * 所以这个 bug 只会在「非交互式启动」时出现 —— 用户在终端里手动跑反而正常。
 * 我们自己的验收探针、CI、以及**打包后的 .app 由 Finder 启动**，全都属于这一类。
 *
 * 实测对照（同一台 mac，同一个 tar 包）：
 *   `env -u LANG  tar -tf` → `./\344\270\255...`  ❌ 转义
 *   `LANG=en_US.UTF-8 tar -tf` → `./中文 文件名.txt` ✅ 正常
 *   `LANG=ja_JP.UTF-8  tar -tf` → `./中文 文件名.txt` ✅ 也正常（任意 UTF-8 locale 都行）
 *
 * 所以**不能靠外部 LANG**（我们自己就常常在没有 LANG 的进程里跑），
 * 必须在 spawn 时显式给一个 UTF-8 locale。
 *
 * ⚠️ 为什么不改 `assertSafeEntry` 放行反斜杠：那条规则是**安全判据**，
 *    放行等于给 Windows 路径穿越开门。转义是 tar 的**输出格式问题**，
 *    该在输入侧修（让 tar 输出原文），不是拆掉安全检查。
 *
 * ⚠️ Windows 上不设：`%SystemRoot%\System32\tar.exe`（bsdtar）在 Windows 上
 *    用系统代码页，塞 `LANG` 没有意义且可能改变行为。只在 darwin 设。
 */
export function tarEnv(): NodeJS.ProcessEnv {
  if (process.platform !== 'darwin') return process.env
  return {
    ...process.env,
    // 用 C.UTF-8 而不是 en_US.UTF-8：前者在 mac 上**不保证存在**，
    // 而 macOS 自带 `en_US.UTF-8`（实测可用）。其它 UTF-8 locale 也可以，
    // 关键只是「让 bsdtar 知道该按 UTF-8 输出」。
    LANG: process.env.LANG || 'en_US.UTF-8',
    LC_ALL: process.env.LC_ALL || 'en_US.UTF-8'
  }
}

/** 本机是否有可用的 tar（测试里决定 skip）。 */
export function hasSystemTar(): boolean {
  try {
    return fs.existsSync(tarBinary())
  } catch {
    return false
  }
}
