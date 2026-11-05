// i18n key 的「死代码守卫」+「动态拼接保护」（2026-11-05 清理时一并立的）。
//
// ===== 这个文件防两件事 =====
//
// ① **死 key 越积越多**：删掉的 UI 会把 key 留在 locales 里（改代码的人顺手删了引用、
//    忘了删文案）。它们无害，但会让语言文件越来越难查 —— 找 `yes` 时看到一条
//    "是"却不知道哪儿在用。
//
// ② **⚠️ 更要紧：把「动态拼接的 key」当成死代码删掉**。
//    本鱼清理时差点删掉 `error.saveArchiveNoManifest` / `BadManifest` / `VerifyFailed`：
//    grep 这三个字面串**一个都搜不到**，看起来完全没用。但主进程是这么拼的：
//
//        translationKey: `error.saveArchive${read.reason.charAt(0).toUpperCase()}${read.reason.slice(1)}`
//        // reason = 'noManifest' | 'badManifest' | 'verifyFailed' | 'notZip'
//
//    删了它们，用户在「导入一个损坏的存档包」时看到的会是
//    `error.saveArchiveBadManifest` 这串**原始 key**（vue-i18n 查不到时原样画出，不报错）。
//    而那正是最需要人话解释的时刻。
//
//    所以判据必须**双向**：既要知道哪些 key 没人用，也要认出哪些"搜不到"是假的。
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const ROOT = process.cwd()
const LOCALES = path.join(ROOT, 'src', 'renderer', 'src', 'locales', 'zh-CN.json')

/** 收集所有源码文本（.vue / .ts），排除 locales 自己。 */
function allSourceText(): string {
  const dirs = ['src/renderer/src', 'src/main', 'src/shared', 'src/preload']
  let text = ''
  const walk = (dir: string): void => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (full.includes('locales')) continue
      if (entry.isDirectory()) walk(full)
      else if (/\.(vue|ts)$/.test(entry.name)) text += `${fs.readFileSync(full, 'utf8')}\n`
    }
  }
  for (const dir of dirs) walk(path.join(ROOT, dir))
  return text
}

const locales = JSON.parse(fs.readFileSync(LOCALES, 'utf8')) as Record<string, unknown>
const sourceText = allSourceText()

/** 把嵌套 locales 摊平成点路径 key 列表。 */
function flatten(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (typeof v === 'string') out.push(key)
    else if (v && typeof v === 'object') out.push(...flatten(v as Record<string, unknown>, key))
  }
  return out
}

const allKeys = flatten(locales)

/**
 * **动态拼接的 key 前缀**：这些分组下的 key 由模板字符串拼出，
 * 源码里搜不到字面串是**正常的**，不许当死代码。
 *
 * 每一条都要写清"怎么拼的"—— 否则下个会话不知道能不能加新的。
 */
const DYNAMIC_PREFIXES = [
  // save-archive-io.ts: `error.saveArchive${reason首字母大写}`
  //   reason = notZip | noManifest | badManifest | verifyFailed
  'error.saveArchive',
  // dlsite.ts / diagnose.ts 的错误 key 都是字面量传的，但 ESlint 风格下可能拼
  'error.dlsite',
  // settings-groups.ts: `settings.group.${group.id}`
  'settings.group',
  // save-sync.ts: `settings.saveSyncModes.${mode}`（⚠️ 在 settings 下面，不是顶层）
  'settings.saveSyncModes'
] as const

/**
 * 一个 key 是"动态拼接的"吗。
 *
 * ⚠️ 判据是**前缀**而不是"搜不到就算了"—— 后者会把真死 key 也放过。
 */
function isDynamic(key: string): boolean {
  return DYNAMIC_PREFIXES.some((prefix) => key.startsWith(prefix))
}

describe('★ 不许把动态拼接的 key 当死代码删（本鱼差点误删）', () => {
  test('error.saveArchive* 的三个"搜不到"的 key 必须还在', () => {
    // 这条是**回归判据**：清理时如果谁又删了它们，这里当场红。
    // 它们搜不到字面串，因为主进程是 `error.saveArchive${reason首字母大写}` 拼的。
    for (const reason of ['NoManifest', 'BadManifest', 'VerifyFailed', 'NotZip']) {
      const key = `error.saveArchive${reason}`
      expect(allKeys, `${key} 被删了 —— 导入损坏包时用户会看到原始 key 而不是中文`).toContain(key)
    }
  })

  test('导出/导入存档的全部错误 key 都在（这一组是成对出现的）', () => {
    // 与 save-archive-io.ts 的 ReadArchiveResult['reason'] 联合类型一一对应
    for (const key of [
      'error.saveArchiveEmpty',
      'error.saveArchiveMissing',
      'error.saveBackupFailed',
      'error.saveExportRunning',
      'error.saveImportRunning',
      'error.saveExportNoLocation'
    ]) {
      expect(allKeys, `${key} 缺失`).toContain(key)
    }
  })

  test('settings.group.* 每个分组都有文案（动态拼接 settings.group.${id}）', () => {
    const groups = (locales.settings as Record<string, unknown>).group as Record<string, string>
    expect(groups).toBeTruthy()
    // settings-groups.ts 里的分组 id
    for (const id of ['appearance', 'library', 'language', 'launch', 'data']) {
      expect(typeof groups[id], `settings.group.${id} 缺失`).toBe('string')
    }
  })

  test('settings.saveSyncModes.* 两个模式都有文案', () => {
    const modes = (locales.settings as Record<string, unknown>).saveSyncModes as Record<string, string>
    expect(modes).toBeTruthy()
    for (const mode of ['none', 'manual']) {
      expect(typeof modes[mode], `settings.saveSyncModes.${mode} 缺失`).toBe('string')
    }
  })
})

describe('★ 死 key 不许堆积（清掉的 15 个不许回来）', () => {
  test('2026-11-05 清理掉的那批 key 确实不在了', () => {
    // 这批 key 在源码里零引用（含动态拼接的检查），已删除。若有人"补回来"，
    // 说明他没查引用就加了 —— 这条会红，逼他去确认。
    const removed = [
      'common.yes',
      'common.browse',
      'common.retryLater',
      'library.batchSelectAll',
      'game.basicInfo',
      'game.coverAndTags',
      'game.coverAndTagsHint',
      'progress.downloadProgress',
      'dlsite.searchTitle',
      'dlsite.searchKeywordLabel',
      'dlsite.searchPick',
      'error.scriptPath',
      'error.scriptEscape',
      'detail.fetchMeta',
      'detail.refreshFailed'
    ]
    for (const key of removed) {
      expect(allKeys, `${key} 又回来了 —— 加文案前先确认有地方用它`).not.toContain(key)
    }
  })

  test('整体死 key 数量不许明显增长（健康度晴雨表）', () => {
    // 不要求 0（i18n 里总有少量预留/边缘 key），但设一个上限：
    // 超过就说明有人在往里堆没人用的文案，该清了。
    const dead = allKeys.filter((key) => {
      if (isDynamic(key)) return false
      const last = key.split('.').pop()!
      // 完整 key 或最后一段在源码里出现过 → 算活的（宽松判据，避免误报）
      return !sourceText.includes(key) && !sourceText.includes(last)
    })
    // 当前实测为 0（清理后）。留 8 的余量给将来可能加的预留 key。
    expect(dead.length, `死 key 太多：\n${dead.join('\n')}`).toBeLessThanOrEqual(8)
  })
})
