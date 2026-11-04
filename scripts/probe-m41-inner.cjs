// M4.1 S4 端到端验收探针（在 Electron 主进程里跑，由 scripts/probe-m41.cjs 以文件入口启动）。
//
// ⚠️ 必须复用真实应用的主进程启动路径（`require('../out/main/index.js')`），
//    不能自己 new BrowserWindow —— 那样 tsumi:invoke 根本没注册。
//    （这个坑 M4.0 的探针已经踩过一次，理由见 scripts/probe-m40-inner.cjs 的开头。）
//
// 验收判据（docs/M4.1-实施方案.md S4）：
//   ① 引擎页的「可安装」列表**恰好四个**，且不含 ruffle / wine / macos
//   ② 装了一个旧引擎（ruffle）→ 它出现在「已安装」，但页面上**没有**「不支持启动」的标灰
//   ③ 「远程引擎列表」相关的两条告警**不再出现**（列表来自本地 registry）
//   ④ 参数表单：点进编辑页，`string` 类型的参数**渲染出输入框**（不是空白行）
//   ⑤ 页面没白屏（consoleErrors 为空 + #app 有内容）
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const dataDir = process.env.TSUMIGEYA_DATA_DIR
const REPORT = path.join(__dirname, '..', '.dev-data-m41probe.json')
const BOOT = path.join(__dirname, '..', '.dev-data-m41boot.txt')

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

/** 写一个引擎模块目录（manifest 来自我们的 registry 形状）。 */
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

