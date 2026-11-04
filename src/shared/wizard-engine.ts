// M5.0 S4（U6）：向导第 2 步的「改引擎」判定 -- 纯函数，零依赖。
//
// ===== 为什么这两条要抽出来测 =====
//
// ① **引擎下拉的选项来源**。可安装列表（`remoteModules`）由主进程 registry 产出，
//    但它是**懒加载**的（首次进引擎页才拉）。如果向导在它还没加载时就打开，
//    下拉会是**空的** —— 而这一轮修的就是「识别错了改不了引擎」，
//    下拉空了等于修了个假的入口（用户点开发现没得选，比没有入口更困惑）。
//
// ② **第 2 步能不能往下走**。删掉「跳过，稍后安装」之后，这里就是唯一的逃生门：
//       · 引擎已装 → 放行（正常路径）
//       · 装过但失败了（断网） → 也要放行，否则断网用户根本存不进游戏
//       · 压根没选引擎 → 不放行（他不知道要装什么，进去也是白搭）
//    判反了的后果很分叉：太严＝断网用户被卡死；太松＝用户带着一个跑不起来的配置存盘。
//
// 两处都是「改反了不报错、只是安静地表现成另一个行为」的那类逻辑，所以抽出来钉住。
//
// ⚠️ 零依赖：不 import vue / pinia / element-plus / api-client。
// 这样纯 Node 的 vitest 能直接跑，与 shared/library-filter.ts、shared/import-target.ts 同取向。

/** 下拉选项的一条。 */
export interface EngineOption {
  label: string
  value: string
}

/** 引擎来源的最小形状（`RemoteModule` 与 `ModuleInfo` 都有这几个字段）。 */
export interface EngineSource {
  id: string
  name?: string
  version?: string
}

/**
 * 拼出「改引擎」下拉的选项。
 *
 * 来源优先用**可安装列表**（= 主进程 registry 里的四个，权威且含未装的），
 * 它还没加载（空数组）时退回**已装列表** —— 至少别让下拉是空的。
 *
 * 为什么不用「两份合并」：registry 的四个是全集，已装的必然是它的子集。
 * 合并会制造重复项（同一个 nwjs 出现两次），而且顺序也会乱。
 * 只有在可安装列表**完全没加载**时才需要退路。
 *
 * 按 value 去重是防御性的：万一将来可安装列表与已装列表的 id 口径不一致
 * （比如 manifest 里的 folder 与模块目录名不同），重复项会让 el-select 行为诡异。
 */
export function engineOptionsFrom(
  remote: readonly EngineSource[],
  installed: readonly EngineSource[]
): EngineOption[] {
  const source = remote.length > 0 ? remote : installed
  const seen = new Set<string>()
  const options: EngineOption[] = []
  for (const item of source) {
    const value = typeof item.id === 'string' ? item.id.trim() : ''
    if (!value || seen.has(value)) continue
    seen.add(value)
    const label = (typeof item.name === 'string' ? item.name.trim() : '') || value
    options.push({ label, value })
  }
  return options
}

/** 向导第 2 步的输入。 */
export interface EngineStepState {
  /** 当前选中的引擎 id（空串 = 还没选）。 */
  engine: string
  /** 这个引擎是不是已经装好了。 */
  installed: boolean
  /**
   * 点过安装、但失败了（断网 / 服务器抽风）。
   *
   * 与「没装过」的区别是语义上的：没装过 = 用户根本还没试（不该放行，
   * 他要先知道有这回事）；装失败 = 他试过了、败了（放行，游戏先存下来，
   * 别让一次网络波动把整个添加流程废掉）。
   */
  installFailed: boolean
}

/**
 * 第 2 步能不能点「下一步」。
 *
 * ⚠️ 删掉「跳过，稍后安装」之后这一条就是唯一的逃生门（方案 §7.1 的容错路径）。
 */
export function canAdvanceEngineStep(state: EngineStepState): boolean {
  // ⚠️ 不能只写 `!state.engine`：空白字符串也算「选了引擎」，而它实际上是个无效 id，
  // 放行会存进一条 `gameEngine: '   '` 的记录 —— 启动时必然报「引擎不支持」。
  if (!String(state.engine ?? '').trim()) return false
  return state.installed || state.installFailed
}

/** 这一轮识别/手动改引擎之后，界面该标「自动识别」还是「已手动修改」。 */
export function engineSourceBadge(manual: boolean, engine: string): 'manual' | 'detected' | 'none' {
  if (!String(engine ?? '').trim()) return 'none'
  return manual ? 'manual' : 'detected'
}
