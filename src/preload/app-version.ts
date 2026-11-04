// 应用版本号的唯一来源（B1）。
//
// ===== 为什么是构建期注入，而不是运行时读取 =====
//
// v0.5.3 之前这里是 `process.env.npm_package_version ?? '0.0.0'`。
// 那个环境变量**只在 `npm run` 起的进程里存在**（npm 会把它塞进子进程 env），
// 打包成 .app 后由 Finder 启动时**根本不存在** → 恒回落 '0.0.0'
// → App.vue 左下角永远显示 `v0.0.0 darwin`（用户实测的原症状）。
//
// 另外两条路都不行：
//   · 主进程 `app.getVersion()` 最权威（打包后读的是 Info.plist / package.json），
//     但 **preload 拿不到主进程 API**；而 contextBridge 是同步暴露的
//     （窗口创建时一次性执行完），等不到一个异步 IPC 的结果。
//   · 主进程把版本塞进 `additionalArguments` 再让 preload 读 argv：
//     能跑通，但要改 BrowserWindow 的创建参数，还得解析 argv 字符串，比一行 define 复杂。
//
// 所以：`electron.vite.config.ts` 的 `define` 把 __APP_VERSION__ 在**构建时**替换成
// package.json 里 version 的字面量。零运行时开销、不依赖任何环境变量、打包后必对。
//
// ⚠️ 本文件**不能有** `// @ts-ignore` 之类的兜底：`__APP_VERSION__` 没有值就应该是构建失败，
// 而不是悄悄变成 undefined（那会退化成「显示 vundefined」这种更难查的形态）。
// 声明由 electron-vite 的 define 提供；如果哪天同步坏了，test/app-version.test.ts 会红。
declare const __APP_VERSION__: string

export const APP_VERSION: string = __APP_VERSION__
