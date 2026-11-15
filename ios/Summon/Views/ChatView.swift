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
    @State private var localError: String?
    @State private var nearBottom = true
    @State private var userScrolling = false
    @State private var sentRevision = 0
    @FocusState private var composing: Bool

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
    private var title: String { room?.name ?? "聊天" }
    private var composerAccent: Color {
        let bot = directBot ?? room?.members.compactMap { store.bot(id: $0) }.first
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
                            .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: 12)), removal: .identity))
                    }
                    Color.clear.frame(height: 18).id("conversation-bottom")
                }
                .padding(.horizontal, 18).padding(.top, 18).padding(.bottom, 8)
                .animation(reduceMotion ? nil : .easeOut(duration: 0.24), value: messages.last?.id)
            }
            .scrollDismissesKeyboard(.interactively)
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
            .overlay(alignment: .bottomTrailing) {
                if !nearBottom && !messages.isEmpty {
                    Button { nearBottom = true; withAnimation { proxy.scrollTo("conversation-bottom", anchor: .bottom) } } label: {
                        Image(systemName: "arrow.down").frame(width: 26, height: 30)
                    }.buttonStyle(.glass).buttonBorderShape(.circle).padding(16)
                        .accessibilityLabel("回到最新消息")
                }
            }
        }
        .background(SummonTheme.background)
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showDetails = true } label: {
                    if let bot = directBot { MemberAvatar(bot: bot, size: 30) }
                    else { Image(systemName: "info.circle") }
                }.accessibilityLabel("会话详情")
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
        .summonSheet(isPresented: $showReferences) {
            SummonReferencePicker(roomID: roomID) { ref in
                if !references.contains(ref) { store.setDraftReferences(references + [ref], for: roomID) }
            }
        }
    }

    private var composer: some View {
        VStack(spacing: 8) {
            if let error = localError { InlineError(message: error).padding(.horizontal, 20) }
            if let notice = store.protocolNotice {
                SummonProtocolNotice(notice: notice, needsUpdate: store.needsClientUpdate)
            }
            if let replyID {
                HStack {
                    Label(messages.first { $0.id == replyID }?.content ?? "回复消息", systemImage: "arrowshape.turn.up.left")
                        .summonFont(.caption).lineLimit(2)
                    Spacer()
                    Button("取消回复", systemImage: "xmark.circle.fill") { store.setDraftReply(nil, for: roomID) }
                        .labelStyle(.iconOnly)
                }.padding(.horizontal, 22)
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
        }.padding(.top, 8)
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
                    Text("\(store.name(for: quoted.senderId))：\(quoted.content)").summonFont(.caption).lineLimit(3)
                        .foregroundStyle(.secondary).padding(10)
                        .background(SummonTheme.surface, in: RoundedRectangle(cornerRadius: 12))
                }
                if let replyID = message.replyTo, !store.messagesForRoom(roomID).contains(where: { $0.id == replyID }) {
                    Button("查看引用的消息") { reference = SummonReference(kind: "event", id: replyID) }.summonFont(.caption)
                }
                if !message.mentions.isEmpty {
                    Text(message.mentions.map { "@" + store.name(for: $0) }.joined(separator: " ")).summonFont(.caption)
                }
                if !message.content.isEmpty {
                    Text(.init(message.content))
                        .textSelection(.enabled)
                        .padding(.horizontal, message.isOwn ? 14 : 0)
                        .padding(.vertical, message.isOwn ? 14 : 12)
                        .background {
                            // Grow the bot bubble around the existing text area, preserving its line width.
                            RoundedRectangle(cornerRadius: 21).fill(SummonTheme.surface)
                                .padding(.horizontal, message.isOwn ? 0 : -10)
                        }
                }
                ForEach(message.attachments) { attachment in AttachmentRow(attachment: attachment) }
                ForEach(message.references, id: \.self) { ref in
                    Button(store.label(ref), systemImage: "link") { reference = ref }.summonFont(.caption)
                }
                if let pending, pending.status != "sent" {
                    if pending.status == "sending" {
                        Label("正在发送…", systemImage: "clock").summonFont(.caption2).foregroundStyle(.secondary)
                    } else {
                        VStack(alignment: .trailing, spacing: 6) {
                            Text(pending.error ?? "保存状态待确认").summonFont(.caption2).foregroundStyle(.orange)
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
                    DisclosureGroup("消息已保存") {
                        ForEach(facts, id: \.bot_id) { fact in
                            Text("\(store.name(for: fact.bot_id)) · \(SummonFormat.status(fact.status))").summonFont(.caption2)
                        }
                    }.summonFont(.caption2).foregroundStyle(.secondary)
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
        .sheet(item: $reference) { ref in NavigationStack { SummonReferenceView(ref: ref) } }
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
