// 不能注入运行时的引擎，用文件读写代替游戏内面板。
//
// NScripter（ONSyuri）与 RPG Maker 2000／2003（EasyRPG）都是 C++ 解释器，
// 没有可注入的 JS／Ruby 层，改文件是唯一手段。其余引擎走游戏内注入面板，
// 不走这里。
import Foundation
import TsumigeyaCore

/// 一个可离线改写的目标。
enum OfflineTarget: Equatable {
    /// NScripter 脚本（`0.txt` / `00.txt` / `nscript.dat`）。
    case nscripter(URL)
    /// RPG Maker 2000／2003 数据库（`RPG_RT.ldb`），只读。
    case rpg2000(URL)

    /// 引擎是否只能靠改文件。
    static func supports(_ engine: String) -> Bool {
        ["nscripter", "easyrpg"].contains(WineRuntime.canonicalEngine(engine))
    }

    /// 在游戏目录里找目标。找不到返回 nil（这个作品还没解压出脚本或数据库）。
    static func detect(engine: String, gamePath: String) -> OfflineTarget? {
        let root = DetectPath.gameDirForFiles(gamePath)
        switch WineRuntime.canonicalEngine(engine) {
        case "nscripter":
            return OfflineScript.locate(in: root).map { .nscripter($0) }
        case "easyrpg":
            let url = URL(fileURLWithPath: root).appendingPathComponent("RPG_RT.ldb")
            return FileManager.default.fileExists(atPath: url.path) ? .rpg2000(url) : nil
        default:
            return nil
        }
    }

    var url: URL {
        switch self {
        case .nscripter(let url), .rpg2000(let url): return url
        }
    }
    var fileName: String { url.lastPathComponent }
}

@MainActor
final class OfflineSession: ObservableObject {
    let game: GameRecord
    private weak var store: AppStore?
    private let dataDirectory: String

    @Published private(set) var target: OfflineTarget?
    @Published private(set) var scriptEntries: [OfflineScriptEntry] = []
    @Published private(set) var databaseTexts: [RPG2000Text] = []
    @Published var busy = false
    @Published var message = ""
    @Published var error: String?

    init(game: GameRecord, store: AppStore) {
        self.game = game; self.store = store
        dataDirectory = store.dataDir
    }

    var isCurrent: Bool {
        guard let store else { return false }
        return store.dataDir == dataDirectory
            && store.game(id: game.id)?.gamePath == game.gamePath
            && store.game(id: game.id)?.gameEngine == game.gameEngine
    }

    func reload() {
        busy = false; error = nil; message = ""
        target = nil; scriptEntries = []; databaseTexts = []
        do {
            guard let found = OfflineTarget.detect(engine: game.gameEngine, gamePath: game.gamePath) else {
                throw AssistanceError.invalid(L("这个目录里没有可改写的脚本或数据库。"))
            }
            target = found
            switch found {
            case .nscripter(let url):
                let document = try OfflineScript.load(url)
                scriptEntries = document.entries
                message = String(format: L("已识别 %@，编码 %@，共 %@ 行可翻译正文。"),
                                 "\(url.lastPathComponent)", "\(document.encoding.rawValue)", "\(document.entries.count)")
            case .rpg2000(let url):
                databaseTexts = try RPG2000Database.texts(url)
                message = String(format: L("已识别 %@，共 %@ 条名称与说明（只读）。"),
                                 "\(url.lastPathComponent)", "\(databaseTexts.count)")
            }
        } catch let failure {
            error = failure.localizedDescription
        }
    }

    /// 把字典里的译文写回脚本。返回实际替换的行数。
    @discardableResult
    func apply(_ translations: [String: String]) -> Int {
        guard !busy, let target else { return 0 }
        busy = true; error = nil
        defer { busy = false }
        do {
            switch target {
            case .nscripter(let url):
                let document = try OfflineScript.load(url)
                let result = try OfflineScript.write(translations, to: document)
                guard result.replaced > 0 else {
                    message = L("字典里没有能匹配上的正文，未改动文件。")
                    return 0
                }
                message = String(format: L("已替换 %@ 行，写回编码 %@。备份在同目录 .tsumigeya-bak。"),
                                 "\(result.replaced)", "\(result.encoding.rawValue)")
                if result.encoding != document.encoding {
                    message += "\n" + String(format: L("⚠️ 原编码装不下这些译文，已改用 %@；请把引擎参数里的脚本编码改成同一项，否则游戏内仍是乱码。"),
                                              "\(result.encoding.rawValue)")
                }
                return result.replaced
            case .rpg2000:
                error = L("RPG Maker 2000／2003 数据库当前只读，不能写回。")
                return 0
            }
        } catch let failure {
            error = failure.localizedDescription
            return 0
        }
    }

    /// 导出成待译字典（值为空串）。
    func exportDictionary() -> Data? {
        do {
            switch target {
            case .nscripter:
                var dictionary: [String: String] = [:]
                for entry in scriptEntries { dictionary[entry.source] = "" }
                return try JSONEncoder().encode(dictionary)
            case .rpg2000:
                var dictionary: [String: String] = [:]
                for row in databaseTexts {
                    if !row.name.isEmpty { dictionary[row.name] = "" }
                    if !row.description.isEmpty { dictionary[row.description] = "" }
                }
                return try JSONEncoder().encode(dictionary)
            case nil:
                return nil
            }
        } catch {
            self.error = error.localizedDescription
            return nil
        }
    }
}
