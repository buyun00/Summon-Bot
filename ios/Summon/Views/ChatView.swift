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
    @State private var showModels = false
    @State private var activeExecutionRef: SummonReference?
    @State private var executionsExpanded = false
    @State private var activityTickerIndex = 0
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
    private static let liveExecutionStatuses: Set<String> = ["opening", "running", "submitted", "waiting", "queued", "needs_input", "awaiting_input"]

    private static func formatLiveText(_ raw: String?) -> String {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "正在处理中" }
        if trimmed.hasPrefix("正在") || trimmed.hasPrefix("等待") || trimmed.hasPrefix("准备") || trimmed.hasPrefix("已") {
            return trimmed
        }
        let firstScalar = trimmed.unicodeScalars.first
        let sep = (firstScalar.map { CharacterSet.alphanumerics.contains($0) && $0.isASCII } ?? false) ? " " : ""
        return "正在\(sep)\(trimmed)"
    }

    private var activeBotItems: [ActiveBotItem] {
        var seen = Set<String>()
        var result: [ActiveBotItem] = []
        for activity in store.activitiesForRoom(roomID) {
            let botID = activity.bot_id
            let bot = store.bot(id: botID)
            if bot?.isPaused == true { continue }
            guard seen.insert(botID).inserted else { continue }
            let name = bot?.name ?? store.name(for: botID)
            result.append(ActiveBotItem(
                id: botID,
                bot: bot,
                name: name,
                status: activity.text.isEmpty ? "正在处理中" : activity.text,
                ref: activity.execution_ref
            ))
        }
        for exec in store.activeExecutionsForRoom(roomID) {
            let botID = exec["execution_actor"]["id"].string ?? exec["bot_id"].string ?? ""
            let bot = botID.isEmpty ? nil : store.bot(id: botID)
            if bot?.isPaused == true { continue }
            let key = botID.isEmpty ? (exec["execution_ref"]["id"].string ?? exec.prettyPrinted) : botID
            guard seen.insert(key).inserted else { continue }
            let name = bot?.name ?? (botID.isEmpty ? "执行会话" : store.name(for: botID))
            let rawStatus = exec["status"].stringValue
            let status: String
            if ["needs_input", "awaiting_input"].contains(rawStatus) {
                let waiting = exec["waiting_summary"].string?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                status = waiting.isEmpty ? "等待你的输入" : "等待输入：\(waiting)"
            } else {
                let live = exec["live_progress"].string ?? exec["work_summary"].string
                status = Self.formatLiveText(live)
            }
            result.append(ActiveBotItem(id: key, bot: bot, name: name, status: status, ref: SummonReference(exec["execution_ref"])))
        }
        if let direct = directBot, !direct.isPaused, seen.insert(direct.id).inserted {
            if direct.resolvedActivity == "working" {
                result.append(ActiveBotItem(id: direct.id, bot: direct, name: direct.name, status: "正在处理中", ref: nil))
            } else if direct.resolvedActivity == "error" {
                result.append(ActiveBotItem(id: direct.id, bot: direct, name: direct.name, status: "运行异常", ref: nil))
            }
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
                LazyVStack(alignment: .leading, spacing: 0) {
                    if messages.isEmpty && !store.isLoading {
                        ContentUnavailableView("开始聊天", systemImage: "bubble.left.and.text.bubble.right", description: Text("发一条消息给 \(title)。"))
                            .padding(.top, 70)
                    }
                    if store.canLoadOlder(roomID) {
                        Button("加载更早消息") { Task { await store.loadRoom(roomID, older: true) } }
                            .buttonStyle(.bordered).disabled(!store.protocolReady)
                            .padding(.bottom, 12)
                    }
                    ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                        let previous = index > 0 ? messages[index - 1] : nil
                        let currentDate = SummonDate.parse(message.createdAt)
                        let prevDate = SummonDate.parse(previous?.createdAt)
                        let gapSeconds = (currentDate != nil && prevDate != nil) ? currentDate!.timeIntervalSince(prevDate!) : nil
                        let showTimeDivider = index == 0 || (gapSeconds != nil && gapSeconds! >= 300)
                        let grouped = !showTimeDivider && previous?.senderId == message.senderId && (gapSeconds == nil || (gapSeconds! >= 0 && gapSeconds! <= 120))
                        VStack(spacing: 0) {
                            if showTimeDivider {
                                let label = SummonFormat.dividerTime(message.createdAt)
                                if !label.isEmpty {
                                    Text(label)
                                        .summonFont(.caption2)
                                        .foregroundStyle(.tertiary)
                                        .frame(maxWidth: .infinity)
                                        .padding(.top, index == 0 ? 4 : 18)
                                        .padding(.bottom, 12)
                                }
                            }
                            MessageRow(message: message, roomID: roomID, previousID: previous?.id, grouped: grouped) {
                                store.setDraftReply(message.id, for: roomID)
                                composing = true
                            }
                            .padding(.top, showTimeDivider ? 0 : (grouped ? 6 : 16))
                        }
                        .id(message.id)
                        .transition(.asymmetric(insertion: .opacity.combined(with: .offset(y: 10)), removal: .identity))
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
        .summonSheet(isPresented: $showModels) { ModelSettingsView() }
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

    private var sortedRoomExecutions: [SummonJSONValue] {
        roomExecutions.sorted { lhs, rhs in
            let lLive = Self.liveExecutionStatuses.contains(lhs["status"].stringValue)
            let rLive = Self.liveExecutionStatuses.contains(rhs["status"].stringValue)
            if lLive != rLive { return lLive }
            let lTime = lhs["updated_at"].string ?? lhs["created_at"].string ?? ""
            let rTime = rhs["updated_at"].string ?? rhs["created_at"].string ?? ""
            return lTime > rTime
        }
    }

    private var executionDrawer: some View {
        let sorted = sortedRoomExecutions
        let liveExecs = sorted.filter { Self.liveExecutionStatuses.contains($0["status"].stringValue) }
        let recentFinished = Array(sorted.filter { !Self.liveExecutionStatuses.contains($0["status"].stringValue) }.prefix(3))
        let visibleExecs = liveExecs + recentFinished
        let activeExecBotIDs = Set(liveExecs.compactMap { $0["execution_actor"]["id"].string ?? $0["bot_id"].string })
        let syntheticLive = activeBotItems.filter { !activeExecBotIDs.contains($0.id) }
        let activeCount = liveExecs.count + syntheticLive.count
        let totalCount = visibleExecs.count + syntheticLive.count
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Label(activeCount > 0 ? "进行中（\(activeCount)）" : "最近执行", systemImage: "terminal")
                    .summonFont(.caption, weight: .semibold)
                    .foregroundStyle(.secondary)
                Spacer()
                Button {
                    withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) { executionsExpanded = false }
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .frame(width: 24, height: 24)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("收起执行过程")
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(syntheticLive) { item in
                        HStack(spacing: 10) {
                            if let bot = item.bot {
                                MemberAvatar(bot: bot, size: 22, motion: "work")
                            }
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 6) {
                                    Text(item.name)
                                        .summonFont(.footnote, weight: .medium)
                                        .foregroundStyle(.primary)
                                        .lineLimit(1)
                                    Text("进行中")
                                        .summonFont(.caption2, weight: .medium)
                                        .foregroundStyle(SummonTheme.ok)
                                }
                                Text(item.status)
                                    .summonFont(.caption)
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }
                            Spacer()
                        }
                        .padding(.vertical, 4)
                    }
                    ForEach(Array(visibleExecs.enumerated()), id: \.offset) { _, exec in
                        if let ref = SummonReference(exec["execution_ref"]) {
                            let status = exec["status"].stringValue
                            let isLive = Self.liveExecutionStatuses.contains(status)
                            let actorID = exec["execution_actor"]["id"].string ?? exec["bot_id"].string
                            let actorName = actorID.map { store.name(for: $0) } ?? "执行会话"
                            let engineName = exec["kind"].string == "conversation" ? "内部对话" : (exec["engine"].string ?? "执行")
                            let progress = exec["live_progress"].string ?? exec["work_summary"].string ?? exec["waiting_summary"].string ?? ""
                            Button { activeExecutionRef = ref } label: {
                                HStack(spacing: 10) {
                                    if let actorID, let bot = store.bot(id: actorID) {
                                        MemberAvatar(bot: bot, size: 22, motion: isLive ? "work" : "idle")
                                    }
                                    VStack(alignment: .leading, spacing: 2) {
                                        HStack(spacing: 6) {
                                            Text("\(actorName) · \(engineName)")
                                                .summonFont(.footnote, weight: .medium)
                                                .foregroundStyle(.primary)
                                                .lineLimit(1)
                                            Text(isLive ? "进行中" : SummonFormat.status(status))
                                                .summonFont(.caption2, weight: .medium)
                                                .foregroundStyle(isLive || status == "completed" ? SummonTheme.ok : (status == "needs_input" || status == "awaiting_input") ? SummonTheme.warn : .secondary)
                                        }
                                        if !progress.isEmpty {
                                            Text(progress)
                                                .summonFont(.caption)
                                                .foregroundStyle(.secondary)
                                                .lineLimit(1)
                                        }
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                        .font(.system(size: 11, weight: .medium))
                                        .foregroundStyle(.tertiary)
                                }
                                .padding(.vertical, 5)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    if totalCount == 0 {
                        Text("当前暂无执行记录")
                            .summonFont(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .frame(maxHeight: 200)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(SummonTheme.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay { RoundedRectangle(cornerRadius: 16).stroke(SummonTheme.bubbleStroke, lineWidth: 0.7) }
        .padding(.horizontal, 14)
        .transition(.opacity.combined(with: .offset(y: reduceMotion ? 0 : 8)))
    }

    @ViewBuilder
    private var composer: some View {
        if let room, room.isArchived {
            HStack(spacing: 12) {
                Label("该群聊已归档", systemImage: "archivebox")
                    .summonFont(.footnote)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("移出归档") {
                    Task {
                        do { try await store.restoreRoom(room); localError = nil }
                        catch { localError = error.localizedDescription }
                    }
                }
                .summonFont(.footnote, weight: .medium)
                .buttonStyle(.glass)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(SummonTheme.surface, in: RoundedRectangle(cornerRadius: 18))
            .overlay { RoundedRectangle(cornerRadius: 18).stroke(SummonTheme.bubbleStroke, lineWidth: 0.7) }
            .padding(.horizontal, 14)
            .padding(.bottom, 10)
        } else {
        VStack(alignment: .leading, spacing: 8) {
            if let error = localError { InlineError(message: error).padding(.horizontal, 20) }
            if let notice = store.protocolNotice {
                SummonProtocolNotice(notice: notice, needsUpdate: store.needsClientUpdate)
            }
            if executionsExpanded {
                executionDrawer
            }
            if !activeBotItems.isEmpty {
                let items = activeBotItems
                let safeIndex = items.isEmpty ? 0 : (activityTickerIndex % items.count)
                let current = items[safeIndex]
                HStack(spacing: 8) {
                    Button {
                        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.2)) {
                            executionsExpanded.toggle()
                        }
                    } label: {
                        HStack(spacing: 8) {
                            BotWorkingIndicator(
                                bot: current.bot,
                                name: current.name,
                                status: current.status,
                                motion: current.status == "运行异常" ? "failed" : "work"
                            )
                            .id(current.id)
                            .transition(.asymmetric(
                                insertion: .move(edge: .bottom).combined(with: .opacity),
                                removal: .move(edge: .top).combined(with: .opacity)
                            ))
                            if items.count > 1 {
                                Text("\(safeIndex + 1)/\(items.count)")
                                    .summonFont(.caption2, weight: .medium)
                                    .foregroundStyle(.secondary)
                                    .monospacedDigit()
                            }
                            Image(systemName: executionsExpanded ? "chevron.up" : "chevron.down")
                                .font(.system(size: 11, weight: .semibold))
                                .foregroundStyle(.secondary)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    Button("停止") {
                        Task {
                            do { try await store.stopRoom(roomID); localError = nil }
                            catch { localError = error.localizedDescription }
                        }
                    }
                    .summonFont(.caption2, weight: .medium)
                    .foregroundStyle(.secondary)
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 16)
                .clipped()
                .animation(reduceMotion ? nil : .easeInOut(duration: 0.3), value: safeIndex)
                .task(id: items.map(\.id)) {
                    if activityTickerIndex >= items.count { activityTickerIndex = 0 }
                    guard items.count > 1 else { return }
                    while !Task.isCancelled {
                        do { try await Task.sleep(for: .milliseconds(3200)) } catch { break }
                        guard !Task.isCancelled else { break }
                        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.3)) {
                            activityTickerIndex = (activityTickerIndex + 1) % max(1, items.count)
                        }
                    }
                }
                .transition(.opacity.combined(with: .offset(y: reduceMotion ? 0 : 6)))
            }
            let roomSuspended = store.suspendedRunsForRoom(roomID)
            if !roomSuspended.isEmpty {
                let latestByBot: [SummonJSONValue] = {
                    var seen: [String: SummonJSONValue] = [:]
                    var order: [String] = []
                    for run in roomSuspended {
                        let key = run["bot_id"].stringValue
                        if seen[key] == nil { order.append(key) }
                        seen[key] = run
                    }
                    return order.compactMap { seen[$0] }
                }()
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(latestByBot.indices, id: \.self) { index in
                        let run = latestByBot[index]
                        let botName = store.name(for: run["bot_id"].stringValue)
                        let errCode = run["error"]["code"].stringValue
                        let isAuth = errCode == "auth_expired"
                        let isQuota = errCode == "quota_exhausted"
                        let summary = isAuth ? "模型登录已失效" : isQuota ? "模型额度已用尽" : "暂时无法回复"
                        HStack(spacing: 8) {
                            Text("\(botName) · \(summary)").summonFont(.caption).foregroundStyle(SummonTheme.warn)
                            Spacer()
                            if isAuth {
                                Button("重新登录") { showModels = true }.summonFont(.caption, weight: .medium).foregroundStyle(SummonTheme.warn)
                            } else if isQuota {
                                Button("更换模型") { showModels = true }.summonFont(.caption, weight: .medium).foregroundStyle(SummonTheme.warn)
                            } else if let convID = run["conversation_id"].string {
                                Button("重试") {
                                    Task {
                                        do { try await store.retrySuspendedRun(conversationID: convID, runID: run["run_id"].string); localError = nil }
                                        catch { localError = error.localizedDescription }
                                    }
                                }.summonFont(.caption, weight: .medium).foregroundStyle(SummonTheme.warn)
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 7)
                        .background(SummonTheme.warn.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))
                    }
                }
                .padding(.horizontal, 14)
            }
            if let pendingExec = pendingInputExecution, let ref = SummonReference(pendingExec["execution_ref"]) {
                let pendingRequests = pendingExec["pending_requests"].array ?? []
                if let firstReq = pendingRequests.first {
                    ExecutionPendingPromptCard(exec: pendingExec, request: firstReq) { error in
                        localError = error
                    }
                    .padding(.horizontal, 14)
                    .transition(.opacity.combined(with: .offset(y: reduceMotion ? 0 : 6)))
                } else {
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
    let previousID: String?
    let grouped: Bool
    let onReply: () -> Void

    private var bot: SummonBot? { store.bots.first { $0.id == message.senderId } }
    private var pending: SummonPendingMessage? { store.pendingMessage(for: message) }
    @State private var reference: SummonReference?
    @State private var failure: String?

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            if message.isOwn { Spacer(minLength: 40) }
            if !message.isOwn {
                if grouped {
                    Color.clear.frame(width: 28, height: 1)
                } else if let bot {
                    MemberAvatar(bot: bot, size: 28)
                } else {
                    Image(systemName: "bolt.circle").foregroundStyle(.secondary).frame(width: 28, height: 28)
                }
            }
            VStack(alignment: message.isOwn ? .trailing : .leading, spacing: 6) {
                if !message.isOwn && !grouped {
                    Text(store.name(for: message.senderId))
                        .summonFont(.caption, weight: .medium)
                        .foregroundStyle(.secondary)
                }
                if let replyID = message.replyTo, replyID != previousID {
                    if let quoted = store.messagesForRoom(roomID).first(where: { $0.id == replyID }) {
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
                    } else {
                        Button("查看引用的消息") { reference = SummonReference(kind: "event", id: replyID) }.summonFont(.caption)
                    }
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
                if !message.isOwn, let prompt = message.prompt, !(prompt["questions"].array ?? []).isEmpty {
                    MessagePromptCardView(message: message, roomID: roomID, prompt: prompt)
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

private struct MessagePromptCardView: View {
    @Environment(SummonStore.self) private var store
    let message: SummonMessage
    let roomID: String
    let prompt: SummonJSONValue

    @State private var selectedByQuestion: [String: [String]] = [:]
    @State private var customByQuestion: [String: String] = [:]
    @State private var submitting = false

    private var kind: String { prompt["kind"].string ?? "question" }
    private var questions: [SummonJSONValue] { prompt["questions"].array ?? [] }

    private var isSkipped: Bool {
        if message.promptAnswer?["skipped"].bool == true { return true }
        return store.messagesForRoom(roomID).first(where: { $0.promptResponse?["prompt_message_id"].string == message.id })?
            .promptResponse?["skipped"].bool == true
    }

    private var answeredItems: [SummonJSONValue]? {
        if isSkipped { return [] }
        if let items = message.promptAnswer?["answers"].array, !items.isEmpty { return items }
        if let reply = store.messagesForRoom(roomID).first(where: { $0.promptResponse?["prompt_message_id"].string == message.id }),
           let items = reply.promptResponse?["answers"].array, !items.isEmpty {
            return items
        }
        return nil
    }

    private var isReady: Bool {
        guard !questions.isEmpty else { return false }
        return questions.allSatisfy { q in
            if q["required"].bool == false { return true }
            let qid = q["id"].stringValue
            let mode = q["mode"].string ?? "single"
            let hasSelected = !(selectedByQuestion[qid] ?? []).isEmpty
            let hasCustom = !(customByQuestion[qid] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            return mode == "text" ? hasCustom : (hasSelected || hasCustom)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                if answeredItems != nil {
                    if isSkipped {
                        Text("已跳过")
                            .summonFont(.caption2, weight: .semibold)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background(Color.secondary.opacity(0.14), in: Capsule())
                    } else {
                        Label(kind == "permission" ? "已确认权限" : kind == "confirm" ? "已确认" : "已提交选择", systemImage: "checkmark.circle.fill")
                            .summonFont(.caption2, weight: .semibold)
                            .foregroundStyle(SummonTheme.ok)
                    }
                } else {
                    Text(kind == "permission" ? "权限确认" : kind == "confirm" ? "操作确认" : "待你选择")
                        .summonFont(.caption2, weight: .semibold)
                        .foregroundStyle(kind == "permission" ? SummonTheme.warn : .secondary)
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background((kind == "permission" ? SummonTheme.warn : Color.secondary).opacity(0.14), in: Capsule())
                }
                if let title = prompt["title"].string, !title.isEmpty {
                    Text(title).summonFont(.caption, weight: .semibold).foregroundStyle(.primary)
                }
            }

            if let answeredItems {
                if isSkipped {
                    Text("已跳过本次选择，由 Bot 自行处理").summonFont(.caption).foregroundStyle(.secondary)
                } else {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(answeredItems.enumerated()), id: \.offset) { _, ans in
                            let labels = (ans["selected_labels"].array ?? []).compactMap(\.string)
                            let custom = ans["custom_text"].string ?? ""
                            let summary = (labels + (custom.isEmpty ? [] : [custom])).joined(separator: " · ")
                            HStack(alignment: .top, spacing: 6) {
                                Text(ans["label"].string ?? ans["question_id"].stringValue)
                                    .summonFont(.caption).foregroundStyle(.secondary)
                                Text(summary.isEmpty ? "—" : summary)
                                    .summonFont(.caption, weight: .medium).foregroundStyle(.primary)
                            }
                        }
                    }
                }
            } else {
                ForEach(Array(questions.enumerated()), id: \.offset) { idx, q in
                    let qid = q["id"].stringValue
                    let mode = q["mode"].string ?? "single"
                    let allowCustom = q["allow_custom"].bool ?? (mode != "text" && kind != "permission")
                    let options = q["options"].array ?? []
                    VStack(alignment: .leading, spacing: 7) {
                        HStack {
                            Text((questions.count > 1 ? "\(idx + 1). " : "") + q["label"].stringValue)
                                .summonFont(.footnote, weight: .semibold).foregroundStyle(.primary)
                            Spacer(minLength: 4)
                            Text((mode == "multi" ? "多选" : mode == "text" ? "填写" : "单选") + (q["required"].bool == false ? " · 选填" : ""))
                                .summonFont(.caption2).foregroundStyle(.tertiary)
                        }
                        if mode != "text" {
                            ForEach(Array(options.enumerated()), id: \.offset) { _, opt in
                                let oid = opt["id"].stringValue
                                let selected = (selectedByQuestion[qid] ?? []).contains(oid)
                                let tone = opt["tone"].string ?? "default"
                                let accentColor: Color = tone == "primary" ? SummonTheme.ok : tone == "danger" ? .red : .primary
                                Button {
                                    toggleOption(qid: qid, oid: oid, mode: mode)
                                } label: {
                                    HStack(alignment: .top, spacing: 9) {
                                        Image(systemName: mode == "multi"
                                              ? (selected ? "checkmark.square.fill" : "square")
                                              : (selected ? "largecircle.fill.circle" : "circle"))
                                            .font(.system(size: 16))
                                            .foregroundStyle(selected ? accentColor : .secondary)
                                        VStack(alignment: .leading, spacing: 2) {
                                            HStack(spacing: 6) {
                                                Text(opt["label"].stringValue)
                                                    .summonFont(.footnote, weight: selected ? .semibold : .regular)
                                                    .foregroundStyle(.primary)
                                                if opt["recommended"].bool == true {
                                                    Text("推荐")
                                                        .summonFont(.caption2, weight: .semibold)
                                                        .foregroundStyle(SummonTheme.ok)
                                                        .padding(.horizontal, 6).padding(.vertical, 1)
                                                        .background(SummonTheme.ok.opacity(0.14), in: Capsule())
                                                }
                                            }
                                            if let desc = opt["description"].string, !desc.isEmpty {
                                                Text(desc).summonFont(.caption2).foregroundStyle(.secondary)
                                            }
                                        }
                                        Spacer(minLength: 0)
                                    }
                                    .padding(.horizontal, 10).padding(.vertical, 8)
                                    .background(selected ? accentColor.opacity(0.10) : Color.clear, in: RoundedRectangle(cornerRadius: 10))
                                    .overlay {
                                        RoundedRectangle(cornerRadius: 10)
                                            .stroke(selected ? accentColor.opacity(0.6) : SummonTheme.bubbleStroke, lineWidth: selected ? 1.2 : 0.7)
                                    }
                                }
                                .buttonStyle(.plain)
                                .disabled(submitting)
                            }
                        }
                        if mode == "text" || allowCustom {
                            let placeholder = q["custom_placeholder"].string
                                ?? (mode == "text" ? "请输入回答…" : mode == "multi" ? "补充说明或自填其他选项（选填）" : "或自定义填写其他想法…")
                            TextField(placeholder, text: Binding(
                                get: { customByQuestion[qid] ?? "" },
                                set: { newVal in
                                    customByQuestion[qid] = newVal
                                    if mode == "single" && !newVal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                                        selectedByQuestion[qid] = []
                                    }
                                }
                            ))
                            .summonFont(.footnote)
                            .padding(.horizontal, 10).padding(.vertical, 8)
                            .background(SummonTheme.background, in: RoundedRectangle(cornerRadius: 10))
                            .overlay { RoundedRectangle(cornerRadius: 10).stroke(SummonTheme.bubbleStroke, lineWidth: 0.8) }
                            .submitLabel(.send)
                            .onSubmit { if isReady { Task { await submit() } } }
                            .disabled(submitting)
                        }
                    }
                }
                HStack(spacing: 8) {
                    Spacer()
                    Button("跳过") {
                        Task { await skip() }
                    }
                    .summonFont(.footnote, weight: .medium)
                    .buttonStyle(.bordered)
                    .disabled(submitting || !store.protocolReady)
                    Button {
                        Task { await submit() }
                    } label: {
                        Text(submitting ? "提交中…" : (prompt["submit_label"].string ?? (kind == "permission" ? "确认授权" : kind == "confirm" ? "确认" : "提交选择")))
                            .summonFont(.footnote, weight: .semibold)
                            .padding(.horizontal, 14).padding(.vertical, 7)
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(submitting || !store.protocolReady || !isReady)
                }
            }
        }
        .padding(12)
        .background(answeredItems != nil ? SummonTheme.ok.opacity(0.07) : SummonTheme.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay {
            RoundedRectangle(cornerRadius: 16)
                .stroke(answeredItems != nil ? SummonTheme.ok.opacity(0.28) : (kind == "permission" ? SummonTheme.warn.opacity(0.42) : SummonTheme.bubbleStroke), lineWidth: 0.9)
        }
    }

    private func toggleOption(qid: String, oid: String, mode: String) {
        var current = selectedByQuestion[qid] ?? []
        if mode == "multi" {
            if let index = current.firstIndex(of: oid) { current.remove(at: index) }
            else { current.append(oid) }
        } else {
            current = current == [oid] ? [] : [oid]
            if !current.isEmpty { customByQuestion[qid] = "" }
        }
        selectedByQuestion[qid] = current
    }

    private func submit() async {
        guard isReady, !submitting else { return }
        submitting = true
        defer { submitting = false }
        var answers: [SummonJSONValue] = []
        var lines: [String] = []
        for q in questions {
            let qid = q["id"].stringValue
            let label = q["label"].stringValue
            let options = q["options"].array ?? []
            let optMap = Dictionary(uniqueKeysWithValues: options.map { ($0["id"].stringValue, $0["label"].stringValue) })
            let selectedIds = (selectedByQuestion[qid] ?? []).filter { optMap[$0] != nil }
            let selectedLabels = selectedIds.compactMap { optMap[$0] }
            let customText = (customByQuestion[qid] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if selectedIds.isEmpty && customText.isEmpty { continue }
            var item: [String: SummonJSONValue] = [
                "question_id": .string(qid),
                "label": .string(label),
                "selected_ids": .array(selectedIds.map(SummonJSONValue.string)),
                "selected_labels": .array(selectedLabels.map(SummonJSONValue.string))
            ]
            if !customText.isEmpty { item["custom_text"] = .string(customText) }
            answers.append(.object(item))
            var parts = selectedLabels
            if !customText.isEmpty { parts.append(selectedLabels.isEmpty ? customText : "补充：\(customText)") }
            lines.append(questions.count == 1 ? "已选择：\(parts.joined(separator: "、"))" : "\(label)：\(parts.joined(separator: "、"))")
        }
        guard !answers.isEmpty else { return }
        await store.sendPromptResponse(roomID: roomID, message: message, answers: answers, summaryText: lines.joined(separator: "\n"))
    }

    private func skip() async {
        guard !submitting else { return }
        submitting = true
        defer { submitting = false }
        let text = kind == "permission" ? "已跳过权限确认" : "已跳过选择，由你自行处理"
        await store.sendPromptResponse(roomID: roomID, message: message, answers: [], summaryText: text, skipped: true)
    }
}

private struct ExecutionPendingPromptCard: View {
    @Environment(SummonStore.self) private var store
    let exec: SummonJSONValue
    let request: SummonJSONValue
    let onError: (String) -> Void

    @State private var selectedChoice = ""
    @State private var freeText = ""
    @State private var busy = false

    private var isApproval: Bool { request["kind"].string == "approval" }
    private var choices: [SummonJSONValue] { request["choices"].array ?? [] }
    private var currentValue: String { choices.isEmpty ? freeText.trimmingCharacters(in: .whitespacesAndNewlines) : selectedChoice }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 8) {
                Text(isApproval ? "执行权限审批" : "执行会话提问")
                    .summonFont(.caption2, weight: .semibold)
                    .foregroundStyle(isApproval ? SummonTheme.warn : .secondary)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background((isApproval ? SummonTheme.warn : Color.secondary).opacity(0.14), in: Capsule())
                let actorID = exec["execution_actor"]["id"].string ?? exec["bot_id"].string ?? ""
                Text(store.name(for: actorID) + (exec["engine"].string.map { " · \($0)" } ?? ""))
                    .summonFont(.caption, weight: .semibold).lineLimit(1)
            }
            if let q = request["question"].string, !q.isEmpty {
                Text(q).summonFont(.footnote).fixedSize(horizontal: false, vertical: true)
            }
            if !choices.isEmpty {
                HStack(spacing: 8) {
                    ForEach(Array(choices.enumerated()), id: \.offset) { _, choice in
                        let cid = choice["id"].stringValue
                        let label = choice["label"].string ?? cid
                        let selected = selectedChoice == cid
                        let accent: Color = cid == "accept" ? SummonTheme.ok : ["deny", "decline", "cancel"].contains(cid) ? .red : .primary
                        Button {
                            selectedChoice = cid
                        } label: {
                            Text(label)
                                .summonFont(.footnote, weight: selected ? .semibold : .regular)
                                .padding(.horizontal, 12).padding(.vertical, 7)
                                .background(selected ? accent.opacity(0.14) : Color.clear, in: Capsule())
                                .overlay { Capsule().stroke(selected ? accent : SummonTheme.bubbleStroke, lineWidth: selected ? 1.2 : 0.7) }
                        }
                        .buttonStyle(.plain)
                        .disabled(busy)
                    }
                }
            } else {
                TextField("输入回答…", text: $freeText)
                    .summonFont(.footnote)
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .background(SummonTheme.background, in: RoundedRectangle(cornerRadius: 10))
                    .overlay { RoundedRectangle(cornerRadius: 10).stroke(SummonTheme.bubbleStroke, lineWidth: 0.8) }
                    .submitLabel(.send)
                    .onSubmit { if !currentValue.isEmpty { Task { await submit() } } }
                    .disabled(busy)
            }
            HStack(spacing: 8) {
                Spacer()
                if let skipId = choices.first(where: { ["cancel", "decline", "deny"].contains($0["id"].stringValue) })?["id"].string {
                    Button("跳过") {
                        Task { await submitValue(skipId) }
                    }
                    .summonFont(.footnote, weight: .medium)
                    .buttonStyle(.bordered)
                    .disabled(busy || !store.protocolReady)
                }
                Button {
                    Task { await submit() }
                } label: {
                    Text(busy ? "提交中…" : isApproval ? "确认审批" : "提交回答")
                        .summonFont(.footnote, weight: .semibold)
                }
                .buttonStyle(.borderedProminent)
                .disabled(busy || !store.protocolReady || currentValue.isEmpty)
            }
        }
        .padding(12)
        .background(SummonTheme.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay { RoundedRectangle(cornerRadius: 16).stroke(SummonTheme.warn.opacity(0.4), lineWidth: 0.9) }
    }

    private func submit() async {
        await submitValue(currentValue)
    }

    private func submitValue(_ value: String) async {
        guard !busy, !value.isEmpty else { return }
        busy = true
        defer { busy = false }
        do {
            try await store.submitPendingExecutionInput(
                target: exec["execution_ref"],
                controlVersion: exec["control_version"].int ?? 1,
                inputTarget: request["input_target"],
                input: value
            )
            selectedChoice = ""
            freeText = ""
        } catch {
            onError(error.localizedDescription)
        }
    }
}
