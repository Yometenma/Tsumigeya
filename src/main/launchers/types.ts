// 启动方案的公共类型（M4.0 §3.2）。
//
// **不 import electron**、不 import 任何引擎实现：这个文件只放形状，
// 四个引擎实现与 index.ts 都依赖它，单测也直接 import 它。
import type { EngineId } from './binary-paths'

/** 一次启动的上下文（由 ipc.ts 的 launch() 组装）。 */
export interface LaunchContext {
  /** 游戏根目录（已解析成绝对路径；gamePath 是文件时取它的父目录）。 */
  folder: string
  /** 用户的原始 gamePath（可能是文件夹里的某个 exe）。 */
  gamePath: string
  /** 引擎参数（**已经过 reconcileVersionArgs 修正**的版本值）。 */
  gameArgs: Record<string, unknown>
  /** 游戏标题（renpy 拿它当存档目录名）。 */
  gameTitle: string
  /** 数据目录（引擎模块所在处，= `<数据目录>/modules/<引擎>` 的上一层）。 */
  dataDir: string
  /** 平台（生产是 process.platform；单测可传任意值）。 */
  platform: NodeJS.Platform
  /** 架构（生产用 **os.arch()**，见 binary-paths.ts 的注释；单测覆盖 arm64/x64）。 */
  arch: string
}

/** 一个引擎的「怎么启动」描述（纯数据 + 一个可选的前置动作）。 */
export interface LaunchPlan {
  /** 要执行的二进制绝对路径。 */
  binary: string
  /**
   * 参数**数组**（D54）。
   *
   * 为什么不是字符串：`spawn(binary, args)` 天然处理空格 / 中文 / 引号，
   * 不用自己写 `quote()` —— 上游四个 launcher 各自写了一份 quote，那正是在补这个坑。
   */
  args: string[]
  /** 工作目录（默认取游戏目录）。 */
  cwd?: string
  /** 哪个引擎（诊断与日志用）。 */
  engine: EngineId | string
  /**
   * 启动**前**要做的事（比如 mkxpz 要写 `mkxp.json`）。
   * 返回 Promise 也行；**抛错 = 前置失败，游戏不会被拉起**。
   */
  prepare?: () => void | Promise<void>
}

/** 一个引擎实现的形状（四个引擎都导出这个签名）。 */
export type EnginePlanner = (ctx: LaunchContext) => LaunchPlan
