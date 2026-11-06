# Tsumigeya

macOS 上的日式同人游戏启动器。把下载好的游戏文件夹拖进来，自动识别引擎、自动安装运行时、一键启动。全中文界面。

主要面向 DLsite 上的 RPG Maker 系作品，**用你自己的 Mac 原生跑起来**——
不需要虚拟机，不需要双系统。

## 功能

- **游戏库**：列表 / 卡片两种视图、搜索、自定义分类
- **自动识别引擎**：按文件结构判断，不用手选
- **一键安装运行时**：缺失的引擎直接在应用内下载安装
- **DLsite 元数据**：按 RJ 号或作品名获取标题、社团、封面、简介
  - 路径里能识别到 RJ 就自动用 RJ；识别不到就按名字搜索让你挑
  - 也可以手动输入 RJ
- **存档管理**：查看、导出为 zip、导入还原（换机或重装时用）
- **进程管理**：显示运行状态、一键关闭

## 支持的引擎

| 引擎 | 运行时 | 状态 |
|---|---|---|
| RPG Maker MV / MZ | NW.js | ✅ 已验 |
| RPG Maker XP / VX / VX Ace | mkxp-z | ✅ 已验 |
| RPG Maker 2000 / 2003 | EasyRPG | ✅ |
| Ren'Py | Ren'Py SDK | ✅ |
| TyranoScript | NW.js（复用） | ⚠️ 启动参数未在真机验过 |
| 吉里吉里（KAG） | krkrsdl2 | ⚠️ 上游声明不支持商业游戏 |
| NScripter | ONScripter | ⚠️ 未验 |
| Siglus | siglus_rs | ⚠️ 未验 |
| Godot | Godot 编辑器 | ⚠️ 未验；存档位置未实现 |

**只识别不启动**（需要 Windows 兼容层，如 CrossOver）：Unity / RPG Developer Bakin / WOLF RPG Editor。

## 安装

从 Releases 下载 `.dmg`，拖进「应用程序」。

⚠️ **首次打开会被 Gatekeeper 拦**（本应用未公证 —— 没有 Apple Developer 账号）。
绕过方式：

- **右键点图标 →「打开」→ 弹窗里再点「打开」**（一次性，之后双击就正常）
- 或命令行：`xattr -dr com.apple.quarantine /Applications/Tsumigeya.app`

## 数据目录

```
~/Library/Application Support/Tsumigeya/
```

包含游戏库、引擎运行时、DLsite 缓存。**删除这个目录等于重置应用**
（游戏本体和存档不受影响，它们在游戏自己的目录里）。

## 常见问题

**引擎下载失败 / 转圈不动**
应用下载走系统代理。若浏览器能上网但应用不能，检查系统代理设置。

**游戏启动后黑屏或闪退**
常见原因是缺 RTP（运行时素材包）。到「引擎」页检查运行时是否装好。

**游戏是加密的（`.rgss3a` 等归档）**
这类需要先解包才能运行。本应用不做（涉及第三方工具与授权问题）。

**存档在哪里 / 怎么换电脑**
详情页的「存档」区块能看到实际位置；「导出」打成 zip，在新机器上「导入」即可。

**DLsite 元数据抓不到**
先看路径里有没有 RJ 号（如 `RJ294126`）；没有的话用「按名字搜索」，
或者手动输入 RJ（在 DLsite 作品页地址里找 `product_id/RJ…`）。

## 开发

**技术栈：Swift 6.2 + SwiftUI**（SwiftPM 三 target）。

```bash
cd mac-native
swift build
swift test        # 全部测试
swift run tsumigeya-cli
```

⚠️ **只能在 macOS 上编译**（Windows 上无法构建 SwiftUI）。

- 协作与交接文档：[AGENTS.md](./AGENTS.md)
- UI 验收方法：[docs/UI验收方法.md](./docs/UI验收方法.md)
- 打包与分发：[docs/打包与分发.md](./docs/打包与分发.md)

## 历史

早期版本（v0.x–v1.1）是 Electron + Vue 实现，2026-11 全部重写为 SwiftUI 原生。
旧代码已从仓库移除，**历史保留在 git log 里**。

## 许可

GPL-3.0，见 [LICENSE](./LICENSE)。
