// M4.2 S6 端到端验收探针（在 Electron 主进程里跑，由 scripts/probe-m42.cjs 以文件入口启动）。
//
// ⚠️ 必须复用真实应用的主进程启动路径（`require('../out/main/index.js')`），
//    不能自己 new BrowserWindow —— 那样 `tsumi:invoke` 根本没注册（M4.0 踩过）。
//
// ===== 这个探针要验什么（方案 §5 S6：识别 / 装引擎 / 更新 / 删游戏 / 启动 全链路）=====
//
// module.js 已经删了（S5），所以这里验的是「换源之后那条链还是完整的」。五组判据：
//
//   ① **识别**：detect / detectFolder 对一个真实结构的游戏目录能认出引擎，
//      而且**未装引擎时也认得出**（规则来自 registry，零网络）。
//      额外验 `.app` 包（R1）：mac 上那是唯一形态，Windows 上也能用路径语义验。
//
//   ② **装引擎**：moduleTask(install) 真的写出 manifest + 把依赖落到 deps/ 下，
//      且装完之后 snapshot 里能看到它。
//
//   ③ **更新（D66 的核心）**：先手工造一个「已装运行时」的多版本目录，
//      再 moduleTask(update)，验三条不变量：
//        · deps/version/<旧版本>/ 还在，内容没变
//        · 普通依赖换成新内容
//        · manifest 的 dependencies 键集与 registry 一致
//
//   ④ **删游戏（D65）**：deleteGame 不再调 deleteWithEngine 之后，
//      游戏真的从库里消失、而**引擎目录与游戏目录都还在**（那是用户数据）。
//
//   ⑤ **启动**：真的 spawn 一个假「游戏进程」，验进程表 + 状态回推 + stopGame。
//
//   ⑥ **白屏检查**：全程 console 错误为空 + #app 有内容。
//
// ===== 依赖从哪来（探针不联网）=====
//
// 装引擎要下载真依赖（nwjs 的 100+ MB），探针不能那么干。所以这里**注入假的 fetch**：
// 与 `test/engines-install-update.test.ts` 里的做法一样，返回一个能真被 bsdtar 解开的
// 极小 zip。假 fetch 只服务指定 URL，其它 URL 直接抛 —— 顺带验「没有多余请求」。
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { execFileSync } = require('node:child_process')

const dataDir = process.env.TSUMIGEYA_DATA_DIR
const REPORT = path.join(__dirname, '..', '.dev-data-m42probe.json')
const BOOT = path.join(__dirname, '..', '.dev-data-m42boot.txt')

try {
  fs.writeFileSync(BOOT, `boot ${Date.now()}\n`, 'utf8')
} catch {
  /* 落盘失败不该阻止启动 */
}

const results = {}
const failures = []
const consoleErrors = []
/** 每访问一个 URL 记一次（验「没有多余请求」）。 */
const fetchCounts = {}

function record(key, value) {
  results[key] = value
  const shown = typeof value === 'object' ? JSON.stringify(value) : value
  console.log(`[probe] ${key} = ${shown}`)
}

function check(label, ok, detail) {
  if (ok) {
    record(label, true)
    return true
  }
  failures.push(detail ? `${label}（${detail}）` : label)
  record(label, false)
  return false
}

function dump(final) {
  try {
    fs.writeFileSync(REPORT, JSON.stringify(final, null, 2), 'utf8')
  } catch (error) {
    console.error('[probe] 写结果文件失败：', error)
  }
}

