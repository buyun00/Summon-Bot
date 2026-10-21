import Foundation
import Observation
import UniformTypeIdentifiers

@MainActor
@Observable
final class RelayStore {
    private(set) var settings = RelayConnectionSettings()
    private(set) var bots: [RelayBot] = []
    private(set) var rooms: [RelayRoom] = []
    private(set) var messages: [RelayMessage] = []
    private(set) var jobs: [RelayJob] = []
    private(set) var agentRuns: [RelayAgentRun] = []
    private(set) var agentRunDetails: [String: RelayAgentRun] = [:]
    private(set) var messageHistory: [String: [RelayMessage]] = [:]
    private(set) var pendingMessages: [RelayPendingMessage] = []
    private(set) var drafts: [String: String] = [:]
    private(set) var draftAttachments: [String: [RelayAttachment]] = [:]
    private(set) var draftTargets: [String: String] = [:]
    private(set) var draftReplies: [String: String] = [:]
    private(set) var selectedRoomID: String?
    private(set) var isLoading = false
    private(set) var isRefreshing = false
    private(set) var isConnected = false
    private(set) var sendingRoomIDs: Set<String> = []
    private(set) var lastSyncAt: Date?
    var errorMessage: String?

    @ObservationIgnored private var client: RelayAPIClient?
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var persistenceTask: Task<Void, Never>?
    @ObservationIgnored private var connectionGeneration = 0
    @ObservationIgnored private var historyGeneration = 0
    @ObservationIgnored private var roomReadGeneration: [String: Int] = [:]
    @ObservationIgnored private var historyEpoch: String?
    @ObservationIgnored private var hasSnapshot = false
    @ObservationIgnored private var refreshAgain = false
    @ObservationIgnored private var startingConnection: Int?
    @ObservationIgnored private let defaults = UserDefaults.standard
    @ObservationIgnored private let settingsKey = "RelayNative.connection.v1"
    @ObservationIgnored private var cacheURL: URL?

    var isConfigured: Bool { client != nil }
    var savedToken: String { RelayKeychain.token(for: settings.baseURL) }
    var selectedRoom: RelayRoom? { rooms.first { $0.id == selectedRoomID } }
    var currentDraft: String {
        get { selectedRoomID.map { drafts[$0] ?? "" } ?? "" }
        set { if let id = selectedRoomID { setDraft(newValue, for: id) } }
    }

