// 引擎页的数据层：每个引擎的运行时状态。
//
// 对应 Electron 版：`pages/EnginesPage.vue` 的数据部分 + `engines/registry.ts` 的 warning 逻辑
// 契约：D60（清单自维护）/ D88（只认不跑）/ D90（吉里吉里标实验性）/ D91（9 个引擎）
//
// ===== 这张表要回答用户三个问题 =====
//
//   ① 这个引擎**装了没有**？（已装 / 可安装）
//   ② 装了的话，**运行时在不在**？（目录在但二进制缺 = 装坏了，得重装）
//   ③ 能不能跑？（可启动 / 只识别 / 上游限制）
//
// ===== ⚠️ 「目录存在」不等于「装好了」 =====
//
// 这是 Electron 版踩过的坑：下载中断会留下**半截目录**（目录建了、二进制没解出来）。
// 如果只看 `modules/<引擎>/` 存不存在，就会显示「已装」，而点启动发现跑不了。
//
// 本文件的判据是 **`BinaryPaths.binary(for:...)` 能不能返回一个真实存在的路径**。
import Foundation

public enum EngineStatus {

    /// 一个引擎在页面上的状态。
    public struct Entry: Sendable, Identifiable {
        public var id: String { definition.folder }
        public let definition: EngineDefinition

        /// 运行时是否可用（**二进制真的能找到**，不是「目录存在」）。
        public let installed: Bool
        /// 二进制路径（`installed == false` 时为 nil）。
        public let binaryPath: String?
        /// 需要在页面上显示的警告。
        public let warning: Warning?

        public init(
            definition: EngineDefinition, installed: Bool,
            binaryPath: String?, warning: Warning?
        ) {
            self.definition = definition
            self.installed = installed
            self.binaryPath = binaryPath
            self.warning = warning
        }
    }

    /// ⚠️ 两种警告**语义完全不同**，不能合并成一个「警告」：
    ///
    ///   · `unverified` —— **我们的问题**：这个引擎还没在任何真实游戏上验证过启动
    ///     （D91 的 4 个新引擎：tyrano / nscripter / siglus / godot）
    ///   · `upstreamGate` —— **上游的问题**：运行时作者自己声明不支持跑商业游戏
    ///     （吉里吉里 krkrsdl2，D90）
    ///
    /// 把两者写成同一句「可能有问题」会让用户分不清「要不要试」还是「根本别指望」。
    public enum Warning: Sendable, Equatable {
        /// 我们的引擎还没在真实游戏上验证过。
        case unverified
        /// 上游明确声明不支持（如实转达，**不替用户挡**，D90）。
        case upstreamGate(reason: String)
    }

    /// 扫描所有引擎的状态。
    ///
    /// - Parameter dataDir: 数据目录
    public static func scan(
        dataDir: String,
        fileManager: FileManager = .default,
        fileExists: (String) -> Bool = { FileManager.default.fileExists(atPath: $0) },
        listDir: (String) -> [String] = { dir in
            (try? FileManager.default.contentsOfDirectory(atPath: dir)) ?? []
        }
    ) -> [Entry] {
        EngineRegistry.all.map { definition in
            var version = ""
            if definition.folder == "nwjs" || definition.folder == "tyrano" {
                version = NwjsVersion.resolve(dataDir: dataDir, current: nil, fileManager: fileManager) ?? ""
            }

            let binary = BinaryPaths.binary(
                for: definition.folder, dataDir: dataDir,
                version: version, arch: Arch.current().rawValue,
                fileExists: fileExists, listDir: listDir)

            return Entry(
                definition: definition,
                installed: binary != nil,
                binaryPath: binary,
                warning: warningFor(definition)
            )
        }
    }

    /// 这个引擎该显示什么警告。
    ///
    /// ⚠️ 判据是**引擎定义里的显式标记**，不是「名字里带什么」：
    ///    `launchable == false` → D88 的只识别引擎
    ///    `detectOnlyReasonKey` → 那条理由的 key
    ///    `experimental` → D90 的上游限制
    private static func warningFor(_ definition: EngineDefinition) -> Warning? {
        // 只识别引擎（D88）
        if !definition.launchable {
            return .upstreamGate(reason: definition.detectOnlyReasonKey ?? "detectOnly")
        }

        // 吉里吉里（D90）：上游 krkrsdl2 官方页明写「不支持跑未修改的商业游戏」
        //
        // ⚠️ 我们是**如实转达**，不替用户挡 —— 它并不会真的拦住。
        //    所以文案要说清「这是上游的立场，不是我们的限制」。
        if definition.folder == "kirikiri" {
            return .upstreamGate(
                reason: "krkrsdl2 作者声明：不支持用本运行时跑未修改的商业游戏（建议用 Wine / GameNative）。"
                    + "这只是上游立场，实际通常能跑。")
        }

        // D91 的四个新引擎：**还没有任何真实游戏样本验证过启动**
        //
        // ⚠️ 这条是**诚实的自我披露**，不是「可能坏了」。
        //    它们的路径是从真下载包解压看结构来的（P3），
        //    但**启动参数**沿用的是通用约定，没在真实游戏上验过。
        if ["tyrano", "nscripter", "siglus", "godot"].contains(definition.folder) {
            return .unverified
        }

        return nil
    }

    /// 已装数量（引擎页标题用）。
    public static func installedCount(_ entries: [Entry]) -> Int {
        entries.filter(\.installed).count
    }

    /// 可装数量（**排除只识别引擎** —— 那些没有运行时可装）。
    ///
    /// ⚠️ 这个判据很关键：把只识别引擎算进「全部安装」，
    ///    会让用户点了「全部安装」却发现某个引擎什么都没发生（D60 的教训）。
    public static func installableCount(_ entries: [Entry]) -> Int {
        entries.filter { !$0.installed && $0.definition.launchable }.count
    }
}
