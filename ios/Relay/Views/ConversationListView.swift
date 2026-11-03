import SwiftUI

struct ConversationListView: View {
    @Environment(RelayStore.self) private var store
    @State private var path: [String] = []
    @State private var query = ""
    @State private var showSettings = false
    @State private var showUsage = false
    @State private var showDisplay = false
    @State private var showCreateBot = false
    @State private var newRoomKind: String?
    @State private var showSystemBots = false
    @State private var showPeerRooms = false
    @State private var workspaceSection: WorkspaceSection?
    @State private var openingBot = false

    private var groups: [RelayRoom] {
        store.rooms.filter { $0.kind != "dm" && matches("\($0.name) \($0.goal)") }
    }

    private var contacts: [RelayBot] {
        store.bots.filter { ($0.presetId ?? "").isEmpty && matches("\($0.name) \($0.role)") }
            .sorted { activityDate($0) > activityDate($1) }
    }

    private var systemBots: [RelayBot] {
        store.bots.filter { !($0.presetId ?? "").isEmpty && matches("\($0.name) \($0.role)") }
    }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                LazyVStack(spacing: 0) {
                    connectionStatus
                    if !groups.isEmpty { groupGrid }
                    ForEach(contacts) { bot in contact(bot) }
                    if !systemBots.isEmpty {
                        DisclosureGroup(isExpanded: $showSystemBots) {
                            ForEach(systemBots) { bot in contact(bot) }
                        } label: {
                            Label("系统 Bot · \(systemBots.count)", systemImage: "slider.horizontal.3")
                                .foregroundStyle(.secondary)
                                .padding(.vertical, 16)
                        }
                        .padding(.horizontal, 22)
                    }
                    let peers = store.rooms.filter { $0.kind == "dm" && !$0.members.contains("user") && matches($0.name) }
                    if !peers.isEmpty {
                        DisclosureGroup("Bot 之间的对话", isExpanded: $showPeerRooms) {
                            ForEach(peers) { room in
                                Button { openRoom(room.id) } label: {
                                    HStack(spacing: 14) {
                                        RoomAvatar(room: room, size: 44)
                                        Text(room.name).foregroundStyle(.primary)
                                        Spacer()
                                    }.padding(.vertical, 12)
                                }.buttonStyle(RelayPressStyle())
                            }
                        }.foregroundStyle(.secondary).padding(22)
                    }
                    if store.bots.isEmpty && store.rooms.isEmpty && !store.isLoading {
                        ContentUnavailableView {
                            Label("你的工作空间", systemImage: "bubble.left.and.bubble.right")
                        } description: {
                            Text(store.errorMessage == nil ? "创建第一位 Bot，开始聊天。" : "暂时无法获取记录，请检查服务连接。")
                        } actions: {
                            Button("创建 Bot") { showCreateBot = true }.buttonStyle(.glass)
                            Button("连接设置") { showSettings = true }
                        }.padding(.top, 80)
                    } else if contacts.isEmpty && groups.isEmpty && systemBots.isEmpty && !query.isEmpty {
                        ContentUnavailableView.search(text: query).padding(.top, 60)
                    }
                }
                .padding(.bottom, 24)
            }
            .background(RelayTheme.background)
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await store.refresh() }
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button { showSettings = true } label: {
                        Image(systemName: "person.crop.circle.fill").relayFont(.title2)
                    }.accessibilityLabel("设置")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("创建新 Bot", systemImage: "person.badge.plus") { showCreateBot = true }
                        Button("创建群聊", systemImage: "person.2.badge.plus") { newRoomKind = "group" }
                        Button("发起深聊", systemImage: "square.stack.3d.up") { newRoomKind = "deep" }
                    } label: {
                        Image(systemName: "plus").relayFont(.title2)
                    }.accessibilityLabel("新建")
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { searchBar }
            .navigationDestination(for: String.self) { id in ChatView(roomID: id) }
            .relaySheet(isPresented: $showSettings) { ConnectionSettingsView() }
            .relaySheet(isPresented: $showUsage) { TokenUsageView() }
            .relaySheet(isPresented: $showDisplay) { RelayDisplaySettingsView() }
            .relaySheet(isPresented: $showCreateBot) {
                CreateBotView { room in openRoom(room.id) }
                    .presentationDragIndicator(.visible)
                    .presentationCornerRadius(28)
            }
            .relaySheet(isPresented: Binding(get: { newRoomKind != nil }, set: { if !$0 { newRoomKind = nil } })) {
                CreateRoomView(initialKind: newRoomKind ?? "group") { room in openRoom(room.id) }
            }
            .relaySheet(item: $workspaceSection) { section in WorkspaceView(section: section) }
        }
    }

    private var connectionStatus: some View {
        VStack(spacing: 8) {
            if store.isLoading && store.bots.isEmpty {
                ProgressView("正在打开工作空间…").padding(.top, 24)
            }
            if let error = store.errorMessage {
                HStack(alignment: .top) {
                    InlineError(message: error)
                    Button("重连") { Task { await store.reconnect() } }.buttonStyle(.glass)
                }.padding(.horizontal, 20)
            } else if !store.isConnected && !store.bots.isEmpty {
                Label("已显示本机记录，正在连接…", systemImage: "wifi.slash")
                    .relayFont(.footnote).foregroundStyle(.secondary).padding(.top, 10)
            }
        }
    }

    private var groupGrid: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 138), spacing: 16)], spacing: 26) {
            ForEach(groups) { room in
                Button { openRoom(room.id) } label: {
                    VStack(spacing: 12) {
                        RoomAvatar(room: room, size: 96)
                        Text(room.name).relayFont(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                        if room.kind == "deep" {
                            Text(room.status == "concluded" ? "已结束" : "深聊").relayFont(.caption2).foregroundStyle(.tertiary)
                        }
                    }.frame(maxWidth: .infinity).padding(.vertical, 16)
                }.buttonStyle(RelayPressStyle())
            }
        }.padding(.horizontal, 42).padding(.top, 32).padding(.bottom, 24)
    }

    private var searchBar: some View {
        GlassEffectContainer(spacing: 16) {
            HStack(spacing: 12) {
                Menu {
                    ForEach(WorkspaceSection.allCases) { section in
                        Button(section.title, systemImage: section.symbol) { workspaceSection = section }
                    }
                    Divider()
                    Button("Token 统计", systemImage: "chart.bar") { showUsage = true }
                    Button("显示设置", systemImage: "textformat.size") { showDisplay = true }
                    Button("连接设置", systemImage: "network") { showSettings = true }
                } label: {
                    Image(systemName: "square.grid.2x2").relayFont(.title3).frame(minWidth: 44, minHeight: 44)
                }
                .buttonStyle(.glass).buttonBorderShape(.circle)
                .accessibilityLabel("连接应用与工作台")
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
                    TextField("搜索", text: $query).submitLabel(.search)
                    if !query.isEmpty {
                        Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                            .accessibilityLabel("清除搜索")
                    }
                }
                .padding(.horizontal, 18).padding(.vertical, 14)
                .glassEffect(.regular, in: .capsule)
            }
        }
        .padding(.horizontal, 20).padding(.bottom, 8)
    }

    private func contact(_ bot: RelayBot) -> some View {
        let room = directRoom(bot)
        return Button {
            guard !openingBot else { return }
            openingBot = true
            Task {
                defer { openingBot = false }
                do { let room = try await store.openDirectMessage(bot: bot); openRoom(room.id) }
                catch { store.errorMessage = error.localizedDescription }
            }
        } label: {
            HStack(spacing: 16) {
                MemberAvatar(bot: bot, size: 50)
                VStack(alignment: .leading, spacing: 7) {
                    HStack {
                        Text(bot.name).relayFont(.title3, weight: .medium).foregroundStyle(.primary).lineLimit(1)
                        Spacer(minLength: 12)
                        Text(RelayFormat.time(room?.lastMessage?.createdAt)).relayFont(.caption).foregroundStyle(.tertiary)
                    }
                    Text(bot.status == "paused" ? "已暂停" : preview(room, bot: bot))
                        .relayFont(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .padding(.horizontal, 22).padding(.vertical, 19)
            .contentShape(Rectangle())
        }.buttonStyle(RelayPressStyle())
    }

    private func matches(_ text: String) -> Bool { query.isEmpty || text.localizedCaseInsensitiveContains(query) }
    private func directRoom(_ bot: RelayBot) -> RelayRoom? {
        store.rooms.first { $0.kind == "dm" && $0.members.contains("user") && $0.members.contains(bot.id) }
    }
    private func activityDate(_ bot: RelayBot) -> String { directRoom(bot)?.lastMessage?.createdAt ?? "" }
    private func preview(_ room: RelayRoom?, bot: RelayBot) -> String {
        if let last = room?.lastMessage {
            return last.content.isEmpty ? last.attachments.map { "[附件] \($0.name)" }.joined(separator: "、") : last.content
        }
        return bot.role.isEmpty ? "开始聊天" : bot.role
    }
    private func openRoom(_ id: String) { path.append(id) }
}
