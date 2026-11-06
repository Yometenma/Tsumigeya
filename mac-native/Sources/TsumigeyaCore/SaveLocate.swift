// 存档位置探测（**纯函数，唯一入口**）。
//
// 对应 Electron 版：`src/shared/save-locate.ts`（400 行 / 19 条单测）
// 契约：M4 S1，D85（nwjs 的存档位置由 package.json 的 main 决定）/ D86（点开头文件跳过）
//
// ===== 这个文件存在的唯一理由：D85 =====
//
// ⚠️ **绝不按「哪个目录有 .rpgsave」判存档位置**。
//
// 用户真机实测（2026-11-05）：`苍蓝星/save/` 里有 5 个 `.rpgsave`，
// 本鱼据此断言「MV 也可能把存档放根 save/」——**完全错了**。
//
// 核实事实：
//   · `save/` 目录**出生时间 = 解压那一刻**（不是玩的时候）
//   · 里面文件的时间戳是 **2022 年**
//   · `debug.log` 是 **2021 年**
//   · 而 `main = www/index.html`
//
// → 那几个是**作者打包时塞进去的残留档**，游戏运行时根本不读它们。
//
// **错的代价比「空列表」大得多**：
//   空列表 = 只是没有（用户去玩到存档点就有了）
//   错的列表 = 用户真存了档（写到 www/save）之后，界面仍显示别人的 2022 年旧档，
//              他自己的一个都看不到 —— **他会以为档丢了**。
//
// 正确判据：MV 的 `StorageManager.localFileDirectoryPath()` =
//            `dirname(process.mainModule.filename) + '/save'`。
// 而 `main` 决定后者是 `www/` 还是根目录 → **读 `package.json` 的 `main`，不看目录内容**。
import Foundation

// MARK: - 目录快照

/// 一个目录的静态快照（探测前由 IO 层产出）。
///
/// ⚠️ 为什么用快照而不是让纯函数去读盘：
///    纯函数才能单测「布局 A 该指向哪」，而不用真建一堆目录。
public struct DirSnapshot: Sendable, Equatable {
    public let path: String
    public let entries: [String]

    public init(path: String, entries: [String]) {
        self.path = path
        self.entries = entries
    }

    /// 这个目录里是否有某个文件（忽略子目录 —— 存档都是文件）。
    public func has(_ name: String) -> Bool {
        entries.contains(name)
    }
}

// MARK: - 位置

/// 存档位置。
public struct SaveLocation: Sendable, Equatable {
    /// 目录绝对路径。
    public let dir: String

    public init(dir: String) {
        self.dir = dir
    }
}

// MARK: - 探测

public enum SaveLocate {

    /// 探测存档位置。
    ///
    /// - Parameters:
    ///   - engine: 引擎 folder 名
    ///   - wwwSave: `<游戏>/www/save`
    ///   - gameSave: `<游戏>/save`
    ///   - dataDir: `<游戏>/Data`
    ///   - saveDir: `<游戏>/Save`
    ///   - root: `<游戏>` 本身
    ///   - external: Ren'Py 专用的外部目录
    ///   - packageMain: `<游戏>/package.json` 的 `main` 字段（原样，**只有 nwjs 用得到**）
    ///   - gameRoot: 游戏根目录（**用于在目标目录还不存在时拼出完整路径**）
    ///
    /// - Returns: 存档位置；`nil` = **不知道在哪**（与「还没存过档」是两件事，见 D85）
    public static func detect(
        engine: String,
        wwwSave: DirSnapshot? = nil,
        gameSave: DirSnapshot? = nil,
        dataDir: DirSnapshot? = nil,
        saveDir: DirSnapshot? = nil,
        root: DirSnapshot? = nil,
        external: DirSnapshot? = nil,
        packageMain: String? = nil,
        gameRoot: String? = nil
    ) -> SaveLocation? {
        switch engine {
        case "nwjs":
            // ⚠️ 传 gameRoot：目标目录可能还不存在（用户没存过档），
            //    那时也要拼出**完整路径**（不能是「www/save」这种相对的）。
            return detectNwjs(
                wwwSave: wwwSave, gameSave: gameSave,
                packageMain: packageMain, gameRoot: gameRoot)
        case "mkxpz":
            return detectRgss(
                root: root, data: dataDir, saveDir: saveDir, gameRoot: gameRoot)
        case "easyrpg":
            return detectEasyrpg(saveDir)
        case "renpy":
            return detectRenpy(external)

        // ⚠️ **这两个引擎故意返回 nil（不知道在哪）**
        //
        // 它们的存档位置**还没在真机上实测**，而猜错的代价比「不知道」大得多：
        //   · 「不知道」→ UI 显示 unknown 态，用户去排障，可接受
        //   · 「猜错了」→ 用户看到别人的残留档或一个空目录，以为自己的档丢了
        //                  —— 这正是 D85 那个 bug 的同一个坑
        //
        // 业界惯例是 `<游戏>/savedata/`（吉里吉里）与 `<游戏>/save/`（Tyrano），
        // 但**未经实测不写进来**。
        case "tyrano", "kirikiri":
            return nil

        default:
            return nil
        }
    }

