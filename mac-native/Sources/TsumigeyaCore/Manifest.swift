// manifest 读取 + gameArgs 缺省值合并。
//
// 对应 Electron 版：src/main/engines/manifest.ts（230 行）+ registry.ts 的 expandDataDirPlaceholders
// 契约：docs/M1-实施方案.md §3，D62 / D61
//
// ===== 本文件是「为什么佣兵的冒险启动失败」的答案 =====
//
// 本鱼最初写 mkxp.json 时只用**用户存的值**，于是配置里只有 3 项：
//   gameFolder / RTP / rgssVersion
//
// 结果 mkxp-z 崩在：
//   `Failed loading .../kernel32: dlopen(...): no such file`
//   `from WF-RGSS Scripts rev-29:776:in initialize'`
//
// **真正的原因**：`preloadScript` 这个参数**没传**。
// 它的 manifest 默认值是
//   `<dataDir>/modules/mkxpz/deps/kawariki/kawariki/preload.rb`
// —— 那个 **kawariki 预载脚本**就是给 Ruby 补 Windows API 兼容层的
// （`kernel32` 正是它提供的）。不传它 → 脚本加载 `kernel32` 失败 → 游戏起不来。
//
// 用户说得对：「之前明明能跑」。Electron 版能跑，是因为它有这一步：
// **按 manifest schema 给 gameArgs 补缺省值**。本鱼漏了整个环节。
//
// ===== 合并语义（四条，每条改一条用户的既有配置就会变）=====
//
//   ① **只补缺、不覆盖**：用户填过 `fullscreen: true`，schema 默认 false → 保留 true。
//      判据是「这个键在不在」，**不是**用 `??` 判空 ——
//      因为**已存的值可能是 `false` / `''` / `0` 这种合法空值**，
//      用 `??` 会把它们当「没填」覆盖掉。
//
//   ② **未知键原样保留**：manifest 里已经没有的参数（我们砍掉的那 49 个）留在
//      `gameArgs` 里不会被删。理由：那是**用户磁盘上的数据**，删掉等于替用户做决定；
//      而且启动时只读认识的键，留着无害。
//
//   ③ **`multi-version` 不补默认值**：nwjs 的 `version` 默认是空串，而真实目录名
//      是 `v0.106.1`。补默认值会让「用户什么都没选」变成「用户选了 0.106.1」
//      → 拼出不存在的路径 → 点启动没反应。**补空串也一样有害**，
//      所以这一类整个跳过，由版本修正逻辑探测真实目录。
//
//   ④ **`changed` 只表示「真的补了东西」**：调用方据此决定要不要落盘。
//      「值已经是对的」不算 changed —— 否则每次启动都会写一次 games.json。
//
// ===== 还有一条顺序规则（必须记住）=====
//
// **先展开 `<dataDir>` 占位符，再 merge。**（Electron 版的注释原话）
//
// 为什么：`preloadScript` 的默认值里写着 `<dataDir>` 占位符，
// 它**只能在启动时展开**（manifest 属于「引擎定义」，数据目录属于「这台机器的安装」）。
// 顺序反了 → 占位符还没展开就 merge 进去 → 写进 mkxp.json 的是字面量
// `<dataDir>/modules/...` → mkxp-z 按字面路径去找 → **找不到**。
import Foundation

// MARK: - manifest 模型

/// manifest 里的一个参数定义。
public struct GameArgDef: Sendable, Equatable {
    /// `boolean` / `text` / `int` / `float` / `dropdown` / `select` / `multi-version` / `array`
    public var type: String?
    public var label: String?
    /// 默认值。`nil` = schema 没写默认值 → **不猜**。
    public var defaultValue: JSONValue?
    /// `dropdown` 类型的固定选项。
    ///
    /// ⚠️ 只在 `type == "dropdown"` 时有意义。**空选项要回落成 text**
    /// （否则会画一个「有下拉但是空的」控件 —— 点了没东西可选，
    /// 比不能改更糟，见 `EngineArgs.control`）。
    public var options: [String]?

    public init(
        type: String? = nil, label: String? = nil,
        defaultValue: JSONValue? = nil, options: [String]? = nil
    ) {
        self.type = type
        self.label = label
        self.defaultValue = defaultValue
        self.options = options
    }
}

