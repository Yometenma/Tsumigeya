// Electron 主进程入口：协议注册、BrowserWindow、tsmg:// 图片协议、CSP、生命周期。
// 契约：docs/M1-实施方案.md §3.7（tsmg://）+ §4（index.ts 行）。
// 注意：主进程是 CJS 产物，不要写 import.meta / 顶层 await（§8 已知坑）。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, net, protocol, session, shell } from 'electron'
import { createCoreHost, resolveCorePath, resolveDataDirWithFallback, type CoreHost } from './core-host'
import { registerIpc } from './ipc'

/** 图片扩展名白名单（§3.7）。 */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'ico'])

// 注意：不要在这里调用 app.setName()。
// 顶层调用 setName 会让本机 Electron 直接 segfault（0xc0000005，可稳定复现），
// 而且是「不报错、直接崩」的那种，极难排查。数据目录由 app.whenReady 里的
// resolveDataDir 显式决定，不依赖 app.getName()。

let mainWindow: BrowserWindow | null = null
let host: CoreHost | null = null

/** core 单例（app ready 之后创建一次，全进程复用）。 */
export function coreHost(): CoreHost {
  if (!host) throw new Error('core host is not ready yet')
  return host
}

// 必须在 app ready 之前注册（§3.7）
protocol.registerSchemesAsPrivileged([
  { scheme: 'tsmg', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 880,
    minHeight: 560,
    show: false,
    title: 'Tsumigeya',
    backgroundColor: '#1b1b1f',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })

  window.once('ready-to-show', () => window.show())

  // 外部链接交给系统浏览器，窗口内不允许导航到别处（§3.7 的安全前提）
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env.ELECTRON_RENDERER_URL
    if (devServer && url.startsWith(devServer)) return
    event.preventDefault()
  })

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (devServerUrl) void window.loadURL(devServerUrl)
  else void window.loadFile(path.join(__dirname, '../renderer/index.html'))

  return window
}

/** `tsmg://img/<encodeURIComponent(绝对路径)>` → 图片字节；任何异常一律 404，绝不抛到主进程。 */
function registerImageProtocol(): void {
  protocol.handle('tsmg', async (request) => {
    try {
      const target = decodeURIComponent(new URL(request.url).pathname.slice(1))
      if (!path.isAbsolute(target)) return new Response(null, { status: 404 })
      const extension = path.extname(target).replace(/^\./, '').toLowerCase()
      if (!IMAGE_EXTENSIONS.has(extension)) return new Response(null, { status: 404 })
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return new Response(null, { status: 404 })
      return await net.fetch(pathToFileURL(target).toString())
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}

/** 渲染层 CSP（开发允许 Vite 的 HMR websocket / eval）。 */
function applyContentSecurityPolicy(): void {
  const devServer = process.env.ELECTRON_RENDERER_URL
  const policy = devServer
    ? [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        // M2：DLsite 封面来自 img.dlsite.jp，必须进 img-src 白名单（方案 §6.5）。
        // **只加 img-src，不动 connect-src / script-src / default-src**：
        // 抓取全在主进程（D20），渲染层不需要向 DLsite 发任何 XHR。
        // 两处分支都必须改——只改一处会出现「dev 能看见封面、打包后全灰」的怪象。
        "img-src 'self' data: tsmg: https://img.dlsite.jp",
        "font-src 'self' data:",
        `connect-src 'self' ${devServer} ws://localhost:* http://localhost:*`
      ]
    : [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: tsmg: https://img.dlsite.jp",
        "font-src 'self' data:",
        "connect-src 'self'"
      ]
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy.join('; ')]
      }
    })
  })
}

/**
 * 写 DLsite 需要的 `adultchecked=1` cookie（方案 §4.2）。
 *
 * 为什么不直接发 `Cookie:` 请求头：Chromium 网络栈会剥掉手工设置的 Cookie 头，
 * 而走 session cookie 是浏览器原生行为。失败只 warn 不阻塞——最多抓到年龄确认页，
 * 那会被 parse 判成 error.dlsiteParse（明示「可能已改版/需要登录」），不会静默错数据。
 */
async function setAdultCookie(): Promise<void> {
  const expires = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60
  await session.defaultSession.cookies.set({
    url: 'https://www.dlsite.com',
    name: 'adultchecked',
    value: '1',
    domain: '.dlsite.com',
    path: '/',
    secure: true,
    expirationDate: expires
  })
}

void app.whenReady().then(async () => {
  // 代理：必须显式让 session 读取系统代理，并且**必须 await**。
  //
  // 1) 为什么必须显式设置：Electron 的 `net.fetch` 用的是 session 的代理设置，
  //    而 session 默认 `mode: direct`——**不会**自动读系统代理。
  //    （「继承 Chromium 代理」是浏览器 window 的行为，主进程的 net 不享受。）
  //    后果：用户在 macOS 上开着 Clash/Surge，引擎却下载失败，报「网络连接关闭」之类，
  //    而浏览器明明能上网，极难排查。
  // 2) 为什么要 await：setProxy 是异步的。不等待就创建 host，
  //    用户点「安装引擎」时第一次请求可能仍在 direct 模式下发出，表现为偶发失败。
  await session.defaultSession.setProxy({ mode: 'system' }).then(
    () => console.info('[tsumigeya] 已启用系统代理读取（mode: system）'),
    (error) => console.warn('[tsumigeya] 启用系统代理失败（将直连）:', error)
  )

  // 数据目录建不起来时不要让整个应用静默死掉：先尝试首选目录，失败则退到临时目录，
  // 并把这个事实通过 dialog 告诉用户（否则用户只看到「窗口没弹出来」，毫无线索）。
  const { dataDir, warning } = resolveDataDirWithFallback()

  const corePath = resolveCorePath({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath
  })

  host = createCoreHost({
    dataDir,
    corePath,
    dataDirWarning: warning,
    // 显式注入 Electron 的 net.fetch，**不要依赖 core-host 里的懒加载兜底**。
    // 兜底逻辑在拿不到 electron.net 时会退回全局 fetch，而全局 fetch 完全不读系统代理，
    // 会出现「浏览器能上网、引擎下载却失败」的割裂现象，且很难排查。
    // net.fetch + session.setProxy({ mode: 'system' }) 才能让下载走用户的代理。
    fetchImpl: (input, init) => net.fetch(input, init as never),
    // M2：DLsite 的作品页要 `adultchecked=1` cookie 才能过年龄闸门（方案 §4.2）。
    setAdultCookie,
    onEvent: (event) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) window.webContents.send('tsumi:event', event)
      }
    }
  })

  registerImageProtocol()
  applyContentSecurityPolicy()
  mainWindow = createWindow()
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // IPC 命令表（S3）：注册一次，全窗口共用
  registerIpc({ host })

  host.emit({ event: 'ready', nodeVersion: process.version })

  // 降级不弹模态框：这里不是「用户做错了什么」，弹窗只会打断启动流程。
  // 改为把降级信息带进 snapshot（settings 页展示），并在日志里留痕。
  if (warning) {
    console.warn(
      `[tsumigeya] 默认数据目录不可写（${warning.requested}：${warning.code}），` +
        `已临时改用 ${warning.switchedTo}。可设置 TSUMIGEYA_DATA_DIR 固定目录。`
    )
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow()
      mainWindow.on('closed', () => {
        mainWindow = null
      })
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