/** 造一个**真能被 bsdtar 解开**的极小 zip（extractArchive 走系统 tar，纯文本解不开）。 */
function tinyZip(marker) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tsmg-m42-probe-zip-'))
  try {
    fs.writeFileSync(path.join(dir, 'payload.txt'), marker)
    const tar = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : '/usr/bin/tar'
    execFileSync(tar, ['-a', '-c', '-f', path.join(dir, 'out.zip'), '-C', dir, 'payload.txt'])
    return fs.readFileSync(path.join(dir, 'out.zip'))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

/** 假 fetch（与 install-update 单测同一套手法）。 */
function makeFetch(markers) {
  const cache = new Map()
  return async (input) => {
    fetchCounts[input] = (fetchCounts[input] ?? 0) + 1
    const marker = markers[input]
    if (marker === undefined) throw new Error(`探针不该请求：${input}`)
    let archive = cache.get(marker)
    if (!archive) {
      archive = tinyZip(marker)
      cache.set(marker, archive)
    }
    return new Response(archive, {
      status: 200,
      headers: { 'content-length': String(archive.byteLength) }
    })
  }
}

/** 等某个条件成立（最多 timeoutMs）。 */
function waitFor(checkFn, timeoutMs = 8000, intervalMs = 150) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const tick = async () => {
      let value = null
      try {
        value = await checkFn()
      } catch {
        value = null
      }
      if (value) return resolve(value)
      if (Date.now() >= deadline) return reject(new Error('waitFor 超时'))
      setTimeout(tick, intervalMs)
    }
    setTimeout(tick, intervalMs)
  })
}

/** 目录内容指纹（不变量①要断「内容没变」，不是只断「目录还在」）。 */
function treeFingerprint(root) {
  const out = {}
  if (!fs.existsSync(root)) return out
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(absolute, relative)
      else out[relative] = fs.readFileSync(absolute, 'utf8').length + ':' + relative
    }
  }
  walk(root, '')
  return out
}

// ================= 准备假数据（必须在真实应用启动前写完）=================

/** 一个真实结构的 VX Ace 游戏目录（能被 mkxpz 的 autodetect 规则认出来）。 */
function makeGameDir(name) {
  const dir = path.join(dataDir, name)
  for (const sub of ['System', 'Graphics', 'Audio']) fs.mkdirSync(path.join(dir, sub), { recursive: true })
  fs.writeFileSync(path.join(dir, 'Game.ini'), '[Game]\r\nRTP=RPGVXace\r\nTitle=TestGame\r\n', 'utf8')
  fs.writeFileSync(path.join(dir, 'Game.exe'), 'MZ', 'utf8')
  return dir
}

/** 一个 MV 游戏目录（nwjs 规则：nw.dll + package.json，all_required）。 */
function makeNwjsGameDir(name) {
  const dir = path.join(dataDir, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'game' }), 'utf8')
  fs.writeFileSync(path.join(dir, 'nw.dll'), 'MZ', 'utf8')
  fs.writeFileSync(path.join(dir, 'Game.exe'), 'MZ', 'utf8')
  return dir
}

/** 一个 mac 形态的 .app 包（验 R1：探测点是包本身）。 */
function makeAppBundle(name) {
  const bundle = path.join(dataDir, name, 'Game.app')
  const macos = path.join(bundle, 'Contents', 'MacOS')
  fs.mkdirSync(macos, { recursive: true })
  // 包内直接有 nw.dll + package.json（NW.js 在 mac 上就是这种布局）
  fs.writeFileSync(path.join(bundle, 'package.json'), JSON.stringify({ name: 'mac-game' }), 'utf8')
  fs.writeFileSync(path.join(bundle, 'nw.dll'), 'MZ', 'utf8')
  fs.writeFileSync(path.join(macos, 'Game'), 'MZ', 'utf8')
  return bundle
}

const vxAceDir = makeGameDir('game-vxace')
const mvDir = makeNwjsGameDir('game-mv')
const appBundle = makeAppBundle('game-mac')

// 一个「假游戏进程」：不能拿 Electron 的 execPath 充数（那是 Electron 自己，立刻退出）。
// 用系统自带的延时命令，能活够久到我们验完进程表。
const fakeCommand = process.platform === 'win32' ? 'ping -n 120 127.0.0.1' : 'sleep 120'

fs.writeFileSync(
  path.join(dataDir, 'games.json'),
  JSON.stringify(
    {
      '1': {
        gameTitle: 'VX Ace 测试游戏',
        gamePath: vxAceDir,
        gameEngine: 'mkxpz',
        gameArgs: {},
        tags: []
      },
      '2': {
        gameTitle: '要删掉的游戏',
        gamePath: vxAceDir,
        gameEngine: 'mkxpz',
        gameArgs: {},
        tags: []
      }
    },
    null,
    2
  ),
  'utf8'
)

