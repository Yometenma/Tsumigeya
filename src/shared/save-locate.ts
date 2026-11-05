// M4：存档位置探测 —— 纯函数，零依赖。
//
// ===== 为什么这条必须抽成纯函数 =====
//
// 「存档在哪」完全**不可猜**，只能按候选枚举。写错的表现**全都不会报错**：
// 列表空了用户以为「我没存过档」、导出功能对着空目录成功返回一个空 zip。
//
// 而判据依赖文件系统（`existsSync` / `readdirSync`），所以真正的 IO 留在主进程，
// 这里只收「调用方给的目录快照」→ 判据可单测（给个假快照就能跑全套分支）。
//
// ===== 实测依据（2026-11-05 在用户 Mac 上查real 目录）=====
//
// ① NW.js 的**同一引擎两种布局**（最容易踩）：
//      Karryn's Prison（MV） → <游戏>/www/save/   .rpgsave
//      艾妮希雅（MZ）        → <游戏>/save/       .rmmzsave
//    MV 的工程根目录是 `www/`，MZ 取消了 `www/`。**不能按引擎硬编码一条路径**。
//
// ② MKXP-Z（RGSS 系列）：用户那份 `傭兵の冒険` 游戏目录里**没有**现在档（还没玩到），
//    所以无法从实例确认。改用 **RPG Maker 全系列的公认约定**枚举：
//      `Data/Save1.rvdata2`（默认） / 根目录 `Save*.rvdata2`（作者改过） / `Save/` 子目录
//    存档文件名约定是 `Save%02d` + `.rvdata2`（VX Ace）/ `.rvdata`（VX）/ `.rxdata`（XP）。
//
// ③ EasyRPG：`<游戏>/Save/*.lsd`（官方 `--save-path` 的默认落点）。
//
// ④ Ren'Py：**不在游戏目录** —— `~/Library/RenPy/<游戏名>/`（mac）。
//    我们自己的 renpy savedir 则落在 `<数据目录>/renpysaves/`（见 registry 的默认值）。
//
// ⚠️ 零依赖：不 import vue / pinia / electron / fs。
// 需要的字段就地声明，保证纯 Node 的 vitest 能直接跑。

/** 一次探测需要的目录快照（由主进程用 readdirSync 填）。 */
export interface DirSnapshot {
  /** 该目录下的条目名（不含路径）。目录不存在时给空数组。 */
  entries: readonly string[]
  /** 是否为目录（路径存在但其实是文件时，我们不该往里探）。 */
  isDir: boolean
}

/** 探测候选的类别，用于文案与排障（不参与路径拼接）。 */
export type SaveLayout =
  | 'nwjs-mv'      // <游戏>/www/save/
  | 'nwjs-mz'      // <游戏>/save/
  | 'rgss-data'    // <游戏>/Data/Save*（RGSS 默认）
  | 'rgss-root'    // <游戏>/Save*（作者改到根目录）
  | 'rgss-save'    // <游戏>/Save/ 子目录
  | 'easyrpg'      // <游戏>/Save/*.lsd
  | 'renpy'        // ~/Library/RenPy/<游戏>/

/**
 * 「文件名判据」的最小接口。
 *
 * 为什么不用 `RegExp`：MV/MZ 的槽判据是「任意后缀但**排除**配置名」，
 * 那是一条**黑名单式的复合判断**，用单个正则写不清（`/^...$/ && !/^config|global$/`）。
 * 只要求实现 `test()` 就够了，具体用正则还是多条件函数由各引擎自己定。
 */
export interface NameMatcher {
  test(name: string): boolean
}

/** 探测结果：找到就用，没找到就是 null（**不是空对象**，避免"以为找到了"）。 */
export interface SaveLocation {
  layout: SaveLayout
  /** 相对游戏目录的路径（`''` 表示就是游戏目录本身）。排障与文案用。 */
  relativeDir: string
  /** 哪些文件名算存档槽（配置文件不算）。 */
  slotPattern: NameMatcher
  /** 哪些文件名算配置文件（要跟存档槽分开列，否则用户以为它是第 0 号存档）。 */
  configPattern: NameMatcher
  /**
   * 位置在**游戏目录之外**（只有 Ren'Py 是）。调用方要拼外部路径，
   * 不能 `path.join(游戏目录, relativeDir)` —— 那样会拼回游戏目录。
   */
  external?: boolean
}

