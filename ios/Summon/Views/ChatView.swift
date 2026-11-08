import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import QuickLook

struct ChatView: View {
    @Environment(SummonStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let roomID: String
    @State private var text = ""
    @State private var attachments: [SummonAttachment] = []
    @State private var reply: SummonMessage?
    @State private var target = ""
    @State private var showFiles = false
    @State private var photo: PhotosPickerItem?
    @State private var uploading = false
    @State private var showDetails = false
    @State private var localError: String?
    @State private var nearBottom = true
    @State private var userScrolling = false
    @State private var sentRevision = 0
    @FocusState private var composing: Bool

    private var room: SummonRoom? { store.rooms.first { $0.id == roomID } }
    private var directBot: SummonBot? {
        guard let room, room.kind == "dm", room.members.contains("user") else { return nil }
        return store.bots.first { room.members.contains($0.id) }
    }
    private var title: String { directBot?.name ?? room?.name ?? "聊天" }
    private var composerAccent: Color {
        let bot = directBot ?? room?.members.compactMap { store.bot(id: $0) }.first
        return Color(summonHex: bot?.resolvedAvatar.color ?? SummonAvatar().color)
    }
    private var hasMessageContent: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty
    }
    private var messages: [SummonMessage] { store.messagesForRoom(roomID) }
    private var workingBots: [SummonBot] {
        let jobs = store.selectedRoomID == roomID ? store.jobs : []
        let repliedJobs = Set(messages.filter { !$0.isOwn && $0.kind != "error" }.compactMap(\.jobId))
        var ids = Set(jobs.filter { $0.isActive && !repliedJobs.contains($0.id) }.map(\.botId))
        for run in store.agentRuns where run.roomId == roomID && run.isActive {
            guard let botID = run.botId else { continue }
            if let detail = store.agentRunDetails[run.id], !detail.isActive { continue }
            if let job = jobs.first(where: { $0.taskId == run.id || $0.agentRunId == run.id }) {
                if job.isActive && !repliedJobs.contains(job.id) { ids.insert(botID) }
            } else {
                ids.insert(botID)
            }
        }
        // A group message without a target has not yet been assigned to a Bot.
        for pending in store.pendingMessages where pending.roomID == roomID && ["sending", "sent"].contains(pending.status) {
            if let target = pending.message.toBotId { ids.insert(target) }
            else if let directBot { ids.insert(directBot.id) }
        }
        for bot in store.bots where bot.activity?.phase == "waiting" && bot.activity?.roomId == roomID {
            ids.insert(bot.id)
        }
        return store.bots.filter { ids.contains($0.id) && !$0.isPaused }
    }

    private var pendingStatus: String? {
        let pending = store.pendingMessages.filter { $0.roomID == roomID && ["sending", "sent"].contains($0.status) }
        guard !pending.isEmpty else { return nil }
        return pending.contains { $0.status == "sending" } ? "正在发送…" : "正在安排回复…"
    }

    private var hasWorkingIndicator: Bool { !workingBots.isEmpty || pendingStatus != nil }

