// 端到端验收探针的外壳（M2）。
// 为什么要拆两段：本机 `electron <目录>` 必 segfault，必须用**文件入口**启动
// （同 AGENTS.md 已知坑第一条 / scripts/dev.cjs 的处理）；而探针逻辑本身要在 Electron 里跑。
//
// 用法：npm run build && node scripts/probe-m2.cjs
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
if (process.platform === 'win32') env.NO_SANDBOX = '1'

// 隔离数据目录：别污染真实游戏库。
// ⚠️ 不要用 %TEMP%：受限 Windows 会话下它整体 EPERM（AGENTS.md 已知坑），
// 游戏库写不进去，编辑页就落到「游戏不存在」空状态，探针等于白跑。
if (!env.TSUMIGEYA_DATA_DIR) {
  env.TSUMIGEYA_DATA_DIR = path.join(__dirname, '..', '.dev-data-m2probe')
}
// 每次跑都清空，保证可重复
fs.rmSync(env.TSUMIGEYA_DATA_DIR, { recursive: true, force: true })
fs.mkdirSync(env.TSUMIGEYA_DATA_DIR, { recursive: true })
console.log(`[probe] 数据目录：${env.TSUMIGEYA_DATA_DIR}`)

const electron = require('electron')
const inner = path.join(__dirname, 'probe-m2-inner.cjs')
// 结果文件写在项目目录（%TEMP% 在受限会话里可能整体 EPERM，见 AGENTS.md 已知坑）
const report = path.join(__dirname, '..', '.dev-data-m2probe.json')

// 实测：本机（受限桌面会话）不带 --no-sandbox 时 Electron 直接 exit 3、什么输出都没有。
// 这不是应用的问题（应用自己设置了 sandbox: true），是**跑验收进程的环境**要求。
const args = process.platform === 'win32' ? ['--no-sandbox', inner] : [inner]

const child = spawn(electron, args, { stdio: 'inherit', env })
child.on('exit', (code) => {
  console.log(`[probe] electron 退出码 ${code}`)
  if (fs.existsSync(report)) {
    console.log('[probe] === 结果 ===')
    console.log(fs.readFileSync(report, 'utf8'))
    process.exit(code === 0 ? 0 : code)
  }
  console.error('[probe] 没生成结果文件——探针没跑起来（检查是否漏了 --no-sandbox）')
  process.exit(code ?? 1)
})
