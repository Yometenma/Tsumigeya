// M2.7 验收：编辑页重构（封面与标签区块 + 标题来源提示）+ 保存不炸
//
// 两阶段（PHASE=seed → PHASE=check），原因见 probe-save-fix.cjs 的注释。
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const REPORT = path.join(__dirname, '..', '.dev-data-m27probe.json')
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
        // 造一条带 DLsite 元数据的游戏（这样标题来源应该是 dlsite）
        await js(`
          window.tsumi.invoke('saveGame', {
            game: {
              gameTitle: '目录名标题',
              gamePath: 'E:/Game/RPG/傭兵の冒険',
              gameEngine: 'mkxpz',
              gameArgs: { fullscreen: true }
            },
            tags: ['自定义标签']
          })
        `)
        const snap = await js(`window.tsumi.invoke('snapshot')`)
        const gid = (snap.games || [])[0]?.id
        results.seed = { id: gid }
        dump()
        return app.exit(0)
      }

      const snap0 = await js(`window.tsumi.invoke('snapshot')`)
      const gid = (snap0.games || [])[0]?.id
      if (!gid) {
        results.error = 'NO_GAME'
        dump()
        return app.exit(1)
      }
      results.gameId = gid
      results.seededTitle = (snap0.games || [])[0]?.gameTitle

      await js(`location.hash = '#/game/${gid}/edit'; true`)
      await new Promise((r) => setTimeout(r, 2000))

      // ── 结构断言：新区块在不在 ──
      results.layout = await js(`
        (() => {
          const text = document.body.innerText
          return {
            htmlLen: document.querySelector('#app')?.innerHTML?.length || 0,
            hasCoverAndTags: text.includes('封面与标签'),
            hasCoverPreview: text.includes('封面预览'),
            hasTitleSource: /当前使用.*标题|尚未获取 DLsite/.test(text),
            hasTagsHint: text.includes('DLsite 不提供分类标签'),
            hasIconAdvanced: text.includes('图标（高级）'),
            // 图标默认应该是**收起**的：折叠时不该出现「更改图标」按钮
            iconCollapsed: !text.includes('更改图标'),
            inputCount: document.querySelectorAll('input').length,
            hasNotFound: text.includes('游戏不存在')
          }
        })()
      `)

      // ── 展开图标区 ──
      results.expandIcon = await js(`
        (() => {
          const btns = Array.from(document.querySelectorAll('button'))
          const toggle = btns.find(b => /图标（高级）/.test(b.textContent || ''))
          if (!toggle) return { ok: false }
          toggle.click()
          return { ok: true }
        })()
      `)
      await new Promise((r) => setTimeout(r, 600))
      results.afterExpand = await js(`
        ({
          hasChangeIcon: document.body.innerText.includes('更改图标'),
          htmlLen: document.querySelector('#app')?.innerHTML?.length || 0
        })
      `)

      // ── 保存仍然可用（回归验证 M2.7 没弄坏 M2.6 的修复）──
      const newTitle = '改过的标题 M2.7'
      await js(`
        (() => {
          const inputs = Array.from(document.querySelectorAll('input'))
          const target = inputs[0]
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
          setter.call(target, ${JSON.stringify(newTitle)})
          target.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        })()
      `)
      await new Promise((r) => setTimeout(r, 500))
      await js(`
        (() => {
          const btns = Array.from(document.querySelectorAll('button'))
          const save = btns.find(b => /^保存/.test((b.textContent || '').trim()))
          if (save) save.click()
          return true
        })()
      `)
      await new Promise((r) => setTimeout(r, 2000))

      const after = await js(`window.tsumi.invoke('snapshot')`)
      results.afterTitles = (after.games || []).map((g) => g.gameTitle)
      results.savedAfterRefactor = results.afterTitles.includes(newTitle)
      results.clonedErrors = consoleErrors.filter((m) => /could not be cloned/i.test(m))

      results.verdict = {
        layoutOk:
          results.layout.hasCoverAndTags &&
          results.layout.hasCoverPreview &&
          results.layout.hasTitleSource &&
          results.layout.hasTagsHint &&
          results.layout.hasIconAdvanced,
        iconCollapsedByDefault: results.layout.iconCollapsed,
        iconExpands: results.afterExpand.hasChangeIcon,
        saveStillWorks: results.savedAfterRefactor,
        noClonedError: results.clonedErrors.length === 0,
        notWhiteScreen: results.layout.htmlLen > 1000
      }
    } catch (e) {
      results.error = String((e && e.message) || e)
    }

    dump()
    app.exit(0)
  }, 7000)
})
