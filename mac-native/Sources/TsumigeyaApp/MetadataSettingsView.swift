import Security
import SwiftUI
import TsumigeyaCore

@MainActor
enum MetadataCredential {
    private static func query(_ endpoint: String, search: Bool) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: search ? "Tsumigeya.Metadata.Search" : "Tsumigeya.Metadata", kSecAttrAccount as String: endpoint]
    }
    static func read(endpoint: String, search: Bool = false) throws -> String {
        guard !endpoint.isEmpty else { return "" }
        var q = query(endpoint, search: search); q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?; let status = SecItemCopyMatching(q as CFDictionary, &result)
        if status == errSecItemNotFound { return "" }
        guard status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) else {
            throw MetadataFailure("无法读取作品信息密钥，请检查钥匙串权限。")
        }
        return value
    }
    static func save(_ value: String, endpoint: String, search: Bool = false) throws {
        guard !endpoint.isEmpty else { throw MetadataFailure("请先填写接口地址。") }
        let q = query(endpoint, search: search)
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
    var search = false
    @State private var key = ""
    @State private var message = ""
    private var endpoint: String { search ? store.metadataSearchSettings.effectiveEndpoint : store.metadataAPISettings.endpoint }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            SecureField(search ? "独立搜索密钥（不与模型共用）" : "作品信息接口密钥（本机服务可留空）", text: $key)
            Button("保存密钥") {
                do { try MetadataCredential.save(key, endpoint: endpoint, search: search); message = "密钥已保存在系统钥匙串。" }
                catch { message = error.localizedDescription }
            }
            if !message.isEmpty { Text(message).font(.caption).textSelection(.enabled) }
            Text(search ? "搜索密钥单独保存在系统钥匙串，通过认证请求头发送，不写入地址或附加参数。自定义接口目前支持 Bearer 认证；需要其他认证方式时请使用自己的转换服务。" : "地址、模型和语言自动保存；密钥需单独保存，仅保存在系统钥匙串，不与翻译或搜索共用。聊天接口可配独立搜索；模型原生搜索仍要求 Responses 支持联网工具。")
                .font(.caption).foregroundStyle(.secondary)
            Text("仅在你确认后调用，可能产生模型或搜索费用；不会自动重试或切换收费服务。不会上传游戏本体、存档或本机目录。搜索词会发给搜索服务，页面正文只发给模型接口。")
                .font(.caption).foregroundStyle(.secondary)
        }
        .onAppear(perform: load)
        .onChange(of: endpoint) { _, _ in load() }
    }
    private func load() {
        do { key = try MetadataCredential.read(endpoint: endpoint, search: search); message = "" }
        catch { key = ""; message = error.localizedDescription }
    }
}


struct MetadataLANPermissionView: View {
    @EnvironmentObject private var store: AppStore
    let search: Bool
    @State private var confirming = false
    @State private var requestedEndpoint = ""
    private var endpoint: String { search ? store.metadataSearchSettings.effectiveEndpoint : store.metadataAPISettings.endpoint }
    private var grantKey: SettingsGroups.Key { search ? .metadataSearchLANEndpoint : .metadataLANEndpoint }
    private var enabled: Bool { !endpoint.isEmpty && store.settingString(grantKey) == endpoint }
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Toggle(search ? "授权当前局域网搜索接口" : "授权当前局域网模型接口", isOn: Binding(
                get: { enabled }, set: { value in
                    if value { requestedEndpoint = endpoint; confirming = true } else { store.setSetting(grantKey, .string("")) }
                }))
                .disabled(!enabled && (URL(string: endpoint)?.scheme != "http" || MetadataEndpoint.url(endpoint, authorizedLANEndpoint: endpoint) == nil || MetadataEndpoint.url(endpoint) != nil))
            Text("只有局域网 HTTP 需要授权，本机回环和 HTTPS 无需授权。仅授权当前完整地址，修改后撤销。明文连接只能在可信网络使用，正文和密钥可能被网络中的其他设备读取。不会放宽网页和封面的公网限制。")
                .font(.caption).foregroundStyle(.secondary)
        }
        .alert("授权当前局域网接口？", isPresented: $confirming) {
            Button("取消", role: .cancel) {}
            Button("授权此地址") {
                guard endpoint == requestedEndpoint else { return }
                store.setSetting(grantKey, .string(requestedEndpoint))
            }
        } message: { Text("只连接你信任的服务：\n" + requestedEndpoint + "\n不会开放端口或修改防火墙。更推荐使用 HTTPS 或安全隧道。") }
    }
}


struct MetadataSearchParametersEditor: View {
    @EnvironmentObject private var store: AppStore
    @State private var draft = "{}"
    @State private var error = ""
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField("自定义搜索附加参数（JSON）", text: $draft)
            Button("保存非敏感参数") {
                guard draft.utf8.count <= 8000, let object = try? JSONDecoder().decode(JSONValue.self, from: Data(draft.utf8)).objectValue,
                      !MetadataSearchService.containsSecret(object) else { error = "请输入不含密钥或令牌的 JSON 对象；未保存。"; return }
                store.setSetting(.metadataSearchParameters, .string(draft)); error = ""
            }.disabled(draft == store.settingString(.metadataSearchParameters))
            if !error.isEmpty { Text(error).font(.caption).foregroundStyle(.orange) }
            Text("附加参数需单独确认保存，只填非敏感参数；认证请用密钥框。关键词自动写入，不支持 Cookie 或任意认证头。") .font(.caption).foregroundStyle(.secondary)
        }.onAppear { draft = store.settingString(.metadataSearchParameters) }
    }
}


struct MetadataSettingsForm: View {
    @EnvironmentObject private var store: AppStore
    private let languages: [SettingsGroups.Key] = [.metadataPreferredLanguage, .metadataFallbackLanguage]
    private let model: [SettingsGroups.Key] = [.metadataEndpoint, .metadataLANEndpoint, .metadataModel, .metadataMode]
    private let options: [SettingsGroups.Key] = [.metadataTimeout, .metadataInputLimit, .metadataJSONOutput, .metadataDisableThinking]
    private let search: [SettingsGroups.Key] = [.metadataSearchEndpoint, .metadataSearchLANEndpoint, .metadataSearchLimit]
    private let custom: [SettingsGroups.Key] = [.metadataSearchMethod, .metadataSearchQueryKey, .metadataSearchResultsPath, .metadataSearchTitlePath, .metadataSearchURLPath, .metadataSearchSummaryPath, .metadataSearchParameters]
    var body: some View {
        Section("资料语言") { ForEach(languages, id: \.self) { SettingRow(key: $0) } }
        Section("整理资料的模型") {
            ForEach(model, id: \.self) { SettingRow(key: $0) }
            DisclosureGroup("本地模型与兼容选项") { ForEach(options, id: \.self) { SettingRow(key: $0) } }
            MetadataCredentialView()
        }
        Section("搜索来源") {
            SettingRow(key: .metadataSearchProvider)
            if !["disabled", "native"].contains(store.settingString(.metadataSearchProvider)) {
                ForEach(search, id: \.self) { SettingRow(key: $0) }
                if store.settingString(.metadataSearchProvider) == "custom" {
                    DisclosureGroup("自定义搜索请求与字段映射") { ForEach(custom, id: \.self) { SettingRow(key: $0) } }
                }
                MetadataCredentialView(search: true)
            }
        }
    }
}
