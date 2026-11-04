// M4.1 S1：四个引擎的**唯一来源**（D60 / D61 / D62）。
//
// ===== 这个文件存在的理由 =====
//
// M4.0 之后启动逻辑是我们自己的（`src/main/launchers/`），但引擎清单还从上游模块仓库拉
// （`core.fetchRemoteManifestsList` 拉 7 个模块的 manifest.json）。
// 后果：每次启动都往 GitHub 发请求；代码里还留着 ruffle / wine / macos 三个名字；
// 上游一改清单我们的行为就变。
//
// 用户 2026-04-07 的明确要求：「为什么是过滤，为什么是隐藏？为什么不是直接删掉」。
// 所以这里**只写四个引擎**，那三个不是被过滤掉的，是**在这个文件里不存在**。
//
// ===== 数据从哪来（不是抄、是抄自实测）=====
//
// 下面每个 link / version / autodetect 都来自上游 manifest 的真实内容
// （`docs/M4.1-实施方案.md` §1.1 的实测清单 + 实施时重新核对过一遍）：
//
//   nwjs    v1.4.4   4 参数 / 6 依赖
//   mkxpz   v1.1.5  59 参数 / 4 依赖
//   easyrpg v1.1.1  51 参数 / 2 依赖
//   renpy   v1.0.2   2 参数 / 1 依赖
//
// ===== 与上游 manifest 的两处**有意**不同（都不是疏漏）=====
//
// 1. **参数大幅精简**（D61）。砍掉的是渲染画质微调（`xbrzScalingFactor` /
//    `bicubicSharpness` / `smoothScaling` 系列 40 多个）与调试参数（`recordInput` /
//    `replayInput` / `battleTest` / `dumpAtlas`）。**砍掉不等于丢功能**：这些值不写进
//    `mkxp.json` 就用 MKXP-Z 自己的默认值，而那本来也是上游给的默认值。
//
// 2. **硬编码路径换成 `<dataDir>` 占位符**。上游 manifest 里有两处写死了
//    `~/Library/Application Support/xenolauncher/...`：
//      · mkxpz 的 `preloadScript` / `midiSoundFont`（方案 §1.2 已列出）
//      · **renpy 的 `savedir`**（方案 §1.2 **漏了**这一处，见 S1 验收报告）
//    D58 之后我们不再用那个目录，照抄会让 MKXP-Z 去读不存在的文件、让 Ren'Py 把存档
//    写进别人的目录。占位符在启动时由 `expandDataDirPlaceholders` 展开（见本文件末尾）。
//
// ===== 为什么 nwjs 只剩一组依赖、一个参数 =====
//
// 上游 nwjs 有 6 个依赖：1 个是 NW.js 运行时（`version/v0.106.1`），另外 5 个是
// **注入到游戏目录里的脚本**（`cheat-js` / `cheat-css` / `bg` / `disable-child` / `disable-net`）。
// 那 5 个正是 M4.0 明令不做的东西（D53：不改写用户的游戏文件、不往游戏目录塞东西）。
// 配套的 `cheat` 参数也一样：M4.0 的 `nwjs.ts` 根本不注入作弊菜单。
//
// **留着一个不起作用的开关，比不显示更糟**——用户勾了它、游戏里按 1 没反应，
// 会以为是「这个功能坏了」。所以 `cheat` 一起删掉：nwjs 只有 `version` 一个参数。
// （玩家真需要作弊菜单时，加回是「依赖 + 参数」两行，但**必须先有注入实现**。）
import type { EngineDefinition } from './types'
import { DATA_DIR_PLACEHOLDER } from './types'

/**
 * 占位符重新导出。
 *
 * 存在的理由很朴素：调用方（启动链路、安装链路、单测）全都只 import `registry`，
 * 不该为了拿一个常量再去 import `types`。少一个入口，就少一次「忘了导出」的失误。
 */
export { DATA_DIR_PLACEHOLDER }

