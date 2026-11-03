// Electron 主进程入口：协议注册、BrowserWindow、tsmg:// 图片协议、CSP、生命周期。
// 契约：docs/M1-实施方案.md §3.7（tsmg://）+ §4（index.ts 行）。
// 注意：主进程是 CJS 产物，不要写 import.meta / 顶层 await（§8 已知坑）。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { app, BrowserWindow, net, protocol, session, shell } from 'electron'
import { createCoreHost, resolveCorePath, resolveDataDir, type CoreHost } from './core-host'
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
        "img-src 'self' data: tsmg:",
        "font-src 'self' data:",
        `connect-src 'self' ${devServer} ws://localhost:* http://localhost:*`
      ]
    : [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: tsmg:",
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

void app.whenReady().then(() => {
  // 不传 userData：文件入口下 app.getPath('userData') 会退化成通用的 "%APPDATA%\Electron"
  // （因为读不到 package.json 的 name），与其它 Electron 应用撞目录，还会撞上权限问题（EPERM）。
  // resolveDataDir 在不传 userData 时会落到 "%APPDATA%\tsumigeya"（见 core-host.ts）。
  const dataDir = resolveDataDir({})
  const corePath = resolveCorePath({
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath
  })

  host = createCoreHost({
    dataDir,
    corePath,
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
