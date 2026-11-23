import Foundation
import Observation
import UniformTypeIdentifiers

@MainActor
@Observable
final class SummonStore {
    private(set) var settings = SummonConnectionSettings()
    private(set) var bots: [SummonBot] = []
    private(set) var rooms: [SummonRoom] = []
    private(set) var pendingMessages: [SummonPendingMessage] = []
    private(set) var drafts: [String: String] = [:]
    private(set) var draftAttachments: [String: [SummonAttachment]] = [:]
    private(set) var draftMentions: [String: [String]] = [:]
    private(set) var draftReplies: [String: String] = [:]
    private(set) var draftReferences: [String: [SummonReference]] = [:]
    private(set) var selectedRoomID: String?
    private(set) var isLoading = false
    private(set) var isRefreshing = false
    private(set) var isConnected = false
    private(set) var protocolReady = false
    private(set) var protocolNotice: String?
    private(set) var needsClientUpdate = false
    private(set) var sendingRoomIDs: Set<String> = []
    private(set) var lastSyncAt: Date?
    private(set) var modelSummary: SummonJSONValue = .null
    private(set) var roomExecutions: [String: [SummonJSONValue]] = [:]
    var errorMessage: String?

    private var messageHistory: [String: [SummonMessage]] = [:]
    private var deliveries: [String: [SummonDelivery]] = [:]
    private var messageSummaries: [String: [SummonMessageSummary]] = [:]
    private var cursors: [String: String] = [:]

    @ObservationIgnored private var client: SummonAPIClient?
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var recoveryTask: Task<Void, Never>?
    @ObservationIgnored private var persistenceTask: Task<Void, Never>?
    @ObservationIgnored private var roomReads: Set<String> = []
    @ObservationIgnored private var olderReadsWaiting: Set<String> = []
    @ObservationIgnored private var connectionGeneration = 0
    @ObservationIgnored private var pushGeneration: Int?
    @ObservationIgnored private var historyEpoch: String?
    @ObservationIgnored private var activeRoomID: String?
    @ObservationIgnored private var refreshAgain = false
    @ObservationIgnored private var foreground = false
    @ObservationIgnored private let defaults = UserDefaults.standard
    @ObservationIgnored private let settingsKey = "SummonNative.connection.v1"
    @ObservationIgnored private var storageDirectory: URL?

    var isConfigured: Bool { client != nil }
    var savedToken: String { SummonKeychain.token(for: settings.baseURL) }

