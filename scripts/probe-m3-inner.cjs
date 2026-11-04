// M3 S3 端到端验收探针（在 Electron 主进程里跑）。
// 由 scripts/probe-m3.cjs 以「文件入口」启动。
//
// S3 的验收判据（docs/M3-实施方案.md §8）：
//   1) 点启动加密发行的 傭兵の冒険 → 出**中文**诊断框
//   2) **不出现英文报错**（这正是 M3 要做掉的东西）
//   3) 诊断框里 fatal 条目**没有**「还是启动试试」按钮（§11-②）
//   4) 诊断命令本身毫秒级、绕开队列（排在 60s 更新检查后面就是「点了没反应」）
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const OUT = path.join(__dirname, '..', 'out')
const dataDir = process.env.TSUMIGEYA_DATA_DIR
const REPORT = path.join(__dirname, '..', '.dev-data-m3probe.json')
const BOOT = path.join(__dirname, '..', '.dev-data-m3boot.txt')

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

require(path.join(OUT, 'main', 'index.js'))

app.whenReady().then(async () => {
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const window = BrowserWindow.getAllWindows()[0]
  if (!window) {
    console.error('[probe] 没有窗口！')
    app.exit(1)
    return
  }

  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) consoleErrors.push(message)
  })

  try {
    record('bridgeType', await evaluate(window, 'typeof window.tsumi'))
    record('appHtmlLen', await evaluate(window, 'document.querySelector("#app").innerHTML.length'))

    // ===== ① 造一个加密发行的游戏记录（用真实样本路径，只读不动文件）=====
    const SAMPLE = path.join('E:', 'Game', 'RPG', '傭兵の冒険', '傭兵の冒険_CHN')
    const sampleExists = fs.existsSync(SAMPLE)
    record('sampleExists', sampleExists)

    if (sampleExists) {
      // 直接调 saveGame，让它进游戏库（探针只读游戏文件，不碰它们）
      const saved = await evaluate(
        window,
        `window.tsumi.invoke('saveGame', {
           game: {
             gameTitle: '傭兵の冒険（M3探针）',
             gamePath: ${JSON.stringify(SAMPLE)},
             gameEngine: 'mkxpz'
           }
         }).then((s) => ({ ok: true, count: s.games.length, ids: s.games.map((g) => g.id) }),
                      (e) => ({ ok: false, message: (e.message || '').slice(0, 120) }))`
      )
      record('saveGame', saved)

      const gameId = saved.ids ? saved.ids[saved.ids.length - 1] : null
      record('gameId', gameId)

      // ===== ② diagnoseGame 的耗时（绕队列的话应该是毫秒级本地扫描）=====
      const started = Date.now()
      const diagnose = await evaluate(
        window,
        `Promise.race([
           window.tsumi.invoke('diagnoseGame', { gameId: ${JSON.stringify(gameId)} }).then(
             (value) => ({ ok: true, count: value.length, first: value[0] || null, codes: value.map((d) => d.code + ':' + d.level) }),
             (error) => ({ ok: false, message: (error.message || '').slice(0, 100) })
           ),
           new Promise((resolve) => setTimeout(() => resolve({ ok: false, message: 'HUNG' }), 30000))
         ])`
      )
      record('diagnose', diagnose)
      record('diagnoseMs', Date.now() - started)

      // ===== ③ 点启动 → 必须返回 { blocked: true, diagnoses }，**不是抛英文错误** =====
      const launch = await evaluate(
        window,
        `window.tsumi.invoke('launch', { id: ${JSON.stringify(gameId)} }).then(
           (value) => ({
             ok: true,
             blocked: value.blocked === true,
             diagnosisCount: Array.isArray(value.diagnoses) ? value.diagnoses.length : 0,
             message: value.message ?? null
           }),
           (error) => ({ ok: false, thrown: true, message: (error.message || '').slice(0, 200) })
         )`
      )
      record('launchResult', launch)

      // ===== ④ 渲染层的诊断框：走真实 UI 路径（点卡片上的启动按钮）=====
      // 这一步验的是「用户真的看到中文」——而不是「IPC 返回了对象」。
      //
      // 两个前置动作：
      //  · 先让页面的 store 重新拉一次 snapshot（探针往库里塞了游戏，但 UI 不会自动刷新）
      //  · 卡片没有 data-game-id，所以按标题文本找，再点它内部的「启动」按钮
      const domProbe = await evaluate(
        window,
        `(async () => {
           const title = 'M3探针'
           // ① 触发 store 刷新：走真实的 store action，而不是直接改 DOM
           const app = document.querySelector('#app').__vue_app__
           const pinia = app.config.globalProperties.$pinia
           const libStore = pinia._s.get('library')
           if (libStore && typeof libStore.load === 'function') await libStore.load()
           await new Promise((r) => setTimeout(r, 400))

           // ② 找到含标题的卡片，点它的启动按钮
           const cards = Array.from(document.querySelectorAll('.game-card, .game-row'))
           const target = cards.find((node) => (node.innerText || '').includes(title))
           if (!target) {
             return {
               clicked: false,
               reason: '找不到游戏卡片',
               cardCount: cards.length,
               visibleText: (document.body.innerText || '').slice(0, 600)
             }
           }
           const launchButton = Array.from(target.querySelectorAll('button')).find((b) =>
             (b.innerText || '').includes('启动')
           )
           if (!launchButton) return { clicked: false, reason: '找不到启动按钮' }
           launchButton.click()
           await new Promise((r) => setTimeout(r, 1500))

           // ③ 诊断框出现后抓它的文本与按钮
           const dialogs = Array.from(document.querySelectorAll('.diagnosis-dialog'))
           const text = dialogs.map((d) => d.innerText || '').join('\\n---\\n')
           const buttons = Array.from(document.querySelectorAll('.diagnosis-dialog button')).map(
             (b) => (b.innerText || '').trim()
           )
           return {
             clicked: true,
             dialogCount: dialogs.length,
             text: text.slice(0, 1500),
             buttons,
             // 关键：中文诊断标题出现 = 用户看到的是中文，不是 mkxp-z 的英文报错
             hasChineseTitle: text.includes('暂时无法启动') || text.includes('启动诊断'),
             hasEnglishMkxpError: text.includes('No script file has been specified'),
             // fatal 不给绕过（§11-②）
             hasRatherTryButton: buttons.some((b) => b.includes('还是启动试试')),
             htmlLen: document.querySelector('#app').innerHTML.length
           }
         })()`
      )
      record('diagnosisDialog', domProbe)

      // ===== ⑤ S4：编辑页的「启动诊断」面板（§8 S4 验收：面板存在 + htmlLen 不塌陷）=====
      // 白屏是本项目最隐蔽的坑（TDZ / ICU 语法 / TS 断言都会导致整块组件消失），
      // 所以判据必须是「htmlLen 没塌」+「面板真的渲染出来」，而不是「没报错」。
      const editPanel = await evaluate(
        window,
        `(async () => {
           // 关掉诊断框（点「关闭」），免得挡住后续操作
           const closeBtn = Array.from(document.querySelectorAll('.diagnosis-dialog button')).find(
             (b) => (b.innerText || '').trim() === '关闭'
           )
           if (closeBtn) closeBtn.click()
           await new Promise((r) => setTimeout(r, 300))

           const before = document.querySelector('#app').innerHTML.length
           // 走真实路由跳到编辑页
           const app = document.querySelector('#app').__vue_app__
           const router = app.config.globalProperties.$router
           await router.push('/game/${gameId}')
           await new Promise((r) => setTimeout(r, 1200))

           const panels = Array.from(document.querySelectorAll('.diagnosis-panel'))
           const text = panels.map((p) => p.innerText || '').join('\\n')
           const buttons = Array.from(document.querySelectorAll('.diagnosis-panel button')).map((b) =>
             (b.innerText || '').trim()
           )

           // 点面板上的诊断按钮，看它真的能跑出结果
           const runBtn = Array.from(document.querySelectorAll('.diagnosis-panel button')).find(
             (b) => /启动诊断|重新诊断/.test(b.innerText || '')
           )
           let afterRun = null
           if (runBtn) {
             runBtn.click()
             await new Promise((r) => setTimeout(r, 900))
             const afterPanels = Array.from(document.querySelectorAll('.diagnosis-panel'))
             afterRun = {
               text: afterPanels.map((p) => p.innerText || '').join('\\n').slice(0, 800),
               alerts: document.querySelectorAll('.diagnosis-panel .el-alert').length
             }
           }

           return {
             beforeLen: before,
             afterLen: document.querySelector('#app').innerHTML.length,
             panelCount: panels.length,
             text: text.slice(0, 600),
             buttons,
             afterRun,
             // 塌陷判据：编辑页应当比库页更"重"，只要没跌回只剩侧边栏（~500）就算没白屏
             collapsed: document.querySelector('#app').innerHTML.length < 3000
           }
         })()`
      )
      record('editDiagnosisPanel', editPanel)
    } else {
      record('skipped', '真实样本不存在，跳过启动链验收')
    }

    record('consoleErrors', consoleErrors.slice(0, 20))
    dump({ ok: true, results })
    app.exit(0)
  } catch (error) {
    record('probeError', String(error && error.stack ? error.stack : error))
    dump({ ok: false, error: String(error), results })
    app.exit(1)
  }
})
