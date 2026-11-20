import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import QuickLook

struct ChatView: View {
    @Environment(SummonStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let roomID: String
    @State private var attachments: [SummonAttachment] = []
    @State private var showFiles = false
    @State private var photo: PhotosPickerItem?
    @State private var staging = false
    @State private var showReferences = false
    @State private var showDetails = false
    @State private var activeExecutionRef: SummonReference?
    @State private var executionsExpanded = false
    @State private var localError: String?
    @State private var nearBottom = true
    @State private var userScrolling = false
    @State private var sentRevision = 0
    @FocusState private var composing: Bool

    private struct ActiveBotItem: Identifiable, Equatable {
        let id: String
        let bot: SummonBot?
        let name: String
        let status: String
        let ref: SummonReference?
    }

    private var room: SummonRoom? { store.room(id: roomID) }
    private var draftText: Binding<String> {
        Binding(get: { store.draft(for: roomID) }, set: { store.setDraft($0, for: roomID) })
    }
    private var files: [SummonAttachment] { store.draftAttachments[roomID] ?? [] }
    private var mentions: [String] { store.draftMentions[roomID] ?? [] }
    private var references: [SummonReference] { store.draftReferences[roomID] ?? [] }
    private var replyID: String? { store.draftReplies[roomID] }
    private var directBot: SummonBot? {
        guard let room, !room.isGroup else { return nil }
        return room.members.compactMap { store.bot(id: $0) }.first
    }
    private var roomBots: [SummonBot] {
        room?.members.compactMap { store.bot(id: $0) } ?? []
    }
    private var title: String { room?.name ?? "聊天" }
    private var roomExecutions: [SummonJSONValue] { store.executionsForRoom(roomID) }
    private var activeBotItems: [ActiveBotItem] {
        var seen = Set<String>()
        var result: [ActiveBotItem] = []
        for exec in store.activeExecutionsForRoom(roomID) {
            let botID = exec["execution_actor"]["id"].string ?? exec["bot_id"].string ?? ""
            let key = botID.isEmpty ? (exec["execution_ref"]["id"].string ?? exec.prettyPrinted) : botID
            guard seen.insert(key).inserted else { continue }
            let bot = botID.isEmpty ? nil : store.bot(id: botID)
            let name = bot?.name ?? (botID.isEmpty ? "执行会话" : store.name(for: botID))
            let status = SummonFormat.status(exec["status"].stringValue)
            result.append(ActiveBotItem(id: key, bot: bot, name: name, status: status, ref: SummonReference(exec["execution_ref"])))
        }
        return result
    }
    private var pendingInputExecution: SummonJSONValue? {
        roomExecutions.first { ["needs_input", "awaiting_input"].contains($0["status"].stringValue) }
    }
    private var composerAccent: Color {
        let bot = directBot ?? roomBots.first
        return Color(summonHex: bot?.resolvedAvatar.color ?? SummonAvatar().color)
    }
    private var hasMessageContent: Bool {
        !store.draft(for: roomID).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !files.isEmpty || !references.isEmpty
    }
    private var messages: [SummonMessage] { store.messagesForRoom(roomID) }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    if messages.isEmpty && !store.isLoading {
                        ContentUnavailableView("开始聊天", systemImage: "bubble.left.and.text.bubble.right", description: Text("发一条消息给 \(title)。"))
                            .padding(.top, 70)
                    }
                    if store.canLoadOlder(roomID) {
                        Button("加载更早消息") { Task { await store.loadRoom(roomID, older: true) } }
                            .buttonStyle(.bordered).disabled(!store.protocolReady)
                    }
                    ForEach(messages) { message in
                        MessageRow(message: message, roomID: roomID) {
                            store.setDraftReply(message.id, for: roomID)
                            composing = true
                        }.id(message.id)
                            .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: 10)), removal: .identity))
                    }
                    if !roomExecutions.isEmpty {
                        executionDisclosure
                    }
                    Color.clear.frame(height: 18).id("conversation-bottom")
                }
                .padding(.horizontal, 18).padding(.top, 18).padding(.bottom, 8)
                .animation(reduceMotion ? nil : .easeOut(duration: 0.24), value: messages.last?.id)
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollEdgeEffectStyle(.soft, for: .all)
            .defaultScrollAnchor(.bottom)
            .onScrollPhaseChange { _, phase in
                switch phase {
                case .tracking, .interacting, .decelerating: userScrolling = true
                default: userScrolling = false
                }
            }
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentSize.height - geometry.visibleRect.maxY < 80
            } action: { _, atBottom in
                // A newly appended reply can move the end marker offscreen without a user scroll.
                if userScrolling || atBottom { nearBottom = atBottom }
            }
            .onScrollGeometryChange(for: CGSize.self) { geometry in
                CGSize(width: geometry.containerSize.height, height: geometry.contentSize.height + geometry.contentInsets.bottom)
            } action: { _, _ in
                // The keyboard, composer, images and streaming text can all resize independently.
                if nearBottom && !userScrolling { proxy.scrollTo("conversation-bottom", anchor: .bottom) }
            }
            .onChange(of: sentRevision) { _, _ in
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.3)) { proxy.scrollTo("conversation-bottom", anchor: .bottom) }
            }
            .onChange(of: composing) { _, _ in
                if nearBottom { withAnimation(reduceMotion ? nil : .easeOut(duration: 0.25)) { proxy.scrollTo("conversation-bottom", anchor: .bottom) } }
            }
            .onChange(of: messages.last?.id) { _, _ in
                if nearBottom { withAnimation(reduceMotion ? nil : .easeOut(duration: 0.25)) { proxy.scrollTo("conversation-bottom", anchor: .bottom) } }
            }
            .overlay(alignment: .top) {
                LinearGradient(
                    stops: [
                        .init(color: SummonTheme.background.opacity(0.95), location: 0.0),
                        .init(color: SummonTheme.background.opacity(0.76), location: 0.48),
                        .init(color: SummonTheme.background.opacity(0.26), location: 0.80),
                        .init(color: SummonTheme.background.opacity(0.0), location: 1.0)
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .frame(height: 118)
                .ignoresSafeArea(edges: .top)
                .allowsHitTesting(false)
            }
            .overlay(alignment: .bottom) {
                if !nearBottom && !messages.isEmpty {
                    Button { nearBottom = true; withAnimation { proxy.scrollTo("conversation-bottom", anchor: .bottom) } } label: {
                        Image(systemName: "chevron.down")
                            .font(.system(size: 14, weight: .semibold))
                            .frame(width: 24, height: 24)
                    }
                    .buttonStyle(.glass)
                    .buttonBorderShape(.circle)
                    .padding(.bottom, 2)
                    .transition(.scale(scale: 0.85).combined(with: .opacity))
                    .accessibilityLabel("回到最新消息")
                }
            }
        }
        .background(SummonTheme.background)
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(.hidden, for: .navigationBar)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Button { showDetails = true } label: {
                    HStack(spacing: 7) {
                        if let bot = directBot {
                            MemberAvatar(bot: bot, size: 24)
                        } else if let room {
                            RoomAvatar(room: room, size: 24, showOutline: false)
                        }
                        Text(title)
                            .summonFont(.subheadline, weight: .semibold)
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: 216)
                    .glassEffect(.regular, in: Capsule())
                }
                .buttonStyle(SummonPressStyle(compact: true))
                .accessibilityLabel("\(title)，会话设置")
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { composer }
        .task(id: roomID) { await store.selectRoom(roomID) }
        .onAppear { store.ensureRoomActive(roomID) }
        .onDisappear { store.deactivateRoom(roomID) }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): Task { await stageFiles(urls) }
            case .failure(let error): localError = error.localizedDescription
            }
        }
        .onChange(of: photo) { _, item in
            guard let item else { return }
            Task { await stagePhoto(item) }
        }
        .summonSheet(isPresented: $showDetails) { NavigationStack { RoomDetailsView(roomID: roomID) } }
        .summonSheet(item: $activeExecutionRef) { ref in
            NavigationStack {
                SummonExecutionView(ref: ref)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("关闭") { activeExecutionRef = nil }
                        }
                    }
            }
        }
        .summonSheet(isPresented: $showReferences) {
            SummonReferencePicker(roomID: roomID) { ref in
                if !references.contains(ref) { store.setDraftReferences(references + [ref], for: roomID) }
            }
        }
    }

    private var executionDisclosure: some View {
        DisclosureGroup(isExpanded: $executionsExpanded) {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(roomExecutions.enumerated()), id: \.offset) { _, exec in
                    if let ref = SummonReference(exec["execution_ref"]) {
                        let status = exec["status"].stringValue
                        let actorID = exec["execution_actor"]["id"].string ?? exec["bot_id"].string
                        let actorName = actorID.map { store.name(for: $0) } ?? "执行会话"
                        let engineName = exec["kind"].string == "conversation" ? "内部对话" : (exec["engine"].string ?? "执行")
                        Button { activeExecutionRef = ref } label: {
                            HStack(spacing: 10) {
                                if let actorID, let bot = store.bot(id: actorID) {
                                    MemberAvatar(bot: bot, size: 22, motion: ["running", "waiting", "queued"].contains(status) ? "work" : "idle")
                                }
                                VStack(alignment: .leading, spacing: 2) {
                                    Text("\(engineName) · \(actorName)")
                                        .summonFont(.footnote, weight: .medium)
                                        .foregroundStyle(.primary)
                                        .lineLimit(1)
                                    Text(SummonFormat.status(status))
                                        .summonFont(.caption2)
                                        .foregroundStyle(status == "completed" ? SummonTheme.ok : (status == "needs_input" || status == "awaiting_input") ? SummonTheme.warn : .secondary)
                                }
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 11, weight: .medium))
                                    .foregroundStyle(.tertiary)
                            }
                            .padding(.vertical, 6)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(.top, 6)
        } label: {
            Label("执行过程（\(roomExecutions.count)）", systemImage: "terminal")
                .summonFont(.caption, weight: .medium)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(SummonTheme.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay { RoundedRectangle(cornerRadius: 16).stroke(SummonTheme.bubbleStroke, lineWidth: 0.7) }
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let error = localError { InlineError(message: error).padding(.horizontal, 20) }
            if let notice = store.protocolNotice {
                SummonProtocolNotice(notice: notice, needsUpdate: store.needsClientUpdate)
            }
            if !activeBotItems.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(activeBotItems) { item in
                        Button {
                            if let ref = item.ref { activeExecutionRef = ref }
                            else { showDetails = true }
                        } label: {
                            BotWorkingIndicator(bot: item.bot, name: item.name, status: item.status, motion: "work")
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 18)
                .transition(.opacity.combined(with: .offset(y: reduceMotion ? 0 : 6)))
            }
            if let pendingExec = pendingInputExecution, let ref = SummonReference(pendingExec["execution_ref"]) {
                Button { activeExecutionRef = ref } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "questionmark.circle.fill")
                            .foregroundStyle(SummonTheme.warn)
                        Text("有待处理的确认或输入请求")
                            .summonFont(.caption, weight: .medium)
                            .foregroundStyle(.primary)
                        Spacer()
                        Text("去回复")
                            .summonFont(.caption, weight: .semibold)
                            .foregroundStyle(SummonTheme.warn)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .glassEffect(.regular, in: .rect(cornerRadius: 16))
                }
                .buttonStyle(.plain)
                .padding(.horizontal, 14)
                .transition(.opacity.combined(with: .offset(y: reduceMotion ? 0 : 6)))
            }
            if let replyID {
                HStack {
                    Label(messages.first { $0.id == replyID }?.content ?? "回复消息", systemImage: "arrowshape.turn.up.left")
                        .summonFont(.caption).lineLimit(2)
                    Spacer()
                    Button("取消回复", systemImage: "xmark.circle.fill") { store.setDraftReply(nil, for: roomID) }
                        .labelStyle(.iconOnly)
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                .background(SummonTheme.surface, in: RoundedRectangle(cornerRadius: 14))
                .padding(.horizontal, 14)
            }
            if !files.isEmpty || !references.isEmpty || !mentions.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(files) { item in
                            draftToken(item.name, icon: "doc") {
                                store.setDraftAttachments(files.filter { $0.id != item.id }, for: roomID)
                                store.discardStagedAttachment(item)
                            }
                        }
                        ForEach(references, id: \.self) { ref in
                            draftToken(store.label(ref), icon: "link") {
                                store.setDraftReferences(references.filter { $0 != ref }, for: roomID)
                            }
                        }
                        ForEach(mentions, id: \.self) { id in
                            draftToken(store.name(for: id), icon: "at") {
                                store.setDraftMentions(mentions.filter { $0 != id }, for: roomID)
                            }
                        }
                    }.padding(.horizontal, 18)
                }
            }
            if let room, !room.members.contains("user") {
                Label("正在查看 Bot 对话", systemImage: "eye").summonFont(.footnote).padding()
            } else {
                GlassEffectContainer(spacing: 12) {
                    HStack(alignment: .bottom, spacing: 10) {
                        Menu {
                            Button("选择文件", systemImage: "folder") { showFiles = true }.disabled(staging || files.count >= 8)
                            PhotosPicker(selection: $photo, matching: .images) {
                                Label("照片图库", systemImage: "photo")
                            }.disabled(staging || files.count >= 8)
                            Button("引用资料", systemImage: "link") { showReferences = true }.disabled(!store.protocolReady)
                        } label: {
                            if staging { ProgressView().frame(width: 24, height: 30) }
                            else { Image(systemName: "plus").summonFont(.title2).frame(width: 24, height: 30) }
                        }
                        .buttonStyle(.glass).buttonBorderShape(.circle)
                        .accessibilityLabel("添加附件或引用")

                        HStack(alignment: .bottom, spacing: 8) {
                            TextField("发消息", text: draftText, axis: .vertical)
                                .lineLimit(1...6).focused($composing).padding(.vertical, 8)
                            if let room {
                                Menu {
                                    ForEach(room.members.compactMap { store.bot(id: $0) }) { bot in
                                        Button {
                                            let next = mentions.contains(bot.id) ? mentions.filter { $0 != bot.id } : mentions + [bot.id]
                                            store.setDraftMentions(next, for: roomID)
                                        } label: {
                                            Label(bot.name, systemImage: mentions.contains(bot.id) ? "checkmark" : "at")
                                        }
                                    }
                                } label: {
                                    Image(systemName: "at").foregroundStyle(mentions.isEmpty ? Color.secondary : Color.primary)
                                        .padding(.vertical, 10)
                                }.accessibilityLabel("@ 成员")
                            }
                        }
                        .padding(.horizontal, 16).padding(.vertical, 3)
                        .glassEffect(.regular, in: .rect(cornerRadius: 25))

                        Button { send() } label: {
                            Image(systemName: "arrow.up").summonFont(.title3, weight: .semibold)
                        }
                        .buttonStyle(ComposerActionButtonStyle(accent: composerAccent))
                        .disabled(staging || !store.protocolReady || store.sendingRoomIDs.contains(roomID) || !hasMessageContent)
                        .accessibilityLabel("发送消息")
                    }
                }.padding(.horizontal, 14).padding(.bottom, 8)
            }
        }
        .padding(.top, 18)
        .background(alignment: .bottom) {
            LinearGradient(
                stops: [
                    .init(color: SummonTheme.background.opacity(0.0), location: 0.0),
                    .init(color: SummonTheme.background.opacity(0.65), location: 0.24),
                    .init(color: SummonTheme.background.opacity(0.92), location: 0.52),
                    .init(color: SummonTheme.background.opacity(0.98), location: 1.0)
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea(edges: .bottom)
            .allowsHitTesting(false)
        }
        .animation(reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.82), value: activeBotItems)
    }

    private func draftToken(_ title: String, icon: String, remove: @escaping () -> Void) -> some View {
        HStack(spacing: 8) {
            Label(title, systemImage: icon).lineLimit(1)
            Button("移除 \(title)", systemImage: "xmark.circle.fill", action: remove).labelStyle(.iconOnly)
        }
        .summonFont(.caption).padding(10).background(SummonTheme.surface, in: Capsule())
    }

    private func send() {
        guard store.protocolReady, room?.members.contains("user") == true,
              !store.sendingRoomIDs.contains(roomID), !staging, hasMessageContent else { return }
        nearBottom = true; userScrolling = false; sentRevision += 1
        localError = nil
        Task { await store.sendMessage(roomID: roomID) }
    }

    private func stageFiles(_ urls: [URL]) async {
        guard !staging else { return }
        staging = true; localError = nil
        let settings = store.settings
        defer { staging = false }
        for url in urls {
            guard files.count < 8 else { localError = "每条消息最多添加 8 个附件。"; break }
            do {
                let file = try await store.stageAttachment(fileURL: url)
                if Task.isCancelled || settings != store.settings { store.discardStagedAttachment(file); return }
                store.setDraftAttachments(files + [file], for: roomID)
            } catch { localError = error.localizedDescription; break }
        }
    }

    private func stagePhoto(_ item: PhotosPickerItem) async {
        guard !staging, files.count < 8 else { return }
        staging = true; localError = nil
        let settings = store.settings
        defer { staging = false; photo = nil }
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else { throw CocoaError(.fileReadCorruptFile) }
            guard !Task.isCancelled, settings == store.settings else { return }
            let type = item.supportedContentTypes.first ?? .image
            let file = try store.stageAttachment(data: data, name: "照片.\(type.preferredFilenameExtension ?? "jpg")",
                                                  mimeType: type.preferredMIMEType ?? "application/octet-stream")
            store.setDraftAttachments(files + [file], for: roomID)
        } catch { localError = error.localizedDescription }
    }
}

