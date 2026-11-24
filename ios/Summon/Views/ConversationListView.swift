import SwiftUI

private let defaultFolderID = "__default__"

private struct HomeFolder: Codable, Identifiable, Equatable, Sendable {
    var id: String
    var name: String
    var keys: [String]
}

private struct HomeOrganization: Codable, Equatable, Sendable {
    var pinnedKeys: [String] = []
    var hiddenKeys: [String] = []
    var folders: [HomeFolder] = []
    var collapsedFolderIDs: [String] = []

    private static let storagePrefix = "SummonNative.homeOrg.v1."

    init(pinnedKeys: [String] = [], hiddenKeys: [String] = [], folders: [HomeFolder] = [], collapsedFolderIDs: [String] = []) {
        self.pinnedKeys = pinnedKeys
        self.hiddenKeys = hiddenKeys
        self.folders = folders
        self.collapsedFolderIDs = collapsedFolderIDs
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pinnedKeys = try c.decodeIfPresent([String].self, forKey: .pinnedKeys) ?? []
        hiddenKeys = try c.decodeIfPresent([String].self, forKey: .hiddenKeys) ?? []
        folders = try c.decodeIfPresent([HomeFolder].self, forKey: .folders) ?? []
        collapsedFolderIDs = try c.decodeIfPresent([String].self, forKey: .collapsedFolderIDs) ?? []
    }

    static func load(for endpoint: String) -> HomeOrganization {
        let key = storagePrefix + (endpoint.isEmpty ? "default" : endpoint)
        guard let data = UserDefaults.standard.data(forKey: key),
              var saved = try? JSONDecoder().decode(HomeOrganization.self, from: data) else {
            return HomeOrganization()
        }
        saved.collapsedFolderIDs.removeAll { $0 == defaultFolderID }
        return saved
    }

    func save(for endpoint: String) {
        let key = Self.storagePrefix + (endpoint.isEmpty ? "default" : endpoint)
        var persisted = self
        persisted.collapsedFolderIDs.removeAll { $0 == defaultFolderID }
        if let data = try? JSONEncoder().encode(persisted) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }

    func isPinned(_ itemKey: String) -> Bool { pinnedKeys.contains(itemKey) }
    func isHidden(_ itemKey: String) -> Bool { hiddenKeys.contains(itemKey) }

    mutating func togglePin(_ itemKey: String) {
        if let idx = pinnedKeys.firstIndex(of: itemKey) { pinnedKeys.remove(at: idx) }
        else {
            hiddenKeys.removeAll { $0 == itemKey }
            pinnedKeys.append(itemKey)
        }
    }

    mutating func setHidden(_ itemKey: String, hidden: Bool) {
        if hidden {
            pinnedKeys.removeAll { $0 == itemKey }
            if !hiddenKeys.contains(itemKey) { hiddenKeys.append(itemKey) }
        } else {
            hiddenKeys.removeAll { $0 == itemKey }
        }
    }

    func folderID(for itemKey: String) -> String? {
        folders.first { $0.keys.contains(itemKey) }?.id
    }

    mutating func move(_ itemKey: String, toFolder folderID: String?) {
        for idx in folders.indices {
            folders[idx].keys.removeAll { $0 == itemKey }
        }
        if let folderID, let idx = folders.firstIndex(where: { $0.id == folderID }) {
            folders[idx].keys.append(itemKey)
        }
    }

    func isCollapsed(_ folderID: String) -> Bool { collapsedFolderIDs.contains(folderID) }

    mutating func toggleCollapsed(_ folderID: String) {
        if let idx = collapsedFolderIDs.firstIndex(of: folderID) { collapsedFolderIDs.remove(at: idx) }
        else { collapsedFolderIDs.append(folderID) }
    }

    @discardableResult
    mutating func createFolder(named rawName: String) -> HomeFolder? {
        let trimmed = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let folder = HomeFolder(id: UUID().uuidString.lowercased(), name: trimmed, keys: [])
        folders.append(folder)
        return folder
    }

    mutating func renameFolder(id: String, to rawName: String) {
        let trimmed = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let idx = folders.firstIndex(where: { $0.id == id }) else { return }
        folders[idx].name = trimmed
    }

    mutating func deleteFolder(id: String) {
        folders.removeAll { $0.id == id }
        collapsedFolderIDs.removeAll { $0 == id }
    }
}

private let botMaintenanceRoomID = "room-default-bot-maintenance"

