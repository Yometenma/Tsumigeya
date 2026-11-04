// M2.6 端到端验收探针的外壳。
// 用法：npm run build && node scripts/probe-m26.cjs
//
// 结构照 scripts/probe-m3.cjs（同一个坑：本机 `electron <目录>` 必 segfault，只能用文件入口）。
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
if (process.platform === 'win32') env.NO_SANDBOX = '1'

// 隔离数据目录；不要用 %TEMP%（受限会话整体 EPERM，见 AGENTS.md 已知坑）
if (!env.TSUMIGEYA_DATA_DIR) {
  env.TSUMIGEYA_DATA_DIR = path.join(__dirname, '..', '.dev-data-m26probe')
}
fs.rmSync(env.TSUMIGEYA_DATA_DIR, { recursive: true, force: true })
fs.mkdirSync(env.TSUMIGEYA_DATA_DIR, { recursive: true })
console.log(`[probe] 数据目录：${env.TSUMIGEYA_DATA_DIR}`)

const electron = require('electron')
const inner = path.join(__dirname, 'probe-m26-inner.cjs')
// 结果文件写项目目录内（stdout 会丢 + %TEMP% 可能 EPERM）
const report = path.join(__dirname, '..', '.dev-data-m26probe.json')
fs.rmSync(report, { force: true })

// 本机（受限桌面会话）不带 --no-sandbox 时 Electron 直接 exit 3 且零输出
const args = process.platform === 'win32' ? ['--no-sandbox', inner] : [inner]

const child = spawn(electron, args, { stdio: 'inherit', env })
child.on('exit', (code) => {
  console.log(`[probe] electron 退出码 ${code}`)
  if (fs.existsSync(report)) {
    console.log('[probe] === 结果 ===')
    try {
      console.log(fs.readFileSync(report, 'utf8'))
    } catch (error) {
      console.error('[probe] 读结果文件失败：', error)
    }
  } else {
    console.error('[probe] 没有结果文件——探针很可能没跑起来（看上面有没有 boot 痕迹）')
    process.exitCode = 1
  }
})
