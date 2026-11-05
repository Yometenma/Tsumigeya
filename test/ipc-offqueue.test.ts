// 绕队列名单的「锁死」测试（M2 §9 / AGENTS.md 已知坑倒数第 5 条）。
//
// 为什么值得单独一个文件：只读命令进了队列会重演「启动更新检查堵死队列、界面永远卡住」的老坑。
// 名单是手写的字符串集合，最容易在不经意间被改坏，所以用测试把它钉住。
import { describe, expect, test } from 'vitest'
import { OFF_QUEUE_METHODS } from '../src/main/ipc'

describe('OFF_QUEUE_METHODS', () => {
  test('包含所有已知的只读 / 独立目录写入命令', () => {
    for (const method of [
      'detect',
      'detectFolder',
      'snapshot',
      'versions',
      'dlsiteDetectRJ',
      'dlsiteLookup',
      // M2.5-A：按名字搜索——只读网络、不写盘，但用户点一下就等结果
      'dlsiteSearch',
      // M2.5-C：多语言分组——纯本地计算（只读 games.json + meta），毫秒级
      'languageGroups',
      // M3：启动前诊断——纯本地文件扫描（读 8 字节魔数 / 读 Game.ini / 查目录），
      // 只读不写盘；用户点「启动」就在等它
      'diagnoseGame',
      // M3.5：进程表只在内存里（D50），读它是内存遍历，毫秒级；
      // 详情页一进去就要知道「在不在跑」
      'runningGames'
    ]) {
      expect(OFF_QUEUE_METHODS.has(method)).toBe(true)
    }
  })

  test('写 games.json / library-meta.json 的命令**必须**进队列', () => {
    for (const method of [
      'saveGame',
      'saveSettings',
      'deleteGame',
      'launch',
      'moduleTask',
      'installVersion',
      'removeVersion',
      'saveGameMeta',
      'refreshGameMeta',
      'clearGameMeta',
      // M3：一键修复可能触发 244MB 的 RTP 下载 → 必须排队
      'repairGame',
      // M3.5：关闭游戏要**等**进程退出（SIGTERM→5s→SIGKILL，D52），必须排队
      'stopGame',
      // M4 S3/S4：导出写 zip 到**用户选的任意目录**（不是我们自己的目录），
      // 导入会覆盖游戏目录里的存档文件 → 两条都写盘，必须排队。
      'exportSaves',
      'importSaves'
    ]) {
      expect(OFF_QUEUE_METHODS.has(method)).toBe(false)
    }
  })

  test('长任务（更新检查 / 全量更新）不进「绕队列」名单（它们本来就要排队）', () => {
    // 注意：checkEngineUpdates 是那个「会堵住队列」的元凶，把它加进旁路 = 让它去堵别人，
    // 所以它必须留在队列里，与只读命令排队。
    expect(OFF_QUEUE_METHODS.has('checkEngineUpdates')).toBe(false)
    expect(OFF_QUEUE_METHODS.has('updateAllEngines')).toBe(false)
  })

  test('名单不会意外膨胀（数量与已知命令对齐）', () => {
    // 这条断言的作用：有人偷偷加了命令却没更新这里 → 测试红了，逼他重新想一遍准入标准。
    // 8（M2/M2.5）→ 9（M3 的 diagnoseGame）→ 10（M3.5 的 runningGames）
    // → 11（M4 的 listSaves：纯本地 readdirSync + statSync，毫秒级）
    // 11 保持不变：M4 S3/S4 的 exportSaves / importSaves **写盘**，不进这份名单。
    expect(OFF_QUEUE_METHODS.size).toBe(11)
  })
})
