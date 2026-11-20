import SwiftUI

private struct HomeFolder: Codable, Identifiable, Equatable {
    var id: String
    var name: String
    var keys: [String]
}

private struct HomeOrganization: Codable, Equatable {
    var pinnedKeys: [String] = []
    var folders: [HomeFolder] = []
    var collapsedFolderIDs: [String] = []

    private static let storagePrefix = "SummonNative.homeOrg.v1."

    static func load(for endpoint: String) -> HomeOrganization {
        let key = storagePrefix + (endpoint.isEmpty ? "default" : endpoint)
        guard let data = UserDefaults.standard.data(forKey: key),
              let saved = try? JSONDecoder().decode(HomeOrganization.self, from: data) else {
            return HomeOrganization()
        }
        return saved
    }

    func save(for endpoint: String) {
        let key = Self.storagePrefix + (endpoint.isEmpty ? "default" : endpoint)
        if let data = try? JSONEncoder().encode(self) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }

    func isPinned(_ itemKey: String) -> Bool { pinnedKeys.contains(itemKey) }

    mutating func togglePin(_ itemKey: String) {
        if let idx = pinnedKeys.firstIndex(of: itemKey) { pinnedKeys.remove(at: idx) }
        else { pinnedKeys.append(itemKey) }
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

private struct HomeEntry: Identifiable {
    enum Kind {
        case room(SummonRoom)
        case bot(SummonBot, SummonRoom?)
    }

    let key: String
    let kind: Kind
    let title: String
    let preview: String
    let timestamp: String
    let sortDate: String
    let isPaused: Bool

    var id: String { key }
}

struct ConversationListView: View {
    @Environment(SummonStore.self) private var store
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var path: [String] = []
    @State private var query = ""
    @State private var org = HomeOrganization()
    @State private var showSettings = false
    @State private var showDisplay = false
    @State private var showUsage = false
    @State private var showProfileMenu = false
    @State private var profileDestination: ProfileDestination?
    @State private var quotaItem: SummonJSONValue?
    @State private var showCreateBot = false
    @State private var showCreateRoom = false
    @State private var showModels = false
    @State private var showFolderManager = false
    @State private var newFolderAlert = false
    @State private var newFolderName = ""
    @State private var pendingMoveKey: String?
    @State private var resourceSection: ResourceSection?
    @State private var openingBot = false
    @State private var openingPush = false
    @FocusState private var searchFocused: Bool

    private var allEntries: [HomeEntry] {
        let directRoomsByBot: [String: SummonRoom] = Dictionary(
            store.bots.compactMap { bot in
                directRoom(bot).map { (bot.id, $0) }
            },
            uniquingKeysWith: { first, _ in first }
        )
        let primaryDirectRoomIDs = Set(directRoomsByBot.values.map(\.id))

        let groupEntries: [HomeEntry] = store.rooms
            .filter { room in !primaryDirectRoomIDs.contains(room.id) }
            .map { room in
                let last = room.lastMessage
                let summary: String
                if let last {
                    let body = messageBodySummary(last)
                    summary = "\(store.name(for: last.senderId))：\(body)"
                } else {
                    summary = "开始聊天"
                }
                let date = last?.createdAt ?? room.updatedAt ?? room.createdAt ?? ""
                return HomeEntry(
                    key: "room:\(room.id)",
                    kind: .room(room),
                    title: room.name,
                    preview: summary,
                    timestamp: SummonFormat.time(last?.createdAt),
                    sortDate: date,
                    isPaused: false
                )
            }

        let botEntries: [HomeEntry] = store.bots.map { bot in
            let room = directRoomsByBot[bot.id]
            let last = room?.lastMessage
            let summary: String
            if bot.isPaused {
                summary = "已暂停"
            } else if let last {
                summary = messageBodySummary(last)
            } else {
                summary = "开始聊天"
            }
            let date = last?.createdAt ?? room?.updatedAt ?? room?.createdAt ?? ""
            return HomeEntry(
                key: "bot:\(bot.id)",
                kind: .bot(bot, room),
                title: bot.name,
                preview: summary,
                timestamp: SummonFormat.time(last?.createdAt),
                sortDate: date,
                isPaused: bot.isPaused
            )
        }

        return (groupEntries + botEntries).sorted {
            if $0.sortDate != $1.sortDate { return $0.sortDate > $1.sortDate }
            return $0.title.localizedStandardCompare($1.title) == .orderedAscending
        }
    }

    private var filteredEntries: [HomeEntry] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return allEntries }
        return allEntries.filter {
            $0.title.localizedCaseInsensitiveContains(trimmed) ||
            $0.preview.localizedCaseInsensitiveContains(trimmed)
        }
    }

