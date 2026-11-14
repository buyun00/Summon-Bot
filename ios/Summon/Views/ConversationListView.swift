import SwiftUI

struct ConversationListView: View {
    @Environment(SummonStore.self) private var store
    @State private var path: [String] = []
    @State private var query = ""
    @State private var showSettings = false
    @State private var showUsage = false
    @State private var showProfileMenu = false
    @State private var profileDestination: ProfileDestination?
    @State private var quotaItem: SummonJSONValue?
    @State private var showCreateBot = false
    @State private var showCreateRoom = false
    @State private var showModels = false
    @State private var workspaceSection: WorkspaceSection?
    @State private var openingBot = false
    @State private var openingPush = false

    private var groups: [SummonRoom] {
        store.rooms.filter { room in
            guard matches(room.name) else { return false }
            return room.isGroup || !store.bots.contains { room.members.contains($0.id) } ||
                store.rooms.first(where: { !$0.isGroup && $0.members == room.members })?.id != room.id
        }
    }

    private var contacts: [SummonBot] {
        store.bots.filter { matches($0.name) }.sorted { activityDate($0) > activityDate($1) }
    }

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                LazyVStack(spacing: 0) {
                    connectionStatus
                    if !groups.isEmpty { groupGrid }
                    ForEach(contacts) { bot in contact(bot) }
                    if store.bots.isEmpty && store.rooms.isEmpty && !store.isLoading && store.protocolReady {
                        ContentUnavailableView {
                            Label("你的工作空间", systemImage: "bubble.left.and.bubble.right")
                        } description: {
                            Text(store.errorMessage == nil ? "创建第一位 Bot，开始聊天。" : "暂时无法获取记录，请检查服务连接。")
                        } actions: {
                            Button("创建 Bot") { showCreateBot = true }.buttonStyle(.glass)
                            Button("连接设置") { showSettings = true }
                        }.padding(.top, 80)
                    } else if contacts.isEmpty && groups.isEmpty && !query.isEmpty {
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
                ToolbarItem(placement: .topBarLeading) {
                    Button { showProfileMenu.toggle() } label: {
                        ZStack {
                            Image("OwnerPaperFrame").resizable().scaledToFit()
                            Image("OwnerAvatar").resizable().scaledToFill()
                                .frame(width: 36 * 0.74, height: 36 * 0.74).clipShape(.circle)
                        }
                            .frame(width: 36, height: 36)
                            .overlay(alignment: .bottomTrailing) {
                                Circle().fill(store.isConnected ? Color(red: 0.58, green: 0.68, blue: 0.60) : .gray)
                                    .frame(width: 8, height: 8)
                                    .overlay { Circle().strokeBorder(Color(red: 0.96, green: 0.96, blue: 0.95), lineWidth: 1.5) }
                                    .padding(2)
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
                    } label: {
                        Image(systemName: "plus").summonFont(.title2)
                    }.accessibilityLabel("新建").disabled(!store.protocolReady)
                }
            }
            .searchable(text: $query, prompt: "搜索")
            .navigationDestination(for: String.self) { id in ChatView(roomID: id) }
            .onChange(of: SummonPush.shared.destinationRoomID, initial: true) { _, _ in openNotification() }
            .onChange(of: store.protocolReady) { _, _ in openNotification() }
            .onChange(of: store.settings) { old, new in
                if old.baseURL != new.baseURL || old.workspaceID != new.workspaceID { path = [] }
            }
            .summonSheet(isPresented: $showSettings) { ConnectionSettingsView() }
            .summonSheet(isPresented: $showUsage) { TokenUsageView() }
            .summonSheet(isPresented: Binding(get: { quotaItem != nil }, set: { if !$0 { quotaItem = nil } })) { if let quotaItem { ModelQuotaDetailsView(item: quotaItem) } }
            .summonSheet(isPresented: $showCreateBot) {
                CreateBotView { room in openRoom(room.id) }
                    .presentationDragIndicator(.visible)
                    .presentationCornerRadius(28)
            }
            .summonSheet(isPresented: $showCreateRoom) { CreateRoomView { room in openRoom(room.id) } }
            .summonSheet(isPresented: $showModels) { ModelSettingsView() }
            .summonSheet(item: $workspaceSection) { section in WorkspaceView(section: section) }
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

    private var groupGrid: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 138), spacing: 16)], spacing: 26) {
            ForEach(groups) { room in
                Button { openRoom(room.id) } label: {
                    VStack(spacing: 12) {
                        RoomAvatar(room: room, size: 96)
                        Text(room.name).summonFont(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                    }.frame(maxWidth: .infinity).padding(.vertical, 16)
                }.buttonStyle(SummonPressStyle())
            }
        }.padding(.horizontal, 42).padding(.top, 32).padding(.bottom, 24)
    }

    private enum ProfileDestination {
        case usage, settings, models
        case quota(SummonJSONValue)
        case workspace(WorkspaceSection)
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
                profileMenuButton("设置", symbol: "gearshape", destination: .settings)
                profileMenuButton("模型与用量", symbol: "cpu", destination: .models)
                Divider().padding(.vertical, 6)
                ForEach(WorkspaceSection.allCases) { section in
                    profileMenuButton(section.title, symbol: section.symbol, destination: .workspace(section))
                }
            }.padding(12)
        }
        .scrollBounceBehavior(.basedOnSize)
        .frame(width: 264, height: 456)
        .background(SummonTheme.surface)
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
        case .settings: showSettings = true
        case .models: showModels = true
        case .quota(let item): quotaItem = item
        case .workspace(let section): workspaceSection = section
        }
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
                    Text(bot.isPaused ? "已暂停" : preview(room, bot: bot))
                        .summonFont(.subheadline).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .padding(.horizontal, 22).padding(.vertical, 19)
            .contentShape(Rectangle())
        }.buttonStyle(SummonPressStyle())
    }

    private func matches(_ text: String) -> Bool { query.isEmpty || text.localizedCaseInsensitiveContains(query) }
    private func directRoom(_ bot: SummonBot) -> SummonRoom? {
        store.rooms.first { !$0.isGroup && $0.members.contains(bot.id) }
    }
    private func activityDate(_ bot: SummonBot) -> String { directRoom(bot)?.lastMessage?.createdAt ?? "" }
    private func preview(_ room: SummonRoom?, bot: SummonBot) -> String {
        if let last = room?.lastMessage {
            if !last.content.isEmpty { return last.content }
            if !last.attachments.isEmpty { return last.attachments.map(\.name).joined(separator: "、") }
            return "共享了引用"
        }
        return "开始聊天"
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
