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

export function tarBinary(): string {
  if (process.platform === 'darwin') return '/usr/bin/tar'
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
  const listing = await runFile(tar, ['-tf', archive], { signal, maxBuffer: MAX_BUFFER })
  for (const entry of listing.stdout.split(/\r?\n/).filter(Boolean)) assertSafeEntry(entry)

  fs.mkdirSync(destination, { recursive: true })
  const args = ['-xf', archive, '-C', destination]
  // `--no-same-owner` 只有 GNU/bsdtar 在 unix 上才安全；Windows 的 tar.exe 不加（§8 已知坑）。
  if (process.platform === 'darwin') args.splice(2, 0, '--no-same-owner')
  await runFile(tar, args, { signal, maxBuffer: MAX_BUFFER })
}

/** 本机是否有可用的 tar（测试里决定 skip）。 */
export function hasSystemTar(): boolean {
  try {
    return fs.existsSync(tarBinary())
  } catch {
    return false
  }
}