private struct ComposerActionButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let accent: Color

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(.white)
            .frame(width: 44, height: 44)
            .background(accent, in: Circle())
            .contentShape(Circle())
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.9 : 1)
            .animation(reduceMotion ? nil : .spring(response: 0.28, dampingFraction: 0.66), value: configuration.isPressed)
    }
}

private struct MessageRow: View {
    @Environment(SummonStore.self) private var store
    let message: SummonMessage
    let roomID: String
    let onReply: () -> Void

    private var bot: SummonBot? { store.bots.first { $0.id == message.senderId } }
    private var pending: SummonPendingMessage? { store.pendingMessage(for: message) }
    @State private var reference: SummonReference?
    @State private var failure: String?

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if message.isOwn { Spacer(minLength: 40) }
            if !message.isOwn {
                if let bot { MemberAvatar(bot: bot, size: 28) }
                else { Image(systemName: "bolt.circle").foregroundStyle(.secondary).frame(width: 28, height: 28) }
            }
            VStack(alignment: message.isOwn ? .trailing : .leading, spacing: 7) {
                HStack(spacing: 8) {
                    Text(store.name(for: message.senderId)).summonFont(.caption, weight: .medium)
                    Text(SummonFormat.time(message.createdAt)).summonFont(.caption2).foregroundStyle(.tertiary)
                }.foregroundStyle(.secondary)
                if let replyID = message.replyTo,
                   let quoted = store.messagesForRoom(roomID).first(where: { $0.id == replyID }) {
                    HStack(spacing: 8) {
                        Capsule()
                            .fill(SummonTheme.ok)
                            .frame(width: 2.5)
                        Text("\(store.name(for: quoted.senderId))：\(quoted.content)")
                            .summonFont(.caption)
                            .lineLimit(3)
                            .foregroundStyle(.secondary)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 8)
                    .background(SummonTheme.quoteBackground, in: RoundedRectangle(cornerRadius: 12))
                }
                if let replyID = message.replyTo, !store.messagesForRoom(roomID).contains(where: { $0.id == replyID }) {
                    Button("查看引用的消息") { reference = SummonReference(kind: "event", id: replyID) }.summonFont(.caption)
                }
                if !message.mentions.isEmpty {
                    HStack(spacing: 6) {
                        ForEach(message.mentions, id: \.self) { id in
                            Text("@" + store.name(for: id))
                                .summonFont(.caption2, weight: .medium)
                                .foregroundStyle(SummonTheme.ok)
                                .padding(.horizontal, 8)
                                .padding(.vertical, 3)
                                .background(SummonTheme.ok.opacity(0.14), in: Capsule())
                        }
                    }
                }
                if !message.content.isEmpty {
                    let bubbleShape = UnevenRoundedRectangle(
                        topLeadingRadius: 20,
                        bottomLeadingRadius: message.isOwn ? 20 : 6,
                        bottomTrailingRadius: message.isOwn ? 6 : 20,
                        topTrailingRadius: 20
                    )
                    MessageContentView(text: message.content, isOwn: message.isOwn)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 11)
                        .background(message.isOwn ? SummonTheme.userBubble : SummonTheme.botBubble, in: bubbleShape)
                        .overlay {
                            if !message.isOwn {
                                bubbleShape.stroke(SummonTheme.bubbleStroke, lineWidth: 0.7)
                            }
                        }
                }
                ForEach(message.attachments) { attachment in AttachmentRow(attachment: attachment) }
                ForEach(message.references, id: \.self) { ref in
                    Button { reference = ref } label: {
                        Label(store.label(ref), systemImage: "link")
                            .summonFont(.caption)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(SummonTheme.surface, in: Capsule())
                            .overlay { Capsule().stroke(SummonTheme.bubbleStroke, lineWidth: 0.6) }
                    }
                    .buttonStyle(.plain)
                }
                if let pending, pending.status != "sent" {
                    if pending.status == "sending" {
                        Label("正在发送…", systemImage: "clock").summonFont(.caption2).foregroundStyle(.secondary)
                    } else {
                        VStack(alignment: .trailing, spacing: 6) {
                            Text(pending.error ?? "保存状态待确认").summonFont(.caption2).foregroundStyle(SummonTheme.warn)
                            if pending.status == "rejected" {
                                Button("转回草稿") {
                                    do { try store.restoreRejectedMessage(pending) }
                                    catch { failure = error.localizedDescription }
                                }.summonFont(.caption).buttonStyle(.glass)
                            } else {
                                Button("查询并重试") { Task { await store.retryMessage(clientID: pending.clientID) } }
                                    .summonFont(.caption).buttonStyle(.glass).disabled(!store.protocolReady || store.sendingRoomIDs.contains(roomID))
                            }
                        }
                    }
                } else if message.isOwn {
                    let facts = store.deliveryFacts(message.id)
                    if !facts.isEmpty {
                        DisclosureGroup("消息已保存") {
                            ForEach(facts, id: \.bot_id) { fact in
                                Text("\(store.name(for: fact.bot_id)) · \(SummonFormat.status(fact.status))").summonFont(.caption2)
                            }
                        }.summonFont(.caption2).foregroundStyle(.secondary)
                    } else {
                        Text("消息已保存").summonFont(.caption2).foregroundStyle(.tertiary)
                    }
                }
                if let failure { InlineError(message: failure) }
            }
            if !message.isOwn { Spacer(minLength: 20) }
        }
        .contextMenu {
            if pending == nil || pending?.status == "sent" {
                Button("回复", systemImage: "arrowshape.turn.up.left", action: onReply)
                if let room = store.room(id: roomID), store.protocolReady {
                    let ref = SummonReference(kind: "event", id: message.id)
                    let pinned = room.pins?.contains(ref) == true
                    Button(pinned ? "取消置顶" : "置顶", systemImage: "pin") {
                        Task {
                            do { try await store.setPin(ref, in: room, remove: pinned); failure = nil }
                            catch { failure = error.localizedDescription }
                        }
                    }
                }
            }
            if !message.content.isEmpty {
                Button("复制", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.content }
                ShareLink(item: message.content)
            }
        }
        .summonSheet(item: $reference) { ref in NavigationStack { SummonReferenceView(ref: ref) } }
    }
}

