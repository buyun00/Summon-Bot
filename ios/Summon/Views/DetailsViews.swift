import SwiftUI
import PhotosUI

struct BotDetailsView: View {
    @Environment(SummonStore.self) private var store
    let botID: String
    @State private var current: SummonBot?
    @State private var name = ""
    @State private var instructions = ""
    @State private var modelConnection = ""
    @State private var modelName = ""
    @State private var thinking = ""
    @State private var avatar = SummonAvatar()
    @State private var photo: PhotosPickerItem?
    @State private var access = SummonJSONValue.null
    @State private var workspaces: [SummonJSONValue] = []
    @State private var models: [SummonJSONValue] = []
    @State private var selectedModels: Set<String> = []
    @State private var selectedWorkspaces: Set<String> = []
    @State private var busy = false
    @State private var error: String?

    private var bot: SummonBot? { current ?? store.bot(id: botID) }
    private var canEdit: Bool { store.protocolReady && current?.revision != nil && !busy }
    private var accessPath: String { "/api/bots/\(SummonAPIClient.component(botID))/access" }

    var body: some View {
        Form {
            HStack {
                Spacer()
                BotAvatar(shape: avatar.shape, color: avatar.color, image: avatar.image, size: 100,
                          secondary: avatar.secondary, ink: avatar.ink, paper: avatar.paper)
                Spacer()
            }.listRowBackground(Color.clear)
            Section("头像") {
                DisclosureGroup("选择头像") { AvatarPicker(avatar: $avatar).padding(.vertical, 12) }
                PhotosPicker(selection: $photo, matching: .images) { Label("使用自己的图片", systemImage: "photo") }
                Button("保存头像") { run { if let bot { current = try await store.setAvatar(avatar, bot: bot) } } }
                    .disabled(!store.protocolReady || busy || bot == nil)
            }
            Section("Bot 设置") {
                TextField("名称", text: $name)
                TextField("行为指令", text: $instructions, axis: .vertical).lineLimit(4...12)
                Picker("模型连接", selection: $modelConnection) {
                    Text("未绑定模型").tag("")
                    ForEach(models.filter { item in
                        let id = item["id"].stringValue
                        return access["model_ids"].array?.contains(.string(id)) == true || id == current?.model?["connection_id"].string
                    }, id: \.prettyPrinted) { item in
                        Text(item["name"].string ?? item["id"].stringValue).tag(item["id"].stringValue)
                    }
                    if let id = current?.model?["connection_id"].string,
                       !models.contains(where: { $0["id"].string == id }) { Text(id + " · 当前绑定").tag(id) }
                }
                if !modelConnection.isEmpty {
                    let entry = models.first { $0["id"].string == modelConnection }
                    let known = modelName.isEmpty || modelName == entry?["model"].string
                    TextField("模型名称", text: $modelName, prompt: Text("留空使用连接配置")).autocorrectionDisabled()
                    ModelThinkingField(label: "推理强度", defaultLabel: "继承连接", suggestions: known ? entry?["thinkingLevels"].array : nil, value: $thinking)
                }
                Button("保存 Bot 设置") { run { try await saveBot() } }.disabled(!canEdit || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if let current {
                Section("控制") {
                    LabeledContent("运行控制", value: current.isPaused ? "已暂停" : "启用")
                    if current.isPaused, let stop = current.control?["stop_status"].string { LabeledContent("停止结果", value: SummonFormat.status(stop)) }
                    Button(current.isPaused ? "恢复 Bot" : "暂停 Bot") {
                        run {
                            self.current = try await store.updateBot(current, changes: ["enabled": .bool(current.isPaused)])
                        }
                    }.disabled(!canEdit)
                }
            }
            if access["revision"].int != nil {
                Section("资源权限") {
                    DisclosureGroup("模型连接") {
                        ForEach(models, id: \.prettyPrinted) { model in
                            Toggle(model["name"].string ?? model["id"].stringValue,
                                   isOn: selection(model["id"].stringValue, in: $selectedModels))
                        }
                        ForEach(hiddenGrants("model_ids", in: models), id: \.self) { id in
                            Toggle(id + " · 现有授权", isOn: selection(id, in: $selectedModels))
                        }
                    }
                    DisclosureGroup("执行目录") {
                        ForEach(workspaces, id: \.prettyPrinted) { item in
                            Toggle(item["name"].string ?? item["id"].stringValue,
                                   isOn: selection(item["id"].stringValue, in: $selectedWorkspaces))
                        }
                        ForEach(hiddenGrants("workspace_ids", in: workspaces), id: \.self) { id in
                            Toggle(id + " · 现有授权", isOn: selection(id, in: $selectedWorkspaces))
                        }
                    }
                    Button("保存资源权限") { run { try await saveAccess() } }.disabled(!store.protocolReady || busy)
                }
            }
            Section("资料与会话") {
                NavigationLink("私有资料") { SummonObjectList(section: .files, space: SummonReference(kind: "bot", id: botID)) }
                NavigationLink("内部对话和执行会话") { SummonObjectList(section: .executions, space: SummonReference(kind: "bot", id: botID)) }
                NavigationLink("订阅与提醒") { SummonObjectList(section: .wakeups, space: SummonReference(kind: "bot", id: botID)) }
            }
            if let items = current?.memory_items, !items.isEmpty {
                Section("长期记忆与约定（\(items.count)）") {
                    ForEach(items, id: \.prettyPrinted) { item in
                        VStack(alignment: .leading, spacing: 4) {
                            let scopes = (item["applies_to"].array ?? []).map { s -> String in
                                s["kind"].string == "bot" ? "全群通用" : "仅限群 \(String(s["id"].stringValue.prefix(8)))"
                            }.joined(separator: " · ")
                            Text("\(item["item_id"].stringValue) · v\(item["revision"].int ?? 1)（\(scopes.isEmpty ? "默认范围" : scopes)）")
                                .summonFont(.subheadline).bold()
                            if let note = item["note"].string, !note.isEmpty {
                                Text(note).summonFont(.caption)
                            }
                            let deprecated = [item["supersedes"].string, item["deprecated_note"].string].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                            if !deprecated.isEmpty {
                                Text("失效/退役：\(deprecated)").summonFont(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
            if let error { InlineError(message: error) }
        }
        .navigationTitle(bot?.name ?? "Bot")
        .navigationBarTitleDisplayMode(.inline)
        .task(id: store.protocolReady) {
            if let bot, current == nil { populate(bot) }
            if store.protocolReady {
                do { try await reload() } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
            }
        }
        .onChange(of: photo) { _, item in if let item { run { try await loadAvatar(item) } } }
    }

    private func selection(_ id: String, in values: Binding<Set<String>>) -> Binding<Bool> {
        Binding(get: { values.wrappedValue.contains(id) }, set: {
            if $0 { values.wrappedValue.insert(id) } else { values.wrappedValue.remove(id) }
        })
    }

    private func hiddenGrants(_ key: String, in records: [SummonJSONValue]) -> [String] {
        let visible = Set(records.compactMap { $0["id"].string })
        return (access[key].array ?? []).compactMap(\.string).filter { !visible.contains($0) }.sorted()
    }

    private func populate(_ value: SummonBot) {
        name = value.name; instructions = value.instructions ?? ""; avatar = value.resolvedAvatar
        modelConnection = value.model?["connection_id"].stringValue ?? ""
        modelName = value.model?["id"].stringValue ?? ""
        thinking = value.model?["thinking_level"].stringValue ?? ""
    }

    private func reload() async throws {
        async let latest = store.fetchBot(botID)
        async let policy = store.request(path: accessPath)
        async let catalog = store.request(path: "/api/model-settings")
        async let locations = store.list("/api/workspaces")
        if let latestPolicy = try? await policy {
            access = latestPolicy
            selectedModels = Set((access["model_ids"].array ?? []).compactMap(\.string))
            selectedWorkspaces = Set((access["workspace_ids"].array ?? []).compactMap(\.string))
        }
        if let configured = try? await catalog { models = configured["connections"].array ?? [] }
        if let directories = try? await locations { workspaces = directories }
        let value = try await latest
        if current == nil { populate(value) }
        current = value
    }

    private func saveBot() async throws {
        guard let current else { return }
        var changes: [String: SummonJSONValue] = ["name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)),
                                                 "instructions": .string(instructions)]
        let previous = current.model ?? .null
        let thinkingLevel = thinking.trimmingCharacters(in: .whitespacesAndNewlines)
        let modelID = modelName.trimmingCharacters(in: .whitespacesAndNewlines)
        if modelConnection != (previous["connection_id"].string ?? "") || modelID != (previous["id"].string ?? "") ||
            thinkingLevel != (previous["thinking_level"].string ?? "") {
            var binding: [String: SummonJSONValue] = ["connection_id": .string(modelConnection)]
            if !modelID.isEmpty { binding["id"] = .string(modelID) }
            if !thinkingLevel.isEmpty { binding["thinking_level"] = .string(thinkingLevel) }
            changes["model"] = modelConnection.isEmpty ? .null : .object(binding)
        }
        self.current = try await store.updateBot(current, changes: changes)
    }

    private func saveAccess() async throws {
        guard let revision = access["revision"].int else { return }
        access = try await store.request(path: accessPath, method: "PATCH", body: .object([
            "revision": .number(Double(revision)), "model_ids": .array(selectedModels.sorted().map(SummonJSONValue.string)),
            "workspace_ids": .array(selectedWorkspaces.sorted().map(SummonJSONValue.string))
        ]))
    }

    private func loadAvatar(_ item: PhotosPickerItem) async throws {
        defer { photo = nil }
        guard let data = try await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        let ratio = min(1, 256 / max(image.size.width, image.size.height))
        let size = CGSize(width: max(1, image.size.width * ratio), height: max(1, image.size.height * ratio))
        let format = UIGraphicsImageRendererFormat(); format.scale = 1
        let small = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        guard let png = small.pngData(), png.base64EncodedString().count <= 390_000 else {
            throw SummonAPIError.http(0, "请使用较小的头像图片。")
        }
        avatar.image = "data:image/png;base64," + png.base64EncodedString()
    }

    private func run(_ operation: @escaping @MainActor () async throws -> Void) {
        guard !busy else { return }
        busy = true; error = nil
        Task {
            defer { busy = false }
            do { try await operation() }
            catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        }
    }
}

struct RoomDetailsView: View {
    @Environment(SummonStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let roomID: String
    @State private var editing = false
    @State private var confirmsLeave = false
    @State private var deletingGroup = false
    @State private var leaving = false
    @State private var error: String?

    private var room: SummonRoom? { store.room(id: roomID) }
    private var directBot: SummonBot? {
        guard let room, !room.isGroup else { return nil }
        return room.members.compactMap { store.bot(id: $0) }.first
    }
    private var canEdit: Bool {
        guard let room else { return false }
        return store.protocolReady && room.revision != nil
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 22) {
                if let room {
                    let roomRef = SummonReference(kind: "room", id: roomID)
                    // Hero
                    VStack(spacing: 12) {
                        if let bot = directBot {
                            MemberAvatar(bot: bot, size: 88)
                        } else {
                            RoomAvatar(room: room, size: 92)
                        }
                        VStack(spacing: 4) {
                            Text(room.name)
                                .summonFont(.title2, weight: .semibold)
                                .multilineTextAlignment(.center)
                            Text(room.isGroup ? "\(room.members.count) 位成员" : (directBot?.isPaused == true ? "已暂停" : "私聊 · 启用"))
                                .summonFont(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 8)

                    // Quick action tiles
                    HStack(spacing: 10) {
                        if let bot = directBot {
                            quickActionTile("Bot 设置", symbol: "slider.horizontal.3") {
                                BotDetailsView(botID: bot.id)
                            }
                        }
                        quickActionTile(room.isGroup ? "群资料" : "资料", symbol: "folder") {
                            SummonObjectList(section: .files, space: roomRef)
                        }
                        quickActionTile("提醒", symbol: "clock") {
                            SummonObjectList(section: .wakeups, space: roomRef)
                        }
                        quickActionTile("执行", symbol: "terminal") {
                            SummonObjectList(section: .executions, space: roomRef)
                        }
                    }

                    // Visual member avatar grid (group chats only — 1-on-1 already shows hero + Bot 设置)
                    if room.isGroup || directBot == nil {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                Text("成员")
                                    .summonFont(.footnote, weight: .semibold)
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Text("\(room.members.count)")
                                    .summonFont(.caption)
                                    .foregroundStyle(.tertiary)
                            }
                            .padding(.horizontal, 6)

                            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 4), spacing: 16) {
                                ForEach(room.members, id: \.self) { id in
                                    memberTile(id: id)
                                }
                                if canEdit {
                                    Button { editing = true } label: {
                                        VStack(spacing: 7) {
                                            ZStack {
                                                Circle()
                                                    .fill(SummonTheme.surface)
                                                    .frame(width: 48, height: 48)
                                                Circle()
                                                    .strokeBorder(SummonTheme.hairline, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                                                    .frame(width: 48, height: 48)
                                                Image(systemName: "plus")
                                                    .font(.system(size: 18, weight: .medium))
                                                    .foregroundStyle(.secondary)
                                            }
                                            Text("管理")
                                                .summonFont(.caption2)
                                                .foregroundStyle(.secondary)
                                                .lineLimit(1)
                                        }
                                        .frame(maxWidth: .infinity)
                                    }
                                    .buttonStyle(SummonPressStyle(compact: true))
                                }
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 16)
                            .background(SummonTheme.surfaceElevated, in: RoundedRectangle(cornerRadius: 22))
                            .overlay { RoundedRectangle(cornerRadius: 22).stroke(SummonTheme.bubbleStroke, lineWidth: 0.7) }
                        }
                    }

                    // Pinned items — only displayed when pins actually exist
                    let pins = room.pins ?? []
                    if !pins.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            HStack {
                                Text("置顶")
                                    .summonFont(.footnote, weight: .semibold)
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Text("\(pins.count)")
                                    .summonFont(.caption)
                                    .foregroundStyle(.tertiary)
                            }
                            .padding(.horizontal, 6)

                            VStack(spacing: 0) {
                                ForEach(Array(pins.enumerated()), id: \.element) { index, ref in
                                    HStack(spacing: 10) {
                                        NavigationLink { SummonReferenceView(ref: ref) } label: {
                                            HStack(spacing: 10) {
                                                Image(systemName: "pin.fill")
                                                    .font(.system(size: 12))
                                                    .foregroundStyle(SummonTheme.ok)
                                                Text(store.label(ref))
                                                    .summonFont(.subheadline)
                                                    .foregroundStyle(.primary)
                                                    .lineLimit(1)
                                                Spacer()
                                            }
                                            .contentShape(Rectangle())
                                        }
                                        .buttonStyle(.plain)

                                        Button {
                                            Task {
                                                do { try await store.setPin(ref, in: room, remove: true) }
                                                catch { self.error = error.localizedDescription }
                                            }
                                        } label: {
                                            Image(systemName: "xmark.circle.fill")
                                                .font(.system(size: 16))
                                                .foregroundStyle(.tertiary)
                                        }
                                        .buttonStyle(.plain)
                                        .disabled(!store.protocolReady)
                                        .accessibilityLabel("取消置顶")
                                    }
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 12)
                                    if index < pins.count - 1 {
                                        Rectangle()
                                            .fill(SummonTheme.hairline)
                                            .frame(height: 0.6)
                                            .padding(.leading, 36)
                                    }
                                }
                            }
                            .background(SummonTheme.surfaceElevated, in: RoundedRectangle(cornerRadius: 20))
                            .overlay { RoundedRectangle(cornerRadius: 20).stroke(SummonTheme.bubbleStroke, lineWidth: 0.7) }
                        }
                    }

                    if let error { InlineError(message: error) }

                    if room.archivable == true {
                        Button {
                            guard !leaving else { return }
                            leaving = true
                            Task {
                                defer { leaving = false }
                                do {
                                    if room.isArchived { try await store.restoreRoom(room) }
                                    else { try await store.archiveRoom(room) }
                                    dismiss()
                                }
                                catch { self.error = error.localizedDescription }
                            }
                        } label: {
                            Text(room.isArchived ? "移出归档" : "归档群聊")
                                .summonFont(.subheadline, weight: .medium)
                                .foregroundStyle(.primary)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 14)
                                .background(SummonTheme.surfaceElevated, in: RoundedRectangle(cornerRadius: 16))
                                .overlay { RoundedRectangle(cornerRadius: 16).stroke(SummonTheme.bubbleStroke, lineWidth: 0.7) }
                        }
                        .buttonStyle(SummonPressStyle())
                        .disabled(!canEdit || leaving)
                        .padding(.top, 6)
                    }

                    // Destructive leave button
                    if room.isGroup && room.members.contains("user") {
                        Button { deletingGroup = false; confirmsLeave = true } label: {
                            Text("退出群聊")
                                .summonFont(.subheadline, weight: .medium)
                                .foregroundStyle(.red)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 14)
                                .background(Color.red.opacity(0.09), in: RoundedRectangle(cornerRadius: 16))
                        }
                        .buttonStyle(SummonPressStyle())
                        .disabled(!canEdit || leaving)
                        .padding(.top, 6)
                    }
                    if room.deletable == true {
                        Button("删除群聊", role: .destructive) { deletingGroup = true; confirmsLeave = true }
                            .disabled(!canEdit || leaving)
                    }
                }
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 28)
        }
        .background(SummonTheme.background)
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("关闭", systemImage: "xmark") { dismiss() }
                    .labelStyle(.iconOnly)
            }
            if canEdit {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("编辑") { editing = true }
                }
            }
        }
        .summonSheet(isPresented: $editing) { if let room { RoomEditView(room: room) } }
        .confirmationDialog(deletingGroup ? "删除后，所有成员都无法再打开这个群聊。" : "退出群聊？", isPresented: $confirmsLeave, titleVisibility: .visible) {
            Button(deletingGroup ? "删除群聊" : "退出群聊", role: .destructive) {
                guard let room, !leaving else { return }
                leaving = true
                Task {
                    defer { leaving = false }
                    do {
                        if deletingGroup { try await store.deleteGroup(room) }
                        else { try await store.leaveRoom(room) }
                        dismiss()
                    }
                    catch { self.error = error.localizedDescription }
                }
            }
        }
    }

    @ViewBuilder
    private func memberTile(id: String) -> some View {
        if id == "user" {
            VStack(spacing: 7) {
                OwnerAvatarView(
                    name: store.settings.hubUsername ?? store.settings.userName,
                    signedIn: store.settings.hubUsername != nil,
                    size: 48
                )
                    .overlay { Circle().strokeBorder(SummonTheme.bubbleStroke, lineWidth: 0.8) }
                Text(store.name(for: id))
                    .summonFont(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)
        } else if let bot = store.bot(id: id) {
            NavigationLink { BotDetailsView(botID: id) } label: {
                VStack(spacing: 7) {
                    MemberAvatar(bot: bot, size: 48)
                        .opacity(bot.isPaused ? 0.45 : 1)
                    Text(bot.name)
                        .summonFont(.caption2, weight: .medium)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(SummonPressStyle(compact: true))
        } else {
            VStack(spacing: 7) {
                Circle()
                    .fill(SummonTheme.surface)
                    .frame(width: 48, height: 48)
                    .overlay {
                        Text(String(store.name(for: id).prefix(1)))
                            .summonFont(.subheadline, weight: .medium)
                            .foregroundStyle(.secondary)
                    }
                Text(store.name(for: id))
                    .summonFont(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)
        }
    }

    private func quickActionTile<Destination: View>(_ title: String, symbol: String, @ViewBuilder destination: () -> Destination) -> some View {
        NavigationLink(destination: destination) {
            VStack(spacing: 7) {
                Image(systemName: symbol)
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(.primary)
                Text(title)
                    .summonFont(.caption, weight: .medium)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 14)
            .background(SummonTheme.surfaceElevated, in: RoundedRectangle(cornerRadius: 18))
            .overlay { RoundedRectangle(cornerRadius: 18).stroke(SummonTheme.bubbleStroke, lineWidth: 0.7) }
        }
        .buttonStyle(SummonPressStyle(compact: true))
    }
}

private struct RoomEditView: View {
    @Environment(SummonStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let room: SummonRoom
    @State private var name = ""
    @State private var members: Set<String> = []
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                TextField("名称", text: $name)
                Section("成员") {
                    ForEach(store.bots) { bot in
                        Toggle(isOn: Binding(get: { members.contains(bot.id) }, set: {
                            if $0 { members.insert(bot.id) } else { members.remove(bot.id) }
                        })) {
                            Label { Text(bot.name) } icon: { MemberAvatar(bot: bot, size: 30) }
                        }
                    }
                }
                if let error { InlineError(message: error) }
            }
            .navigationTitle("编辑会话")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        busy = true
                        Task {
                            defer { busy = false }
                            do { try await store.updateRoom(room, name: name, members: members.sorted()); dismiss() }
                            catch { self.error = error.localizedDescription }
                        }
                    }.disabled(busy || !store.protocolReady)
                }
            }
            .onAppear { name = room.name; members = Set(room.members) }
        }
    }
}
