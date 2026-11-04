// M2 端到端验收探针（在 Electron 主进程里跑）。
// 由 scripts/probe-m2.cjs 以「文件入口」启动。
// 判据照 AGENTS.md「验收 npm run dev 的正确姿势」：
//   1) window.tsumi 是 object；2) #app innerHTML 不塌陷（白屏探针）；
//   3) 新 IPC 命令在渲染层真调得通，错误路径返回正确的 translationKey，且不挂死。
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const OUT = path.join(__dirname, '..', 'out')
const dataDir = process.env.TSUMIGEYA_DATA_DIR
// 结果写到项目目录下（%TEMP% 在受限会话里可能整体 EPERM，见 AGENTS.md 已知坑）
const REPORT = path.join(__dirname, '..', '.dev-data-m2probe.json')
const BOOT = path.join(__dirname, '..', '.dev-data-m2boot.txt')

/** 极早的痕迹：Windows 上 Electron 的 stdout 会丢，先落盘证明脚本真的跑起来了。 */
try {
  fs.writeFileSync(BOOT, `boot ${Date.now()}\n`, 'utf8')
} catch {
  /* 落盘失败也不该阻止启动 */
}

const results = {}
const consoleErrors = []

function record(key, value) {
  results[key] = value
  const shown = typeof value === 'object' ? JSON.stringify(value) : value
  console.log(`[probe] ${key} = ${shown}`)
}

/** Windows 上 Electron 的 stdout 会丢（GUI 子系统），所以结果同时落盘。 */
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

// 主进程入口自己会 whenReady + 建窗口
require(path.join(OUT, 'main', 'index.js'))

