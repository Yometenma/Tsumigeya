// R18 封面打码的端到端验证（两阶段版）。
//
// 为什么要两阶段：saveGame / saveGameMeta 之后，library store 的 meta 只在
// App.vue 的 onMounted 里赋值；切路由不会重新 mount，而 location.reload()
// 会把探针自己一起清掉（第一版踩的坑）。
// 所以：RUN=seed 先造数据并退出；RUN=check 在全新进程里检查（此时页面加载时
// 就能拿到全部数据），再切开关看是否立刻显示。
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const REPORT = path.join(__dirname, '..', '.dev-data-adultprobe.json')
const PHASE = process.env.PROBE_PHASE || 'check'

const results = {}
const dump = () => {
  try {
    fs.writeFileSync(REPORT, JSON.stringify(results, null, 2), 'utf8')
  } catch (e) {
    console.error('[probe] dump failed', e)
  }
}

require(path.join(__dirname, '..', 'out', 'main', 'index.js'))

app.whenReady().then(() => {
  setTimeout(async () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) {
      results.error = 'NO_WINDOW'
      dump()
      return app.exit(1)
    }
    const js = (code) => win.webContents.executeJavaScript(code)

    try {
      if (PHASE === 'seed') {
        // —— 阶段 1：造数据 ——
        results.defaultShowAdultCovers = await js(
          `window.tsumi.invoke('snapshot').then(s => s.settings.showAdultCovers)`
        )

        const work = await js(`
          window.tsumi.invoke('dlsiteLookup', { rj: 'RJ294126' })
            .then(w => ({ ok: true, work: w }))
            .catch(e => ({ ok: false, err: String((e && e.message) || e) }))
        `)
        results.lookupOk = work.ok
        results.category = work.ok ? work.work.category : undefined

        if (work.ok) {
          const snap = await js(`
            window.tsumi.invoke('saveGame', {
              game: { gameTitle: 'probe-adult', gamePath: 'E:/Game/RPG/傭兵の冒険', gameEngine: 'mkxpz', gameArgs: {} }
            })
          `)
          const gid = (snap.games || []).find((g) => g.gameTitle === 'probe-adult')?.id
          results.gameId = gid
          if (gid) {
            await js(`
              window.tsumi.invoke('saveGameMeta', {
                gameId: ${JSON.stringify(gid)},
                rj: 'RJ294126',
                work: ${JSON.stringify(work.work)}
              })
            `)
            results.saved = true
          }
        }
        dump()
        return app.exit(0)
      }

      // —— 阶段 2：检查（全新进程，页面加载即带数据）——
      await new Promise((r) => setTimeout(r, 1200))
      results.currentShowAdultCovers = await js(
        `window.tsumi.invoke('snapshot').then(s => s.settings.showAdultCovers)`
      )

      const sample = () =>
        js(`
          (() => {
            const text = document.body.innerText
            const imgs = Array.from(document.querySelectorAll('img'))
            const remote = imgs.filter(i => i.src && i.src.startsWith('https://img.dlsite.jp'))
            const local = imgs.filter(i => i.src && i.src.startsWith('tsmg://'))
            return {
              hasMaskHint: text.includes('R18 封面已隐藏'),
              remoteCoverCount: remote.length,
              remoteNaturalWidths: remote.map(i => i.naturalWidth),
              localIconCount: local.length,
              gameCountText: (text.match(/共\\s*(\\d+)\\s*个游戏/) || [])[0] || '',
              htmlLen: document.querySelector('#app')?.innerHTML?.length || 0
            }
          })()
        `)

      results.stateOff = await sample()

      // —— 打开开关 ——
      // 模拟**真实用户路径**：进设置页、找到「显示 R18 作品封面」开关、点它。
      // 这条路会走 settings store 的 save()（applySnapshot 回灌），
      // 而直接 invoke('saveSettings') 只写盘、不回灌 pinia —— 后者是探针的错觉。
      await js(`location.hash = '#/settings'; true`)
      await new Promise((r) => setTimeout(r, 1200))
      results.settingsPageFound = await js(`
        (() => {
          const t = document.body.innerText
          const switches = Array.from(document.querySelectorAll('.el-switch'))
          return { hasLabel: t.includes('显示 R18 作品封面'), switchCount: switches.length }
        })()
      `)

      // 找到「显示 R18 作品封面」那一行里的开关，点它
      results.clicked = await js(`
        (() => {
          const rows = Array.from(document.querySelectorAll('.settings-row'))
          const target = rows.find(r => r.textContent.includes('显示 R18 作品封面'))
          if (!target) return { ok: false, reason: 'row not found' }
          const sw = target.querySelector('.el-switch')
          if (!sw) return { ok: false, reason: 'switch not found' }
          sw.click()
          return { ok: true }
        })()
      `)
      await new Promise((r) => setTimeout(r, 1000))
      results.afterToggle = await js(
        `window.tsumi.invoke('snapshot').then(s => s.settings.showAdultCovers)`
      )

      await js(`location.hash = '#/library'; true`)
      await new Promise((r) => setTimeout(r, 1200))
      results.stateOn = await sample()

      results.verdict = {
        defaultOff: results.currentShowAdultCovers === false,
        maskedWhenOff: !!results.stateOff && results.stateOff.hasMaskHint === true && results.stateOff.remoteCoverCount === 0,
        visibleWhenOn: !!results.stateOn && results.stateOn.remoteCoverCount > 0
      }
    } catch (e) {
      results.error = String(e && e.message ? e.message : e)
    }

    dump()
    app.exit(0)
  }, 6000)
})