    init() {
        settings.baseURL = Bundle.main.object(forInfoDictionaryKey: "RelayDefaultServerURL") as? String ?? "https://bot.lin0.org"
        if let data = defaults.data(forKey: settingsKey),
           let saved = try? JSONDecoder().decode(RelayConnectionSettings.self, from: data) { settings = saved }
        if let url = try? RelayAPIClient.normalizedURL(settings.baseURL) {
            client = RelayAPIClient(baseURL: url, token: RelayKeychain.token(for: settings.baseURL))
        }
        if let root = try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                                   appropriateFor: nil, create: true) {
            let directory = root.appending(path: "RelayNative", directoryHint: .isDirectory)
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            var excluded = directory
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try? excluded.setResourceValues(values)
            cacheURL = directory.appending(path: "workspace.json")
        }
        restoreSnapshot()
    }

    func start() async {
        guard client != nil, startingConnection != connectionGeneration else { return }
        let connection = connectionGeneration
        startingConnection = connection
        defer { if startingConnection == connection { startingConnection = nil } }
        startStream()
        await refresh()
    }

    func reconnect() async {
        guard startingConnection != connectionGeneration else { return }
        disconnect()
        if let url = try? RelayAPIClient.normalizedURL(settings.baseURL) {
            client = RelayAPIClient(baseURL: url, token: savedToken)
        }
        await start()
    }

    func disconnect() {
        connectionGeneration += 1
        startingConnection = nil
        streamTask?.cancel()
        streamTask = nil
        refreshTask?.cancel()
        refreshTask = nil
        isConnected = false
        isRefreshing = false
        isLoading = false
        refreshAgain = false
        for index in pendingMessages.indices where pendingMessages[index].status == "sending" {
            pendingMessages[index].status = "failed"
            pendingMessages[index].error = "连接已暂停，送达状态待确认。请刷新后手动重试。"
        }
        sendingRoomIDs = []
        persistNow()
    }

    func saveConnection(baseURL: String, token: String, userName: String? = nil) async throws {
        let url = try RelayAPIClient.normalizedURL(baseURL)
        let endpoint = url.absoluteString
        try RelayKeychain.save(token: token.trimmingCharacters(in: .whitespacesAndNewlines), for: endpoint)
        let changedEndpoint = endpoint != settings.baseURL
        disconnect()
        settings = RelayConnectionSettings(baseURL: endpoint,
                                           userName: userName?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? settings.userName)
        if changedEndpoint { clearWorkspace() }
        client = RelayAPIClient(baseURL: url, token: RelayKeychain.token(for: endpoint))
        if let data = try? JSONEncoder().encode(settings) { defaults.set(data, forKey: settingsKey) }
        errorMessage = nil
        persistNow()
        await start()
        if let errorMessage { throw RelayAPIError.http(0, errorMessage) }
    }

    func setUserName(_ name: String) {
        settings.userName = name.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty ?? "你"
        if let data = try? JSONEncoder().encode(settings) { defaults.set(data, forKey: settingsKey) }
    }

    func refresh() async {
        guard let client else { return }
        if isRefreshing { refreshAgain = true; return }
        let connection = connectionGeneration
        isRefreshing = true
        isLoading = !hasSnapshot
        defer {
            if connection == connectionGeneration {
                isRefreshing = false
                isLoading = false
                if refreshAgain { refreshAgain = false; scheduleRefresh() }
            }
        }
        do {
            let snapshot = try await client.request(RelayWorkspace.self, path: "/api/state")
            guard connection == connectionGeneration, !Task.isCancelled else { return }
            acceptEpoch(snapshot.historyEpoch)
            bots = snapshot.bots
            rooms = snapshot.rooms
            agentRuns = snapshot.agentRuns ?? []
            hasSnapshot = true
            lastSyncAt = Date()
            errorMessage = nil
            if let selected = selectedRoomID, !rooms.contains(where: { $0.id == selected }) {
                selectedRoomID = nil
                messages = []
                jobs = []
            }
            if let selected = selectedRoomID { await loadRoom(selected, client: client, connection: connection) }
            schedulePersistence()
        } catch {
            if connection == connectionGeneration, !Task.isCancelled { errorMessage = error.localizedDescription }
        }
    }

    func selectRoom(_ id: String) async {
        selectedRoomID = id
        messages = messagesForRoom(id)
        jobs = []
        schedulePersistence()
        guard let client else { return }
        await loadRoom(id, client: client, connection: connectionGeneration)
    }

    func messagesForRoom(_ id: String) -> [RelayMessage] {
        let remote = messageHistory[id] ?? []
        let confirmed = Set(remote.filter { $0.senderId == "user" }.compactMap(\.clientId))
        return remote + pendingMessages.filter { $0.roomID == id && !confirmed.contains($0.clientID) }.map(\.message)
    }

    func bot(id: String) -> RelayBot? { bots.first { $0.id == id } }
    func room(id: String) -> RelayRoom? { rooms.first { $0.id == id } }
    func name(for id: String) -> String { id == "user" ? settings.userName : bot(id: id)?.name ?? (id == "system" ? "Relay" : id) }
    func pendingMessage(for message: RelayMessage) -> RelayPendingMessage? {
        pendingMessages.first { $0.clientID == message.clientId && $0.roomID == message.roomId }
    }

    func openDirectMessage(bot: RelayBot) async throws -> RelayRoom {
        if let room = rooms.first(where: { $0.kind == "dm" && $0.members.contains("user") && $0.members.contains(bot.id) && $0.members.count == 2 }) {
            await selectRoom(room.id)
            return room
        }
        let room = try await createGroup(name: "与 \(bot.name) 的私聊", members: ["user", bot.id], kind: "dm")
        await selectRoom(room.id)
        return room
    }

    func createBot(name: String, avatar: RelayAvatar, role: String = "项目协作",
                   expertise: String = "", prompt: String = "") async throws -> RelayBot {
        let connection = connectionGeneration
        let value = try Self.json(avatar)
        let result: RelayBot = try await apiClient().request(RelayBot.self, path: "/api/bots", method: "POST", body: .object([
            "id": .string("bot-\(UUID().uuidString.lowercased())"), "name": .string(name), "role": .string(role),
            "expertise": .string(expertise), "prompt": .string(prompt), "avatar": value
        ]))
        if connection == connectionGeneration { upsertBot(result); schedulePersistence() }
        return result
    }

    func updateBot(_ bot: RelayBot) async throws -> RelayBot {
        try await updateBot(id: bot.id, name: bot.name, role: bot.role, expertise: bot.expertise,
                            prompt: bot.prompt, status: bot.status, avatar: bot.avatar)
    }

    func updateBot(id: String, name: String? = nil, role: String? = nil, expertise: String? = nil,
                   prompt: String? = nil, status: String? = nil, avatar: RelayAvatar? = nil) async throws -> RelayBot {
        let connection = connectionGeneration
        var body: [String: RelayJSONValue] = [:]
        for (key, value) in [("name", name), ("role", role), ("expertise", expertise), ("prompt", prompt), ("status", status)] {
            if let value { body[key] = .string(value) }
        }
        if let avatar { body["avatar"] = try Self.json(avatar) }
        let result = try await apiClient().request(RelayBot.self, path: "/api/bots/\(RelayAPIClient.component(id))",
                                                   method: "PATCH", body: .object(body))
        if connection == connectionGeneration { upsertBot(result); schedulePersistence() }
        return result
    }

    func createGroup(name: String, members: [String], goal: String = "", kind: String = "group") async throws -> RelayRoom {
        let connection = connectionGeneration
        let result = try await apiClient().request(RelayRoom.self, path: "/api/rooms", method: "POST", body: .object([
            "name": .string(name), "kind": .string(kind), "goal": .string(goal), "members": .array(members.map(RelayJSONValue.string))
        ]))
        if connection == connectionGeneration { upsertRoom(result); schedulePersistence() }
        return result
    }

    func updateRoom(id: String, name: String, members: [String], goal: String = "") async throws -> RelayRoom {
        let connection = connectionGeneration
        let result = try await apiClient().request(RelayRoom.self, path: "/api/rooms/\(RelayAPIClient.component(id))", method: "PATCH", body: .object([
            "name": .string(name), "members": .array(members.map(RelayJSONValue.string)), "goal": .string(goal)
        ]))
        if connection == connectionGeneration { upsertRoom(result); schedulePersistence() }
        return result
    }

    func draft(for id: String) -> String { drafts[id] ?? "" }
    func setDraft(_ value: String, for id: String) { drafts[id] = value; schedulePersistence() }
    func updateDraft(_ value: String) { currentDraft = value }
    func setDraftAttachments(_ value: [RelayAttachment], for id: String) {
        draftAttachments[id] = Array(value.prefix(8)); schedulePersistence()
    }
    func setDraftTarget(_ value: String?, for id: String) { draftTargets[id] = value; schedulePersistence() }
    func setDraftReply(_ value: String?, for id: String) { draftReplies[id] = value; schedulePersistence() }

    /// Sends once. An uncertain receipt remains visible for an explicit retry with the same clientId.
    func sendMessage(roomID: String, content: String, attachments: [RelayAttachment] = [],
                     toBotID: String? = nil, replyTo: String? = nil) async {
        guard !sendingRoomIDs.contains(roomID) else { return }
        let text = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty || !attachments.isEmpty else { errorMessage = RelayAPIError.emptyMessage.localizedDescription; return }
        guard attachments.count <= 8 else { errorMessage = RelayAPIError.tooManyAttachments.localizedDescription; return }
        guard client != nil else { errorMessage = RelayAPIError.noConnection.localizedDescription; return }
        let id = UUID().uuidString.lowercased()
        let message = RelayMessage(id: "local-\(id)", roomId: roomID, senderId: "user", content: text,
                                   attachments: attachments, replyTo: replyTo, toBotId: toBotID,
                                   clientId: id, createdAt: ISO8601DateFormatter().string(from: Date()))
        pendingMessages.append(RelayPendingMessage(clientID: id, message: message, status: "sending"))
        drafts[roomID] = ""
        draftAttachments[roomID] = []
        draftTargets[roomID] = nil
        draftReplies[roomID] = nil
        updateVisibleMessages(roomID)
        persistNow()
        await deliver(clientID: id)
    }

    func retryMessage(clientID: String) async {
        guard let pending = pendingMessages.first(where: { $0.clientID == clientID }), pending.status == "failed" else { return }
        await deliver(clientID: clientID)
    }

    func cancelRun(id: String) async throws {
        _ = try await request(path: "/api/agent-runs/\(RelayAPIClient.component(id))/cancel", method: "POST", body: .object([:]))
        await refresh()
    }

    func fetchAgentRun(id: String) async throws -> RelayAgentRun {
        let connection = connectionGeneration
        let result = try await apiClient().request(RelayAgentRun.self, path: "/api/agent-runs/\(RelayAPIClient.component(id))")
        if connection == connectionGeneration { agentRunDetails[id] = result }
        return result
    }

    func uploadAttachment(fileURL: URL) async throws -> RelayAttachment {
        let client = try apiClient()
        let accessing = fileURL.startAccessingSecurityScopedResource()
        defer { if accessing { fileURL.stopAccessingSecurityScopedResource() } }
        let data = try await Task.detached(priority: .userInitiated) {
            let attributes = try fileURL.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey])
            guard (attributes.fileSize ?? 0) <= 20 * 1024 * 1024 else { throw RelayAPIError.attachmentTooLarge }
            let bytes = try Data(contentsOf: fileURL)
            guard bytes.count <= 20 * 1024 * 1024 else { throw RelayAPIError.attachmentTooLarge }
            return (bytes, attributes.contentType?.preferredMIMEType ?? "application/octet-stream")
        }.value
        return try await client.upload(data: data.0, name: fileURL.lastPathComponent, mimeType: data.1)
    }

    func uploadAttachment(data: Data, name: String, mimeType: String) async throws -> RelayAttachment {
        try await apiClient().upload(data: data, name: name, mimeType: mimeType)
    }

    func attachmentFileURL(_ attachment: RelayAttachment) async throws -> URL {
        try await apiClient().download(path: "/api/attachments/\(RelayAPIClient.component(attachment.id))", name: attachment.name)
    }

    func attachmentPreviewData(_ attachment: RelayAttachment) async throws -> Data {
        try await apiClient().attachmentData(attachment)
    }

    func artifactFileURL(_ artifact: RelayArtifact, runID: String, toolID: String) async throws -> URL {
        let component = RelayAPIClient.component
        return try await apiClient().download(path: "/api/agent-runs/\(component(runID))/tools/\(component(toolID))/artifacts/\(component(artifact.id))",
                                               name: artifact.name ?? "产物")
    }

    func request(path: String, method: String = "GET", body: RelayJSONValue? = nil) async throws -> RelayJSONValue {
        try await apiClient().request(RelayJSONValue.self, path: path, method: method, body: body)
    }

    private func apiClient() throws -> RelayAPIClient {
        guard let client else { throw RelayAPIError.noConnection }
        return client
    }

    private func deliver(clientID: String) async {
        guard let client, let item = pendingMessages.first(where: { $0.clientID == clientID }),
              !sendingRoomIDs.contains(item.roomID) else { return }
        let connection = connectionGeneration, history = historyGeneration
        sendingRoomIDs.insert(item.roomID)
        updatePending(clientID) { $0.status = "sending"; $0.error = nil }
        persistNow()
        defer {
            if connection == connectionGeneration, history == historyGeneration {
                sendingRoomIDs.remove(item.roomID)
                updateVisibleMessages(item.roomID)
                schedulePersistence()
                scheduleRefresh()
            }
        }
        do {
            let message = item.message
            var body: [String: RelayJSONValue] = [
                "content": .string(message.content), "clientId": .string(clientID),
                "attachments": .array(message.attachments.map { .object(["id": .string($0.id)]) })
            ]
            if let id = message.toBotId { body["toBotId"] = .string(id) }
            if let id = message.replyTo { body["replyTo"] = .string(id) }
            let sent = try await client.request(RelayMessage.self, path: "/api/rooms/\(RelayAPIClient.component(item.roomID))/messages",
                                               method: "POST", body: .object(body))
            guard connection == connectionGeneration, history == historyGeneration else { return }
            guard sent.clientId == clientID, sent.roomId == item.roomID, !sent.id.isEmpty else { throw RelayAPIError.invalidReceipt }
            updatePending(clientID) { $0.message = sent; $0.status = "sent"; $0.error = nil }
            if let index = rooms.firstIndex(where: { $0.id == item.roomID }) { rooms[index].lastMessage = sent }
        } catch {
            guard connection == connectionGeneration, history == historyGeneration else { return }
            // An SSE read can confirm this message while the POST is still returning.
            if messageHistory[item.roomID]?.contains(where: { $0.clientId == clientID && $0.senderId == "user" }) == true { return }
            updatePending(clientID) { $0.status = "failed"; $0.error = error.localizedDescription }
            errorMessage = "消息尚未确认送达，可在消息旁手动重试。"
        }
    }

    private func loadRoom(_ id: String, client: RelayAPIClient, connection: Int) async {
        let read = (roomReadGeneration[id] ?? 0) + 1
        roomReadGeneration[id] = read
        let history = historyGeneration
        do {
            let snapshot = try await client.request(RelayRoomSnapshot.self, path: "/api/rooms/\(RelayAPIClient.component(id))/messages")
            guard connection == connectionGeneration, history == historyGeneration,
                  roomReadGeneration[id] == read, !Task.isCancelled else { return }
            if hasSnapshot && snapshot.historyEpoch != historyEpoch {
                // A maintenance boundary was crossed; get the workspace before accepting room data.
                scheduleRefresh()
                return
            }
            upsertRoom(snapshot.room)
            messageHistory[id] = snapshot.messages
            let confirmed = Set(snapshot.messages.filter { $0.senderId == "user" }.compactMap(\.clientId))
            pendingMessages.removeAll { $0.roomID == id && confirmed.contains($0.clientID) }
            if selectedRoomID == id { messages = messagesForRoom(id); jobs = snapshot.jobs }
            lastSyncAt = Date()
            schedulePersistence()
        } catch {
            if connection == connectionGeneration, selectedRoomID == id, !Task.isCancelled { errorMessage = error.localizedDescription }
        }
    }

    private func startStream() {
        guard streamTask == nil, let client else { return }
        let connection = connectionGeneration
        streamTask = Task { [weak self] in
            var delay: UInt64 = 1
            while !Task.isCancelled {
                do {
                    try await RelayEventStream(client: client).consume { [weak self] event in
                        await self?.receiveStream(event, connection: connection)
                    }
                    delay = 1
                } catch {
                    guard !Task.isCancelled, let self, connection == self.connectionGeneration else { return }
                    self.isConnected = false
                    do { try await Task.sleep(for: .seconds(delay)) } catch { return }
                    delay = min(delay * 2, 30)
                }
            }
        }
    }

    private func receiveStream(_ event: RelayStreamEvent, connection: Int) {
        guard connection == connectionGeneration else { return }
        if case .connected = event { isConnected = true }
        scheduleRefresh()
    }

    private func scheduleRefresh() {
        guard client != nil, refreshTask == nil else { return }
        refreshTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(300)) } catch { return }
            guard let self, !Task.isCancelled else { return }
            self.refreshTask = nil
            await self.refresh()
        }
    }

    private func acceptEpoch(_ epoch: String?) {
        if hasSnapshot && historyEpoch != epoch {
            historyGeneration += 1
            messageHistory = [:]
            messages = []
            jobs = []
            pendingMessages = []
            drafts = [:]
            draftAttachments = [:]
            draftTargets = [:]
            draftReplies = [:]
            sendingRoomIDs = []
            agentRunDetails = [:]
        }
        historyEpoch = epoch
    }

    private func clearWorkspace() {
        historyGeneration += 1
        hasSnapshot = false
        historyEpoch = nil
        bots = []; rooms = []; messages = []; jobs = []; agentRuns = []; agentRunDetails = [:]
        messageHistory = [:]; pendingMessages = []; drafts = [:]; draftAttachments = [:]
        draftTargets = [:]; draftReplies = [:]; selectedRoomID = nil; sendingRoomIDs = []; lastSyncAt = nil
    }

    private func upsertBot(_ bot: RelayBot) {
        if let index = bots.firstIndex(where: { $0.id == bot.id }) { bots[index] = bot }
        else { bots.append(bot) }
    }

    private func upsertRoom(_ room: RelayRoom) {
        if let index = rooms.firstIndex(where: { $0.id == room.id }) {
            var updated = room
            updated.lastMessage = room.lastMessage ?? rooms[index].lastMessage
            rooms[index] = updated
        } else { rooms.append(room) }
    }

    private func updatePending(_ id: String, _ mutate: (inout RelayPendingMessage) -> Void) {
        guard let index = pendingMessages.firstIndex(where: { $0.clientID == id }) else { return }
        mutate(&pendingMessages[index])
    }

    private func updateVisibleMessages(_ roomID: String) {
        if selectedRoomID == roomID { messages = messagesForRoom(roomID) }
    }

    private static func json<T: Encodable>(_ value: T) throws -> RelayJSONValue {
        try JSONDecoder().decode(RelayJSONValue.self, from: JSONEncoder().encode(value))
    }

    private struct LocalSnapshot: Codable {
        var endpoint: String
        var historyEpoch: String?
        var bots: [RelayBot]
        var rooms: [RelayRoom]
        var agentRuns: [RelayAgentRun]
        var messageHistory: [String: [RelayMessage]]
        var pendingMessages: [RelayPendingMessage]
        var drafts: [String: String]
        var draftAttachments: [String: [RelayAttachment]]
        var draftTargets: [String: String]
        var draftReplies: [String: String]
        var selectedRoomID: String?
        var savedAt: Date
    }

    private func restoreSnapshot() {
        guard let url = cacheURL, let data = try? Data(contentsOf: url),
              let snapshot = try? JSONDecoder().decode(LocalSnapshot.self, from: data),
              snapshot.endpoint == settings.baseURL else { return }
        historyEpoch = snapshot.historyEpoch
        bots = snapshot.bots; rooms = snapshot.rooms; agentRuns = snapshot.agentRuns
        messageHistory = snapshot.messageHistory
        pendingMessages = snapshot.pendingMessages.map { entry in
            var restored = entry
            if restored.status == "sending" { restored.status = "failed"; restored.error = "上次发送尚未确认，请手动重试。" }
            return restored
        }
        drafts = snapshot.drafts; draftAttachments = snapshot.draftAttachments
        draftTargets = snapshot.draftTargets; draftReplies = snapshot.draftReplies
        selectedRoomID = snapshot.selectedRoomID
        if let id = selectedRoomID { messages = messagesForRoom(id) }
        lastSyncAt = snapshot.savedAt
        hasSnapshot = true
    }

    private func schedulePersistence() {
        persistenceTask?.cancel()
        persistenceTask = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(250)) } catch { return }
            self?.persistNow()
        }
    }

    private func persistNow() {
        persistenceTask?.cancel()
        persistenceTask = nil
        guard let url = cacheURL else { return }
        let snapshot = LocalSnapshot(endpoint: settings.baseURL, historyEpoch: historyEpoch, bots: bots,
            rooms: rooms, agentRuns: agentRuns, messageHistory: messageHistory, pendingMessages: pendingMessages,
            drafts: drafts, draftAttachments: draftAttachments, draftTargets: draftTargets,
            draftReplies: draftReplies, selectedRoomID: selectedRoomID, savedAt: lastSyncAt ?? Date())
        do {
            let data = try JSONEncoder().encode(snapshot)
            try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            errorMessage = "本机草稿暂时无法保存：\(error.localizedDescription)"
        }
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
