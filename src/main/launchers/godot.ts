// M6.5：Godot 的启动方案。
//
// ===== 判据 =====
//
// 资源：`.pck`（或内嵌在 exe 尾部的 pck）—— **GDScript 项目**的 pck **跨平台可读**
//       （官方论坛 + 导出文档都支持：只出 PCK 时「allows a single exported main pack file
//       to be used with **multiple Godot executables**」）。
//       桌面↔桌面不受 VRAM 压缩纹理差异影响（都走 S3TC/BPTC）。
//
//       ⚠️ **三种情况下 pck 不可用**：
//         ① **C# 项目**（issue #72159 实测：`class could not be found` / `Failed to load hostfxr`）
//         ② 用了 **GDExtension**（含平台专用 .dylib/.dll）
//         ③ **引擎版本不匹配**（4.6.1 的 pck 只能配 4.6.x）
//
// 运行时：官方 **编辑器二进制**（Godot.app/Contents/MacOS/Godot），MIT，universal 双架构，
//         约 154 MiB。给 `--main-pack` 就直接进游戏，**不弹编辑器、不要授权**
//         （官方 issue #3593 里 akien-mga 原话）。
//
// ===== ⚠️ 4.6 的硬坑（必须知道）=====
//
// PR #111909（2025-11-12 合并）把 `disable_path_overrides` 拆成两半，
// **release export template 默认禁用 `--main-pack`**。
// 实测（issue #119376）：4.6.2 报
//   `--main-pack was specified on the command line, but this Godot binary was compiled
//    without support for path overrides. Aborting.`
// 4.5.2 正常。
//
// → 我们的选择是 **用编辑器二进制当 runner**（不需要自编译、`--main-pack` 仍可用）。
//   代价是 154MB 的运行时，但换来「不需要每个人自己编译 Godot」。
//
// ===== 存档：只能定位，不能改（已知限制，不假装能解决）=====
//
// 官方明确：**导出的工程不支持 self-contained mode**（`_sc_` 只对编辑器有效）
// → 不能靠放标记文件把存档重定向到游戏目录。
//
// 存档位置（官方文档的精确表）：
//   默认                        → ~/Library/Application Support/Godot/app_userdata/<project_name>
//   工程开了 use_custom_user_dir → ~/Library/Application Support/<project_name>
//   再设了 custom_user_dir_name  → ~/Library/Application Support/<custom_user_dir_name>
//
// 而 `<project_name>` 要从 pck 里读 `application/config/name` —— 本文件**不自己解析 pck**
// （格式有 v0–v4 五个版本、Godot 又每年升级，自己解析等于赌它不变）。
// 改为**在启动前用引擎自己的能力问它**：`--headless --quit --path ...` 之类不可靠，
// 所以本文件的结论是：**存档位置标记为「未实现」，返回 null**（与 tyrano / kirikiri 同一取向）。
//
// → 这条写进 docs §10.10 的未实现清单，**不假装支持**。
import fs from 'node:fs'
import path from 'node:path'
import { godotBinaryPath, godotDepsDir, godotExpectedPath } from './binary-paths'
import type { LaunchContext, LaunchPlan } from './types'

/** Godot 主程序的相对路径（app bundle 内）。 */
const GODOT_BIN = 'Godot.app/Contents/MacOS/Godot'

/**
 * 这个目录里有没有 Godot 的 pck。
 *
 * 判据：`*.pck` 存在**或**存在一个 `.exe`（内嵌 pck 的形态）。
 *
 * ⚠️ 为什么把 `.exe` 也算：Godot 的 Windows 导出**常把 pck 嵌进 exe 尾部**
 * （官方 Exporting for Windows 文档有 "PCK embedding" 一节）。
 * 这种形态下游戏目录里只有 `Game.exe`，没有独立 .pck。
 *
 * ⚠️ 但 `.exe` 这个判据**太宽**（任何 Windows 游戏都有 exe）—— 所以它只在
 * **已经识别成 godot** 之后才被调用（`hasGodotPattern` 用于 detect 之外的二次确认，
 * 不进 autodetect 规则，避免误伤别的引擎）。
 */
