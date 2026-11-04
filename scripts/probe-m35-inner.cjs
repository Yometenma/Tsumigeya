// M3.5 端到端验收探针（在 Electron 主进程里跑，由 scripts/probe-m35.cjs 以文件入口启动）。
//
// 验收判据（docs/M3.5-实施方案.md §8 的 S3/S4/S5）：
//   S3 启动后进程表有记录（真 PID）、play-stats.json 落盘、能关掉（真的杀掉）
//   S4 snapshot.running 有该游戏；gameStarted / gameExited 事件真的发出来
//   S5 详情页显示「正在运行（已 N 秒）」+ 关闭按钮；卡片有绿点（**没有关闭按钮**）
//   反面判据：未运行时不显示运行条；重复启动被拒；停止后运行条消失
//
// 探针不用真引擎（Windows 上没有 mac 二进制），而是造一个**假的 mkxpz 模块**，
// 它的 launcher.js 照上游形态写（`exec(cmd, cb)` 且丢弃返回值）——
// 这恰好是 M3.5 要解决的那个形态。cmd 用当前 node 起一个长睡进程当「游戏」。
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')

const OUT = path.join(__dirname, '..', 'out')
const dataDir = process.env.TSUMIGEYA_DATA_DIR
const REPORT = path.join(__dirname, '..', '.dev-data-m35probe.json')
const BOOT = path.join(__dirname, '..', '.dev-data-m35boot.txt')

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

async function evaluate(window, code) {
  return await window.webContents.executeJavaScript(code, true)
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 造一个假的 mkxpz 模块：launcher 照上游形态写（exec + 丢弃返回值）。 */
function installFakeEngine() {
  const dir = path.join(dataDir, 'modules', 'mkxpz')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      name: 'mkxp-z',
      version: '1.0.0',
      autodetect: { extensions: ['exe'], files: ['Data'] }
    })
  )
  // ⚠️ 这就是上游 launcher 的真实形态：exec 的返回值被丢掉。
  // 拿不到 PID 才是 M3.5 要修的病；能拿到说明注入生效了。
  //
  // 「游戏」本身用系统命令起一个长睡进程（跨平台各挑一个自带命令，
  // 不依赖 node 在 PATH 上——探针里最容易翻车的就是这个假设）：
  //   Windows：ping -n 120 127.0.0.1（约 120 秒）
  //   其它：sleep 120
  const command =
    process.platform === 'win32' ? 'ping -n 120 127.0.0.1' : 'sleep 120'
  fs.writeFileSync(
    path.join(dir, 'launcher.js'),
    [
      "const { exec } = require('child_process')",
      `const COMMAND = ${JSON.stringify(command)}`,
      'exports.launch = function (gamePath, folder, args, title, ui) {',
      '  exec(COMMAND, () => {})',
      '}',
      ''
    ].join('\n')
  )
}

/** 造一个「能通过诊断」的游戏目录。 */
function makeGame() {
  const dir = path.join(dataDir, 'fake-game')
  fs.mkdirSync(path.join(dir, 'Data'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'Game.exe'), 'MZ')
  fs.writeFileSync(path.join(dir, 'Data', 'Scripts.rvdata2'), '')
  return dir
}

require(path.join(OUT, 'main', 'index.js'))

