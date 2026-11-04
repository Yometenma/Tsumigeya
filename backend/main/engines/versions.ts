// M4.1 S3：NW.js 多版本「可下载列表」（D60 / §3.3）。
//
// ===== 为什么这个文件必须存在，而且必须联网 =====
//
// 上游 navjs 的 `gameArgs.version` 是 `multi-version` 类型，配 `"version-script": "nwjs.js"`。
// 上游那个 `nwjs.js` 干的事是：**拉 `https://nwjs.io/versions.json`**（实测 129 KB、
// 381 个版本、其中 380 个带 sdk flavor），筛出「含 sdk 且含 osx-x64 / osx-arm64」的，
// 拼成 `{ v0.119.2: { x86_64: {link, unzip}, arm64: {...} } }`。
//
// ⚠️⚠️ **方案 §3.3 写的是「扫 deps 目录下有哪些子目录」——那是错的。**
//    扫本地目录只能知道「装了什么」，拿不到「能装什么」。
//    照方案实现的结果：版本管理弹窗里「可下载」列表永远是空的 —— 用户看到的是
//    「已安装：无 / 可下载：无」，功能直接死掉。
//
// 所以这里**照上游的真实行为实现**（联网拉 nwjs.io），但：
//   · 不加载上游的 `nwjs.js`（那是模块文件，我们不再下载模块目录）
//   · 解析逻辑自己写，带超时 + 失败降级（返回空列表 + 一条可读 warning，**不抛错**）
//
// ===== 为什么「失败不抛错」=====
//
// 这个列表是给「用户想装一个 NW.js 版本」用的。拉不到时应该：
//   · 弹窗照常打开，已安装列表照常显示（本地信息永远可用）
//   · 「可下载」区域显示空 + 一句「暂时拿不到版本列表」
// 而不是让整个弹窗崩掉、连已装的版本都看不见。
//
// 这正好与 D17 的代理现实对上：nwjs.io 在用户开系统代理时才通，主进程的 net.fetch 走代理（D9）。
import type { EngineBuild, EngineDependency } from '../engines/types'

/** 可下载列表的形状：`{ v0.119.2: { x86_64: {...}, arm64: {...} } }`（与上游 nwjs.js 一致）。 */
export type AvailableVersions = Record<string, EngineDependency>

/** nwjs.io 的版本清单地址（与上游 nwjs.js 用的同一个）。 */
export const NWJS_VERSIONS_URL = 'https://nwjs.io/versions.json'

/** 拉取超时：识别/装版本是用户点一下就要有反馈的动作，不能让它挂着。 */
const FETCH_TIMEOUT_MS = 10_000

/**
 * 从 nwjs.io 的版本清单里筛出「能装到 mac 上」的版本。
 *
 * 筛选规则（**与上游逐条一致**，改一条就等于换了一组可装版本）：
 *   1. 必须有 `sdk` flavor（普通版没有调试能力，且上游也只给 sdk）
 *   2. 必须同时有 `osx-x64` 与 `osx-arm64` 两个文件标记（缺一个就拼不出该架构的地址）
 *   3. 地址按 `https://dl.nwjs.io/<version>/nwjs-sdk-<version>-osx-<arch>.zip` 拼
 *
 * 导出的目的是**单测能直接断言这份筛选逻辑**（不联网也能验：喂一个假的 versions.json）。
 */
export function pickMacBuilds(payload: unknown): AvailableVersions {
  const versionEntries =
    payload && typeof payload === 'object' && Array.isArray((payload as { versions?: unknown }).versions)
      ? ((payload as { versions: unknown[] }).versions ?? [])
      : []

  const out: AvailableVersions = {}
  for (const raw of versionEntries) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as { version?: unknown; files?: unknown; flavors?: unknown }
    const version = typeof entry.version === 'string' ? entry.version.trim() : ''
    if (!version) continue

    const files = Array.isArray(entry.files) ? entry.files.map(String) : []
    const flavors = Array.isArray(entry.flavors) ? entry.flavors.map(String) : []
    // 规则 1：只要 sdk（上游注释 "Only include SDK flavor downloads cuz they are better for debugging"）
    if (!flavors.includes('sdk')) continue
    // 规则 2：两个 mac 架构都得有，否则这个版本在 mac 上必有一半装不了
    if (!files.includes('osx-x64') || !files.includes('osx-arm64')) continue

    // DIRECTORY 名里本来就带 v（`v0.119.2`），用它拼 URL 与目录名都对
    const arch = (name: string): EngineBuild => ({
      link: `https://dl.nwjs.io/${version}/nwjs-sdk-${version}-osx-${name}.zip`,
      unzip: true
    })
    out[version] = { x86_64: arch('x64'), arm64: arch('arm64') }
  }
  return out
}

export interface FetchVersionsResult {
  available: AvailableVersions
  /** 拉取失败时的可读说明（成功时为 null）。**不抛错**，见文件头。 */
  warning: string | null
}

/**
 * 联网拉 NW.js 的可用版本列表。
 *
 * `fetchImpl` 是注入的（生产是 Electron 的 net.fetch，走系统代理 —— D9）；
 * 单测传一个假的，就不需要联网。
 */
export async function fetchNwjsVersions(
  fetchImpl: (input: string, init?: unknown) => Promise<Response>,
  signal?: AbortSignal
): Promise<FetchVersionsResult> {
  try {
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    const response = await fetchImpl(NWJS_VERSIONS_URL, { signal: combined })
    if (!response.ok) {
      return { available: {}, warning: `无法获取 NW.js 版本列表：HTTP ${response.status}` }
    }
    const payload = await response.json()
    const available = pickMacBuilds(payload)
    if (Object.keys(available).length === 0) {
      // 拿到了但筛出 0 个：要么格式变了，要么这份清单里没有 mac 的 sdk 构建。
      // 这**不是**「用户网络不好」，所以给一句不一样的话。
      return { available: {}, warning: 'NW.js 版本列表里没有可用的 macOS SDK 构建' }
    }
    return { available, warning: null }
  } catch (error) {
    // 用户主动取消要照常抛出（不然「取消」会变成「拿到空列表」）
    signal?.throwIfAborted()
    const message = (error as Error)?.message ?? String(error)
    return { available: {}, warning: `无法获取 NW.js 版本列表：${message}` }
  }
}