// ================= 准备假数据（必须在真实应用启动前写完）=================
function prepare() {
  // 一个「旧版残留」的引擎：用户从旧版本升级上来，modules 里还躺着它
  installModule('ruffle', { name: 'Ruffle', version: '1.0.0', autodetect: { extensions: ['swf'] }, gameArgs: {} })

  // 一个**我们自己的**引擎（mkxpz），manifest 用 registry 那套字段（含 string 类型参数）
  installModule('mkxpz', {
    name: 'mkxp-z',
    version: '1.1.5',
    description: 'A module to launch RPG Maker XP, VX and VX Ace games with mkxp-z.',
    autodetect: { files: ['Game.ini', 'System', 'Graphics', 'Audio'], all_required: true },
    gameArgs: {
      rgssVersion: {
        type: 'dropdown',
        label: 'RGSS Version',
        default: '0',
        options: [
          { label: 'Auto (0)', value: '0' },
          { label: 'RGSS1 (XP)', value: '1' },
          { label: 'RGSS2 (VX)', value: '2' },
          { label: 'RGSS3 (VX Ace)', value: '3' }
        ]
      },
      fullscreen: { type: 'boolean', label: 'Start in Fullscreen', default: false },
      // ⚠️ 关键：**string** 类型（上游写法）。表单必须渲染出输入框
      windowTitle: { type: 'string', label: 'Window Title Override', default: '' },
      defScreenW: { type: 'int', label: 'Window Width (0=auto)', default: 0 },
      fontSub: { type: 'array', label: 'Font Substitutions (Old>New)', default: [] }
    },
    dependencies: {}
  })

  const gameDir = path.join(dataDir, 'game-mkxpz')
  fs.mkdirSync(path.join(gameDir, 'System'), { recursive: true })
  fs.mkdirSync(path.join(gameDir, 'Graphics'), { recursive: true })
  fs.mkdirSync(path.join(gameDir, 'Audio'), { recursive: true })
  fs.writeFileSync(path.join(gameDir, 'Game.ini'), '[Game]\r\nRTP=RPGVXace\r\n', 'utf8')
  fs.writeFileSync(path.join(gameDir, 'Game.exe'), 'MZ', 'utf8')

  fs.writeFileSync(
    path.join(dataDir, 'games.json'),
    JSON.stringify(
      {
        mkxpz1: {
          gameTitle: '参数表单测试游戏',
          gamePath: gameDir,
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
}

prepare()
record('prepared', true)

// ================= 让**真实应用**跑起来（建窗口 + 注册 IPC）=================
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

    await waitFor(() =>
      win.webContents.executeJavaScript(`typeof window.tsumi === 'object' && window.tsumi !== null`)
    )
    await new Promise((resolve) => setTimeout(resolve, 900))
    record('rendererReady', true)

    // ===== ① 主进程侧：可安装列表恰好四个 =====
    const remote = await win.webContents.executeJavaScript(`(async () => {
      const modules = await window.tsumi.invoke('remoteModules', {})
      return (modules || []).map((module) => ({ folder: module.folder, name: module.name, version: module.version }))
    })()`)
    record('remoteCount', remote.length)
    record('remoteFolders', remote.map((module) => module.folder))
    record('remoteHasRuffle', remote.some((module) => module.folder === 'ruffle'))
    record('remoteHasWine', remote.some((module) => module.folder === 'wine'))
    record('remoteHasMacos', remote.some((module) => module.folder === 'macos'))

    // ===== ② 更新检查：旧引擎给提示、不报「有更新」 =====
    const updates = await win.webContents.executeJavaScript(`(async () => {
      const report = await window.tsumi.invoke('checkEngineUpdates', {})
      return {
        warnings: report.warnings || [],
        updates: (report.updates || []).map((item) => ({ id: item.id, remoteVersion: item.remoteVersion, moduleUpdate: item.moduleUpdate })),
        cachedRemote: report.cachedRemote
      }
    })()`)
    record('cachedRemote', updates.cachedRemote)
    record('ruffleWarningPresent', updates.warnings.some((warning) => warning.includes('ruffle')))
    const ruffleUpdate = updates.updates.find((item) => item.id === 'ruffle')
    record('ruffleRemoteVersion', ruffleUpdate ? ruffleUpdate.remoteVersion : null)
    record('ruffleModuleUpdate', ruffleUpdate ? ruffleUpdate.moduleUpdate : null)

    // ===== ③ 引擎页 DOM：四个可安装、无标灰、无「远程」告警 =====
    await win.webContents.executeJavaScript(`(async () => {
      // 走 Pinia store（M3.5 探针的教训：直接 invoke 只改主进程，页面读的是 store 投影）
      const router = window.__tsumiRouter || null
      return true
    })()`)
    // 直接改 hash 路由到引擎页（应用用 hash 路由）
    await win.webContents.executeJavaScript(`(() => { window.location.hash = '#/engines'; return true })()`)
    await new Promise((resolve) => setTimeout(resolve, 1200))

    const enginePage = await win.webContents.executeJavaScript(`(() => {
      const text = document.body.innerText || ''
      const cards = document.querySelectorAll('.engine-card').length
      const emptyState = document.querySelectorAll('.empty-state').length
      const alerts = Array.from(document.querySelectorAll('.el-alert__title')).map((el) => el.textContent.trim())
      const unavailableCards = document.querySelectorAll('.engine-card-unavailable').length
      const warnTexts = Array.from(document.querySelectorAll('.engine-card-warn')).map((el) => el.textContent.trim())
      return {
        htmlLen: (document.querySelector('#app') || {}).innerHTML ? document.querySelector('#app').innerHTML.length : 0,
        textLen: text.length,
        cardCount: cards,
        emptyStateCount: emptyState,
        alertTitles: alerts,
        unavailableCardCount: unavailableCards,
        warnTextCount: warnTexts.length,
        warnTexts,
        hasNotLaunchableText: text.includes('不支持启动'),
        hasRuffle: text.includes('Ruffle') || text.includes('ruffle'),
        hasRemoteUnavailable: text.includes('无法获取远程引擎列表'),
        hasCachedWarning: text.includes('远程列表来自本地缓存'),
        bodyText: text.slice(0, 1200)
      }
    })()`)
    record('enginePage', enginePage)

    // ===== ④ 参数表单：string 类型渲染出输入框 =====
    // ⚠️ 先等引擎 store 真的装好了数据再进编辑页。
    // M4.1 S4 探针第一版没等，编辑页的 `manifest` computed 算出来是 null
    // → 界面上显示「该引擎没有可配置参数」，看起来像 bug、其实是时序。
    // 判据：snapshot.modules 里已经有 mkxpz（App.vue 启动时就会 applySnapshot）。
    await waitFor(async () => {
      const ids = await win.webContents.executeJavaScript(`(async () => {
        const snap = await window.tsumi.invoke('snapshot', {})
        return (snap.modules || []).map((module) => module.id)
      })()`)
      return Array.isArray(ids) && ids.includes('mkxpz')
    })
    await win.webContents.executeJavaScript(`(() => { window.location.hash = '#/game/mkxpz1/edit'; return true })()`)
    // 路由切换 + fill() + 表单渲染都要时间；给足再读 DOM
    await new Promise((resolve) => setTimeout(resolve, 2600))

    const argForm = await win.webContents.executeJavaScript(`(() => {
      const text = document.body.innerText || ''
      const inputs = document.querySelectorAll('.el-input__inner').length
      const numbers = document.querySelectorAll('.el-input-number').length
      const switches = document.querySelectorAll('.el-switch').length
      const selects = document.querySelectorAll('.el-select').length
      const labels = Array.from(document.querySelectorAll('.settings-row-title')).map((el) => el.textContent.trim())
      return {
        htmlLen: (document.querySelector('#app') || {}).innerHTML ? document.querySelector('#app').innerHTML.length : 0,
        inputCount: inputs,
        numberCount: numbers,
        switchCount: switches,
        selectCount: selects,
        labels,
        // 中文标签（M4.1 S4 的 args.<folder>.<key>）：窗口标题必须是中文
        hasWindowTitleLabel: labels.some((label) => label.includes('窗口标题')),
        // 不能出现英文 label 兜底失败的样子
        bodyHasBlankRow: labels.some((label) => label === ''),
        textTail: text.slice(0, 900)
      }
    })()`)
    record('argForm', argForm)

    // ===== ④b 参数表单确实拿到了 manifest（回归 M1 就存在的 raw 缺失 bug）=====
    // 修复前这里会是 `mkxpzRawKeys: null` + 页面显示「该引擎没有可配置参数」。
    const manifestProbe = await win.webContents.executeJavaScript(`(async () => {
      const snap = await window.tsumi.invoke('snapshot', {})
      const mkxpz = (snap.modules || []).find((module) => module.id === 'mkxpz')
      const raw = mkxpz ? mkxpz.raw : null
      return {
        mkxpzRawKeys: raw ? Object.keys(raw) : null,
        mkxpzRawGameArgsKeys: raw && raw.gameArgs ? Object.keys(raw.gameArgs) : null,
        // 摊平字段也必须在（引擎页的 displayName/moduleVersion 在读它们）
        flatName: mkxpz ? mkxpz.name : null,
        pageHasNoArgsHint: (document.body.innerText || '').includes('没有可配置参数')
      }
    })()`)
    record('manifestProbe', manifestProbe)

    // ===== ⑤ 汇总 =====
    record('consoleErrors', consoleErrors.slice(0, 10))
    record('verificationLevel', 'renderer + main (windows)')

    dump(results)
    console.log('[probe] DONE')
    app.quit()
  } catch (error) {
    record('probeError', String((error && error.stack) || error))
    record('consoleErrors', consoleErrors.slice(0, 10))
    dump(results)
    console.error('[probe] 失败：', error)
    app.quit()
  }
})
