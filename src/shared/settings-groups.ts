/**
 * M5.0 S9（U9）：设置页的分组定义 -- 纯数据 + 纯函数，零依赖。
 *
 * ===== 本步真正要防的错误 =====
 *
 * 用户原话：「设置页面，也可以顺手优化一下，这里的问题没有编辑游戏问题大」
 *
 * 分组化看起来只是"把 13 条搬进 5 个 box"，但它有一个**只删不守就会复发**的风险：
 *
 *     **某个设置项在搬家时被漏掉**。
 *
 * 表现：用户找不到那个开关了。而且它**不会报错** —— 页面正常渲染、类型检查通过、
 * 单测（如果有）也全绿，因为没有任何东西在核对「Settings 的每个键都出现在某个分组里」。
 *
 * 这就是本文件存在的理由：把分组写成**数据**，再用一条判据核对
 * 「`SETTINGS_KEYS` 里的每一个都恰好被某个分组列一次」。
 * 与 D68 是同一取向（删掉/搬走的东西必须有测试守着）。
 *
 * ⚠️ 零依赖：不 import vue / pinia / i18n / api-client。
 * 分组只有 key 与「属于哪组」，文案（标题/描述）全在 locales 里按 i18n key 取。
 */

/** 一个设置项的身份（= `Settings` 的字段名）。 */
export type SettingKey =
  | 'appearance'
  | 'language'
  | 'listView'
  | 'deletionConfirmation'
  | 'nonInstalledAutodetect'
  | 'checkModuleUpdatesOnStartup'
  | 'showAdultCovers'
  | 'preferredLanguage'
  | 'fallbackLanguage'
  | 'languageSwitchPrompt'
  | 'diagnoseBeforeLaunch'
  | 'saveSyncMode'

/**
 * 全部设置项的唯一清单。
 *
 * ⚠️ 加新的 Settings 字段时**必须**同时把它加进这里、并归到某个分组 ——
 * 否则 `missingSettings` 那条测试会红（那是刻意的：漏掉的表现是"用户找不到开关"）。
 *
 * 注意**不含** `dataPath` / `appVersion` / `nodeVersion` / `platform`
 * 这类**只读**信息：它们不是"开关"，搬不进"设置项"的语义里，
 * 由 `INFO_KEYS` 单独列。
 */
export const SETTINGS_KEYS: readonly SettingKey[] = [
  'appearance',
  'language',
  'listView',
  'deletionConfirmation',
  'nonInstalledAutodetect',
  'checkModuleUpdatesOnStartup',
  'showAdultCovers',
  'preferredLanguage',
  'fallbackLanguage',
  'languageSwitchPrompt',
  'diagnoseBeforeLaunch',
  // M4 S5：存档同步模式（none / manual）。归在「游戏库」组：
  // 它管的是"存档怎么带出去"，与删确认/R18 封面同属"库里的日常行为"。
  'saveSyncMode'
]

/** 只读信息项（不是开关，单独一组展示）。 */
export const INFO_KEYS = ['dataPath', 'appVersion', 'nodeVersion', 'platform'] as const

/** 分组 id（locales 里 `settings.group.<id>` 取标题与描述）。 */
export type SettingsGroupId = 'appearance' | 'library' | 'language' | 'launch' | 'data'

/** 一个分组。 */
export interface SettingsGroup {
  id: SettingsGroupId
  /** 这一组里有哪些设置项（顺序 = 页面里的显示顺序）。 */
  keys: readonly SettingKey[]
  /**
   * 默认是否展开。
   *
   * 为什么不是全部展开：用户的抱怨是「一条条平铺」——
   * 13 条全展开就等于没分组。所以只把最常改的展开，其余收起。
   */
  defaultOpen: boolean
}

/**
 * 分组定义。
 *
 * ===== 分组依据（用户视角，不是功能上线顺序）=====
 *
 * 用户说「一条条平铺」不好，意味着他想要**按"我想改什么"来归类**：
 *
 * · `appearance` 外观：看到的样子（主题、列表视图）
 * · `library`   游戏库：库的日常行为（删确认、R18 封面）
 * · `language`  语言：界面语言 + 多语言版本偏好（这两件都与"语言"有关）
 * · `launch`    启动与引擎：与"游戏能不能起来"相关的（自动识别未装引擎、启动前诊断、
 *               启动检查更新）
 * · `data`      数据与版本：数据目录 + 版本信息
 *
 * ⚠️ `preferredLanguage` / `fallbackLanguage` / `languageSwitchPrompt` 三个都在 `language` 组：
 * 它们是同一件事（多语言版本偏好）的三个参数，拆开会让用户在两处找。
 * 同理 `diagnoseBeforeLaunch` 与 `nonInstalledAutodetect` 都在 `launch` 组：
 * 它们都影响"这次启动会不会被拦/能不能认出来"。
 */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  { id: 'appearance', keys: ['appearance', 'listView'], defaultOpen: true },
  {
    id: 'library',
    keys: ['deletionConfirmation', 'showAdultCovers', 'saveSyncMode'],
    defaultOpen: true
  },
  {
    id: 'language',
    keys: ['language', 'preferredLanguage', 'fallbackLanguage', 'languageSwitchPrompt'],
    defaultOpen: false
  },
  {
    id: 'launch',
    keys: ['nonInstalledAutodetect', 'diagnoseBeforeLaunch', 'checkModuleUpdatesOnStartup'],
    defaultOpen: false
  },
  { id: 'data', keys: [], defaultOpen: false }
]