    // MARK: - nwjs（D85 的核心）

    /// NW.js（RPG Maker MV / MZ）的存档位置。
    ///
    /// **判据 = `package.json` 的 `main`**，不是目录内容。
    ///
    /// | `main` 的值 | 存档目录 |
    /// |---|---|
    /// | `www/index.html`（或 `www/` 开头） | `<游戏>/www/save` |
    /// | `index.html`（在根） | `<游戏>/save` |
    /// | 读不到 `main` | 退回「哪个目录存在就用哪个」的启发式 |
    ///
    /// ⚠️ **为什么读不到 main 才退回启发式**：读不到是「这个包不规范」，
    ///    那时只能猜；而能读到 `main` 时**必须听它的**（它是运行时的真实依据）。
    private static func detectNwjs(
        wwwSave: DirSnapshot?, gameSave: DirSnapshot?,
        packageMain: String?, gameRoot: String?
    ) -> SaveLocation? {
        // ① main 在 www/ 下 → www/save
        if let main = packageMain, !main.isEmpty {
            let normalized = main.replacingOccurrences(of: "\\", with: "/")
            let inWww = normalized.hasPrefix("www/") || normalized.hasPrefix("./www/")
            if inWww {
                // ⚠️ **即使 www/save 还不存在也要指向它** ——
                //    那是「用户还没存过档」（empty），不是「不知道在哪」（unknown）。
                //
                // ⚠️ **但路径必须是完整的绝对路径**。
                //    本鱼第一版在目录不存在时返回了字面量 `"www/save"` ——
                //    CLI 实测抓到了（id=1 显示 `目录: www/save`）。
                //    相对路径对 UI 没用：「在访达中显示」会指向一个未知位置。
                //
                //    所以有快照就用它；没有就用 `gameRoot` 拼出来。
                let dir = wwwSave?.path
                    ?? gameRoot.map { ($0 as NSString).appendingPathComponent("www/save") }
                guard let dir else { return nil }
                return SaveLocation(dir: dir)
            }
            // main 在根 → save/
            let dir = gameSave?.path
                ?? gameRoot.map { ($0 as NSString).appendingPathComponent("save") }
            guard let dir else { return nil }
            return SaveLocation(dir: dir)
        }

        if let wwwSave, !wwwSave.entries.isEmpty { return SaveLocation(dir: wwwSave.path) }
        if let gameSave, !gameSave.entries.isEmpty { return SaveLocation(dir: gameSave.path) }
        return nil
    }

    // MARK: - mkxpz（RGSS）

