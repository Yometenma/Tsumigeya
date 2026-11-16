import Foundation

/// 只读取页面自带的结构化数据，不执行页面脚本，也不依赖展示层的 CSS。
enum DLsitePageData {
    static func scripts(_ html: String, matching predicate: (String) -> Bool) -> [JSONValue] {
        guard let regex = try? NSRegularExpression(
            pattern: #"<script\b([^>]*)>([\s\S]*?)</script\s*>"#, options: .caseInsensitive) else { return [] }
        let ns = html as NSString
        return regex.matches(in: html, range: NSRange(location: 0, length: ns.length)).compactMap {
            guard predicate(ns.substring(with: $0.range(at: 1))),
                  let data = ns.substring(with: $0.range(at: 2)).data(using: .utf8) else { return nil }
            return try? JSONDecoder().decode(JSONValue.self, from: data)
        }
    }

    static func productJSONLD(_ html: String) -> [String: JSONValue]? {
        func product(_ value: JSONValue) -> [String: JSONValue]? {
            if let object = value.objectValue {
                if object["@type"]?.stringValue == "Product" { return object }
                if let graph = object["@graph"] { return product(graph) }
            }
            return value.arrayValue?.compactMap(product).first
        }
        return scripts(html) { $0.contains("application/ld+json") }.compactMap(product).first
    }

    static func nuxtProduct(_ html: String, rj: String) -> [String: JSONValue]? {
        guard let table = scripts(html, matching: { $0.contains("__NUXT_DATA__") }).first?.arrayValue,
              let entry = table.compactMap(\.objectValue).first(where: { $0["dlsite-product-\(rj)"] != nil }),
              let index = entry["dlsite-product-\(rj)"]?.intValue else { return nil }
        var budget = 20_000
        var visiting: Set<Int> = []
        func resolve(_ index: Int, depth: Int = 0) -> JSONValue {
            guard table.indices.contains(index), depth < 40, budget > 0,
                  !visiting.contains(index) else { return .null }
            budget -= 1
            visiting.insert(index)
            defer { visiting.remove(index) }
            let value = table[index]
            if let object = value.objectValue {
                return .object(object.mapValues { resolve($0.intValue ?? -1, depth: depth + 1) })
            }
            if let array = value.arrayValue {
                if let tag = array.first?.stringValue,
                   ["Reactive", "ShallowReactive", "Ref", "ShallowRef"].contains(tag), array.count == 2 {
                    return resolve(array[1].intValue ?? -1, depth: depth + 1)
                }
                return .array(array.map { resolve($0.intValue ?? -1, depth: depth + 1) })
            }
            return value
        }
        return resolve(index).objectValue?["data"]?.objectValue
    }

    static func plainText(_ html: String) -> String? {
        var text = html.replacingOccurrences(of: #"(?is)<(script|style)\b[^>]*>.*?</\1>"#,
                                             with: "", options: .regularExpression)
        text = text.replacingOccurrences(of: #"(?i)<br\s*/?>|</(?:p|div|h[1-6]|li|section)>"#,
                                        with: "\n", options: .regularExpression)
        text = text.replacingOccurrences(of: #"<[^>]+>"#, with: "", options: .regularExpression)
        text = DLsiteParser.decodeEntities(text)
        let lines = text.components(separatedBy: .newlines).map {
            $0.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        text = lines.filter { !$0.isEmpty }.joined(separator: "\n")
        return text.isEmpty ? nil : text
    }

    static func unique(_ values: [String]) -> [String] {
        var seen: Set<String> = []
        return values.filter { !$0.isEmpty && seen.insert($0).inserted }
    }

    static func fullIntroduction(_ value: JSONValue?) -> String? {
        let sections = (value?.arrayValue ?? []).compactMap { item -> String? in
            guard let section = item.objectValue else { return nil }
            var parts = [section["title"]?.stringValue].compactMap { $0 }
            for body in section["body"]?.arrayValue ?? [] {
                if let intro = body.objectValue?["intro"]?.stringValue { parts.append(intro) }
            }
            return plainText(parts.joined(separator: "\n"))
        }
        return sections.isEmpty ? nil : sections.joined(separator: "\n\n")
    }
}
