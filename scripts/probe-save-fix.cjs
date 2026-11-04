// 端到端验收：编辑页「保存基本信息」不再报 An object could not be cloned.
//
// 修的是这个 bug：GameEditPage 的 save() 把 `gameArgs`（DynamicArgsForm 双向绑定的
// reactive 对象）直接传给 saveGame → contextBridge 的 structured clone 抛错
// → 用户看到「点保存没反应，只弹一句英文」。
//
// 两阶段（本探针第一版踩坑学到的）：
//   PHASE=seed   造一条游戏记录（**不能在同进程里 reload，reload 会把探针自己清掉**）
//   PHASE=check  全新进程启动，页面挂载时就能拿到数据 → 进编辑页 → 改标题 → 保存 → 验
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const REPORT = path.join(__dirname, '..', '.dev-data-fixprobe.json')
const PHASE = process.env.PROBE_PHASE || 'check'
const results = {}
const consoleErrors = []

const dump = () => {
  try {
    fs.writeFileSync(REPORT, JSON.stringify({ ...results, consoleErrors }, null, 2), 'utf8')
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

    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) consoleErrors.push(String(message))
    })

    try {
      if (PHASE === 'seed') {
        await js(`
          window.tsumi.invoke('saveGame', {
            game: {
              gameTitle: '保存测试',
              gamePath: 'E:/Game/RPG/傭兵の冒険',
              gameEngine: 'mkxpz',
              gameArgs: { fullscreen: true, scale: 2 }
            }
          })
        `)
        const snap = await js(`window.tsumi.invoke('snapshot')`)
        results.seed = { games: (snap.games || []).map((g) => ({ id: g.id, t: g.gameTitle })) }
        dump()
        return app.exit(0)
      }

      // ── PHASE=check：数据已在磁盘，页面挂载时会自己加载 ──
      await new Promise((r) => setTimeout(r, 1500))
      const snap0 = await js(`window.tsumi.invoke('snapshot')`)
      const gid = (snap0.games || [])[0]?.id
      results.gameId = gid
      results.initialTitles = (snap0.games || []).map((g) => g.gameTitle)
      if (!gid) {
        results.error = 'NO_GAME_SEEDED'
        dump()
        return app.exit(1)
      }

      // ── 进编辑页 ──
      await js(`location.hash = '#/game/${gid}/edit'; true`)
      await new Promise((r) => setTimeout(r, 2000))
      results.editPage = await js(`
        ({
          hash: location.hash,
          htmlLen: document.querySelector('#app')?.innerHTML?.length || 0,
          hasNotFound: document.body.innerText.includes('游戏不存在'),
          inputCount: document.querySelectorAll('input').length,
          buttonTexts: Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim()).slice(0, 20)
        })
      `)

      if (results.editPage.hasNotFound) {
        results.error = 'EDIT_PAGE_NOT_FOUND'
        dump()
        return app.exit(1)
      }

      // ── ① 改标题（走真实输入框）──
      const newTitle = '保存测试-改过了'
      results.fillTitle = await js(`
        (() => {
          const inputs = Array.from(document.querySelectorAll('input'))
          const target = inputs[0]
          if (!target) return { ok: false, reason: 'no input' }
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
          setter.call(target, ${JSON.stringify(newTitle)})
          target.dispatchEvent(new Event('input', { bubbles: true }))
          return { ok: true, now: target.value }
        })()
      `)
      await new Promise((r) => setTimeout(r, 500))

      // ── ② 点保存（真实按钮，走 save()）──
      results.clickedSave = await js(`
        (() => {
          const btns = Array.from(document.querySelectorAll('button'))
          const save = btns.find(b => /^保存/.test((b.textContent || '').trim()))
          if (!save) return { ok: false, candidates: btns.map(b => (b.textContent||'').trim()).slice(0, 20) }
          save.click()
          return { ok: true, text: save.textContent.trim() }
        })()
      `)
      await new Promise((r) => setTimeout(r, 2000))

      // ── ③ 验真的存进去了 ──
      const after = await js(`window.tsumi.invoke('snapshot')`)
      const titles = (after.games || []).map((g) => g.gameTitle)
      results.afterTitles = titles
      results.savedNewTitle = titles.includes(newTitle)

      // ── ④ 有没有 cloned 报错 ──
      results.clonedErrors = consoleErrors.filter((m) => /could not be cloned|cloned/i.test(m))

      results.verdict = {
        saveWorked: results.savedNewTitle,
        noClonedError: results.clonedErrors.length === 0,
        editPageAlive: results.editPage.htmlLen > 1000
      }
    } catch (e) {
      results.error = String((e && e.message) || e)
    }

    dump()
    app.exit(0)
  }, 7000)
})
