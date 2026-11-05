// 引擎参数名的中文翻译。
//
// 对应 Electron 版：`src/renderer/src/locales/zh-CN.json` 的 `args.<引擎>.<key>`
// 契约：D62（我们生成的 manifest **刻意不写 labelKey** —— 那是我们自己的字段，
//       上游只认 `label`，写了会污染兼容 schema）
//
// ===== 为什么翻译要单独一层，不能写进 manifest =====
//
// manifest 的 `label` 是**上游字段**，值是英文（`Start in Fullscreen`）。
// 如果我们往 manifest 里写中文，就破坏了与上游的 schema 兼容（D10/D62）。
//
// 所以：manifest 保留英文 `label`（那是数据），**显示时再翻**。
//
// ===== 退化顺序（与 Electron 版一致）=====
//
//   ① `args.<引擎>.<key>` —— 我们的翻译表（本文件）
//   ② manifest 的 `label` —— 英文原值（兜底）
//   ③ 键名本身 —— 最后兜底（绝不能显示空白）
//
// ⚠️ 顺序不能反：先看英文 label 会让少数我们翻过的参数也显示英文。
import Foundation

public enum EngineArgsLabels {

    /// 取一个参数的中文显示名。
    ///
    /// - Parameters:
    ///   - engine: 引擎 folder
    ///   - key: 参数名
    ///   - manifestLabel: manifest 里的英文 `label`（可能为 nil）
    public static func label(
        engine: String, key: String, manifestLabel: String?
    ) -> String {
        // ① 我们的翻译表
        if let translated = table[engine]?[key] { return translated }

        // ② manifest 的英文 label（兜底）
        if let manifestLabel, !manifestLabel.trimmingCharacters(in: .whitespaces).isEmpty {
            return manifestLabel
        }

        // ③ 键名本身（最后兜底 —— 绝不能显示空白）
        return key
    }

    /// 翻译表。
    ///
    /// ⚠️ **与 Electron 版 `zh-CN.json` 的 `args.*` 逐条对齐**。
    ///    加新参数时两边都要加 —— 但**只在这边加**会让 Swift 版有中文、
    ///    Electron 版显示英文（D95 弃用 Electron 后这个问题自然消失）。
    ///
    /// ⚠️ 这里**只翻已经在 manifest 里的参数**。
    ///    `integerScalingActive` / `fixedAspectRatio` 是 D61 砍掉的（参数表单精简），
    ///    但翻译留着 —— 用户在旧数据里可能还有这些值，展示时不该显示英文。
    static let table: [String: [String: String]] = [
        "nwjs": [
            "version": "NW.js 版本",
            "fullscreen": "全屏启动",
        ],
        "mkxpz": [
            "rgssVersion": "RGSS 版本",
            "fullscreen": "全屏启动",
            "vsync": "垂直同步",
            "RTP": "额外 RTP / 归档目录",
            "windowTitle": "窗口标题",
            "fontSub": "字体替换（原名>新名）",
            "defScreenW": "窗口宽度（0 = 自动）",
            "defScreenH": "窗口高度（0 = 自动）",
            "preloadScript": "预载 Ruby 脚本",
            "midiSoundFont": "MIDI 音源（SF2）",
            // D61 已从表单砍掉，但旧数据里可能有 —— 翻译留着
            "integerScalingActive": "整数缩放（像素最清晰）",
            "fixedAspectRatio": "固定宽高比",
        ],
        "easyrpg": [
            "encoding": "文本编码",
            "language": "语言",
            "rtpPath": "RTP 目录",
            "soundfontPath": "音源路径",
            "vsync": "垂直同步",
            "showFps": "显示帧率",
            "fullscreen": "全屏启动",
            "scaling": "缩放方式",
        ],
        "renpy": [
            "savedir": "存档目录",
            "command": "启动命令",
        ],
        // 下面 5 个引擎的参数表只有 `fullscreen`（D61 精简后）
        "tyrano": ["fullscreen": "全屏启动"],
        "kirikiri": ["fullscreen": "全屏启动"],
        "nscripter": ["fullscreen": "全屏启动"],
        "siglus": ["fullscreen": "全屏启动"],
        "godot": ["fullscreen": "全屏启动"],
    ]
}