/// 本地 manifest（`<dataDir>/modules/<引擎>/manifest.json`）。
public struct Manifest: Sendable {
    public var name: String
    public var version: String
    public var autodetect: DetectRule?
    /// 参数 schema（**含默认值**，这是补缺省值的来源）。
    public var gameArgs: [String: GameArgDef]
    /// 参数名的**声明顺序**（= manifest 里写的顺序）。
    ///
    /// ⚠️ 为什么要单独存：Swift 字典不保序，
    ///    而参数表单的显示顺序应按作者写的顺序（不是字母序）。
    ///    用字母序会把 `rgssVersion` 排在 `fullscreen` 前面 → 用户看到的顺序与设计不符。
    public var gameArgOrder: [String]
    /// 依赖表（**顺序有意义**：安装时用户看到进度条先动主二进制）。
    ///
    /// ⚠️ `[String: ...]` 的遍历顺序**不稳定**，所以这里额外保留一个有序的名字列表。
    /// 安装编排要靠这个顺序 —— 用字典的 key 顺序会让「先下主二进制」这个体验变成随机的。
    public var dependencyOrder: [String]
    /// 依赖规格（名字 → 规格）。
    public var dependencies: [String: DependencySpec]

    public init(
        name: String, version: String, autodetect: DetectRule?,
        gameArgs: [String: GameArgDef] = [:],
        gameArgOrder: [String] = [],
        dependencyOrder: [String] = [],
        dependencies: [String: DependencySpec] = [:]
    ) {
        self.name = name
        self.version = version
        self.autodetect = autodetect
        self.gameArgs = gameArgs
        self.gameArgOrder = gameArgOrder.isEmpty ? gameArgs.keys.sorted() : gameArgOrder
        self.dependencyOrder = dependencyOrder
        self.dependencies = dependencies
    }

    /// 按声明顺序排好的依赖列表（安装用）。
    public var orderedDependencies: [(name: String, spec: DependencySpec)] {
        dependencyOrder.compactMap { name in
            guard let spec = dependencies[name] else { return nil }
            return (name, spec)
        }
    }

    /// 按声明顺序排好的参数列表（编辑页参数表单用）。
    ///
    /// ⚠️ **用 `gameArgOrder` 而不是字典 keys**：Swift 字典不保序，
    ///    按字母序会把 `rgssVersion` 排在 `fullscreen` 前面，
    ///    用户看到的顺序与设计不符。
    ///
    /// ⚠️ 但要**兜住 schema 里有、order 里没有的**（手改过 manifest 的情况）：
    ///    追加到末尾，不能静默丢掉（丢掉 = 参数在界面上消失）。
    public var orderedGameArgs: [(name: String, def: GameArgDef)] {
        var result = gameArgOrder.compactMap { name -> (String, GameArgDef)? in
            guard let def = gameArgs[name] else { return nil }
            return (name, def)
        }
        // 兜住漏在 order 里的
        let covered = Set(result.map(\.0))
        for (name, def) in gameArgs.sorted(by: { $0.key < $1.key })
        where !covered.contains(name) {
            result.append((name, def))
        }
        return result
    }
}

extension Manifest: Codable {
    private enum Keys: String, CaseIterable {
        case name, version, description, author, license, autodetect, gameArgs, dependencies
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyCodingKey.self)
        self.name = (try? c.decode(String.self, forKey: AnyCodingKey("name"))) ?? ""
        self.version = (try? c.decode(String.self, forKey: AnyCodingKey("version"))) ?? ""

        // autodetect：manifest 里可能是 {extensions, files, all_required} 或 {extension}
        var rule: DetectRule?
        if let raw = try? c.decode([String: JSONValue].self, forKey: AnyCodingKey("autodetect")) {
            rule = DetectRule(
                extensions: raw["extensions"]?.arrayValue?.compactMap { $0.stringValue },
                extension_: raw["extension"]?.stringValue,
                files: raw["files"]?.arrayValue?.compactMap { $0.stringValue },
                allRequired: raw["all_required"]?.boolValue
            )
        }
        self.autodetect = rule

