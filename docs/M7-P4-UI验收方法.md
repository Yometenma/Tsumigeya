# M7-P4 UI 验收方法（Tsumigeya 原生版）

> **给接手的 AI**：改完 SwiftUI 代码后，**先自己看一眼**，别让用户当人肉 lint。
> 用户 2026-11-06 的原话：「观感相关的东西我之后慢慢微调」——
> 意思是**观感他负责**，但**布局错误（错位/空白/溢出/看不见）必须你自己拦住**。

---

## §1 本机的现实约束（先搞清楚再动手）

| 事实 | 后果 |
|---|---|
| 开发机是 **Windows**，代码在 `D:\YomeXProjects\Tsumigeya` | Swift 只能在 Mac 上编译 |
| Mac 通过 **SSH** 访问（`ssh yometenma@192.168.1.86`） | 无真实用户会话 |
| **`screencapture` 在 SSH 里恒失败** | `could not create image from display`（需要「屏幕录制」权限） |
| **AppleScript / System Events 恒失败** | `not allowed assistive access`（需要「辅助功能」权限） |
| 但 **`CGWindowListCopyWindowInfo` 可用** | 能查窗口标题与 pid（不需要权限） |

→ 所以**截图必须从 app 内部做**，不能靠系统截图工具。

## §2 三条渲染路径（前两条都失败过，别再走）

### ✗ v1：`ImageRenderer { NavigationSplitView { ... } }`

**症状**：输出**空白 PNG**。

**原因**：`NavigationSplitView` / `ScrollView` / `List` 需要真实的窗口上下文
（NSWindow、NSView 层级、布局系统）。`ImageRenderer` 只做离屏 SwiftUI 布局，拿不到它们。

### ✗ v2：`ImageRenderer` + 扁平化视图（避开 NavigationSplitView）

**症状**：输出一个**巨大的黄色禁止图标**（🚫）。

**这是最坑的一条**：`ImageRenderer` 渲染不了时**不返回 nil**，
它返回那张占位图。于是「用 `nsImage == nil` 判断失败」**判不出来**，
会以为成功、把一张黄图当成果。

→ 教训：**任何「渲染成功」的判据必须看内容，不能只看有没有返回对象。**

### ✅ v3（当前实现）：真开 `NSWindow` + `NSHostingView` + `cacheDisplay`

```
NSHostingView(rootView: view)         ← SwiftUI 视图塞进 AppKit 宿主
  ↓
NSWindow(borderless, 位置在屏幕外 -3000,-3000)
  ↓ window.orderFrontRegardless()     ← 必须真的「上屏」，否则不做完整布局
  ↓ RunLoop 转两圈 + layoutSubtreeIfNeeded()
  ↓
hosting.bitmapImageRepForCachingDisplay(in:)
hosting.cacheDisplay(in:to:)
  ↓
PNG
```

**为什么位置放屏幕外**：`orderFrontRegardless` 会让窗口是真的存在，
但用户在真实机器上看不到（不会闪一下抢焦点）。

**⚠️ 自检是必须的**：`checkBlank()` 采样网格上的像素，
如果全是同一个色就当失败。**这就是 v2 那个黄图的教训换来的防线。**

## §3 怎么用

```bash
# 在 Mac 上
cd ~/Tsumigeya-Native
swift build
.build/debug/Tsumigeya --snapshot /tmp/tsmg-ui
# → 输出 01-root-with-selection.png / 02-root-no-selection.png / 03-detail-<id>.png
```

然后 `scp` 回本地看：

```bash
# 在 Windows 的 Git Bash
scp yometenma@192.168.1.86:/tmp/tsmg-ui/*.png .dev-scratch/ui/
```

⚠️ **`.dev-scratch/` 在 `.gitignore` 里**（渲染产物不入库）。

## §4 ⚠️ 已知限制（别以为看到了全部）

**① `NavigationSplitView` 的侧边栏渲染成白色**

