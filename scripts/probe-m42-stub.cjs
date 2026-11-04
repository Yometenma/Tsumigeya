// M4.2 探针的**测试桩**：由 `electron --require <这个文件> <inner>` 预载。
//
// ===== 为什么需要它（以及为什么不能改生产代码）=====
//
// 探针要验「装引擎 / 更新引擎」这两条链路，而它们要下真依赖（NW.js SDK 100+ MB）。
// 探针不能联网，所以要给主进程一个假 fetch。三条可选通道都不合适：
//
//   ① 改 `src/main/index.ts` 加一个 `TSUMIGEYA_PROBE_FAKE_FETCH` 环境变量 —— 为了测试
//      往生产代码里加后门，是最不该做的一种「测试支持」。真出了下载 bug，
//      那个开关的存在只会让人怀疑「是不是没走真 net.fetch」。
//   ② 直接 require `out/main/engines/install.js` —— 不行：主进程被打包成**单文件**
//      `out/main/index.js`（electron-vite 的默认行为），没有独立模块可 require。
//      探针第一版就是这么写错的（报 MODULE_NOT_FOUND）。
//   ③ 走 IPC 的 moduleTask —— 对，但那一步的 fetch 是应用注入的 `net.fetch`。
//
// 于是选第四种：**在进程启动时把 `electron.net.fetch` 这个方法替换掉**。
// 生产代码一行不改，`createCoreHost` 拿到的 `fetchImpl` 仍然指同一个 `net.fetch`，
// 只是那个方法现在是我们塞的假实现。装引擎/更新引擎的调用链**完全照原样跑**。
//
// ===== 桩的边界 =====
//
//   · 只替换 `fetch`（不碰别的方法）
//   · 只服务白名单里的 URL，其它一律抛 —— 「多下了一个依赖」会立刻炸出来
//   · 返回的是**真 zip**（extractArchive 走系统 tar，纯文本解不开）
//   · 只在 `TSUMIGEYA_PROBE_FAKE_NET=1` 时生效（防止被误 require 到真实运行里去）
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

if (process.env.TSUMIGEYA_PROBE_FAKE_NET !== '1') {
  // 没说自己是探针 → 什么都不做，退化成透明预载（不改变任何行为）
  return
}

const counts = {}
/** 造一个能真被 bsdtar 解开的小 zip（内容 = marker）。 */
function tinyZip(marker) {
  // ⚠️ **不要用 os.tmpdir()**：Electron 里这个进程的 %TEMP% 是 EPERM 的
  // （AGENTS.md 的已知坑：受限会话下临时目录整体不可写）。
  // 落到**项目目录内**（与探针结果文件同一个地方，那里一定可写）。
  const base = process.env.TSUMIGEYA_DATA_DIR || path.join(__dirname, '..')
  const dir = fs.mkdtempSync(path.join(base, '.probe-zip-'))
  try {
    fs.writeFileSync(path.join(dir, 'payload.txt'), marker)
    const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : '/usr/bin/tar'
    execFileSync(tar, ['-a', '-c', '-f', path.join(dir, 'out.zip'), '-C', dir, 'payload.txt'])
    return fs.readFileSync(path.join(dir, 'out.zip'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** URL → 内容标记（与 inner 探针里那份保持一致；两处都改才不会跑偏）。 */
const MARKERS = {
  // renpy 的真实下载地址（registry 里就是这个，白名单必须按**真实 URL** 写）
  'https://www.renpy.org/dl/8.5.2/renpy-8.5.2-sdk.zip': 'renpy-sdk',
  // 更新场景：mkxpz 的普通依赖换成这一份
  'https://probe.test/newpayload.zip': 'new-payload',
  // mkxpz 的 4 个依赖（registry 的真实地址）。探针装 mkxpz 是为了让
  // 「reconcileAndPersistGameArgs 补缺省值」有**非空 schema** 可验 ——
  // 否则期望键集是空数组，`every` 恒真，那条判据就是假绿。
  'https://github.com/m5kro/mkxp-z/releases/download/launcher/Z-universal.zip': 'mkxpz-body',
  'https://github.com/m5kro/mkxp-z/releases/download/launcher/RTP.zip': 'RTP',
  'https://github.com/m5kro/mkxp-z/releases/download/launcher/kawariki.zip': 'kawariki',
  'https://github.com/mmontag/chip-player-js/raw/refs/heads/master/public/soundfonts/gmgsx-plus.sf2': 'sf2'
}

const cache = new Map()

function fakeFetch(input) {
  const url = typeof input === 'string' ? input : String(input && input.url ? input.url : input)
  counts[url] = (counts[url] ?? 0) + 1
  const marker = MARKERS[url]
  if (marker === undefined) {
    // 不在白名单 → 明确失败。探针据此能发现「这条链路偷偷请求了别的东西」
    throw new Error(`[probe-stub] 探针不该请求：${url}`)
  }
  let archive = cache.get(marker)
  if (!archive) {
    archive = tinyZip(marker)
    cache.set(marker, archive)
  }
  return Promise.resolve(
    new Response(archive, {
      status: 200,
      headers: { 'content-length': String(archive.byteLength) }
    })
  )
}

function installStub() {
  const electron = require('electron')
  if (!electron || !electron.net) {
    console.error('[probe-stub] 拿不到 electron.net —— 桩没装上（探针会去真联网）')
    return
  }
  // 记录原始实现（探针结束时不需要还原：进程马上就退出了）
  electron.net.fetch = fakeFetch
  // 暴露给 inner 读计数用（它不是模块导出，只能挂全局）
  globalThis.__tsumigeyaProbeFetchCounts = counts
  console.log('[probe-stub] net.fetch 已替换为假实现（白名单 %d 个 URL）', Object.keys(MARKERS).length)
}

installStub()