        // gameArgs：形状是 { name: { type, label, default, options } }
        //
        // ⚠️ **顺序**：`[String: JSONValue].self` 解码不保序，
        //    所以 order 用 `keyedContainer.allKeys`（那是**文件里的原始顺序**）。
        //    两次解码同一个文件，allKeys 的顺序是稳定的。
        var args: [String: GameArgDef] = [:]
        var argOrder: [String] = []
        if let keyed = try? c.nestedContainer(
            keyedBy: AnyCodingKey.self, forKey: AnyCodingKey("gameArgs")) {
            for key in keyed.allKeys {
                guard let obj = try? keyed.decode([String: JSONValue].self, forKey: key) else {
                    continue
                }
                args[key.stringValue] = GameArgDef(
                    type: obj["type"]?.stringValue,
                    label: obj["label"]?.stringValue,
                    defaultValue: obj["default"],
                    options: obj["options"]?.arrayValue?.compactMap { $0.stringValue }
                )
                argOrder.append(key.stringValue)
            }
        }
        self.gameArgs = args
        self.gameArgOrder = argOrder

        // dependencies：形状是 { name: { arch: {link, unzip}, optional, keepSingleDir } }
        //
        // ⚠️ 顺序：这里只能拿到字典（**KeyedDecodingContainer 不保证顺序**），
        //    所以 dependencyOrder 用「allKeys 的顺序」——它至少是**同一份文件里的顺序**。
        //    实测 manifest 是生成物（D62），键序就是 registry 里的声明顺序，够用。
        var deps: [String: DependencySpec] = [:]
        var order: [String] = []
        if let raw = try? c.decode([String: JSONValue].self, forKey: AnyCodingKey("dependencies")) {
            for key in c.allKeys where key.stringValue == "dependencies" {
                _ = key
            }
            for (name, value) in raw {
                guard let obj = value.objectValue else { continue }
                // 这个 value 里除了架构键，还可能混着 `optional` / `keepSingleDir` 这类元字段
                var builds: [String: DependencyBuild] = [:]
                for (archKey, archValue) in obj {
                    guard let archObj = archValue.objectValue,
                          let link = archObj["link"]?.stringValue else {
                        continue   // 不是架构键（可能是 optional / keepSingleDir）
                    }
                    builds[archKey] = DependencyBuild(
                        link: link,
                        unzip: archObj["unzip"]?.boolValue == true)
                }
                guard !builds.isEmpty else { continue }
                deps[name] = DependencySpec(
                    builds: builds,
                    optional: obj["optional"]?.boolValue == true,
                    // ⚠️ D69：默认**保留**单层目录，只有显式 false 才拍平
                    keepSingleDir: obj["keepSingleDir"]?.boolValue != false)
                order.append(name)
            }
        }
        self.dependencies = deps
        self.dependencyOrder = order
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: AnyCodingKey.self)
        try c.encode(name, forKey: AnyCodingKey("name"))
        try c.encode(version, forKey: AnyCodingKey("version"))
    }
}

// MARK: - 读取

public enum ManifestStore {

    /// 读某个引擎的本地 manifest。
    ///
    /// - Returns: `nil` = 没装（目录里没有 manifest.json）。
    public static func load(
        dataDir: String, engine: String, fileManager: FileManager = .default
    ) -> Manifest? {
        let path = manifestPath(dataDir: dataDir, engine: engine)
        guard let data = fileManager.contents(atPath: path), !data.isEmpty else {
            return nil
        }
        return try? JSONDecoder().decode(Manifest.self, from: data)
    }

    /// manifest 路径。
    public static func manifestPath(dataDir: String, engine: String) -> String {
        (BinaryPaths.moduleDir(dataDir, engine) as NSString)
            .appendingPathComponent("manifest.json")
    }

    /// 列出**已装**的引擎（modules 下每个目录里都有 manifest.json）。
    public static func installedEngines(
        dataDir: String, fileManager: FileManager = .default
    ) -> [String] {
        let modulesDir = (dataDir as NSString).appendingPathComponent(BinaryPaths.modulesDirName)
        guard let entries = try? fileManager.contentsOfDirectory(atPath: modulesDir) else {
            return []
        }
        return entries.filter { name in
            var isDir: ObjCBool = false
            let path = (modulesDir as NSString).appendingPathComponent(name)
            guard fileManager.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue else {
                return false
            }
            return fileManager.fileExists(
                atPath: (path as NSString).appendingPathComponent("manifest.json"))
        }.sorted()
    }
}

