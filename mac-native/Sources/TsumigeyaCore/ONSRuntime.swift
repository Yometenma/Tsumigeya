// NScripter（ONS）运行时的附属判据：参数 schema、脚本编码探测、字体回落。
//
// ===== 为什么单独一篇 =====
//
// 这三个判据都是「启不启动得了」的问题，不是「启动得好不好看」，而且都要读游戏目录里的文件：
//
//   · 脚本编码错了 → 满屏乱码，用户会以为是乱码 bug，其实是没传 `--enc`
//   · 没有字体    → 一个字都画不出来（ONScripter 必须有 default.ttf）
//
// 它们曾经都没有：`genericPlan` 只传游戏目录，靠 cwd 蒙对。换 ONSyuri 后
// **默认编码是 GBK**，不显式传 `--enc` 就会把日文原版跑成乱码 —— 所以必须自己判，
// 不能指望上游默认值。
import Foundation

public enum ONSRuntime {

    /// manifest 里的参数 schema（安装引擎时写进 `modules/nscripter/manifest.json`）。
    ///
    /// ⚠️ ONSyuri 的 `--enc` 默认是 **gbk**，而 DLsite 上占多数的是日文原版（SJIS）。
    ///    所以 `encoding` 的默认值必须是 **auto**（探测），不能是任何一个具体编码。
    public static let argumentSchema: [String: JSONValue] = [
        "encoding": .object([
            "type": .string("dropdown"),
            "label": .string("Script Encoding"),
            "default": .string("auto"),
        ]),
        "fullscreen": .object([
            "type": .string("boolean"),
            "label": .string("Start in Fullscreen"),
            "default": .bool(false),
        ]),
    ]

    /// 脚本编码选项。
    public enum Encoding: String, Sendable, CaseIterable {
        case auto
        case sjis
        case gbk
        case utf8

        /// 传给 `--enc:` 的值。
        ///
        /// ⚠️ `auto` 没有对应值 —— 它必须在构造启动参数前被**解析成具体编码**，
        ///    否则 ONSyuri 会用它自己的默认值（gbk），日文原版直接乱码。
        public var flag: String? {
            self == .auto ? nil : rawValue
        }
    }

    /// 把 `gameArgs.encoding` 解析成真正要传的编码。
    ///
    /// - Returns: 永远返回具体编码（不会是 `.auto`）
    public static func resolveEncoding(
        gameArgs: [String: JSONValue],
        folder: String,
        readFile: (String) -> Data?
    ) -> Encoding {
        let raw = gameArgs["encoding"]?.stringValue ?? ""
        if let explicit = Encoding(rawValue: raw), let flag = explicit.flag {
            return Encoding(rawValue: flag) ?? .sjis
        }
        return detectEncoding(folder: folder, readFile: readFile)
    }

    /// 探测游戏目录里的脚本编码。
    ///
    /// 判据顺序：
    ///   ① 明文脚本（`0.txt` / `00.txt`）能按 UTF-8 严格解码且含非 ASCII → utf8
    ///   ② 出现 **GBK 独有的首字节区**（0xB0–0xDF）→ gbk
    ///      SJIS 的首字节只有 0x81–0x9F / 0xE0–0xEF，0xB0–0xDF 在 SJIS 里是非法首字节，
    ///      所以这条信号是硬的（中文汉字区的高频字节正好落在里面）。
    ///   ③ 其余（含纯 ASCII）→ sjis
    ///
    /// ⚠️ **加密脚本也要看**：`nscript.dat` 是 ONS 的 mode 1（每字节 XOR 0x84），
    ///    解出来与明文脚本是同一套字节。只看明文的话，纯 `nscript.dat` 的作品
    ///    一律回落 sjis —— 汉化版（GBK）就会满屏乱码（实测：某 GBK 汉化作品
    ///    菜单是图片所以看着正常，正文全是乱码）。
    public static func detectEncoding(
        folder: String, readFile: (String) -> Data?
    ) -> Encoding {
        for name in ["0.txt", "00.txt"] {
            let path = (folder as NSString).appendingPathComponent(name)
            guard let data = readFile(path), !data.isEmpty else { continue }
            return judge(data)
        }

        // 没有明文脚本时看加密的 nscript.dat（解密后同样按上面的判据）
        let locked = (folder as NSString).appendingPathComponent("nscript.dat")
        if let data = readFile(locked), !data.isEmpty {
            return judge(decryptNscript(data))
        }
        return .sjis
    }

    /// `nscript.dat` 的解密：ONS 的 encrypt_mode 1 就是每个字节 XOR 0x84。
    ///
    /// 只看前 64KB 就够判断编码；9MB 级的脚本不必整个搬进内存。
    static func decryptNscript(_ data: Data, limit: Int = 64 * 1024) -> Data {
        Data(data.prefix(limit).map { $0 ^ 0x84 })
    }

    /// 对一段脚本文本字节做编码判断（明文与解密后共用）。
    static func judge(_ data: Data) -> Encoding {
        let head = data.prefix(64 * 1024)
        if hasNonASCII(head), String(data: head, encoding: .utf8) != nil {
            return .utf8
        }
        if hasGBKOnlyLeadByte(head) {
            return .gbk
        }
        return .sjis
    }

    static func hasNonASCII(_ data: Data) -> Bool {
        data.contains { $0 >= 0x80 }
    }

    /// 是否出现 GBK 独有的双字节首字节（0xB0–0xDF）。
    ///
    /// 只看「高位字节后面还跟着一个字节」的位置，避免把行尾的孤立字节当信号。
    static func hasGBKOnlyLeadByte(_ data: Data) -> Bool {
        let bytes = [UInt8](data)
        var i = 0
        while i + 1 < bytes.count {
            let b = bytes[i]
            if b < 0x80 {
                i += 1
                continue
            }
            if (0xB0...0xDF).contains(b) && (0xA1...0xFE).contains(bytes[i + 1]) {
                return true
            }
            i += 2
        }
        return false
    }

    /// 游戏的 prefer 字体文件：先看游戏目录自带的 `default.ttf`，没有就给一个系统字体。
    ///
    /// ⚠️ 不传 `-f` 时 ONScripter 会在 **cwd** 找 `default.ttf`；cwd 就是游戏目录，
    ///    所以自带字体的游戏不需要这一项。没有自带字体的中文作品，缺了它就是「无字」。
    ///
    /// ⚠️ **`.ttf` 优先于 `.ttc`**：macOS 上实测 `PingFang.ttc` 会让 SDL_ttf 报
    ///    `can't open font file` 然后直接退出；`Supplemental/Arial Unicode.ttf`
    ///    能正常渲染日文假名与汉字。所以候选表把 ttf 排前面。
    ///
    /// - Returns: `nil` = 让运行时自己按 cwd 找（游戏自带 `default.ttf`）
    public static func fontArgument(
        folder: String, fileExists: (String) -> Bool
    ) -> String? {
        let bundled = (folder as NSString).appendingPathComponent("default.ttf")
        if fileExists(bundled) { return nil }

        for candidate in [
            "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
            "/System/Library/Fonts/Supplemental/Songti.ttc",
            "/System/Library/Fonts/Hiragino Sans GB.ttc",
        ] where fileExists(candidate) {
            return candidate
        }
        return nil
    }
}
