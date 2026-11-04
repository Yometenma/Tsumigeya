// M4.0 端到端验收探针（在 Electron 主进程里跑，由 scripts/probe-m40.cjs 以文件入口启动）。
//
// ⚠️ 关键设计（本鱼踩过一次才明白）：
//   探针**必须复用真实应用的主进程启动路径**，不能自己 new BrowserWindow 就完事——
//   那样 `tsumi:invoke` 根本没注册（注册发生在 src/main/index.ts 的 whenReady 里），
//   于是每个 invoke 都报 "No handler registered"（第一版就是这么错的）。
//
//   做法：先 `require('../out/main/index.js')` 让真实应用完整启动（建窗口 + 注册 IPC），
//   然后等它的窗口出现，再通过 `webContents.executeJavaScript` 从**渲染层**调 IPC。
//   这样验到的就是用户真实的那条链路。
//
// 验收判据（docs/M4.0-实施方案.md S5/S7）：
//   ① 造一个**没有 launcher.js** 的 mkxpz 模块 → 启动仍然成功（证明走的是 buildLaunchPlan + spawn）
//   ② 真拿到 PID（snapshot.running 里有）
//   ③ prepare 真的写了 mkxp.json，且 gameFolder / RTP 都在我们自己的数据目录下
//   ④ 未知引擎不回退（D57）：ruffle → error.engineNotLaunchable，文案列出支持的引擎
//   ⑤ 引擎页把不支持的引擎标灰（D57 配套）：DOM 里真有标签与说明
//   ⑥ 页面没白屏（consoleErrors 为空 + #app 仍有内容）
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const dataDir = process.env.TSUMIGEYA_DATA_DIR
const REPORT = path.join(__dirname, '..', '.dev-data-m40probe.json')
const BOOT = path.join(__dirname, '..', '.dev-data-m40boot.txt')

try {
  fs.writeFileSync(BOOT, `boot ${Date.now()}\n`, 'utf8')
} catch {
  /* 落盘失败不该阻止启动 */
}

const results = {}
const consoleErrors = []

function record(key, value) {
  results[key] = value
  const shown = typeof value === 'object' ? JSON.stringify(value) : value
  console.log(`[probe] ${key} = ${shown}`)
}

function dump(final) {
  try {
    fs.writeFileSync(REPORT, JSON.stringify(final, null, 2), 'utf8')
  } catch (error) {
    console.error('[probe] 写结果文件失败：', error)
  }
}

/** 写一个引擎模块目录（**故意不写 launcher.js** —— 证明我们不再需要它）。 */
function installModule(folder, manifest) {
  const dir = path.join(dataDir, 'modules', folder)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
}

