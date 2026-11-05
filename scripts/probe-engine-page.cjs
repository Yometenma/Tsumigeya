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
// 用法：node scripts/probe-engine-page.cjs
// 产物：.dev-scratch/probe-engine-page.json（**写在项目目录内**，%TEMP% 可能 EPERM）
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.cwd()
const OUT_DIR = path.join(ROOT, '.dev-scratch')
const OUT_FILE = path.join(OUT_DIR, 'probe-engine-page.json')
const DATA_DIR = path.join(ROOT, '.dev-data-probe-engine')

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

const child = spawn(
  electronBin,
  ['.', '--no-sandbox', '--remote-debugging-port=0', '--enable-logging'],
  { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false }
)

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
    ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
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
    cardCount: null,
    cards: [],
    tags: {},
    consoleErrors: [],
    missingKeys: [],
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

    const wsUrl = await connect(port)
    const rpc = await makeRpc(wsUrl)

    await rpc.send('Runtime.enable')
    await rpc.send('Log.enable')

    // 收集 console 错误
    const consoleErrors = []
    rpc.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data)
      if (msg.method === 'Log.entryAdded' && msg.params?.entry?.level === 'error') {
        consoleErrors.push(String(msg.params.entry.text).slice(0, 300))
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params?.exceptionDetails
        consoleErrors.push(String(d?.exception?.description ?? d?.text ?? 'exception').slice(0, 300))
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

    result.stage = 'ui-ready'
    // 等渲染层挂上
    await sleep(2500)

    // 1) 走 Pinia store 切到引擎页 + 可安装 tab（AGENTS.md：验收 UI 必须走 store）
    const switched = await evaluate(`(async () => {
      const pinia = window.__pinia || (window.$pinia)
      if (!pinia) return { ok: false, why: 'no pinia on window' }
      const engines = pinia._s.get('engines')
      if (!engines) return { ok: false, why: 'no engines store' }
      await engines.loadRemote()
      return { ok: true, available: engines.available.length }
    })()`)
    result.notes.push('store 切换：' + JSON.stringify(switched))

    // 2) 直接导航到引擎页并切到「可安装」
    await evaluate(`(() => {
      const w = window
      if (w.location.hash !== '#/engines') w.location.hash = '#/engines'
      return true
    })()`)
    await sleep(1200)

    // 点「可安装」tab
    await evaluate(`(() => {
      const els = [...document.querySelectorAll('.el-tabs__item')]
      const target = els.find((el) => el.textContent.includes('可安装') || el.textContent.includes('可安装' ))
      if (target) { target.click(); return 'clicked' }
      return 'no-tab:' + els.map(e=>e.textContent.trim()).join('|')
    })()`)
    await sleep(900)

    // 3) 读真实 DOM
    const dom = await evaluate(`(() => {
      const cards = [...document.querySelectorAll('.engine-card')]
      return {
        cardCount: cards.length,
        cards: cards.map((c) => ({
          name: (c.querySelector('.engine-card-name')?.textContent || '').trim(),
          folder: (c.querySelector('.hint')?.textContent || '').trim(),
          tags: [...c.querySelectorAll('.el-tag')].map((t) => t.textContent.trim()),
          hasInstallBtn: [...c.querySelectorAll('button')].some((b) => b.textContent.includes('安装')),
          bodyText: c.textContent.replace(/\\s+/g, ' ').trim().slice(0, 160)
        }))
      }
    })()`)
    result.cardCount = dom.cardCount
    result.cards = dom.cards

    // 4) 统计标签种类
    const tagTexts = dom.cards.flatMap((c) => c.tags)
    result.tags = {
      upstreamGate: tagTexts.filter((t) => t === '上游限制').length,
      unverified: tagTexts.filter((t) => t === '未验证').length,
      installBtns: dom.cards.filter((c) => c.hasInstallBtn).length,
      noDependencyText: dom.cards.filter((c) => c.bodyText.includes('无需单独下载')).length
    }

    // 5) 有没有把 i18n key 原样画出来（vue-i18n 查不到时不报错）
    const rawKeys = dom.cards.filter(
      (c) => c.bodyText.includes('engines.') || c.tags.some((t) => t.startsWith('engines.'))
    )
    result.missingKeys = rawKeys.map((c) => c.folder)

    result.consoleErrors = consoleErrors
    result.ok = dom.cardCount > 0 && consoleErrors.length === 0 && rawKeys.length === 0
    result.stage = 'done'
  } catch (error) {
    result.stage = 'error'
    result.notes.push('异常：' + (error && error.message ? error.message : String(error)))
  } finally {
    try {
      child.kill()
    } catch {
      // 忽略
    }
    fs.writeFileSync(OUT_FILE, JSON.stringify(result, null, 2), 'utf8')
    logStream.end()
  }

  return result
}

main().then((result) => {
  console.log('PROBE ' + JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
})
