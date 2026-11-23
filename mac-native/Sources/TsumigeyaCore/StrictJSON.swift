// RFC 8259 严格 JSON 校验（只判合法性，不构造值）。
//
// ===== 为什么需要这一层 =====
//
// macOS 26 的 Foundation `JSONSerialization` **容忍尾逗号**（实测：`{"name":"x",}`
// 能解析成功），而 nw.js 读 app 清单走的是 Chromium 的 `JSON.parse` —— 严格拒绝。
//
// 判据不同会造成一个很难查的空档：
//   启动器解析成功 → 判定「清单没问题，不用兼容」→ 直接交给 nw.js
//   nw.js 却因为尾逗号拒绝加载 → 用户看到的是「点了没反应」
//
// 所以清单状态不能只用「能不能解析」来判，还要判「原文是不是严格 JSON」。
// 不严格的清单同样可以在兼容目录里重写成标准 JSON 交给 nw.js（不改游戏文件）。
//
// ===== 为什么不用 JSONSerialization 转一遍再比对 =====
//
// 它能把对象重新序列化成严格 JSON，但**发现不了原文的问题** ——
// 我们要的是「原文是否合法」，不是「能不能转成合法」。
//
// ⚠️ BOM 不算问题：Chromium 的 JSON 读取器会跳过 UTF-8 BOM，这里与之对齐，
//    避免为正常游戏白白生成兼容目录。
//
// ⚠️ switch 的 case pattern 里不能写 `UInt8(ascii:)`（那是初始化器调用，不是常量），
//    所以 pattern 一律用十六进制字面量，旁边标注对应字符。
import Foundation

public enum StrictJSON {

    /// 这段字节是不是严格的 JSON 文本。
    public static func isValid(_ data: Data) -> Bool {
        var scanner = Scanner(bytes: [UInt8](data))
        return scanner.validateDocument()
    }

    /// 字节级递归下降扫描器。只推进下标，不建对象。
    struct Scanner {
        let bytes: [UInt8]
        var index = 0
        /// 嵌套深度上限：`package.json` 不可能更深，防损坏文件把栈打爆。
        static let maxDepth = 256

        init(bytes: [UInt8]) {
            self.bytes = bytes
            // 跳过 UTF-8 BOM（见文件头）
            if bytes.count >= 3, bytes[0] == 0xEF, bytes[1] == 0xBB, bytes[2] == 0xBF {
                index = 3
            }
        }

        var isAtEnd: Bool { index >= bytes.count }

        mutating func skipWhitespace() {
            while index < bytes.count {
                switch bytes[index] {
                case 0x20, 0x09, 0x0A, 0x0D: index += 1
                default: return
                }
            }
        }

        /// 整份文档：一个值 + 尾随空白 + 结束。
        mutating func validateDocument() -> Bool {
            skipWhitespace()
            guard validateValue(depth: 0) else { return false }
            skipWhitespace()
            return isAtEnd
        }

        mutating func validateValue(depth: Int) -> Bool {
            guard depth <= Self.maxDepth, !isAtEnd else { return false }
            switch bytes[index] {
            case 0x7B: return validateObject(depth: depth)   // {
            case 0x5B: return validateArray(depth: depth)    // [
            case 0x22: return validateString()               // "
            case 0x74: return match("true")                  // t
            case 0x66: return match("false")                 // f
            case 0x6E: return match("null")                  // n
            case 0x2D: return validateNumber()               // -
            case 0x30...0x39: return validateNumber()        // 0-9
            default: return false
            }
        }

        mutating func validateObject(depth: Int) -> Bool {
            index += 1                       // {
            skipWhitespace()
            if !isAtEnd, bytes[index] == 0x7D {   // }
                index += 1
                return true
            }
            while true {
                skipWhitespace()
                guard validateString() else { return false }
                skipWhitespace()
                guard !isAtEnd, bytes[index] == 0x3A else { return false }   // :
                index += 1
                skipWhitespace()
                guard validateValue(depth: depth + 1) else { return false }
                skipWhitespace()
                guard !isAtEnd else { return false }
                switch bytes[index] {
                case 0x2C:                       // ,
                    index += 1
                    // 关键：`,` 后面必须是下一个成员，**不能直接是 `}`**（那正是尾逗号）
                case 0x7D:                       // }
                    index += 1
                    return true
                default:
                    return false
                }
            }
        }