app.whenReady().then(async () => {
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const window = BrowserWindow.getAllWindows()[0]
  if (!window) {
    console.error('[probe] 没有窗口！')
    app.exit(1)
    return
  }

  // 渲染层的错误不会打印到主进程，必须从页面里抓（白屏的真凶通常在这）
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) consoleErrors.push(message)
  })

  try {
    record('bridgeType', await evaluate(window, 'typeof window.tsumi'))
    record('hash', await evaluate(window, 'location.hash'))
    record('appHtmlLen', await evaluate(window, 'document.querySelector("#app").innerHTML.length'))
    record('titleText', await evaluate(window, 'document.querySelector(".page-title")?.textContent ?? ""'))

    // 非法 RJ：主进程抛出的 Error 过 contextBridge 后 key 会丢，
    // 但我们的修复把 key 编进了 message（\u0000tsumi-key: 标记）。
    // 这里**同时看两处**：key（若桥没丢）与 message 里的标记（修复生效的证据）。
    record(
      'lookupInvalid',
      await evaluate(
        window,
        `window.tsumi.invoke('dlsiteLookup', { rj: 'nope' }).then(
           () => ({ ok: true }),
           (error) => ({
             ok: false,
             key: error.key ?? null,
             messageHasKeyMarker: (error.message || '').includes('tsumi-key:'),
             message: (error.message || '').slice(0, 60)
           })
         )`
      )
    )

    // 路径不存在 → 空数组，不抛
    record(
      'detectRJEmpty',
      await evaluate(
        window,
        `window.tsumi.invoke('dlsiteDetectRJ', { path: 'C:/nonexistent/plain' }).then(
           (value) => value,
           (error) => ({ key: error.key })
         )`
      )
    )

    // 真实目录名带 RJ → 命中
    // 注意：受限 Windows 会话下 %TEMP% 可能整体 EPERM（AGENTS.md 已知），
    // 所以不建真目录，直接用「字面路径」走识别逻辑——识别对不存在的路径也按字面猜，这正是要验的。
    const rjDir = path.join(dataDir || '.', 'RJ294126 テスト')
    record(
      'detectRJHit',
      await evaluate(
        window,
        `window.tsumi.invoke('dlsiteDetectRJ', { path: ${JSON.stringify(rjDir)} }).then(
           (value) => value,
           (error) => ({ key: error.key })
         )`
      )
    )

    // 网络：本机 DLsite 直连超时（真实场景）。必须给 dlsiteNetwork/Timeout，且**不能挂死**
    const started = Date.now()
    record(
      'lookupNetwork',
      await evaluate(
        window,
        `Promise.race([
           window.tsumi.invoke('dlsiteLookup', { rj: 'RJ294126' }).then(
             (value) => ({ ok: true, title: value.title }),
             (error) => ({ ok: false, key: error.key })
           ),
           new Promise((resolve) => setTimeout(() => resolve({ ok: false, key: 'HUNG' }), 25000))
         ])`
      )
    )
    record('lookupNetworkMs', Date.now() - started)

    // 编辑页要先有一条游戏记录，否则路由会落到「游戏不存在」的空状态（M1 的既有行为）
    const seeded = await evaluate(
      window,
      `window.tsumi.invoke('saveGame', { id: undefined, game: {
         gameTitle: '测试游戏', gamePath: ${JSON.stringify(dataDir + '/RJ294126 テスト')},
         gameEngine: 'mkxpz'
       } }).then(
         (value) => ({ ok: true, count: value.games.length, id: value.games[0]?.id }),
         (error) => ({ ok: false, message: error.message })
       )`
    )
    record('seedGame', seeded)

    // ⚠️ 关键：上面是直接调 IPC，**没有经过 Pinia store**，渲染层的 library.games 还是空的，
    // 编辑页会落到「游戏不存在」空状态。所以必须真重载一次页面，让 App 初始化时自己调 snapshot()。
    // 注意：`location.reload()` 在 executeJavaScript 里不可靠（上下文被销毁，promise 挂住），
    // 用主进程的 webContents.reload() + did-finish-load 才稳。
    const loaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
    window.webContents.reload()
    await loaded
    await new Promise((resolve) => setTimeout(resolve, 900))
    record('afterReloadGames', await evaluate(window, 'document.querySelector(".page-subtitle")?.textContent ?? ""'))

    // 编辑页的 DLsite 面板（组件白屏探针）
    const gameId = seeded?.id ?? '1'
    await evaluate(window, `location.hash = '#/game/${gameId}'`)
    await new Promise((resolve) => setTimeout(resolve, 700))
    record('editRouteHash', await evaluate(window, 'location.hash'))
    record('editHtmlLen', await evaluate(window, 'document.querySelector("#app").innerHTML.length'))
    record('editPageTitle', await evaluate(window, 'document.querySelector(".page-title")?.textContent ?? ""'))
    record('editBodyText', await evaluate(window, 'document.body.innerText.slice(0, 120)'))
    record('dlsiteTextPresent', await evaluate(window, 'document.body.innerText.includes("DLsite")'))
    record(
      'rjInputPresent',
      await evaluate(window, '!!document.querySelector(".dlsite-preview") || document.body.innerText.includes("RJ 号")')
    )

    // 面板里真调一次识别按钮所依赖的 IPC，确认编辑页上下文能拿到候选
    record(
      'editDetectRJ',
      await evaluate(
        window,
        `window.tsumi.invoke('dlsiteDetectRJ', { path: ${JSON.stringify(dataDir + '/RJ294126 テスト')} }).then(
           (value) => value,
           (error) => ({ key: error.key ?? null })
         )`
      )
    )

    // ===== 全链路：查询 → 保存 → snapshot 能读到 → 封面 URL 进渲染层 =====
    record(
      'fullChainSave',
      await evaluate(
        window,
        `(async () => {
           try {
             const work = await window.tsumi.invoke('dlsiteLookup', { rj: 'RJ294126' })
             const snapshot = await window.tsumi.invoke('saveGameMeta', { gameId: '1', work })
             const meta = snapshot.meta['1']
             return {
               ok: true,
               rj: meta?.rj, title: meta?.title, circle: meta?.circle,
               coverUrl: meta?.coverUrl, registDate: meta?.registDate,
               // GameRecord 必须**没有**任何 DLsite 字段（D18 的核心验收）
               gameKeys: Object.keys(snapshot.games[0] || {}).sort()
             }
           } catch (error) {
             return { ok: false, message: (error && error.message) || String(error) }
           }
         })()`
      )
    )

    // 库里要有 meta 后，grid 模式才会渲染封面（重载让 store 重新拉 snapshot）
    const loaded2 = new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
    window.webContents.reload()
    await loaded2
    await new Promise((resolve) => setTimeout(resolve, 900))

    // 重载后停在 #/game/1，必须先回库页才看得到封面（否则 imgCount 恒为 0）
    await evaluate(window, `location.hash = '#/library'`)
    await new Promise((resolve) => setTimeout(resolve, 800))

    record(
      'libraryCoverRendered',
      await evaluate(
        window,
        `(() => {
           const images = Array.from(document.querySelectorAll('.game-card-icon img, .game-row-icon img'))
           return {
             imgCount: images.length,
             srcs: images.map((img) => img.currentSrc || img.src),
             allRemote: images.every((img) => (img.src || '').startsWith('https://img.dlsite.jp/'))
           }
         })()`
      )
    )

    // 封面是不是真的下载成功（naturalWidth > 0 = CSP 与防盗链都过关）
    await new Promise((resolve) => setTimeout(resolve, 800))
    record(
      'coverActuallyLoaded',
      await evaluate(
        window,
        `Array.from(document.querySelectorAll('.game-card-icon img, .game-row-icon img'))
           .map((img) => ({ src: (img.src || '').slice(0, 50), naturalWidth: img.naturalWidth, complete: img.complete }))`
      )
    )

    record('finalConsoleErrors', consoleErrors.slice())
  } catch (error) {
    console.error('[probe] 探针本身出错：', error)
    results.probeError = String(error)
  }

  results.consoleErrors = consoleErrors
  dump(results)
  console.log('[probe] RESULT ' + JSON.stringify(results, null, 2))
  app.exit(0)
})

// 兜底：探针中途崩了也要有痕迹（否则只能看到「什么输出都没有」）
process.on('uncaughtException', (error) => {
  results.fatal = String(error)
  dump(results)
  app.exit(1)
})