    private var pinnedEntries: [HomeEntry] {
        guard query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return [] }
        let byKey = Dictionary(uniqueKeysWithValues: allEntries.map { ($0.key, $0) })
        return org.pinnedKeys.compactMap { byKey[$0] }
    }

    private var unpinnedFilteredEntries: [HomeEntry] {
        if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return filteredEntries
        }
        let pinned = Set(org.pinnedKeys)
        return filteredEntries.filter { !pinned.contains($0.key) }
    }

    private var defaultFolderEntries: [HomeEntry] {
        let assigned = Set(org.folders.flatMap(\.keys))
        return unpinnedFilteredEntries.filter { !assigned.contains($0.key) }
    }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    connectionStatus

                    if !pinnedEntries.isEmpty {
                        pinnedGrid
                    }

                    if !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        ForEach(filteredEntries) { entry in
                            conversationRow(entry)
                        }
                    } else {
                        folderSection(id: "__default__", title: "主要", entries: defaultFolderEntries)
                        ForEach(org.folders) { folder in
                            let folderKeys = Set(folder.keys)
                            let entries = unpinnedFilteredEntries.filter { folderKeys.contains($0.key) }
                            folderSection(id: folder.id, title: folder.name, entries: entries, isCustom: true)
                        }
                    }

                    if store.bots.isEmpty && store.rooms.isEmpty && !store.isLoading && store.protocolReady {
                        ContentUnavailableView {
                            Label("你的工作空间", systemImage: "bubble.left.and.bubble.right")
                        } description: {
                            Text(store.errorMessage == nil ? "创建第一位 Bot，开始聊天。" : "暂时无法获取记录，请检查服务连接。")
                        } actions: {
                            Button("创建 Bot") { showCreateBot = true }.buttonStyle(.glass)
                            Button("连接设置") { showSettings = true }
                        }.padding(.top, 80)
                    } else if filteredEntries.isEmpty && !query.isEmpty {
                        ContentUnavailableView.search(text: query).padding(.top, 60)
                    }
                }
                .padding(.top, 6)
                .padding(.bottom, 20)
            }
            .background(SummonTheme.background)
            .scrollDismissesKeyboard(.interactively)
            .scrollEdgeEffectStyle(.soft, for: .all)
            .refreshable { await store.refresh() }
            .overlay(alignment: .top) {
                LinearGradient(
                    stops: [
                        .init(color: SummonTheme.background.opacity(0.95), location: 0.0),
                        .init(color: SummonTheme.background.opacity(0.70), location: 0.55),
                        .init(color: SummonTheme.background.opacity(0.0), location: 1.0)
                    ],
                    startPoint: .top,
                    endPoint: .bottom
                )
                .frame(height: 110)
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
                    Menu {
                        Button("创建新 Bot", systemImage: "person.badge.plus") { showCreateBot = true }
                        Button("创建群聊", systemImage: "person.2.badge.plus") { showCreateRoom = true }
                        Divider()
                        Button("新建文件夹", systemImage: "folder.badge.plus") {
                            pendingMoveKey = nil
                            newFolderName = ""
                            newFolderAlert = true
                        }
                    } label: {
                        Image(systemName: "plus").summonFont(.title2)
                    }.accessibilityLabel("新建").disabled(!store.protocolReady)
                }
            }
            .navigationDestination(for: String.self) { id in ChatView(roomID: id) }
            .onAppear { org = HomeOrganization.load(for: store.settings.baseURL) }
            .onChange(of: store.settings.baseURL) { _, newURL in
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
            .alert("新建文件夹", isPresented: $newFolderAlert) {
                TextField("文件夹名称（如 Tech、工作）", text: $newFolderName)
                Button("取消", role: .cancel) { pendingMoveKey = nil; newFolderName = "" }
                Button("创建") {
                    if let folder = org.createFolder(named: newFolderName), let key = pendingMoveKey {
                        org.move(key, toFolder: folder.id)
                    }
                    pendingMoveKey = nil
                    newFolderName = ""
                }
            }
            .summonSheet(isPresented: $showSettings) { ConnectionSettingsView() }
            .summonSheet(isPresented: $showDisplay) { SummonDisplaySettingsView() }
            .summonSheet(isPresented: $showUsage) { TokenUsageView() }
            .summonSheet(isPresented: $showFolderManager) {
                HomeFolderManagerSheet(org: $org, entries: allEntries)
            }
            .summonSheet(isPresented: Binding(get: { quotaItem != nil }, set: { if !$0 { quotaItem = nil } })) {
                if let quotaItem { ModelQuotaDetailsView(item: quotaItem) }
            }
            .summonSheet(isPresented: $showCreateBot) {
                CreateBotView { room in openRoom(room.id) }
                    .presentationDragIndicator(.visible)
                    .presentationCornerRadius(28)
            }
            .summonSheet(isPresented: $showCreateRoom) { CreateRoomView { room in openRoom(room.id) } }
            .summonSheet(isPresented: $showModels) { ModelSettingsView() }
            .summonSheet(item: $resourceSection) { section in ResourcesView(section: section) }
        }
    }

    private var bottomSearchBar: some View {
        GlassEffectContainer(spacing: 10) {
            HStack(spacing: 10) {
                Button { showFolderManager = true } label: {
                    Image(systemName: "square.grid.2x2")
                        .font(.system(size: 17, weight: .medium))
                        .frame(width: 22, height: 28)
                }
                .buttonStyle(.glass)
                .buttonBorderShape(.circle)
                .accessibilityLabel("管理文件夹")

                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(.secondary)
                    TextField("搜索", text: $query)
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
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .glassEffect(.regular, in: Capsule())
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 18)
        .padding(.bottom, 8)
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
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 14), count: 3), spacing: 18) {
            ForEach(pinnedEntries) { entry in
                Button { openEntry(entry) } label: {
                    VStack(spacing: 8) {
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
                .contextMenu { entryContextMenu(entry) }
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 10)
        .padding(.bottom, 18)
    }

    @ViewBuilder
    private func folderSection(id: String, title: String, entries: [HomeEntry], isCustom: Bool = false) -> some View {
        let collapsed = org.isCollapsed(id)
        if !entries.isEmpty || isCustom {
            VStack(alignment: .leading, spacing: 0) {
                Button {
                    withAnimation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.84)) {
                        org.toggleCollapsed(id)
                    }
                } label: {
                    HStack(spacing: 5) {
                        Text(title)
                            .summonFont(.footnote, weight: .medium)
                            .foregroundStyle(.secondary)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundStyle(.tertiary)
                            .rotationEffect(.degrees(collapsed ? -90 : 0))
                        Spacer()
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 14)
                    .padding(.bottom, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)

                if !collapsed {
                    if entries.isEmpty {
                        Text("长按会话可移入此文件夹")
                            .summonFont(.caption)
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 20)
                            .padding(.vertical, 10)
                    } else {
                        ForEach(entries) { entry in
                            conversationRow(entry)
                        }
                    }
                }
            }
        }
    }

    private func conversationRow(_ entry: HomeEntry) -> some View {
        Button { openEntry(entry) } label: {
            HStack(spacing: 14) {
                entryAvatar(entry, size: 48)
                    .opacity(entry.isPaused ? 0.45 : 1)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(entry.title)
                            .summonFont(.body, weight: .semibold)
                            .foregroundStyle(.primary)
                            .lineLimit(1)
                        Spacer(minLength: 8)
                        if !entry.timestamp.isEmpty {
                            Text(entry.timestamp)
                                .summonFont(.caption)
                                .foregroundStyle(.tertiary)
                        }
                    }
                    Text(entry.preview)
                        .summonFont(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 11)
            .contentShape(Rectangle())
        }
        .buttonStyle(SummonPressStyle())
        .contextMenu { entryContextMenu(entry) }
    }

    @ViewBuilder
    private func entryAvatar(_ entry: HomeEntry, size: CGFloat) -> some View {
        switch entry.kind {
        case .room(let room):
            RoomAvatar(room: room, size: size)
        case .bot(let bot, _):
            MemberAvatar(bot: bot, size: size)
        }
    }

    @ViewBuilder
    private func entryContextMenu(_ entry: HomeEntry) -> some View {
        let pinned = org.isPinned(entry.key)
        Button(pinned ? "取消置顶" : "置顶", systemImage: pinned ? "pin.slash" : "pin") {
            withAnimation(reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.82)) {
                org.togglePin(entry.key)
            }
        }
        Menu("移到文件夹", systemImage: "folder") {
            let currentFolderID = org.folderID(for: entry.key)
            Button {
                org.move(entry.key, toFolder: nil)
            } label: {
                Label("主要（默认）", systemImage: currentFolderID == nil ? "checkmark" : "tray")
            }
            ForEach(org.folders) { folder in
                Button {
                    org.move(entry.key, toFolder: folder.id)
                } label: {
                    Label(folder.name, systemImage: currentFolderID == folder.id ? "checkmark" : "folder")
                }
            }
            Divider()
            Button("新建文件夹…", systemImage: "folder.badge.plus") {
                pendingMoveKey = entry.key
                newFolderName = ""
                newFolderAlert = true
            }
        }
    }

    private func openEntry(_ entry: HomeEntry) {
        switch entry.kind {
        case .room(let room):
            openRoom(room.id)
        case .bot(let bot, let existingRoom):
            if let existingRoom {
                openRoom(existingRoom.id)
                return
            }
            guard !openingBot else { return }
            openingBot = true
            Task {
                defer { openingBot = false }
                do { let room = try await store.openDirectMessage(bot: bot); openRoom(room.id) }
                catch { store.errorMessage = error.localizedDescription }
            }
        }
    }

    private var connectionStatus: some View {
        VStack(spacing: 8) {
            if store.isLoading && store.bots.isEmpty {
                ProgressView("正在打开工作空间…").padding(.top, 24)
            }
            if let notice = store.protocolNotice {
                SummonProtocolNotice(notice: notice, needsUpdate: store.needsClientUpdate)
            }
            if let error = store.errorMessage {
                HStack(alignment: .top) {
                    InlineError(message: error)
                    Button("重连") { Task { await store.refresh() } }.buttonStyle(.glass)
                }.padding(.horizontal, 20)
            } else if !store.isConnected && !store.bots.isEmpty {
                Label("已显示本机记录，正在连接…", systemImage: "wifi.slash")
                    .summonFont(.footnote).foregroundStyle(.secondary).padding(.top, 10)
            }
        }
    }

    private enum ProfileDestination {
        case usage, display, settings, models
        case quota(SummonJSONValue)
        case resource(ResourceSection)
    }

    private var profileMenu: some View {
        ScrollView {
            VStack(spacing: 2) {
                HStack(spacing: 12) {
                    ModelQuotaSignal(item: store.modelSummary["chat"], label: "默认模型") {
                        selectProfileDestination(.quota(store.modelSummary["chat"]))
                    }
                }.padding(.vertical, 8)
                profileMenuButton("Token 统计", symbol: "chart.bar", destination: .usage)
                profileMenuButton("显示与外观", symbol: "circle.lefthalf.filled", destination: .display)
                profileMenuButton("设置", symbol: "gearshape", destination: .settings)
                profileMenuButton("模型与用量", symbol: "cpu", destination: .models)
                Divider().padding(.vertical, 6)
                ForEach(ResourceSection.allCases) { section in
                    profileMenuButton(section.title, symbol: section.symbol, destination: .resource(section))
                }
            }.padding(12)
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(width: 268, height: 492)
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
        case .usage: showUsage = true
        case .display: showDisplay = true
        case .settings: showSettings = true
        case .models: showModels = true
        case .quota(let item): quotaItem = item
        case .resource(let section): resourceSection = section
        }
    }

    private func directRoom(_ bot: SummonBot) -> SummonRoom? {
        store.rooms.first { !$0.isGroup && $0.members.contains(bot.id) }
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
                try await store.openPushRoom(id)
                guard SummonPush.shared.destinationRoomID == id else { return }
                showSettings = false
                path = [id]
                SummonPush.shared.destinationRoomID = nil
            } catch {
                if SummonPush.shared.destinationRoomID == id { SummonPush.shared.destinationRoomID = nil }
                store.errorMessage = error.localizedDescription
            }
        }
    }

    private func openRoom(_ id: String) { path.append(id) }
}

