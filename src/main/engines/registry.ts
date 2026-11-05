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
import type { EngineAutodetect, EngineDefinition } from './types'
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
    },
    // ===== 全屏（M5 S2）=====
    //
    // 走 Chromium 的 `--start-fullscreen`（命令行开关），**不碰 package.json**
    // 的 `chromium-args` —— 后者是改写用户游戏文件，D53 已拒。
    // 参数位置由 `nwjs.ts` 的 nwjsPlan 保证（放在游戏目录之后）。
    fullscreen: {
      type: 'boolean',
      label: 'Start in Fullscreen',
      labelKey: 'args.fullscreen',
      default: false
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
    // ===== 缩放（M5 S1）=====
    //
    // 键名是从 **用户 mac 上那份 Z-Universal 二进制的 strings** 里核对的
    // （2026-11-05）：`integerScalingActive` / `integerScalingLastMile` / `fixedAspectRatio`
    // 与 `gameFolder` 出现在**同一串配置键**里，说明它们都是 mkxp.json 认的键。
    //
    // ⚠️ 别把 `smoothScaling` 当成窗口缩放 —— 它是**位图**平滑
    // （bitmapSmoothScaling / textureScalingFactor 才是它的同类），
    // 管的是贴图采样，不是窗口大小。我们之前只在注释里提过它，容易误接。
    integerScalingActive: {
      type: 'boolean',
      label: 'Integer Scaling (pixel-perfect)',
      labelKey: 'args.integerScalingActive',
      // 默认关：mkxp-z 自己的默认是关，随意打开会改变所有游戏的观感
      default: false
    },
    fixedAspectRatio: {
      type: 'boolean',
      label: 'Fixed Aspect Ratio',
      labelKey: 'args.fixedAspectRatio',
      default: false
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
    },
    // ===== 全屏与缩放（M5 S1）=====
    //
    // 参数名来自 **EasyRPG Player 官方 man page**
    // （`resources/unix/easyrpg-player.6.adoc`，2026-11-05 拉取核对）：
    //   `--fullscreen`  Start in fullscreen mode.
    //   `--window`      Start in windowed mode.
    //   `--scaling MODE`  nearest / integer / bilinear
    //      integer = 按游戏分辨率的整数倍缩放（**像素风游戏最该用这个**，不出插值糊字）
    //
    // ⚠️ 与 `--window` 的关系：两者互斥，但 launcher 的 `argsToFlags` 是按 gameArgs 的键
    // 逐个输出，**不会**自动互斥。所以这里**只用 `fullscreen` 布尔**：
    //   true  → 输出 `--fullscreen`；false → 什么都不输出（EasyRPG 默认就是窗口）
    //   这样永远不会出现「同时给了 --fullscreen 和 --window」。
    fullscreen: {
      type: 'boolean',
      label: 'Start in Fullscreen',
      labelKey: 'args.fullscreen',
      default: false
    },
    scaling: {
      type: 'dropdown',
      label: 'Scaling',
      labelKey: 'args.easyrpgScaling',
      // 空 = 不传 `--scaling`，用 EasyRPG 自己的默认（等于 nearest）
      default: '',
      options: [
        { label: 'Engine default', value: '' },
        { label: 'Nearest (fast)', value: 'nearest' },
        { label: 'Integer (pixel-perfect)', value: 'integer' },
        { label: 'Bilinear (smooth)', value: 'bilinear' }
      ]
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

// ===== TyranoScript（ティラノスクリプト）=====
//
// ===== 为什么它能被「自己实现」=====
//
// 它是 **HTML5 引擎**：游戏本体就是 `index.html` + `tyrano/` + `data/` 的网页目录
// （官方教程明写「ブラウザゲームとして配布する場合はプロジェクトフォルダ以下の
// ファイルを丸ごとサーバーにアップ」）。所以**资源完全跨平台**（判据 A 成立）。
//
// 判据 B 也成立，而且我们已经有运行时了：**上方的 nwjs**。
// NW.js 就是个浏览器壳，`nw ` 加载一个含 `package.json` 的网页目录 ——
// 与 Tyrano 的形态天然同构。**不需要为它下载任何新东西**（这是它成本最低的原因）。
//
// ===== Windows 分发包的三种形态（`tyranoscript.exe` + 其中一种）=====
//
//   ① 未打包目录：`tyranoscript.exe` + `game/`（内含 index.html、tyrano/、data/）
//   ② `app.nw`：项目打成 zip 后改名，与 exe 并排
//   ③ 单文件 `game.exe`：`copy /b tyranoscript.exe+app.nw game.exe`（zip 拼接在 exe 尾部）
//
// 出处：官方作者 shikemokumk 的打包说明
// （https://shikemokumk.hateblo.jp/entry/2016/01/22/141350）。
//
// ⚠️ 形态 ③ 在游戏目录里**除了一个 exe 什么都没有**，光看文件名认不出是 Tyrano。
// 所以 autodetect 先只覆盖形态 ①②（目录里有 `tyrano/` + `data/`）。
// 形态 ③ 要走「读 exe 尾部找 zip」的解包路径，**必须先有真机样本实测**才敢做
// （见 docs/引擎范围扩展-实施方案.md §8-B）。
//
// ⚠️ 存档位置**待实测**：在确认之前 `shared/save-locate.ts` 对它返回 null（显示「不知道」），
// 绝不按「哪个目录像存档」去猜 —— 那是 D85 那个 bug 的同一个坑。
const tyrano: EngineDefinition = {
  folder: 'tyrano',
  name: 'TyranoScript',
  version: '1.0.0',
  description: 'A module to launch TyranoScript HTML5 games with NW.js.',
  descriptionKey: 'engines.desc.tyrano',
  autodetect: {
    // ===== Tyrano 的三种分发包形态（2026-11-05 核实，M6.5 补 v5）=====
    //
    //   ① **v4 未打包**：`tyrano/` + `data/` 直接在游戏根            ✅ 强命中（下面这条）
    //   ② **v5 unpacked**：`resources/app/{index.html,main.js,tyrano/,data/}`  ⚠️ 见下
    //   ③ **v5 packed**：`resources/app.asar`                       ❌ **认不出**（见下）
    //
    // ① 用两个**目录**当判据，不用 index.html —— 后者在任何网页项目里都有，会误伤。
    //    强命中（all_required），与 nwjs 的 `nw.dll + package.json` 互不重叠。
    //
    // ⚠️ **② 为什么不能写进规则**：`resources/app/` 这个路径在很多 Electron 应用里都有，
    //    写成 `files: ['resources/app']` 会把任何 Electron 打包的程序都认成 Tyrano。
    //    → 形态 ② 的识别**靠 `import-target.ts` 的上退兜底**：用户选 `resources/app/index.html`
    //      时，退到 `resources/app/` 那一层能看到 `tyrano/` + `data/`（上退上限 2 层，刚好够）。
    //      **这条依赖用户选对文件，脆弱但不会误认** —— 这是有意的取舍：宁可漏认，不可乱认
    //      （D88 那条 Unity 误判的同一个教训）。
    //
    // ⚠️ **③ 为什么认不出**：NW.js **原生不支持 asar**（nwjs/nw.js issue #5500 至今是
    //    feature request，未实现）。而 Electron 才能读 asar。
    //    → 形态 ③ **本版本不支持**，且**没有可靠的本地判据**认它
    //      （asar 是个魔数文件，但目录里只有它时无法区分「这是 Tyrano 的 asar」
    //      和「别的 Electron 应用的 asar」）。
    //    → 如实记为「未支持」，不写一个会误伤所有 Electron 应用的规则。
    files: ['tyrano', 'data'],
    all_required: true
  },
  gameArgs: {
    // Tyrano 全屏靠浏览器全屏；与 nwjs 共用同一个键与文案。
    fullscreen: {
      type: 'boolean',
      label: 'Start in Fullscreen',
      labelKey: 'args.fullscreen',
      default: false
    }
  },
  // ⚠️ 空 dependencies 是**有意**的：Tyrano 复用 NW.js 运行时，不需要自己的下载。
  // 空对象不是「还没写」。引擎页对空 dependencies 的引擎要显示「无需单独下载」，
  // 不能显示成「可安装 → 点了失败」（D60 的同一个教训：不起作用的开关比不显示更糟）。
  dependencies: {}
}

// ===== 吉里吉里（KiriKiri 2 / Z）=====
//
// ===== ⚠️ 这个引擎是「实验性」的，理由必须写在代码里 =====
//
// 运行时用 **krkrsdl2**（吉里吉里Z 的 SDL2 移植，MIT，有 macOS 预编译包）。
// 它技术上能跑吉里吉里游戏（命令行就是 `krkrsdl2 <启动目录>`），
// 但官方页面 **明写**：
//
//     "Running **unmodified commercial games** using this project is **not supported**.
//      Please use Wine or GameNative instead."
//     —— https://krkrsdl2.github.io/krkrsdl2/en/
//
// 用户 2026-11-05 拍板**接受**这条限制，所以我们做它；但**必须**：
//   ① `experimental: true` → 引擎页标「实验」，卡片写明这是上游的限制
//   ② 出问题时不要把锅算到我们头上
//
// 判据 A：资源是 `data.xp3`（归档）+ `.tjs` 脚本，**跨平台**（不是机器码）→ 成立
// 判据 B：krkrsdl2 有 macOS 版 → 成立
// 所以它符合「自己实现」的公式，只是上游不背书。
const kirikiri: EngineDefinition = {
  folder: 'kirikiri',
  name: "KiriKiri",
  version: '1.0.0',
  description: 'A module to launch KiriKiri games with krkrsdl2 (experimental).',
  descriptionKey: 'engines.desc.kirikiri',
  autodetect: {
    // 强命中：有 data.xp3 归档就是吉里吉里（这是它最标志性的产物）。
    // ⚠️ 有些游戏不打包，用 startup.tjs + 散文件；那种形态**暂不认**
    // （认了就会把「一堆 .tjs」误判，而那些项目的散文件布局没有统一约定）。
    files: ['data.xp3'],
    all_required: true
  },
  gameArgs: {
    fullscreen: {
      type: 'boolean',
      label: 'Start in Fullscreen',
      labelKey: 'args.fullscreen',
      default: false
    }
  },
  dependencies: {
    // ===== ⚠️ 这是一个**浮动 tag**，不是固定版本（2026-11-05 实测）=====
    //
    // `krkrsdl2` 仓库没有版本化 release，只有一个由 GitHub Actions 每次 commit
    // 自动重建、**反复覆盖同一文件名**的 `latest` tag（实测 HEAD 请求 302 到
    // release-assets，文件名仍是 `krkrsdl2-macos.zip`）。
    //
    // 这与 D60 的取向**冲突**（浮动 tag 会让我们的行为随上游漂移），但这里没有选择：
    // 上游根本不提供固定版本。**如实记下来，不假装它稳定。**
    //
    // 后果与处置：
    //   · 用户装到的是「安装那一刻」的上游代码 —— 同一台机器重装可能拿到不同 build
    //   · 若某次重建引入了回归，我们**无法 pin、无法回退**
    //   · → 出问题时的排障提示要指向「上游 latest 变了」这个可能性
    //     （`launchers/kirikiri.ts` 的注释里记了这条）
    krkrsdl2: {
      universal: {
        link: 'https://github.com/krkrsdl2/krkrsdl2/releases/download/latest/krkrsdl2-macos.zip',
        unzip: true
      }
    }
  },
  experimental: true
}

// ===== NScripter（ONScripter）=====
//
// ===== 判据 A（资源跨平台）=====
//
// NScripter 的游戏是 `nscript.dat`（脚本，简单加密）+ `arc.nsa`（归档）+ 图片音频，
// 全是数据。ONScripter 直接读这些文件，**不需要任何 Windows 二进制**。
//
// ===== 判据 B（有 macOS 运行时）=====
//
// **ONScripter** 是 NScripter 的开源兼容实现，本体 **GPL-2+**。
// ⚠️ 许可证本鱼核过 Debian 官方版权文件（onscripter 包）：
//    「either version 2 of the License, **or (at your option) any later version**」
//    → 是 `GPL-2+` 而不是 `GPL-2.0-only` → **允许按 GPL-3.0 使用，与本项目兼容**。
//    （普通法理上「GPLv2-only 与 GPLv3 不兼容」是对的，但这个包带 `+`，结论相反。）
//
// macOS 二进制来源：**tmkk 的 ONSLauncher 项目**（https://tmkk.undo.jp/onscripter/）
//   · 2023-07-08 起 **Apple Silicon 原生**（arm64）
//   · 双架构 universal binary，OSX 10.4+ / 10.9+ 分别对应两个二进制
//   · 提供 `onscripter-sdl2`（通过 sdl12-compat 走 SDL2），这是现代 macOS 唯一能正常渲染的
//
// ===== ⚠️ 两个「不处理就静默失败」的点（launcher 的 prepare 必须管）=====
//
//   ① **缺 `default.ttf` 根本启动不了**（不是警告，是起不来）
//   ② **缺 `game.id` 会把存档丢进随机命名的目录**（用户的档还在，但他找不到）
//
// 这两个都由 `launchers/nscripter.ts` 的 prepare 处理（**写进 `<dataDir>`，绝不碰游戏目录**）。
//
// ===== 存档（可纳入现有管理）=====
//
// ONScripter 支持 `--save=<路径>`（命令行）或 `ons.cfg` 的 `save=`。
// 默认落点是 Windows `C:\ProgramData\` / Linux `~/` 下按 `game.id` 命名的子目录
// （macOS 具体默认路径 —— **未查到**，所以**一律显式传 `--save`**，不靠默认）。
// → 显式指定后，存档管理就能像 nwjs/renpy 一样接入。
const nscripter: EngineDefinition = {
  folder: 'nscripter',
  name: 'NScripter',
  version: '1.0.0',
  description: 'A module to launch NScripter visual novels with ONScripter.',
  descriptionKey: 'engines.desc.nscripter',
  autodetect: {
    // 强命中：`nscript.dat`（脚本）或 `arc.nsa`（归档）—— 这两个是 NScripter 的标志产物。
    // ⚠️ `all_required: false`：因为有些游戏两者只出现其中一个
    //    （散装素材的游戏可能没有 arc.nsa）。用打分而不是硬门槛。
    //    但它仍然赢不过别的强命中，符合 pickBestRule 的规则。
    files: ['nscript.dat', 'arc.nsa'],
    all_required: false
  },
  gameArgs: {
    fullscreen: {
      type: 'boolean',
      label: 'Start in Fullscreen',
      labelKey: 'args.fullscreen',
      default: false
    }
  },
  dependencies: {
    // ⚠️ 这是 **tar.bz2** 而不是 zip。系统 bsdtar（mac /usr/bin/tar）原生支持，
    //    与 zip 走同一条 extractArchive 路径，不需要额外依赖。
    onscripter: {
      universal: {
        link: 'https://tmkk.undo.jp/onscripter/onscripter-20230825bin.tar.bz2',
        unzip: true
      }
    }
  }
}

// ===== Siglus（siglus_rs）=====
//
// ===== 为什么它是「性价比最高」的一条 =====
//
// **siglus_rs**（https://github.com/xmoezzz/siglus_rs）是一个 Rust 重实现，
// 一个引擎同时覆盖 **四种** 日本 VN 引擎格式：
//
//   · UK2
//   · AVG32
//   · **RealLive**（所以 RealLive 可能不需要单独做 —— 见下）
//   · SiglusEngine
//
// 许可证 **MPL-2.0**（与 GPL-3.0 兼容，且 MPL 是文件级 copyleft，不传染整个项目）。
// macOS 支持：README 明写 **aarch64 app / x86_64 app / universal DMG app bundle**，
// 且有预编译 Releases、README 里带「SiglusEngine running natively on macOS」截图。
//
// ===== ⚠️ 唯一的技术门槛：`key.toml` =====
//
// SiglusEngine 的游戏资源是加密的，需要一个 16 字节副密钥（`key.toml`）。
// siglus_rs 支持**自动爆破**（README 有说明），所以不是硬阻塞，但要在启动前处理。
//
// ===== 关于 RealLive 是否单独做 =====
//
// siglus_rs 已经覆盖 RealLive。所以**先用 siglus_rs 跑 RealLive 游戏**，
// 跑不动再考虑 rlvm（后者许可证/存档路径/arm64 全都未核实，风险更高）。
// 这条写在这里是为了避免下个会话又去做一遍 rlvm。
const siglus: EngineDefinition = {
  folder: 'siglus',
  name: 'Siglus',
  version: '1.0.0',
  description: 'A module to launch Siglus / UK2 / AVG32 / RealLive games with siglus_rs.',
  descriptionKey: 'engines.desc.siglus',
  autodetect: {
    // SiglusEngine 的标志产物：`Scene.pck`（主归档）+ `Gameexe.dat`（配置）。
    // ⚠️ RealLive 的旧格式是 `Seen.txt` + `Gameexe.ini`，见下一条。
    files: ['Scene.pck', 'Gameexe.dat'],
    all_required: false
  },
  gameArgs: {
    fullscreen: {
      type: 'boolean',
      label: 'Start in Fullscreen',
      labelKey: 'args.fullscreen',
      default: false
    }
  },
  dependencies: {
    // ===== ⚠️ M6.5 实测修正：原来的地址是 404 =====
    //
    // 本鱼第一版写的是
    //   `.../releases/latest/download/siglus_engine-macos-universal.dmg`
    // **两处都错**（2026-11-05 经代理实测 404）：
    //   ① 资产名不对：真实文件叫 **`Siglus-universal.dmg`**（不是 siglus_engine-…）
    //   ② tag 不对：macOS 产物在 **`pre-release`** 这个 tag 里；
    //      而 `latest` 指向的是 `1.0.0`，**那个 release 一个资产都没有**（只有源码）
    //
    // 改用**按架构分开的 app 包**（`siglus-macos-arm64.app.tar.gz`，12 MB），
    // 而不是 universal DMG（DMG 在 mac 上要挂载/解包，对我们这条「引擎=目录」模型更麻烦）。
    // 地址已实测 HTTP 206（可下载）。
    siglus_rs: {
      arm64: {
        link: 'https://github.com/xmoezzz/siglus_rs/releases/download/pre-release/siglus-macos-arm64.app.tar.gz',
        unzip: true
      },
      x86_64: {
        link: 'https://github.com/xmoezzz/siglus_rs/releases/download/pre-release/siglus-macos-x86_64.app.tar.gz',
        unzip: true
      }
    }
  }
}

// ===== Godot =====
//
// ===== 判据 A：pck 跨平台（但有三个前提）=====
//
// 官方导出文档：「allows a single exported main pack file to be used with
// **multiple Godot executables**」→ 只出 PCK 时，同一份 pck 可配不同平台的引擎。
// 桌面↔桌面不受 VRAM 压缩纹理差异影响（Windows 与 macOS 都走 S3TC/BPTC）。
//
// ⚠️ **三个前提，缺一不可**：
//   ① **GDScript 项目**（C# 项目在 mac 上加载不了 —— issue #72159 实测报
//      `class could not be found` / `Failed to load hostfxr`）
//   ② **不用 GDExtension**（它含平台专用 .dylib/.dll）
//   ③ **引擎版本匹配**（4.6.1 的 pck 只能配 4.6.x）
//
// ===== 判据 B：有 macOS 运行时 =====
//
// 用**官方编辑器二进制**（universal 双架构，约 154 MiB）。
// 为什么不自己编译 export template：4.6 起 template **默认禁用 `--main-pack`**
// （PR #111909 / issue #119376 实测报 `compiled without support for path overrides`），
// 而编辑器二进制仍然支持 —— 用它可以**避免要求每个用户自己编译 Godot**。
//
// ===== ⚠️ 已知限制：存档改不了 =====
//
// 官方明确「导出的工程不支持 self-contained mode」→ 不能把存档重定向到游戏目录。
// 而默认位置依赖 `project_name`（要从 pck 里读）。
// → **本版本存档位置返回 null（未实现）**，不假装支持（与 tyrano/kirikiri 同一取向）。
//
// ===== autodetect 为什么这么窄 =====
//
// 只认 `.pck` 这个扩展名 —— 它太宽（任何引擎都可能有个叫 x.pck 的文件）？
// 实测权衡：Godot 的 pck **只有 Godot 用**这个扩展名，而更可靠的判据
// （读 pck 魔数 `GDPC`）需要额外解析。用扩展名 + **排在所有强命中之后**打分，
// 风险可控：真被误认的后果是「识别成 Godot」，而 Godot 玩家目录里确实有 .pck。
const godot: EngineDefinition = {
  folder: 'godot',
  name: 'Godot',
  version: '1.0.0',
  description: 'A module to launch Godot games (GDScript projects) with the official Godot runtime.',
  descriptionKey: 'engines.desc.godot',
  autodetect: {
    extensions: ['pck'],
    all_required: false
  },
  gameArgs: {
    fullscreen: {
      type: 'boolean',
      label: 'Start in Fullscreen',
      labelKey: 'args.fullscreen',
      default: false
    }
  },
  dependencies: {
    // ⚠️ universal 双架构（arm64 + x86_64），约 154 MiB。
    // 版本 pin 在 4.6.x —— 因为 pck 的版本必须与引擎匹配，
    // 而 4.5 与 4.6 的 pck 格式不通用。
    godot: {
      universal: {
        link: 'https://github.com/godotengine/godot-builds/releases/download/4.6.1-stable/Godot_v4.6.1-stable_macos.universal.zip',
        unzip: true
      }
    }
  }
}

// ===== 只识别、不启动的引擎（DETECT_ONLY）=====
//
// ===== 为什么需要这张表 =====
//
// 用户的要求是「范围尽可能广」。但**「认得出」和「跑得动」是两件事**：
//
//   引擎           资源跨平台？  有 macOS 运行时？  我们能跑？
//   Unity          ❌ IL2CPP 锁平台      —            ❌ 需要 Windows
//   RPGBakin       ❌ 仅 Windows（官方 FAQ 明写）      ❌ 需要 Windows
//   ウディタ        ❌ Windows 专属                    ❌ 需要 Windows
//
// 把这三类塞进 `ENGINES` 是错的：引擎页会把它们列成「可安装」，
// 而下载地址是空的 → 用户点了一定失败（D60 的「不起作用的开关」教训）。
//
// 完全不认它们也是错的：用户添加一个 Unity 游戏会得到「未知引擎」，
// 而「未知引擎」和「这个引擎需要 Windows 兼容层」是**两种完全不同的处境** ——
// 前者像是本程序坏了，后者是有清晰说明的能力边界。
//
// 所以：**识别范围铺满，运行范围诚实留白**。
// 这张表只参与 `detect` 打分，不进可安装列表、不进 `ENGINE_FOLDERS`。
//
// ⚠️ **它们必须弱于所有可启动引擎**：这些规则的 `all_required` 一律 false（走打分），
// 而可启动引擎的强命中永远压过打分命中（见 pickBestRule 的 ③）。
// 用户拍板：不做 Windows 兼容层，这类游戏交给 CrossOver
// （2026-11-05：「windows兼容的游戏有CrossOver嘛，不做也可以的」）。
//
// 认出来之后 UI 要做的事：告诉他「这个引擎需要 Windows 兼容层（CrossOver 之类），
// Tsumigeya 不代跑」—— **不是**「不支持」四个字。
// ⚠️ 这些条目的 `name` 会出现在用户眼前的「识别结果」里，所以必须写**用户认得的名字**，
//    不是内部代号。
export interface DetectOnlyEngine {
  /** 内部 id（**永远不会**成为 gameEngine 的值，因为跑不了）。 */
  folder: string
  /** 用户看到的名字。 */
  name: string
  /** 识别规则（打分用，一律 all_required: false）。 */
  autodetect: EngineAutodetect
  /** 为什么跑不了（i18n key），UI 用它解释给用户听。 */
  reasonKey: string
}

export const DETECT_ONLY: readonly DetectOnlyEngine[] = [
  {
    folder: 'unity',
    name: 'Unity',
    autodetect: {
      // Unity 导出物的标志：`UnityPlayer.dll`（Windows）/ `unity default resources`（包里）。
      //
      // ⚠️ **绝不能加 `extensions: ['exe']`**：那会让任何 .exe 都命中 Unity 打分，
      // 于是「一个我们完全不认识的 exe 游戏」被判成 Unity，报「需要 Windows 兼容层」——
      // 而它也许其实是我们认识的某个引擎（这里只是恰好强命中没匹配上）。
      // 实测抓到：加了 exe 规则后，一个只有 readme 的空目录都被判成 Unity。
      // 判据必须**只靠专有文件名**，宁可认不出（返回 null）也不能乱认。
      files: ['UnityPlayer.dll', 'unity default resources'],
      all_required: false
    },
    reasonKey: 'detectOnly.unity'
  },
  {
    folder: 'rpgbakin',
    name: 'RPG Developer Bakin',
    autodetect: {
      // Bakin 官方 FAQ 明写只有 Windows 版（rpgbakin.com/en/faq）。
      // 导出物是 `BakinGame.exe` + `BakinData` 之类，**没有跨平台资源**。
      // 同样不加 exe 扩展名（理由见 unity 的注释）。
      files: ['BakinData'],
      all_required: false
    },
    reasonKey: 'detectOnly.rpgbakin'
  },
  {
    folder: 'wolfrpg',
    name: 'WOLF RPG Editor (ウディタ)',
    autodetect: {
      // ウディタ 的标志是 `Data.wolf`（打包数据）。
      //
      // ⚠️ **不放 `Game.exe`**：那是几乎所有 RPG Maker 系引擎都有的一般文件名，
      // 放进来会让「随便一个 Game.exe」蹭到分。只认 `Data.wolf` 这种专有产物。
      files: ['Data.wolf'],
      all_required: false
    },
    reasonKey: 'detectOnly.wolfrpg'
  }
]

/**
 * ★ 引擎的唯一来源（D60 / D87）。
 *
 * 顺序 = 引擎页的展示顺序。**现在是 8 个**（M6 加了 tyrano/kirikiri，M6.5 加了 nscripter/siglus）。
 *
 * ruffle（Flash）/ wine（Windows）/ macos 不在**这里**，也不是被 `.filter()` 挡掉的 ——
 * 它们在这个代码库里没有任何定义、没有任何下载地址、没有任何名字（有测试扫描源码钉死这条）。
 *
 * ⚠️ 新增引擎时**必须同步**：`launchers/binary-paths.ts` 的 `ENGINE_IDS` 与
 * `launchers/index.ts` 的 `LAUNCHABLE_ENGINES`（两处都有测试核对同源）。
 */
export const ENGINES: readonly EngineDefinition[] = [
  nwjs,
  mkxpz,
  easyrpg,
  renpy,
  tyrano,
  kirikiri,
  nscripter,
  siglus,
  godot
]

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
