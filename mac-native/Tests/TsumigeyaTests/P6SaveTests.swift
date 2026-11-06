// 存档位置探测测试。
//
// 对应 Electron 版：`test/save-locate.test.ts`（19 条，其中 4 条是 D85 的核心）
//
// ===== 本文件最重要的两条（D85）=====
//
// ① **作者塞进包里的残留档不能骗过它**（这是那个真 bug 的回归）
// ② **`location: nil`（不知道在哪）与「还没存过档」必须分开**
import Foundation
import Testing

@testable import TsumigeyaCore

// MARK: - nwjs（D85）

@Suite("nwjs 存档位置")
struct NwjsSaveLocateTests {

    /// ⚠️⚠️ **本文件最重要的一条**：`main = www/index.html` 时，
    /// 即使**根目录有残留的 `.rpgsave`**，也必须指向 `www/save`。
    ///
    /// 守的是 2026-11-05 那个真 bug：用户真机上 `苍蓝星/save/` 里有 5 个旧档
    /// （作者打包时塞的，2022 年时间戳），本鱼据此判成「存档在根 save/」——
    /// 后果是**用户真存了档（写到 www/save）之后，界面仍显示别人的旧档**，
    /// 他自己的一个都看不到 → 以为档丢了。
    @Test("main 在 www 时指向 www/save，不看根目录残留")
    func mainInWwwIgnoresRootSaves() {
        let loc = SaveLocate.detect(
            engine: "nwjs",
            wwwSave: DirSnapshot(path: "/games/苍蓝星/www/save", entries: []),   // 空（用户没存过档）
            gameSave: DirSnapshot(
                path: "/games/苍蓝星/save",
                entries: ["file1.rpgsave", "file2.rpgsave", "file3.rpgsave"]),   // ← 残留档！
            packageMain: "www/index.html"
        )
        #expect(loc?.dir == "/games/苍蓝星/www/save",
                "main 在 www 时必须指向 www/save，哪怕根 save/ 里有旧档")
    }

    /// `main` 就在根（`index.html`）→ 存档在根 `save/`。
    @Test("main 在根时指向根 save")
    func mainAtRoot() {
        let loc = SaveLocate.detect(
            engine: "nwjs",
            gameSave: DirSnapshot(path: "/games/MyGame/save", entries: ["file1.rpgsave"]),
            packageMain: "index.html"
        )
        #expect(loc?.dir == "/games/MyGame/save")
    }

    /// `./www/` 前缀也要认（有些 package.json 这么写）。
    @Test("./www 前缀也算 www")
    func dotSlashWww() {
        let loc = SaveLocate.detect(
            engine: "nwjs",
            wwwSave: DirSnapshot(path: "/games/X/www/save", entries: []),
            packageMain: "./www/index.html"
        )
        #expect(loc?.dir == "/games/X/www/save")
    }

    /// ⚠️ **即使 `www/save` 还没创建（entries 为空），也要指向它**。
    ///
    /// 那是「用户还没存过档」—— 与「不知道在哪」是两件事。
    @Test("www/save 不存在也指向它")
    func pointsToMissingWwwSave() {
        // ① 目录成立（但空）
        let loc1 = SaveLocate.detect(
            engine: "nwjs",
            wwwSave: DirSnapshot(path: "/games/苍蓝星/www/save", entries: []),
            packageMain: "www/index.html"
        )
        #expect(loc1?.dir == "/games/苍蓝星/www/save")

        // ② 目录**根本不存在** → 用 gameRoot 拼出完整路径
        //
        // ⚠️ 这条是本鱼改了语义才补上的：第一版在目录不存在时返回字面量
        //    `"www/save"`（相对路径），CLI 实测抓到了（id=1 显示 `目录: www/save`）。
        //    相对路径对 UI 没用 ——「在访达中显示」会指向未知位置。
        let loc2 = SaveLocate.detect(
            engine: "nwjs",
            wwwSave: nil,
            gameSave: nil,
            packageMain: "www/index.html",
            gameRoot: "/games/苍蓝星"
        )
        #expect(loc2 != nil, "读得到 main 就必须给出位置（哪怕是空的）")
        #expect(loc2?.dir == "/games/苍蓝星/www/save", "必须是绝对路径")
        #expect(loc2?.dir.hasPrefix("/") == true, "以 / 开头")
    }

    /// 读不到 `main` 才退回启发式（哪个目录存在就用哪个）。
    @Test("读不到 main 时退回启发式")
    func fallsBackWithoutMain() {
        let loc = SaveLocate.detect(
            engine: "nwjs",
            gameSave: DirSnapshot(path: "/games/Y/save", entries: ["file1.rpgsave"]),
            packageMain: nil
        )
        #expect(loc?.dir == "/games/Y/save")
    }

    /// 什么都没有 → nil（**不知道在哪**）。
    @Test("什么线索都没有时返回 nil")
    func noCluesReturnsNil() {
        let loc = SaveLocate.detect(engine: "nwjs", packageMain: nil)
        #expect(loc == nil)
    }
}

// MARK: - mkxpz

@Suite("mkxpz 存档位置")
struct MkxpzSaveLocateTests {

    /// 约定 ①：`Data/` 里有存档文件 → 用 Data。
    @Test("Data 里有存档")
    func dataHasSaves() {
        let loc = SaveLocate.detect(
            engine: "mkxpz",
            dataDir: DirSnapshot(path: "/games/Ace/Data",
                                 entries: ["Save1.rvdata2", "Scripts.rvdata2"])
        )
        #expect(loc?.dir == "/games/Ace/Data")
    }

