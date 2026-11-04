// M2.5 端到端验收探针（在 Electron 主进程里跑）。
// 由 scripts/probe-m25.cjs 以「文件入口」启动。
//
// S2 的验收判据（docs/M2.5-实施方案.md §5）：
//   1) 真实应用里搜「傭兵」能出候选结果
//   2) 点选后能把 RJ 填进输入框，且能接着查询
//   3) 搜索命令不挂死、不走队列（排在 60s 更新检查后面会表现为「点了没反应」）
//   4) 编辑页组件没白屏（M2.5-A 加了模板，白屏风险最高）
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const OUT = path.join(__dirname, '..', 'out')
const dataDir = process.env.TSUMIGEYA_DATA_DIR
const REPORT = path.join(__dirname, '..', '.dev-data-m25probe.json')
const BOOT = path.join(__dirname, '..', '.dev-data-m25boot.txt')

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

    // ===== ① 真网络搜索：搜「傭兵」必须出候选 =====
    // 这条同时验「走系统代理」「URL 格式」「解析」「绕队列不挂死」。
    const searchStarted = Date.now()
    const searchResult = await evaluate(
      window,
      `Promise.race([
         window.tsumi.invoke('dlsiteSearch', { keyword: '傭兵' }).then(
           (value) => ({
             ok: true,
             keyword: value.keyword,
             count: value.results.length,
             first: value.results[0] || null,
             rjs: value.results.map((hit) => hit.rj)
           }),
           (error) => ({ ok: false, key: error.key ?? null, message: (error.message || '').slice(0, 80) })
         ),
         new Promise((resolve) => setTimeout(() => resolve({ ok: false, key: 'HUNG' }), 30000))
       ])`
    )
    record('searchMercenary', searchResult)
    record('searchMercenaryMs', Date.now() - searchStarted)

    // ===== ② 连续第二次搜索的耗时：绕队列的话应该是网络耗时，不是排队耗时 =====
    const secondStarted = Date.now()
    const second = await evaluate(
      window,
      `window.tsumi.invoke('dlsiteSearch', { keyword: '傭兵の冒険' }).then(
         (value) => ({ ok: true, count: value.results.length }),
         (error) => ({ ok: false, key: error.key ?? null })
       )`
    )
    record('searchSecondCall', second)
    record('searchSecondCallMs', Date.now() - secondStarted)

    // ===== ③ 搜不到的关键词 → error.dlsiteSearchEmpty =====
    // ⚠️ 不能只看 error.key：contextBridge 跨边界会丢自定义属性（AGENTS.md 已知坑），
    // key 被编进 message 尾部标记，渲染层靠 decodeBridgeError 解回来。
    // 这里按同一套格式解一次，验「用户实际能不能看到中文文案」。
    // 编码格式（src/shared/bridge-error.ts）：<message><marker><key>:<encodeURIComponent(JSON)>
    const emptyProbeCode = [
      "window.tsumi.invoke('dlsiteSearch', { keyword: 'zzzzzz不存在的关键词zzzzzz' }).then(",
      '  (value) => ({ ok: true, count: value.results.length }),',
      '  (error) => {',
      "    const message = error.message || ''",
      "    const marker = '\\u0000tsumi-key:'",
      '    const index = message.indexOf(marker)',
      '    let decodedKey = null',
      '    let decodedArgs = null',
      '    if (index >= 0) {',
      '      const tail = message.slice(index + marker.length)',
      "      const colon = tail.indexOf(':')",
      '      decodedKey = colon === -1 ? tail : tail.slice(0, colon)',
      "      const rawArgs = colon === -1 ? '' : tail.slice(colon + 1)",
      '      if (rawArgs) {',
      '        try { decodedArgs = JSON.parse(decodeURIComponent(rawArgs)) } catch (e) { decodedArgs = String(e) }',
      '      }',
      '    }',
      '    return {',
      '      ok: false,',
      '      key: error.key ?? null,',
      '      decodedKey,',
      '      decodedArgs,',
      '      hasMarker: index >= 0,',
      '      message: message.slice(0, 90)',
      '    }',
      '  }',
      ')'
    ].join('\n')
    record('searchEmptyKeyword', await evaluate(window, emptyProbeCode))

    // ===== ④ 搜索不写盘：library-meta.json 不该因为搜索被创建 =====
    record('metaFileAfterSearch', fs.existsSync(path.join(dataDir || '.', 'library-meta.json')))

    // ===== ⑤ 编辑页 UI：点「按名字搜索」能出候选列表、能点选填 RJ =====
    // 先种一条游戏（否则编辑页落到「游戏不存在」）
    const seeded = await evaluate(
      window,
      `window.tsumi.invoke('saveGame', { id: undefined, game: {
         gameTitle: '测试游戏', gamePath: ${JSON.stringify((dataDir || '.') + '/傭兵の冒険_CHN')},
         gameEngine: 'mkxpz'
       } }).then(
         (value) => ({ ok: true, id: value.games[0]?.id }),
         (error) => ({ ok: false, message: error.message })
       )`
    )
    record('seedGame', seeded)

    // 重载让 Pinia store 真拿到 snapshot（直接调 IPC 不会更新 store）
    const loaded = new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
    window.webContents.reload()
    await loaded
    await new Promise((resolve) => setTimeout(resolve, 900))

    const gameId = seeded?.id ?? '1'
    await evaluate(window, `location.hash = '#/game/${gameId}'`)
    await new Promise((resolve) => setTimeout(resolve, 800))

    record('editHtmlLen', await evaluate(window, 'document.querySelector("#app").innerHTML.length'))
    record('editHasSearchButton', await evaluate(window, 'document.body.innerText.includes("按名字搜索")'))

    // 真点按钮（走真组件逻辑，不是直接调 IPC）
    record(
      'clickedSearchButton',
      await evaluate(
        window,
        `(() => {
           const buttons = Array.from(document.querySelectorAll('button'))
           const target = buttons.find((btn) => (btn.textContent || '').trim() === '按名字搜索')
           if (target) target.click()
           return !!target
         })()`
      )
    )
    await new Promise((resolve) => setTimeout(resolve, 400))
    record('searchPanelOpened', await evaluate(window, '!!document.querySelector(".search-panel")'))
    // 关键词默认值应来自目录名（傭兵の冒険_CHN → 傭兵の冒険）
    record(
      'keywordDefault',
      await evaluate(window, 'document.querySelector(".search-panel input")?.value ?? ""')
    )

    // 点面板里的「搜索」按钮（组件内的 runSearch）
    record(
      'clickedSubmit',
      await evaluate(
        window,
        `(() => {
           const panel = document.querySelector('.search-panel')
           if (!panel) return false
           const target = Array.from(panel.querySelectorAll('button'))
             .find((btn) => (btn.textContent || '').trim() === '搜索')
           if (target) target.click()
           return !!target
         })()`
      )
    )
    // 等真网络返回（走代理约 1-3 秒）
    await new Promise((resolve) => setTimeout(resolve, 6000))
    record(
      'uiSearchHits',
      await evaluate(
        window,
        `(() => {
           const hits = document.querySelectorAll('.search-hit')
           return {
             count: hits.length,
             titles: Array.from(hits).slice(0, 5).map((hit) => hit.querySelector('.search-hit-title')?.textContent || '')
           }
         })()`
      )
    )

    // 点第一条候选 → RJ 输入框应被填上，且面板收起
    const pickInfo = await evaluate(
      window,
      `(() => {
         const first = document.querySelector('.search-hit')
         if (!first) return { picked: false }
         const expectedRj = (first.querySelector('.hint')?.textContent || '').trim()
         first.click()
         return { picked: true, expectedRj }
       })()`
    )
    await new Promise((resolve) => setTimeout(resolve, 500))
    record('uiPick', {
      ...pickInfo,
      rjInputValue: await evaluate(
        window,
        `(() => {
           const inputs = Array.from(document.querySelectorAll('.settings-row input'))
           return inputs.map((input) => input.value).find((value) => /RJ/.test(value)) || ''
         })()`
      ),
      panelClosed: await evaluate(window, '!document.querySelector(".search-panel")')
    })

    // ===== ⑥ 用刚点选到的 RJ 真查询一次（搜索 → 填 RJ → 查询 的闭环）=====
    // ⚠️ 用 pickInfo.expectedRj 而不是写死的 RJ——否则验的是「随便一个 RJ 能查」，
    // 而不是「点选的那个作品能查」，两者完全不同。
    const pickedRj = (pickInfo && pickInfo.expectedRj) || ''
    if (pickedRj) {
      record(
        'lookupAfterPick',
        await evaluate(
          window,
          `window.tsumi.invoke('dlsiteLookup', { rj: ${JSON.stringify(pickedRj)} }).then(
             (value) => ({ ok: true, title: value.title, rj: value.rj }),
             (error) => ({ ok: false, key: error.key ?? null, message: (error.message || '').slice(0, 80) })
           )`
        )
      )
    } else {
      record('lookupAfterPick', { ok: false, reason: '没有点选到候选，跳过' })
    }

    record('finalConsoleErrors', consoleErrors.slice())

    // ===== ⑦ S4：可编辑元数据（改标题 → 持久化 → 刷新不丢）=====
    // 先把点选到的 RJ 真存进库里（否则编辑页没有 meta 可改）
    record(
      'editSeed',
      await evaluate(
        window,
        `window.tsumi.invoke('dlsiteLookup', { rj: 'RJ306254' })
           .then((work) => window.tsumi.invoke('saveGameMeta', { gameId: ${JSON.stringify(gameId)}, work }))
           .then(
             (snapshot) => ({ ok: true, metaTitle: snapshot.meta[${JSON.stringify(gameId)}]?.title }),
             (error) => ({ ok: false, message: (error && error.message) || String(error) })
           )`
      )
    )

    // ⚠️ 必须用主进程的 webContents.reload()，不能在渲染层里 location.reload()：
    // 后者会销毁 JS 上下文，executeJavaScript 的 promise 直接挂住（AGENTS.md 已知坑）。
    const loadedAfterSeed = new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
    window.webContents.reload()
    await loadedAfterSeed
    // store 的 snapshot 在 App.onMounted 里异步拉，等它落定
    await new Promise((resolve) => setTimeout(resolve, 1500))

    await evaluate(window, `location.hash = '#/game/${gameId}'`)
    await new Promise((resolve) => setTimeout(resolve, 1500))

    record('editPageAfterSeed', {
      htmlLen: await evaluate(window, 'document.querySelector("#app").innerHTML.length'),
      metaFieldCount: await evaluate(window, 'document.querySelectorAll(".meta-field").length'),
      diag: await evaluate(
        window,
        `(() => {
           const hasDlsiteSection = document.body.innerText.includes('DLsite 信息')
           const hasNoMetaHint = document.body.innerText.includes('尚未获取 DLsite 信息')
           const hasPreview = !!document.querySelector('.dlsite-preview')
           return { hasDlsiteSection, hasNoMetaHint, hasPreview, hash: location.hash }
         })()`
      )
    })

    // 点标题那一行的「编辑」按钮
    record(
      'clickEditTitle',
      await evaluate(
        window,
        `(() => {
           const fields = Array.from(document.querySelectorAll('.meta-field-view'))
           const titleRow = fields.find((row) => (row.textContent || '').includes('标题'))
           if (!titleRow) return { clicked: false, rows: fields.length }
           const btn = Array.from(titleRow.querySelectorAll('button'))
             .find((b) => (b.textContent || '').trim() === '编辑')
           if (!btn) return { clicked: false, reason: 'no edit button' }
           btn.click()
           return { clicked: true }
         })()`
      )
    )
    await new Promise((resolve) => setTimeout(resolve, 400))
    record('editInputOpen', await evaluate(window, '!!document.querySelector(".meta-field-edit .el-input")'))

    // 填新标题并保存
    record(
      'fillAndSaveTitle',
      await evaluate(
        window,
        `(async () => {
           const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
           const input = document.querySelector('.meta-field-edit input')
           if (!input) return { ok: false, reason: 'no input' }
           const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
           setter.call(input, '我改的标题 E2E')
           input.dispatchEvent(new Event('input', { bubbles: true }))
           await sleep(300)
           const row = document.querySelector('.meta-field-edit')
           if (!row) return { ok: false, reason: 'row gone', inputValue: input.value }
           const buttons = Array.from(row.querySelectorAll('button')).map((b) => (b.textContent || '').trim())
           const saveBtn = Array.from(row.querySelectorAll('button'))
             .find((b) => (b.textContent || '').trim() === '保存')
           if (!saveBtn) return { ok: false, reason: 'no save button', buttons, inputValue: input.value }
           saveBtn.click()
           await sleep(800)
           const snapshot = await window.tsumi.invoke('snapshot')
           const meta = snapshot.meta[${JSON.stringify(gameId)}]
           return {
             ok: true,
             buttons,
             inputValueBeforeSave: input.value,
             title: meta && meta.title,
             edited: meta && meta.edited,
             editedFields: meta && meta.editedFields,
             editInputClosed: !document.querySelector('.meta-field-edit'),
             bodyHasNewTitle: document.body.innerText.includes('我改的标题 E2E'),
             messages: Array.from(document.querySelectorAll('.el-message')).map((el) => (el.textContent || '').trim())
           }
         })()`
      )
    )

    // ⑧ §B.2 核心验收：重新获取不该覆盖用户改过的标题
    record(
      'refreshKeepsEditedTitle',
      await evaluate(
        window,
        `(async () => {
           const snapshot = await window.tsumi.invoke('refreshGameMeta', { gameId: ${JSON.stringify(gameId)} })
           const meta = snapshot.meta[${JSON.stringify(gameId)}]
           return {
             title: meta && meta.title,
             circle: meta && meta.circle,
             edited: meta && meta.edited,
             editedFields: meta && meta.editedFields
           }
         })()`
      )
    )

    // ⑨ 强制覆盖全部 → 标题回到 DLsite 值
    record(
      'forceRefreshRestores',
      await evaluate(
        window,
        `(async () => {
           const snapshot = await window.tsumi.invoke('refreshGameMeta', { gameId: ${JSON.stringify(gameId)}, force: true })
           const meta = snapshot.meta[${JSON.stringify(gameId)}]
           return { title: meta && meta.title, edited: meta && meta.edited, editedFields: meta && meta.editedFields }
         })()`
      )
    )

    record('finalConsoleErrors2', consoleErrors.slice())

    // ===== ⑩ S6：多语言标记与启动确认（§C.5）=====
    // 造出真实的「同一游戏两个语言版」布局，验三件事：
    //   1) 库页卡片出现语言标记与「也有 xx 版」
    //   2) 启动非偏好语言版时弹确认
    //   3) 选「就启动这个」→ 尊重用户选择（不擅自替换成另一个游戏）
    const langSeed = await evaluate(
      window,
      `(async () => {
         const base = ${JSON.stringify((dataDir || '.') + '/lang')}
         const ja = await window.tsumi.invoke('saveGame', { id: undefined, game: {
           gameTitle: '傭兵の冒険', gamePath: base + '/傭兵の冒険', gameEngine: 'mkxpz'
         } })
         const zh = await window.tsumi.invoke('saveGame', { id: undefined, game: {
           gameTitle: '傭兵の冒険_CHN', gamePath: base + '/傭兵の冒険/傭兵の冒険_CHN', gameEngine: 'mkxpz'
         } })
         return { total: zh.games.length }
       })()`
    )
    record('langSeed', langSeed)

    // 直接验分组 IPC（真实数据走主进程逻辑）
    record(
      'languageGroupsIpc',
      await evaluate(
        window,
        `window.tsumi.invoke('languageGroups').then(
           (value) => ({ ok: true, count: value.groups.length, groups: value.groups }),
           (error) => ({ ok: false, key: error.key ?? null })
         )`
      )
    )

    // 重载 → 库页应显示语言标记
    const loadedLang = new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
    window.webContents.reload()
    await loadedLang
    await new Promise((resolve) => setTimeout(resolve, 2000))
    // 重载后会停在上一次的 hash（#/game/x），必须先回库页才看得到卡片
    await evaluate(window, "location.hash = '#/library'")
    await new Promise((resolve) => setTimeout(resolve, 1800))

    record(
      'libraryLangMarkers',
      await evaluate(
        window,
        `(() => {
           const tags = Array.from(document.querySelectorAll('.game-card-lang .el-tag, .game-row-lang .el-tag'))
             .map((tag) => (tag.textContent || '').trim())
           return {
             tagCount: tags.length,
             tags,
             hasAlsoHas: document.body.innerText.includes('也有'),
             langWords: ['中文', '日文'].filter((w) => document.body.innerText.includes(w))
           }
         })()`
      )
    )

    // 启动确认：点日文原版「启动」→ 应弹「要换成偏好的语言版吗？」
    record(
      'launchPromptShown',
      await evaluate(
        window,
        `(async () => {
           const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
           const rows = Array.from(document.querySelectorAll('.game-row, .game-card'))
           const jaRow = rows.find((row) => {
             const title = row.querySelector('.game-row-title, .game-card-title')?.textContent || ''
             return title.trim() === '傭兵の冒険'
           })
           if (!jaRow) return { clicked: false, rows: rows.length }
           const btn = Array.from(jaRow.querySelectorAll('button'))
             .find((b) => (b.textContent || '').trim() === '启动')
           if (!btn) return { clicked: false, reason: 'no launch button' }
           btn.click()
           await sleep(700)
           const box = document.querySelector('.el-message-box')
           return {
             clicked: true,
             boxShown: !!box,
             boxText: box ? (box.innerText || '').replace(/\s+/g, ' ').slice(0, 160) : '',
             hasSwitchTitle: document.body.innerText.includes('要换成偏好的语言版吗'),
             mentionsPreferred: box ? (box.innerText || '').includes('中文') : false
           }
         })()`
      )
    )

    // 点「就启动这个」→ 应尊重用户选择
    record(
      'launchCurrentKeepsChoice',
      await evaluate(
        window,
        `(async () => {
           const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
           const box = document.querySelector('.el-message-box')
           if (!box) return { ok: false, reason: 'no box' }
           const buttons = Array.from(box.querySelectorAll('button'))
             .map((b) => (b.textContent || '').trim())
           const cancelBtn = Array.from(box.querySelectorAll('button'))
             .find((b) => (b.textContent || '').trim() === '就启动这个')
           if (!cancelBtn) return { ok: false, reason: 'no cancel button', buttons }
           cancelBtn.click()
           await sleep(900)
           return { ok: true, boxClosed: !document.querySelector('.el-message-box'), buttons }
         })()`
      )
    )


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
