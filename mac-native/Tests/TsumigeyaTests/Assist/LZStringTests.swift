import Testing
import Foundation
@testable import TsumigeyaCore

/// 向量来自 MV 自带的 `js/libs/lz-string.js`（1.3 版）实跑结果，不是自造实现对拍。
@Suite("LZString 存档压缩")
struct LZStringTests {
    private let vectors: [(String, String)] = [
        ("", "QAA="),
        ("a", "IZA="),
        ("hello", "BYUwNmD2QAA="),
        ("あいうえお", "kIMhEGRiDIEgyFIMQAA="),
        ("RPGツクールMZ", "EoBQ4oIwyPUMg/DI1wwFkBaQ"),
        (#"{"gold":1234,"items":{"1":5}}"#, "N4Ig5g9gNgJiBcBGATAZgCwBoQEsAuApgLYDOCoiCArAL41A"),
        (#"{"_gold":50000,"_items":{"1":99,"2":3}}"#, "N4Ig+g5g9gNgJiAXAVgAztQGnASwC4CmAtgM5KgCMSAnNdgExIDMAvi0AAA=")
    ]

    @Test("压缩输出与 MV 自带实现逐字节一致")
    func compressesLikeEngine() {
        for (plain, encoded) in vectors {
            #expect(LZString.compressToBase64(plain) == encoded, "压缩不一致：\(plain)")
        }
    }

    @Test("解压与环境向量一致")
    func decompressesLikeEngine() {
        for (plain, encoded) in vectors {
            #expect(LZString.decompressFromBase64(encoded) == plain, "解压不一致：\(encoded)")
        }
    }

    @Test("任意文本往返，包含代理对与长串")
    func roundTrip() {
        let samples = ["", "1", String(repeating: "存档", count: 400),
                       "😀🎮 emoji 与 日本語 混排", #"{"a":[1,2,{"b":"c"}],"d":null}"#]
        for sample in samples {
            let packed = LZString.compressToBase64(sample)
            #expect(LZString.decompressFromBase64(packed) == sample)
        }
    }

    @Test("非法输入不崩溃，返回 nil")
    func rejectsGarbage() {
        #expect(LZString.decompressFromBase64("") == nil)
        #expect(LZString.decompressFromBase64("!!!!") == nil)
    }
}
