#!/usr/bin/env node
// 引擎页 UI 探针（M6.5）：验证 9 张卡片能渲染、两种警告标签各自出现、零 console 错误。
//
// ===== 为什么必须有这个探针 =====
//
// 单测只能验「判据对不对」「模板里有没有那个字符串」。它们**看不到真实 DOM**：
//   · `v-if` 写对了但作用域里没有那个函数 → 渲染时抛错（vue 会吞进 console）
//   · i18n key 拼错 → 页面画出 key 原文（**不报错**）
//   · 两张卡片的 el-tag 都渲染但文字相同 → 用户分不清「上游限制」与「未验证」
//
// 所以按 AGENTS.md 的验收惯例：起真实 Electron、用 CDP 读真实 DOM。
//
// ===== 2026-11-05 mac 真机实测记录（YomedeMacBook-Neo / macOS 26.6.2 / arm64）=====
//
// 全部通过：
//   · 卡片 9 张：nwjs / mkxpz / easyrpg / renpy / tyrano / kirikiri / nscripter / siglus / godot
//   · 老四个**无**警告标签；kirikiri 有「上游限制」；tyrano/nscripter/siglus/godot 有「未验证」
//   · **tyrano 没有「安装」按钮**（空依赖 → 显示「无需单独下载」）
//   · **零 console 错误**
//
// 三条实测踩到的坑（改动这个探针前先读）：
//   ① `window.__pinia` 是 **undefined** —— 不能用 store 导航，必须点真实 UI
//   ② tab 不是 `.el-tabs__item`，而是 **`el-radio-button__inner`**（span），
//      文本形如 `可安装 (9)`
//   ③ 「可安装」这个词在页面里出现 5 次（含提示语、按钮），必须**取最内层那个 span**
//
// 用法：node scripts/probe-engine-page.cjs
// 产物：.dev-scratch/probe-engine-page.json（**写在项目目录内**，%TEMP% 可能 EPERM）
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const OUT_DIR = path.join(ROOT, '.dev-scratch')
const OUT_FILE = path.join(OUT_DIR, 'probe-engine-page.json')
const DATA_DIR = path.join(ROOT, '.dev-data-probe-engine')

/** 期望的引擎清单（顺序与 registry 的 ENGINES 一致）。 */
const EXPECTED_FOLDERS = [
  'nwjs',
  'mkxpz',
  'easyrpg',
  'renpy',
  'tyrano',
  'kirikiri',
  'nscripter',
  'siglus',
  'godot'
]

/** 期望的警告标签（folder → 标签文字）。老四个不在表里 = 不该有标签。 */
const EXPECTED_BADGES = {
  tyrano: '未验证',
  kirikiri: '上游限制',
  nscripter: '未验证',
  siglus: '未验证',
  godot: '未验证'
}

/** 不该有「安装」按钮的引擎（dependencies 为空）。 */
const NO_INSTALL_BTN = ['tyrano']

fs.mkdirSync(OUT_DIR, { recursive: true })
// 探针要一个干净的隔离数据目录（不碰用户真实数据）
fs.rmSync(DATA_DIR, { recursive: true, force: true })
fs.mkdirSync(DATA_DIR, { recursive: true })

const logPath = path.join(OUT_DIR, 'probe-engine-page.log')
const logStream = fs.createWriteStream(logPath)

const electronBin = require('electron')
const env = { ...process.env }
// 本机实测：不清这两个会让 electron 以纯 Node 模式跑 → protocol undefined
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
env.ELECTRON_ENTRY = path.join('out', 'main', 'index.js')
env.TSUMIGEYA_DATA_DIR = DATA_DIR
env.ELECTRON_ENABLE_LOGGING = '1'

const child = spawn(electronBin, ['.', '--no-sandbox', '--remote-debugging-port=0', '--enable-logging'], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe']
})

