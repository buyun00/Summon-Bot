import SwiftUI

struct ConnectionSettingsView: View {
    @Environment(RelayStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var baseURL = ""
    @State private var token = ""
    @State private var userName = ""
    @State private var saving = false
    @State private var errorMessage: String?
    @State private var showDisplay = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 16) {
                        Image("RelayIcon").resizable().frame(width: 52, height: 52).clipShape(RoundedRectangle(cornerRadius: 14))
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Relay Bot").relayFont(.headline)
                            Text("iOS 原生客户端").relayFont(.subheadline).foregroundStyle(.secondary)
                            Text("版本 \(appVersion)")
                                .relayFont(.caption).foregroundStyle(.secondary)
                        }
                    }.padding(.vertical, 8)
                }
                Section("个人信息") {
                    TextField("显示名称", text: $userName)
                }
                Section {
                    Button("显示设置", systemImage: "textformat.size") { showDisplay = true }
                }
                Section {
                    TextField("https://bot.lin0.org", text: $baseURL)
                        .keyboardType(.URL).textContentType(.URL)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("访问令牌（如服务需要）", text: $token)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                } header: { Text("服务连接") } footer: {
                    Text("填写现有 Relay Web 服务地址。直接连接网关时填写访问令牌，令牌保存在 iOS 钥匙串中。")
                }
                Section("连接状态") {
                    LabeledContent("实时消息", value: store.isConnected ? "已连接" : "未连接")
                    LabeledContent("Bot", value: "\(store.bots.count)")
                    LabeledContent("会话", value: "\(store.rooms.count)")
                    if let errorMessage { InlineError(message: errorMessage) }
                    Button {
                        Task { await save() }
                    } label: {
                        HStack {
                            Text("保存并连接")
                            Spacer()
                            if saving { ProgressView() } else { Image(systemName: "arrow.triangle.2.circlepath") }
                        }
                    }.disabled(saving || baseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                Section {
                    Text("已读取的会话和草稿保存在这台设备，失败消息需要手动重试。切换服务时会清除这台设备上的会话缓存。")
                        .relayFont(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            .relaySheet(isPresented: $showDisplay) { RelayDisplaySettingsView() }
            .onAppear {
                baseURL = store.settings.baseURL
                userName = store.settings.userName
                token = store.savedToken
            }
        }
    }

    private var appVersion: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "" }

    private func save() async {
        saving = true; errorMessage = nil
        defer { saving = false }
        do {
            try await store.saveConnection(baseURL: baseURL, token: token, userName: userName)
            dismiss()
        } catch { errorMessage = error.localizedDescription }
    }
}