// ===== NW.js（RPG Maker MV / MZ）=====
//
// 上游 4 个参数：cheat / version / disableProtection / applyPixelPatch。
// 只留 `version`，理由见文件头（其余三个都依赖「改游戏文件」那一套）。
const nwjs: EngineDefinition = {
  folder: 'nwjs',
  name: 'NW.js',
  version: '1.4.4',
  description: 'A module to launch NW.js native games like RPG Maker MV and MZ.',
  descriptionKey: 'engines.desc.nwjs',
  autodetect: {
    files: ['nw.dll', 'package.json'],
    all_required: true
  },
  gameArgs: {
    // ⚠️ 默认值是**空串**，不是 `0.106.1`。上游兜底 `0.106.1`（不带 v）会拼出
    // `deps/version/0.106.1/...` 而真实目录叫 `v0.106.1` → 路径不存在 → 点启动没反应。
    // 真实的版本目录名由 `core-host.reconcileVersionArgs` 在启动前探测并修正。
    // 我们自己生成 manifest 时也不写默认版本：用户没装任何版本时让他先去装。
    version: {
      type: 'multi-version',
      label: 'NW.js Version',
      labelKey: 'args.nwjsVersion',
      default: '',
      'version-script': 'nwjs.js'
    }
  },
  dependencies: {
    'version/v0.106.1': {
      x86_64: {
        link: 'https://dl.nwjs.io/v0.106.1/nwjs-sdk-v0.106.1-osx-x64.zip',
        unzip: true
      },
      arm64: {
        link: 'https://dl.nwjs.io/v0.106.1/nwjs-sdk-v0.106.1-osx-arm64.zip',
        unzip: true
      }
    }
  }
}