    /// 约定 ②：根目录有存档文件 → 用根。
    @Test("根目录有存档")
    func rootHasSaves() {
        let loc = SaveLocate.detect(
            engine: "mkxpz",
            root: DirSnapshot(path: "/games/Ace",
                              entries: ["Save1.rvdata2", "Game.exe"])
        )
        #expect(loc?.dir == "/games/Ace")
    }

    /// 约定 ③：`Save/` 子目录存在就用（哪怕空）。
    @Test("Save 子目录存在就用")
    func saveSubdir() {
        let loc = SaveLocate.detect(
            engine: "mkxpz",
            saveDir: DirSnapshot(path: "/games/Ace/Save", entries: []),
            root: DirSnapshot(path: "/games/Ace", entries: ["Game.exe"])
        )
        #expect(loc?.dir == "/games/Ace/Save")
    }

    /// 优先级：Data > 根 > Save 子目录。
    @Test("优先级 Data > 根 > Save")
    func priority() {
        let loc = SaveLocate.detect(
            engine: "mkxpz",
            dataDir: DirSnapshot(path: "/games/X/Data", entries: ["Save1.rvdata2"]),
            saveDir: DirSnapshot(path: "/games/X/Save", entries: []),
            root: DirSnapshot(path: "/games/X", entries: ["Save2.rvdata2"])
        )
        #expect(loc?.dir == "/games/X/Data", "Data 优先")
    }

    /// ⚠️ VX / XP 的扩展名也要认（不只是 rvdata2）。
    @Test("三种 RGSS 扩展名都认")
    func allRgssExtensions() {
        for ext in ["rvdata2", "rvdata", "rxdata"] {
            let loc = SaveLocate.detect(
                engine: "mkxpz",
                dataDir: DirSnapshot(path: "/games/X/Data", entries: ["Save1.\(ext)"])
            )
            #expect(loc?.dir == "/games/X/Data", "\(ext) 该被认出来")
        }
    }
}

// MARK: - 不猜的引擎

@Suite("不猜位置的引擎")
struct UnknownSaveLocateTests {

    /// ⚠️ Tyrano / 吉里吉里**故意返回 nil**。
    ///
    /// 守的是：它们的存档位置还没实测，而**猜错的代价比「不知道」大得多**
    /// （猜错会让用户看到别人的档，以为自己的丢了 —— D85 的同一个坑）。
    @Test("Tyrano 与吉里吉里返回 nil")
    func unknownEngines() {
        #expect(SaveLocate.detect(engine: "tyrano") == nil)
        #expect(SaveLocate.detect(engine: "kirikiri") == nil)
    }

    /// 陌生引擎也返回 nil（不猜）。
    @Test("陌生引擎返回 nil")
    func unknownEngine() {
        #expect(SaveLocate.detect(engine: "no-such") == nil)
    }
}

// MARK: - 条目分类（D86）

@Suite("存档条目分类")
struct SaveEntriesTests {

    /// ⚠️ **点开头的系统噪音一律跳过**（D86）。
    ///
    /// `._file1.rpgsave` 是 macOS 的 AppleDouble（163 字节元数据镜像）。
    /// 它会**命中**「任意 .rpgsave」的槽判据 → 列表里多一个幽灵存档。
    @Test("点开头文件被跳过")
    func skipsDotFiles() {
        let result = SaveEntries.classify(
            entries: ["file1.rpgsave", "._file1.rpgsave", ".DS_Store", "file2.rpgsave"],
            engine: "nwjs"
        )
        #expect(result.slots == ["file1.rpgsave", "file2.rpgsave"])
        #expect(!result.slots.contains("._file1.rpgsave"))
    }

    /// ⚠️ **先判 config 再判 slot**：
    /// 顺序反了 `config.rpgsave` 会被匹配成槽（用户以为它是第 0 号档）。
    @Test("config 不会被当成槽")
    func configNotSlot() {
        let result = SaveEntries.classify(
            entries: ["file1.rpgsave", "config.rpgsave", "global.rpgsave"],
            engine: "nwjs"
        )
        #expect(result.slots == ["file1.rpgsave"])
        #expect(result.configs.sorted() == ["config.rpgsave", "global.rpgsave"])
    }

    /// ⚠️ **自然排序**：`file10` 必须在 `file2` **后面**。
    /// 字符串排序会让用户的槽顺序乱掉。
    @Test("按数字自然排序")
    func naturalOrdering() {
        let result = SaveEntries.classify(
            entries: ["file10.rpgsave", "file2.rpgsave", "file1.rpgsave"],
            engine: "nwjs"
        )
        #expect(result.slots == ["file1.rpgsave", "file2.rpgsave", "file10.rpgsave"])
    }

    /// 不相关文件被忽略（不是存档数据）。
    @Test("无关文件被忽略")
    func ignoresIrrelevant() {
        let result = SaveEntries.classify(
            entries: ["file1.rpgsave", "readme.txt", "debug.log"],
            engine: "nwjs"
        )
        #expect(result.slots == ["file1.rpgsave"])
        #expect(result.configs.isEmpty)
    }
}

// MARK: - 自然排序（单独测）

@Suite("自然排序")
struct NaturalCompareTests {

    @Test("数字按大小")
    func numeric() {
        #expect(SaveEntries.naturalCompare("file2", "file10"))
        #expect(!SaveEntries.naturalCompare("file10", "file2"))
    }

    @Test("相同则按长度")
    func shorterFirst() {
        #expect(SaveEntries.naturalCompare("a", "aa"))
    }

    @Test("文本按字典序")
    func text() {
        #expect(SaveEntries.naturalCompare("abc", "abd"))
    }
}
