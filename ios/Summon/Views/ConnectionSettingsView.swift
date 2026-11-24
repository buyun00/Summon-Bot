import SwiftUI

struct ConnectionSettingsView: View {
    @Environment(SummonStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var userName = ""
    @State private var showDisplay = false
    @State private var switching = false

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
                Section("账号与中枢") {
                    LabeledContent("账号", value: store.settings.hubUsername ?? store.settings.userName)
                    LabeledContent("中枢", value: store.settings.baseURL.isEmpty ? SummonAPIClient.defaultHubURL : store.settings.baseURL)
                    LabeledContent("实时连接", value: store.isConnected ? "已连接" : "重连中")
                    Button("退出账号", role: .destructive) {
                        Task {
                            await store.logoutHub()
                            dismiss()
                        }
                    }
                }
                Section("已绑定电脑节点（\(store.onlineNodes.count) 台在线）") {
                    if store.hubNodes.isEmpty {
                        Text("暂无已绑定电脑，请在电脑上登录同一账号。").foregroundStyle(.secondary)
                    } else {
                        ForEach(store.hubNodes) { node in
                            Button {
                                guard node.online, node.id != store.activeNodeID else { return }
                                switching = true
                                Task {
                                    await store.switchNode(node.id)
                                    switching = false
                                }
                            } label: {
                                HStack {
                                    Circle()
                                        .fill(node.online ? Color.green : Color.secondary.opacity(0.45))
                                        .frame(width: 8, height: 8)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(node.name).foregroundStyle(node.online ? .primary : .secondary)
                                        Text(node.online ? "在线" : "离线").font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    if node.id == store.activeNodeID {
                                        Text("当前配置").font(.caption).foregroundStyle(.secondary)
                                        Image(systemName: "checkmark").foregroundStyle(.tint)
                                    }
                                }
                            }
                            .disabled(!node.online || switching)
                        }
                    }
                }
                Section("通用") {
                    TextField("显示名称", text: $userName)
                    Button("保存显示名称") { store.setUserName(userName); userName = store.settings.userName }
                        .disabled(userName == store.settings.userName)
                    Button("显示与外观", systemImage: "circle.lefthalf.filled") { showDisplay = true }
                }
                Section("当前电脑的模型与配置") {
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
                    NavigationLink {
                        SummonObjectList(section: .connections)
                    } label: {
                        Label("执行连接与目录", systemImage: "link")
                    }
                    .disabled(!store.protocolReady)
                }
                Section("消息通知") {
                    Text(SummonPush.shared.status).foregroundStyle(.secondary)
                    Button("启用消息通知") { Task { await SummonPush.shared.enable() } }
                    Link("打开系统通知设置", destination: URL(string: UIApplication.openNotificationSettingsURLString)!)
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
                userName = store.settings.userName
            }
        }
    }

    private var appVersion: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "" }
}

struct SummonConnectionGuideView: View {
    @Environment(SummonStore.self) private var store
    @State private var isRegister = false
    @State private var hubURL = SummonAPIClient.defaultHubURL
    @State private var inviteCode = ""
    @State private var username = ""
    @State private var displayName = ""
    @State private var password = ""
    @State private var showAdvanced = false
    @State private var saving = false
    @State private var failure: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Image("SummonIcon").resizable().frame(width: 52, height: 52).clipShape(RoundedRectangle(cornerRadius: 14))
                Text("Summon Bot").font(.largeTitle.bold())
                Text("登录中枢账号，同时连接并管理你名下所有在线电脑。")
                    .padding(14).background(SummonTheme.surface, in: RoundedRectangle(cornerRadius: 16))
                Picker("模式", selection: $isRegister) {
                    Text("账号登录").tag(false)
                    Text("邀请码注册").tag(true)
                }
                .pickerStyle(.segmented)

                if isRegister {
                    TextField("邀请码（例如 SUMMON-XXXX-XXXX-XXXX）", text: $inviteCode)
                        .textInputAutocapitalization(.characters).autocorrectionDisabled()
                        .textFieldStyle(.roundedBorder)
                }
                TextField("用户名", text: $username)
                    .textContentType(.username)
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .textFieldStyle(.roundedBorder)
                if isRegister {
                    TextField("显示名称（可选）", text: $displayName)
                        .textFieldStyle(.roundedBorder)
                }
                SecureField(isRegister ? "密码（至少 8 位）" : "密码", text: $password)
                    .textContentType(isRegister ? .newPassword : .password)
                    .textFieldStyle(.roundedBorder)

                DisclosureGroup("自定义中枢服务器地址", isExpanded: $showAdvanced) {
                    TextField(SummonAPIClient.defaultHubURL, text: $hubURL)
                        .keyboardType(.URL).textContentType(.URL)
                        .textInputAutocapitalization(.never).autocorrectionDisabled()
                        .textFieldStyle(.roundedBorder)
                        .padding(.top, 6)
                }
                .font(.footnote)
                .foregroundStyle(.secondary)

                Button {
                    submit()
                } label: {
                    HStack {
                        Spacer()
                        Text(isRegister ? "注册并连接" : "登录")
                        Spacer()
                    }
                }
                .buttonStyle(.borderedProminent)
                .disabled(saving || username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || password.isEmpty || (isRegister && inviteCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))

                if saving { ProgressView("正在连接中枢…") }
                if let failure { InlineError(message: failure) }
                else if let migrationError = store.errorMessage { InlineError(message: migrationError) }
            }.padding(24)
        }.background(SummonTheme.background)
    }

    private func submit() {
        saving = true
        failure = nil
        Task {
            defer { saving = false }
            do {
                if isRegister {
                    try await store.registerHub(baseURL: hubURL, inviteCode: inviteCode, username: username, password: password, displayName: displayName)
                } else {
                    try await store.loginHub(baseURL: hubURL, username: username, password: password)
                }
            } catch {
                failure = error.localizedDescription
            }
        }
    }
}