    init() {
        do { try SummonBrandingMigration.run() }
        catch { errorMessage = "无法迁移本机连接设置：\(error.localizedDescription)" }
        if let data = defaults.data(forKey: settingsKey),
           let saved = try? JSONDecoder().decode(SummonConnectionSettings.self, from: data) {
            settings = saved
            if let previous = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               previous.keys.contains("workspaceID"), let updated = try? JSONEncoder().encode(saved) {
                defaults.set(updated, forKey: settingsKey)
            }
        }
        if let url = try? SummonAPIClient.normalizedURL(settings.baseURL) {
            client = SummonAPIClient(baseURL: url, token: savedToken)
        }
        if let root = try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                   appropriateFor: nil, create: true) {
            var directory = root.appending(path: "SummonNative", directoryHint: .isDirectory)
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? directory.setResourceValues(values)
            storageDirectory = directory
        }
        restoreSnapshot()
    }

    func start() async {
        guard client != nil, !foreground else { return }
        foreground = true
        let connection = connectionGeneration
        await refresh()
        guard foreground, connection == connectionGeneration else { return }
        startStream()
        startRecovery()
    }

    func reconnect() async { await start() }

    func disconnect() {
        connectionGeneration += 1
        foreground = false
        streamTask?.cancel(); streamTask = nil
        refreshTask?.cancel(); refreshTask = nil
        recoveryTask?.cancel(); recoveryTask = nil
        roomReads.removeAll()
        olderReadsWaiting.removeAll()
        isConnected = false
        protocolReady = false
        isLoading = false
        isRefreshing = false
        refreshAgain = false
        for index in pendingMessages.indices where pendingMessages[index].status == "sending" {
            pendingMessages[index].status = "failed"
            pendingMessages[index].error = "保存状态待确认。"
        }
        sendingRoomIDs.removeAll()
        persistNow()
    }

    func saveConnection(baseURL: String, token: String) async throws {
        let url = try SummonAPIClient.normalizedURL(baseURL)
        let endpoint = url.absoluteString
        let newToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        let changed = endpoint != settings.baseURL
        let newClient = SummonAPIClient(baseURL: url, token: newToken)
        let startup: SummonBootstrap?
        do { startup = try await newClient.bootstrap(probe: true) }
        catch let error as URLError where [.timedOut, .notConnectedToInternet, .cannotFindHost, .cannotConnectToHost,
                                          .networkConnectionLost, .dnsLookupFailed].contains(error.code) { startup = nil }
        catch SummonAPIError.http(503, _, "updating") { startup = nil }
        catch { throw startupError(error) }
        let previousToken = savedToken
        try SummonKeychain.save(token: newToken, for: endpoint)
        if changed || newToken != previousToken { SummonPush.shared.changeServer() }
        disconnect()
        if changed { clearServerState() }
        settings = SummonConnectionSettings(baseURL: endpoint,
            userName: settings.userName)
        if let data = try? JSONEncoder().encode(settings) { defaults.set(data, forKey: settingsKey) }
        client = newClient
        if changed { restoreSnapshot() }
        if let startup { acceptStartup(startup) }
        else { protocolNotice = "连接已保存，等待服务响应。" }
        errorMessage = nil
        persistNow()
        if startup != nil { await start() }
        else { Task { await start() } }
    }

    func openPushRoom(_ id: String) async throws {
        if room(id: id) != nil { return }
        guard protocolReady, let client else {
            throw SummonAPIError.protocolUnavailable(protocolNotice ?? "正在连接实例。")
        }
        let connection = connectionGeneration
        let snapshot = try await client.request(SummonRoomSnapshot.self, path: Self.roomPath(id) + "?limit=1")
        guard connection == connectionGeneration else { throw CancellationError() }
        if room(id: id) == nil { rooms.append(snapshot.room) }
    }

    func setUserName(_ name: String) {
        settings.userName = name.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? "Lin"
        if let data = try? JSONEncoder().encode(settings) { defaults.set(data, forKey: settingsKey) }
    }

    func refresh() async {
        guard let client, foreground else { return }
        if isRefreshing { refreshAgain = true; return }
        let connection = connectionGeneration
        isRefreshing = true
        isLoading = rooms.isEmpty && bots.isEmpty
        defer {
            if connection == connectionGeneration {
                isLoading = false
                isRefreshing = false
                if refreshAgain { refreshAgain = false; scheduleRefresh() }
            }
        }
        do {
            if !protocolReady || protocolNotice != nil {
                let startup = try await client.bootstrap(probe: true)
                guard connection == connectionGeneration, !Task.isCancelled else { return }
                acceptStartup(startup)
                guard startup.ready else { return }
            }
            let state = try await client.request(SummonState.self, path: "/api/state")
            guard connection == connectionGeneration, !Task.isCancelled else { return }
            if historyEpoch != state.historyEpoch {
                messageHistory = [:]
                deliveries = [:]
                messageSummaries = [:]
                cursors = [:]
            }
            historyEpoch = state.historyEpoch
            bots = state.bots
            rooms = state.rooms
            if let model = state.modelSettings { modelSummary = model }
            errorMessage = nil
            lastSyncAt = Date()
            if let id = activeRoomID, room(id: id) != nil { await loadRoom(id) }
            guard connection == connectionGeneration else { return }
            schedulePersistence()
            if protocolReady && pushGeneration != connection {
                pushGeneration = connection
                await SummonPush.shared.connect(client)
            }
        } catch {
            guard connection == connectionGeneration, !Task.isCancelled else { return }
            if !protocolReady { protocolNotice = startupError(error).localizedDescription }
            else { handle(error) }
        }
    }

    private func acceptStartup(_ startup: SummonBootstrap) {
        protocolReady = startup.ready
        protocolNotice = startup.notice
        needsClientUpdate = startup.protocolVersion > SummonAPIClient.protocolVersion
    }

    private func startupError(_ error: Error) -> Error {
        if case SummonAPIError.http(404, _, nil) = error {
            return SummonAPIError.protocolUnavailable("正在等待服务支持当前协议。草稿和待确认的发送已保留。")
        }
        if case SummonAPIError.http(503, _, "updating") = error {
            return SummonAPIError.protocolUnavailable("服务正在更新。草稿和待确认的发送已保留。")
        }
        return error
    }

    private func handle(_ error: Error) {
        if case SummonAPIError.http(426, _, _) = error {
            protocolReady = false
            isConnected = false
            protocolNotice = "正在重新检查服务协议。"
            scheduleRefresh()
        } else if case SummonAPIError.http(503, _, "updating") = error {
            protocolNotice = "服务正在更新。草稿和待确认的发送已保留。"
        } else { errorMessage = error.localizedDescription }
    }

    func selectRoom(_ id: String) async {
        ensureRoomActive(id)
        await loadRoom(id)
    }

    func ensureRoomActive(_ id: String) {
        selectedRoomID = id
        activeRoomID = id
        schedulePersistence()
    }

    func deactivateRoom(_ id: String) {
        if activeRoomID == id { activeRoomID = nil }
    }

    func messagesForRoom(_ id: String) -> [SummonMessage] {
        let remote = messageHistory[id] ?? []
        let confirmed = Set(remote.filter(\.isOwn).compactMap(\.clientId))
        return remote + pendingMessages.filter { $0.roomID == id && !confirmed.contains($0.clientID) }.map(\.message)
    }

    func bot(id: String) -> SummonBot? { bots.first { $0.id == id } }
    func room(id: String) -> SummonRoom? { rooms.first { $0.id == id } }
    func name(for id: String) -> String {
        switch id {
        case "user": settings.userName
        case "system", "platform": "Summon 平台"
        default: bot(id: id)?.name ?? id
        }
    }

    func label(_ ref: SummonReference) -> String {
        switch ref.kind {
        case "bot", "user": name(for: ref.id)
        case "room": room(id: ref.id)?.name ?? ref.id
        case "event": "消息 · \(ref.id)"
        case "file": "资料 · \(ref.id)"
        case "workspace_file": "工作区 · \((ref.filePath as NSString?)?.lastPathComponent ?? ref.filePath ?? ref.id)"
        case "session": "执行会话 · \(ref.id)"
        case "conversation": "内部对话 · \(ref.id)"
        default: ref.id
        }
    }

    func deliveryFacts(_ id: String) -> [SummonDelivery] { deliveries[id] ?? [] }
    func summaryFacts(_ id: String) -> [SummonMessageSummary] { messageSummaries[id] ?? [] }
    func executionsForRoom(_ id: String) -> [SummonJSONValue] { roomExecutions[id] ?? [] }
    func activeExecutionsForRoom(_ id: String) -> [SummonJSONValue] {
        let live: Set<String> = ["running", "waiting", "queued", "needs_input", "awaiting_input"]
        return (roomExecutions[id] ?? []).filter { live.contains($0["status"].stringValue) }
    }
    func pendingMessage(for message: SummonMessage) -> SummonPendingMessage? {
        pendingMessages.first { $0.clientID == message.clientId && $0.roomID == message.roomId }
    }

    func canLoadOlder(_ id: String) -> Bool { cursors[id] != nil }

    func loadRoom(_ id: String, older: Bool = false) async {
        guard protocolReady, let client else { return }
        guard roomReads.insert(id).inserted else {
            if older { olderReadsWaiting.insert(id) }
            return
        }
        let connection = connectionGeneration
        defer {
            if connection == connectionGeneration {
                roomReads.remove(id)
                if olderReadsWaiting.remove(id) != nil, activeRoomID == id {
                    Task {
                        if connection == connectionGeneration, activeRoomID == id { await loadRoom(id, older: true) }
                    }
                }
            }
        }
        let cursor = older ? cursors[id] : nil
        if older && cursor == nil { return }
        let suffix = cursor.map { "?cursor=\(SummonAPIClient.component($0))" } ?? ""
        do {
            let snapshot = try await client.request(SummonRoomSnapshot.self, path: Self.roomPath(id) + "/messages" + suffix)
            guard connection == connectionGeneration, !Task.isCancelled else { return }
            guard snapshot.historyEpoch == historyEpoch else { scheduleRefresh(); return }
            upsertRoom(snapshot.room)
            let cached = messageHistory[id] ?? []
            let pageIDs = Set(snapshot.messages.map(\.id))
            let retainCache = older || cached.contains { pageIDs.contains($0.id) }
            var byID: [String: SummonMessage] = [:]
            if retainCache { for message in cached { byID[message.id] = message } }
            for message in snapshot.messages { byID[message.id] = message }
            messageHistory[id] = byID.values.sorted(by: Self.messageOrder)
            let oldest = messageHistory[id]?.first?.id
            if older || oldest == snapshot.messages.first?.id { cursors[id] = snapshot.cursor }
            else if cursors[id] == nil { cursors[id] = oldest }
            deliveries.merge(snapshot.deliveries ?? [:]) { _, new in new }
            messageSummaries.merge(snapshot.summaries ?? [:]) { _, new in new }
            let confirmed = Set(snapshot.messages.filter(\.isOwn).compactMap(\.clientId))
            let staged = pendingMessages.filter { $0.roomID == id && confirmed.contains($0.clientID) }.flatMap(\.attachments)
            pendingMessages.removeAll { $0.roomID == id && confirmed.contains($0.clientID) }
            if !staged.isEmpty, persistComposer() { staged.forEach(discardStagedAttachment) }
            schedulePersistence()
            lastSyncAt = Date()
            if !older {
                if let execs = try? await list("/api/executions?room=" + SummonAPIClient.component(id)),
                   connection == connectionGeneration, !Task.isCancelled {
                    roomExecutions[id] = execs
                }
            }
        } catch {
            if connection == connectionGeneration, id == activeRoomID, !Task.isCancelled { handle(error) }
        }
    }

    nonisolated private static func messageOrder(_ a: SummonMessage, _ b: SummonMessage) -> Bool {
        if a.createdAt == b.createdAt, let first = a.sequence, let second = b.sequence, first != second { return first < second }
        return (a.createdAt ?? "", a.id) < (b.createdAt ?? "", b.id)
    }

    func openDirectMessage(bot: SummonBot) async throws -> SummonRoom {
        if let room = rooms.first(where: { !$0.isGroup && $0.members.contains(bot.id) }) { return room }
        return try await createGroup(name: bot.name, members: [bot.id])
    }

    func fetchBot(_ id: String) async throws -> SummonBot {
        try await business(SummonBot.self, "/api/bots/\(SummonAPIClient.component(id))", "GET", nil)
    }

    func createBot(name: String, avatar: SummonAvatar, instructions: String) async throws -> SummonBot {
        let result = try await business(SummonBot.self, "/api/bots", "POST", .object([
            "name": .string(name), "instructions": .string(instructions), "avatar": try Self.json(avatar)
        ]), clientID: Self.newID())
        upsertBot(result)
        return result
    }

    func updateBot(_ bot: SummonBot, changes: [String: SummonJSONValue]) async throws -> SummonBot {
        guard let revision = bot.revision else { throw SummonAPIError.invalidResponse }
        var body = changes
        body["revision"] = .number(Double(revision))
        let result = try await business(SummonBot.self, "/api/bots/\(SummonAPIClient.component(bot.id))", "PATCH",
                                        .object(body), clientID: Self.newID())
        upsertBot(result)
        return result
    }

    func setAvatar(_ avatar: SummonAvatar, bot: SummonBot) async throws -> SummonBot {
        let result = try await business(SummonBot.self, "/api/bots/\(SummonAPIClient.component(bot.id))", "PATCH",
                                        .object(["avatar": try Self.json(avatar)]), clientID: Self.newID())
        upsertBot(result)
        return result
    }

    func createGroup(name: String, members: [String]) async throws -> SummonRoom {
        var body: [String: SummonJSONValue] = ["members": .array(members.map(SummonJSONValue.string))]
        if !name.isEmpty { body["title"] = .string(name) }
        let result = try await business(SummonRoom.self, "/api/rooms", "POST", .object(body), clientID: Self.newID())
        upsertRoom(result)
        return result
    }

    func updateRoom(_ room: SummonRoom, name: String, members: [String]) async throws {
        let title = name.trimmingCharacters(in: .whitespacesAndNewlines)
        var changes: [String: SummonJSONValue] = [
            "add_members": .array(members.filter { !room.members.contains($0) }.map(SummonJSONValue.string)),
            "remove_members": .array(room.members.filter { $0 != "user" && !members.contains($0) }.map(SummonJSONValue.string))
        ]
        if !title.isEmpty, title != room.name { changes["title"] = .string(title) }
        try await changeRoom(room, changes)
    }

    func leaveRoom(_ room: SummonRoom) async throws {
        try await changeRoom(room, ["remove_members": .array([.string("user")])])
        removeLocalRoom(room.id)
    }

    func deleteGroup(_ room: SummonRoom) async throws {
        guard let revision = room.revision else { throw SummonAPIError.invalidResponse }
        _ = try await request(path: Self.roomPath(room.id), method: "DELETE", body: .object(["revision": .number(Double(revision))]))
        removeLocalRoom(room.id)
    }

    private func removeLocalRoom(_ id: String) {
        rooms.removeAll { $0.id == id }
        if activeRoomID == id { activeRoomID = nil }
        if selectedRoomID == id { selectedRoomID = nil }
        schedulePersistence()
    }

    func setPin(_ ref: SummonReference, in room: SummonRoom, remove: Bool) async throws {
        try await changeRoom(room, [remove ? "pin_remove" : "pin_add": .array([ref.json])])
    }

    private func changeRoom(_ room: SummonRoom, _ changes: [String: SummonJSONValue]) async throws {
        guard let revision = room.revision else { throw SummonAPIError.invalidResponse }
        var body = changes
        body["revision"] = .number(Double(revision))
        upsertRoom(try await business(SummonRoom.self, Self.roomPath(room.id), "PATCH", .object(body), clientID: Self.newID()))
    }

    func draft(for id: String) -> String { drafts[id] ?? "" }
    func setDraft(_ value: String, for id: String) { drafts[id] = value; schedulePersistence() }
    func setDraftAttachments(_ value: [SummonAttachment], for id: String) { draftAttachments[id] = value; persistNow() }
    func setDraftMentions(_ value: [String], for id: String) { draftMentions[id] = value; schedulePersistence() }
    func setDraftReply(_ value: String?, for id: String) { draftReplies[id] = value; schedulePersistence() }
    func setDraftReferences(_ value: [SummonReference], for id: String) { draftReferences[id] = value; schedulePersistence() }

    func sendMessage(roomID: String) async {
        guard protocolReady, !sendingRoomIDs.contains(roomID) else { return }
        let text = draft(for: roomID)
        let attachments = draftAttachments[roomID] ?? []
        let refs = draftReferences[roomID] ?? []
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !attachments.isEmpty || !refs.isEmpty else { return }
        guard attachments.count <= 8 else { errorMessage = SummonAPIError.tooManyAttachments.localizedDescription; return }
        let id = Self.newID()
        let message = SummonMessage(id: "local-\(id)", roomId: roomID, senderId: "user", content: text,
            attachments: attachments, references: refs, mentions: draftMentions[roomID] ?? [],
            replyTo: draftReplies[roomID], clientId: id, createdAt: ISO8601DateFormatter().string(from: Date()))
        pendingMessages.append(SummonPendingMessage(clientID: id, message: message, status: "queued"))
        drafts[roomID] = nil
        draftAttachments[roomID] = nil
        draftMentions[roomID] = nil
        draftReplies[roomID] = nil
        draftReferences[roomID] = nil
        await deliver(id, queryFirst: false)
    }

    func retryMessage(clientID: String) async {
        await deliver(clientID, queryFirst: true)
    }

    func restoreRejectedMessage(_ item: SummonPendingMessage) throws {
        let id = item.roomID
        guard pendingMessages.contains(where: { $0.clientID == item.clientID && $0.status == "rejected" }) else { return }
        guard draft(for: id).isEmpty, draftAttachments[id]?.isEmpty != false, draftMentions[id]?.isEmpty != false,
              draftReferences[id]?.isEmpty != false, draftReplies[id] == nil else {
            throw SummonAPIError.http(0, "请先保存或清空输入框里的草稿，再恢复这条消息。")
        }
        let message = item.message
        drafts[id] = message.content; draftAttachments[id] = message.attachments
        draftMentions[id] = message.mentions; draftReferences[id] = message.references; draftReplies[id] = message.replyTo
        pendingMessages.removeAll { $0.clientID == item.clientID }
        persistComposer()
    }

    private func deliver(_ id: String, queryFirst: Bool) async {
        guard protocolReady, let client, let item = pendingMessages.first(where: { $0.id == id }),
              !["sent", "rejected"].contains(item.status), sendingRoomIDs.insert(item.roomID).inserted else { return }
        let connection = connectionGeneration
        defer {
            if connection == connectionGeneration {
                sendingRoomIDs.remove(item.roomID)
                if pendingMessages.first(where: { $0.id == id })?.status == "sending" {
                    updatePending(id) { $0.status = "failed"; $0.error = protocolNotice ?? "保存状态待确认。" }
                    persistComposer()
                }
            }
        }
        updatePending(id) { $0.status = "sending"; $0.error = nil }
        guard persistComposer() else {
            updatePending(id) { $0.status = "failed"; $0.error = "本机发送记录无法保存。" }
            return
        }
        var submittingMessage = false
        do {
            let path = Self.roomPath(item.roomID) + "/messages"
            var receipt: SummonReceipt?
            if queryFirst {
                do { receipt = try await client.request(SummonReceipt.self, path: path + "/receipt?clientId=\(SummonAPIClient.component(id))") }
                catch SummonAPIError.http(404, _, _) { }
            }
            if receipt == nil {
                let message = item.message
                var attachments: [SummonJSONValue] = []
                for attachment in item.attachments {
                    guard connection == connectionGeneration, protocolReady else { return }
                    let file = try await preparedAttachment(attachment, client: client)
                    attachments.append(SummonReference(kind: "file", id: file.id).json)
                }
                guard connection == connectionGeneration, protocolReady else { return }
                var body: [String: SummonJSONValue] = ["text": .string(message.content), "clientId": .string(id),
                    "attachments": .array(attachments), "references": .array(message.references.map(\.json)),
                    "mentions": .array(message.mentions.map(SummonJSONValue.string))]
                if let reply = message.replyTo { body["reply_to"] = SummonReference(kind: "event", id: reply).json }
                submittingMessage = true
                receipt = try await client.request(SummonReceipt.self, path: path, method: "POST", body: .object(body), clientID: id)
            }
            guard connection == connectionGeneration else { return }
            guard let receipt, receipt.message.clientId == id, receipt.message.roomId == item.roomID,
                  receipt.message.isOwn, !receipt.message.id.isEmpty else { throw SummonAPIError.invalidReceipt }
            deliveries[receipt.message.id] = receipt.deliveries
            updatePending(id) { $0.message = receipt.message; $0.status = "sent"; $0.error = nil }
            if let index = rooms.firstIndex(where: { $0.id == item.roomID }) { rooms[index].lastMessage = receipt.message }
            if persistComposer() { item.attachments.forEach(discardStagedAttachment) }
            schedulePersistence()
            scheduleRefresh()
        } catch {
            guard connection == connectionGeneration else { return }
            var rejected = false
            if submittingMessage, case SummonAPIError.http(let status, _, _) = error { rejected = [400, 413, 415, 422].contains(status) }
            updatePending(id) { $0.status = rejected ? "rejected" : "failed"; $0.error = error.localizedDescription }
            persistComposer()
            if (error as? SummonAPIError)?.interruptsProtocol == true { handle(error) }
        }
    }

    func stageAttachment(fileURL: URL) async throws -> SummonAttachment {
        let accessing = fileURL.startAccessingSecurityScopedResource()
        defer { if accessing { fileURL.stopAccessingSecurityScopedResource() } }
        let result = try await Task.detached(priority: .userInitiated) {
            let attributes = try fileURL.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey])
            guard (attributes.fileSize ?? 0) <= 20 * 1024 * 1024 else { throw SummonAPIError.attachmentTooLarge }
            return (try Data(contentsOf: fileURL), attributes.contentType?.preferredMIMEType ?? "application/octet-stream")
        }.value
        return try stageAttachment(data: result.0, name: fileURL.lastPathComponent, mimeType: result.1)
    }

    func stageAttachment(data: Data, name: String, mimeType: String) throws -> SummonAttachment {
        guard data.count <= 20 * 1024 * 1024 else { throw SummonAPIError.attachmentTooLarge }
        let id = Self.newID()
        guard let url = stagingURL(id) else { throw SummonAPIError.missingAttachment }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        return SummonAttachment(id: id, name: name, mimeType: mimeType, size: data.count, staged: true)
    }

    func discardStagedAttachment(_ attachment: SummonAttachment) {
        if attachment.staged == true, let url = stagingURL(attachment.id) { try? FileManager.default.removeItem(at: url) }
    }

    private func stagingURL(_ id: String) -> URL? {
        guard UUID(uuidString: id) != nil else { return nil }
        return storageDirectory?.appending(path: "attachments").appending(path: id)
    }

    private func preparedAttachment(_ attachment: SummonAttachment, client: SummonAPIClient) async throws -> SummonAttachment {
        guard attachment.staged == true else { return attachment }
        guard let url = stagingURL(attachment.id), FileManager.default.fileExists(atPath: url.path) else { throw SummonAPIError.missingAttachment }
        let data = try await Task.detached { try Data(contentsOf: url) }.value
        return try await client.upload(data: data, name: attachment.name,
            mimeType: attachment.mimeType ?? "application/octet-stream", clientID: attachment.id)
    }

    func attachmentFileURL(_ attachment: SummonAttachment) async throws -> URL {
        guard attachment.unavailable != true else { throw SummonAPIError.http(404, "附件不可用。") }
        return try await apiClient().download(path: attachment.downloadPath, name: attachment.name)
    }

    func attachmentPreviewData(_ attachment: SummonAttachment) async throws -> Data {
        try await apiClient().attachmentData(attachment)
    }

    func downloadFile(id: String, name: String, revision: Int? = nil) async throws -> URL {
        let query = revision.map { "?revision=\($0)" } ?? ""
        return try await apiClient().download(path: "/api/files/\(SummonAPIClient.component(id))/download\(query)", name: name)
    }

    func downloadWorkspaceFile(workspaceID: String, path filePath: String) async throws -> URL {
        let name = (filePath as NSString).lastPathComponent
        let endpoint = "/api/workspaces/\(SummonAPIClient.component(workspaceID))/file?path=\(SummonAPIClient.component(filePath))"
        return try await apiClient().download(path: endpoint, name: name.isEmpty ? "file" : name)
    }

    @discardableResult
    func refreshModelUsage(force: Bool = false) async throws -> SummonJSONValue {
        let result = try await request(path: "/api/model-settings/usage", method: "POST", body: .object(["force": .bool(force)]))
        modelSummary = result
        return result
    }

    func request(path: String, method: String = "GET", body: SummonJSONValue? = nil, clientID: String? = nil) async throws -> SummonJSONValue {
        try await business(SummonJSONValue.self, path, method, body, clientID: clientID)
    }

    func read(_ ref: SummonReference, cursor: String? = nil) async throws -> SummonJSONValue {
        if let path = ref.path {
            return try await request(path: path + (cursor.map { "?cursor=\(SummonAPIClient.component($0))" } ?? ""))
        }
        return try await request(path: "/api/platform/read", method: "POST", body: .object(["arguments": .object(["ref": ref.json])]))["result"]
    }

    func list(_ path: String) async throws -> [SummonJSONValue] {
        var cursor: String?
        var items: [SummonJSONValue] = []
        var visited = Set<String>()
        repeat {
            if let cursor, !visited.insert(cursor).inserted { break }
            let endpoint = path + (cursor.map { (path.contains("?") ? "&" : "?") + "cursor=" + SummonAPIClient.component($0) } ?? "")
            let page = try await request(path: endpoint)
            items += page["items"].array ?? []
            cursor = page["next_cursor"].string
        } while cursor != nil
        return items
    }

    private func apiClient() throws -> SummonAPIClient {
        guard let client else { throw SummonAPIError.noConnection }
        guard protocolReady else { throw SummonAPIError.protocolUnavailable(protocolNotice ?? "正在连接实例。") }
        return client
    }

    private func business<T: Decodable & Sendable>(_ type: T.Type, _ path: String, _ method: String,
        _ body: SummonJSONValue?, clientID: String? = nil) async throws -> T {
        let connection = connectionGeneration
        do {
            let result = try await apiClient().request(type, path: path, method: method, body: body, clientID: clientID)
            guard connection == connectionGeneration else { throw CancellationError() }
            return result
        } catch {
            if connection == connectionGeneration, (error as? SummonAPIError)?.interruptsProtocol == true {
                handle(error)
            }
            throw error
        }
    }

    private func startStream() {
        guard streamTask == nil, let client else { return }
        let connection = connectionGeneration
        streamTask = Task { [weak self] in
            var delay: UInt64 = 1
            while !Task.isCancelled, let self, self.foreground, connection == self.connectionGeneration {
                if !self.protocolReady || self.protocolNotice != nil { await self.refresh() }
                if self.protocolReady {
                    let started = ContinuousClock.now
                    do {
                        try await SummonEventStream(client: client).consume { [weak self] event in
                            await self?.receiveStream(event, connection: connection)
                        }
                    } catch {
                        guard !Task.isCancelled, connection == self.connectionGeneration else { return }
                        self.isConnected = false
                        if (error as? SummonAPIError)?.interruptsProtocol == true { self.handle(error) }
                        if started.duration(to: ContinuousClock.now) >= .seconds(30) { delay = 1 }
                    }
                }
                do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                delay = min(delay * 2, 30)
            }
        }
    }

    private func receiveStream(_ event: SummonStreamEvent, connection: Int) {
        guard foreground, connection == connectionGeneration else { return }
        isConnected = true
        switch event {
        case .connected, .change: scheduleRefresh()
        case .keepAlive: break
        }
    }

    private func startRecovery() {
        guard recoveryTask == nil else { return }
        let connection = connectionGeneration
        recoveryTask = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(15)) } catch { return }
                guard let self, self.foreground, connection == self.connectionGeneration else { return }
                if let id = self.activeRoomID, self.protocolReady { await self.loadRoom(id) }
            }
        }
    }

    private func scheduleRefresh() {
        guard foreground, refreshTask == nil else { return }
        let connection = connectionGeneration
        refreshTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(850)) } catch { return }
            guard let self, connection == self.connectionGeneration else { return }
            self.refreshTask = nil
            await self.refresh()
        }
    }

    private func clearServerState() {
        bots = []; rooms = []; messageHistory = [:]; deliveries = [:]; messageSummaries = [:]; cursors = [:]; roomExecutions = [:]
        pendingMessages = []; drafts = [:]; draftAttachments = [:]; draftMentions = [:]; draftReplies = [:]; draftReferences = [:]
        selectedRoomID = nil; activeRoomID = nil; historyEpoch = nil; lastSyncAt = nil; modelSummary = .null
    }

    private func upsertBot(_ bot: SummonBot) {
        if let index = bots.firstIndex(where: { $0.id == bot.id }) { bots[index] = bot }
        else { bots.append(bot) }
        schedulePersistence()
    }

    private func upsertRoom(_ room: SummonRoom) {
        if let index = rooms.firstIndex(where: { $0.id == room.id }) {
            if (room.revision ?? 0) >= (rooms[index].revision ?? 0) { rooms[index] = room }
        } else { rooms.append(room) }
        schedulePersistence()
    }

    private func updatePending(_ id: String, _ mutate: (inout SummonPendingMessage) -> Void) {
        if let index = pendingMessages.firstIndex(where: { $0.id == id }) { mutate(&pendingMessages[index]) }
    }

    nonisolated static func newID() -> String { UUID().uuidString.lowercased() }
    private static func roomPath(_ id: String) -> String { "/api/rooms/\(SummonAPIClient.component(id))" }

    private static func json<T: Encodable>(_ value: T) throws -> SummonJSONValue {
        try JSONDecoder().decode(SummonJSONValue.self, from: JSONEncoder().encode(value))
    }

    private struct LocalSnapshot: Codable {
        var endpoint: String
        var historyEpoch: String?
        var bots: [SummonBot]
        var rooms: [SummonRoom]
        var messageHistory: [String: [SummonMessage]]
        var summaries: [String: [SummonMessageSummary]]?
        var savedAt: Date
    }

    private struct LocalComposer: Codable {
        var endpoint: String
        var pendingMessages: [SummonPendingMessage]
        var drafts: [String: String]
        var draftAttachments: [String: [SummonAttachment]]
        var draftMentions: [String: [String]]?
        var draftReplies: [String: String]
        var draftReferences: [String: [SummonReference]]?
        var draftTargets: [String: String]?
    }

    private var snapshotURL: URL? {
        guard let directory = storageDirectory, !settings.baseURL.isEmpty else { return nil }
        let encoded = Data(settings.baseURL.utf8).base64EncodedString()
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "+", with: "-")
        let pieces = stride(from: 0, to: encoded.count, by: 120).map { offset in
            let start = encoded.index(encoded.startIndex, offsetBy: offset)
            return String(encoded[start..<encoded.index(start, offsetBy: min(120, encoded.count - offset))])
        }
        let target = pieces.reduce(directory.appending(path: "instances")) { $0.appending(path: $1) }
        return target.appending(path: "snapshot.json")
    }

    private func restoreSnapshot() {
        guard let url = snapshotURL, let directory = storageDirectory else { return }
        let files = FileManager.default
        let decoder = JSONDecoder()
        func decode<Value: Decodable>(_ type: Value.Type, _ path: URL) -> Value? {
            guard let data = try? Data(contentsOf: path) else { return nil }
            return try? decoder.decode(type, from: data)
        }
        let composerURL = url.deletingLastPathComponent().appending(path: "composer.json")
        if let snapshot = decode(LocalSnapshot.self, url), snapshot.endpoint == settings.baseURL {
            loadSnapshot(snapshot)
            if let composer = decode(LocalComposer.self, composerURL), composer.endpoint == settings.baseURL {
                loadComposer(composer)
            }
            return
        }

        let legacy = files.enumerator(at: directory.appending(path: "workspaces"),
            includingPropertiesForKeys: [.contentModificationDateKey], options: .skipsHiddenFiles)?
            .compactMap { $0 as? URL }.filter { ["snapshot.json", "composer.json"].contains($0.lastPathComponent) } ?? []
        let candidates = [directory.appending(path: "workspace.json")] + legacy
        var converted = Set<URL>()
        let snapshots = candidates.compactMap { path -> LocalSnapshot? in
            guard let value = decode(LocalSnapshot.self, path), value.endpoint == settings.baseURL else { return nil }
            converted.insert(path)
            return value
        }.sorted { $0.savedAt < $1.savedAt }
        if let newest = snapshots.last {
            for snapshot in snapshots where snapshot.historyEpoch == newest.historyEpoch { loadSnapshot(snapshot) }
        }
        let composers = candidates.compactMap { path -> (Date, LocalComposer)? in
            guard let value = decode(LocalComposer.self, path), value.endpoint == settings.baseURL else { return nil }
            if path.lastPathComponent == "snapshot.json",
               decode(LocalComposer.self, path.deletingLastPathComponent().appending(path: "composer.json"))?.endpoint == settings.baseURL {
                return nil
            }
            converted.insert(path)
            let date = (try? path.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
            return (date, value)
        }.sorted { $0.0 < $1.0 }
        for (_, composer) in composers { loadComposer(composer) }
        if let composer = decode(LocalComposer.self, composerURL), composer.endpoint == settings.baseURL { loadComposer(composer) }
        if !converted.isEmpty, persistNow() {
            for path in converted { try? files.removeItem(at: path) }
        }
    }

    private func loadSnapshot(_ saved: LocalSnapshot) {
        historyEpoch = saved.historyEpoch
        let botIDs = Set(saved.bots.map(\.id)), roomIDs = Set(saved.rooms.map(\.id))
        bots = bots.filter { !botIDs.contains($0.id) } + saved.bots
        rooms = rooms.filter { !roomIDs.contains($0.id) } + saved.rooms
        messageHistory.merge(saved.messageHistory) { _, latest in latest }
        if let savedSummaries = saved.summaries { messageSummaries.merge(savedSummaries) { _, latest in latest } }
        lastSyncAt = saved.savedAt
    }

    private func loadComposer(_ composer: LocalComposer) {
        let ids = Set(composer.pendingMessages.map(\.id))
        pendingMessages = pendingMessages.filter { !ids.contains($0.id) } + composer.pendingMessages.map { entry in
            guard entry.status == "sending" || entry.status == "queued" else { return entry }
            var value = entry; value.status = "failed"; value.error = "上次发送的保存状态待确认。"; return value
        }
        drafts.merge(composer.drafts) { _, latest in latest }
        draftAttachments.merge(composer.draftAttachments) { _, latest in latest }
        draftMentions.merge(composer.draftMentions ?? composer.draftTargets?.mapValues { [$0] } ?? [:]) { _, latest in latest }
        draftReplies.merge(composer.draftReplies) { _, latest in latest }
        draftReferences.merge(composer.draftReferences ?? [:]) { _, latest in latest }
    }

    private func schedulePersistence() {
        persistenceTask?.cancel()
        persistenceTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(220)) } catch { return }
            self?.persistNow()
        }
    }

    @discardableResult
    private func persistComposer() -> Bool {
        guard let folder = snapshotURL?.deletingLastPathComponent() else { return false }
        let composer = LocalComposer(endpoint: settings.baseURL,
            pendingMessages: pendingMessages, drafts: drafts, draftAttachments: draftAttachments,
            draftMentions: draftMentions, draftReplies: draftReplies, draftReferences: draftReferences, draftTargets: nil)
        do {
            try saveLocal(composer, to: folder.appending(path: "composer.json"))
            return true
        } catch {
            errorMessage = "无法保存本机草稿和发送记录：\(error.localizedDescription)"
            return false
        }
    }

    @discardableResult
    private func persistNow() -> Bool {
        persistenceTask?.cancel()
        persistenceTask = nil
        guard let url = snapshotURL, persistComposer() else { return false }
        let trimmedHistory = messageHistory.mapValues { Array($0.suffix(100)) }
        let keptMessageIDs = Set(trimmedHistory.values.flatMap { $0.map(\.id) })
        let trimmedSummaries = messageSummaries.filter { keptMessageIDs.contains($0.key) }
        let saved = LocalSnapshot(endpoint: settings.baseURL, historyEpoch: historyEpoch, bots: bots, rooms: rooms,
            messageHistory: trimmedHistory, summaries: trimmedSummaries.isEmpty ? nil : trimmedSummaries, savedAt: lastSyncAt ?? Date())
        do {
            try saveLocal(saved, to: url)
            return true
        } catch {
            errorMessage = "无法更新本机聊天缓存：\(error.localizedDescription)"
            return false
        }
    }

    private func saveLocal(_ value: some Encodable, to url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(value).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
