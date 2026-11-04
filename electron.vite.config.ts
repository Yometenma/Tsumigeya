import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import pkg from './package.json'

// B1：版本号在**构建时**注入（`__APP_VERSION__`），不靠运行时 `npm_package_version`。
//
// 为什么必须在这里注入：preload 用 `process.env.npm_package_version` 取值，
// 而那个变量只有 `npm run` 起的进程里才有；打包成 .app 由 Finder 启动时不存在
// → 恒回落 '0.0.0'（左下角版本号永远显示 v0.0.0，用户实测的原 bug）。
// preload 同步暴露、拿不到 `app.getVersion()`，所以构建期替换是唯一零运行时开销的做法。
//
// 三个块都要（main 目前不用，但保持三处一致，免得将来 main 里用时被静默替换成 undefined）。
const define = { __APP_VERSION__: JSON.stringify(pkg.version) }

export default defineConfig({
  main: {
    // 主进程依赖全部外置（CJS 运行时 require），不打包
    plugins: [externalizeDepsPlugin()],
    define
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    define
  },
  renderer: {
    plugins: [vue()],
    define,
    resolve: {
      alias: {
        '@': resolve('src/renderer/src')
      }
    }
  }
})
