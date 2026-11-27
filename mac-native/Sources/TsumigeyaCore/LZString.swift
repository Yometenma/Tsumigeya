// LZString：RPG Maker MV／MZ 存档用的压缩格式。
//
// ===== 为什么单独实现一篇 =====
//
// MV／MZ 自带的 `js/libs/lz-string.js` 是 **1.3 版**，与 npm 上 1.4.x 的实现**不兼容**：
//
//   · 1.3：先压成 16 位字流（每次读 16 位，`position` 从 32768 起）
//   · 1.4：直接 6 位字流（`position` 从 32 起）
//
// 两者 `compressToBase64` 的输出互不相认。照 1.4 写出来的解压器对 MZ 存档会直接
// 解出空串或乱码，所以这里按游戏里那份源码逐行移植（含 base64 的 3 字节／2 字符打包）。
//
// ⚠️ 只用 `compressToBase64` / `decompressFromBase64` 这一对 —— MV／MZ 的存档
//    （`save/file1.rmmzsave`、MV 的 localStorage 值）走的都是这个入口。
import Foundation

public enum LZString {
    private static let alphabet: [Character] = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=")
    private static let alphabetString = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="

    public static func compressToBase64(_ input: String) -> String {
        packBase64(compress(Array(input.utf16)))
    }

    public static func decompressFromBase64(_ input: String) -> String? {
        guard let units = unpackBase64(input) else { return nil }
        return decompress(units)
    }

    // MARK: - 位流

    /// 16 位字流的压缩（对应 `LZString.compress`）。
    static func compress(_ input: [UInt16]) -> [UInt16] {
        var dictionary: [[UInt16]: Int] = [:]
        var pending: Set<[UInt16]> = []
        var dictSize = 3
        var w: [UInt16] = []
        var enlargeIn = 2
        var numBits = 2
        var output: [UInt16] = []
        var bits = 0
        var position = 0

        func write(_ bit: Int) {
            bits = (bits << 1) | (bit & 1)
            if position == 15 { output.append(UInt16(bits & 0xFFFF)); bits = 0; position = 0 }
            else { position += 1 }
        }
        func writeValue(_ value: Int, _ count: Int) {
            var remaining = value
            for _ in 0..<count { write(remaining & 1); remaining >>= 1 }
        }
        func emitWord(_ word: [UInt16]) {
            if pending.contains(word) {
                if let first = word.first, first < 256 {
                    writeValue(0, numBits)
                    writeValue(Int(first), 8)
                } else {
                    writeValue(1, numBits)
                    writeValue(Int(word.first ?? 0), 16)
                }
                enlargeIn -= 1
                if enlargeIn == 0 { enlargeIn = 1 << numBits; numBits += 1 }
                pending.remove(word)
            } else if let code = dictionary[word] {
                writeValue(code, numBits)
            }
            enlargeIn -= 1
            if enlargeIn == 0 { enlargeIn = 1 << numBits; numBits += 1 }
        }

        for scalar in input {
            let c: [UInt16] = [scalar]
            if dictionary[c] == nil { dictionary[c] = dictSize; dictSize += 1; pending.insert(c) }
            let wc = w + c
            if dictionary[wc] != nil {
                w = wc
            } else {
                emitWord(w)
                dictionary[wc] = dictSize; dictSize += 1
                w = c
            }
        }
        if !w.isEmpty { emitWord(w) }
        writeValue(2, numBits)
        while true {
            bits <<= 1
            if position == 15 { output.append(UInt16(bits & 0xFFFF)); break }
            position += 1
        }
        return output
    }

