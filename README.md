# Tsumigeya

macOS 上的 DLsite 游戏启动器——把下载好的游戏文件夹拖进来，自动识别引擎（RPG Maker 2000/2003/XP/VX/VX Ace/MV/MZ、Ren'Py、Flash、通用 Windows 程序等），自动安装对应的原生运行时，一键启动。全中文界面。

> 基于 [Xenolauncher](https://github.com/m5kro/Xenolauncher) 的核心引擎模块系统二次开发，遵循 **GPL-3.0** 开源。

## 支持的引擎

| 引擎 | 运行时 | 识别特征（自动） |
|---|---|---|
| RPG Maker MV / MZ | NW.js | `nw.dll` + `package.json` |
| RPG Maker XP / VX / VX Ace | mkxp-z | `Game.ini` + `System/Graphics/Audio` |
| RPG Maker 2000 / 2003 | EasyRPG Player | `RPG_RT.ldb/.lmt/.ini` |
| Ren'Py | Ren'Py SDK | `renpy/` 目录 |
| Flash | Ruffle | — |
| 通用 Windows 程序 | Wine（beta） | `.exe/.msi/.bat` |
| macOS .app | 原生 | `.app` 包 |

## 开发

```bash
npm install
npm run dev        # 启动开发模式（需要图形界面）
npm test           # 单测（无网络、无 GUI）
npm run build      # 构建
```

- 开发文档 / 多会话协作：见 [AGENTS.md](./AGENTS.md)
- 技术决策：见 [docs/](./docs/)

### 数据目录

- macOS：`~/Library/Application Support/Xenolauncher`（与 Xenolauncher 共享，已装引擎和游戏库直接复用）
- Windows（开发）：`%APPDATA%/tsumigeya`
- 可用环境变量 `TSUMIGEYA_DATA_DIR` 覆盖

### 网络说明

引擎运行时从 GitHub 与各官方源下载。国内网络建议配置系统代理（本应用下载走系统代理）。

## 许可

GPL-3.0（见 [LICENSE](./LICENSE)）。衍生自 [Xenolauncher](https://github.com/m5kro/Xenolauncher)（作者 m5kro）与 [Xenolauncher-Modules](https://github.com/m5kro/Xenolauncher-Modules)，感谢上游的开源工作。
