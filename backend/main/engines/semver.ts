// M4.2 S1：版本号比较（D63，「检查引擎更新」不再有远端清单后的自实现部分）。
//
// ===== 这个文件替代了什么 =====
//
// `resources/core/module.js` 里的 `compareVersions` / `hasUpdate` 是两个 20 行的实现，
// 被 `checkEngineUpdates` 用来判断「本地版本 vs 期望版本」。删 module.js（D63）后
// 这两个 API 的判决是「自实现」（方案 §1.1 的表格），所以搬到这里。
//
// 为什么单独一个文件而不是塞进 registry：它是**纯函数、零依赖**，单独放才能被
// 单测直接钉死（方案 §5 S1 的验收标准就是「纯函数，最容易先钉死」）。
//
// ===== 与上游实现的关系（有意保留的三条语义）=====
//
// 上游的 `compareVersions` 做三件事，这三件事**必须保留**，否则行为会变：
//
//   1. **剥前导 v**：`v0.106.1` 与 `0.106.1` 相等。
//      依据：nwjs 的依赖名就叫 `version/v0.106.1`，而 manifest 的 version 字段是
//      `1.4.4` 这种不带 v 的写法。两边混着比是常态。
//
//   2. **位数不等时补 0**：`1.2` == `1.2.0`，`1.2` < `1.2.1`。
//      依据：上游 manifest 里出现过 `8.5` 与 `8.5.2` 两种写法。
//
//   3. **数字段排在字符串段之上**（不是「忽略非数字段」）。
//      它就是「1.0.0 > 1.0.0-beta.1」这条规则成立的原因：pre 段被解析成字符串段，
//      而数字段永远更大 → 正式版压过预发布版。这条**正是 semver 的排序**，
//      所以下面按 semver 写反而更清楚，且与上游在这些真实数据上结果相同。
//
// ===== 与上游**有意**不同的两处 =====
//
//   ① 预发布段的比较**显式实现**，不再靠「字符串恰好以 `0-` 开头」这种巧合。
//      上游把 `1.0.0-beta.1` 拆成 `["1","0","0-beta","1"]`（按 `.` 拆，`-` 留在段里），
//      于是 `0-beta` 是字符串段 —— 能工作，但纯属运气。上一段说的三条语义一样，
//      但读代码的人看不出「这是在比预发布」。
//
//   ② 预发布段的标识符按 semver 规则比（数字型比数值、数字型 < 字符串型、
//      前缀相同时段数少的更小）。上游遇到 `1.0.0-beta.1.2` vs `1.0.0-beta.1`
//      会判后者更小（缺段补 0），semver 判前者更大 —— 现实里不会出现这种版本号，
//      但既然要自己写，就写对的那个。
//
// ===== 边界：不做什么 =====
//
//   · **不比较 build metadata**（`1.0.0+build.5` 的 `+` 之后一律忽略）。
//     依据：semver 规定 build metadata 不参与排序；上游也没处理，忽略不会变坏。
//   · **不做版本号合法性校验**。传进来 `"garbage"` 不会抛错，会被当成
//     「一个没有数字段的版本」比大小。理由：本地 manifest 的 version 可能是
//     用户从旧版升级上来的任意字符串，比大小是**尽力而为**，抛错会让整个更新检查
//     因为「某个旧引擎的 version 字段脏了」而失败 —— 那比「比错」更糟。
//     （「本地版本疑似脏值」的提示由调用方按 `N/A` 兜底，见 `hasUpdate`。）

/** 拆开后的版本号：核心段 + 预发布段（`undefined` 表示这是正式版）。 */
interface ParsedVersion {
  core: Array<number | string>
  pre?: Array<number | string>
}

/** 剥前导 v / 大写 V，并 trim（上游 `normalizeVer` 的等价物）。 */
export function normalizeVersion(value: string | undefined | null): string {
  return String(value ?? '')
    .trim()
    .replace(/^[vV]/, '')
    .trim()
}

/**
 * 把一个标识符段转成「数字或字符串」。
 *
 * 纯数字（且不是空串）→ 数字；其余原样保留成字符串。
 * ⚠️ `Number('')` 是 0，`Number('01')` 是 1 —— 前者要先挡掉空串，后者是有意的
 * （`1.01` 与 `1.1` 相等，与上游 `isNaN(Number(y)) ? y : Number(y)` 一致）。
 */
