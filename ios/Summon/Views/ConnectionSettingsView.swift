import SwiftUI

struct ConnectionSettingsView: View {
    @Environment(SummonStore.self) private var store
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
                        Image("SummonIcon").resizable().frame(width: 52, height: 52).clipShape(RoundedRectangle(cornerRadius: 14))
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Summon Bot").summonFont(.headline)
                            Text("iOS 原生客户端").summonFont(.subheadline).foregroundStyle(.secondary)
                            Text("版本 \(appVersion)")
                                .summonFont(.caption).foregroundStyle(.secondary)
                        }
                    }.padding(.vertical, 8)
                }
                Section("通用") {
                    TextField("显示名称", text: $userName)
                    Button("保存显示名称") { store.setUserName(userName); userName = store.settings.userName }
                        .disabled(userName == store.settings.userName)
                    Button("显示与外观", systemImage: "circle.lefthalf.filled") { showDisplay = true }
                }
                Section("模型与订阅") {
                    NavigationLink {
                        ModelSettingsView(embedded: true)
                    } label: {
                        Label("模型连接", systemImage: "cpu")
                    }
                    .disabled(!store.protocolReady)
                    NavigationLink {
                        SummonObjectList(section: .wakeups)
                    } label: {
                        Label("订阅与提醒", systemImage: "clock")
                    }
                    .disabled(!store.protocolReady)
                }
                Section {
                    NavigationLink {
                        SummonObjectList(section: .connections)
                    } label: {
                        Label("执行连接与目录", systemImage: "link")
                    }
                    .disabled(!store.protocolReady)
                    TextField("https://你的实例地址", text: $baseURL)
                        .keyboardType(.URL).textContentType(.URL)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("实例访问令牌", text: $token)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                } header: { Text("连接与实例") } footer: {
                    Text("使用部署机提供的 HTTPS 地址和访问令牌。令牌保存在 iOS 钥匙串中。")
                }
                Section("消息通知") {
                    Text(SummonPush.shared.status).foregroundStyle(.secondary)
                    Button("启用消息通知") { Task { await SummonPush.shared.enable() } }
                    Link("打开系统通知设置", destination: URL(string: UIApplication.openNotificationSettingsURLString)!)
                }
                Section("连接状态") {
                    if let notice = store.protocolNotice { InlineError(message: notice) }
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
                    Text("草稿和待确认的发送保存在这台设备。重新连接后，可按原发送记录查询保存状态。")
                        .summonFont(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            .summonSheet(isPresented: $showDisplay) { SummonDisplaySettingsView() }
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
            try await store.saveConnection(baseURL: baseURL, token: token)
            dismiss()
        } catch { errorMessage = error.localizedDescription }
    }
}

struct SummonConnectionGuideView: View {
    @Environment(SummonStore.self) private var store
    @State private var address = ""
    @State private var token = ""
    @State private var awaitingToken = false
    @State private var saving = false
    @State private var failure: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Image("SummonIcon").resizable().frame(width: 52, height: 52).clipShape(RoundedRectangle(cornerRadius: 14))
                Text("连接 Summon Bot").font(.largeTitle.bold())
                Text("输入部署者提供的实例地址和访问令牌。")
                    .padding(14).background(SummonTheme.surface, in: RoundedRectangle(cornerRadius: 16))
                if awaitingToken {
                    Text(address).foregroundStyle(.secondary)
                    Text("接下来输入部署者给你的访问令牌。")
                    SecureField("访问令牌", text: $token).textFieldStyle(.roundedBorder)
                    Button("连接实例") {
                        let credential = token.trimmingCharacters(in: .whitespacesAndNewlines)
                        saving = true; failure = nil
                        Task {
                            defer { saving = false }
                            do { try await store.saveConnection(baseURL: address, token: credential) }
                            catch { failure = error.localizedDescription }
                        }
                    }.buttonStyle(.borderedProminent).disabled(saving || token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("更改地址") { awaitingToken = false; token = ""; failure = nil }.disabled(saving)
                } else {
                    TextField("https://你的实例地址", text: $address)
                        .keyboardType(.URL).textContentType(.URL).textInputAutocapitalization(.never)
                        .autocorrectionDisabled().textFieldStyle(.roundedBorder)
                    Button("继续") {
                        do { address = try SummonAPIClient.normalizedURL(address).absoluteString; awaitingToken = true; failure = nil }
                        catch { failure = error.localizedDescription }
                    }.buttonStyle(.borderedProminent).disabled(address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if saving { ProgressView("正在连接…") }
                if let failure { InlineError(message: failure) }
                else if let migrationError = store.errorMessage { InlineError(message: migrationError) }
            }.padding(24)
        }.background(SummonTheme.background)
    }
}