private enum MessageSegment: Identifiable {
    case text(id: Int, value: String)
    case code(id: Int, language: String, code: String)

    var id: Int {
        switch self {
        case .text(let id, _): id
        case .code(let id, _, _): id
        }
    }

    static func parse(_ source: String) -> [MessageSegment] {
        let lines = source.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var segments: [MessageSegment] = []
        var textLines: [String] = []
        var codeLines: [String] = []
        var inCode = false
        var language = ""
        var nextID = 0

        func flushText() {
            let joined = textLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !joined.isEmpty {
                segments.append(.text(id: nextID, value: joined))
                nextID += 1
            }
            textLines.removeAll()
        }

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                if inCode {
                    segments.append(.code(id: nextID, language: language, code: codeLines.joined(separator: "\n")))
                    nextID += 1
                    codeLines.removeAll()
                    language = ""
                    inCode = false
                } else {
                    flushText()
                    language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                    inCode = true
                }
            } else if inCode {
                codeLines.append(line)
            } else {
                textLines.append(line)
            }
        }
        if inCode {
            segments.append(.code(id: nextID, language: language, code: codeLines.joined(separator: "\n")))
        } else {
            flushText()
        }
        return segments.isEmpty ? [.text(id: 0, value: source)] : segments
    }
}

private struct MessageContentView: View {
    let text: String
    let isOwn: Bool