// ===== 文件名判据 =====
//
// ⚠️ 判据的**方向**：宁可把「看起来像存档的东西」都算进槽，也不能漏。
//   漏了的后果是用户看到「没有存档」，而文件明明在那 —— 他会以为程序坏了。
//   多认几个（比如游戏插件多写的 `sync_data.rpgsave`）最坏只是列表多一项。
//
// 用户真机实测（2026-11-05，Karryn's Prison/www/save/）：
//   config.rpgsave      ← 配置
//   global.rpgsave      ← 配置
//   file1.rpgsave       ← 存档槽
//   lastsave.autobak    ← 游戏插件写的「上次存档的备份」（不是存档槽，但**是存档数据**）
//   sync_data.rpgsave   ← 游戏自己的同步数据（同上）
// 所以：槽 = `.rpgsave` 但**排除**已知的配置名；剩下的 `.rpgsave` 全算槽。

/** MV：`config` / `global` 是引擎配置，其余 `.rpgsave` 都算存档数据。 */
const MV_ANY = /\.rpgsave$/i
const MV_CONFIG = /^(config|global)\.rpgsave$/i

/**
 * MV 的槽判据：**任意** `.rpgsave`，但排除配置名。
 *
 * 用「白名单前缀」（只认 `file\d+`）会漏掉插件写的 `sync_data.rpgsave` /
 * `lastsave.autobak` 之类 —— 那些**确实是存档数据**（备份/同步），
 * 漏了会让「导出」少带走一部分，用户换机后就少东西。
 */
const MV_SLOT = {
  test(name: string): boolean {
    return MV_ANY.test(name) && !MV_CONFIG.test(name)
  }
}

/** MZ：同 MV 的策略。`file1.rmmzsave` 是槽，`config`/`global` 是配置。 */
const MZ_ANY = /\.rmmzsave$/i
const MZ_CONFIG = /^(config|global)\.rmmzsave$/i
const MZ_SLOT = {
  test(name: string): boolean {
    return MZ_ANY.test(name) && !MZ_CONFIG.test(name)
  }
}

/** RGSS：`Save1.rvdata2` / `Save1.rvdata` / `Save1.rxdata`（三个世代的扩展名）。 */
const RGSS_SLOT = /^Save\d+\.(rvdata2|rvdata|rxdata)$/i
/** RGSS 没有独立的配置文件（`Game.ini` 在游戏根目录，不属于存档目录）。 */
const RGSS_CONFIG = /^\u0000_never_\u0000/ // 永不匹配（见下方解释）

/** EasyRPG：`Save1.lsd` / `Save01.lsd`（它允许补零）。 */
const EASY_SLOT = /^Save\d+\.lsd$/i

/** Ren'Py：`1-1-LT1.save` / `auto-1.save`（它自己的命名，手动档与自动档都算）。 */
const RENPY_SLOT = /^(?:\d+-\d+-LT\d+|auto-\d+)\.save$/i

/**
 * 「永不匹配」的正则。
 *
 * 为什么不给 `null`：调用方要统一地 `.test(name)`，null 会逼出分支。
 * 用 NUL 字符做字面量是因为文件名**不可能**包含 NUL（文件系统层就禁止），
 * 所以它在任何真实文件名上都不会命中 —— 比 `/(?!)!/` 这种零宽负向断言更容易读懂。
 */
const NEVER: RegExp = RGSS_CONFIG

// ===== 探测主函数 =====

/**
 * 从「游戏目录的条目」判断是不是 NW.js MV / MZ 布局。
 *
 * 判据不是「有没有 www」，而是「www/save 或 save 里有没有存档后缀的文件」——
 * 有些 MV 游戏把 save 放在 www 外面，有些目录存在但空着（还没存过档）。
 */
