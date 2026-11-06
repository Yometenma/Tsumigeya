// SHA256 实现测试。
//
// ===== 为什么这个文件特别重要 =====
//
// sha256 是存档包**唯一的完整性判据**。写错了**不会崩溃** ——
// 它只会「稳定地算出一个错的哈希」：
//   · 导出时记下错的值
//   · 导入时比对同一个错的值
//   · **一切看起来都通过了**，但「文件被改过」再也检不出来
//
// 所以必须用**公开的已知答案**（NIST/FIPS 向量）钉住，而不是自己跟自己对。
import Foundation
import Testing

@testable import TsumigeyaCore

@Suite("SHA256")
struct SHA256Tests {

    /// ⚠️ **空串的 sha256 是公开的已知答案**。
    @Test("空串")
    func emptyString() {
        #expect(SHA256.hex([]) ==
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    }

    /// ⚠️ `"abc"` 是 FIPS 180-2 的经典测试向量。
    @Test("abc")
    func abc() {
        #expect(SHA256.hex([0x61, 0x62, 0x63]) ==
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    /// ⚠️ 两个块（112 字节）：验证填充逻辑（跨块的边界最容易写错）。
    @Test("两块的输入")
    func twoBlock() {
        // NIST 向量：`"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"`
        let input = Array("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq".utf8)
        #expect(SHA256.hex(input) ==
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1")
    }

    /// ⚠️ **长度恰好 55 字节**（填充边界：`55 + 1 + 8 = 64`，正好一个块）。
    /// 这是「填充逻辑差一个字节」最容易暴露的地方。
    @Test("55 字节边界")
    func length55() {
        // NIST 向量：`"a"` 重复 55 次
        let input = [UInt8](repeating: 0x61, count: 55)
        #expect(SHA256.hex(input) ==
            "9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318")
    }

    /// ⚠️ **长度 56 字节**（超过填充边界，需要两个块）。
    @Test("56 字节边界")
    func length56() {
        let input = [UInt8](repeating: 0x61, count: 56)
        #expect(SHA256.hex(input) ==
            "b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a")
    }

    /// 64 字节（正好一个整块，需要额外一个填充块）。
    @Test("64 字节")
    func length64() {
        let input = [UInt8](repeating: 0x61, count: 64)
        #expect(SHA256.hex(input) ==
            "ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb")
    }

    /// 输出形状：**小写**十六进制 64 位。
    ///
    /// ⚠️ 守的是：大写或长度不对的话，`isSha256Hex` 会把**自己的包**判成非法
    ///    ——「自己导出的包自己拒收」。
    @Test("输出是小写 64 位十六进制")
    func outputShape() {
        let hex = SHA256.hex([1, 2, 3])
        #expect(hex.count == 64)
        #expect(SaveManifestParser.isSha256Hex(hex), "自己的输出必须能通过自己的格式校验")
        #expect(hex.allSatisfy { $0.isLowercase || $0.isNumber })
    }

    /// 不同内容 → 不同哈希（最基本的抗碰撞直觉）。
    @Test("不同内容不同哈希")
    func differentContent() {
        #expect(SHA256.hex([1, 2, 3]) != SHA256.hex([1, 2, 4]))
    }

    /// 文件计算（真实文件）。
    @Test("文件哈希")
    func fileHash() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("sha-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let path = dir.appendingPathComponent("test.bin").path
        try Data([0x61, 0x62, 0x63]).write(to: URL(fileURLWithPath: path))

        #expect(SHA256.hexOfFile(at: path) ==
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    /// ⚠️ **读不到文件时返回 nil**，不返回空串的哈希。
    ///
    /// 守的是：返回空串哈希会让「文件不存在」看起来像「文件内容是空的」——
    /// 导入校验就会把缺失的文件判成「内容匹配」（如果导出时也记空串）。
    @Test("文件不存在返回 nil")
    func missingFile() {
        #expect(SHA256.hexOfFile(at: "/nonexistent/\(UUID().uuidString)") == nil)
    }
}