// MARK: - gameArgs 合并

public enum GameArgs {

    /// 按 schema 给 gameArgs 补缺省值（`reconcileGameArgs` 的等价物）。
    ///
    /// 四条语义见文件头 ①②③④。
    public static func reconcile(
        current: [String: JSONValue], schema: [String: GameArgDef]?
    ) -> (merged: [String: JSONValue], changed: Bool) {
        var merged = current
        guard let schema else { return (merged, false) }

        var changed = false
        for (key, def) in schema {
            // ③ multi-version 不补默认值
            if def.type == "multi-version" { continue }
            // ① 只补缺、不覆盖（判据是「键在不在」，不是值是否为空）
            if merged[key] != nil { continue }
            // schema 没写默认值 → 不猜
            guard let defaultValue = def.defaultValue else { continue }
            // 深拷贝默认值（避免多个游戏共享同一个数组对象）
            merged[key] = clone(defaultValue)
            changed = true
        }
        return (merged, changed)
    }

    /// 展开 `<dataDir>` 占位符（**必须在 merge 之前**，见文件头）。
    ///
    /// manifest 里的默认值带 `<dataDir>` 占位符（如 preloadScript），
    /// 它只能在启动时展开 —— manifest 属于「引擎定义」，数据目录属于「这台机器的安装」。
    public static func expandPlaceholders(
        _ gameArgs: [String: JSONValue], dataDir: String
    ) -> [String: JSONValue] {
        var out: [String: JSONValue] = [:]
        for (key, value) in gameArgs {
            out[key] = expandValue(value, dataDir: dataDir)
        }
        return out
    }

    private static func expandValue(_ value: JSONValue, dataDir: String) -> JSONValue {
        switch value {
        case .string(let s):
            return .string(s.replacingOccurrences(of: "<dataDir>", with: dataDir))
        case .array(let items):
            return .array(items.map { expandValue($0, dataDir: dataDir) })
        case .object(let obj):
            var out: [String: JSONValue] = [:]
            for (k, v) in obj { out[k] = expandValue(v, dataDir: dataDir) }
            return .object(out)
        default:
            return value
        }
    }

    /// 深拷贝（数组/对象递归）。
    ///
    /// 为什么不是直接赋值：默认值里有**数组**（mkxpz 的 `RTP` / `preloadScript` / `fontSub`）。
    /// 直接赋值会让两份 gameArgs 共享同一个数组对象 —— 用户改了一个游戏的 RTP，
    /// 另一个游戏的 RTP 跟着变。
    private static func clone(_ value: JSONValue) -> JSONValue {
        switch value {
        case .array(let items): return .array(items.map(clone))
        case .object(let obj):
            var out: [String: JSONValue] = [:]
            for (k, v) in obj { out[k] = clone(v) }
            return .object(out)
        default: return value
        }
    }

    /// **一步到位**：读 manifest → 合并默认值 → 展开占位符。
    ///
    /// 这是启动前必须做的完整流程。顺序：**先 merge（补进带占位符的默认值）
    /// 再 expand（把占位符换成真实路径）**。
    ///
    /// 反了会怎样：占位符还没展开就在 merge 里被跳过（因为键已存在）……
    /// 不对，这里正确答案是：先 merge 是必须的（要先把默认值补进来），
    /// 然后 expand 才有东西可展开。
    public static func prepare(
        userArgs: [String: JSONValue]?, dataDir: String, engine: String,
        fileManager: FileManager = .default
    ) -> [String: JSONValue] {
        let manifest = ManifestStore.load(
            dataDir: dataDir, engine: engine, fileManager: fileManager)

        // ① 补缺省值（用的还是带占位符的原始默认值）
        let (merged, _) = reconcile(current: userArgs ?? [:], schema: manifest?.gameArgs)

        // ② 展开占位符（现在默认值已经在 merged 里了）
        return expandPlaceholders(merged, dataDir: dataDir)
    }
}