        mutating func validateArray(depth: Int) -> Bool {
            index += 1                       // [
            skipWhitespace()
            if !isAtEnd, bytes[index] == 0x5D {   // ]
                index += 1
                return true
            }
            while true {
                skipWhitespace()
                guard validateValue(depth: depth + 1) else { return false }
                skipWhitespace()
                guard !isAtEnd else { return false }
                switch bytes[index] {
                case 0x2C:                       // ,
                    index += 1
                case 0x5D:                       // ]
                    index += 1
                    return true
                default:
                    return false
                }
            }
        }

        mutating func validateString() -> Bool {
            guard !isAtEnd, bytes[index] == 0x22 else { return false }   // "
            index += 1
            while index < bytes.count {
                let byte = bytes[index]
                if byte == 0x22 {                // "
                    index += 1
                    return true
                }
                if byte == 0x5C {                // \
                    index += 1
                    guard index < bytes.count else { return false }
                    switch bytes[index] {
                    case 0x22, 0x5C, 0x2F,       // " \ /
                         0x62, 0x66, 0x6E,       // b f n
                         0x72, 0x74:             // r t
                        index += 1
                    case 0x75:                   // u
                        index += 1
                        guard index + 4 <= bytes.count else { return false }
                        for _ in 0..<4 {
                            guard isHexDigit(bytes[index]) else { return false }
                            index += 1
                        }
                    default:
                        return false             // `\x` 之类非法转义
                    }
                    continue
                }
                // 未转义的控制字符（< 0x20）非法；其余按 UTF-8 原样通过
                if byte < 0x20 { return false }
                index += 1
            }
            return false                         // 未闭合
        }

        mutating func validateNumber() -> Bool {
            if !isAtEnd, bytes[index] == 0x2D { index += 1 }   // -
            guard !isAtEnd else { return false }
            // 整数部分：`0` 或 [1-9][0-9]*（`01`、`.5` 都非法）
            if bytes[index] == 0x30 {                          // 0
                index += 1
            } else if bytes[index] >= 0x31 && bytes[index] <= 0x39 {
                while !isAtEnd, isDigit(bytes[index]) { index += 1 }
            } else {
                return false
            }
            // 小数部分：`.` 后至少一位
            if !isAtEnd, bytes[index] == 0x2E {                 // .
                index += 1
                guard !isAtEnd, isDigit(bytes[index]) else { return false }
                while !isAtEnd, isDigit(bytes[index]) { index += 1 }
            }
            // 指数部分：e/E [+-]? 至少一位
            if !isAtEnd, bytes[index] == 0x65 || bytes[index] == 0x45 {
                index += 1
                if !isAtEnd, bytes[index] == 0x2B || bytes[index] == 0x2D {
                    index += 1
                }
                guard !isAtEnd, isDigit(bytes[index]) else { return false }
                while !isAtEnd, isDigit(bytes[index]) { index += 1 }
            }
            return true
        }

        mutating func match(_ literal: String) -> Bool {
            let wanted = Array(literal.utf8)
            guard index + wanted.count <= bytes.count else { return false }
            guard Array(bytes[index..<(index + wanted.count)]) == wanted else { return false }
            index += wanted.count
            return true
        }

        func isDigit(_ byte: UInt8) -> Bool {
            byte >= 0x30 && byte <= 0x39
        }

        func isHexDigit(_ byte: UInt8) -> Bool {
            isDigit(byte)
                || (byte >= 0x61 && byte <= 0x66)
                || (byte >= 0x41 && byte <= 0x46)
        }
    }
}
