// RPG Maker 2000／2003 的数据库（`RPG_RT.ldb`）：只读，用于提取可翻译文本。
//
// 结构见 `LCF.swift`。这里只关心**有名字和说明的条目**：
//   chunk 11 角色、12 技能、13 物品、14 敌人、16 地形、18 状态、
//   21 公共事件、26 开关、27 变量
//
// 每个条目内：chunk 1 = 名称、chunk 2 = 说明（开关／变量只有名称）。
//
// ⚠️ 只读不写。写回要按新长度重建整棵 chunk 树并逐层重算长度字段，
//    在没有真实存档／数据库可回归的情况下不做。
import Foundation

public struct RPG2000Text: Sendable, Equatable {
    public let section: String
    public let id: Int
    public let name: String
    public let description: String
    public var label: String { "\(section)#\(id)" }
}

public enum RPG2000Database {
    /// chunk ID → 区块名。
    static let sections: [Int: String] = [
        11: "actors", 12: "skills", 13: "items", 14: "enemies",
        16: "terrains", 18: "states", 21: "commonEvents",
        26: "switches", 27: "variables"
    ]

    public static func texts(_ url: URL) throws -> [RPG2000Text] {
        try texts(Data(contentsOf: url))
    }

    public static func texts(_ data: Data) throws -> [RPG2000Text] {
        let (bytes, bodyStart) = try LCF.open(data, expecting: "LcfDataBase")
        var offset = bodyStart
        var result: [RPG2000Text] = []
        while offset < bytes.count {
            guard let chunk = try LCF.readChunk(bytes, &offset) else { break }
            guard let name = sections[chunk.id] else { continue }
            result.append(contentsOf: entries(bytes, chunk: chunk, section: name))
        }
        return result
    }

    /// 数组：`count` + （`元素 ID` + 该元素的 chunk 序列，以 ID 0 结束）*
    static func entries(_ bytes: [UInt8], chunk: LCFChunk, section: String) -> [RPG2000Text] {
        var offset = chunk.range.lowerBound
        guard let count = try? LCF.readInt(bytes, &offset), count > 0, count < 100_000 else { return [] }
        var rows: [RPG2000Text] = []
        for _ in 0..<count {
            guard let id = try? LCF.readInt(bytes, &offset), offset < chunk.range.upperBound else { break }
            var name = "", description = ""
            // 元素自身的 chunk 序列，遇到 ID 0 或越过本 chunk 就收手。
            while offset < chunk.range.upperBound {
                guard let fieldID = try? LCF.readInt(bytes, &offset) else { break }
                if fieldID == 0 { break }
                guard let length = try? LCF.readInt(bytes, &offset), length >= 0,
                      offset + length <= chunk.range.upperBound else { break }
                if fieldID == 1 || fieldID == 2 {
                    // chunk 的 length 就是字符串本身的字节数，值里不再带长度前缀。
                    let raw = Array(bytes[offset..<(offset + length)])
                    let value = LCF.decode(raw)
                    if fieldID == 1 { name = value } else { description = value }
                }
                offset += length
            }
            if !name.isEmpty || !description.isEmpty {
                rows.append(.init(section: section, id: id, name: name, description: description))
            }
        }
        return rows
    }
}
