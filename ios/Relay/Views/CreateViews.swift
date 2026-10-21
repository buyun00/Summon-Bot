import SwiftUI

struct CreateBotView: View {
    @Environment(RelayStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let onCreated: (RelayRoom) -> Void
    @State private var name = ""
    @State private var avatar = RelayAvatar(shape: "clover", color: "#8F59F9")
    @State private var busy = false
    @State private var createdBot: RelayBot?
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 28) {
                    BotAvatar(shape: avatar.shape, color: avatar.color, image: avatar.image, size: 148)
                        .padding(.top, 28).padding(.bottom, 10)
                    TextField("为 Bot 取个名字", text: $name)
                        .font(.title3.weight(.medium)).multilineTextAlignment(.center)
                        .padding(18).background(RelayTheme.surface, in: RoundedRectangle(cornerRadius: 22))
                        .onChange(of: name) { _, value in name = String(value.prefix(100)) }
                    AvatarPicker(avatar: $avatar)
                    if let errorMessage { InlineError(message: errorMessage) }
                }.padding(24)
            }
            .safeAreaInset(edge: .bottom) {
                Button {
                    Task { await create() }
                } label: {
                    HStack(spacing: 10) {
                        if busy { ProgressView() }
                        Text(createdBot == nil ? "创建" : "打开聊天").font(.headline)
                    }.frame(maxWidth: .infinity).padding(.vertical, 10)
                }
                .buttonStyle(.glassProminent)
                .disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .padding(.horizontal, 28).padding(.bottom, 12)
            }
            .navigationTitle("创建新 Bot")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("关闭", systemImage: "xmark") { dismiss() }.labelStyle(.iconOnly) }
            }
        }
    }

    private func create() async {
        busy = true; errorMessage = nil
        defer { busy = false }
        do {
            let bot: RelayBot
            if let createdBot { bot = createdBot }
            else {
                bot = try await store.createBot(name: name.trimmingCharacters(in: .whitespacesAndNewlines), avatar: avatar)
                createdBot = bot
            }
            let room = try await store.openDirectMessage(bot: bot)
            dismiss(); onCreated(room)
        } catch { errorMessage = error.localizedDescription }
    }
}

struct AvatarPicker: View {
    @Binding var avatar: RelayAvatar

    var body: some View {
        VStack(spacing: 26) {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 10), count: 5), spacing: 12) {
                ForEach(AvatarPalette.shapes, id: \.id) { shape in
                    Button {
                        avatar.shape = shape.id; avatar.image = nil
                    } label: {
                        BotAvatar(shape: shape.id, color: avatar.color, size: 43)
                            .padding(6)
                            .background {
                                if avatar.shape == shape.id && avatar.image == nil {
                                    RoundedRectangle(cornerRadius: 17).stroke(.secondary, lineWidth: 2)
                                }
                            }
                    }.buttonStyle(.plain).accessibilityLabel(shape.label)
                        .accessibilityAddTraits(avatar.shape == shape.id ? .isSelected : [])
                }
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 6), spacing: 17) {
                ForEach(AvatarPalette.colors, id: \.self) { color in
                    Button { avatar.color = color; avatar.image = nil } label: {
                        Circle().fill(Color(relayHex: color)).frame(width: 30, height: 30)
                            .overlay { Circle().strokeBorder(.white.opacity(0.18), lineWidth: 1) }
                            .padding(5)
                            .overlay { if avatar.color == color { Circle().stroke(.secondary, lineWidth: 2) } }
                    }.buttonStyle(.plain).accessibilityLabel("颜色 \(color)")
                        .accessibilityAddTraits(avatar.color == color ? .isSelected : [])
                }
            }
        }
    }
}

struct CreateRoomView: View {
    @Environment(RelayStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let initialKind: String
    let onCreated: (RelayRoom) -> Void
    @State private var name = ""
    @State private var goal = ""
    @State private var kind = "group"
    @State private var members: Set<String> = []
    @State private var busy = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("会话") {
                    TextField("会话名称", text: $name)
                    Picker("交流方式", selection: $kind) {
                        Text("群聊").tag("group")
                        Text("深聊").tag("deep")
                    }
                    TextField("讨论目标", text: $goal, axis: .vertical).lineLimit(3...6)
                }
                Section("选择成员") {
                    ForEach(store.bots) { bot in
                        Button {
                            if !members.insert(bot.id).inserted { members.remove(bot.id) }
                        } label: {
                            HStack(spacing: 12) {
                                MemberAvatar(bot: bot, size: 32)
                                Text(bot.name).foregroundStyle(.primary)
                                Spacer()
                                if members.contains(bot.id) { Image(systemName: "checkmark").foregroundStyle(.tint) }
                            }.contentShape(Rectangle())
                        }.buttonStyle(.plain)
                    }
                }
                if let errorMessage { Section { InlineError(message: errorMessage) } }
            }
            .navigationTitle(kind == "deep" ? "发起深聊" : "创建群聊")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("创建") { Task { await create() } }
                        .disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || members.isEmpty || (kind == "deep" && goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                }
            }
            .overlay { if busy { ProgressView() } }
            .onAppear { kind = initialKind }
        }
    }

    private func create() async {
        busy = true; errorMessage = nil
        defer { busy = false }
        do {
            let room = try await store.createGroup(name: name, members: ["user"] + members.sorted(), goal: goal, kind: kind)
            dismiss(); onCreated(room)
        } catch { errorMessage = error.localizedDescription }
    }
}