    var body: some View {
        let segments = MessageSegment.parse(text)
        VStack(alignment: .leading, spacing: 10) {
            ForEach(segments) { segment in
                switch segment {
                case .text(_, let value):
                    markdownText(value)
                        .foregroundStyle(isOwn ? SummonTheme.userBubbleText : Color.primary)
                        .textSelection(.enabled)
                case .code(_, let language, let code):
                    CodeBlockCard(language: language, code: code)
                }
            }
        }
    }

    @ViewBuilder
    private func markdownText(_ value: String) -> some View {
        if let attributed = try? AttributedString(
            markdown: value,
            options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) {
            Text(attributed)
        } else {
            Text(value)
        }
    }
}

private struct CodeBlockCard: View {
    let language: String
    let code: String
    @State private var copied = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(language.isEmpty ? "代码" : language.uppercased())
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    UIPasteboard.general.string = code
                    copied = true
                    Task {
                        try? await Task.sleep(for: .milliseconds(1400))
                        copied = false
                    }
                } label: {
                    Label(copied ? "已复制" : "复制", systemImage: copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(copied ? SummonTheme.ok : .secondary)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .overlay(alignment: .bottom) {
                Rectangle().fill(SummonTheme.hairline).frame(height: 0.6)
            }

            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(size: 13, design: .monospaced))
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)
                    .padding(12)
            }
        }
        .background(SummonTheme.codeBackground, in: RoundedRectangle(cornerRadius: 12))
        .overlay { RoundedRectangle(cornerRadius: 12).stroke(SummonTheme.bubbleStroke, lineWidth: 0.7) }
    }
}

