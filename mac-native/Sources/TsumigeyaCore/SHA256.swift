// sha256（存档包的校验用）。
//
// 对应 Electron 版：`src/main/save-archive-io.ts` 的 `sha256Hex`（用 `node:crypto`）
//
// ===== 为什么需要它 =====
//
// 导出时记下每个文件的 sha256，导入时逐个校验。这是「文件在传输中没被改过」
// 的唯一判据 —— **没有它，导入就是拿用户的存档冒险**。
//
// ⚠️ **导出端与导入端必须用同一个算法**（就是本文件）：
//    分成两处各写一遍的话，漂移的表现是「自己导出的包自己拒收」。
//
// ⚠️ 现在**没用 CryptoKit** 的 `Insecure.SHA256` —— 那在 macOS 上能用，
//    但本文件先给一个纯 Swift 实现，理由：
//      · 归档/导入是**低频操作**（一次几百 KB），纯 Swift 慢一点无所谓
//      · 零 import 意味着**单测能在任何平台跑**（Windows 上也能验判据）
//
//    如果将来存档变大到几百 MB，再换成 CryptoKit（接口不变）。
import Foundation

public enum SHA256 {

    /// 计算一段数据的 sha256（小写十六进制 64 位）。
    public static func hex(_ input: [UInt8]) -> String {
        compute(input)
    }

    /// 计算文件内容的 sha256。
    ///
    /// - Returns: 小写十六进制；读不到文件时返回 nil（**不猜空字符串**）
    public static func hexOfFile(at path: String) -> String? {
        guard let data = FileManager.default.contents(atPath: path) else { return nil }
        return compute([UInt8](data))
    }

    // MARK: - 实现

    private static let k: [UInt32] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
        0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
        0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
        0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
        0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
        0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
        0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]

    private static func rotr(_ x: UInt32, _ n: UInt32) -> UInt32 {
        (x >> n) | (x << (32 - n))
    }

    private static func add(_ a: UInt32, _ b: UInt32) -> UInt32 {
        let sum = a &+ b
        return sum
    }

    /// 主实现。
    private static func compute(_ input: [UInt8]) -> String {
        var h: [UInt32] = [
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
            0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
        ]

        // 填充：附加 0x80，再补 0 到 56 mod 64，最后 8 字节是大端长度（bit）
        var padded = input
        let bitLength = UInt64(input.count) * 8
        padded.append(0x80)
        while padded.count % 64 != 56 {
            padded.append(0)
        }
        for shift in stride(from: 56, through: 0, by: -8) {
            padded.append(UInt8((bitLength >> UInt64(shift)) & 0xFF))
        }

        // 逐块处理
        var offset = 0
        while offset < padded.count {
            var w = [UInt32](repeating: 0, count: 64)
            for i in 0..<16 {
                let base = offset + i * 4
                w[i] = (UInt32(padded[base]) << 24)
                    | (UInt32(padded[base + 1]) << 16)
                    | (UInt32(padded[base + 2]) << 8)
                    | UInt32(padded[base + 3])
            }
            for i in 16..<64 {
                let s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3)
                let s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10)
                w[i] = add(add(add(w[i - 16], s0), w[i - 7]), s1)
            }

            var a = h[0], b = h[1], c = h[2], d = h[3]
            var e = h[4], f = h[5], g = h[6], hh = h[7]

            for i in 0..<64 {
                let s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
                let ch = (e & f) ^ (~e & g)
                let temp1 = add(add(add(hh, s1), add(ch, k[i])), w[i])
                let s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
                let maj = (a & b) ^ (a & c) ^ (b & c)
                let temp2 = add(s0, maj)

                hh = g; g = f; f = e
                e = add(d, temp1)
                d = c; c = b; b = a
                a = add(temp1, temp2)
            }

            h[0] = add(h[0], a); h[1] = add(h[1], b)
            h[2] = add(h[2], c); h[3] = add(h[3], d)
            h[4] = add(h[4], e); h[5] = add(h[5], f)
            h[6] = add(h[6], g); h[7] = add(h[7], hh)

            offset += 64
        }

        return h.map { word in
            String(format: "%02x%02x%02x%02x",
                   (word >> 24) & 0xFF, (word >> 16) & 0xFF,
                   (word >> 8) & 0xFF, word & 0xFF)
        }.joined()
    }
}