function identifierOf(raw: string): number | string {
  if (raw === '') return 0
  if (/^\d+$/.test(raw)) return Number(raw)
  return raw
}

/** 按 `.` 拆成标识符数组；空串按 0 处理（`1..2` 这种脏值不炸）。 */
function splitIdentifiers(part: string): Array<number | string> {
  return part.split('.').map(identifierOf)
}

/**
 * 解析版本号：`[v]core[-pre][+build]`。
 *
 * `+build` 直接截掉（semver 规定不参与排序）。
 * 没有 `-` 时 `pre` 为 undefined —— 这个区别是「正式版 vs 预发布版」的唯一信号。
 */
export function parseVersion(value: string | undefined | null): ParsedVersion {
  const normalized = normalizeVersion(value)
  const plus = normalized.indexOf('+')
  const withoutBuild = plus >= 0 ? normalized.slice(0, plus) : normalized
  const dash = withoutBuild.indexOf('-')
  if (dash < 0) return { core: splitIdentifiers(withoutBuild) }
  return {
    core: splitIdentifiers(withoutBuild.slice(0, dash)),
    pre: splitIdentifiers(withoutBuild.slice(dash + 1))
  }
}

/**
 * 比较两个标识符（数字 / 字符串混合）。
 *
 * 规则（三条，缺一不可）：
 *   · 两个都是数字 → 比数值
 *   · 两个都是字符串 → 按码位比（`beta` < `rc`，与 semver 的 ASCII 排序一致）
 *   · 混合 → **数字更大**（这就是「正式版 > 预发布版」的实现方式）
 */
function compareIdentifier(a: number | string, b: number | string): number {
  const aNumber = typeof a === 'number'
  const bNumber = typeof b === 'number'
  if (aNumber && bNumber) return a === b ? 0 : a > b ? 1 : -1
  if (!aNumber && !bNumber) return a === b ? 0 : a > b ? 1 : -1
  return aNumber ? 1 : -1
}

/**
 * 比较版本号：`a > b` 返回 1，`a < b` 返回 -1，相等返回 0。
 *
 * 三级比较，前一级相等才看下一级：
 *   ① 核心段（缺段补 0，所以 `1.2` == `1.2.0`）
 *   ② 预发布段：**没有预发布段的那一方更大**（`1.0.0` > `1.0.0-beta.1`）
 *   ③ 预发布标识符逐个比；全部相同则段数少的更小
 */
export function compareVersions(a?: string | null, b?: string | null): number {
  const left = parseVersion(a)
  const right = parseVersion(b)

  const length = Math.max(left.core.length, right.core.length)
  for (let index = 0; index < length; index += 1) {
    // 缺段补 0：这是「位数不等」那条语义的落点
    const compared = compareIdentifier(left.core[index] ?? 0, right.core[index] ?? 0)
    if (compared !== 0) return compared
  }

  // 核心段相等 → 正式版（无 pre）大于预发布版
  if (!left.pre && !right.pre) return 0
  if (!left.pre) return 1
  if (!right.pre) return -1

  const preLength = Math.max(left.pre.length, right.pre.length)
  for (let index = 0; index < preLength; index += 1) {
    const leftPart = left.pre[index]
    const rightPart = right.pre[index]
    // 段数不同：前缀全部相等时，**段数少的更小**（semver §11.4.4）
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const compared = compareIdentifier(leftPart, rightPart)
    if (compared !== 0) return compared
  }
  return 0
}

/**
 * 「有更新吗」——`remote` 是否比 `local` 新。
 *
 * ⚠️ 两个 `N/A` 兜底**必须保留**（上游 `hasUpdate` 的前两行）：
 *   · 本地没装 / 没版本 → 谈不上「有更新」
 *   · 期望版本未知 → 不能报「有更新」（否则引擎页会挂一个永远消不掉的红点）
 *
 * 传 `undefined` / 空串 / `'N/A'` 都返回 false，而不是把空串当 0 去比 ——
 * 后者会让「本地版本丢了」被误判成「有更新」。
 */
export function hasUpdate(localVersion?: string | null, remoteVersion?: string | null): boolean {
  const local = normalizeVersion(localVersion)
  const remote = normalizeVersion(remoteVersion)
  if (!local || local === 'N/A') return false
  if (!remote || remote === 'N/A') return false
  return compareVersions(remote, local) > 0
}
