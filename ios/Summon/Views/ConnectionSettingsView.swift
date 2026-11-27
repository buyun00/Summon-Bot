import PhotosUI
import SwiftUI
import UIKit

struct ConnectionSettingsView: View {
    @Environment(SummonStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var userName = ""
    @State private var didEditName = false
    @State private var avatarPhoto: PhotosPickerItem?
    @State private var savingName = false
    @State private var updatingAvatar = false
    @State private var profileError: String?
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
                    LabeledContent("账号", value: store.settings.hubUsername ?? store.userDisplayName)
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
                Section("个人资料") {
                    HStack(spacing: 14) {
                        OwnerAvatarView(
                            name: store.userAvatarFallbackName,
                            signedIn: store.hasOwnerIdentity,
                            size: 56,
                            avatarPath: store.userProfile?.normalizedAvatarPath
                        )
                        .overlay { Circle().strokeBorder(SummonTheme.bubbleStroke, lineWidth: 1) }
                        VStack(alignment: .leading, spacing: 4) {
                            Text(store.userDisplayName)
                                .summonFont(.headline)
                            if updatingAvatar {
                                HStack(spacing: 6) {
                                    ProgressView().controlSize(.small)
                                    Text("正在更新头像…").summonFont(.caption).foregroundStyle(.secondary)
                                }
                            } else if !store.protocolReady {
                                Text("连接在线电脑后可修改头像与显示名称")
                                    .summonFont(.caption)
                                    .foregroundStyle(.secondary)
                            } else {
                                Text("头像与显示名称将在各端同步")
                                    .summonFont(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .padding(.vertical, 4)
                    PhotosPicker(selection: $avatarPhoto, matching: .images) {
                        Label(store.userProfile?.normalizedAvatarPath == nil ? "设置头像" : "更换头像", systemImage: "photo")
                    }
                    .disabled(updatingAvatar || !store.protocolReady)
                    if store.userProfile?.normalizedAvatarPath != nil {
                        Button("移除头像", role: .destructive) {
                            removeAvatar()
                        }
                        .disabled(updatingAvatar || !store.protocolReady)
                    }
                    let trimmedName = userName.trimmingCharacters(in: .whitespacesAndNewlines)
                    TextField("显示名称", text: $userName)
                        .onChange(of: userName) { _, newValue in
                            if newValue != store.editableDisplayName {
                                didEditName = true
                            }
                        }
                    if trimmedName.count > 24 {
                        Text("名字需要 1–24 个字")
                            .summonFont(.caption)
                            .foregroundStyle(SummonTheme.warn)
                    }
                    Button {
                        saveDisplayName()
                    } label: {
                        HStack {
                            Text(savingName ? "正在保存…" : "保存显示名称")
                            if savingName {
                                Spacer()
                                ProgressView().controlSize(.small)
                            }
                        }
                    }
                    .disabled(savingName || !store.protocolReady || trimmedName.isEmpty || trimmedName.count > 24 || trimmedName == store.editableDisplayName)
                    if let profileError {
                        InlineError(message: profileError)
                    }
                }
                Section("通用") {
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
            .onChange(of: store.activeNodeID) { _, _ in
                didEditName = false
                userName = store.editableDisplayName
                profileError = nil
            }
            .task(id: "\(store.activeNodeID ?? ""):\(store.protocolReady)") {
                if !didEditName {
                    userName = store.editableDisplayName
                }
                if store.protocolReady, let fetched = try? await store.fetchUserProfile(), !didEditName {
                    userName = fetched.trimmedDisplayName ?? ""
                }
            }
            .onChange(of: avatarPhoto) { _, item in
                guard let item else { return }
                uploadSelectedAvatar(item)
            }
        }
    }

    private var appVersion: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "" }

    private func saveDisplayName() {
        guard !savingName else { return }
        let trimmed = userName.trimmingCharacters(in: .whitespacesAndNewlines)
        savingName = true
        profileError = nil
        Task {
            defer { savingName = false }
            do {
                let updated = try await store.updateUserDisplayName(trimmed)
                userName = updated.trimmedDisplayName ?? ""
                didEditName = false
            } catch {
                if !Task.isCancelled {
                    profileError = error.localizedDescription
                }
            }
        }
    }

    private func uploadSelectedAvatar(_ item: PhotosPickerItem) {
        guard !updatingAvatar else { return }
        updatingAvatar = true
        profileError = nil
        Task {
            defer {
                avatarPhoto = nil
                updatingAvatar = false
            }
            do {
                guard let rawData = try await item.loadTransferable(type: Data.self) else {
                    throw SummonAPIError.http(0, "无法读取所选图片，请换一张。")
                }
                let dataUrl = try await Task.detached(priority: .userInitiated) {
                    try Self.encodeUserAvatarDataURL(from: rawData)
                }.value
                _ = try await store.uploadUserAvatar(dataUrl: dataUrl)
            } catch {
                if !Task.isCancelled {
                    profileError = error.localizedDescription
                }
            }
        }
    }

    private func removeAvatar() {
        guard !updatingAvatar else { return }
        updatingAvatar = true
        profileError = nil
        Task {
            defer { updatingAvatar = false }
            do {
                _ = try await store.deleteUserAvatar()
            } catch {
                if !Task.isCancelled {
                    profileError = error.localizedDescription
                }
            }
        }
    }

    private nonisolated static func encodeUserAvatarDataURL(from rawData: Data) throws -> String {
        guard let image = UIImage(data: rawData), image.size.width > 0, image.size.height > 0 else {
            throw SummonAPIError.http(0, "无法读取所选图片，请换一张。")
        }
        let targetSide: CGFloat = 160
        let scale = max(targetSide / image.size.width, targetSide / image.size.height)
        let drawSize = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let drawOrigin = CGPoint(x: (targetSide - drawSize.width) / 2, y: (targetSide - drawSize.height) / 2)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let rendered = UIGraphicsImageRenderer(size: CGSize(width: targetSide, height: targetSide), format: format).image { ctx in
            UIColor.white.setFill()
            ctx.fill(CGRect(origin: .zero, size: CGSize(width: targetSide, height: targetSide)))
            image.draw(in: CGRect(origin: drawOrigin, size: drawSize))
        }
        guard let jpeg = rendered.jpegData(compressionQuality: 0.8) else {
            throw SummonAPIError.http(0, "无法压缩所选图片，请换一张。")
        }
        let dataUrl = "data:image/jpeg;base64," + jpeg.base64EncodedString()
        if jpeg.count > 48 * 1024 || dataUrl.count > 100_000 {
            throw SummonAPIError.http(413, "头像太大了，换一张")
        }
        return dataUrl
    }
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