    /// 16 位字流的解压（对应 `LZString.decompress`）。
    static func decompress(_ input: [UInt16]) -> String? {
        guard !input.isEmpty else { return nil }
        var dictionary: [[UInt16]] = [[0], [1], [2]]
        var enlargeIn = 4
        var dictSize = 4
        var numBits = 3
        var result: [UInt16] = []
        var value = Int(input[0])
        var position = 32768
        var index = 1

        func readBits(_ count: Int) -> Int {
            var bits = 0, power = 1
            for _ in 0..<count {
                let carried = value & position
                position >>= 1
                if position == 0 {
                    position = 32768
                    value = index < input.count ? Int(input[index]) : 0
                    index += 1
                }
                bits += (carried > 0 ? 1 : 0) * power
                power <<= 1
            }
            return bits
        }

        var entry: [UInt16]
        switch readBits(2) {
        case 0: entry = [UInt16(readBits(8))]
        case 1: entry = [UInt16(readBits(16))]
        default: return ""
        }
        dictionary.append(entry)
        var previous = entry
        result.append(contentsOf: entry)

        while true {
            if index > input.count { return "" }
            let code = readBits(numBits)
            switch code {
            case 0:
                let scalar = UInt16(readBits(8))
                dictionary.append([scalar]); dictSize += 1
                entry = [scalar]; enlargeIn -= 1
            case 1:
                let scalar = UInt16(readBits(16))
                dictionary.append([scalar]); dictSize += 1
                entry = [scalar]; enlargeIn -= 1
            case 2:
                return String(decoding: result, as: UTF16.self)
            default:
                if code < dictionary.count { entry = dictionary[code] }
                else if code == dictSize { entry = previous + [previous[0]] }
                else { return nil }
            }
            if enlargeIn == 0 { enlargeIn = 1 << numBits; numBits += 1 }
            result.append(contentsOf: entry)
            dictionary.append(previous + [entry[0]]); dictSize += 1
            enlargeIn -= 1
            previous = entry
            if enlargeIn == 0 { enlargeIn = 1 << numBits; numBits += 1 }
        }
    }

    // MARK: - base64 打包（1.3 版的 3 字节 ↔ 2 字符）

    static func packBase64(_ words: [UInt16]) -> String {
        var output: [Character] = []
        var cursor = 0
        while cursor < words.count * 2 {
            var n = 0, r = -1, i = -1
            if cursor % 2 == 0 {
                n = Int(words[cursor / 2]) >> 8
                r = Int(words[cursor / 2]) & 255
                if cursor / 2 + 1 < words.count { i = Int(words[cursor / 2 + 1]) >> 8 }
            } else {
                n = Int(words[(cursor - 1) / 2]) & 255
                if (cursor + 1) / 2 < words.count {
                    r = Int(words[(cursor + 1) / 2]) >> 8
                    i = Int(words[(cursor + 1) / 2]) & 255
                }
            }
            cursor += 3
            let first = n >> 2
            let second = (n & 3) << 4 | (max(r, 0) >> 4)
            var third = ((max(r, 0) & 15) << 2) | (max(i, 0) >> 6)
            var fourth = max(i, 0) & 63
            if r < 0 { third = 64; fourth = 64 }
            else if i < 0 { fourth = 64 }
            output.append(alphabet[first]); output.append(alphabet[second])
            output.append(alphabet[third]); output.append(alphabet[fourth])
        }
        return String(output)
    }

    static func unpackBase64(_ input: String) -> [UInt16]? {
        let filtered = input.filter { $0.isLetter || $0.isNumber || $0 == "+" || $0 == "/" || $0 == "=" }
        guard !filtered.isEmpty else { return nil }
        let characters = Array(filtered)
        var output: [UInt16] = []
        var phase = 0
        var carry = 0
        var cursor = 0
        func index(_ character: Character) -> Int { alphabetString.firstIndex(of: character).map { alphabetString.distance(from: alphabetString.startIndex, to: $0) } ?? 64 }
        while cursor < characters.count {
            let u = index(characters[cursor]); cursor += 1
            let a = cursor < characters.count ? index(characters[cursor]) : 64; cursor += 1
            let f = cursor < characters.count ? index(characters[cursor]) : 64; cursor += 1
            let l = cursor < characters.count ? index(characters[cursor]) : 64; cursor += 1
            let i = u << 2 | a >> 4
            let s = (a & 15) << 4 | f >> 2
            let o = (f & 3) << 6 | l
            if phase % 2 == 0 {
                carry = i << 8
                if f != 64 { output.append(UInt16((carry | s) & 0xFFFF)) }
                if l != 64 { carry = o << 8 }
            } else {
                output.append(UInt16((carry | i) & 0xFFFF))
                if f != 64 { carry = s << 8 }
                if l != 64 { output.append(UInt16((carry | o) & 0xFFFF)) }
            }
            phase += 3
        }
        return output
    }
}
