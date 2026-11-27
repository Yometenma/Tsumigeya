// RPG Maker MZ 的存档：`save/file1.rmmzsave`。
//
// 格式链（与引擎 `StorageManager.objectToJson` 完全一致）：
//
//     LZString.compressToBase64( JsonEx.stringify(contents) )
//
// 而 `JsonEx.stringify` 的产物是 **8 位 hash 前缀 + JSON**（hash 由循环引用表算出，
// 但引擎的 `parse` 只是跳过它、不校验），所以这里把前缀原样留着，只改 JSON 部分。
//
// ⚠️ hash 前缀原样留着：引擎自己的 `parse` 只是跳过它、不校验，
//    但去掉它等于在做一个没人要求的格式变更。
import Foundation

public struct RMStoreDocument: Sendable {
    public let url: URL
    /// `JsonEx.stringify` 写在前面的 8 位 hash；只读。
    public let hash: String
    /// 解析后的存档内容（`party` / `variables` / `actors` …）。
    public let contents: JSONValue
}

public enum RMStoreSave {
    public static let fileExtension = "rmmzsave"

    public static func read(_ url: URL) throws -> RMStoreDocument {
        guard url.resolvingSymlinksInPath().path == url.path else {
            throw OfflineError.invalid(L10n.string("存档是符号链接，拒绝读写。"))
        }
        guard let encoded = String(data: try Data(contentsOf: url), encoding: .utf8) else {
            throw OfflineError.invalid(L10n.string("存档不是可识别的文本。"))
        }
        guard let json = LZString.decompressFromBase64(encoded.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            throw OfflineError.invalid(L10n.string("存档解压失败：可能不是 .rmmzsave。"))
        }
        let hash: String, body: String
        if json.hasPrefix("{\"@\":") {
            hash = ""; body = json
        } else {
            hash = String(json.prefix(8)); body = String(json.dropFirst(8))
        }
        guard let value = try? JSONDecoder().decode(JSONValue.self, from: Data(body.utf8)) else {
            throw OfflineError.invalid(L10n.string("存档内容不是有效 JSON。"))
        }
        return .init(url: url, hash: hash, contents: value)
    }

    @discardableResult
    public static func write(_ contents: JSONValue, to document: RMStoreDocument, backup: Bool = true) throws -> URL {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let body = String(decoding: try encoder.encode(contents), as: UTF8.self)
        let encoded = LZString.compressToBase64(document.hash + body)
        guard let data = encoded.data(using: .utf8) else {
            throw OfflineError.invalid(L10n.string("存档无法写回。"))
        }
        try OfflineScript.writeWithBackup(data, to: document.url, backup: backup)
        return document.url
    }

    // MARK: - 路径读写

    public static func value(at path: [String], in root: JSONValue) -> JSONValue? {
        var node = root
        for key in path {
            guard case .object(let map) = node, let next = map[key] else { return nil }
            node = next
        }
        return node
    }

    /// 返回替换后的新树；路径不存在时返回 nil（不改结构，避免把存档写坏）。
    public static func setting(_ value: JSONValue, at path: [String], in root: JSONValue) -> JSONValue? {
        guard let head = path.first else { return value }
        guard case .object(var map) = root, let existing = map[head] else { return nil }
        if path.count == 1 {
            guard sameShape(existing, value) else { return nil }
            map[head] = value
            return .object(map)
        }
        guard let updated = setting(value, at: Array(path.dropFirst()), in: existing) else { return nil }
        map[head] = updated
        return .object(map)
    }

    /// 物品表这类字典：`party._items` 的键是条目编号。
    public static func number(_ path: [String], in root: JSONValue) -> Double? {
        switch value(at: path, in: root) {
        case .int(let number): return Double(number)
        case .double(let number): return number
        default: return nil
        }
    }

    /// 只允许同类型替换：数字换数字、布尔换布尔，避免把对象覆盖成字符串。
    private static func sameShape(_ existing: JSONValue, _ replacement: JSONValue) -> Bool {
        switch (existing, replacement) {
        case (.int, .int), (.int, .double), (.double, .int), (.double, .double): return true
        case (.bool, .bool), (.string, .string): return true
        default: return false
        }
    }
}
