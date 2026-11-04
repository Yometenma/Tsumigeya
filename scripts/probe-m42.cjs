// M4.2 S6 端到端验收探针的外壳（照 probe-m41.cjs 结构：本机只能走文件入口）。
//
// 用法：npm run build && node scripts/probe-m42.cjs
//
// ⚠️ 两个本机坑（AGENTS.md 里都有，这里再写一遍免得下个会话踩）：
//   ① 必须走**文件入口**（scripts/probe-m42-inner.cjs），用「目录」入口启动 Electron 必 segfault
//   ② 结果文件必须写**项目目录内**：Vite 打包后 out/main 的 stdout 在 Windows 会丢，
//      而 %TEMP% 在受限会话里可能整体 EPERM
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS
if (process.platform === 'win32') env.NO_SANDBOX = '1'

// 隔离数据目录（每次跑前清空：探针要验「从来没装过 → 装 → 更新」，残留会污染结论）
const dataDir = path.join(__dirname, '..', '.dev-data-m42probe')
fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(dataDir, { recursive: true })
env.TSUMIGEYA_DATA_DIR = dataDir
console.log(`[probe] 数据目录：${dataDir}`)

const electron = require('electron')
const inner = path.join(__dirname, 'probe-m42-inner.cjs')
const stub = path.join(__dirname, 'probe-m42-stub.cjs')
const report = path.join(__dirname, '..', '.dev-data-m42probe.json')
fs.rmSync(report, { force: true })

// 假网络（见 probe-m42-stub.cjs 开头的长注释）：把 electron.net.fetch 换成白名单假实现。
// 必须用 `--require` 预载，而不是在 inner 里 require —— 桩要在 index.js 创建 host 之前生效。
env.TSUMIGEYA_PROBE_FAKE_NET = '1'

const args =
  process.platform === 'win32'
    ? ['--no-sandbox', '--require', stub, inner]
    : ['--require', stub, inner]

console.log('[probe] 启动 Electron（文件入口 + 假网络桩）…')
const child = spawn(electron, args, { stdio: 'inherit', env })
child.on('exit', (code) => {
  console.log(`[probe] electron 退出码 ${code}`)
  if (!fs.existsSync(report)) {
    console.error('[probe] 没有结果文件——探针很可能没跑起来（看上面有没有 boot 痕迹）')
    process.exitCode = 1
    return
  }
  const raw = fs.readFileSync(report, 'utf8')
  console.log('[probe] === 结果 ===')
  console.log(raw)

  // 退出码也反映结论：本机不能只靠人眼看 JSON
  let parsed = null
  try {
    parsed = JSON.parse(raw)
  } catch {
    /* 下面按失败处理 */
  }
  const failures = Array.isArray(parsed?.failures) ? parsed.failures : ['结果文件不是合法 JSON']
  if (failures.length > 0) {
    console.error('[probe] ❌ 失败项：')
    for (const item of failures) console.error(`   · ${item}`)
    process.exitCode = 1
  } else {
    console.log('[probe] ✅ 全部判据通过')
  }
})