let stdoutBuf = ''
let stderrBuf = ''
child.stdout.on('data', (d) => {
  stdoutBuf += d.toString()
  logStream.write(d)
})
child.stderr.on('data', (d) => {
  stderrBuf += d.toString()
  logStream.write(d)
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 从日志里读实际调试端口（传 0 后端口是随机的，这是实测结论）。 */
async function waitForPort(deadlineMs) {
  const started = Date.now()
  while (Date.now() - started < deadlineMs) {
    const m = /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(stdoutBuf + stderrBuf)
    if (m) return Number(m[1])
    await sleep(400)
  }
  return null
}

/** 极简 CDP 客户端：只用 WebSocket + Runtime.evaluate。 */
async function connect(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  const targets = await res.json()
  const page = targets.find((t) => t.type === 'page') || targets[0]
  if (!page) throw new Error('没有 page target')
  return page.webSocketDebuggerUrl
}

function makeRpc(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let nextId = 1
    const pending = new Map()
    const listeners = []
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      for (const fn of listeners) {
        try {
          fn(msg)
        } catch {
          /* 忽略 */
        }
      }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) rej(new Error(JSON.stringify(msg.error)))
        else res(msg.result)
      }
    })
    ws.addEventListener('error', reject)
    ws.addEventListener('open', () => {
      resolve({
        ws,
        onMessage(fn) {
          listeners.push(fn)
        },
        send(method, params) {
          const id = nextId++
          return new Promise((res, rej) => {
            pending.set(id, { res, rej })
            ws.send(JSON.stringify({ id, method, params }))
          })
        }
      })
    })
  })
}