    private func workingStatus(for bot: SummonBot, at date: Date) -> String {
        let job = store.selectedRoomID == roomID ? store.jobs.last { $0.botId == bot.id && $0.isActive } : nil
        let run = store.agentRuns.last {
            $0.roomId == roomID && $0.botId == bot.id && $0.isActive
                && (job?.taskId == nil || job?.taskId == $0.id || job?.agentRunId == $0.id)
        }
        let runID = job?.taskId ?? job?.agentRunId ?? run?.id
        let detail = runID.flatMap { store.agentRunDetails[$0] }
        let status = detail?.status ?? run?.status ?? job?.status
        if let activity = run?.activity ?? detail?.activity { return activity.label }
        if job == nil, let activity = bot.activity, activity.phase == "waiting", activity.roomId == roomID { return activity.label }
        if status == "queued" { return "等待执行" }
        if status == "accepted" { return "已接收，准备处理" }
        if status == "waiting" { return "正在等待已登记的工作条件" }
        return "正在分析任务并准备下一步"
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    if messages.isEmpty && !store.isLoading {
                        ContentUnavailableView("开始聊天", systemImage: "bubble.left.and.text.bubble.right", description: Text("发一条消息给 \(title)。"))
                            .padding(.top, 70)
                    }
                    ForEach(messages) { message in
                        MessageRow(message: message, roomID: roomID) {
                            reply = message
                            composing = true
                        }.id(message.id)
                            .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: 12)), removal: .identity))
                    }
                    if hasWorkingIndicator {
                        TimelineView(.periodic(from: .now, by: 6)) { context in
                            let bots = workingBots
                            VStack(alignment: .leading, spacing: 6) {
                                ForEach(bots) { bot in
                                    BotWorkingIndicator(bot: bot, name: room?.kind == "dm" ? "" : bot.name,
                                        status: workingStatus(for: bot, at: context.date),
                                        motion: store.agentRuns.last { $0.roomId == roomID && $0.botId == bot.id && $0.isActive }?.activity?.motion)
                                }
                                if bots.isEmpty, let pendingStatus { BotWorkingIndicator(bot: nil, status: pendingStatus) }
                            }
                        }
                        .id("conversation-working")
                        .transition(.opacity)
                    }
                    Color.clear.frame(height: 18).id("conversation-bottom")
                }
                .padding(.horizontal, 18).padding(.top, 18).padding(.bottom, 8)
                .animation(reduceMotion ? nil : .easeOut(duration: 0.24), value: messages.last?.id)
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.3), value: hasWorkingIndicator)
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
            .onChange(of: workingBots.map(\.id)) { _, _ in
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
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                SummonOnboardingStepView(roomID: roomID)
                composer
            }
        }
        .task(id: roomID) {
            text = store.draft(for: roomID)
            attachments = store.draftAttachments[roomID] ?? []
            target = store.draftTargets[roomID] ?? ""
            await store.selectRoom(roomID)
            if let replyID = store.draftReplies[roomID] {
                reply = store.messagesForRoom(roomID).first { $0.id == replyID }
            }
        }
        .onAppear { store.ensureRoomActive(roomID) }
        .onDisappear { store.deactivateRoom(roomID) }
        .onChange(of: text) { _, value in store.setDraft(value, for: roomID) }
        .onChange(of: attachments) { _, value in store.setDraftAttachments(value, for: roomID) }
        .onChange(of: target) { _, value in store.setDraftTarget(value.isEmpty ? nil : value, for: roomID) }
        .onChange(of: reply?.id) { _, value in store.setDraftReply(value, for: roomID) }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls): Task { await upload(urls) }
            case .failure(let error): localError = error.localizedDescription
            }
        }
        .onChange(of: photo) { _, item in
            guard let item else { return }
            Task { await uploadPhoto(item) }
        }
        .summonSheet(isPresented: $showDetails) {
            NavigationStack {
                if let bot = directBot { BotDetailsView(botID: bot.id) }
                else { RoomDetailsView(roomID: roomID) }
            }
        }
    }

    private var composer: some View {
        VStack(spacing: 8) {
            if let error = localError { InlineError(message: error).padding(.horizontal, 20) }
            if let reply {
                HStack {
                    Label(String(reply.content.prefix(90)), systemImage: "arrowshape.turn.up.left")
                        .summonFont(.caption).foregroundStyle(.secondary).lineLimit(2)
                    Spacer()
                    Button { self.reply = nil } label: { Image(systemName: "xmark.circle.fill") }
                        .accessibilityLabel("取消回复")
                }.padding(.horizontal, 22)
            }
            if !attachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack {
                        ForEach(attachments) { item in
                            HStack(spacing: 8) {
                                Image(systemName: "doc")
                                Text(item.name).summonFont(.caption).lineLimit(1)
                                Button { attachments.removeAll { $0.id == item.id } } label: { Image(systemName: "xmark.circle.fill") }
                                    .accessibilityLabel("移除 \(item.name)")
                            }.padding(10).background(SummonTheme.surface, in: Capsule())
                        }
                    }.padding(.horizontal, 18)
                }
            }
            if room?.isConcluded == true {
                Label("深聊已结束，结论已保留", systemImage: "checkmark.bubble")
                    .summonFont(.footnote).foregroundStyle(.secondary).padding()
            } else if let room, !room.members.contains("user") {
                Label("正在查看 Bot 之间的对话", systemImage: "eye")
                    .summonFont(.footnote).foregroundStyle(.secondary).padding()
            } else {
                GlassEffectContainer(spacing: 12) {
                    HStack(alignment: .bottom, spacing: 10) {
                        Menu {
                            Button("选择文件", systemImage: "folder") { showFiles = true }
                            PhotosPicker(selection: $photo, matching: .images) {
                                Label("照片图库", systemImage: "photo")
                            }
                        } label: {
                            if uploading { ProgressView().frame(width: 24, height: 30) }
                            else { Image(systemName: "plus").summonFont(.title2).frame(width: 24, height: 30) }
                        }
                        .buttonStyle(.glass).buttonBorderShape(.circle)
                        .disabled(uploading || attachments.count >= 8)
                        .accessibilityLabel("添加附件")

                        HStack(alignment: .bottom, spacing: 8) {
                            TextField("给 \(title) 发消息", text: $text, axis: .vertical)
                                .lineLimit(1...6).focused($composing).padding(.vertical, 8)
                            if room?.kind != "dm" {
                                Menu {
                                    Picker("消息对象", selection: $target) {
                                        Text("所有成员").tag("")
                                        ForEach(store.bots.filter { room?.members.contains($0.id) == true }) { bot in
                                            Text(bot.name).tag(bot.id)
                                        }
                                    }
                                } label: {
                                    Image(systemName: "at").foregroundStyle(target.isEmpty ? Color.secondary : Color.primary)
                                        .padding(.vertical, 10)
                                }.accessibilityLabel("选择消息对象")
                            }
                        }
                        .padding(.horizontal, 16).padding(.vertical, 3)
                        .glassEffect(.regular, in: .rect(cornerRadius: 25))

                        Button { send() } label: {
                            Image(systemName: hasMessageContent ? "arrow.up" : "mic.fill")
                                .summonFont(.title3, weight: .semibold)
                        }
                        .buttonStyle(ComposerActionButtonStyle(accent: composerAccent))
                        .disabled(uploading || !store.isConfigured || store.sendingRoomIDs.contains(roomID) || !hasMessageContent)
                        .accessibilityLabel(hasMessageContent ? "发送消息" : "语音输入（暂未开放）")
                    }
                }.padding(.horizontal, 14).padding(.bottom, 8)
            }
        }.padding(.top, 8)
    }

    private func send() {
        guard store.isConfigured, room?.members.contains("user") == true,
              !store.sendingRoomIDs.contains(roomID), !uploading else { return }
        let content = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty || !attachments.isEmpty else { return }
        let files = attachments, replyID = reply?.id, targetID = target.isEmpty ? nil : target
        nearBottom = true; userScrolling = false; sentRevision += 1
        text = ""; attachments = []; reply = nil; localError = nil
        Task {
            await store.sendMessage(roomID: roomID, content: content, attachments: files, toBotID: targetID, replyTo: replyID)
        }
    }

    private func upload(_ urls: [URL]) async {
        guard !uploading else { return }
        uploading = true; localError = nil
        defer { uploading = false }
        for url in urls {
            guard attachments.count < 8 else { localError = "每条消息最多添加 8 个附件。"; break }
            let granted = url.startAccessingSecurityScopedResource()
            defer { if granted { url.stopAccessingSecurityScopedResource() } }
            do { attachments.append(try await store.uploadAttachment(fileURL: url)) }
            catch { localError = error.localizedDescription; break }
        }
    }

    private func uploadPhoto(_ item: PhotosPickerItem) async {
        guard !uploading, attachments.count < 8 else { return }
        uploading = true; localError = nil
        defer { uploading = false; photo = nil }
        do {
            guard let data = try await item.loadTransferable(type: Data.self) else {
                throw CocoaError(.fileReadCorruptFile)
            }
            let type = item.supportedContentTypes.first ?? .image
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("photo-\(UUID().uuidString).\(type.preferredFilenameExtension ?? "jpg")")
            try data.write(to: url)
            defer { try? FileManager.default.removeItem(at: url) }
            attachments.append(try await store.uploadAttachment(fileURL: url))
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
    private var pending: SummonPendingMessage? { store.pendingMessages.first { $0.clientID == message.clientId } }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if message.isOwn { Spacer(minLength: 40) }
            if !message.isOwn {
                if let bot { MemberAvatar(bot: bot, size: 28) }
                else { Image(systemName: "bolt.circle").foregroundStyle(.secondary).frame(width: 28, height: 28) }
            }
            VStack(alignment: message.isOwn ? .trailing : .leading, spacing: 7) {
                HStack(spacing: 8) {
                    Text(message.isOwn ? store.settings.userName : bot?.name ?? "系统").summonFont(.caption, weight: .medium)
                    Text(SummonFormat.time(message.createdAt)).summonFont(.caption2).foregroundStyle(.tertiary)
                }.foregroundStyle(.secondary)
                if let replyID = message.replyTo,
                   let quoted = store.messagesForRoom(roomID).first(where: { $0.id == replyID }),
                   quoted.senderId != message.senderId,
                   store.bot(id: quoted.senderId) != nil {
                    Text("\(store.name(for: quoted.senderId))：\(quoted.content)").summonFont(.caption).lineLimit(3)
                        .foregroundStyle(.secondary).padding(10)
                        .background(SummonTheme.surface, in: RoundedRectangle(cornerRadius: 12))
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
                if let pending, pending.status != "sent" {
                    if pending.status == "sending" {
                        Label("正在发送…", systemImage: "clock").summonFont(.caption2).foregroundStyle(.secondary)
                    } else {
                        VStack(alignment: .trailing, spacing: 6) {
                            Text(pending.error ?? "尚未确认送达").summonFont(.caption2).foregroundStyle(.orange)
                            Button("重试发送") { Task { await store.retryMessage(clientID: pending.clientID) } }
                                .summonFont(.caption).buttonStyle(.glass)
                        }
                    }
                }
            }
            if !message.isOwn { Spacer(minLength: 20) }
        }
        .contextMenu {
            Button("回复", systemImage: "arrowshape.turn.up.left", action: onReply)
            Button("复制", systemImage: "doc.on.doc") { UIPasteboard.general.string = message.content }
            ShareLink(item: message.content)
        }
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
                    else { Image(systemName: attachment.mimeType.hasPrefix("image/") ? "photo" : "doc") }
                    VStack(alignment: .leading, spacing: 3) {
                        Text(attachment.name).summonFont(.subheadline).lineLimit(2)
                        Text(attachment.formattedSize).summonFont(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 4)
                    Image(systemName: "arrow.down.circle").foregroundStyle(.secondary)
                }.padding(12).background(SummonTheme.surface, in: RoundedRectangle(cornerRadius: 16))
            }.buttonStyle(.plain).disabled(downloading)
            if let fileURL { ShareLink(item: fileURL) { Label("分享文件", systemImage: "square.and.arrow.up") }.summonFont(.caption) }
            if let errorMessage { InlineError(message: errorMessage) }
        }
        .quickLookPreview($previewURL)
        .task(id: attachment.id) {
            guard attachment.previewUrl != nil else { return }
            do { previewImage = UIImage(data: try await store.attachmentPreviewData(attachment)) }
            catch { /* The original file remains available using the download button. */ }
        }
    }
}

