#!/usr/bin/env node
// 启动开发模式。存在的理由：本机（Windows）用目录入口启动 Electron 会 segfault，
// 必须用文件入口 + EXPLICIT 的 ELECTRON_ENTRY。详见 AGENTS.md「已知坑」。
//
// 用法：npm run dev            （正常）
//       npm run dev -- --headless-check   （无窗口，仅验证主进程能起来）

const { spawn } = require('node:child_process')
const path = require('node:path')

const env = { ...process.env }

// 关键：清掉会把 electron.exe 变成纯 Node 的环境变量。
// DSH / 某些 shell 会注入 ELECTRON_RUN_AS_NODE=1，electron 会以 Node 模式跑，主进程立刻报 protocol undefined。
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_OPTIONS

// 本机实测：`electron <目录>` 必然 segfault（0xc0000005），`electron <文件>` 正常。
// electron-vite 默认 ELECTRON_ENTRY='.'，这里强制改成文件入口。
env.ELECTRON_ENTRY = path.join('out', 'main', 'index.js')

// 无沙箱：本机没有真实桌面会话，沙箱起不来。
if (process.platform === 'win32') env.NO_SANDBOX = '1'

const args = ['electron-vite', 'dev']
const passthrough = process.argv.slice(2)
if (passthrough.length) args.push('--', ...passthrough)

const child = spawn(process.execPath, [path.join('node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'dev', ...passthrough], {
  stdio: 'inherit',
  env
})

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[dev] electron-vite 被信号终止：${signal}`)
    console.error('[dev] 若看到 segfault/0xc0000005，确认 ELECTRON_ENTRY 指向文件而不是目录（见 AGENTS.md 已知坑）')
    process.exit(1)
  }
  process.exit(code ?? 0)
})
