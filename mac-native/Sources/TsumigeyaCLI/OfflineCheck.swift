// 离线辅助的验收入口：不注入运行时，直接读写游戏自己的脚本与存档。
//
//   NScripter   0.txt / 00.txt / nscript.dat      → 文本提取与替换
//   RPG Maker MZ save/file*.rmmzsave              → JSON（LZString 压缩）
//   XP/VX/Ace   Save*.rvdata2 / *.rxdata          → Ruby Marshal
import Foundation
import TsumigeyaCore

private let usage = """
用法：
  offline script-inspect <游戏目录>              列出可翻译行
  offline script-extract <游戏目录> <输出.json>   导出 {原文: ""}
  offline script-apply   <游戏目录> <字典.json>   写入译文（自动备份）
  offline save-inspect   <存档路径>              列出可改字段
  offline save-set       <存档路径> <路径> <值>   改一个标量，路径用 . 分隔
"""

func runOfflineCommand(_ args: [String]) -> Int32 {
    guard let action = args.first else { print(usage); return 2 }
    let rest = Array(args.dropFirst())
    do {
        switch action {
        case "script-inspect":
            guard let root = rest.first else { print(usage); return 2 }
            return try scriptInspect(root: root)
        case "script-extract":
            guard rest.count == 2 else { print(usage); return 2 }
            return try scriptExtract(root: rest[0], output: rest[1])
        case "script-apply":
            guard rest.count == 2 else { print(usage); return 2 }
            return try scriptApply(root: rest[0], dictionary: rest[1])
        case "save-inspect":
            guard let path = rest.first else { print(usage); return 2 }
            return try saveInspect(path: path)
        case "save-set":
            guard rest.count == 3 else { print(usage); return 2 }
            return try saveSet(path: rest[0], path: rest[1], raw: rest[2])
        default:
            print(usage); return 2
        }
    } catch {
        print("失败：\(error.localizedDescription)")
        return 1
    }
}

private func scriptInspect(root: String) throws -> Int32 {
    guard let url = OfflineScript.locate(in: root) else {
        print("这个目录里没有 NScripter 脚本（0.txt / 00.txt / nscript.dat）。")
        return 1
    }
    let document = try OfflineScript.load(url)
    print("脚本：\(url.lastPathComponent)；编码：\(document.encoding.rawValue)\(document.encrypted ? "（XOR 0x84）" : "")；可翻译行：\(document.entries.count)")
    for entry in document.entries.prefix(20) { print("  \(entry.index)\t\(entry.source)") }
    if document.entries.count > 20 { print("  …共 \(document.entries.count) 行") }
    return 0
}

private func scriptExtract(root: String, output: String) throws -> Int32 {
    guard let url = OfflineScript.locate(in: root) else {
        print("这个目录里没有 NScripter 脚本。"); return 1
    }
    let document = try OfflineScript.load(url)
    var dictionary: [String: String] = [:]
    for entry in document.entries { dictionary[entry.source] = "" }
    let data = try JSONEncoder().encode(dictionary)
    try data.write(to: URL(fileURLWithPath: output), options: .atomic)
    print("已导出 \(dictionary.count) 条到 \(output)")
    return 0
}

private func scriptApply(root: String, dictionary: String) throws -> Int32 {
    guard let url = OfflineScript.locate(in: root) else {
        print("这个目录里没有 NScripter 脚本。"); return 1
    }
    let document = try OfflineScript.load(url)
    let decoded = try JSONDecoder().decode([String: String].self, from: Data(contentsOf: URL(fileURLWithPath: dictionary)))
    let translations = decoded.filter { !$0.value.isEmpty }
    let result = try OfflineScript.write(translations, to: document)
    print("替换 \(result.replaced) 行；写回编码：\(result.encoding.rawValue)")
    if result.encoding != document.encoding {
        print("⚠️ 原编码装不下这些译文，已改用 \(result.encoding.rawValue)；启动参数里的 --enc 必须跟着改。")
    }
    return 0
}