app.whenReady().then(async () => {
  await wait(1500)
  const window = BrowserWindow.getAllWindows()[0]
  if (!window) {
    console.error('[probe] 没有窗口！')
    dump({ fatal: 'no window' })
    app.exit(1)
    return
  }

  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) consoleErrors.push(message)
  })

  try {
    record('bridgeType', await evaluate(window, 'typeof window.tsumi'))

    // ===== ① 准备：假引擎 + 假游戏 =====
    installFakeEngine()
    const gamePath = makeGame()
    record('gamePath', gamePath)

    const saved = await evaluate(
      window,
      `window.tsumi.invoke('saveGame', {
         game: { gameTitle: 'M3.5 探针游戏', gamePath: ${JSON.stringify(gamePath)}, gameEngine: 'mkxpz', gameArgs: {} }
       }).then((s) => ({ ok: true, ids: s.games.map((g) => g.id), running: s.running }),
                    (e) => ({ ok: false, message: (e.message || '').slice(0, 160) }))`
    )
    record('saveGame', saved)
    if (!saved.ok) throw new Error(`saveGame 失败：${saved.message}`)
    const gameId = saved.ids[saved.ids.length - 1]
    record('gameId', gameId)

    // 关掉启动前诊断（假游戏目录本身能过诊断，但关掉更稳，让本探针只验进程管理）
    await evaluate(window, `window.tsumi.invoke('saveSettings', { diagnoseBeforeLaunch: false })`)

    // ⚠️ 上面这些都是**直接调 IPC**，绕过了 Pinia store。页面读的是 store 里的状态，
    // 所以必须再走一次 store 的 applySnapshot 把它接上（真实用户点按钮走的就是这条路径：
    // 详情页 launch → store.launch → 主进程 → 事件 + snapshot）。
    await evaluate(
      window,
      `(async () => {
         // Pinia 把 store 挂在 #app 的 __vue_app__ 上
         try {
           const app = document.querySelector('#app').__vue_app__
           window.__tsmgPinia = app ? app.config.globalProperties.$pinia : null
         } catch { window.__tsmgPinia = null }
         if (window.__tsmgPinia) {
           const lib = window.__tsmgPinia._s.get('library')
           if (lib) await lib.load()
         }
         return !!window.__tsmgPinia
       })()`
    )
    // ===== ② S3：启动（走 store，与真实用户点按钮同一条路径）=====
    //
    // ⚠️ 必须走 store 而不是直接 invoke：页面读的是 store 里的 running（snapshot 的投影），
    // 直接 invoke 只改主进程的表，界面上什么都不会变——那样探针验的是「IPC 能跑」，
    // 不是「用户点了按钮会看到什么」。
    const launched = await evaluate(
      window,
      `(async () => {
         const pinia = window.__tsmgPinia
         const lib = pinia && pinia._s.get('library')
         if (!lib) return { ok: false, message: 'store 拿不到（探针接线问题）' }
         try {
           const r = await lib.launch(${JSON.stringify(gameId)}, false)
           return { ok: true, result: r }
         } catch (e) { return { ok: false, message: (e.message || '').slice(0, 160) } }
       })()`
    )
    record('launchResult', launched)
    if (!launched.ok) throw new Error(`launch 失败：${launched.message}`)

    // exec 的回调是异步的；给一点时间让 onSpawn 跑到
    await wait(700)

    const runningAfterLaunch = await evaluate(window, `window.tsumi.invoke('runningGames')`)
    record('runningCount', runningAfterLaunch.length)
    record('runningPid', runningAfterLaunch[0] && runningAfterLaunch[0].pid)
    record('runningEngine', runningAfterLaunch[0] && runningAfterLaunch[0].engine)
    record('hasRealPid', !!(runningAfterLaunch[0] && typeof runningAfterLaunch[0].pid === 'number' && runningAfterLaunch[0].pid > 0))
    record('hasCommand', !!(runningAfterLaunch[0] && runningAfterLaunch[0].command))
    record('execPathParsed', runningAfterLaunch[0] && runningAfterLaunch[0].execPath)

    // 游玩记录真的落盘了吗（S1 的生产形态）
    const statsFile = path.join(dataDir, 'play-stats.json')
    record('playStatsExists', fs.existsSync(statsFile))
    if (fs.existsSync(statsFile)) {
      const stats = JSON.parse(fs.readFileSync(statsFile, 'utf8'))
      record('playStat', stats[gameId] ?? null)
      record('playCountIsOne', (stats[gameId] || {}).playCount === 1)
    }

    // ===== ③ S4：snapshot.running 同步出现了 =====
    const snapshot = await evaluate(window, `window.tsumi.invoke('snapshot')`)
    record('snapshotRunningIds', (snapshot.running || []).map((item) => item.gameId))
    record('snapshotHasRunning', (snapshot.running || []).some((item) => item.gameId === gameId))
    record('snapshotRunningHasNoCommand', (snapshot.running || []).every((item) => item.command === undefined))

    // ===== ④ S5：详情页 DOM（运行态 + 关闭按钮）=====
    await evaluate(window, `window.location.hash = '#/game/${gameId}'`)
    await wait(900)
    const detailRunning = await evaluate(
      window,
      `(() => {
        const body = document.body.innerText
        const hasRunningBar = !!document.querySelector('.detail-running')
        const stopButtons = [...document.querySelectorAll('.detail-launch')].map((el) => el.textContent.trim())
        return {
          hash: location.hash,
          hasRunningBar,
          runningText: (document.querySelector('.detail-running-text') || {}).textContent || '',
          launchButtonTexts: stopButtons,
          hasCloseButton: stopButtons.some((text) => text.includes('关闭游戏')),
          hasLaunchButton: stopButtons.some((text) => text.includes('启动游戏')),
          bodyHasRunningWord: body.includes('正在运行'),
          htmlLen: document.querySelector('#app').innerHTML.length
        }
      })()`
    )
    record('detailRunningState', detailRunning)

    // ===== ⑤ S5：卡片绿点（库页）=====
    await evaluate(window, `window.location.hash = '#/library'`)
    await wait(700)
    const cardRunning = await evaluate(
      window,
      `(() => {
        const dots = document.querySelectorAll('.game-card-running')
        const cards = document.querySelectorAll('.game-card')
        return {
          hash: location.hash,
          cardCount: cards.length,
          runningDots: dots.length,
          // D41 的精神：卡片上**不该有**关闭按钮
          cardHasStopButton: [...document.querySelectorAll('.game-card button')]
            .some((el) => (el.textContent || '').includes('关闭游戏')),
          htmlLen: document.querySelector('#app').innerHTML.length
        }
      })()`
    )
    record('cardRunningBadge', cardRunning)

    // ===== ⑥ 反面判据：重复启动被拒 =====
    const relaunch = await evaluate(
      window,
      `window.tsumi.invoke('launch', { id: ${JSON.stringify(gameId)}, diagnose: false })
         .then(() => ({ ok: true }), (e) => ({ ok: false, message: (e.message || '').slice(0, 160) }))`
    )
    record('relaunchRejected', !relaunch.ok)
    record('relaunchMessage', relaunch.message)

    // 游玩次数**不该**被失败的第二次启动污染
    if (fs.existsSync(statsFile)) {
      const stats = JSON.parse(fs.readFileSync(statsFile, 'utf8'))
      record('playCountStillOne', (stats[gameId] || {}).playCount === 1)
    }

    // ===== ⑦ S3：关闭游戏（走 store，真杀掉）=====
    const pid = (runningAfterLaunch[0] || {}).pid
    const stopped = await evaluate(
      window,
      `(async () => {
         const pinia = window.__tsmgPinia
         const lib = pinia && pinia._s.get('library')
         if (!lib) return { ok: false, message: 'store 拿不到（探针接线问题）' }
         try {
           const r = await lib.stopGame(${JSON.stringify(gameId)})
           return { ok: true, result: r }
         } catch (e) { return { ok: false, message: (e.message || '').slice(0, 160) } }
       })()`
    )
    record('stopResult', stopped)
    await wait(600)

    // 进程真的没了吗（用系统层确认，不只信我们自己的表）
    let processGone = null
    if (typeof pid === 'number') {
      const probe = spawnSync('node', ['-e', `process.kill(${pid}, 0)`], { encoding: 'utf8' })
      processGone = probe.status !== 0
    }
    record('processReallyGone', processGone)

    const runningAfterStop = await evaluate(window, `window.tsumi.invoke('runningGames')`)
    record('runningCountAfterStop', runningAfterStop.length)

    const snapshotAfterStop = await evaluate(window, `window.tsumi.invoke('snapshot')`)
    record('snapshotRunningAfterStop', (snapshotAfterStop.running || []).length)

    // ===== ⑧ S6：退出的详情页不再显示运行条 =====
    await evaluate(window, `window.location.hash = '#/game/${gameId}'`)
    await wait(800)
    const detailAfterStop = await evaluate(
      window,
      `(() => {
        const hasRunningBar = !!document.querySelector('.detail-running')
        const texts = [...document.querySelectorAll('.detail-launch')].map((el) => el.textContent.trim())
        return {
          hasRunningBar,
          launchButtonTexts: texts,
          hasLaunchButton: texts.some((text) => text.includes('启动游戏')),
          hasCloseButton: texts.some((text) => text.includes('关闭游戏')),
          htmlLen: document.querySelector('#app').innerHTML.length
        }
      })()`
    )
    record('detailAfterStop', detailAfterStop)

    // ===== ⑨ 停止一个没在跑的游戏 → 可翻译的错误 =====
    const stopIdle = await evaluate(
      window,
      `window.tsumi.invoke('stopGame', { gameId: ${JSON.stringify(gameId)} })
         .then((r) => ({ ok: true, result: r }), (e) => ({ ok: false, message: (e.message || '').slice(0, 200) }))`
    )
    record('stopIdleRejected', !stopIdle.ok)
    record('stopIdleKeyDecoded', /gameNotRunning/.test(stopIdle.message || ''))

    record('consoleErrors', consoleErrors)
    record('finalHtmlLen', await evaluate(window, 'document.querySelector("#app").innerHTML.length'))
    record('done', true)
    dump(results)
  } catch (error) {
    record('error', (error && error.stack) || String(error))
    record('consoleErrors', consoleErrors)
    dump(results)
    app.exit(1)
    return
  }
  app.exit(0)
})
