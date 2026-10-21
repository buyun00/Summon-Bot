import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import QuickLook

struct ChatView: View {
    @Environment(RelayStore.self) private var store
    let roomID: String
    @State private var text = ""
    @State private var attachments: [RelayAttachment] = []
    @State private var reply: RelayMessage?
    @State private var target = ""
    @State private var showFiles = false
    @State private var photo: PhotosPickerItem?
    @State private var uploading = false
    @State private var showDetails = false
    @State private var localError: String?
    @State private var nearBottom = true
    @FocusState private var composing: Bool

    private var room: RelayRoom? { store.rooms.first { $0.id == roomID } }
    private var directBot: RelayBot? {
        guard let room, room.kind == "dm", room.members.contains("user") else { return nil }
        return store.bots.first { room.members.contains($0.id) }
    }
    private var title: String { directBot?.name ?? room?.name ?? "聊天" }
    private var messages: [RelayMessage] { store.messagesForRoom(roomID) }
    private var runs: [RelayAgentRun] { store.agentRuns.filter { $0.roomId == roomID } }

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
                    }
                    ForEach(runs) { run in AgentRunRow(run: run) }
                    if store.selectedRoomID == roomID {
                        ForEach(store.jobs.filter { $0.isActive }) { job in
                            HStack(spacing: 10) {
                                ProgressView().controlSize(.small)
                                Text("\(store.bots.first { $0.id == job.botId }?.name ?? "Bot") · \(RelayFormat.status(job.status))")
                                    .font(.footnote).foregroundStyle(.secondary)
                            }
                        }
                    }
                    Color.clear.frame(height: 1).id("conversation-bottom")
                        .onAppear { nearBottom = true }
                        .onDisappear { nearBottom = false }
                }
                .padding(.horizontal, 18).padding(.top, 18).padding(.bottom, 8)
            }
            .scrollDismissesKeyboard(.interactively)
            .defaultScrollAnchor(.bottom)
            .onChange(of: messages.last?.id) { _, _ in
                if nearBottom { withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("conversation-bottom", anchor: .bottom) } }
            }
            .overlay(alignment: .bottomTrailing) {
                if !nearBottom && !messages.isEmpty {
                    Button { withAnimation { proxy.scrollTo("conversation-bottom", anchor: .bottom) } } label: {
                        Image(systemName: "arrow.down").frame(width: 26, height: 30)
                    }.buttonStyle(.glass).buttonBorderShape(.circle).padding(16)
                        .accessibilityLabel("回到最新消息")
                }
            }
        }
        .background(RelayTheme.background)
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
        .task(id: roomID) {
            text = store.draft(for: roomID)
            attachments = store.draftAttachments[roomID] ?? []
            target = store.draftTargets[roomID] ?? ""
            await store.selectRoom(roomID)
            if let replyID = store.draftReplies[roomID] {
                reply = store.messagesForRoom(roomID).first { $0.id == replyID }
            }
        }
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
        .sheet(isPresented: $showDetails) {
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
                        .font(.caption).foregroundStyle(.secondary).lineLimit(2)
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
                                Text(item.name).font(.caption).lineLimit(1)
                                Button { attachments.removeAll { $0.id == item.id } } label: { Image(systemName: "xmark.circle.fill") }
                                    .accessibilityLabel("移除 \(item.name)")
                            }.padding(10).background(RelayTheme.surface, in: Capsule())
                        }
                    }.padding(.horizontal, 18)
                }
            }
            if room?.isConcluded == true {
                Label("深聊已结束，结论已保留", systemImage: "checkmark.bubble")
                    .font(.footnote).foregroundStyle(.secondary).padding()
            } else if let room, !room.members.contains("user") {
                Label("正在查看 Bot 之间的对话", systemImage: "eye")
                    .font(.footnote).foregroundStyle(.secondary).padding()
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
                            else { Image(systemName: "plus").font(.title2).frame(width: 24, height: 30) }
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
                            Image(systemName: "arrow.up").font(.title3.weight(.semibold)).frame(width: 24, height: 30)
                        }
                        .buttonStyle(.glassProminent).buttonBorderShape(.circle)
                        .disabled(uploading || !store.isConfigured || store.sendingRoomIDs.contains(roomID) || (text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && attachments.isEmpty))
                        .accessibilityLabel("发送消息")
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

private struct MessageRow: View {
    @Environment(RelayStore.self) private var store
    let message: RelayMessage
    let roomID: String
    let onReply: () -> Void