// ===== mkxp-z（RPG Maker XP / VX / VX Ace）=====
//
// 上游 59 个参数。留 10 个，全是「普通用户真的会改」的：
//   rgssVersion（判断不出时的兜底）/ fullscreen / vsync / RTP / windowTitle /
//   fontSub / preloadScript / midiSoundFont / defScreenW / defScreenH
//
// 砍掉的 49 个里：40 多个是画质插值微调，其余是调试开关（JIT / dumpAtlas / execName 等）。
// 每个被砍的参数在下面注释里留了上游原名，需要时加回是一行（D61）。
const mkxpz: EngineDefinition = {
  folder: 'mkxpz',
  name: 'mkxp-z',
  version: '1.1.5',
  description: 'A module to launch RPG Maker XP, VX and VX Ace games with mkxp-z.',
  descriptionKey: 'engines.desc.mkxpz',
  autodetect: {
    files: ['Game.ini', 'System', 'Graphics', 'Audio'],
    all_required: true
  },
  gameArgs: {
    rgssVersion: {
      type: 'dropdown',
      label: 'RGSS Version',
      labelKey: 'args.rgssVersion',
      default: '0',
      // `0` = 让 mkxp-z 自己判断（与上游一致；我们不替它猜，见 mkxpz.ts 的 resolveRtp）
      options: [
        { label: 'Auto (0)', value: '0' },
        { label: 'RGSS1 (XP)', value: '1' },
        { label: 'RGSS2 (VX)', value: '2' },
        { label: 'RGSS3 (VX Ace)', value: '3' }
      ]
    },
    fullscreen: {
      type: 'boolean',
      label: 'Start in Fullscreen',
      labelKey: 'args.fullscreen',
      default: false
    },
    vsync: {
      type: 'boolean',
      label: 'VSync',
      labelKey: 'args.vsync',
      default: false
    },
    RTP: {
      type: 'array',
      label: 'RTP / Archives to Add',
      labelKey: 'args.mkxpzRtp',
      // 空数组 = 不额外加，由 `mkxpz.ts` 的 `resolveRtp` 按本地文件特征推断（复用 M3）
      default: []
    },
    windowTitle: {
      type: 'string',
      label: 'Window Title Override',
      labelKey: 'args.windowTitle',
      default: ''
    },
    fontSub: {
      type: 'array',
      label: 'Font Substitutions (Old>New)',
      labelKey: 'args.fontSub',
      default: []
    },
    defScreenW: {
      type: 'int',
      label: 'Window Width (0=auto)',
      labelKey: 'args.defScreenW',
      default: 0
    },
    defScreenH: {
      type: 'int',
      label: 'Window Height (0=auto)',
      labelKey: 'args.defScreenH',
      default: 0
    },
    // ⚠️ 上游默认值是 `~/Library/Application Support/xenolauncher/modules/mkxpz/deps/
    //    kawariki/kawariki/preload.rb`。D58 后那个目录不存在 → MKXP-Z 读不到预载脚本
    //    （表现是某些游戏的补丁层不生效，**不报错**）。这里换成运行时展开的占位符。
    //
    // ⚠️ 注意路径层级：上游是「数据目录 / **modules / mkxpz** / deps / …」——
    //    `modules/mkxpz` 这两层**必须保留**。方案 §2.4 的示例写成 `<dataDir>/deps/…`
    //    少了这两层，照抄会让 MKXP-Z 去找一个不存在的文件（它不报错，只是静默失效）。
    //    引擎依赖永远落在 `<数据目录>/modules/<引擎>/deps/` 下（见 binary-paths.ts 的 depsDir）。
    preloadScript: {
      type: 'array',
      label: 'Preload Ruby Scripts',
      labelKey: 'args.preloadScript',
      default: [`${DATA_DIR_PLACEHOLDER}/modules/mkxpz/deps/kawariki/kawariki/preload.rb`]
    },
    // ⚠️ 同样的问题：上游默认值指到 xenolauncher 目录下的 gmgsx-plus.sf2。
    midiSoundFont: {
      type: 'string',
      label: 'MIDI SoundFont (SF2)',
      labelKey: 'args.midiSoundFont',
      default: `${DATA_DIR_PLACEHOLDER}/modules/mkxpz/deps/soundfont/gmgsx-plus.sf2`
    }
  },
  // 4 个依赖全部保留：mkxpz 本体 / RTP / kawariki（preload.rb 的来源）/ soundfont（MIDI）
  dependencies: {
    mkxpz: {
      universal: {
        link: 'https://github.com/m5kro/mkxp-z/releases/download/launcher/Z-universal.zip',
        unzip: true
      }
    },
    RTP: {
      universal: {
        link: 'https://github.com/m5kro/mkxp-z/releases/download/launcher/RTP.zip',
        unzip: true
      }
    },
    kawariki: {
      universal: {
        link: 'https://github.com/m5kro/mkxp-z/releases/download/launcher/kawariki.zip',
        unzip: true
      }
    },
    // 音源是单文件 `.sf2`，**不解压**（unzip: false）
    soundfont: {
      universal: {
        link: 'https://github.com/mmontag/chip-player-js/raw/refs/heads/master/public/soundfonts/gmgsx-plus.sf2',
        unzip: false
      }
    }
  }
}

