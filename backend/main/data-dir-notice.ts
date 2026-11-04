// M4.0 S6.5：数据目录切换的**一次性**说明（D58）。
//
// 背景（用户 2026-11-04 拍板）：数据目录从别的程序共用的那个换成 `Tsumigeya`，
// 且**不做迁移**——老用户升级上来会看到「引擎未安装、游戏库空白」。
//
// 绝不能静默：那会让用户以为「我的游戏全丢了」。所以首次运行给一条中文说明，
// 但**只给一次**（用 settings 里的标记落盘），不能每次启动都弹。
//
// 为什么抽成独立模块而不是写在 ipc.ts：
//   · 判断逻辑（该不该提示）是纯函数，能毫秒级单测；写在 IPC 里只能靠端到端探针
//   · 「只提示一次」这种标记位最容易被写错成「每次启动都弹」，必须有测试钉死
//
// ⚠️ 这里**不探测旧目录**（不 fs.existsSync 任何别的路径）：D58 明确不做迁移，
// 一旦代码里开始探测旧目录，下个会话很容易顺手加「搬一下」。
import fs from 'node:fs'
import path from 'node:path'

/** settings 里的标记键名（单数、明确，避免与业务开关混淆）。 */
export const DATA_DIR_NOTICE_KEY = 'dataDirNoticeShown'

export interface DataDirNoticeInput {
  /** 数据目录（`<dataDir>/modules`、`<dataDir>/games.json` 都在它下面）。 */
  dataDir: string
  /** 现有设置（读 `dataDirNoticeShown`）。 */
  settings: Record<string, unknown>
  /** 平台（只有 mac 会切换过数据目录，其它平台不提示）。 */
  platform?: NodeJS.Platform
}

/**
 * 这次启动该不该给「数据目录已切换」的说明。
 *
 * 三个条件全满足才提示：
 *   1. 平台是 darwin（Windows 上数据目录一直在 `%APPDATA%/tsumigeya`，没变过）
 *   2. 还没提示过（settings 里没有标记）
 *   3. **确实是空的**（没有 modules 且没有 games.json）——一个已经有数据的目录
 *      不需要这句说明（那是「正常使用的老用户」，不是「刚升级上来的人」）
 *
 * 第 3 条很重要：如果只按「没提示过」判断，那么一个已经正常用起来、但从没触发过
 * 这条提示的用户（例如全新安装后玩了两天）也会看到一句莫名其妙的
 * 「数据目录已切换」，而他从没切换过。
 */
export function shouldShowDataDirNotice(input: DataDirNoticeInput): boolean {
  const platform = input.platform ?? process.platform
  if (platform !== 'darwin') return false
  if (input.settings[DATA_DIR_NOTICE_KEY] === true) return false
  return isEmptyDataDir(input.dataDir)
}

/** 目录里既没有 modules 也没有 games.json（= 看起来是「什么都还没装」）。 */
export function isEmptyDataDir(dataDir: string): boolean {
  if (exists(path.join(dataDir, 'modules'))) return false
  if (exists(path.join(dataDir, 'games.json'))) return false
  return true
}

/** 存在性检查（不抛；任何类型都算存在）。 */
function exists(target: string): boolean {
  try {
    fs.statSync(target)
    return true
  } catch {
    return false
  }
}

/** 提示文案（中文，info 级，**不是**错误）。放这里便于单测断言措辞要点。 */
export const DATA_DIR_NOTICE_TEXT =
  '数据目录已切换到 Tsumigeya。\n' +
  '引擎与游戏库需要重新添加（旧目录里的数据不会被读取，也不会被删除）。\n' +
  '如果之前用过旧版本，可能需要在「引擎管理」里重新安装引擎。'
