/*
 * M5.0 S8（U10）：引擎页「全部安装」的执行编排 -- 纯函数，零依赖。
 *
 * ===== 为什么这一块要单独抽出来 =====
 *
 * 用户原话：「引擎管理这里已安装那边左上角可以有检查更新和全部更新……但是切换到
 * 可安装里面的时候感觉不一样了，那边应该是全部安装之类的吧？」
 *
 * 与「全部更新」**对称**，但两者的失败策略必须**不一样**，这一点方案 §10 明说了：
 *
 *     「注意：一次装多个引擎会下载几百 MB，必须逐个 + 进度」
 *
 * 现有 `updateAllEngines`（我照抄形状时发现的）是**第一个失败就 throw**，
 * 后面的引擎一个都不装。对「更新」来说那还算合理（版本不齐比装了半套更麻烦），
 * 但**对「安装」是错的**：
 *
 *   · 装引擎是**独立**的事 —— nwjs 装失败不影响 mkxpz 装成功，两者没有依赖关系；
 *   · 一次几百 MB、几个引擎，断在某一个上很常见（网络波动、某镜像挂掉）；
 *   · 用户点「全部安装」的意图是「把能装的装上」，不是「要么全装要么全不装」。
 *     后者会让一次偶发的网络抖动把整个操作废掉，而且**已经下好的那几个也留不下来**
 *     （throw 之后连 snapshot 都不返回）。
 *
 * 所以这里的编排是：**逐个装、失败不中断、最后汇总**。
 *
 * ⚠️ 零依赖：不 import vue / pinia / i18n / api-client。
 * 文案不进这里（规矩：文案一律进 locales），这里只返回结构。
 */

/** 一个待安装的引擎（只取这里用得到的字段）。 */
export interface InstallTarget {
  /** 引擎目录名（= id，registry 里那四个之一）。 */
  folder: string
  /** 展示名（进度与汇总文案要用）。 */
  name: string
}

/** 汇总结果。 */
export interface InstallAllResult {
  /** 装成功的（folder）。 */
  installed: string[]
  /** 失败的（folder + 原因）。 */
  failed: Array<{ folder: string; name: string; error: unknown }>
  /**
   * 用户中途取消。
   *
   * 与"全部失败"区分开：取消是**用户自己的决定**，不该弹红色错误；
   * 而已装好的那些仍然要保留（它们真的装上了）。
   */
  cancelled: boolean
}

/**
 * 算出「还需要装哪些」。
 *
 * `installed` 是**已装引擎的 folder 集合**。
 *
 * 为什么不用 `available`（可安装列表）自己的长度：那份列表来自 registry 的四个，
 * 但它只说明"我们支持这四个"，不说明"现在缺哪些"。用户在安装页与已安装页之间切换、
 * 或刚装完一个，「全部安装」应该只处理剩下的那些。
 *
 * 顺序**原样保留**（不排序）：registry 的顺序是刻意的（引擎页的固定顺序），
 * 重排会让"装到第几个"与卡片列表对不上。
 */
export function pendingInstalls(
  available: readonly InstallTarget[],
  installed: ReadonlySet<string>
): InstallTarget[] {
  return available.filter((item) => !installed.has(item.folder))
}

/**
 * 「全部安装」按钮上要不要显示数量、显示多少。
 *
 * 一行判据抽出来是因为它有两个易错点：
 *   · 已装齐时按钮要 **disabled**（而不是点了一下弹「都装好了」）
 *   · 数量要按**还没装的**算，不是按 available 总数
 */
export function installAllCount(
  available: readonly InstallTarget[],
  installed: ReadonlySet<string>
): number {
  return pendingInstalls(available, installed).length
}

/** 逐个执行时的回调（渲染层用它更新进度文案）。 */
export interface InstallAllHooks {
  /** 跑一个引擎的安装；抛错表示这个失败。 */
  install: (target: InstallTarget) => Promise<void>
  /** 每个引擎装完（成功或失败都调）时上报进度。 */
  onProgress?: (done: number, total: number, target: InstallTarget) => void
  /**
   * 要不要停下来（每次循环**之前**检查）。
   *
   * ⚠️ 这里是「引擎之间」的粒度，但**渲染层实际用的是"上一个 install 抛了取消"**
   * 这个信号（见 EnginesPage 的 `userCancelled`）—— 因为真正的取消能力在
   * ProgressOverlay 那条链上（`task.cancel()` → 主进程 AbortController），
   * 它能在**当前这个下载中**就打断。被打断的那个会抛 error.cancelled，
   * install 回调识别后置位，下一次循环前就在这里停下。
   *
   * 用回调而不是 AbortSignal：渲染层这里没有可复用的 signal，
   * 而判断"要不要继续"本来就该发生在引擎之间。
   */
  isCancelled?: () => boolean
}

/**
 * 执行「全部安装」。
 *
 * 关键行为（每条都有单测）：
 *   ① **失败不中断**：一个装失败，继续装下一个
 *   ② **逐个上报进度**（`onProgress` 在成功/失败后都调）
 *   ③ 取消是**引擎之间**的检查：当前那个装完才停下
 *   ④ 已装成功的那些**一定留在结果里**（哪怕后面全失败）
 */
export async function runInstallAll(
  targets: readonly InstallTarget[],
  hooks: InstallAllHooks
): Promise<InstallAllResult> {
  const installed: string[] = []
  const failed: InstallAllResult['failed'] = []
  let cancelled = false
  const total = targets.length
  for (let index = 0; index < total; index += 1) {
    if (hooks.isCancelled?.()) {
      cancelled = true
      break
    }
    const target = targets[index]!
    try {
      await hooks.install(target)
      installed.push(target.folder)
    } catch (error) {
      // ⚠️ 这里**必须**吞掉错误继续循环。这正是与 updateAllEngines 的区别：
      // 装引擎相互独立，一个失败不该把其余的一起废掉。
      failed.push({ folder: target.folder, name: target.name, error })
    }
    hooks.onProgress?.(index + 1, total, target)
  }
  return { installed, failed, cancelled }
}

/**
 * 汇总文案的判定（渲染层据此选 success / warning / info）。
 *
 * 抽出来是因为三种结果的措辞很容易写混：
 *   · 全成功 → success
 *   · 有失败 → warning（不是 error：**有一部分真的装上了**，报 error 会让用户
 *     以为全废了，然后去重装一遍已装好的）
 *   · 用户取消 → info（那是他自己的决定，不该红）
 */
export type InstallAllOutcome = 'all-success' | 'partial' | 'all-failed' | 'cancelled'

export function installAllOutcome(result: InstallAllResult): InstallAllOutcome {
  if (result.cancelled) return 'cancelled'
  if (result.failed.length === 0) return 'all-success'
  if (result.installed.length === 0) return 'all-failed'
  return 'partial'
}
