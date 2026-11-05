// M6.5：引擎页卡片的两条判据 —— 纯函数，零依赖。
//
// ===== 为什么这两条值得抽出来测 =====
//
// 它们都属于「**不接就静默出错**」那一类：
//
//   ① `hasDependencies`：TyranoScript 的 `dependencies` 是**空对象**（有意为之，
//      它复用 NW.js 的运行时）。而引擎页原来**无条件**显示「安装」按钮 ——
//      用户点它，主进程发现没有依赖可装 → 要么报错、要么"装完了什么都没发生"。
//      两者都是 D60 说的「不起作用的开关」：**比不显示更糟**。
//
//   ② `isExperimental`：吉里吉里能用，但上游明写不支援商用游戏。标签漏了不报错，
//      只是用户永远不知道这条限制（D90 要求如实转达）。
//
// 判据写错的表现全是「页面照常渲染、点了照常没反应」，所以必须有单测钉住。
//
// ===== ⚠️ 为什么这里**不 import** `main/engines/registry` =====
//
// 本鱼第一版直接 import 了它，`typecheck` 当场报错：
//
//     error TS6307: File 'src/main/engines/registry.ts' is not listed within
//     the file list of project 'tsconfig.web.json'
//
// 原因：`src/shared/` 会被**渲染层（web）**打包，而 `main/` 属于 **node** 工程。
// 这是这条边界存在的意义 —— 整个 `src/shared/` 里**从来没有**一个文件 import `main/`
// （本鱼查过），本鱼不能第一个破例。
//
// 所以改成**依赖注入**：判据收一个 `engines` 数组参数，调用方从 store 拿（store 本来
// 就有 `available` 列表）。判据本身零依赖，纯 Node 的 vitest 能直接跑。
//
// ⚠️ 但这样一来，「registry 与列表是否一致」就没人管了 →
//    `test/engine-card.test.ts` 里有一条**源码级 + registry 级**的核对补上这个缺口。

/** 判据需要的最小形状（`EngineDefinition` 与 store 里的 `RemoteModule` 都满足它）。 */
export interface EngineCardSource {
  /** 引擎目录名。 */
  folder: string
  /** 依赖表（空对象 = 无需下载）。 */
  dependencies: Record<string, unknown>
  /** 是否实验性（缺省 = 否）。 */
  experimental?: true
}

/**
 * 把 store 里的 `RemoteModule`（`{ folder, raw: { dependencies } }`）转成判据输入。
 *
 * 为什么要这一层：渲染层拿到的是 **manifest 的 `raw`**，不是 registry 的
 * `EngineDefinition`（那边在主进程，渲染层不能 import，见文件头的 TS6307 注释）。
 * 而 manifest 里**上游老写法有 `deps` 与 `dependencies` 两处**（见 install.ts 的注释）
 * —— 判据必须两处都认，否则某些引擎的依赖会被当成空。
 */
export interface RemoteModuleLike {
  folder: string
  raw?: { dependencies?: Record<string, unknown>; deps?: Record<string, unknown> }
}

export function toCardSource(module: RemoteModuleLike): EngineCardSource {
  const deps = module.raw?.dependencies ?? module.raw?.deps ?? {}
  return { folder: module.folder, dependencies: deps }
}

/** 一批 `RemoteModule` → 判据输入。 */
export function toCardSources(modules: readonly RemoteModuleLike[]): EngineCardSource[] {
  return modules.map(toCardSource)
}

/**
 * 这个引擎有没有需要下载的依赖。
 *
 * 判据是 `dependencies` 里**至少有一个键**。空对象 = 不需要下载。
 *
 * ⚠️ 不要改成「看 dependencies 是不是 undefined」：我们的定义里永远是对象，
 * 空对象才是「无需下载」的表示（见 registry 里 tyrano 的注释）。
 *
 * 找不到这个引擎时返回 `true`（保守：显示按钮）。
 * 为什么保守：万一列表与 registry 不同步，**多显示一个按钮**比
 * 「明明该能装却显示无需下载」更安全 —— 前者点错了至少能看到错误，
 * 后者会让用户以为没有可装的东西而放弃。
 */
export function hasDependencies(folder: string, engines: readonly EngineCardSource[]): boolean {
  const engine = engines.find((item) => item.folder === folder)
  if (!engine) return true
  return Object.keys(engine.dependencies ?? {}).length > 0
}

/**
 * 这个引擎是不是「实验性」。
 *
 * 来源是 registry 的 `experimental: true`（目前只有吉里吉里）。
 * 找不到引擎时返回 `false`（不显示标签，不误伤）。
 */
export function isExperimental(folder: string, engines: readonly EngineCardSource[]): boolean {
  const engine = engines.find((item) => item.folder === folder)
  return engine?.experimental === true
}

/**
 * 一次「全部安装」里，真正需要下载的引擎（空依赖的排除）。
 *
 * ⚠️ 用它的两处（卡片的按钮显隐、全部安装的计数与执行）必须**同时**用它，
 * 否则会出现「数字说 3 个、实际只装 2 个」——
 * **数字撒谎比按钮坏掉更难查**。
 *
 * 泛型只要求 `{ folder }`（调用方传的是 `RemoteModule`，它没有顶层 `dependencies`；
 * 依赖信息由 `engines` 参数提供）。
 */
export function installableTargets<T extends { folder: string }>(
  available: readonly T[],
  engines: readonly EngineCardSource[]
): T[] {
  return available.filter((item) => hasDependencies(item.folder, engines))
}