// ===== EasyRPG Player（RPG Maker 2000 / 2003）=====
//
// 上游 51 个参数。留 6 个：encoding / language / rtpPath / soundfontPath / vsync / showFps。
// 砍掉的 45 个里，`loadGameId` / `recordInput` / `replayInput` / `battleTest` / `seed`
// 是调试用途，`patchXxx` 系列是给特定游戏打补丁（猜错了反而添乱，与 D35 的精神一致），
// 其余是音量/字体/分辨率微调。
const easyrpg: EngineDefinition = {
  folder: 'easyrpg',
  name: 'EasyRPG',
  version: '1.1.1',
  description: 'A module to launch RPG Maker 2000/2003 games with EasyRPG Player.',
  descriptionKey: 'engines.desc.easyrpg',
  autodetect: {
    files: ['RPG_RT.ldb', 'RPG_RT.lmt', 'RPG_RT.ini'],
    all_required: false
  },
  gameArgs: {
    encoding: {
      type: 'string',
      label: 'Encoding',
      labelKey: 'args.encoding',
      // 空 = 让 EasyRPG 自己判断（实测 Game.ini 有可能是 GBK / Shift-JIS，见 M3 §2.5）
      default: ''
    },
    language: {
      type: 'string',
      label: 'Language',
      labelKey: 'args.language',
      default: ''
    },
    rtpPath: {
      type: 'string',
      label: 'Rtp Path',
      labelKey: 'args.easyrpgRtpPath',
      default: ''
    },
    soundfontPath: {
      type: 'string',
      label: 'Soundfont Path',
      labelKey: 'args.easyrpgSoundfontPath',
      default: ''
    },
    vsync: {
      type: 'boolean',
      label: 'Vsync',
      labelKey: 'args.vsync',
      default: true
    },
    showFps: {
      type: 'boolean',
      label: 'Show Fps',
      labelKey: 'args.showFps',
      default: false
    }
  },
  dependencies: {
    player: {
      universal: {
        link: 'https://ci.easyrpg.org/downloads/macos/EasyRPG-Player-macos.app.zip',
        unzip: true
      }
    },
    // ⚠️ `optional: true` **必须保留**（core 的补丁 #3）：
    // 这个地址是 musical-artifacts.com，该站点由 Cloudflare 人机验证保护，
    // 程序化请求恒返回 403。不加标记 → 上游逻辑直接 throw → **EasyRPG 永远装不上**。
    // 音源不是运行必需品（缺了只是部分音乐退化）。
    soundfont: {
      universal: {
        link: 'https://musical-artifacts.com/artifacts/841/GMGSx.SF2',
        unzip: false
      },
      optional: true
    }
  }
}

// ===== Ren'Py =====
//
// 上游 2 个参数：savedir / command。两个都留（`command` 是 Ren'Py 自己的子命令入口）。
const renpy: EngineDefinition = {
  folder: 'renpy',
  name: 'RenPy',
  version: '1.0.2',
  description: "A module to launch Ren'Py games.",
  descriptionKey: 'engines.desc.renpy',
  autodetect: {
    extensions: ['py', 'exe', 'sh'],
    files: ['renpy'],
    all_required: true
  },
  gameArgs: {
    // ⚠️⚠️ 上游默认值是 `~/Library/Application Support/xenolauncher/renpysaves/`
    // —— 这是**方案 §1.2 漏掉的第二处硬编码**。
    //
    // 它比 mkxpz 那两处更隐蔽：`renpy.ts` 的 `renpySaveDir` 是「用户给了 savedir 就用它，
    // 否则用我们自己的 `<dataDir>/renpysaves`」。看着安全，但 `mergeGameArgsWithSchema`
    // 会把 manifest 的默认值**合进 gameArgs 并落盘**，于是「用户什么都没填」也会变成
    // 「用户填了 xenolauncher 路径」→ 存档写进别人的目录（D58 后那个目录可能根本不存在）。
    // 所以默认值必须是我们自己的路径（占位符展开）。
    savedir: {
      type: 'string',
      label: 'Save Directory',
      labelKey: 'args.renpySaveDir',
      default: `${DATA_DIR_PLACEHOLDER}/renpysaves/`
    },
    command: {
      type: 'string',
      label: 'Other Commands',
      labelKey: 'args.renpyCommand',
      default: ''
    }
  },
  dependencies: {
    renpy: {
      universal: {
        link: 'https://www.renpy.org/dl/8.5.2/renpy-8.5.2-sdk.zip',
        unzip: true
      }
    }
  }
}

/**
 * ★ 四个引擎的唯一来源（D60）。
 *
 * 顺序 = 引擎页的展示顺序。**只有这四个**：ruffle（Flash）/ wine（Windows）/ macos
 * 不在这里，也不是被 `.filter()` 挡掉的 —— 它们在这个代码库里没有任何定义、
 * 没有任何下载地址、没有任何名字（有测试扫描源码钉死这条）。
 */