/** 等某个条件成立（最多 timeoutMs）。 */
function waitFor(check, timeoutMs = 8000, intervalMs = 150) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      let value = null
      try {
        value = check()
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

// ================= 准备假数据（**必须在真实应用启动前**写完）=================
function prepare() {
  installModule('mkxpz', {
    name: 'MKXP-Z',
    version: '1.1.5',
    autodetect: { files: ['Game.ini', 'System'], all_required: false },
    gameArgs: { rgssVersion: { type: 'dropdown', default: '0' } }
  })
  installModule('ruffle', {
    name: 'Ruffle',
    version: '1.0.0',
    autodetect: { extensions: ['swf'] },
    gameArgs: {}
  })

  // mkxpz 的 binary（按 binary-paths 的拼法）；用 shell 脚本当「游戏」
  const mkxpzBin = path.join(
    dataDir, 'modules', 'mkxpz', 'deps', 'mkxpz', 'Z-Universal.app', 'Contents', 'MacOS', 'Z-Universal'
  )
  // mkxpz 的 args 是空数组 → 这里放一个**真实可执行**的程序（node），
  // 它会等 stdin，正好是长跑进程：能验「spawn 成功 + 拿到 PID」。
  // （写 shell 脚本在本机 Windows 上不可执行，第一版就是这么失败的。）
  fs.mkdirSync(path.dirname(mkxpzBin), { recursive: true })
  // ⚠️ 本机是 Windows，**目标平台是 macOS**：mac 版引擎二进制在这里跑不了。
  // 所以本机能验到的层次不同，必须如实记录，不能假装验到了：
  //   · Windows：只验「错误路径 + 中文文案」（真进程验证在单测里用系统 ping/sleep 做过）
  //   · mac/linux：binary 写成 shell 脚本，走完整的 spawn 链路
  const canRunRealBinary = process.platform !== "win32"
  record("platform", process.platform)
  record("canRunRealBinary", canRunRealBinary)
  if (canRunRealBinary) {
    const nodeExe = process.execPath
    fs.writeFileSync(mkxpzBin, `#!/bin/sh\nexec "${nodeExe}" -e "setTimeout(()=>{},120000)"\n`, "utf8")
    fs.chmodSync(mkxpzBin, 0o755)
  } else {
    // Windows：**故意不写可执行文件** —— 我们要验的正是「缺失时给的中文说明对不对」
    record("binaryIntentionallyMissing", true)
  }

  const gameDir = path.join(dataDir, 'game-mkxpz')
  fs.mkdirSync(path.join(gameDir, 'System'), { recursive: true })
  fs.writeFileSync(path.join(gameDir, 'Game.ini'), '[Game]\r\nRTP=RPGVXace\r\n', 'utf8')
  fs.writeFileSync(path.join(gameDir, 'Game.exe'), 'MZ', 'utf8')

  const swfDir = path.join(dataDir, 'game-ruffle')
  fs.mkdirSync(swfDir, { recursive: true })
  fs.writeFileSync(path.join(swfDir, 'game.swf'), 'FWS', 'utf8')

  fs.writeFileSync(
    path.join(dataDir, 'games.json'),
    JSON.stringify(
      {
        mkxpz1: {
          gameTitle: 'mkxpz 测试游戏',
          gamePath: gameDir,
          gameEngine: 'mkxpz',
          gameArgs: {},
          tags: []
        },
        ruffle1: {
          gameTitle: 'ruffle 测试游戏',
          gamePath: swfDir,
          gameEngine: 'ruffle',
          gameArgs: {},
          tags: []
        }
      },
      null,
      2
    ),
    'utf8'
  )
  // 关掉启动前诊断（验的是启动路径本身，不想被诊断拦住）
  fs.writeFileSync(
    path.join(dataDir, 'global-settings.json'),
    JSON.stringify({ diagnoseBeforeLaunch: false }),
    'utf8'
  )
}

prepare()
record('prepared', true)

// ================= 让**真实应用**跑起来（建窗口 + 注册 IPC）=================
require(path.join(__dirname, '..', 'out', 'main', 'index.js'))

app.whenReady().then(async () => {
  try {
    // 等真实窗口出现（src/main/index.ts 在 whenReady 里 createWindow）
    const win = await waitFor(() => {
      const all = BrowserWindow.getAllWindows()
      return all.length > 0 ? all[0] : null
    })
    record('windowReady', true)

    win.webContents.on('console-message', (_event, level, message) => {
      if (level >= 2) consoleErrors.push(message)
    })

    // 等渲染层把 window.tsumi 与首屏渲染好
    await waitFor(() =>
      win.webContents.executeJavaScript(`typeof window.tsumi === 'object' && window.tsumi !== null`)
    )
    await new Promise((resolve) => setTimeout(resolve, 900))
    record('rendererReady', true)

    // ================= ① 从渲染层真调 launch（模块里没有 launcher.js）=================
    const launchProbe = await win.webContents.executeJavaScript(`(async () => {
      try {
        const before = await window.tsumi.invoke('snapshot', {})
        const result = await window.tsumi.invoke('launch', { id: 'mkxpz1', diagnose: false })
        const snap = await window.tsumi.invoke('snapshot', {})
        return {
          ok: true,
          result,
          running: snap.running || [],
          dataPath: snap.dataPath,
          gamesBefore: (before.games || []).length
        }
      } catch (error) {
        // 就算启动失败也要把 dataPath 带回来（那是数据目录断言，与成败无关）
        let dataPath = null
        try {
          const snap = await window.tsumi.invoke('snapshot', {})
          dataPath = snap.dataPath
        } catch {
          dataPath = null
        }
        return { ok: false, error: String((error && error.message) || error), dataPath }
      }
    })()`)
    record('launchProbe', launchProbe)

    const running = launchProbe.running || []
    record('runningCount', running.length)
    record('runningPid', running[0]?.pid ?? null)
    record('hasRealPid', typeof running[0]?.pid === 'number')
    record('dataPath', launchProbe.dataPath)
    record('dataPathIsOurs', path.resolve(String(launchProbe.dataPath || '')) === path.resolve(dataDir))

    // ================= ② prepare 真的写了 mkxp.json =================
    const mkxpJson = path.join(
      dataDir, 'modules', 'mkxpz', 'deps', 'mkxpz', 'Z-Universal.app', 'Contents', 'Game', 'mkxp.json'
    )
    record('mkxpJsonExists', fs.existsSync(mkxpJson))
    if (fs.existsSync(mkxpJson)) {
      const config = JSON.parse(fs.readFileSync(mkxpJson, 'utf8'))
      record('mkxpGameFolder', config.gameFolder)
      record('mkxpGameFolderCorrect', config.gameFolder === gameDirPath())
      record('mkxpRgssVersion', config.rgssVersion)
      record('mkxpRtpInOurDataDir', Array.isArray(config.RTP) && String(config.RTP[0] || '').startsWith(dataDir))
      record('mkxpJsonHasNoLegacyPath', !JSON.stringify(config).toLowerCase().includes('xenolauncher'))
    }

    // ================= ③ 未知引擎被拒（D57）=================
    const ruffleProbe = await win.webContents.executeJavaScript(`(async () => {
      try {
        const result = await window.tsumi.invoke('launch', { id: 'ruffle1', diagnose: false })
        return { rejected: false, result }
      } catch (error) {
        return { rejected: true, message: String((error && error.message) || error) }
      }
    })()`)
    record('ruffleProbe', ruffleProbe)
    record('ruffleRejected', ruffleProbe.rejected === true)
    record('ruffleErrorMentionsEngine', String(ruffleProbe.message || '').includes('ruffle'))
    record('ruffleErrorListsSupported', String(ruffleProbe.message || '').includes('本版本支持'))

    const afterRuffle = await win.webContents.executeJavaScript(`(async () => {
      const snap = await window.tsumi.invoke('snapshot', {})
      return { registered: (snap.running || []).some((item) => item.gameId === 'ruffle1') }
    })()`)
    record('ruffleDidNotRegister', afterRuffle.registered === false)

    // ================= ④ 关掉，验证真能杀 =================
    const stopProbe = await win.webContents.executeJavaScript(`(async () => {
      try {
        return await window.tsumi.invoke('stopGame', { gameId: 'mkxpz1' })
      } catch (error) {
        return { error: String((error && error.message) || error) }
      }
    })()`)
    record('stopProbe', stopProbe)
    const afterStop = await win.webContents.executeJavaScript(`(async () => {
      const snap = await window.tsumi.invoke('snapshot', {})
      return { runningCount: (snap.running || []).length }
    })()`)
    record('runningCountAfterStop', afterStop.runningCount)

    // ================= ⑤ 引擎页：不支持的引擎被标灰 =================
    const enginePage = await win.webContents.executeJavaScript(`(async () => {
      const pageErrors = []
      window.addEventListener('error', (e) => pageErrors.push(String(e.message)))
      // 用侧边栏导航按钮（与用户点的是同一个东西）
      const links = [...document.querySelectorAll('a, .nav-item, aside *')]
      const target = links.find((el) => (el.innerText || '').includes('引擎'))
      if (target) target.click()
      await new Promise((r) => setTimeout(r, 900))

      const tags = [...document.querySelectorAll('.el-tag')].map((el) => el.innerText.trim())
      const dimmed = [...document.querySelectorAll('.engine-card-unavailable')].length
      const warns = [...document.querySelectorAll('.engine-card-warn')].map((el) => el.innerText.trim())
      const cards = document.querySelectorAll('.engine-card').length
      return {
        clickedNav: !!target,
        engineCardCount: cards,
        tagCount: tags.length,
        hasNotLaunchableBadge: tags.some((b) => b.includes('不支持启动')),
        dimmedCount: dimmed,
        warnHintCount: warns.length,
        warnHintText: warns[0] || '',
        bodyMentionsSupported: document.body.innerText.includes('本版本支持'),
        htmlLen: document.querySelector('#app')?.innerHTML.length ?? 0,
        pageErrors
      }
    })()`)
    record('enginePage', enginePage)

    // ================= ⑥ 库页没白屏 =================
    const libraryPage = await win.webContents.executeJavaScript(`(async () => {
      const links = [...document.querySelectorAll('a, .nav-item, aside *')]
      const target = links.find((el) => (el.innerText || '').includes('游戏库'))
      if (target) target.click()
      await new Promise((r) => setTimeout(r, 700))
      return {
        cardCount: document.querySelectorAll('.game-card').length,
        bodyHasTitle: document.body.innerText.includes('mkxpz 测试游戏'),
        htmlLen: document.querySelector('#app')?.innerHTML.length ?? 0
      }
    })()`)
    record('libraryPage', libraryPage)

    record('consoleErrors', consoleErrors)
    record('finalOk', true)
    // 本机（Windows）与目标机（mac）能验到的层次不同，如实记录：
    //   · 真进程链路（拿到 PID + 能关掉）在单测 launchers-spawn-real.test.ts 里用系统 ping/sleep 验过
    //   · 本探针验的是「错误路径 + 中文文案 + UI 标灰 + 数据目录」，这些都是跨平台一致的
    record('verificationLevel', results.canRunRealBinary ? 'full (spawn + pid)' : 'error-path only (windows)')
    dump({ ...results, ok: true })
  } catch (error) {
    record('finalOk', false)
    record('fatal', String((error && error.stack) || error))
    dump({ ...results, ok: false })
  } finally {
    setTimeout(() => app.exit(0), 500)
  }
})

function gameDirPath() {
  return path.join(dataDir, 'game-mkxpz')
}

process.on('uncaughtException', (error) => {
  console.error('[probe] uncaughtException', error)
})
