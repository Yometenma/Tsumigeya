/// <reference types="vite/client" />

// 注意：本文件**不能有顶层 import/export**，否则它会变成模块，
// 下面的 `declare module '*.vue'` 就不再是全局声明，Vue SFC 的类型解析会全部失败。
// 因此 TsumiBridge 用内联 import() 引入。

interface Window {
  tsumi: import('./api/client').TsumiBridge
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default component
}
