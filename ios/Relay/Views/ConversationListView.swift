import SwiftUI

struct ConversationListView: View {
    @Environment(SummonStore.self) private var store
    @State private var path: [String] = []
    @State private var query = ""
    @State private var showSettings = false
    @State private var showUsage = false
    @State private var showDisplay = false
    @State private var showModels = false
    @State private var quotaItem: SummonJSONValue?
    @State private var showCreateBot = false
    @State private var newRoomKind: String?
    @State private var showSystemBots = false
    @State private var showPeerRooms = false
    @State private var workspaceSection: WorkspaceSection?
    @State private var openingBot = false

    private var groups: [SummonRoom] {
        store.rooms.filter { $0.kind != "dm" && matches("\($0.name) \($0.goal)") }
    }

    private var contacts: [SummonBot] {
        store.bots.filter { ($0.presetId ?? "").isEmpty && matches("\($0.name) \($0.role)") }
            .sorted { activityDate($0) > activityDate($1) }
    }

    private var systemBots: [SummonBot] {
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
                                }.buttonStyle(SummonPressStyle())
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
            .background(SummonTheme.background)
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await store.refresh() }
            .navigationTitle("")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("创建新 Bot", systemImage: "person.badge.plus") { showCreateBot = true }
                        Button("创建群聊", systemImage: "person.2.badge.plus") { newRoomKind = "group" }
                        Button("发起深聊", systemImage: "square.stack.3d.up") { newRoomKind = "deep" }
                    } label: {
                        Image(systemName: "plus").summonFont(.title2)
                    }.accessibilityLabel("新建")
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { searchBar }
            .searchable(text: $query, prompt: "搜索")
            .task(id: store.settings.baseURL) {
                while !Task.isCancelled { try? await store.refreshModelUsage(); try? await Task.sleep(for: .seconds(60)) }
            }
            .navigationDestination(for: String.self) { id in ChatView(roomID: id) }
            .summonSheet(isPresented: $showSettings) { ConnectionSettingsView() }
            .summonSheet(isPresented: $showUsage) { TokenUsageView() }
            .summonSheet(isPresented: $showDisplay) { SummonDisplaySettingsView() }
            .summonSheet(isPresented: $showModels) { ModelSettingsView() }
            .summonSheet(isPresented: Binding(get: { quotaItem != nil }, set: { if !$0 { quotaItem = nil } })) { if let quotaItem { ModelQuotaDetailsView(item: quotaItem) } }
            .summonSheet(isPresented: $showCreateBot) {
                CreateBotView { room in openRoom(room.id) }
                    .presentationDragIndicator(.visible)
                    .presentationCornerRadius(28)
            }
            .summonSheet(isPresented: Binding(get: { newRoomKind != nil }, set: { if !$0 { newRoomKind = nil } })) {
                CreateRoomView(initialKind: newRoomKind ?? "group") { room in openRoom(room.id) }
            }
            .summonSheet(item: $workspaceSection) { section in WorkspaceView(section: section) }
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
                    .summonFont(.footnote).foregroundStyle(.secondary).padding(.top, 10)
            }
        }
    }

    private var groupGrid: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 138), spacing: 16)], spacing: 26) {
            ForEach(groups) { room in
                Button { openRoom(room.id) } label: {
                    VStack(spacing: 12) {
                        RoomAvatar(room: room, size: 96)
                        Text(room.name).summonFont(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                        if room.kind == "deep" {
                            Text(room.status == "concluded" ? "已结束" : "深聊").summonFont(.caption2).foregroundStyle(.tertiary)
                        }
                    }.frame(maxWidth: .infinity).padding(.vertical, 16)
                }.buttonStyle(SummonPressStyle())
            }
        }.padding(.horizontal, 42).padding(.top, 32).padding(.bottom, 24)
    }

    private var searchBar: some View {
        VStack(spacing: 4) {
            HStack(spacing: 8) {
                Button { workspaceSection = .works } label: { Label("工作", systemImage: "briefcase").frame(maxWidth: .infinity) }.buttonStyle(.glass)
                Button { workspaceSection = .knowledge } label: { Label("知识", systemImage: "book").frame(maxWidth: .infinity) }.buttonStyle(.glass)
            }
            HStack(alignment: .top, spacing: 4) {
                Menu {
                    ForEach(WorkspaceSection.allCases) { section in
                        Button(section.title, systemImage: section.symbol) { workspaceSection = section }
                    }
                    Divider()
                    Button("Token 统计", systemImage: "chart.bar") { showUsage = true }
                    Button("模型与引擎", systemImage: "circle.dashed") { showModels = true }
                    Button("显示设置", systemImage: "textformat.size") { showDisplay = true }
                    Button("连接设置", systemImage: "network") { showSettings = true }
                } label: {
                    VStack(spacing: 1) {
                        ZStack(alignment: .top) {
                            Image("OwnerAvatar").resizable().scaledToFill().frame(width: 48, height: 48).clipShape(.circle)
                                .overlay(alignment: .bottomTrailing) { Circle().fill(store.isConnected ? Color(red: 0.58, green: 0.68, blue: 0.60) : .gray).frame(width: 9, height: 9).offset(x: 1, y: 1) }.padding(.top, 4)
                        }.frame(width: 64, height: 59)
                        Text(store.settings.userName).font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
                    }.padding(.vertical, 3).frame(maxWidth: .infinity)
                }
                .accessibilityLabel("\(store.settings.userName)，设置，\(store.isConnected ? "已连接" : "正在连接")")
                ModelQuotaSignal(item: store.modelSummary["chat"], label: "CHAT") { quotaItem = store.modelSummary["chat"] }.frame(maxWidth: .infinity)
                ModelQuotaSignal(item: store.modelSummary["executors"].array?.first ?? .object(["role": .string("executor"), "kind": .string("codex")] ), label: "WORK") { quotaItem = store.modelSummary["executors"].array?.first }.frame(maxWidth: .infinity)
            }
        }
        .padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 8).background(SummonTheme.background)
    }

    private func contact(_ bot: SummonBot) -> some View {
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
                        Text(bot.name).summonFont(.title3, weight: .medium).foregroundStyle(.primary).lineLimit(1)
                        Spacer(minLength: 12)
                        Text(SummonFormat.time(room?.lastMessage?.createdAt)).summonFont(.caption).foregroundStyle(.tertiary)
                    }
                    Text(bot.status == "paused" ? "已暂停" : preview(room, bot: bot))
                        .summonFont(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .padding(.horizontal, 22).padding(.vertical, 19)
            .contentShape(Rectangle())
        }.buttonStyle(SummonPressStyle())
    }

    private func matches(_ text: String) -> Bool { query.isEmpty || text.localizedCaseInsensitiveContains(query) }
    private func directRoom(_ bot: SummonBot) -> SummonRoom? {
        store.rooms.first { $0.kind == "dm" && $0.members.contains("user") && $0.members.contains(bot.id) }
    }
    private func activityDate(_ bot: SummonBot) -> String { directRoom(bot)?.lastMessage?.createdAt ?? "" }
    private func preview(_ room: SummonRoom?, bot: SummonBot) -> String {
        if let last = room?.lastMessage {
            return last.content.isEmpty ? last.attachments.map { "[附件] \($0.name)" }.joined(separator: "、") : last.content
        }
        return bot.role.isEmpty ? "开始聊天" : bot.role
    }
    private func openRoom(_ id: String) { path.append(id) }
}