function detectNwjs(snap: {
  worldWideWeb: DirSnapshot | null
  wwwSave: DirSnapshot | null
  gameSave: DirSnapshot | null
}): SaveLocation | null {
  const { wwwSave, gameSave } = snap

  // ① MV：<游戏>/www/save/ 里有 .rpgsave
  if (wwwSave?.isDir && wwwSave.entries.some((n) => MV_SLOT.test(n) || MV_CONFIG.test(n))) {
    return { layout: 'nwjs-mv', relativeDir: 'www/save', slotPattern: MV_SLOT, configPattern: MV_CONFIG }
  }

  // ② MZ：<游戏>/save/ 里有 .rmmzsave
  if (gameSave?.isDir && gameSave.entries.some((n) => MZ_SLOT.test(n) || MZ_CONFIG.test(n))) {
    return { layout: 'nwjs-mz', relativeDir: 'save', slotPattern: MZ_SLOT, configPattern: MZ_CONFIG }
  }

  // ②' ★ 真机踩到的：**MV 游戏也可能把 save 放在 <游戏>/save/**
  //     （Mac 实测 2026-11-05：`苍蓝星` 的 www/ 存在、但 www/save/ 不存在，
  //     存档全在 `<游戏>/save/` 里，后缀是 .rpgsave）
  //
  //     ⚠️ 判据必须是**后缀**，不是相对路径。原来这里漏了这个分支：
  //     走到下面的 ③ 时「save/ 存在」被当成 MZ → 布局报 nwjs-mz、
  //     slotPattern 用 MZ 的 `.rmmzsave` 判据 → 那堆 .rpgsave **一个都匹配不上**
  //     → 用户看到「目录已就绪，还没有存档」，而那儿躺着 20 多个档。
  //     这正是本模块最怕的「看起来成功了」：不报错、只安静地少列东西。
  if (gameSave?.isDir && gameSave.entries.some((n) => MV_SLOT.test(n) || MV_CONFIG.test(n))) {
    return { layout: 'nwjs-mv', relativeDir: 'save', slotPattern: MV_SLOT, configPattern: MV_CONFIG }
  }

  // ③ 目录存在但**空**（还没存过档）：也报出来，好让 UI 说「目录已就绪，还没有存档」
  //    而不是「这个游戏没有存档功能」。靠引擎线索区分：有 www/ → 大概率 MV。
  if (wwwSave?.isDir) {
    return { layout: 'nwjs-mv', relativeDir: 'www/save', slotPattern: MV_SLOT, configPattern: MV_CONFIG }
  }
  if (gameSave?.isDir) {
    return { layout: 'nwjs-mz', relativeDir: 'save', slotPattern: MZ_SLOT, configPattern: MZ_CONFIG }
  }
  return null
}

/** 从「游戏目录 + Data/ + Save/」三处条目判断 RGSS 存档位置。 */
function detectRgss(snap: {
  root: DirSnapshot | null
  data: DirSnapshot | null
  saveDir: DirSnapshot | null
}): SaveLocation | null {
  // ① <游戏>/Data/Save*（RGSS 默认约定）
  if (snap.data?.isDir && snap.data.entries.some((n) => RGSS_SLOT.test(n))) {
    return { layout: 'rgss-data', relativeDir: 'Data', slotPattern: RGSS_SLOT, configPattern: NEVER }
  }
  // ② <游戏>/Save*（作者改到根目录）
  if (snap.root?.isDir && snap.root.entries.some((n) => RGSS_SLOT.test(n))) {
    return { layout: 'rgss-root', relativeDir: '', slotPattern: RGSS_SLOT, configPattern: NEVER }
  }
  // ③ <游戏>/Save/ 子目录（有些移植版这么放）
  if (snap.saveDir?.isDir && snap.saveDir.entries.some((n) => RGSS_SLOT.test(n))) {
    return { layout: 'rgss-save', relativeDir: 'Save', slotPattern: RGSS_SLOT, configPattern: NEVER }
  }
  // ④ 一个存档都没有，但 Data/ 存在（RGSS 游戏一定有 Data/）→ 报「默认位置，目前空」
  //    这条很重要：它让 UI 能说「玩到存档点后，存档会出现在这里」
  if (snap.data?.isDir) {
    return { layout: 'rgss-data', relativeDir: 'Data', slotPattern: RGSS_SLOT, configPattern: NEVER }
  }
  return null
}

/** EasyRPG：`<游戏>/Save/*.lsd`。 */
function detectEasyrpg(saveDir: DirSnapshot | null): SaveLocation | null {
  if (!saveDir?.isDir) return null
  // 目录存在就报（哪怕空）—— EasyRPG 的存档目录就是它
  return { layout: 'easyrpg', relativeDir: 'Save', slotPattern: EASY_SLOT, configPattern: NEVER }
}

/**
 * Ren'Py：位置**在游戏目录之外**（`~/Library/RenPy/<游戏名>/`）。
 *
 * 主进程会把那个目录的内容也读成快照传进来（`external`）。
 * `relativeDir` 留 `''`，并用 `external: true` 明确「不在游戏目录里」——
 * 调用方据此知道要拼外部路径而不是 `path.join(root, '')`。
 */
