import Security
import SwiftUI
import TsumigeyaCore

@MainActor
enum MetadataCredential {
    private static func query(_ endpoint: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "Tsumigeya.Metadata", kSecAttrAccount as String: endpoint]
    }
    static func read(endpoint: String) throws -> String {
        guard !endpoint.isEmpty else { return "" }
        var q = query(endpoint); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?; let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return "" }
        guard status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            throw MetadataFailure("无法读取作品信息密钥，请检查钥匙串权限。")
        }
        return value
    }
    static func save(_ value: String, endpoint: String) throws {
        guard !endpoint.isEmpty else { throw MetadataFailure("请先填写接口地址。") }
        let q = query(endpoint)
        if value.isEmpty {
            let status = SecItemDelete(q as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else { throw MetadataFailure("无法删除作品信息密钥。") }
            return
        }
        let attrs = [kSecValueData as String: Data(value.utf8)]
        var status = SecItemUpdate(q as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            var item = q; item.merge(attrs) { _, new in new }
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            status = SecItemAdd(item as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw MetadataFailure("无法把作品信息密钥保存到钥匙串。") }
    }
}

struct MetadataCredentialView: View {
    @EnvironmentObject private var store: AppStore
    @State private var key = ""
    @State private var message = ""
    private var endpoint: String { store.settingString(.metadataEndpoint).trimmingCharacters(in: .whitespacesAndNewlines) }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SecureField("作品信息接口密钥（本机服务可留空）", text: $key)
            Button("保存密钥") {
                do { try MetadataCredential.save(key, endpoint: endpoint); message = "密钥已保存在系统钥匙串。" }
                catch { message = error.localizedDescription }
            }
            if !message.isEmpty { Text(message).font(.caption).textSelection(.enabled) }
            Text("地址、模型和语言自动保存；密钥需单独保存，仅保存在系统钥匙串，不与游戏翻译共用。接口完整地址须包含所选协议的请求路径。普通聊天接口用于页面整理；按名称查找要求 Responses 接口与模型支持联网搜索。")
                .font(.caption).foregroundStyle(.secondary)
            Text("仅在你确认后调用，可能产生接口及搜索费用。不会上传游戏本体、存档或本机目录。语言偏好不会自动重写已保存信息，也不会自动切换到其他 RJ 的翻译版商品。")
                .font(.caption).foregroundStyle(.secondary)
        }
        .onAppear(perform: load)
        .onChange(of: endpoint) { _, _ in load() }
    }
    private func load() {
        do { key = try MetadataCredential.read(endpoint: endpoint); message = "" }
        catch { key = ""; message = error.localizedDescription }
    }
}