快照里**左侧侧边栏是白的**（不是界面坏了）。原因是离屏 NSWindow
拿不到 `.sidebar` 材质背景（那是 `NSVisualEffectView`，需要真实的窗口材质）。

→ **判据：只看内容区。** 侧边栏的**布局**（行高/缩进/分组）能从图里看，
但**颜色/材质**不能。

**② 暗色模式要强制**

`NSAppearance(named: .darkAqua)` 显式设。SSH 会话下的系统外观可能是亮色，
不强制就渲染出与用户实际看到的不一样的界面。

**③ 渲染 ≠ 观感**

能证明：视图树建起来了 / 布局有内容 / 没有严重错位 / 没有纯色空白。
**不能证明**：渐变好不好看 / 按钮够不够醒目 / 字号合不合适 / 动画手感。

→ 那部分**必须让用户看**。别自作聪明说「我验过了」。

## §5 本鱼这一轮从渲染里抓到的真问题

| # | 问题 | 怎么发现的 |
|---|---|---|
| 1 | 大图渐变有**一条可见的横向分界线** | 用户截图（渲染也看得到，但本鱼当时没渲） |
| 2 | 窗口标题回落成 `Tsumigeya` 而不是「游戏库」 | 用户截图 |
| 3 | 引擎参数值在最右、名在最左，视线横跨全屏 | 用户截图 |
| 4 | 启动按钮看着像**禁用状态** | 用户截图 |
| 5 | `ImageRenderer` 失败返回黄图而非 nil | **本鱼自己跑快照才发现** |
| 6 | `ImageRenderer` 渲染不出 NavigationSplitView | 同上 |
| 7 | 信号量阻塞主线程导致**死锁**（零输出挂住） | 同上 |

**3 条是本鱼自查发现的，4 条要靠用户。**
这说明快照能挡掉一部分（布局/空白/死锁），但**观感与「看着像不像能点」还是要人眼**。

---

## §6 第二次栽在同一个坑上：判据「看起来在验，实际验不过」

**v3 的自检 `checkBlank()` 第一版：**

```swift
if dr + dg + db > 0.06 { distinct += 1 }     // 阈值 0.06
return distinct == 0                          // 一个点就算有内容
```

**结果**：设置页渲染成**全白**，自检却报 ✅。

**根因**：纯白背景上抗锯齿文字的边缘产生了极小的色差（< 0.06），
采样网格恰好扫到那些边缘，于是 `distinct > 0` → 判「有内容」。

**修法**：阈值收紧到 `0.02`，且要求 **至少 3 个**明显不同的采样点。

### ⚠️ 这是本鱼第二次栽在「判据太松」

| 次数 | 错法 | 症状 |
|---|---|---|
| 第 1 次 | `ImageRenderer` 渲染失败返回**占位图**（不是 nil） | 把黄图当成功 |
| 第 2 次 | 自检阈值 0.06 + 「一个点就算有内容」 | 把全白当成功 |

**共同点：判据本身有假通过路径。** 一个坏判据比没有判据更糟 ——
它给你「验过了」的错觉，于是你不会再去看。

**下次写判据时的自检问题**（问自己这三个）：
1. **失败时**，这个判据会不会也返回「通过」？
2. 阈值是**拍脑袋的**还是**量出来的**？（本鱼两次都是拍脑袋）
3. 有没有**阴性对照**？（造一个明确失败样本，证明判据会红）

### ⚠️ 顺带记一个 SwiftUI 布局坑

**`ScrollView` + `GroupBox` 在离屏 NSWindow 里会布局成 0 高度** → 全白。

改成 `Form` + `.formStyle(.grouped)` 正常。
（`Form` 自带滚动与分组语义，也更接近 mac 系统设置的样子。）

**但这不代表真实窗口里 `ScrollView` 也有问题** —— 本鱼**没法在 SSH 会话里确认**
（那里没有真实用户会话）。所以选了「不依赖滚动容器」的写法：
宁可写得保守，也不要赌「真窗口里应该没事」——用户上次就报过「引擎页有问题」。