export const ENGINES: readonly EngineDefinition[] = [nwjs, mkxpz, easyrpg, renpy]

/** 引擎目录名集合（`gameEngine` 的合法值）。 */
export const ENGINE_FOLDERS: readonly string[] = ENGINES.map((engine) => engine.folder)

/** 按 folder 取定义（找不到返回 undefined，**不猜、不回退**）。 */
export function findEngine(folder: string): EngineDefinition | undefined {
  return ENGINES.find((engine) => engine.folder === folder)
}

// ===== 占位符展开 =====

/** 把一个字符串里的 `<dataDir>` 换成真实数据目录。 */
export function expandDataDirInString(value: string, dataDir: string): string {
  return value.split(DATA_DIR_PLACEHOLDER).join(dataDir)
}

/**
 * 展开 gameArgs 里所有 `<dataDir>` 占位符（递归数组/对象，**不改入参**）。
 *
 * 为什么在**启动时**展开而不是存盘时就展开：
 *   · manifest 属于「引擎定义」，数据目录属于「这台机器的安装」——前者不该写死后者的值
 *   · 用户在设置里换数据目录后，manifest 不用跟着改
 *
 * 为什么不做「默认值替换」，只做占位符替换：用户名下的路径不能靠猜
 * （`~/Library/Application Support/xenolauncher` 这种写法在 D58 之后一律是错的，
 * 而 `~/MySaves` 这种用户自己填的还是对的——只有占位符是我们能确定该换掉的）。
 */
export function expandDataDirPlaceholders(
  gameArgs: Record<string, unknown>,
  dataDir: string
): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return expandDataDirInString(value, dataDir)
    if (Array.isArray(value)) return value.map(walk)
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        out[key] = walk(item)
      }
      return out
    }
    return value
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(gameArgs)) out[key] = walk(value)
  return out
}

// ===== 生成 manifest（D62）=====

/**
 * 造一份**与上游格式兼容**的 manifest（安装时写进 `<dataDir>/modules/<引擎>/manifest.json`）。
 *
 * 兼容的意义有两层：
 *   1. 我们自己的 `readLocalManifests`（core 实现的）能读回 —— S3 有测试断言
 *   2. **原版 Xenolauncher 也能读**（字段名一个不差），万一用户的模块目录被两边共用
 *
 * 生成的字段：`name` / `version` / `description` / `author` / `license` /
 * `autodetect` / `gameArgs` / `dependencies`。
 * （`author` / `license` 固定写本项目：这份定义确实是我们的，不是上游那份。
 *  GPL-3.0 与上游一致，因为它们描述的是同一套引擎约定。）
 */
export const GENERATED_MANIFEST_AUTHOR = 'Tsumigeya'
export const GENERATED_MANIFEST_LICENSE = 'GPL-3.0'

/** `gameArgs` 的 schema 部分（去掉我们自己的 `labelKey`，只留上游认的字段）。 */
function upstreamGameArgs(definition: EngineDefinition): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, spec] of Object.entries(definition.gameArgs)) {
    const entry: Record<string, unknown> = { type: spec.type }
    if (spec.label) entry.label = spec.label
    if ('default' in spec) entry.default = spec.default
    if (spec.options) entry.options = spec.options
    if (spec['version-script']) entry['version-script'] = spec['version-script']
    out[key] = entry
  }
  return out
}

export function buildManifest(definition: EngineDefinition): Record<string, unknown> {
  return {
    name: definition.name,
    version: definition.version,
    description: definition.description,
    author: GENERATED_MANIFEST_AUTHOR,
    license: GENERATED_MANIFEST_LICENSE,
    autodetect: definition.autodetect,
    gameArgs: upstreamGameArgs(definition),
    dependencies: definition.dependencies
  }
}