private struct HomeFolderManagerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var org: HomeOrganization
    let entries: [HomeEntry]
    @State private var newName = ""
    @State private var renamingFolder: HomeFolder?
    @State private var renameText = ""

    var body: some View {
        NavigationStack {
            List {
                Section("新建文件夹") {
                    HStack {
                        TextField("输入名称（如 Tech、工作）", text: $newName)
                        Button("添加") {
                            _ = org.createFolder(named: newName)
                            newName = ""
                        }
                        .disabled(newName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    }
                }

                Section("文件夹列表") {
                    if org.folders.isEmpty {
                        Text("暂无自定义文件夹。新建后可在此分配会话，或在主界面长按任意会话置顶或归类。")
                            .summonFont(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    ForEach(org.folders) { folder in
                        NavigationLink {
                            HomeFolderAssignView(org: $org, folderID: folder.id, entries: entries)
                        } label: {
                            HStack {
                                Label(folder.name, systemImage: "folder")
                                Spacer()
                                Text("\(folder.keys.count)")
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .swipeActions(edge: .trailing) {
                            Button("删除", role: .destructive) { org.deleteFolder(id: folder.id) }
                            Button("重命名") {
                                renameText = folder.name
                                renamingFolder = folder
                            }
                        }
                    }
                }
            }
            .navigationTitle("文件夹分栏")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } }
            }
            .alert("重命名文件夹", isPresented: Binding(get: { renamingFolder != nil }, set: { if !$0 { renamingFolder = nil } })) {
                TextField("文件夹名称", text: $renameText)
                Button("取消", role: .cancel) { renamingFolder = nil }
                Button("保存") {
                    if let folder = renamingFolder { org.renameFolder(id: folder.id, to: renameText) }
                    renamingFolder = nil
                }
            }
        }
    }
}

private struct HomeFolderAssignView: View {
    @Binding var org: HomeOrganization
    let folderID: String
    let entries: [HomeEntry]

    private var folder: HomeFolder? { org.folders.first { $0.id == folderID } }

    var body: some View {
        List {
            ForEach(entries) { entry in
                let included = folder?.keys.contains(entry.key) == true
                Button {
                    org.move(entry.key, toFolder: included ? nil : folderID)
                } label: {
                    HStack(spacing: 12) {
                        switch entry.kind {
                        case .room(let room): RoomAvatar(room: room, size: 34)
                        case .bot(let bot, _): MemberAvatar(bot: bot, size: 34)
                        }
                        Text(entry.title).foregroundStyle(.primary)
                        Spacer()
                        if included {
                            Image(systemName: "checkmark")
                                .foregroundStyle(SummonTheme.ok)
                        }
                    }
                }
                .buttonStyle(.plain)
            }
        }
        .navigationTitle(folder?.name ?? "管理会话")
        .navigationBarTitleDisplayMode(.inline)
    }
}
