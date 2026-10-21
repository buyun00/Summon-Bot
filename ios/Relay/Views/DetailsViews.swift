import SwiftUI
import PhotosUI

struct BotDetailsView: View {
    @Environment(RelayStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let botID: String
    @State private var name = ""
    @State private var role = ""
    @State private var expertise = ""
    @State private var prompt = ""
    @State private var avatar = RelayAvatar()
    @State private var photo: PhotosPickerItem?
    @State private var busy = false
    @State private var saved = false
    @State private var errorMessage: String?
    @State private var memories: [RelayJSONValue] = []
    @State private var editingMemory: RelayJSONValue?
    @State private var showMemoryEditor = false

    private var bot: RelayBot? { store.bots.first { $0.id == botID } }

    var body: some View {
        Form {
            Section {
                HStack {
                    Spacer()
                    BotAvatar(shape: avatar.shape, color: avatar.color, image: avatar.image, size: 112)
                    Spacer()
                }.listRowBackground(Color.clear).padding(.vertical, 14)
                DisclosureGroup("编辑头像") {
                    AvatarPicker(avatar: $avatar).padding(.vertical, 18)
                    PhotosPicker(selection: $photo, matching: .images) { Label("使用自己的图片", systemImage: "photo") }
                }
            }
            Section("Bot 资料") {
                TextField("名字", text: $name)
                TextField("主要职责", text: $role)
                TextField("专业领域", text: $expertise)
                TextField("身份与工作方式", text: $prompt, axis: .vertical).lineLimit(4...12)
                Button(saved ? "已保存" : "保存资料") { Task { await save() } }
                    .disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                if let bot {
                    Button(bot.isPaused ? "恢复 Bot" : "暂停 Bot") { Task { await toggleStatus() } }.disabled(busy)
                }
            }
            Section {
                if memories.isEmpty { Text("还没有长期记忆").foregroundStyle(.secondary) }
                ForEach(Array(memories.enumerated()), id: \.offset) { _, memory in
                    Button {
                        editingMemory = memory; showMemoryEditor = true
                    } label: {
                        VStack(alignment: .leading, spacing: 8) {
                            Text(memory["content"].string ?? memory["text"].string ?? "").foregroundStyle(.primary)
                            Text(memory["status"].string == "expired" ? "已过期" : "有效").font(.caption).foregroundStyle(.secondary)
                        }.padding(.vertical, 5)
                    }.buttonStyle(.plain)
                }
                Button("添加记忆", systemImage: "plus") { editingMemory = nil; showMemoryEditor = true }
            } header: { Text("长期记忆") }
            if let errorMessage { Section { InlineError(message: errorMessage) } }
        }
        .navigationTitle(bot?.name ?? "Bot 资料")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        .task {
            if let bot {
                name = bot.name; role = bot.role; expertise = bot.expertise; prompt = bot.prompt
                avatar = bot.avatar ?? RelayAvatar.defaultAvatar(for: bot.id)
            }
            await loadMemories()
        }
        .onChange(of: photo) { _, item in
            guard let item else { return }
            Task { await loadAvatar(item) }
        }
        .onChange(of: avatar) { _, _ in saved = false }
        .onChange(of: name) { _, _ in saved = false }
        .onChange(of: role) { _, _ in saved = false }
        .onChange(of: expertise) { _, _ in saved = false }
        .onChange(of: prompt) { _, _ in saved = false }
        .sheet(isPresented: $showMemoryEditor, onDismiss: { Task { await loadMemories() } }) {
            MemoryEditor(botID: botID, memory: editingMemory)
        }
    }

    private func save() async {
        busy = true; errorMessage = nil
        defer { busy = false }
        do {
            _ = try await store.updateBot(id: botID, name: name, role: role, expertise: expertise, prompt: prompt, avatar: avatar)
            saved = true
        } catch { errorMessage = error.localizedDescription }
    }

    private func toggleStatus() async {
        guard let bot else { return }
        busy = true; errorMessage = nil
        defer { busy = false }
        do { _ = try await store.updateBot(id: botID, status: bot.isPaused ? "active" : "paused") }
        catch { errorMessage = error.localizedDescription }
    }

    private func loadMemories() async {
        do { memories = try await store.request(path: "/api/bots/\(RelayAPIClient.component(botID))/memories")["memories"].array ?? [] }
        catch { errorMessage = error.localizedDescription }
    }

    private func loadAvatar(_ item: PhotosPickerItem) async {
        do {
            guard let data = try await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else {
                throw CocoaError(.fileReadCorruptFile)
            }
            let ratio = min(1, 256 / max(image.size.width, image.size.height))
            let size = CGSize(width: max(1, image.size.width * ratio), height: max(1, image.size.height * ratio))
            let format = UIGraphicsImageRendererFormat(); format.scale = 1
            let small = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
            guard let png = small.pngData(), png.base64EncodedString().count <= 390_000 else {
                errorMessage = "图片缩放后仍然过大，请选择较小的图片。"; return
            }
            avatar.image = "data:image/png;base64," + png.base64EncodedString()
            photo = nil
        } catch { errorMessage = error.localizedDescription }
    }
}

private struct MemoryEditor: View {
    @Environment(RelayStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let botID: String
    let memory: RelayJSONValue?
    @State private var content = ""
    @State private var status = "active"
    @State private var category = "professional"
    @State private var errorMessage: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                TextField("记忆内容", text: $content, axis: .vertical).lineLimit(6...16)
                Picker("分类", selection: $category) {
                    Text("专业记忆").tag("professional")
                    Text("私人记忆").tag("private")
                }
                Picker("状态", selection: $status) { Text("有效").tag("active"); Text("已过期").tag("expired") }
                if let errorMessage { InlineError(message: errorMessage) }
            }
            .navigationTitle(memory == nil ? "添加记忆" : "修订记忆")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { Task { await save() } }.disabled(busy || content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .onAppear {
                content = memory?["content"].string ?? memory?["text"].string ?? ""
                status = memory?["status"].string ?? "active"
                category = memory?["category"].string ?? "professional"
            }
        }
    }

