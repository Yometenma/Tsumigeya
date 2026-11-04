// M2.6 端到端验收探针（在 Electron 主进程里跑）。
// 由 scripts/probe-m26.cjs 以「文件入口」启动。
//
// 验收判据（docs/M2.6-实施方案.md §8）：
//   S2 卡片重写：卡片 DOM 里有三点菜单、**没有**启动按钮、htmlLen 不塌陷
//   S3 详情页：进详情页 → 有启动按钮、有「暂无标签」文案
//   S4 路由拆分：点卡片进详情（#/game/:id）、点编辑进编辑页（#/game/:id/edit）
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const OUT = path.join(__dirname, '..', 'out')
const dataDir = process.env.TSUMIGEYA_DATA_DIR
const REPORT = path.join(__dirname, '..', '.dev-data-m26probe.json')
const BOOT = path.join(__dirname, '..', '.dev-data-m26boot.txt')

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

/** 等页面重载完成（不能用渲染层的 location.reload——会销毁 JS 上下文让 promise 挂住）。 */
async function reload(window, waitMs = 1200) {
  const loaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
  window.webContents.reload()
  await loaded
  await new Promise((resolve) => setTimeout(resolve, waitMs))
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

    // ===== ① 种数据：两个游戏（一个带完整元数据、一个完全没有）=====
    // 带元数据的那个用来验「简介/类型/三点菜单的刷新可用」；
    // 没有元数据的那个用来验「空数据不留白、不假装」（D37）。
    const seed = await evaluate(
      window,
      `(async () => {
         const base = ${JSON.stringify((dataDir || '.') + '/games')}
         const withMeta = await window.tsumi.invoke('saveGame', { id: undefined, game: {
           gameTitle: '傭兵の冒険', gamePath: base + '/傭兵の冒険_CHN', gameEngine: 'mkxpz'
         } })
         const bare = await window.tsumi.invoke('saveGame', { id: undefined, game: {
           gameTitle: '没元数据的游戏', gamePath: base + '/新作', gameEngine: 'RPG Maker MV'
         } })
         const games = bare.games
         return {
           total: games.length,
           withMetaId: games.find((g) => g.gameTitle === '傭兵の冒険')?.id ?? null,
           bareId: games.find((g) => g.gameTitle === '没元数据的游戏')?.id ?? null
         }
       })()`
    )
    record('seedGames', seed)

    const withMetaId = seed?.withMetaId
    const bareId = seed?.bareId
    if (!withMetaId) throw new Error('种数据失败：拿不到 withMetaId')

    // 给第一条塞一份完整元数据（含 summary / author / salesCount / rating / workType）
    record(
      'seedMeta',
      await evaluate(
        window,
        `window.tsumi.invoke('saveGameMeta', { gameId: ${JSON.stringify(withMetaId)}, work: {
           rj: 'RJ01699769', title: '即ハメ王女', circle: 'ShiftAltOn', seriesName: 'テストシリーズ',
           category: 'maniax', workType: 'MNG', registDate: '2024/06/01',
           price: 880, priceWithTax: 968,
           summary: '本作は、隣の部屋に住むおま○こ当番との毎日を描いた物語。',
           author: 'Tonda', salesCount: 739, rating: 4.5,
           fetchedAt: new Date().toISOString()
         } }).then(
           (value) => ({ ok: true, keys: Object.keys(value.meta[${JSON.stringify(withMetaId)}] || {}) }),
           (error) => ({ ok: false, message: (error && error.message) || String(error) })
         )`
      )
    )

    // ===== ② S2：库页卡片 =====
    await reload(window, 2000)
    await evaluate(window, "location.hash = '#/library'")
    await new Promise((resolve) => setTimeout(resolve, 1500))

    record(
      'libraryGrid',
      await evaluate(
        window,
        `(() => {
           const cards = Array.from(document.querySelectorAll('.game-card'))
           const rows = Array.from(document.querySelectorAll('.game-row'))
           const allButtons = Array.from(document.querySelectorAll('.game-card button, .game-row button'))
             .map((btn) => (btn.textContent || '').trim())
           const firstCard = cards[0] || null
           return {
             htmlLen: document.querySelector('#app').innerHTML.length,
             cardCount: cards.length,
             rowCount: rows.length,
             // S2 判据 ①：卡片上有三点菜单触发器
             menuTriggers: document.querySelectorAll('.game-card-menu-trigger').length,
             // S2 判据 ②：卡片上**没有**启动按钮
             hasLaunchButton: allButtons.includes('启动') || allButtons.includes('启动游戏'),
             cardButtons: allButtons,
             // S2 判据 ③：卡片承载了简介 / 类型标签
             summaryCount: document.querySelectorAll('.game-card-summary').length,
             tagTexts: Array.from(document.querySelectorAll('.game-card-tags .el-tag')).map((el) => (el.textContent || '').trim()),
             titles: cards.map((c) => (c.querySelector('.game-card-title')?.textContent || '').trim()),
             // 封面仍是 4:3（D36）：读实际渲染的宽高比
             coverRatio: (() => {
               const cover = document.querySelector('.game-card-cover')
               if (!cover) return null
               const rect = cover.getBoundingClientRect()
               return rect.height > 0 ? Number((rect.width / rect.height).toFixed(2)) : null
             })()
           }
         })()`
      )
    )

    // 空数据那条：卡片上不该出现「暂无」字样（卡片空间有限就不画，§5.1）
    record(
      'bareCardNoPlaceholder',
      await evaluate(
        window,
        `(() => {
           const cards = Array.from(document.querySelectorAll('.game-card'))
           const bare = cards.find((c) => (c.querySelector('.game-card-title')?.textContent || '').trim() === '没元数据的游戏')
           if (!bare) return { found: false }
           const text = (bare.innerText || '').replace(/\\s+/g, ' ')
           return {
             found: true,
             text,
             hasNoSummary: text.includes('暂无'),
             hasSummaryRow: !!bare.querySelector('.game-card-summary'),
             hasNoTags: text.includes('暂无标签')
           }
         })()`
      )
    )

    // ===== ③ S2：三点菜单能展开（真点触发器）=====
    record(
      'openCardMenu',
      await evaluate(
        window,
        `(async () => {
           const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
           const trigger = document.querySelector('.game-card-menu-trigger')
           if (!trigger) return { clicked: false }
           trigger.click()
           await sleep(500)
           const items = Array.from(document.querySelectorAll('.el-dropdown-menu__item'))
             .filter((el) => el.offsetParent !== null)
             .map((el) => ({
               text: (el.textContent || '').trim(),
               // ⚠️ aria-disabled 是**字符串**："false" 也是真值，不能直接 !! 判断
               disabled: el.getAttribute('aria-disabled') === 'true' || el.classList.contains('is-disabled')
             }))
           return { clicked: true, menuVisible: items.length > 0, items }
         })()`
      )
    )

    // 菜单项点「编辑」→ 应跳编辑页（S4 判据）
    record(
      'menuEditNavigates',
      await evaluate(
        window,
        `(async () => {
           const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
           const items = Array.from(document.querySelectorAll('.el-dropdown-menu__item'))
             .filter((el) => el.offsetParent !== null)
           const edit = items.find((el) => (el.textContent || '').trim() === '编辑')
           if (!edit) return { clicked: false, hash: location.hash }
           edit.click()
           await sleep(900)
           return {
             clicked: true,
             hash: location.hash,
             isEditRoute: /^#\\/game\\/[^/]+\\/edit$/.test(location.hash),
             htmlLen: document.querySelector('#app').innerHTML.length
           }
         })()`
      )
    )

    // ===== ④ S4：点卡片主体 → 进详情页（不是编辑页）=====
    await evaluate(window, "location.hash = '#/library'")
    await new Promise((resolve) => setTimeout(resolve, 1200))
    record(
      'clickCardOpensDetail',
      await evaluate(
        window,
        `(async () => {
           const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
           const cards = Array.from(document.querySelectorAll('.game-card'))
           const target = cards.find((c) => (c.querySelector('.game-card-title')?.textContent || '').trim() === '傭兵の冒険')
           if (!target) return { clicked: false, count: cards.length }
           // 点的是卡片**主体**（封面），不是三点菜单
           const cover = target.querySelector('.game-card-cover')
           ;(cover || target).click()
           await sleep(1000)
           return {
             clicked: true,
             hash: location.hash,
             isDetailRoute: /^#\\/game\\/[^/]+$/.test(location.hash),
             isEditPage: document.body.innerText.includes('DLsite 信息') === false ? null : true,
             htmlLen: document.querySelector('#app').innerHTML.length,
             hasDetailLayout: !!document.querySelector('.detail-layout')
           }
         })()`
      )
    )

    // ===== ⑤ S3：详情页内容 =====
    record(
      'detailPage',
      await evaluate(
        window,
        `(() => {
           const body = document.body.innerText
           const detail = document.querySelector('.detail-layout')
           const buttons = Array.from(document.querySelectorAll('button')).map((b) => (b.textContent || '').trim())
           return {
             htmlLen: document.querySelector('#app').innerHTML.length,
             hasDetailLayout: !!detail,
             // S3 判据 ①：有启动按钮
             hasLaunchButton: buttons.includes('启动游戏'),
             // S3 判据 ②：有「暂无标签」文案（D37：明说 DLsite 不提供）
             hasNoTags: body.includes('暂无标签'),
             hasNoCredits: body.includes('暂无制作信息'),
             hasTagSection: !!document.querySelector('.detail-section'),
             // 元数据齐的这条：简介 / 作者 / 销量 / 评分都应出现
             summaryShown: !!document.querySelector('.detail-summary'),
             summaryText: (document.querySelector('.detail-summary')?.textContent || '').trim().slice(0, 60),
             hasAuthor: body.includes('Tonda'),
             hasSales: body.includes('739'),
             hasRating: body.includes('4.5'),
             // 「暂无」不该出现在有值的字段上
             missingCount: document.querySelectorAll('.detail-info-value.is-missing').length,
             coverRatio: (() => {
               const cover = document.querySelector('.detail-cover')
               if (!cover) return null
               const rect = cover.getBoundingClientRect()
               return rect.height > 0 ? Number((rect.width / rect.height).toFixed(2)) : null
             })(),
             hasBackButton: buttons.includes('返回游戏库'),
             hasEditButton: buttons.includes('编辑')
           }
         })()`
      )
    )

    // 详情页的「编辑」→ 编辑页
    record(
      'detailEditNavigates',
      await evaluate(
        window,
        `(async () => {
           const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
           const btn = Array.from(document.querySelectorAll('button'))
             .find((b) => (b.textContent || '').trim() === '编辑')
           if (!btn) return { clicked: false }
           btn.click()
           await sleep(900)
           return { clicked: true, hash: location.hash, isEditRoute: /^#\\/game\\/[^/]+\\/edit$/.test(location.hash) }
         })()`
      )
    )

    // 编辑页的「返回」→ 详情页（不是库页，§5.3）
    record(
      'editBackGoesToDetail',
      await evaluate(
        window,
        `(async () => {
           const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
           const btn = Array.from(document.querySelectorAll('button'))
             .find((b) => (b.textContent || '').trim() === '返回')
           if (!btn) return { clicked: false }
           btn.click()
           await sleep(900)
           return {
             clicked: true,
             hash: location.hash,
             isDetailRoute: /^#\\/game\\/[^/]+$/.test(location.hash),
             isLibrary: location.hash === '#/library'
           }
         })()`
      )
    )

    // ===== ⑥ 空元数据的详情页：明说「暂无」，不假装（D37） =====
    await evaluate(window, `location.hash = '#/game/${bareId}'`)
    await new Promise((resolve) => setTimeout(resolve, 1200))
    record(
      'detailPageNoMeta',
      await evaluate(
        window,
        `(() => {
           const body = document.body.innerText
           return {
             htmlLen: document.querySelector('#app').innerHTML.length,
             hasDetailLayout: !!document.querySelector('.detail-layout'),
             hasMetaMissing: body.includes('尚未获取 DLsite 信息'),
             hasNoSummary: body.includes('暂无简介'),
             // 没有元数据时「作品信息」区块整块换成提示，不该出现一堆「暂无」
             missingValueCount: document.querySelectorAll('.detail-info-value.is-missing').length,
             hasLaunchButton: Array.from(document.querySelectorAll('button')).map((b) => (b.textContent || '').trim()).includes('启动游戏'),
             refreshDisabled: (() => {
               const btn = Array.from(document.querySelectorAll('button'))
                 .find((b) => (b.textContent || '').trim() === '重新获取元数据')
               return btn ? btn.disabled || btn.classList.contains('is-disabled') : null
             })()
           }
         })()`
      )
    )

    // ===== ⑦ 详情页的启动按钮真的接了启动链路（会因诊断被拦/或因无引擎报错，但必须"有反应"）=====
    record(
      'detailLaunchWired',
      await evaluate(
        window,
        `(async () => {
           const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
           const btn = Array.from(document.querySelectorAll('button'))
             .find((b) => (b.textContent || '').trim() === '启动游戏')
           if (!btn) return { clicked: false }
           btn.click()
           await sleep(1500)
           const body = document.body.innerText
           return {
             clicked: true,
             // 诊断框（M3）或错误提示（无引擎）都算"接上了"，关键是不能静默无反应
             hasDiagnosisDialog: !!document.querySelector('.el-dialog'),
             hasMessage: document.querySelectorAll('.el-message').length > 0,
             hasChineseError: body.includes('失败') || body.includes('无法') || body.includes('引擎'),
             htmlLen: document.querySelector('#app').innerHTML.length
           }
         })()`
      )
    )

    // ===== ⑧ 列表视图同样没有启动按钮（S2 对 row 变体也生效）=====
    await evaluate(window, "location.hash = '#/library'")
    await new Promise((resolve) => setTimeout(resolve, 1200))
    record(
      'listViewNoLaunch',
      await evaluate(
        window,
        `(async () => {
           const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
           // 切到列表视图（读 settings.listView，点工具栏的「列表」）
           const radio = Array.from(document.querySelectorAll('.el-radio-button'))
             .find((el) => (el.textContent || '').trim() === '列表')
           if (radio) radio.click()
           await sleep(900)
           const rows = Array.from(document.querySelectorAll('.game-row'))
           const buttons = Array.from(document.querySelectorAll('.game-row button')).map((b) => (b.textContent || '').trim())
           return {
             rowCount: rows.length,
             hasLaunchButton: buttons.includes('启动') || buttons.includes('启动游戏'),
             menuTriggers: document.querySelectorAll('.game-row-actions .game-card-menu-trigger').length,
             buttons
           }
         })()`
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

process.on('uncaughtException', (error) => {
  results.fatal = String(error)
  dump(results)
  app.exit(1)
})