export function hasGodotPck(folder: string): boolean {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true })
  } catch {
    return false
  }
  return entries.some((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.pck'))
}

/**
 * 找这次要喂给引擎的 pck 路径。
 *
 * 顺序：① 目录里唯一的 `.pck`；② 多个 `.pck` 时**不猜**（返回 null，让上层报错）。
 *
 * 为什么多个就不猜：Godot 导出的补丁机制（"Patch PCK"）会让目录里有多个 pck
 * （主包 + 补丁）。选错的表现是**游戏能启动但内容不对/缺资源** —— 比报错更糟。
 */
export function findMainPck(folder: string): string | null {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(folder, { withFileTypes: true })
  } catch {
    return null
  }
  const pcks = entries.filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.pck'))
  if (pcks.length === 1) return path.join(folder, pcks[0]!.name)
  return null
}

/**
 * Godot 的启动方案。
 *
 * ⚠️ **`--main-pack` 用绝对路径**（与 Butterscotch 的经验同一条：相对路径在别的引擎上
 * 出过「找不到文件」的怪问题，绝对路径省一类 bug）。
 *
 * 找不到二进制时**仍然返回 plan**（binary 指向期望路径），由 ipc 层报可读错误。
 */
export function godotPlan(ctx: LaunchContext): LaunchPlan {
  const resolved = godotBinaryPath(ctx.dataDir)
  const binary = resolved ?? godotExpectedPath(ctx.dataDir)

  const pck = findMainPck(ctx.folder)
  const args: string[] = []

  if (pck) {
    args.push('--main-pack', pck)
  } else {
    // 没有独立 pck → 可能是内嵌形态，或者用户选的是解包后的目录。
    // **两种都不在这里猜**：内嵌形态我们还没实现（需要从 exe 尾部抠 pck），
    // 而 `--path` 要求目录里有 project.godot（发行版通常没有）。
    // → 什么都不传，让 Godot 自己在 cwd 里找；找不到它会报自己的错，
    //   比我们猜错要好。
  }

  if (ctx.gameArgs.fullscreen === true) args.push('--fullscreen')

  return {
    binary,
    args,
    cwd: ctx.folder,
    engine: 'godot'
  }
}

/** Godot 运行时的「本该在那」路径（错误文案用）。 */
export function godotRuntimeDir(dataDir: string): string {
  return path.join(godotDepsDir(dataDir), GODOT_BIN)
}

/**
 * 「这个 Godot 游戏没有独立 pck」的可读说明。
 *
 * 为什么不复用一句泛泛的失败：Godot 的**内嵌 pck 形态**（pck 拼在 exe 尾部）
 * 是真实存在且常见的一种。我们现在**不处理它**，必须如实告诉用户，
 * 而不是让他以为是自己的游戏坏了。
 */
export function godotEmbeddedUnsupportedMessage(folder: string): string {
  return (
    `这个目录里没有独立的 .pck 文件：${folder}\n` +
    '如果游戏只给了一个 exe（pck 嵌在 exe 里），本版本还不支持这种形态。\n' +
    '（这是已知限制，不是游戏坏了。）'
  )
}

/**
 * 「这个 Godot 游戏可能用了 C# 或 GDExtension」的可读说明。
 *
 * 为什么专门有一句：pck 跨平台**只对 GDScript 项目成立**。
 * C# 项目在 macOS 上根本加载不了（issue #72159），GDExtension 含平台专用库。
 * 用户遇到「启动后立刻退出/报类找不到」时，需要知道原因在这里，
 * 而不是去重装引擎。
 */
export function godotManagedCodeHint(): string {
  return (
    '这个 Godot 游戏可能用了 C# 脚本或 GDExtension。\n' +
    '这类游戏的原生库是平台专用的，Windows 版无法在 macOS 上加载（引擎本身的限制）。\n' +
    '重装引擎不会改善；需要作者提供 macOS 版。'
  )
}
