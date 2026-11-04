// M5.0 S3（U5）：只选文件之后，「这个文件属于哪个游戏目录」怎么定 -- 纯函数，零依赖。
//
// ===== 为什么这轮需要一层「反推」 =====
//
// 去掉「选择文件夹」后，用户只能选**文件**。四个引擎的游戏入口都是「目录里有哪些文件」，
// 所以选任何一个标志性文件都能反推目录 —— 但有两个例外（方案 §6 点名的）：
//
//   ① **用户选错文件**（`readme.txt`、`www/package.json` 之类）
//      文件本身认不出引擎，但它的**目录或上一层**就是游戏根。
//   ② **Ren'Py 的入口常在子目录**（`游戏名/game/script.rpy`）
//      直接取父目录得到 `游戏名/game`，而 `renpy/` 在 `游戏名/` 里 → 认不出来。
//
// 两例外都是同一个解法：**这一层认不出来就往上退一层再认**。
//
// 退几层必须有上限 —— 否则一路退到 `/Users` 甚至 `/`，可能撞上完全无关目录里的残骸文件，
// 认出一个「看起来对」的引擎，用户存进去才发现指错了游戏。上限 2 层的依据：
// Ren'Py 的 `game/xx.rpy` 只差 1 层；mac 的 `Xxx.app/Contents/MacOS/xxx` 差 2 层。
// 再深就不是「游戏目录」而是别的目录结构了。
//
// ⚠️ 零依赖：不 import vue / pinia / electron / fs / node:path。
// 这样纯 Node 的 vitest 能直接跑「退几层、退到哪、什么时候停」这套判据，
// 而渲染层（会被 vite 打包进浏览器）也不会因为 import node 内置模块而构建失败。
// 真正读盘识别仍然只有一处（主进程 detectFolder），**打分算法不许在这里重写**。

/** 往上最多退几层。 */
export const MAX_ASCEND = 2

/** 一次待识别的尝试：`level` 0 = 用户选的那个文件本身。 */
export interface ImportAttempt {
  /** 要交给 detectFolder 的路径（绝对路径）。 */
  path: string
  /** 0 = 选中的文件；1 = 它的目录；2 = 再上一层。 */
  level: number
}

/** 去掉尾部分隔符（`/x/y/` → `/x/y`）。根 `/` 与 `C:\` 这类保持原样。 */
export function stripTrailingSep(input: string): string {
  const trimmed = String(input ?? '').trim()
  if (!trimmed) return ''
  const stripped = trimmed.replace(/[\\/]+$/, '')
  // 全是分隔符（Unix 根）时保留一个，否则会变成空串
  if (!stripped) return trimmed.slice(0, 1)
  // `C:` 这种盘符根：剥完是 `C:`，保留（不补斜杠，交给调用方）
  return stripped
}

/**
 * 取父目录；已经到顶端就返回 null（用来终止上退）。
 *
 * 只做字符串处理，因此 **Windows 反斜杠与 POSIX 斜杠都认**：
 * 开发机是 Windows、目标平台是 mac，两条路径风格的单测都得过。
 */
export function parentOf(input: string): string | null {
  const value = stripTrailingSep(input)
  if (!value) return null
  const index = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  if (index < 0) return null
  const parent = value.slice(0, index).replace(/[\\/]+$/, '')
  // `/x` → parent 为 `''`：已经到 Unix 根，停
  if (!parent) return null
  // `C:\x` → parent 为 `C:`：盘符根，停
  if (/^[A-Za-z]:$/.test(parent)) return null
  return parent
}

/**
 * 按「先看选中的文件本身，再一层层往上退」的顺序列出所有尝试。
 *
 * 为什么 level 0 是**文件本身**而不是它的目录：选对了入口时（`Game.exe`、
 * `RPG_RT.ldb`、`Game.ini`），文件本身就能被 autodetect 认出来
 * （规则里的 `files` 是相对它的目录评估的），没必要先去扫整个目录。
 * 这样 `gamePath` 存下来的就是用户选的那个文件，与「选文件」的语义一致。
 */
export function buildImportAttempts(picked: string, maxAscend: number = MAX_ASCEND): ImportAttempt[] {
  const attempts: ImportAttempt[] = []
  let current: string | null = stripTrailingSep(picked)
  if (!current) return attempts
  attempts.push({ path: current, level: 0 })
  for (let level = 1; level <= maxAscend; level += 1) {
    const parent = parentOf(current)
    if (!parent) break
    attempts.push({ path: parent, level })
    current = parent
  }
  return attempts
}

/**
 * 某一层识别成功时，`gamePath` 该存什么。
 *
 * · level 0（选中的文件本身认出来了）→ 存**用户选的那个文件**（不擅自改写）
 * · level ≥ 1（退到目录才认出来）→ 存**该层识别出的那个候选**（通常是个 exe）
 *
 * 为什么不存「退到的那层目录」：`folder` 反正还是同一个目录（启动时由 gamePath 取父目录），
 * 但存 exe 更贴近「游戏入口」——详情页/诊断显示得更有意义，用户手改时也知道该改什么。
 * 该层没给候选时（理论不该发生）退回目录本身。
 */
export function importGamePath(picked: string, attempt: ImportAttempt, bestPath: string | null): string {
  const original = stripTrailingSep(picked)
  if (attempt.level === 0) return original
  return bestPath ?? attempt.path
}

/** 一次尝试的识别结果（由调用方跑 detectFolder 后填）。 */
export interface ImportDetection {
  level: number
  engine: string | null
  /** `detectFolder` 给的 `best.path`（用于 level ≥ 1 时决定存哪个文件）。 */
  bestPath: string | null
}

/** 收敛后的结论。 */
export interface ImportOutcome {
  /** 最终存进 `gamePath` 的值。 */
  gamePath: string
  /** 识别出的引擎 id（`null` = 一路退到底都没认出来）。 */
  engine: string | null
  /** 在第几层认出（`null` = 没认出）。 */
  level: number | null
  /**
   * 是否需要提示「你选的这个文件不像游戏入口，我改成看它的所在目录了」。
   *
   * 为什么这提示不能省：用户以为自己选对了文件，我们却悄悄换成了另一个路径存盘。
   * 不说一声的话，将来详情页显示的是 `Game.exe`、他记得自己点的是别的文件 ——
   * 这类「静默纠正」是最难排查的一类困惑。
   */
  ascended: boolean
}

/**
 * 把「逐层尝试的结果」收敛成一个结论。
 *
 * 输入是**跑到第一个成功就停**的结果序列（渲染层是懒循环）。
 * 一路全失败时传 `[]` 或空引擎数组，此时 gamePath 保持用户选的那个文件 ——
 * 与旧行为一致，让「识别失败」的老路照常能存下游戏。
 */
export function importOutcome(
  picked: string,
  attempts: readonly ImportAttempt[],
  detections: readonly ImportDetection[]
): ImportOutcome {
  const original = stripTrailingSep(picked)
  for (const detection of detections) {
    if (!detection.engine) continue
    const attempt = attempts.find((item) => item.level === detection.level)
    return {
      gamePath: attempt ? importGamePath(picked, attempt, detection.bestPath) : original,
      engine: detection.engine,
      level: detection.level,
      ascended: detection.level > 0
    }
  }
  return { gamePath: original, engine: null, level: null, ascended: false }
}