struct AttachmentRow: View {
    @Environment(SummonStore.self) private var store
    let attachment: SummonAttachment
    @State private var fileURL: URL?
    @State private var previewURL: URL?
    @State private var errorMessage: String?
    @State private var downloading = false
    @State private var previewImage: UIImage?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let previewImage {
                Image(uiImage: previewImage).resizable().scaledToFit()
                    .frame(maxHeight: 260).clipShape(RoundedRectangle(cornerRadius: 14))
            }
            Button {
                Task {
                    downloading = true
                    defer { downloading = false }
                    do { let url = try await store.attachmentFileURL(attachment); fileURL = url; previewURL = url }
                    catch { errorMessage = error.localizedDescription }
                }
            } label: {
                HStack(spacing: 10) {
                    if downloading { ProgressView() }
                    else { Image(systemName: attachment.mimeType?.hasPrefix("image/") == true ? "photo" : "doc") }
                    VStack(alignment: .leading, spacing: 3) {
                        Text(attachment.name).summonFont(.subheadline).lineLimit(2)
                        Text(attachment.formattedSize).summonFont(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 4)
                    Image(systemName: "arrow.down.circle").foregroundStyle(.secondary)
                }.padding(12).background(SummonTheme.surface, in: RoundedRectangle(cornerRadius: 16))
            }.buttonStyle(.plain).disabled(downloading || attachment.staged == true || attachment.unavailable == true || !store.protocolReady)
            if attachment.unavailable == true { Text("附件不可用").summonFont(.caption2) }
            if let fileURL { ShareLink(item: fileURL) { Label("分享文件", systemImage: "square.and.arrow.up") }.summonFont(.caption) }
            if let errorMessage { InlineError(message: errorMessage) }
        }
        .quickLookPreview($previewURL)
        .task(id: "\(attachment.id):\(store.protocolReady)") {
            guard attachment.previewUrl != nil, store.protocolReady else { return }
            do { previewImage = UIImage(data: try await store.attachmentPreviewData(attachment)) }
            catch { /* The original file remains available using the download button. */ }
        }
    }
}