    private var bot: RelayBot? { store.bots.first { $0.id == message.senderId } }
    private var pending: RelayPendingMessage? { store.pendingMessages.first { $0.clientID == message.clientId } }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if message.isOwn { Spacer(minLength: 40) }
            if !message.isOwn {
                if let bot { MemberAvatar(bot: bot, size: 28) }
                else { Image(systemName: "bolt.circle").foregroundStyle(.secondary).frame(width: 28, height: 28) }
            }
            VStack(alignment: message.isOwn ? .trailing : .leading, spacing: 7) {
                HStack(spacing: 8) {
                    Text(message.isOwn ? store.settings.userName : bot?.name ?? "系统").font(.caption.weight(.medium))
                    Text(RelayFormat.time(message.createdAt)).font(.caption2).foregroundStyle(.tertiary)
                }.foregroundStyle(.secondary)
                if let replyID = message.replyTo,
                   let quoted = store.messagesForRoom(roomID).first(where: { $0.id == replyID }) {
                    Text("回复：\(quoted.content)").font(.caption).lineLimit(3)
                        .foregroundStyle(.secondary).padding(10)
                        .background(RelayTheme.surface, in: RoundedRectangle(cornerRadius: 12))
                }
                if !message.content.isEmpty {
                    Text(.init(message.content))
                        .textSelection(.enabled)
                        .padding(message.isOwn ? 14 : 0)
                        .background(message.isOwn ? RelayTheme.surface : Color.clear, in: RoundedRectangle(cornerRadius: 21))
                }
                ForEach(message.attachments) { attachment in AttachmentRow(attachment: attachment) }
                if let pending, pending.status != "sent" {
                    if pending.status == "sending" {
                        Label("正在发送…", systemImage: "clock").font(.caption2).foregroundStyle(.secondary)
                    } else {
                        VStack(alignment: .trailing, spacing: 6) {
                            Text(pending.error ?? "尚未确认送达").font(.caption2).foregroundStyle(.orange)
                            Button("重试发送") { Task { await store.retryMessage(clientID: pending.clientID) } }
                                .font(.caption).buttonStyle(.glass)
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
    @Environment(RelayStore.self) private var store
    let attachment: RelayAttachment
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
                        Text(attachment.name).font(.subheadline).lineLimit(2)
                        Text(attachment.formattedSize).font(.caption2).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 4)
                    Image(systemName: "arrow.down.circle").foregroundStyle(.secondary)
                }.padding(12).background(RelayTheme.surface, in: RoundedRectangle(cornerRadius: 16))
            }.buttonStyle(.plain).disabled(downloading)
            if let fileURL { ShareLink(item: fileURL) { Label("分享文件", systemImage: "square.and.arrow.up") }.font(.caption) }
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

private struct AgentRunRow: View {
    @Environment(RelayStore.self) private var store
    let run: RelayAgentRun
    @State private var detail: RelayAgentRun?
    @State private var expanded = false
    @State private var errorMessage: String?
    @State private var busy = false

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 10) {
                if !run.outputText.isEmpty { Text(run.outputText).font(.footnote).textSelection(.enabled) }
                if let detail {
                    ForEach(detail.tools ?? []) { tool in
                        DisclosureGroup(tool.displayName) {
                            VStack(alignment: .leading, spacing: 8) {
                                if let input = tool.arguments ?? tool.input {
                                    Text(input.prettyPrinted).font(.caption.monospaced()).textSelection(.enabled)
                                }
                                if !tool.outputText.isEmpty {
                                    Text(tool.outputText).font(.caption.monospaced()).textSelection(.enabled)
                                }
                                ForEach(tool.artifacts ?? []) { artifact in
                                    ArtifactRow(artifact: artifact, runID: run.id, toolID: tool.id)
                                }
                            }.padding(.vertical, 8)
                        }
                    }
                    if let error = detail.error, error != .null { InlineError(message: error.stringValue) }
                }
                if let errorMessage { InlineError(message: errorMessage) }
                if run.isActive {
                    Button("停止执行", role: .destructive) {
                        Task {
                            busy = true
                            defer { busy = false }
                            do { try await store.cancelRun(id: run.id) }
                            catch { errorMessage = error.localizedDescription }
                        }
                    }.buttonStyle(.glass).disabled(busy)
                }
            }.padding(.top, 8)
        } label: {
            Label("执行记录 · \(RelayFormat.status(run.status ?? ""))", systemImage: "terminal")
                .font(.footnote).foregroundStyle(.secondary)
        }
        .onChange(of: expanded) { _, value in
            guard value else { return }
            Task {
                busy = true
                defer { busy = false }
                do { detail = try await store.fetchAgentRun(id: run.id) }
                catch { errorMessage = error.localizedDescription }
            }
        }
    }
}

private struct ArtifactRow: View {
    @Environment(RelayStore.self) private var store
    let artifact: RelayArtifact
    let runID: String
    let toolID: String
    @State private var fileURL: URL?
    @State private var previewURL: URL?
    @State private var busy = false
    @State private var errorMessage: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                Task {
                    busy = true
                    defer { busy = false }
                    do {
                        let url = try await store.artifactFileURL(artifact, runID: runID, toolID: toolID)
                        fileURL = url; previewURL = url
                    } catch { errorMessage = error.localizedDescription }
                }
            } label: {
                Label(artifact.name ?? "文件", systemImage: "doc.badge.arrow.up")
            }.buttonStyle(.glass).disabled(busy)
            if let fileURL { ShareLink(item: fileURL) }
            if let errorMessage { InlineError(message: errorMessage) }
        }.quickLookPreview($previewURL)
    }
}