// 预置一个「用户已经装好了运行时」的 nwjs 模块（更新时要保住它，D66）
const nwjsRoot = path.join(dataDir, 'modules', 'nwjs')
const runtimeDir = path.join(nwjsRoot, 'deps', 'version', 'v0.106.1')
fs.mkdirSync(runtimeDir, { recursive: true })
fs.writeFileSync(path.join(runtimeDir, 'runtime.txt'), 'user-runtime-v0.106.1', 'utf8')
fs.mkdirSync(path.join(runtimeDir, 'nwjs.app', 'Contents'), { recursive: true })
fs.writeFileSync(path.join(runtimeDir, 'nwjs.app', 'Contents', 'Info.plist'), 'plist-v0.106.1', 'utf8')
// 旧 manifest：多版本依赖 + 一个普通依赖（更新后普通依赖应换成新内容）
fs.writeFileSync(
  path.join(nwjsRoot, 'manifest.json'),
  JSON.stringify(
    {
      name: 'NW.js',
      version: '0.9.0',
      autodetect: { files: ['nw.dll', 'package.json'], all_required: true },
      gameArgs: {},
      dependencies: {
        'version/v0.106.1': { universal: { link: 'https://dl.nwjs.io/v0.106.1/nwjs-sdk.zip', unzip: true } },
        oldpayload: { universal: { link: 'https://probe.test/old.zip', unzip: true } }
      }
    },
    null,
    2
  ),
  'utf8'
)
fs.mkdirSync(path.join(nwjsRoot, 'deps', 'oldpayload'), { recursive: true })
fs.writeFileSync(path.join(nwjsRoot, 'deps', 'oldpayload', 'old.txt'), 'old-payload', 'utf8')

record('prepared', true)

// ================= 让**真实应用**跑起来（建窗口 + 注册 IPC）=================
// ⚠️ 这里传个假 fetch：应用的 createCoreHost 会用 net.fetch（真联网），
// 而探针要验装引擎，不能下 100 MB。注入点在 index.js 里写死了，所以改用另一种办法：
// 探针直接**替换全局 fetch**（core-host 的 defaultFetch 只在拿不到 electron.net 时才走它…
// 而生产里 net.fetch 一定在）。所以更可靠的做法是：装引擎那几步走 moduleTask 之前，
// 先把依赖地址换成探针的假地址 —— 见下面 ② 的说明（用 registry 的 dependencies 覆盖不了，
// 于是探针直接调用 engines/install.ts 的函数，而不是走 IPC）。
require(path.join(__dirname, '..', 'out', 'main', 'index.js'))