async function main() {
  const result = {
    ok: false,
    stage: 'start',
    port: null,
    cardCount: 0,
    cards: [],
    checks: {},
    failures: [],
    consoleErrors: [],
    notes: []
  }

  try {
    const port = await waitForPort(30000)
    if (!port) {
      result.stage = 'no-port'
      result.notes.push('30s 内没读到 DevTools 端口。stderr 尾部：' + stderrBuf.slice(-800))
      return result
    }
    result.port = port
    result.stage = 'connected'

    const rpc = await makeRpc(await connect(port))
    await rpc.send('Runtime.enable')
    await rpc.send('Log.enable')

    const consoleErrors = []
    rpc.onMessage((msg) => {
      if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
        consoleErrors.push(String(msg.params.entry.text).slice(0, 300))
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params?.exceptionDetails
        const text = String(d?.exception?.description ?? d?.text ?? 'exception')
        consoleErrors.push(text.slice(0, 300))
      }
    })

    const evaluate = async (expression) => {
      const r = await rpc.send('Runtime.evaluate', {
        expression,
        awaitPromise: true,
        returnByValue: true
      })
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400))
      return r.result?.value
    }

    await sleep(3000)
    result.stage = 'ui-ready'

    // 1) 点侧边栏「引擎管理」（**不能用 pinia**：实测 window.__pinia 是 undefined）
    const nav = await evaluate(`(() => {
      const anchors = [...document.querySelectorAll('a')]
      const target = anchors.find((el) => (el.textContent || '').includes('引擎管理'))
      if (!target) return { ok: false, seen: anchors.map((e) => (e.textContent || '').trim()) }
      target.click()
      return { ok: true }
    })()`)
    result.notes.push('侧边栏导航：' + JSON.stringify(nav))
    if (!nav || !nav.ok) throw new Error('找不到「引擎管理」导航')
    await sleep(2000)

    // 2) 切到「可安装」。
    //    ⚠️ 实测：tab 是 `el-radio-button__inner`（span），文本 `可安装 (9)`；
    //    而「可安装」在页面里出现多次（提示语、按钮），所以**取最内层那个**。
    const tab = await evaluate(`(() => {
      const cands = [...document.querySelectorAll('*')].filter(
        (el) => (el.textContent || '').includes('可安装') && el.children.length <= 1
      )
      const target = cands[cands.length - 1]
      if (!target) return { ok: false }
      target.click()
      return { ok: true, cls: target.className }
    })()`)
    result.notes.push('可安装 tab：' + JSON.stringify(tab))
    await sleep(2500)

    // 3) 读真实 DOM
    const dom = await evaluate(`(() => {
      const cards = [...document.querySelectorAll('.engine-card')]
      return cards.map((c) => ({
        name: (c.querySelector('.engine-card-name') || {}).textContent || '',
        folder: ((c.querySelector('.hint') || {}).textContent || '').trim(),
        tags: [...c.querySelectorAll('.el-tag')].map((t) => t.textContent.trim()),
        hasInstallBtn: [...c.querySelectorAll('button')].some((b) => (b.textContent || '').includes('安装')),
        bodyText: (c.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200)
      }))
    })()`)

    result.cards = dom
    result.cardCount = dom.length

    // ---- 逐条核对 ----
    const fail = (msg) => result.failures.push(msg)

    // ① 9 张卡片，且 folder 顺序与 registry 一致
    if (dom.length !== EXPECTED_FOLDERS.length) {
      fail(`卡片数 ${dom.length}，期望 ${EXPECTED_FOLDERS.length}`)
    }
    const folders = dom.map((c) => c.folder)
    if (JSON.stringify(folders) !== JSON.stringify(EXPECTED_FOLDERS)) {
      fail(`folder 顺序不符：${JSON.stringify(folders)}`)
    }

    // ② 警告标签逐个核对
    for (const [folder, expected] of Object.entries(EXPECTED_BADGES)) {
      const card = dom.find((c) => c.folder === folder)
      if (!card) {
        fail(`缺卡片 ${folder}`)
        continue
      }
      if (!card.tags.includes(expected)) {
        fail(`${folder} 缺「${expected}」标签（实际标签：${card.tags.join(',')}）`)
      }
    }

    // ③ 老四个不该有任何警告标签
    for (const folder of ['nwjs', 'mkxpz', 'easyrpg', 'renpy']) {
      const card = dom.find((c) => c.folder === folder)
      if (!card) {
        fail(`缺卡片 ${folder}`)
        continue
      }
      if (card.tags.includes('未验证') || card.tags.includes('上游限制')) {
        fail(`${folder} 不该有警告标签（实际：${card.tags.join(',')}）`)
      }
    }

    // ④ 空依赖的引擎不该有「安装」按钮
    for (const folder of NO_INSTALL_BTN) {
      const card = dom.find((c) => c.folder === folder)
      if (card?.hasInstallBtn) fail(`${folder} 不该有「安装」按钮（它的 dependencies 是空的）`)
      if (card && !card.bodyText.includes('无需单独下载')) {
        fail(`${folder} 应显示「无需单独下载」`)
      }
    }

    // ⑤ 有依赖的引擎必须有「安装」按钮
    for (const folder of EXPECTED_FOLDERS.filter((f) => !NO_INSTALL_BTN.includes(f))) {
      const card = dom.find((c) => c.folder === folder)
      if (card && !card.hasInstallBtn) fail(`${folder} 应有「安装」按钮`)
    }

    // ⑥ 没有把 i18n key 原样画出来（vue-i18n 查不到时不报错，只会画出 key 原文）
    for (const card of dom) {
      if (card.bodyText.includes('engines.') || card.tags.some((t) => t.startsWith('engines.'))) {
        fail(`${card.folder} 把 i18n key 原样画出来了`)
      }
    }

    result.consoleErrors = consoleErrors
    if (consoleErrors.length > 0) fail(`有 ${consoleErrors.length} 条 console 错误`)

    result.ok = result.failures.length === 0
    result.stage = 'done'
  } catch (error) {
    result.stage = 'error'
    result.notes.push('异常：' + (error && error.message ? error.message : String(error)))
  } finally {
    try {
      child.kill()
    } catch {
      /* 忽略 */
    }
    fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2), 'utf8')
    logStream.end()
  }

  return result
}

main().then((result) => {
  console.log('PROBE ' + JSON.stringify(result, null, 2))
  console.log(result.ok ? '\n✅ 引擎页探针全部通过' : `\n❌ 失败项：\n- ${result.failures.join('\n- ')}`)
  process.exit(result.ok ? 0 : 1)
})
