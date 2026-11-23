// 严格 JSON 判定的回归。
//
// 守的是「Foundation 说能解析、Chromium 说不行」的差集：
// macOS 26 的 JSONSerialization 容忍尾逗号，nw.js 的 JSON.parse 不容忍。
// 清单状态靠这个判定决定要不要走兼容目录，判错就会让用户继续看到「点了没反应」。
import Foundation
import Testing

@testable import TsumigeyaCore

@Suite("严格 JSON 判定")
struct StrictJSONTests {

    private func check(_ text: String) -> Bool {
        StrictJSON.isValid(Data(text.utf8))
    }

    @Test("合法 JSON")
    func acceptsValid() {
        let cases = [
            "{}", "[]", "  {  }  ",
            #"{"a":1}"#,
            #"[1,2,3]"#,
            #""just a string""#,
            "0", "-0", "1.5", "-2.25", "1e10", "1E+10", "-0.5e-3", "1234567890",
            "true", "false", "null",
            #"{"a":[{"b":null}],"c":"\u00e9"}"#,
            #"{"path":"www\/index.html"}"#,
            #"{ "a" : [ 1 , 2 ] }"#,
            #"{"中文":"值"}"#,
        ]
        for text in cases {
            #expect(check(text), "应该合法：\(text)")
        }
    }

    /// Chromium 的 JSON 读取器会跳过 BOM，这里跟它对齐（不算问题）。
    @Test("带 UTF-8 BOM 视为合法")
    func acceptsBOM() {
        var data = Data([0xEF, 0xBB, 0xBF])
        data.append(Data(#"{"a":1}"#.utf8))
        #expect(StrictJSON.isValid(data))
    }

    /// 这一组是重点：Foundation 多半能解析，但 nw.js 一定拒收。
    @Test("不合法 JSON")
    func rejectsInvalid() {
        let cases = [
            #"{"a":1,}"#,          // 尾逗号（本期要抓的主要目标）
            #"[1,]"#,              // 数组尾逗号
            #"{,}"#,
            #"{"a":1} extra"#,     // 多余内容
            #"{"a":01}"#,          // 前导零
            #"{"a":.5}"#,          // 缺整数位
            #"{"a":1.}"#,          // 缺小数位
            #"{"a":+1}"#,
            #"{"a":1} // 注释"#,
            #"{'a':1}"#,           // 单引号
            #"{"a":1"#,            // 未闭合对象
            #""未闭合"#,
            #"{"a":"\x"}"#,        // 非法转义
            #"{"a":"\u12"}"#,      // \u 不足四位
            "tru", "nul", "", "   ",
            #"{"a":"# + "\u{01}" + #""}"#,   // 字符串里有控制字符
        ]
        for text in cases {
            #expect(!check(text), "应该不合法：\(text)")
        }
    }

    /// 深度炸弹不该把解析器打爆（只判 false，不崩溃）。
    @Test("超深嵌套不崩溃")
    func depthBomb() {
        let deep = String(repeating: "[", count: 5000) + String(repeating: "]", count: 5000)
        #expect(!check(deep))
    }
}