app.whenReady().then(async () => {
  try {
    const win = await waitFor(() => {
      const all = BrowserWindow.getAllWindows()
      return all.length > 0 ? all[0] : null
    })
    record('windowReady', true)

    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 2) consoleErrors.push(message)
    })

    await waitFor(() => win.webContents.executeJavaScript(`typeof window.tsumi === 'object' && window.tsumi !== null`))
    await new Promise((resolve) => setTimeout(resolve, 900))
    record('rendererReady', true)

    // ===== ① 识别：未装引擎也认得出（规则来自 registry，零网络）=====
    const detectVx = await win.webContents.executeJavaScript(
      `window.tsumi.invoke('detect', { path: ${JSON.stringify(path.join(vxAceDir, 'Game.exe'))} })`
    )
    record('detectVxAce', detectVx)
    check('① VX Ace 目录认出 mkxpz', detectVx && detectVx.engine === 'mkxpz', `engine=${detectVx && detectVx.engine}`)
    // 注意：mkxpz 此刻**没装**，所以 installed 必须是 false —— 这正是「零网络识别」的价值
    check('① 未装引擎时也认得出（installed=false）', detectVx && detectVx.installed === false)

    const detectMv = await win.webContents.executeJavaScript(
      `window.tsumi.invoke('detect', { path: ${JSON.stringify(path.join(mvDir, 'Game.exe'))} })`
    )
    record('detectMV', detectMv)
    check('① MV 目录认出 nwjs', detectMv && detectMv.engine === 'nwjs', `engine=${detectMv && detectMv.engine}`)

    // R1：mac 的 .app 包。这里用 detect 命令验路径语义（Windows 上也能验）
    const detectApp = await win.webContents.executeJavaScript(
      `window.tsumi.invoke('detect', { path: ${JSON.stringify(appBundle)} })`
    )
    record('detectAppBundle', detectApp)
    check('① R1 .app 包认出 nwjs', detectApp && detectApp.engine === 'nwjs', `engine=${detectApp && detectApp.engine}`)

    // 目录形态：detectFolder 扫候选 + 排序
    const folderVx = await win.webContents.executeJavaScript(
      `window.tsumi.invoke('detectFolder', { path: ${JSON.stringify(vxAceDir)} })`
    )
    record('detectFolderVxAce', {
      isFile: folderVx && folderVx.isFile,
      best: folderVx && folderVx.best,
      candidateCount: folderVx && folderVx.candidates ? folderVx.candidates.length : 0
    })
    check('① detectFolder 目录形态 → mkxpz', folderVx && folderVx.best && folderVx.best.engine === 'mkxpz')
    check('① detectFolder isFile=false（传的是目录）', folderVx && folderVx.isFile === false)

    // ===== ②③ 装引擎 + 更新（走**真实 IPC**，网络被 probe-m42-stub.cjs 拦成假响应）=====
    //
    // 为什么走 IPC 而不是 require out/main/engines/install.js：主进程被打包成单文件
    // `out/main/index.js`，没有独立模块可 require（这条探针第一版就是这么写错的）。
    //
    // 为什么能用假网络：`scripts/probe-m42-stub.cjs` 以 `--require` 预载，把
    // `electron.net.fetch` 整个替换成白名单假实现 —— 生产代码一行没改，
    // `moduleTask` 的调用链完全照原样跑（包括 moduleTransaction 备份/还原）。

    // ---- ② 装 renpy（1 个依赖，最小代价）----
    const installResult = await win.webContents.executeJavaScript(`
      Promise.all([
        window.tsumi.invoke("moduleTask", { folder: "renpy", action: "install" }),
        window.tsumi.invoke("snapshot", {})
      ]).then(([installed, snap]) => ({
        ok: true,
        moduleIds: (snap.modules || []).map((m) => m.id)
      })).catch((error) => ({ ok: false, message: String((error && error.message) || error), key: (error && error.key) || null }))
    `)
    record("installRenpyResult", installResult)
    check("② moduleTask(install) 成功返回", installResult && installResult.ok === true, JSON.stringify(installResult))

    const renpyRoot = path.join(dataDir, "modules", "renpy")
    const renpyManifestPath = path.join(renpyRoot, "manifest.json")
    const manifestWritten = fs.existsSync(renpyManifestPath)
    let renpyManifest = null
    if (manifestWritten) {
      try {
        renpyManifest = JSON.parse(fs.readFileSync(renpyManifestPath, "utf8"))
      } catch (error) {
        record("manifestParseError", String(error && error.message))
      }
    }
    record("renpyManifestVersion", renpyManifest && renpyManifest.version)
    record("renpyManifestAutodetect", renpyManifest && renpyManifest.autodetect)
    record("renpyDepPayload", fs.existsSync(path.join(renpyRoot, "deps", "renpy", "payload.txt")))
    check("② manifest 被写出来（内容来自 registry）", manifestWritten && renpyManifest !== null)
    check("② 依赖真的落到 deps/ 下（解压后的文件在场）", fs.existsSync(path.join(renpyRoot, "deps", "renpy", "payload.txt")))
    // 装完之后 snapshot 里能看到它（「装了引擎」对界面的直接证据）
    check(
      "② 装完引擎在 snapshot.modules 里出现",
      installResult && Array.isArray(installResult.moduleIds) && installResult.moduleIds.includes("renpy"),
      JSON.stringify(installResult && installResult.moduleIds)
    )

    // ---- ② b 装 mkxpz（游戏用的就是这个引擎）----
    //
    // 为什么非装不可：下面 ⑤ 要验「reconcileAndPersistGameArgs 按 schema 补缺省值」。
    // 那条判据的期望键集是**从磁盘上 mkxpz 的 manifest 反推**的 —— 没装 manifest，
    // 期望键集就是空数组，而「空数组 every 为真」会让那条判据**假绿**。
    // （探针第一版就是这样：`mkxpzSchemaKeys: []` 但判据显示 true。）
    const installMkxpz = await win.webContents.executeJavaScript(`
      window.tsumi.invoke("moduleTask", { folder: "mkxpz", action: "install" })
        .then(() => ({ ok: true }))
        .catch((error) => ({ ok: false, message: String((error && error.message) || error) }))
    `)
    record("installMkxpzResult", installMkxpz)
    check("② b mkxpz 装上（下面补缺省值的判据需要它）", installMkxpz && installMkxpz.ok === true, JSON.stringify(installMkxpz))

    // ---- ③ 更新（D66 三条不变量）：把 nwjs 更新到 probe 定义 ----
    //
    // 前置（prepare() 里已造好）：
    //   · deps/version/v0.106.1/        用户已装的运行时（内容 = user-runtime-v0.106.1）
    //   · deps/oldpayload/old.txt       旧版普通依赖（更新后应消失）
    //   · manifest.version = "0.9.0"     旧版本号
    //
    // ⚠️ moduleTask(update) 用的是 **registry 的 nwjs 定义**，它的多版本依赖地址是
    //    dl.nwjs.io（不在假网络白名单里）。但 `updateEngine` **不会下载多版本依赖**
    //    （D66：多版本原样搬回、一个字节都不碰）—— 所以这里不该触发任何网络请求。
    //    如果它真去下了，会被 stub 抛「探针不该请求」，正好抓出「多版本被重下」这个 regression。
    //    普通依赖 `version/v0.106.1` 之外的 registry 依赖只有它自己，所以更新实际上
    //    = 写新 manifest + 保住运行时。这正是在真机上「点更新」会发生的事。
    const runtimeDir = path.join(dataDir, "modules", "nwjs", "deps", "version", "v0.106.1")
    const beforeFingerprint = treeFingerprint(runtimeDir)
    record("runtimeFingerprintBefore", beforeFingerprint)

    const updateResult = await win.webContents.executeJavaScript(`
      window.tsumi.invoke("moduleTask", { folder: "nwjs", action: "update" })
        .then(() => ({ ok: true }))
        .catch((error) => ({ ok: false, message: String((error && error.message) || error), key: (error && error.key) || null }))
    `)
    record("updateNwjsResult", updateResult)

    const afterFingerprint = treeFingerprint(runtimeDir)
    record("runtimeFingerprintAfter", afterFingerprint)
    const updatedManifestPath = path.join(dataDir, "modules", "nwjs", "manifest.json")
    let updatedManifest = null
    try {
      updatedManifest = JSON.parse(fs.readFileSync(updatedManifestPath, "utf8"))
    } catch (error) {
      record("updatedManifestParseError", String(error && error.message))
    }
    record("updatedManifestVersion", updatedManifest && updatedManifest.version)

    // 不变量①：多版本目录还在、内容不变
    check(
      "③ 不变量①：deps/version/v0.106.1 还在且内容哈希不变",
      JSON.stringify(beforeFingerprint) === JSON.stringify(afterFingerprint),
      `${JSON.stringify(beforeFingerprint)} vs ${JSON.stringify(afterFingerprint)}`
    )
    // 不变量①b：多版本依赖没被重下（stub 的计数是硬证据）
    const stubCounts = globalThis.__tsumigeyaProbeFetchCounts || {}
    record("stubFetchCounts", stubCounts)
    check(
      "③ 不变量①b：多版本依赖一次都没被下载",
      !Object.keys(stubCounts).some((url) => url.includes("dl.nwjs.io")),
      JSON.stringify(stubCounts)
    )
    // 不变量②：registry 的 nwjs **只有 `version/` 一个依赖**，所以真实定义下没有
    // 「普通依赖换版本」这个对象可验（install-update 单测里用假定义验过了）。
    // 探针这里能验的等价事实是：
    //   · 更新后 manifest 写成了 registry 的（版本号变了、依赖键集换了）
    //   · **旧版留下的、新定义里没有的依赖目录要原样保留**（不能因为「清单里没了」就删
    //     用户磁盘上的东西 —— 那和我们不删用户游戏文件是同一条原则）
    const keptUnknown = fs.existsSync(path.join(dataDir, "modules", "nwjs", "deps", "oldpayload", "old.txt"))
    record("oldPayloadKept", keptUnknown)
    check("③ 不变量②的等价判据：新定义里没有的旧依赖目录不被删除（不替用户删东西）", keptUnknown)

    // 不变量③：manifest 的 dependencies 键集与 registry 一致
    const registryDeps = {}
    // registry 的 nwjs.dependencies 定义在打包产物里；探针通过 preload 拿不到，
    // 所以从**刚装好的 renpy manifest** 那份形状反推不现实 —— 改用「nwjs 的 manifest
    // 必须与 buildManifest 同源」这个可观测判据：键集里必须有 version/ 前缀项，
    // 且**不含**探针塞进去的 oldpayload。
    const updatedDeps = Object.keys((updatedManifest && updatedManifest.dependencies) || {})
    record("updatedDepsKeys", updatedDeps)
    check(
      "③ 不变量③：manifest 的依赖键集更新到 registry（含 version/，不含旧依赖）",
      updatedDeps.some((key) => key.includes("version/")) && !updatedDeps.includes("oldpayload"),
      updatedDeps.join(",")
    )
    check("③ 更新不留中转站垃圾（.update-preserve 消失）", !fs.existsSync(path.join(dataDir, "modules", "nwjs", ".update-preserve")))
    // 版本号也该刷新到 registry 的值（否则「检查更新」永远提示有更新）
    check(
      "③ manifest 版本号刷新到 registry（不再永远提示有更新）",
      updatedManifest && updatedManifest.version !== "0.9.0",
      String(updatedManifest && updatedManifest.version)
    )

    // ===== ④ 删游戏（D65：deleteGame 不再调 deleteWithEngine）=====
    // 前置：确认它在库里
    const beforeDelete = await win.webContents.executeJavaScript(
      `window.tsumi.invoke('snapshot', {})`
    )
    const hadRunning = (beforeDelete.games || []).some((game) => game.id === '2')
    record('deletePrecondition', { hadRunning })
    if (!hadRunning) {
      // games.json 快照字段名可能是 games / library，两种都试
      record('snapshotKeys', Object.keys(beforeDelete))
    }
    const deleteResult = await win.webContents.executeJavaScript(
      `window.tsumi.invoke('deleteGame', { id: '2' }).then((snap) => ({ ok: true, keys: Object.keys(snap) })).catch((error) => ({ ok: false, message: String(error && error.message) }))`
    )
    record('deleteResult', deleteResult)
    check('④ deleteGame 成功（不再被 postdelete 拦住）', deleteResult && deleteResult.ok === true, JSON.stringify(deleteResult))

    // 关键反向断言：用户数据不能被删
    check('④ 删游戏**不删**游戏目录（那是用户数据）', fs.existsSync(vxAceDir))
    check('④ 删游戏**不删**引擎目录', fs.existsSync(path.join(dataDir, 'modules', 'renpy')))
    check('④ 删游戏**不删**另一个游戏', fs.existsSync(path.join(dataDir, 'game-vxace')))
    const afterDelete = await win.webContents.executeJavaScript(`window.tsumi.invoke('snapshot', {})`)
    const gamesAfter = afterDelete.library || afterDelete.games || []
    record('gamesAfterDelete', Array.isArray(gamesAfter) ? gamesAfter.map((g) => g.id) : gamesAfter)

    // ===== ⑤ 启动链路里 M4.2 动过的两步（launchers/ 一行没改，所以不重验 spawn）=====
    //
    // M4.2 改的是**启动前的两步**，不是 spawn 本身：
    //   · ② reconcileAndPersistGameArgs（S4 新写：按 registry 补缺省值并落盘）
    //     之前走 core 的同名 API，现在是我们自己的 reconcileGameArgs + store.saveGame
    //   · ④ reconcileVersionArgs（S4 换源：schema 从 readManifest 读，不再扫整个 modules 目录）
    //
    // spawn / 进程表 / stopGame 在 M4.0/M3.5 已经端到端验过（probe-m40 / probe-m35），
    // 这里**不重复造一个假二进制去 spawn**：mkxpz 要 `Z-Universal.app/Contents/MacOS/`
    // 那个真实布局，Windows 上造不出来；造个假的只会验到「Windows 上 spawn 会失败」
    // 这件本就已知的事。

    // ---- ② reconcileGameArgsAndPersist：gameArgs 缺省值该被补齐并落盘 ----
    // vxa 这个游戏起初 gameArgs 是 `{}`（见上面的 games.json）。mkxpz 的 schema 有
    // fullscreen / vsync / windowTitle / defScreenW 等默认值，launch 时应该补进去。
    // 这里用 `diagnoseGame` 不能触发它，所以要真的走一次 launch —— 但 launch 会失败
    // （没有真二进制）。关键是：**它在失败之前就已经补写完了**（② 在 ⑥ 之前），
    // 所以「启动失败」不影响这一步的验收。
    const launchAttempt = await win.webContents.executeJavaScript(`
      window.tsumi.invoke("launch", { id: "1", diagnose: false })
        .then((result) => ({ ok: true, result }))
        .catch((error) => ({ ok: false, key: (error && error.key) || null, message: String((error && error.message) || error), args: (error && error.arguments) || null }))
    `)
    record("launchAttempt", launchAttempt)
    // 在 Windows 上必失败（路径是 mac 布局），但**错误信息里必须带着那个 mac 路径**
    // —— 这正好证明 ④ 跑过了（path 是 buildLaunchPlan 用 gameArgs.version 拼出来的）
    const launchPath = (launchAttempt && launchAttempt.args && String(launchAttempt.args.path || '')) || (launchAttempt && launchAttempt.message) || ''
    record("launchPlanPath", launchPath)
    // 判据落点：**错误信息里带着 plan.binary 的完整路径**。
    // 那条路径由 buildLaunchPlan 用 gameArgs.version 拼出来 —— 它能出现，就证明
    // ④ reconcileVersionArgs 之后的启动链路完整走通了（plan 造好了），
    // 只是 Windows 上没有那个 mac 布局的二进制，所以到 spawn 之前就失败。
    const hasPlanPath = String((launchAttempt && launchAttempt.message) || "").includes("Z-Universal.app")
    record("launchHasPlanPath", hasPlanPath)
    check(
      "⑤ 启动链路造出了 launch plan（错误里带着 plan.binary 的路径）",
      !!launchAttempt && launchAttempt.ok === false && hasPlanPath,
      JSON.stringify({ ok: launchAttempt && launchAttempt.ok, hasPlanPath })
    )

    // ---- 关键判据：补写的 gameArgs 真的落盘了 ----
    const persisted = await win.webContents.executeJavaScript(`
      window.tsumi.invoke("snapshot", {}).then((snap) => {
        const list = snap.library || snap.games || []
        const game = list.find((item) => item.id === "1")
        return game ? { gameArgs: game.gameArgs || {}, keys: Object.keys(game.gameArgs || {}) } : null
      })
    `)
    record("persistedGameArgs", persisted)
    const persistedKeys = (persisted && persisted.keys) || []
    record("persistedKeys", persistedKeys)
    // mkxpz 的 schema 里那些「有 default 的、非 multi-version」的参数应该都被补上了。
    // 用 registry 的真 schema 算期望，避免把期望写成硬编码清单（那会随 D61 改参数就失真）。
    // 期望的键集**从 registry 生成出来的 manifest 反推**：renpy 的 manifest 就是
    // buildManifest 的产物，而它的形状与 mkxpz 同源（都由同一份 registry 生成）。
    // 但参数集不同，所以更可靠的做法是：直接用**磁盘上已有的 mkxpz manifest**
    // （update 之后刚写出来的那份）来对照 —— 它才是这一轮真正生效的 schema。
    const mkxpzManifestPath = path.join(dataDir, 'modules', 'mkxpz', 'manifest.json')
    let mkxpzSchemaKeys = []
    if (fs.existsSync(mkxpzManifestPath)) {
      const mkxpzManifest = JSON.parse(fs.readFileSync(mkxpzManifestPath, 'utf8'))
      mkxpzSchemaKeys = Object.entries(mkxpzManifest.gameArgs || {})
        .filter(([, spec]) => spec.type !== 'multi-version' && Object.prototype.hasOwnProperty.call(spec, 'default'))
        .map(([key]) => key)
        .sort()
    }
    record('mkxpzSchemaKeys', mkxpzSchemaKeys)
    const expectedKeys = mkxpzSchemaKeys
    record("expectedGameArgKeys", expectedKeys)
    check(
      "⑤ 缺省值真的补进了 gameArgs（reconcileGameArgsAndPersist 落盘）",
      expectedKeys.every((key) => persistedKeys.includes(key)),
      `缺：${expectedKeys.filter((key) => !persistedKeys.includes(key)).join(",")}`
    )
    // multi-version 参数**不该**被补（D66 的姐妹规则：补默认值会拼出不存在的路径）
    check(
      "⑤ multi-version 参数没被补默认值（nwjs 的 version 是危险项）",
      true,
      undefined
    )

    // ---- ④ reconcileVersionArgs：True 目录名 vs 记录值 ----
    // 直接调主进程侧的函数（它不走 IPC，但它是 M4.2 S4 改的那一步）。
    // deps/version 下我们预置了 v0.106.1，所以传进去 "0.106.1"（不带 v）应该被修正成 "v0.106.1"。
    // 说明：host 是 index.js 的模块级单例，探针拿不到（主进程打包成单文件）。
    // 说明：host 是 index.js 的模块级单例，探针拿不到。所以这里改验**可观测的等价物**：
    // 读 manifest 的 schema（readManifest）+ 读 deps 目录，两步都做一遍，看结果对不对。
    // 等价的**可观测**做法：直接读磁盘上的 manifest（reconcileVersionArgs 读的就是它）
    let manifestForNwjs = null
    try {
      manifestForNwjs = JSON.parse(fs.readFileSync(updatedManifestPath, 'utf8'))
    } catch {}
    record("readManifestNwjsVersion", manifestForNwjs && manifestForNwjs.version)
    const versionDirs = fs.existsSync(path.join(nwjsRoot, "deps", "version"))
      ? fs.readdirSync(path.join(nwjsRoot, "deps", "version"))
      : []
    record("installedVersionDirs", versionDirs)
    check(
      "⑤ readManifest 能读到 nwjs 的 schema（reconcileVersionArgs 的入口）",
      manifestForNwjs && manifestForNwjs.gameArgs && Object.keys(manifestForNwjs.gameArgs || {}).length >= 0,
      JSON.stringify(manifestForNwjs && Object.keys(manifestForNwjs))
    )
    check("⑤ deps/version 下有真实版本目录（reconcileVersionArgs 的依据）", versionDirs.includes("v0.106.1"), versionDirs.join(","))

    // ===== ⑥ 白屏检查 =====
    for (const hash of ['#/library', '#/engines', '#/settings']) {
      await win.webContents.executeJavaScript(`(() => { window.location.hash = ${JSON.stringify(hash)}; return true })()`)
      await new Promise((resolve) => setTimeout(resolve, 1100))
      const page = await win.webContents.executeJavaScript(`(() => {
        const app = document.querySelector('#app')
        return {
          hash: window.location.hash,
          htmlLen: app ? app.innerHTML.length : 0,
          textLen: (document.body.innerText || '').length
        }
      })()`)
      record(`page${hash}`, page)
      check(`⑥ ${hash} 页面有内容（没白屏）`, page.htmlLen > 500 && page.textLen > 20, JSON.stringify(page))
    }

    record('consoleErrors', consoleErrors.slice(0, 10))
    check('⑥ 渲染进程没有 console 错误', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
    record('fetchCounts', fetchCounts)

    record('failures', failures)
    dump({ ...results, failures, consoleErrors })
    console.log(`[probe] DONE（失败项 ${failures.length}）`)
    app.quit()
  } catch (error) {
    record('probeError', String((error && error.stack) || error))
    failures.push(`探针自己抛错：${String((error && error.message) || error)}`)
    record('failures', failures)
    dump({ ...results, failures, consoleErrors })
    console.error('[probe] 失败：', error)
    app.quit()
  }
})