    private func save() async {
        busy = true; defer { busy = false }
        var body: [String: RelayJSONValue] = ["content": .string(content), "status": .string(status), "category": .string(category)]
        let id = memory?["id"].string
        if let revision = memory?["revision"].int { body["expectedRevision"] = .number(Double(revision)) }
        let path = id.map { "/api/memories/\(RelayAPIClient.component($0))" } ?? "/api/bots/\(RelayAPIClient.component(botID))/memories"
        do { _ = try await store.request(path: path, method: id == nil ? "POST" : "PATCH", body: .object(body)); dismiss() }
        catch { errorMessage = error.localizedDescription }
    }
}

struct RoomDetailsView: View {
    @Environment(RelayStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let roomID: String
    @State private var name = ""
    @State private var goal = ""
    @State private var members: Set<String> = []
    @State private var busy = false
    @State private var errorMessage: String?
    @State private var confirmConclude = false

    private var room: RelayRoom? { store.rooms.first { $0.id == roomID } }

    var body: some View {
        Form {
            if let room {
                Section {
                    HStack { Spacer(); RoomAvatar(room: room, size: 100); Spacer() }.padding(.vertical, 16)
                    if room.kind == "dm" {
                        LabeledContent("名称", value: room.name)
                    } else {
                        TextField("会话名称", text: $name)
                        TextField("讨论目标", text: $goal, axis: .vertical).lineLimit(3...7)
                    }
                }
                Section("成员") {
                    ForEach(store.bots.filter { room.kind != "dm" || room.members.contains($0.id) }) { bot in
                        Button {
                            if !members.insert(bot.id).inserted { members.remove(bot.id) }
                        } label: {
                            HStack {
                                MemberAvatar(bot: bot, size: 32)
                                Text(bot.name).foregroundStyle(.primary)
                                Spacer()
                                if members.contains(bot.id) { Image(systemName: "checkmark") }
                            }
                        }.buttonStyle(.plain).disabled(room.kind == "dm")
                    }
                }
                Section {
                    if room.kind != "dm" {
                        Button("保存会话") { Task { await save() } }.disabled(busy || members.isEmpty || name.isEmpty)
                    }
                    ShareLink(item: store.messagesForRoom(roomID).map { "\(store.name(for: $0.senderId))：\($0.content)" }.joined(separator: "\n\n")) {
                        Label("分享会话文字", systemImage: "square.and.arrow.up")
                    }
                    if room.kind == "deep", !room.isConcluded {
                        Button("结束深聊并保留结论", role: .destructive) { confirmConclude = true }.disabled(busy)
                    }
                    if !room.summary.isEmpty { Text(room.summary).textSelection(.enabled) }
                }
            }
            if let errorMessage { Section { InlineError(message: errorMessage) } }
        }
        .navigationTitle("会话详情").navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        .onAppear {
            if let room { name = room.name; goal = room.goal; members = Set(room.members.filter { $0 != "user" }) }
        }
        .confirmationDialog("结束这段深聊？", isPresented: $confirmConclude, titleVisibility: .visible) {
            Button("结束并保留结论", role: .destructive) { Task { await conclude() } }
        }
    }

    private func save() async {
        busy = true; defer { busy = false }
        do {
            let ids = (room?.members.contains("user") == true ? ["user"] : []) + members.sorted()
            _ = try await store.updateRoom(id: roomID, name: name, members: ids, goal: goal)
            dismiss()
        } catch { errorMessage = error.localizedDescription }
    }

    private func conclude() async {
        busy = true; defer { busy = false }
        do {
            _ = try await store.request(path: "/api/rooms/\(RelayAPIClient.component(roomID))/conclude", method: "POST", body: .object([:]))
            await store.refresh(); dismiss()
        } catch { errorMessage = error.localizedDescription }
    }
}
