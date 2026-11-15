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
    @State private var files: [SummonJSONValue] = []
    @State private var selectedModels: Set<String> = []
    @State private var selectedWorkspaces: Set<String> = []
    @State private var materialIndex = ""
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
                Picker("选材索引", selection: $materialIndex) {
                    Text("未选择").tag("")
                    ForEach(files.filter { $0["id"].string != nil }, id: \.prettyPrinted) { file in
                        Text(file["path"].stringValue).tag(file["id"].stringValue)
                    }
                    if let current = current?.material_index_ref,
                       !files.contains(where: { $0["id"].string == current.id }) {
                        Text(store.label(current)).tag(current.id)
                    }
                }
                Button("保存 Bot 设置") { run { try await saveBot() } }.disabled(!canEdit || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if let current {
                Section("控制") {
                    LabeledContent("运行控制", value: current.isPaused ? "已暂停" : "启用")
                    if current.isPaused, let stop = current.control?["stop_status"].string { LabeledContent("停止结果", value: SummonFormat.status(stop)) }
                    if !current.isPaused || (current.resume_ref?.object != nil && current.control?["stop_status"].string == "stopped") {
                        Button(current.isPaused ? "恢复 Bot" : "暂停 Bot") {
                            run {
                                var changes: [String: SummonJSONValue] = ["enabled": .bool(current.isPaused)]
                                if current.isPaused, let resume = current.resume_ref { changes["resume_ref"] = resume }
                                self.current = try await store.updateBot(current, changes: changes)
                            }
                        }.disabled(!canEdit)
                    }
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
            if let error { InlineError(message: error) }
        }
        .navigationTitle(bot?.name ?? "Bot")
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
        materialIndex = value.material_index_ref?.id ?? ""
    }

    private func reload() async throws {
        async let latest = store.fetchBot(botID)
        async let policy = store.request(path: accessPath)
        async let catalog = store.request(path: "/api/model-settings")
        async let locations = store.list("/api/workspaces")
        async let privateFiles = store.list("/api/files?bot=" + SummonAPIClient.component(botID))
        if let latestPolicy = try? await policy {
            access = latestPolicy
            selectedModels = Set((access["model_ids"].array ?? []).compactMap(\.string))
            selectedWorkspaces = Set((access["workspace_ids"].array ?? []).compactMap(\.string))
        }
        if let configured = try? await catalog { models = configured["connections"].array ?? [] }
        if let directories = try? await locations { workspaces = directories }
        if let documents = try? await privateFiles { files = documents }
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
        if materialIndex != (current.material_index_ref?.id ?? "") {
            changes["material_index_ref"] = materialIndex.isEmpty ? .null : SummonReference(kind: "file", id: materialIndex).json
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
    @State private var leaving = false
    @State private var error: String?

    private var room: SummonRoom? { store.room(id: roomID) }

    var body: some View {
        Form {
            if let room {
                Section {
                    HStack { Spacer(); RoomAvatar(room: room); Spacer() }.listRowBackground(Color.clear)
                    LabeledContent("名称", value: room.name)
                    Button("编辑名称和成员") { editing = true }.disabled(!store.protocolReady || room.revision == nil)
                }
                Section("成员") {
                    ForEach(room.members, id: \.self) { id in
                        if store.bot(id: id) != nil {
                            NavigationLink { BotDetailsView(botID: id) } label: {
                                Label { Text(store.name(for: id)) } icon: { MemberAvatar(bot: store.bot(id: id), size: 30) }
                            }
                        } else { Text(store.name(for: id)) }
                    }
                }
                Section("置顶") {
                    if room.pins?.isEmpty != false { Text("暂无置顶").foregroundStyle(.secondary) }
                    ForEach(room.pins ?? [], id: \.self) { ref in
                        NavigationLink(store.label(ref)) { SummonReferenceView(ref: ref) }
                            .swipeActions {
                                Button("移除", role: .destructive) {
                                    Task {
                                        do { try await store.setPin(ref, in: room, remove: true) }
                                        catch { self.error = error.localizedDescription }
                                    }
                                }.disabled(!store.protocolReady)
                            }
                    }
                }
                Section {
                    let ref = SummonReference(kind: "room", id: roomID)
                    NavigationLink("群资料") { SummonObjectList(section: .files, space: ref) }
                    NavigationLink("订阅与提醒") { SummonObjectList(section: .wakeups, space: ref) }
                    NavigationLink("执行会话和内部对话") { SummonObjectList(section: .executions, space: ref) }
                }
                if room.isGroup && room.members.contains("user") {
                    Section {
                        Button("退出群聊", role: .destructive) { confirmsLeave = true }
                            .disabled(!store.protocolReady || room.revision == nil || leaving)
                    }
                }
            }
            if let error { InlineError(message: error) }
        }
        .navigationTitle("会话详情")
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("关闭") { dismiss() } } }
        .summonSheet(isPresented: $editing) { if let room { RoomEditView(room: room) } }
        .confirmationDialog("退出群聊？", isPresented: $confirmsLeave, titleVisibility: .visible) {
            Button("退出群聊", role: .destructive) {
                guard let room, !leaving else { return }
                leaving = true
                Task {
                    defer { leaving = false }
                    do { try await store.leaveRoom(room); dismiss() }
                    catch { self.error = error.localizedDescription }
                }
            }
        }
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
                        Toggle(bot.name, isOn: Binding(get: { members.contains(bot.id) }, set: {
                            if $0 { members.insert(bot.id) } else { members.remove(bot.id) }
                        }))
                    }
                }
                if let error { InlineError(message: error) }
            }
            .navigationTitle("编辑会话")
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