    /// mkxp-z（XP / VX / VX Ace）的存档位置。
    ///
    /// 这是**按约定枚举**（不等真实样本，但每条都是工程惯例）：
    ///   ① `Data/Save*`（有些游戏把存档放 Data 里）
    ///   ② 根目录 `Save*`
    ///   ③ `Save/` 子目录
    ///
    /// ⚠️ **三条都要查**：不同的游戏打包习惯不同，只查一种会漏。
    ///
    /// ⚠️ **三个都没有时返回 nil，不猜**。
    ///
    ///    本鱼实测（2026-11-06）：用户的 `傭兵の冒険` 三个都没有
    ///    （根目录只有 Audio/Data/Fonts/Game.exe/...，`Data/` 里全是 `.rvdata2` 素材，
    ///    **没有 Save 开头的**）。这说明**用户还没在那个游戏里存过档**。
    ///
    ///    那时该返回什么？
    ///      · 返回 nil（不知道在哪）→ UI 显示 unknown → 用户以为程序找不到档
    ///      · 猜一个 `Save/` → 但那个目录不存在，且不知道游戏会不会自己创建
    ///
    ///    本鱼选 **nil**，理由是「宁可说不知道，也不要指向一个可能永远不会被创建的目录」
    ///    —— 后者会让用户点「在访达中显示」时找不到东西，比 unknown 更困惑。
    ///
    ///    ⚠️ 但如果将来实测出「MKXP-Z 的存档一定落在某个固定位置」（比如
    ///    它会自己在根目录创建 `Save1.rvdata2`），那时这里就该改成
    ///    「固定指向那个位置」——**改了要留实测记录**。
    private static func detectRgss(
        root: DirSnapshot?, data: DirSnapshot?, saveDir: DirSnapshot?,
        gameRoot: String?
    ) -> SaveLocation? {
        // ① Data 里有存档文件
        if let data, data.entries.contains(where: { isSaveFile($0) }) {
            return SaveLocation(dir: data.path)
        }
        // ② 根目录有存档文件
        if let root, root.entries.contains(where: { isSaveFile($0) }) {
            return SaveLocation(dir: root.path)
        }
        // ③ Save/ 子目录（存在就用，哪怕空 —— 那是「还没存档」）
        if let saveDir { return SaveLocation(dir: saveDir.path) }

        // ④ 都没有 → nil（见上）
        _ = gameRoot
        return nil
    }

    /// 是不是 RGSS 的存档文件。
    ///
    /// 判据：`Save<N>.rvdata2`（VX Ace）/ `Save<N>.rvdata`（VX）/ `Save<N>.rxdata`（XP）
    /// 以及不带数字的文件（有些游戏直接叫 `Save.rvdata2`）。
    private static func isSaveFile(_ name: String) -> Bool {
        let lower = name.lowercased()
        guard lower.hasPrefix("save") else { return false }
        return lower.hasSuffix(".rvdata2") || lower.hasSuffix(".rvdata")
            || lower.hasSuffix(".rxdata")
    }

    // MARK: - easyrpg

    /// EasyRPG（RPG Maker 2000 / 2003）的存档位置。
    ///
    /// 约定：`<游戏>/Save/`（大写 S）。
    private static func detectEasyrpg(_ saveDir: DirSnapshot?) -> SaveLocation? {
        guard let saveDir else { return nil }
        return SaveLocation(dir: saveDir.path)
    }

    // MARK: - renpy

    /// Ren'Py 的存档位置。
    ///
    /// ⚠️ Ren'Py 的存档**不在游戏目录里**，它在 `~/Library/RenPy/<游戏名>/`。
    ///    这是它的默认 `savedir` 行为（除非游戏改了 `config.save_directory`）。
    ///
    /// 判据：外部目录存在就用；不存在时返回 nil（**不猜**）。
    private static func detectRenpy(_ external: DirSnapshot?) -> SaveLocation? {
        guard let external else { return nil }
        return SaveLocation(dir: external.path)
    }
}

// MARK: - 条目分类（D86）

public enum SaveEntries {

