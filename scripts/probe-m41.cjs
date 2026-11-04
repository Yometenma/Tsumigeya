// M4.1 S4 端到端验收探针的外壳（照 probe-m40.cjs 结构：本机只能走文件入口）。
//
// 用法：npm run build && node scripts/probe-m41.cjs
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
if (process.platform === 'win32') env.NO_SANDBOX = '1'

// 隔离数据目录；不用 %TEMP%（受限会话整体 EPERM，见 AGENTS.md 已知坑）
if (!env.TSUMIGEYA_DATA_DIR) {
  env.TSUMIGEYA_DATA_DIR = path.join(__dirname, '..', '.dev-data-m41probe')
}
fs.rmSync(env.TSUMIGEYA_DATA_DIR, { recursive: true, force: true })
fs.mkdirSync(env.TSUMIGEYA_DATA_DIR, { recursive: true })
console.log(`[probe] 数据目录：${env.TSUMIGEYA_DATA_DIR}`)

const electron = require('electron')
const inner = path.join(__dirname, 'probe-m41-inner.cjs')
// 结果文件写项目目录内（stdout 会丢 + %TEMP% 可能 EPERM）
const report = path.join(__dirname, '..', '.dev-data-m41probe.json')
fs.rmSync(report, { force: true })

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
