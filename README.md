# Tsumigeya

macOS 上的日式同人游戏启动器。把下载好的游戏文件夹拖进来，自动识别引擎、自动安装运行时、一键启动。全中文界面。

主要面向 DLsite 上的 RPG Maker 系作品。

## 功能

- **游戏库**：封面墙、搜索、自定义分类、批量管理
- **自动识别引擎**：按文件结构判断，不用手选
- **一键安装运行时**：缺失的引擎直接在应用内下载安装
- **DLsite 元数据**：按 RJ 号或作品名自动获取标题、社团、封面、发售日
- **启动前诊断**：缺 RTP、缺运行时、加密归档等问题会提前告知并给出修复建议
- **进程管理**：显示运行状态、一键关闭、累计游玩时长
- **存档管理**：查看、导出为 zip、导入还原（换机或重装时用）

## 支持的引擎

| 引擎 | 运行时 | 识别特征 |
|---|---|---|
| RPG Maker MV / MZ | NW.js | `package.json` / `www/` |
| RPG Maker XP / VX / VX Ace | mkxp-z | `Game.ini` + `Data/` |
| RPG Maker 2000 / 2003 | EasyRPG Player | `RPG_RT.ldb` |
| Ren'Py | Ren'Py SDK | `renpy/` 目录 |

> 仅支持以上四种。Flash（Ruffle）、Wine、原生 `.app` 不支持。

## 下载安装

到 **[Releases](https://github.com/Yometenma/Tsumigeya/releases)** 下载最新的 dmg：

- **Apple Silicon**（M1/M2/M3…）→ 文件名带 `arm64`
- **Intel** → 文件名不带架构后缀

打开 dmg，把 Tsumigeya 拖进「应用程序」文件夹。

### 首次打开

应用没有 Apple 开发者签名，macOS 首次会阻止打开。任选其一：

**方式一（推荐）**：在「应用程序」里**右键**点 Tsumigeya → **打开** → 弹窗里再点一次「打开」。

**方式二**：终端执行

```bash
xattr -dr com.apple.quarantine /Applications/Tsumigeya.app
```

之后正常双击即可，不会再拦。这是 macOS 对所有未签名应用的标准行为，不影响任何功能。

## 数据存放位置

```
~/Library/Application Support/Tsumigeya/
```

包括游戏库、引擎运行时、DLsite 缓存、存档导出记录。**删除这个目录等于重置应用**（游戏本体和存档不受影响，它们在游戏自己的目录里）。

## 常见问题

**引擎下载失败 / 转圈不动**
应用下载走系统代理。若浏览器能上网但应用不能，检查系统代理设置。

**游戏启动后黑屏或闪退**
详情页的「启动诊断」会给出原因。常见是缺 RTP——按提示一键补装。

**游戏是加密的（`.rgss3a` 等归档）**
这类需要先解包才能运行。应用会提示但不会自动处理（涉及第三方工具与授权问题）。

**存档在哪里 / 怎么换电脑**
详情页的「存档」区块能看到实际位置；「导出」按钮打成一个 zip，在新机器上「导入」即可。

## 开发

```bash
npm install
npm run dev        # 开发模式（需要图形界面）
npm test           # 单测（不依赖网络与 GUI）
npm run build      # 构建
```

- 协作与交接文档：[AGENTS.md](./AGENTS.md)
- 各里程碑实现细节：[docs/](./docs/)

Windows 上可以开发和跑测试，但打包出的 mac 包只有 macOS 能运行。

## 许可

GPL-3.0，见 [LICENSE](./LICENSE)。

早期版本曾复用 [Xenolauncher](https://github.com/m5kro/Xenolauncher)（作者 m5kro）的模块系统代码，
该部分已于 v0.5.0 完全移除（现为独立实现）。历史沿革记录在
[resources/core/FORK-NOTES.md](./resources/core/FORK-NOTES.md)。