    /// 把一个目录的条目分成「存档槽」与「配置文件」两类。
    ///
    /// ⚠️ **先判 config，再判 slot**：
    ///    槽判据是「任意 `.rpgsave` 但排除配置名」（黑名单式）。
    ///    如果先判 slot，`config.rpgsave` 会被匹配成槽 —— 用户以为它是第 0 号档。
    ///    顺序写反**不会报错**，只会让 config 混进存档列表。
    ///
    /// ⚠️ **点开头的系统噪音一律跳过**（D86）：
    ///    `._file1.rpgsave` 是 macOS 的 AppleDouble（163 字节元数据镜像）。
    ///    但 MV 的槽判据是「任意 `.rpgsave` 但排除 config/global」，
    ///    所以它会**命中槽判据** → 列表里多出一个幽灵存档，
    ///    点「在访达中显示」指向的只是一份元数据。
    public static func classify(
        entries: [String],
        engine: String
    ) -> (slots: [String], configs: [String]) {
        let (slotPattern, configPattern) = patterns(for: engine)
        var slots: [String] = []
        var configs: [String] = []

        for name in entries {
            // ① 点开头一律跳过（D86）
            if name.hasPrefix(".") { continue }
            // ② 先判 config
            if configPattern(name) {
                configs.append(name)
            } else if slotPattern(name) {
                slots.append(name)
            }
            // 都不匹配 → 忽略（不是存档数据）
        }

        // 按文件名**自然排序**（`file1` / `file2` / `file10` 要按数字，不是字典序）
        return (slots.sorted(by: naturalCompare), configs.sorted(by: naturalCompare))
    }

    /// 各引擎的槽 / 配置判据。
    private static func patterns(
        for engine: String
    ) -> (slot: (String) -> Bool, config: (String) -> Bool) {
        switch engine {
        case "nwjs":
            // MV/MZ 的存档：`file<N>.rpgsave`；配置：`config.rpgsave` / `global.rpgsave`
            return (
                slot: { name in
                    let lower = name.lowercased()
                    return lower.hasSuffix(".rpgsave") && !lower.hasPrefix("config")
                        && !lower.hasPrefix("global")
                },
                config: { name in
                    let lower = name.lowercased()
                    return lower.hasSuffix(".rpgsave")
                        && (lower.hasPrefix("config") || lower.hasPrefix("global"))
                }
            )
        case "mkxpz":
            // RGSS 三种扩展名
            return (
                slot: { SaveLocate.isSaveFilePublic($0) },
                config: { name in
                    let lower = name.lowercased()
                    return lower.hasSuffix(".ini") || lower.hasSuffix(".dat")
                }
            )
        default:
            return (slot: { _ in false }, config: { _ in false })
        }
    }

    /// 自然排序：把数字段当数字比。
    ///
    /// ⚠️ 为什么不能用字符串排序：`file10` 会排在 `file2` **前面**
    ///    （"1" < "2"），用户看到的槽顺序是乱的。
    public static func naturalCompare(_ a: String, _ b: String) -> Bool {
        let ta = tokenize(a)
        let tb = tokenize(b)
        for i in 0..<min(ta.count, tb.count) {
            switch (ta[i], tb[i]) {
            case (.number(let x), .number(let y)):
                if x != y { return x < y }
            case (.text(let x), .text(let y)):
                if x != y { return x < y }
            case (.number, .text):
                // 数字排在文本前（`file2` 在 `fileA` 前）
                return true
            case (.text, .number):
                return false
            }
        }
        return ta.count < tb.count
    }

    private enum Token: Equatable {
        case number(Int)
        case text(String)
    }

    private static func tokenize(_ s: String) -> [Token] {
        var out: [Token] = []
        var buf = ""
        var isDigit = false
        for ch in s.lowercased() {
            let d = ch.isNumber
            if d != isDigit, !buf.isEmpty {
                out.append(d ? .text(buf) : .number(Int(buf) ?? 0))
                buf = ""
            }
            isDigit = d
            buf.append(ch)
        }
        if !buf.isEmpty {
            out.append(isDigit ? .number(Int(buf) ?? 0) : .text(buf))
        }
        return out
    }
}

extension SaveLocate {
    /// 供 `SaveEntries` 调用的公开版本（同一个判据，别写两份）。
    public static func isSaveFilePublic(_ name: String) -> Bool {
        isSaveFile(name)
    }
}