private enum ConversationRoute: Hashable {
    case room(String)
    case newGroup
}

private struct HomeEntry: Identifiable {
    let key: String
    let nodeID: String
    let nodeName: String
    let room: SummonRoom
    let title: String
    let preview: String
    let fullPreview: String
    let timestamp: String
    let sortDate: String
    let isSystem: Bool
    let isWorking: Bool

    var id: String { key }
    var roomID: String { room.id }
}

private enum DetailsSheetTarget: Identifiable {
    case room(String)
    var id: String {
        switch self {
        case .room(let id): "room:\(id)"
        }
    }
}

struct ConversationListView: View {
    @Environment(SummonStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage(SummonDisplayKey.appearance) private var appearanceRaw = SummonAppearance.system.rawValue
    @State private var path: [ConversationRoute] = []
    @State private var query = ""
    @State private var org = HomeOrganization()
    @State private var loadedEndpoint: String?
    @State private var showSettings = false
    @State private var showPanel = false
    @State private var showHidden = false
    @State private var showArchived = false
    @State private var showProfileMenu = false
    @State private var profileDestination: ProfileDestination?
    @State private var quotaItem: SummonJSONValue?
    @State private var detailsTarget: DetailsSheetTarget?
    @State private var newFolderAlert = false
    @State private var newFolderName = ""
    @State private var pendingMoveKey: String?
    @State private var renamingFolder: HomeFolder?
    @State private var renameFolderText = ""
    @State private var openingPush = false
    @FocusState private var searchFocused: Bool

    private func exclusiveWorkingBot(in room: SummonRoom) -> SummonBot? {
        var candidates: [SummonBot] = []
        if let leadID = room.lead_bot_id, let lead = store.bots.first(where: { $0.id == leadID }) {
            candidates.append(lead)
        }
        let allGroups = store.rooms.filter(\.isGroup)
        for memberID in room.members where memberID != "user" && memberID != room.lead_bot_id {
            guard let bot = store.bots.first(where: { $0.id == memberID }),
                  !["eggbot", "tool-onboarding"].contains(bot.role_id ?? "") else { continue }
            let roomCount = allGroups.filter { $0.members.contains(memberID) }.count
            if roomCount <= 1 { candidates.append(bot) }
        }
        return candidates.first { $0.resolvedActivity == "working" }
    }

    private var allEntries: [HomeEntry] {
        let multiOnline = store.onlineNodes.count > 1
        let items = store.hubNodes.isEmpty
            ? store.rooms.filter(\.isGroup).map { ("", "", $0) }
            : store.mixedGroupRooms
        return items.map { (nodeID, nodeName, room) in
            let last = room.lastMessage
            let sameNode = nodeID.isEmpty || nodeID == store.activeNodeID
            let activeBot = store.isConnected && sameNode ? exclusiveWorkingBot(in: room) : nil
            let singleLine: String
            let fullText: String
            if let activeBot {
                singleLine = "\(activeBot.name) · 正在处理…"
                let raw = last?.content.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                fullText = raw.isEmpty ? singleLine : raw
            } else if let last {
                let body = messageBodySummary(last)
                let sender = store.anyBot(id: last.senderId)?.name ?? store.name(for: last.senderId)
                singleLine = "\(sender)：\(body)"
                let raw = last.content.trimmingCharacters(in: .whitespacesAndNewlines)
                fullText = raw.isEmpty ? singleLine : raw
            } else {
                singleLine = "开始聊天"
                fullText = "还没有消息，点按开始对话。"
            }
            let date = last?.createdAt ?? room.updatedAt ?? room.createdAt ?? ""
            let entryKey = multiOnline && !nodeID.isEmpty ? "room:\(nodeID):\(room.id)" : "room:\(room.id)"
            return HomeEntry(
                key: entryKey,
                nodeID: nodeID,
                nodeName: multiOnline ? nodeName : "",
                room: room,
                title: room.name,
                preview: singleLine,
                fullPreview: fullText,
                timestamp: SummonFormat.time(last?.createdAt),
                sortDate: date,
                isSystem: room.id == botMaintenanceRoomID,
                isWorking: activeBot != nil
            )
        }
        .sorted {
            if $0.sortDate != $1.sortDate { return $0.sortDate > $1.sortDate }
            return $0.title.localizedStandardCompare($1.title) == .orderedAscending
        }
    }

    private var visibleEntries: [HomeEntry] {
        let hidden = Set(org.hiddenKeys)
        return allEntries.filter { !hidden.contains($0.key) }
    }

    private var hiddenEntries: [HomeEntry] {
        let hidden = Set(org.hiddenKeys)
        return allEntries.filter { hidden.contains($0.key) }
    }

    private var trimmedQuery: String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var filteredEntries: [HomeEntry] {
        guard !trimmedQuery.isEmpty else { return visibleEntries }
        return visibleEntries.filter {
            $0.title.localizedCaseInsensitiveContains(trimmedQuery) ||
            $0.preview.localizedCaseInsensitiveContains(trimmedQuery)
        }
    }

    private var pinnedEntries: [HomeEntry] {
        guard trimmedQuery.isEmpty else { return [] }
        let byKey = Dictionary(uniqueKeysWithValues: visibleEntries.map { ($0.key, $0) })
        return org.pinnedKeys.compactMap { byKey[$0] }
    }

    private var unpinnedEntries: [HomeEntry] {
        guard trimmedQuery.isEmpty else { return filteredEntries }
        let pinned = Set(org.pinnedKeys)
        return visibleEntries.filter { !pinned.contains($0.key) }
    }

    private var defaultFolderEntries: [HomeEntry] {
        let assigned = Set(org.folders.flatMap(\.keys))
        return unpinnedEntries.filter { !assigned.contains($0.key) && !$0.isSystem }
    }

    private var systemFolderEntries: [HomeEntry] {
        let assigned = Set(org.folders.flatMap(\.keys))
        return unpinnedEntries.filter { !assigned.contains($0.key) && $0.isSystem }
    }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if store.hubNodes.count > 1 || !store.offlineNodes.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            Button {
                                store.filterNodeID = nil
                            } label: {
                                Text("全部 \(store.onlineNodes.count)")
                                    .font(.caption.weight(.medium))
                                    .padding(.horizontal, 12).padding(.vertical, 6)
                                    .background(store.filterNodeID == nil ? Color.primary : SummonTheme.surface, in: Capsule())
                                    .foregroundStyle(store.filterNodeID == nil ? Color(uiColor: .systemBackground) : .primary)
                            }
                            .buttonStyle(.plain)
                            ForEach(store.onlineNodes) { node in
                                Button {
                                    store.filterNodeID = node.id
                                } label: {
                                    HStack(spacing: 5) {
                                        Circle().fill(Color.green).frame(width: 6, height: 6)
                                        Text(node.name)
                                    }
                                    .font(.caption.weight(.medium))
                                    .padding(.horizontal, 12).padding(.vertical, 6)
                                    .background(store.filterNodeID == node.id ? Color.primary : SummonTheme.surface, in: Capsule())
                                    .foregroundStyle(store.filterNodeID == node.id ? Color(uiColor: .systemBackground) : .primary)
                                }
                                .buttonStyle(.plain)
                            }
                            ForEach(store.offlineNodes) { node in
                                HStack(spacing: 5) {
                                    Circle().fill(Color.secondary.opacity(0.45)).frame(width: 6, height: 6)
                                    Text("\(node.name) · 离线")
                                }
                                .font(.caption)
                                .padding(.horizontal, 12).padding(.vertical, 6)
                                .background(SummonTheme.surface.opacity(0.55), in: Capsule())
                                .foregroundStyle(.secondary)
                            }
                        }
                        .padding(.horizontal, 20)
                    }
                    .listRowInsets(EdgeInsets(top: 6, leading: 0, bottom: 6, trailing: 0))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                }

                if store.isLoading && store.bots.isEmpty || store.protocolNotice != nil || store.errorMessage != nil || (!store.isConnected && !store.bots.isEmpty) {
                    connectionStatus
                        .listRowInsets(EdgeInsets(top: 6, leading: 20, bottom: 8, trailing: 20))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }

                if !pinnedEntries.isEmpty {
                    pinnedGrid
                        .listRowInsets(EdgeInsets(top: 10, leading: 20, bottom: 16, trailing: 20))
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }

                if !trimmedQuery.isEmpty {
                    ForEach(filteredEntries) { entry in
                        conversationRowCell(entry)
                    }
                } else {
                    if !defaultFolderEntries.isEmpty || !store.archivedRooms.isEmpty {
                        folderHeaderRow(id: defaultFolderID, title: "群聊", customFolder: nil)
                        if !org.isCollapsed(defaultFolderID) {
                            ForEach(defaultFolderEntries) { entry in
                                conversationRowCell(entry)
                            }
                            if !store.archivedRooms.isEmpty {
                                Button { showArchived = true } label: {
                                    HStack(spacing: 12) {
                                        ZStack {
                                            Circle().fill(SummonTheme.surface).frame(width: 44, height: 44)
                                            Image(systemName: "archivebox").font(.system(size: 18, weight: .medium)).foregroundStyle(.secondary)
                                        }
                                        VStack(alignment: .leading, spacing: 3) {
                                            HStack {
                                                Text("归档群助手")
                                                    .summonFont(.body, weight: .medium)
                                                    .foregroundStyle(.primary)
                                                Spacer()
                                                Text("\(store.archivedRooms.count)")
                                                    .summonFont(.caption2, weight: .medium)
                                                    .foregroundStyle(.secondary)
                                            }
                                            Text(store.archivedRooms.prefix(3).map(\.name).joined(separator: "、"))
                                                .summonFont(.footnote)
                                                .foregroundStyle(.secondary)
                                                .lineLimit(1)
                                        }
                                    }
                                    .padding(.vertical, 6)
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                .listRowInsets(EdgeInsets(top: 4, leading: 20, bottom: 4, trailing: 20))
                                .listRowSeparator(.hidden)
                                .listRowBackground(Color.clear)
                            }
                        }
                    }

                    ForEach(org.folders) { folder in
                        let folderKeys = Set(folder.keys)
                        let entries = unpinnedEntries.filter { folderKeys.contains($0.key) }
                        folderHeaderRow(id: folder.id, title: folder.name, customFolder: folder)
                        if !org.isCollapsed(folder.id) {
                            if entries.isEmpty {
                                Text("长按任意群聊可移动到此分组")
                                    .summonFont(.caption)
                                    .foregroundStyle(.tertiary)
                                    .listRowInsets(EdgeInsets(top: 8, leading: 22, bottom: 14, trailing: 22))
                                    .listRowSeparator(.hidden)
                                    .listRowBackground(Color.clear)
                            } else {
                                ForEach(entries) { entry in
                                    conversationRowCell(entry)
                                }
                            }
                        }
                    }

                    if !systemFolderEntries.isEmpty {
                        folderHeaderRow(id: "__system__", title: "系统", customFolder: nil)
                        if !org.isCollapsed("__system__") {
                            ForEach(systemFolderEntries) { entry in
                                conversationRowCell(entry)
                            }
                        }
                    }
                }

                if allEntries.isEmpty && store.archivedRooms.isEmpty && !store.isLoading && store.protocolReady {
                    ContentUnavailableView {
                        Label("你的工作空间", systemImage: "bubble.left.and.bubble.right")
                    } description: {
                        Text(store.errorMessage == nil ? "点击右上角 +，说出你想建的群，立即组建专属团队。" : "暂时无法获取记录，请检查服务连接。")
                    } actions: {
                        Button("新建群聊") { path.append(.newGroup) }.buttonStyle(.glass)
                        Button("连接设置") { showSettings = true }
                    }
                    .padding(.top, 70)
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                } else if filteredEntries.isEmpty && !trimmedQuery.isEmpty {
                    ContentUnavailableView.search(text: trimmedQuery)
                        .padding(.top, 50)
                        .listRowSeparator(.hidden)
                        .listRowBackground(Color.clear)
                }

                Color.clear
                    .frame(height: 16)
                    .listRowInsets(EdgeInsets())
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
            .listStyle(.plain)
            .environment(\.defaultMinListRowHeight, 10)
            .scrollContentBackground(.hidden)
            .background(SummonTheme.background)
            .scrollDismissesKeyboard(.interactively)
            .scrollEdgeEffectStyle(.soft, for: .all)
            .refreshable { await store.refresh() }
            .overlay(alignment: .top) {
                LinearGradient(
                    stops: [
                        .init(color: SummonTheme.background.opacity(0.95), location: 0.0),
                        .init(color: SummonTheme.background.opacity(0.68), location: 0.56),
                        .init(color: SummonTheme.background.opacity(0.0), location: 1.0)
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .frame(height: 108)
                .ignoresSafeArea(edges: .top)
                .allowsHitTesting(false)
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { bottomSearchBar }
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.hidden, for: .navigationBar)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showProfileMenu.toggle() } label: {
                        Image("OwnerAvatar").resizable().scaledToFill()
                            .frame(width: 34, height: 34)
                            .clipShape(.circle)
                            .overlay { Circle().strokeBorder(SummonTheme.bubbleStroke, lineWidth: 1) }
                            .overlay(alignment: .bottomTrailing) {
                                Circle().fill(store.isConnected ? SummonTheme.ok : .gray)
                                    .frame(width: 9, height: 9)
                                    .overlay { Circle().strokeBorder(SummonTheme.background, lineWidth: 1.8) }
                                    .offset(x: 1, y: 1)
                            }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(store.settings.userName)，菜单，\(store.isConnected ? "已连接" : "正在连接")")
                    .popover(isPresented: $showProfileMenu, arrowEdge: .top) {
                        profileMenu
                            .presentationCompactAdaptation(.popover)
                            .onDisappear { presentProfileDestination() }
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { path.append(.newGroup) } label: {
                        Image(systemName: "plus").summonFont(.title2)
                    }
                    .accessibilityLabel("新建群聊")
                    .disabled(!store.protocolReady)
                }
            }
            .navigationDestination(for: ConversationRoute.self) { route in
                switch route {
                case .room(let id):
                    ChatView(roomID: id)
                case .newGroup:
                    NewGroupDraftView { room in
                        path = [.room(room.id)]
                    }
                }
            }
            .onAppear {
                if loadedEndpoint != store.settings.baseURL {
                    loadedEndpoint = store.settings.baseURL
                    org = HomeOrganization.load(for: store.settings.baseURL)
                }
            }
            .onChange(of: store.settings.baseURL) { _, newURL in
                loadedEndpoint = newURL
                org = HomeOrganization.load(for: newURL)
            }
            .onChange(of: org) { _, updated in
                updated.save(for: store.settings.baseURL)
            }
            .onChange(of: SummonPush.shared.destinationRoomID, initial: true) { _, _ in openNotification() }
            .onChange(of: store.protocolReady) { _, _ in openNotification() }
            .onChange(of: store.settings) { old, new in
                if old.baseURL != new.baseURL { path = [] }
            }
            .alert("新建分组", isPresented: $newFolderAlert) {
                TextField("分组名称（如 Tech、工作）", text: $newFolderName)
                Button("取消", role: .cancel) { pendingMoveKey = nil; newFolderName = "" }
                Button("创建") {
                    if let folder = org.createFolder(named: newFolderName), let key = pendingMoveKey {
                        org.move(key, toFolder: folder.id)
                    }
                    pendingMoveKey = nil
                    newFolderName = ""
                }
            }
            .alert("重命名分组", isPresented: Binding(get: { renamingFolder != nil }, set: { if !$0 { renamingFolder = nil } })) {
                TextField("分组名称", text: $renameFolderText)
                Button("取消", role: .cancel) { renamingFolder = nil }
                Button("保存") {
                    if let folder = renamingFolder { org.renameFolder(id: folder.id, to: renameFolderText) }
                    renamingFolder = nil
                }
            }
            .summonSheet(isPresented: $showSettings) { ConnectionSettingsView() }
            .summonSheet(isPresented: $showPanel) {
                WorkspacePanelView { roomID in
                    openRoom(roomID)
                }
            }
            .summonSheet(isPresented: $showHidden) {
                HiddenConversationsSheet(entries: hiddenEntries) { key in
                    org.setHidden(key, hidden: false)
                }
            }
            .summonSheet(isPresented: $showArchived) {
                NavigationStack {
                    List {
                        ForEach(store.archivedRooms) { room in
                            HStack(spacing: 12) {
                                Button {
                                    showArchived = false
                                    path.append(.room(room.id))
                                } label: {
                                    HStack(spacing: 12) {
                                        RoomAvatar(room: room, size: 40, showOutline: false)
                                        VStack(alignment: .leading, spacing: 2) {
                                            Text(room.name).summonFont(.body, weight: .medium).foregroundStyle(.primary).lineLimit(1)
                                            Text("\(room.members.count) 位成员").summonFont(.caption).foregroundStyle(.secondary)
                                        }
                                        Spacer()
                                    }
                                    .contentShape(Rectangle())
                                }
                                .buttonStyle(.plain)
                                Button("恢复") {
                                    Task { try? await store.restoreRoom(room) }
                                }
                                .summonFont(.caption, weight: .medium)
                                .buttonStyle(.bordered)
                            }
                        }
                    }
                    .navigationTitle("归档群助手")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("关闭") { showArchived = false }
                        }
                    }
                }
            }
            .summonSheet(item: $detailsTarget) { target in
                NavigationStack {
                    switch target {
                    case .room(let id): RoomDetailsView(roomID: id)
                    }
                }
            }
            .summonSheet(isPresented: Binding(get: { quotaItem != nil }, set: { if !$0 { quotaItem = nil } })) {
                if let quotaItem { ModelQuotaDetailsView(item: quotaItem) }
            }
        }
    }

    private var bottomSearchBar: some View {
        GlassEffectContainer(spacing: 12) {
            HStack(spacing: 12) {
                Button { showSettings = true } label: {
                    Image(systemName: "gearshape")
                        .font(.system(size: 19, weight: .medium))
                        .foregroundStyle(.primary)
                        .frame(width: 48, height: 48)
                        .glassEffect(.regular, in: Circle())
                }
                .buttonStyle(SummonPressStyle(compact: true))
                .accessibilityLabel("设置")

                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(.secondary)
                    TextField("搜索群聊", text: $query)
                        .focused($searchFocused)
                        .submitLabel(.search)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    if !query.isEmpty {
                        Button { query = "" } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 16))
                                .foregroundStyle(.tertiary)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("清除搜索")
                    }
                }
                .padding(.horizontal, 16)
                .frame(height: 48)
                .glassEffect(.regular, in: Capsule())
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 18)
        .padding(.bottom, 10)
        .background(alignment: .bottom) {
            LinearGradient(
                stops: [
                    .init(color: SummonTheme.background.opacity(0.0), location: 0.0),
                    .init(color: SummonTheme.background.opacity(0.66), location: 0.30),
                    .init(color: SummonTheme.background.opacity(0.92), location: 0.62),
                    .init(color: SummonTheme.background.opacity(0.98), location: 1.0)
                ],
                startPoint: .top,
                endPoint: .bottom
            )
            .ignoresSafeArea(edges: .bottom)
            .allowsHitTesting(false)
        }
    }

    private var pinnedGrid: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 16), count: 3), spacing: 20) {
            ForEach(pinnedEntries) { entry in
                Button { openEntry(entry) } label: {
                    VStack(spacing: 9) {
                        entryAvatar(entry, size: 74)
                        Text(entry.title)
                            .summonFont(.footnote, weight: .medium)
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 4)
                }
                .buttonStyle(SummonPressStyle(compact: true))
                .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: 16))
                .contextMenu {
                    entryContextMenu(entry)
                } preview: {
                    entryPreviewCard(entry)
                }
            }
        }
    }

    @ViewBuilder
    private func folderHeaderRow(id: String, title: String, customFolder: HomeFolder?) -> some View {
        let collapsed = org.isCollapsed(id)
        let headerButton = Button {
            withAnimation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.84)) {
                org.toggleCollapsed(id)
            }
        } label: {
            HStack(spacing: 5) {
                Text(title)
                    .summonFont(.subheadline, weight: .medium)
                    .foregroundStyle(.secondary)
                Image(systemName: "chevron.down")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.tertiary)
                    .rotationEffect(.degrees(collapsed ? -90 : 0))
                Spacer()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)

        Group {
            if let customFolder {
                headerButton.contextMenu {
                    Button("重命名分组", systemImage: "pencil") {
                        renameFolderText = customFolder.name
                        renamingFolder = customFolder
                    }
                    Button("删除分组", systemImage: "trash", role: .destructive) {
                        org.deleteFolder(id: customFolder.id)
                    }
                }
            } else {
                headerButton
            }
        }
        .listRowInsets(EdgeInsets(top: 20, leading: 22, bottom: 8, trailing: 22))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }

    private func conversationRowCell(_ entry: HomeEntry) -> some View {
        let pinned = org.isPinned(entry.key)
        return Button { openEntry(entry) } label: {
            HStack(spacing: 15) {
                entryAvatar(entry, size: 52)
                    .overlay(alignment: .bottomTrailing) {
                        if entry.isWorking {
                            Circle()
                                .fill(Color.orange)
                                .frame(width: 11, height: 11)
                                .overlay { Circle().strokeBorder(SummonTheme.background, lineWidth: 2) }
                        }
                    }
                VStack(alignment: .leading, spacing: 6) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(entry.title)
                            .summonFont(.body, weight: .semibold)
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                        if !entry.nodeName.isEmpty {
                            Text(entry.nodeName)
                                .font(.caption2.weight(.medium))
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(SummonTheme.surface, in: Capsule())
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        Spacer(minLength: 8)
                        if !entry.timestamp.isEmpty {
                            Text(entry.timestamp)
                                .summonFont(.caption)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    Text(entry.preview)
                        .summonFont(.subheadline)
                        .foregroundStyle(entry.isWorking ? Color.orange : Color.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: 14))
        .contextMenu {
            entryContextMenu(entry)
        } preview: {
            entryPreviewCard(entry)
        }
        .listRowInsets(EdgeInsets(top: 15, leading: 20, bottom: 15, trailing: 20))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button(role: .destructive) {
                withAnimation(reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.84)) {
                    org.setHidden(entry.key, hidden: true)
                }
            } label: {
                Label("隐藏", systemImage: "eye.slash.fill")
            }
            .tint(.red)

            Button {
                withAnimation(reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.84)) {
                    org.togglePin(entry.key)
                }
            } label: {
                Label(pinned ? "取消置顶" : "置顶", systemImage: pinned ? "pin.slash.fill" : "pin.fill")
            }
            .tint(Color(uiColor: .systemGray2))
        }
    }

    private func entryPreviewCard(_ entry: HomeEntry) -> some View {
        let botsSnapshot = store.bots
        let scheme = (SummonAppearance(rawValue: appearanceRaw) ?? .system).colorScheme
        return VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                entryAvatar(entry, size: 28, bots: botsSnapshot, background: SummonTheme.surfaceElevated)
                Text(entry.title)
                    .summonFont(.headline)
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                Spacer()
                if !entry.timestamp.isEmpty {
                    Text(entry.timestamp)
                        .summonFont(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)

            Rectangle()
                .fill(SummonTheme.hairline)
                .frame(height: 0.6)

            VStack(alignment: .leading, spacing: 10) {
                Text(entry.fullPreview)
                    .summonFont(.body)
                    .foregroundStyle(.primary)
                    .lineLimit(8)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(SummonTheme.botBubble, in: RoundedRectangle(cornerRadius: 16))
            }
            .padding(14)
        }
        .frame(width: 320, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .background(SummonTheme.surfaceElevated)
        .preferredColorScheme(scheme)
        .environment(store)
    }

    @ViewBuilder
    private func entryAvatar(_ entry: HomeEntry, size: CGFloat, bots: [SummonBot]? = nil, background: Color = SummonTheme.background) -> some View {
        RoomAvatar(room: entry.room, size: size, background: background, bots: bots)
    }

    @ViewBuilder
    private func entryContextMenu(_ entry: HomeEntry) -> some View {
        let pinned = org.isPinned(entry.key)
        Button(pinned ? "取消置顶" : "置顶", systemImage: pinned ? "pin.slash" : "pin") {
            withAnimation(reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.82)) {
                org.togglePin(entry.key)
            }
        }
        Menu("移动到", systemImage: "folder") {
            let currentFolderID = org.folderID(for: entry.key)
            Button {
                org.move(entry.key, toFolder: nil)
            } label: {
                Label(entry.isSystem ? "系统" : "群聊", systemImage: currentFolderID == nil ? "checkmark" : "folder")
            }
            ForEach(org.folders) { folder in
                Button {
                    org.move(entry.key, toFolder: folder.id)
                } label: {
                    Label(folder.name, systemImage: currentFolderID == folder.id ? "checkmark" : "folder")
                }
            }
            Divider()
            Button("新建分组", systemImage: "folder.badge.plus") {
                pendingMoveKey = entry.key
                newFolderName = ""
                newFolderAlert = true
            }
        }
        Button("群聊详情", systemImage: "info.circle") {
            detailsTarget = .room(entry.roomID)
        }
        Divider()
        Button("隐藏", systemImage: "eye.slash", role: .destructive) {
            withAnimation(reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.84)) {
                org.setHidden(entry.key, hidden: true)
            }
        }
    }

    private func openEntry(_ entry: HomeEntry) {
        if !entry.nodeID.isEmpty && entry.nodeID != store.activeNodeID {
            Task {
                await store.switchNode(entry.nodeID)
                openRoom(entry.room.id)
            }
        } else {
            openRoom(entry.room.id)
        }
    }

    private var connectionStatus: some View {
        VStack(spacing: 8) {
            if store.isLoading && store.bots.isEmpty {
                ProgressView("正在打开工作空间…").padding(.top, 18)
            }
            if let notice = store.protocolNotice {
                SummonProtocolNotice(notice: notice, needsUpdate: store.needsClientUpdate)
            }
            if let error = store.errorMessage {
                HStack(alignment: .top) {
                    InlineError(message: error)
                    Button("重连") { Task { await store.refresh() } }.buttonStyle(.glass)
                }
            } else if !store.isConnected && !store.bots.isEmpty {
                Label("已显示本机记录，正在连接…", systemImage: "wifi.slash")
                    .summonFont(.footnote).foregroundStyle(.secondary)
            }
        }
    }

    private enum ProfileDestination {
        case panel, settings, hidden
        case quota(SummonJSONValue)
    }

    private var profileMenu: some View {
        VStack(spacing: 4) {
            HStack(spacing: 12) {
                ModelQuotaSignal(item: store.modelSummary["chat"], label: "默认模型") {
                    selectProfileDestination(.quota(store.modelSummary["chat"]))
                }
            }.padding(.vertical, 6)
            Divider().padding(.vertical, 4)
            profileMenuButton("面板", symbol: "square.stack.3d.up", destination: .panel)
            profileMenuButton("设置", symbol: "gearshape", destination: .settings)
            if !hiddenEntries.isEmpty {
                Divider().padding(.vertical, 4)
                profileMenuButton("已隐藏群聊（\(hiddenEntries.count)）", symbol: "eye.slash", destination: .hidden)
            }
        }
        .padding(12)
        .frame(width: 212)
    }

    private func profileMenuButton(_ title: String, symbol: String, destination: ProfileDestination) -> some View {
        Button { selectProfileDestination(destination) } label: {
            Label(title, systemImage: symbol)
                .summonFont(.body).frame(maxWidth: .infinity, minHeight: 42, alignment: .leading)
                .contentShape(Rectangle())
        }.buttonStyle(SummonPressStyle()).foregroundStyle(.primary)
    }

    private func selectProfileDestination(_ destination: ProfileDestination) {
        profileDestination = destination
        showProfileMenu = false
    }

    private func presentProfileDestination() {
        guard let destination = profileDestination else { return }
        profileDestination = nil
        switch destination {
        case .panel: showPanel = true
        case .settings: showSettings = true
        case .hidden: showHidden = true
        case .quota(let item): quotaItem = item
        }
    }

    private func messageBodySummary(_ message: SummonMessage) -> String {
        let cleaned = message.content
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if !cleaned.isEmpty { return cleaned }
        if !message.attachments.isEmpty {
            return "[附件] " + message.attachments.map(\.name).joined(separator: "、")
        }
        return "共享了引用"
    }

    private func openNotification() {
        guard let id = SummonPush.shared.destinationRoomID, store.protocolReady, !openingPush else { return }
        openingPush = true
        Task {
            defer {
                openingPush = false
                if SummonPush.shared.destinationRoomID != id { openNotification() }
            }
            do {
                let targetNode = SummonPush.shared.destinationNodeID
                try await store.openPushRoom(id, nodeID: targetNode)
                guard SummonPush.shared.destinationRoomID == id else { return }
                showSettings = false
                path = [.room(id)]
                SummonPush.shared.destinationRoomID = nil
                SummonPush.shared.destinationNodeID = nil
            } catch {
                if SummonPush.shared.destinationRoomID == id {
                    SummonPush.shared.destinationRoomID = nil
                    SummonPush.shared.destinationNodeID = nil
                }
                store.errorMessage = error.localizedDescription
            }
        }
    }

    private func openRoom(_ id: String) { path.append(.room(id)) }
}

private struct HiddenConversationsSheet: View {
    @Environment(\.dismiss) private var dismiss
    let entries: [HomeEntry]
    let onRestore: (String) -> Void

    var body: some View {
        NavigationStack {
            List {
                if entries.isEmpty {
                    Text("没有已隐藏的群聊")
                        .foregroundStyle(.secondary)
                }
                ForEach(entries) { entry in
                    HStack(spacing: 12) {
                        RoomAvatar(room: entry.room, size: 38)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(entry.title).summonFont(.body, weight: .medium)
                            Text(entry.preview).summonFont(.caption).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                        Button("取消隐藏") { onRestore(entry.key) }
                            .buttonStyle(.bordered)
                    }
                }
            }
            .navigationTitle("已隐藏群聊")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } }
            }
        }
    }
}