private func saveInspect(path: String) throws -> Int32 {
    let url = URL(fileURLWithPath: path)
    switch url.pathExtension.lowercased() {
    case "rmmzsave":
        let document = try RMStoreSave.read(url)
        print("MZ 存档；hash 前缀：\(document.hash.isEmpty ? "无" : document.hash)")
        for field in flattenJSON(document.contents).prefix(40) { print("  \(field)") }
        return 0
    case "rvdata2", "rxdata":
        let (_, fields) = try RubyMarshal.scan(try Data(contentsOf: url))
        print("Ruby Marshal 存档；可改字段 \(fields.count) 处")
        for field in fields.prefix(40) { print("  \(field.displayPath) = \(describe(field.value))") }
        return 0
    default:
        print("不认识的存档扩展名：\(url.pathExtension)")
        return 1
    }
}

private func saveSet(path: String, path dotted: String, raw: String) throws -> Int32 {
    let url = URL(fileURLWithPath: path)
    let segments = dotted.split(separator: ".").map(String.init)
    let value = parseScalar(raw)
    switch url.pathExtension.lowercased() {
    case "rmmzsave":
        let document = try RMStoreSave.read(url)
        guard let updated = RMStoreSave.setting(value, at: segments, in: document.contents) else {
            print("路径不存在或类型不一致：\(dotted)"); return 1
        }
        try RMStoreSave.write(updated, to: document)
        print("已写入 \(dotted) = \(raw)")
        return 0
    case "rvdata2", "rxdata":
        let data = try Data(contentsOf: url)
        let (_, fields) = try RubyMarshal.scan(data)
        guard let field = fields.first(where: { $0.displayPath == dotted }) else {
            print("找不到字段：\(dotted)"); return 1
        }
        let replacement: MarshalValue
        switch field.value {
        case .int:
            guard case .int(let number) = value else { print("类型不一致：字段是整数"); return 1 }
            replacement = .int(number)
        case .double:
            if case .double(let number) = value { replacement = .double(number) }
            else if case .int(let number) = value { replacement = .double(Double(number)) }
            else { print("类型不一致：字段是浮点数"); return 1 }
        case .bool:
            guard case .bool(let flag) = value else { print("类型不一致：字段是布尔值"); return 1 }
            replacement = .bool(flag)
        case .string:
            guard case .string(let text) = value else { print("类型不一致：字段是字符串"); return 1 }
            replacement = .string(text: text, raw: Data(text.utf8))
            print("注意：字符串按 UTF-8 写入，原存档若用 Shift_JIS 可能需要改回原编码。")
        default:
            print("只能改数字、布尔值和字符串：字段是 \(describe(field.value))"); return 1
        }
        let patched = try RubyMarshal.patch([(field, replacement)], in: data)
        try OfflineScript.writeWithBackup(patched, to: url, backup: true)
        print("已写入 \(dotted) = \(raw)")
        return 0
    default:
        print("不认识的存档扩展名：\(url.pathExtension)")
        return 1
    }
}

private func parseScalar(_ raw: String) -> JSONValue {
    if raw == "true" { return .bool(true) }
    if raw == "false" { return .bool(false) }
    if let number = Int(raw) { return .int(number) }
    if let number = Double(raw) { return .double(number) }
    return .string(raw)
}

private func describe(_ value: MarshalValue) -> String {
    switch value {
    case .null: return "nil"
    case .bool(let flag): return String(flag)
    case .int(let number): return String(number)
    case .double(let number): return String(number)
    case .string(let text, _): return "\"\(text)\""
    case .symbol(let name): return ":\(name)"
    case .array(let items): return "[\(items.count)]"
    case .hash(let entries): return "{\(entries.count)}"
    case .object(let className, _): return "\(className) 实例"
    case .userDefined(let className, _): return "\(className) 数据"
    case .classRef(let name): return "class \(name)"
    case .moduleRef(let name): return "module \(name)"
    case .userMarshal(let className, _): return "\(className) marshal"
    }
}

private func flattenJSON(_ value: JSONValue, prefix: String = "") -> [String] {
    switch value {
    case .object(let map):
        return map.keys.sorted().flatMap { flattenJSON(map[$0]!, prefix: prefix.isEmpty ? $0 : prefix + "." + $0) }
    case .array(let items):
        return items.enumerated().flatMap { flattenJSON($0.element, prefix: prefix + "[\($0.offset)]") }
    default:
        return [prefix + " = " + (value.stringValue ?? String(describing: value))]
    }
}