/**
 * 被分组**漏掉**的设置项（应当恒为空）。
 *
 * 这条判据是本文件的全部意义所在：搬家的漏项不会报错，只会让用户找不到开关。
 */
export function missingSettings(groups: readonly SettingsGroup[] = SETTINGS_GROUPS): SettingKey[] {
  const covered = new Set<SettingKey>()
  for (const group of groups) for (const key of group.keys) covered.add(key)
  return SETTINGS_KEYS.filter((key) => !covered.has(key))
}

/**
 * 被分组**重复列出**的设置项（应当恒为空）。
 *
 * 重复的后果比漏掉更隐蔽：同一个开关在两个组里出现两次，用户改了一处、
 * 另一处看起来没变（其实是同一个值，但界面给了他"有两个独立设置"的错觉）。
 */
export function duplicatedSettings(groups: readonly SettingsGroup[] = SETTINGS_GROUPS): SettingKey[] {
  const seen = new Set<SettingKey>()
  const duplicated = new Set<SettingKey>()
  for (const group of groups) {
    for (const key of group.keys) {
      if (seen.has(key)) duplicated.add(key)
      seen.add(key)
    }
  }
  return [...duplicated]
}

/**
 * 分组里的设置项是否**一个都没有**（"数据与版本"组就是这样：它放的是只读信息与按钮）。
 *
 * 这种组不该画成"可折叠的设置分组" —— 里面没有开关，收起它只会让用户多一次点击。
 * 页面据此把它渲染成固定区块（`details` 之外）。
 */
export function isEmptyGroup(group: SettingsGroup): boolean {
  return group.keys.length === 0
}

/**
 * 各布尔开关的**默认值**（主进程 `DEFAULT_SETTINGS` 的镜像）。
 *
 * ===== 为什么需要这份镜像，以及它为什么必须被测 =====
 *
 * 设置页用它判断「这个收起的组里有没有被改过」——改过就在标题上点一个小圆点。
 * 判据是「当前值 ≠ 默认值」，所以**默认值写错就会误报**：
 * 用户什么都没改，收起的组上却一直挂着"你改过这里"的提示。
 *
 * 而它只能是一份**镜像**：渲染层不能 import 主进程的 `games-store.ts`
 * （那个文件会 `import node:fs`，打包进浏览器会当场失败）。
 *
 * 所以：`test/settings-groups.test.ts` 里有一条**源码级核对** ——
 * 从 `games-store.ts` 里抠出 `DEFAULT_SETTINGS` 的实际值与本表逐项比对。
 * 只要主进程改了默认值而这里没跟上，那条测试就红。
 *
 * ⚠️ 只列**布尔**项：枚举/字符串（appearance / language / 语言偏好）
 * 的"改动判定"不在这里猜 —— 猜错了会画出误导性的提示，而那些项本来也不需要提示。
 */
export const BOOL_DEFAULTS: Readonly<Record<string, boolean>> = {
  listView: false,
  deletionConfirmation: true,
  nonInstalledAutodetect: true,
  checkModuleUpdatesOnStartup: true,
  showAdultCovers: false,
  languageSwitchPrompt: true,
  diagnoseBeforeLaunch: true
}

/**
 * 某个分组里是否有**偏离默认值**的布尔设置。
 *
 * 为什么要这个：收起的组里如果用户改过东西，只看到一个折叠的标题会以为"这里是默认状态"。
 *
 * `current` 传当前 settings 对象（可以是 reactive proxy，只读不写）。
 */
export function groupHasCustom(
  group: SettingsGroup,
  current: Readonly<Record<string, unknown>>
): boolean {
  for (const key of group.keys) {
    const fallback = BOOL_DEFAULTS[key]
    if (fallback === undefined) continue
    if (current[key] !== fallback) return true
  }
  return false
}
