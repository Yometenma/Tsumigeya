// M4.1 S1：引擎定义的形状（D60 / D61 / D62）。
//
// 本文件**只放形状与常量**：不 import electron、不 import core-host、不 import 任何引擎实现。
// registry.ts 与单测都依赖它，所以它必须是叶子。
//
// 为什么不用 core-host 的 `ManifestRaw` / `GameArgDef`：那两个类型描述的是「从磁盘读到的
// manifest 长什么样」，而这里描述的是「我们**要生成**的 manifest 长什么样」。
// 数据方向相反（一个是读、一个是写），共用类型会让「生成时漏字段」变成静默通过。
// 两边形状相同是**结果**，不是靠同一个类型保证的 —— 由 test/engines-registry.test.ts 断言。

/** 默认值里代表「数据目录」的占位符（D62 修正方案 §1.2 / §2.4 的硬编码路径）。 */
export const DATA_DIR_PLACEHOLDER = '<dataDir>'

/**
 * 参数类型。
 *
 * 与渲染层 `DynamicArgsForm.vue` 认的类型集合一致：
 *   · `string` —— 单行文本（**上游 manifest 用的就是这个名字**，不是 `text`）
 *   · `text`   —— 同一个控件的历史别名（core-host 的 GameArgDef 用这个名字）
 * 两者渲染完全相同（见 DynamicArgsForm 的注释）；这里明确列出 `string`，
 * 因为上游 nwjs/mkxpz/easyrpg/renpy 的 string 参数全都写 `"type": "string"`。
 */
export type EngineArgType =
  | 'boolean'
  | 'string'
  | 'int'
  | 'float'
  | 'dropdown'
  | 'select'
  | 'multi-version'
  | 'array'

/** 下拉项（与上游 `options` 形状一致）。 */
export interface EngineArgOption {
  label: string
  value: string
}

/**
 * 一个参数的 schema（生成的 manifest 里原样写进 `gameArgs[<key>]`）。
 *
 * 字段名与上游 manifest **完全一致**（D62 的兼容要求）：
 * `type` / `label` / `default` / `options` / `version-script`。
 * 只有 `labelKey` 是我们自己加的（上游读到会忽略），用于中文界面。
 */
export interface EngineArgSpec {
  type: EngineArgType
  /**
   * 上游的英文标签。**必须保留**：原版 Xenolauncher 读的就是这个字段，
   * 而且排障时对着上游 manifest 比对要能对上名字。
   */
  label: string
  /** 中文标签的 i18n key（渲染层优先用它，见 DynamicArgsForm.vue）。 */
  labelKey: string
  default: unknown
  options?: EngineArgOption[]
  /** `multi-version` 专用：算「可下载版本列表」的脚本名（我们自己实现，见 S3）。 */
  'version-script'?: string
}

/** 一个架构的下载描述（与上游 manifest 的每个 arch 条目同形）。 */
export interface EngineBuild {
  link: string
  /** 下载后是否解压（`.zip` 要，`.sf2` / `.js` 不要）。 */
  unzip?: boolean
}

/**
 * 一个依赖：按架构分（不区分架构的用 `universal`）。
 *
 * ⚠️ 结构**照抄上游 manifest**：`{ universal?: {...}, arm64?: {...}, x86_64?: {...} }`。
 * 方案 §2.2 把 `unzip` 写在依赖顶层，但真实 manifest 里 `unzip` 在**每个 arch 条目里**
 * （同一个依赖的两个架构可能一个要解压一个不要），顶层写会丢掉这层信息。
 */
export interface EngineDependency {
  universal?: EngineBuild
  arm64?: EngineBuild
  x86_64?: EngineBuild
  /**
   * 下载失败是否容忍。**位置在依赖这一层**（不是每个 arch 条目里）。
   *
   * 实测依据（`resources/core/module.js` 的补丁 #3 判断的是 `builds.optional === true`，
   * 而 `builds` 就是这一层的对象）：
   * easyrpg 的 soundfont 指向 musical-artifacts.com，该站点有 Cloudflare 人机验证，
   * 程序化请求恒 403 → 不加这个标记就「EasyRPG 永远装不上」。
   * 音源不是运行必需品（缺了只是部分音乐退化），所以可容忍。
   */
  optional?: boolean
  /**
   * 解压后**保留**那一层唯一的顶层目录（不拍平）。
   *
   * 为什么需要显式声明，而不是靠「猜目录名」：
   *
   * 两种依赖的形态**看起来一样、要求相反**：
   *   · `RTP.zip` 解压出 `RTP/RPGVXace/…`，而 depDir 已经叫 `deps/RTP`
   *     → 必须**保留**那层 `RTP/`，最终 `deps/RTP/RTP/RPGVXace`（诊断查的就是这个）
   *   · `nwjs-sdk-…zip` 解压出 `nwjs-sdk-v0.106.1-osx-arm64/nwjs.app/…`，depDir 是
   *     `deps/version/v0.106.1`
   *     → 也必须**保留**那层（`binary-paths` 拼的是 `.../v0.106.1/nwjs-sdk-…/nwjs.app/…`）
   *
   * M4.2 之前用「顶层目录名 ≠ 依赖名就拍平」的启发式，结果把 nwjs 那层也拍掉了 →
   * 二进制路径对不上 → **NW.js 游戏启动失败**（mac 上实测到，Windows 测不出）。
   * 「依赖名 ≠ 目录名」根本不能推出「这是个无关包裹层」。
   *
   * 所以改成显式标记：**true = 保留单层，false/缺省 = 拍平单层**。
   */
  keepSingleDir?: boolean
}

/**
 * 自动识别规则（与上游 manifest 的 `autodetect` 同形）。
 *
 * 语义（照抄 `module.js` 的 `detectEngineForPath`，**不要自己发明**）：
 *   · `all_required: true` → `extensions`（若有）必须命中 **且** `files` 全都在场
 *   · `all_required: false` → 按「扩展名命中 +1、文件命中比例」打分取最高
 */
export interface EngineAutodetect {
  extensions?: string[]
  files?: string[]
  all_required?: boolean
}

/** 一个引擎的完整定义。**唯一来源**（D60）。 */
export interface EngineDefinition {
  /** 模块目录名，也是 `gameEngine` 字段的值（`games.json` 里的字符串）。 */
  folder: string
  /** 展示名。 */
  name: string
  /** 硬编码的上游版本号（上游发新版时手动改这里，见 R2）。 */
  version: string
  /** 一句话说明（引擎页展示）。 */
  description: string
  /** 说明的 i18n key。 */
  descriptionKey: string
  /** 怎么认这个游戏。 */
  autodetect: EngineAutodetect
  /** 参数表单（**只保留用户真会用的**，D61）。 */
  gameArgs: Record<string, EngineArgSpec>
  /** 二进制与资源下载地址。 */
  dependencies: Record<string, EngineDependency>
}