function detectRenpy(external: DirSnapshot | null): SaveLocation | null {
  if (!external?.isDir) return null
  return {
    layout: 'renpy',
    relativeDir: '',
    slotPattern: RENPY_SLOT,
    configPattern: NEVER,
    external: true
  }
}

/**
 * 全套探测入口。
 *
 * **调用方负责**把所需的目录读成 `DirSnapshot`（读不到的给 null）——
 * 这样这个函数可以在纯 Node 里被喂假数据测遍所有分支。
 */
export function detectSaveLocation(input: {
  engine: string
  /** <游戏>/www/save */
  wwwSave?: DirSnapshot | null
  /** <游戏>/save */
  gameSave?: DirSnapshot | null
  /** <游戏>/Data */
  dataDir?: DirSnapshot | null
  /** <游戏>/Save */
  saveDir?: DirSnapshot | null
  /** <游戏> 本身 */
  root?: DirSnapshot | null
  /** Ren'Py 专用的外部目录（`~/Library/RenPy/<游戏名>/`） */
  external?: DirSnapshot | null
}): SaveLocation | null {
  switch (input.engine) {
    case 'nwjs':
      return detectNwjs({ worldWideWeb: null, wwwSave: input.wwwSave ?? null, gameSave: input.gameSave ?? null })
    case 'mkxpz':
      return detectRgss({ root: input.root ?? null, data: input.dataDir ?? null, saveDir: input.saveDir ?? null })
    case 'easyrpg':
      return detectEasyrpg(input.saveDir ?? null)
    case 'renpy':
      return detectRenpy(input.external ?? null)
    default:
      return null
  }
}

/**
 * 把一个目录的条目分成「存档槽」与「配置文件」两类（顺序稳定，config 在前）。
 *
 * ⚠️ **先判 config，再判 slot**：M4 的槽判据是「任意 .rpgsave 但排除配置名」，
 * 如果先判 slot，`config.rpgsave` 会被匹配成槽（因为 slot 是黑名单式）。
 * 顺序写反不会报错，只会让 `config` 混进存档列表 —— 用户以为它是第 0 号档。
 *
 * ⚠️ **点开头的系统噪音一律跳过**（`._file1.rpgsave` / `.DS_Store`）。
 * 这条不是洁癖：MV 的槽判据是「任意 .rpgsave 但排除 config/global」，
 * 所以 `._file1.rpgsave` **会命中槽判据** —— 列表里多出一个看起来像存档、
 * 点"在访达中显示"却指向 163 字节元数据镜像的幽灵条目。
 * 而且导出会把它当存档打进包（`save-archive-io` 那边也有一道同样的过滤）。
 */
export function classifySaveEntries(
  entries: readonly string[],
  loc: SaveLocation
): { slots: string[]; configs: string[] } {
  const slots: string[] = []
  const configs: string[] = []
  for (const name of entries) {
    // 与 shared/save-archive.ts 的 isNoiseFile 同一判据（点开头）。
    // 这里不 import 它：save-locate 是「探测」层，save-archive 是「打包」层，
    // 让探测层依赖打包层会绕成环（archive 已经 import 了 locate）。
    if (name.startsWith('.')) continue
    if (loc.configPattern.test(name)) configs.push(name)
    else if (loc.slotPattern.test(name)) slots.push(name)
  }
  // 槽按文件名自然排序：`file1` / `file2` / `file10` 要按数字而不是字典序
  slots.sort(naturalCompare)
  configs.sort(naturalCompare)
  return { slots, configs }
}

/**
 * 自然排序（`file2` 排在 `file10` 前）。
 *
 * 不用 `localeCompare`：它的结果依赖 ICU 与语言环境，
 * CI（Linux）和开发机（Windows）可能给出不同顺序 → 测试会"偶发"红。
 */
export function naturalCompare(a: string, b: string): number {
  const re = /(\d+)|(\D+)/g
  const pa = a.match(re) ?? []
  const pb = b.match(re) ?? []
  const n = Math.min(pa.length, pb.length)
  for (let i = 0; i < n; i += 1) {
    const x = pa[i]
    const y = pb[i]
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      const d = Number(x) - Number(y)
      if (d !== 0) return d
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return pa.length - pb.length
}
