import SwiftUI
import QuickLook

enum ResourceSection: String, CaseIterable, Identifiable {
    case bots, executions, files, wakeups, connections
    var id: String { rawValue }
    var title: String {
        switch self {
        case .bots: "成员"
        case .executions: "执行会话"
        case .files: "资料"
        case .wakeups: "订阅与提醒"
        case .connections: "执行连接与额度"
        }
    }
    var symbol: String {
        switch self {
        case .bots: "person.2"
        case .executions: "terminal"
        case .files: "folder"
        case .wakeups: "clock"
        case .connections: "link"
        }
    }
    var endpoint: String { "/api/\(rawValue)" }
}

struct SummonProtocolNotice: View {
    @Environment(SummonStore.self) private var store
    let notice: String
    let needsUpdate: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            InlineError(message: notice)
            HStack {
                Button("重新连接") { Task { await store.refresh() } }
                if needsUpdate, let url = URL(string: "https://testflight.apple.com/") {
                    Link("打开 TestFlight", destination: url)
                }
            }.summonFont(.caption)
        }.padding(.horizontal, 18).padding(.vertical, 5)
    }
}

struct ResourcesView: View {
    @Environment(\.dismiss) private var dismiss
    let section: ResourceSection

    var body: some View {
        NavigationStack {
            SummonObjectList(section: section)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } } }
        }
    }
}

struct SummonObjectList: View {
    @Environment(SummonStore.self) private var store
    let section: ResourceSection
    var space: SummonReference? = nil
    @State private var items: [SummonJSONValue] = []
    @State private var hosts = SummonJSONValue.null
    @State private var directories: [SummonJSONValue] = []
    @State private var loading = false
    @State private var error: String?
    @State private var editor: SummonEditorRoute?

    private var path: String {
        guard let space else { return section.endpoint }
        return section.endpoint + "?\(space.kind)=" + SummonAPIClient.component(space.id)
    }

    var body: some View {
        List {
            if let error { InlineError(message: error) }
            if loading && items.isEmpty { ProgressView() }
            switch section {
            case .bots:
                ForEach(store.bots) { bot in
                    NavigationLink {
                        BotDetailsView(botID: bot.id)
                    } label: {
                        HStack {
                            MemberAvatar(bot: bot, size: 35)
                            Text(bot.name)
                            Spacer()
                            Text(bot.isPaused ? "已暂停" : "启用").foregroundStyle(.secondary)
                        }
                    }
                }
            case .executions:
                ForEach(items, id: \.prettyPrinted) { item in
                    if let ref = SummonReference(item["execution_ref"]) {
                        NavigationLink {
                            SummonExecutionView(ref: ref)
                        } label: {
                            VStack(alignment: .leading, spacing: 5) {
                                Text(executionTitle(item, store: store))
                                Text("\(SummonFormat.status(item["status"].stringValue)) · \(SummonFormat.status(item["control"]["state"].stringValue))")
                                    .summonFont(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            case .files:
                ForEach(items, id: \.prettyPrinted) { item in
                    if let ref = SummonReference(item["ref"]) {
                        NavigationLink(item["path"].string ?? store.label(ref)) { SummonFileView(ref: ref, room: space?.kind == "room" ? space : nil) }
                    }
                }
            case .wakeups:
                wakeupSection("基础关注", items: items.filter { $0["rule"]["kind"].string == "room_base" })
                wakeupSection("自定义订阅与提醒", items: items.filter { $0["rule"]["kind"].string != "room_base" })
            case .connections:
                connectionSections
            }
            if items.isEmpty && !loading && section != .bots && section != .connections && section != .wakeups {
                Text("暂无记录").foregroundStyle(.secondary)
            }
        }
        .navigationTitle(section.title)
        .refreshable { await reload() }
        .task(id: store.protocolReady) { if store.protocolReady { await reload() } }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    switch section {
                    case .bots: Button("创建 Bot") { editor = .bot }
                    case .executions:
                        if space == nil { Button("打开执行会话") { editor = .execution } }
                    case .files: Button("新增资料") { editor = .file }
                    case .wakeups: Button("新增订阅或提醒") { editor = .wakeup(.null) }
                    case .connections:
                        Button("新增连接") { editor = .connection(.null) }
                        Button("登记执行目录") { editor = .directory(.null) }
                    }
                    Button("刷新") { Task { await reload() } }
                } label: { Image(systemName: "ellipsis.circle").accessibilityLabel("操作") }
                    .disabled(!store.protocolReady)
            }
        }
        .summonSheet(item: $editor, onDismiss: { Task { await reload() } }) { route in
            switch route {
            case .bot: CreateBotView { _ in editor = nil }
            case .execution: SummonExecutionEditor()
            case .file: SummonFileEditor(space: space)
            case .wakeup(let item): SummonWakeupEditor(item: item, space: space)
            case .connection(let item): SummonConnectionEditor(item: item)
            case .directory(let item): SummonDirectoryEditor(item: item)
            case .limits: SummonLimitsEditor()
            }
        }
    }

    private func wakeupSection(_ title: String, items: [SummonJSONValue]) -> some View {
        Section(title) {
            if items.isEmpty { Text("暂无规则").foregroundStyle(.secondary) }
            ForEach(items, id: \.prettyPrinted) { item in
                Button { editor = .wakeup(item) } label: {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(store.name(for: item["bot_id"].stringValue) + " · " + wakeupTitle(item["rule"]))
                        Text(item["enabled"].bool == true ? "启用" : "已停用").summonFont(.caption).foregroundStyle(.secondary)
                    }
                }.disabled(!store.protocolReady)
            }
        }
    }

    private var connectionSections: some View {
        Group {
            Section("执行连接") {
                ForEach(items, id: \.prettyPrinted) { item in
                    if let id = item["id"].string {
                        NavigationLink(item["name"].string ?? id) {
                            SummonReferenceView(ref: SummonReference(kind: "connection", id: id))
                        }
                        .swipeActions {
                            if item["revision"].int != nil, id != "pi" {
                                Button("设置") { editor = .connection(item) }.disabled(!store.protocolReady)
                            }
                        }
                    }
                }
            }
            Section("宿主额度") {
                ForEach((hosts["limits"].object ?? [:]).keys.sorted(), id: \.self) { key in
                    let used = hosts["usage"][key].int.map { "\($0) / " } ?? ""
                    LabeledContent(resourceName(key), value: used + (hosts["limits"][key].int.map { String($0) } ?? ""))
                }
                if let at = SummonDate.parse(hosts["usage"]["resets_at"].string) {
                    LabeledContent("本周期截止", value: at.formatted(date: .abbreviated, time: .shortened))
                }
                Button("编辑额度") { editor = .limits }.disabled(!store.protocolReady || hosts["limits_revision"].int == nil)
            }
            Section("执行目录") {
                ForEach(directories, id: \.prettyPrinted) { directory in
                    Button { editor = .directory(directory) } label: {
                        VStack(alignment: .leading) {
                            Text(directory["name"].stringValue)
                            Text(directory["path"].stringValue).summonFont(.caption).foregroundStyle(.secondary)
                        }
                    }.disabled(!store.protocolReady || directory["revision"].int == nil)
                }
            }
        }
    }

    private func reload() async {
        guard store.protocolReady, !loading else { return }
        loading = true; error = nil
        defer { loading = false }
        do {
            if section == .bots { await store.refresh(); return }
            items = try await store.list(path)
            if section == .connections {
                async let usage = store.request(path: "/api/connections")
                async let workspaces = store.list("/api/workspaces")
                (hosts, directories) = try await (usage, workspaces)
            }
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}

private enum SummonEditorRoute: Identifiable {
    case bot, execution, file, wakeup(SummonJSONValue), connection(SummonJSONValue), directory(SummonJSONValue), limits
    var id: String {
        switch self {
        case .bot: "bot"
        case .execution: "execution"
        case .file: "file"
        case .wakeup(let item): "wakeup" + item["id"].stringValue
        case .connection(let item): "connection" + item["id"].stringValue
        case .directory(let item): "directory" + item["id"].stringValue
        case .limits: "limits"
        }
    }
}

private func wakeupTitle(_ rule: SummonJSONValue) -> String {
    switch rule["kind"].string {
    case "room_base": return rule["mode"].string == "all" ? "全部消息" : "仅 @ 或回复"
    case "time":
        let time = SummonDate.parse(rule["at"].string)?.formatted(date: .abbreviated, time: .shortened) ?? rule["at"].stringValue
        if let interval = rule["interval_ms"].int { return time + " · 每 \(Double(interval) / 60000) 分钟" }
        return time
    default:
        return [rule["type"].string, rule["author"]["id"].string, rule["room"].string].compactMap { $0 }.joined(separator: " · ")
    }
}

private func resourceName(_ key: String) -> String {
    ["sessions": "活动会话", "models": "并发模型请求", "external": "并发外部执行",
     "queue": "待处理事件", "reserved_calls": "回执容量", "period_ms": "周期（毫秒）", "calls": "调用次数",
     "tokens": "Token", "active_ms": "活跃时间（毫秒）"][key] ?? key
}

struct SummonReferencePicker: View {
    @Environment(SummonStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let roomID: String
    let onSelect: (SummonReference) -> Void
    @State private var files: [SummonJSONValue] = []
    @State private var fileID = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                if let error { InlineError(message: error) }
                if files.isEmpty && error == nil { Text("暂无可引用的群资料").foregroundStyle(.secondary) }
                ForEach(files, id: \.prettyPrinted) { file in
                    if let ref = SummonReference(file["ref"]) {
                        Button(file["path"].string ?? store.label(ref)) { onSelect(ref); dismiss() }
                    }
                }
                Section("按文件 ID 引用") {
                    TextField("文件 ID", text: $fileID).textInputAutocapitalization(.never).autocorrectionDisabled()
                    Button("加入消息") {
                        onSelect(SummonReference(kind: "file", id: fileID.trimmingCharacters(in: .whitespacesAndNewlines)))
                        dismiss()
                    }.disabled(fileID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .navigationTitle("引用资料")
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } } }
            .task {
                do { files = try await store.list("/api/files?room=" + SummonAPIClient.component(roomID)) }
                catch { if !Task.isCancelled { self.error = error.localizedDescription } }
            }
        }
    }
}

struct SummonReferenceView: View {
    @Environment(SummonStore.self) private var store
    let ref: SummonReference
    @State private var value = SummonJSONValue.null
    @State private var preview: URL?
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        switch ref.kind {
        case "session", "conversation": SummonExecutionView(ref: ref)
        case "file": SummonFileView(ref: ref)
        case "bot": BotDetailsView(botID: ref.id)
        case "room": RoomDetailsView(roomID: ref.id)
        case "workspace_file":
            List {
                if let error { InlineError(message: error) }
                if let fp = ref.filePath { LabeledContent("工作区路径", value: fp) }
                if let ws = ref.workspaceId, let fp = ref.filePath {
                    Button("下载 / 预览最新内容", systemImage: "arrow.down.circle") {
                        Task {
                            busy = true; defer { busy = false }
                            do { preview = try await store.downloadWorkspaceFile(workspaceID: ws, path: fp); error = nil }
                            catch { self.error = error.localizedDescription }
                        }
                    }.disabled(busy || !store.protocolReady)
                }
            }
            .navigationTitle(store.label(ref))
            .quickLookPreview($preview)
        default:
            List {
                if let error { InlineError(message: error) }
                else if value == .null { ProgressView() }
                else if ref.kind == "event" {
                    Text(store.name(for: value["senderId"].string ?? "platform"))
                    Text(value["content"].stringValue).textSelection(.enabled)
                    ForEach(value["mentions"].array ?? [], id: \.prettyPrinted) { id in
                        Text("@" + store.name(for: id.stringValue)).summonFont(.caption)
                    }
                } else if ref.kind == "call" {
                    let execStatus = value["result"]["status"].string ?? value["status"].string ?? "unknown"
                    let httpStatus = value["result"]["status"].int
                    let exitCode = value["result"]["exit_code"].int ?? value["result"]["native"]["exit_code"].int ?? value["result"]["output"]["exit_code"].int
                    let errCode = value["result"]["code"].string ?? value["result"]["output"]["code"].string
                    let errText = value["result"]["error"].string ?? value["result"]["output"]["error"].string
                    let outText = value["result"]["output"].string ?? value["result"]["output"]["text"].string ?? value["result"]["output"]["message"].string
                    LabeledContent("工具", value: value["tool"].string ?? "—")
                    LabeledContent("状态", value: SummonFormat.status(execStatus))
                    if let httpStatus { LabeledContent("HTTP 状态", value: String(httpStatus)) }
                    if let exitCode { LabeledContent("退出码", value: String(exitCode)) }
                    if let submitter = value["submitted_by"]["id"].string { LabeledContent("发起者", value: store.name(for: submitter)) }
                    if let targetRef = SummonReference(value["target"]) { LabeledContent("目标", value: store.label(targetRef)) }
                    if errCode != nil || errText != nil {
                        LabeledContent("错误信息", value: [errCode, errText].compactMap { $0 }.joined(separator: " · "))
                            .foregroundStyle(SummonTheme.warn)
                    }
                    if let outText, !outText.isEmpty {
                        Section("结果摘要") {
                            Text(String(outText.prefix(2000))).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                        }
                    }
                    DisclosureGroup("查看原始数据") {
                        Text(value.prettyPrinted).font(.system(.footnote, design: .monospaced)).textSelection(.enabled)
                    }
                } else { Text(value.prettyPrinted).font(.system(.footnote, design: .monospaced)).textSelection(.enabled) }
            }
            .navigationTitle(store.label(ref))
            .task(id: store.protocolReady) {
                guard store.protocolReady else { return }
                do { value = try await store.read(ref); error = nil }
                catch { if !Task.isCancelled { self.error = error.localizedDescription } }
            }
        }
    }
}

struct SummonFileView: View {
    @Environment(SummonStore.self) private var store
    let ref: SummonReference
    var room: SummonReference? = nil
    @State private var value = SummonJSONValue.null
    @State private var text = ""
    @State private var cursor: String?
    @State private var selectedRevision: Int?
    @State private var preview: URL?
    @State private var editor = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        List {
            if let error { InlineError(message: error) }
            if let path = value["path"].string { LabeledContent("文件", value: path) }
            if let revision = value["revision"].int {
                let latest = value["latest_revision"].int ?? revision
                LabeledContent("修订", value: revision == latest ? "v\(revision)（当前正式版）" : "v\(revision)（历史快照 · 最新 v\(latest)）")
            }
            if let spaceKind = value["space"]["kind"].string {
                LabeledContent("适用范围", value: spaceKind == "bot" ? "私有记忆/资料" : (spaceKind == "room" ? "本群共享资料" : spaceKind))
            }
            let revisions = value["revisions"].array ?? []
            if revisions.count > 1 {
                Section("版本历史") {
                    ForEach(revisions, id: \.prettyPrinted) { rev in
                        if let r = rev["revision"].int {
                            let latest = value["latest_revision"].int ?? value["revision"].int ?? r
                            Button(r == latest ? "v\(r)（当前正式版）" : "v\(r)（历史版本）") {
                                selectedRevision = (r == latest) ? nil : r
                                Task { await load() }
                            }.disabled(busy || r == value["revision"].int)
                        }
                    }
                }
            }
            let rawSources = value["sources"].array ?? []
            if !rawSources.isEmpty {
                Section("修订来源") {
                    ForEach(rawSources, id: \.prettyPrinted) { src in
                        if src["access"].string == "redacted" {
                            Text("受限来源（\(String(src["id"].stringValue.prefix(8)))）").foregroundStyle(.secondary)
                        } else if let sref = SummonReference(src) {
                            NavigationLink(store.label(sref)) { SummonReferenceView(ref: sref) }
                        }
                    }
                }
            }
            if !text.isEmpty { Text(text).textSelection(.enabled) }
            if value["content_status"].string == "unavailable" { Text("正文不可用").foregroundStyle(.secondary) }
            if cursor != nil { Button("读取后续正文") { Task { await load(append: true) } }.disabled(busy) }
            if value["url"].string != nil {
                Button("下载文件", systemImage: "arrow.down.circle") {
                    Task {
                        busy = true; defer { busy = false }
                        do {
                            if value["url"].string?.hasPrefix("/api/attachments/") == true {
                                let attachment = SummonAttachment(id: ref.id, name: value["name"].string ?? "附件",
                                                                  mimeType: value["mimeType"].string)
                                preview = try await store.attachmentFileURL(attachment)
                            } else { preview = try await store.downloadFile(id: ref.id, name: value["name"].string ?? "资料", revision: selectedRevision) }
                        } catch { self.error = error.localizedDescription }
                    }
                }.disabled(busy || !store.protocolReady)
            }
            if cursor == nil && value["path"].string != nil && value["content"].string != nil {
                Button("编辑资料", systemImage: "pencil") { editor = true }.disabled(busy || !store.protocolReady)
            }
            if let room, let record = store.room(id: room.id) {
                let pinned = record.pins?.contains(ref) == true
                Button(pinned ? "取消置顶" : "在群里置顶", systemImage: "pin") {
                    Task {
                        do { try await store.setPin(ref, in: record, remove: pinned) }
                        catch { self.error = error.localizedDescription }
                    }
                }.disabled(busy || !store.protocolReady)
            }
        }
        .navigationTitle(value["name"].string ?? "资料")
        .quickLookPreview($preview)
        .task(id: store.protocolReady) { if store.protocolReady { await load() } }
        .refreshable { await load() }
        .summonSheet(isPresented: $editor, onDismiss: { Task { await load() } }) {
            SummonFileEditor(before: value, original: text)
        }
    }

    private func load(append: Bool = false) async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            let previousRevision = value["revision"].int
            var queryItems: [String] = []
            if append, let cursor { queryItems.append("cursor=" + SummonAPIClient.component(cursor)) }
            if let rev = selectedRevision { queryItems.append("revision=\(rev)") }
            let base = ref.path ?? "/api/files/\(SummonAPIClient.component(ref.id))"
            let page = try await store.request(path: queryItems.isEmpty ? base : base + "?" + queryItems.joined(separator: "&"))
            if append && page["revision"].int != previousRevision {
                throw SummonAPIError.http(409, "资料已修订，请刷新后读取。")
            }
            value = page; cursor = page["next_cursor"].string
            text = (append ? text : "") + (page["content"].string ?? "")
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}

@MainActor private func executionTitle(_ value: SummonJSONValue, store: SummonStore) -> String {
    let role = value["bot_id"].string.map { store.name(for: $0) }
    let title = value["kind"].string == "conversation" ? "内部对话" : value["engine"].string ?? "执行会话"
    return role.map { title + " · " + $0 } ?? title
}

struct SummonExecutionView: View {
    @Environment(SummonStore.self) private var store
    let ref: SummonReference
    @State private var detail = SummonJSONValue.null
    @State private var logPages: [SummonJSONValue] = []
    @State private var pendingCommand: SummonExecutionRequest?
    @State private var stopResults: [SummonJSONValue] = []
    @State private var showStop = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        List {
            if let error { InlineError(message: error) }
            if detail == .null && busy { ProgressView() }
            if let status = detail["status"].string {
                Section("执行事实") {
                    LabeledContent("状态", value: SummonFormat.status(status))
                    let lastError = detail["last_error"]
                    let errorText = [lastError["code"].string, lastError["message"].string]
                        .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                    if !errorText.isEmpty { InlineError(message: "最近错误 · " + errorText) }
                    LabeledContent("控制", value: SummonFormat.status(detail["control"]["state"].stringValue))
                    if let stop = detail["control"]["stop_status"].string { LabeledContent("停止结果", value: SummonFormat.status(stop)) }
                    if let actor = detail["execution_actor"]["id"].string ?? detail["bot_id"].string {
                        LabeledContent("执行身份", value: store.name(for: actor))
                    }
                    if let submitter = detail["submitted_by"]["id"].string { LabeledContent("提交者", value: store.name(for: submitter)) }
                    if let call = detail["latest_call_id"].string {
                        NavigationLink("调用 \(call)") { SummonReferenceView(ref: SummonReference(kind: "call", id: call)) }
                    }
                    if detail["native"].object != nil {
                        DisclosureGroup("原生标识") { Text(detail["native"].prettyPrinted).textSelection(.enabled) }
                    }
                }
                Section("控制") {
                    if detail["can_stop"].bool == true && detail["control"]["state"].string != "paused" {
                        Button("暂停并请求停止", role: .destructive) { showStop = true }.disabled(busy || !store.protocolReady)
                    }
                    if detail["resume_ref"].object != nil && detail["control"]["stop_status"].string == "stopped" {
                        Button("恢复控制") { Task { await command(kind: "resume") } }.disabled(busy || !store.protocolReady)
                    }
                    ForEach(stopResults, id: \.prettyPrinted) { result in
                        if let target = SummonReference(result["target"]) {
                            Text(store.label(target) + " · " + SummonFormat.status(result["control"]["stop_status"].stringValue))
                        }
                    }
                }
                ForEach(SummonInputOption.options(detail)) { option in
                    SummonNativeInput(option: option, disabled: busy || !store.protocolReady) { input in
                        await command(kind: option.kind, input: input, target: option.target)
                    }
                    .id(detail["control_version"].stringValue + option.id)
                }
                Section("输入与输出") {
                    ForEach(Array(logPages.enumerated()), id: \.offset) { _, page in logRows(page) }
                    if logPages.last?["next_cursor"].string != nil {
                        Button("读取后续日志") { Task { await load(append: true) } }.disabled(busy || !store.protocolReady)
                    }
                }
            }
        }
        .navigationTitle(detail == .null ? store.label(ref) : executionTitle(detail, store: store))
        .refreshable { await load() }
        .task(id: store.protocolReady) { if store.protocolReady { await load() } }
        .toolbar { ToolbarItem(placement: .primaryAction) {
            Button("刷新", systemImage: "arrow.clockwise") { Task { await load() } }.disabled(busy || !store.protocolReady)
        } }
        .confirmationDialog("选择停止范围", isPresented: $showStop) {
            Button("当前目标", role: .destructive) { Task { await command(kind: "stop", scope: "target") } }
            Button("当前目标及其独占调用", role: .destructive) { Task { await command(kind: "stop", scope: "target_and_owned_calls") } }
        }
    }

    private func logRows(_ page: SummonJSONValue) -> some View {
        let outputs = page["output_pages"].array ?? (page["output_page"] == .null ? [] : [page["output_page"]])
        return Group {
            if outputs.isEmpty && page["output"] != .null {
                Text(page["output"].string ?? page["output"].prettyPrinted).textSelection(.enabled)
            }
            ForEach(Array(outputs.enumerated()), id: \.offset) { _, output in Text(output["text"].stringValue).textSelection(.enabled) }
            ForEach(Array(((page["messages"].array ?? []) + (page["output_events"].array ?? [])).enumerated()), id: \.offset) { _, entry in
                let message = entry["message"] == .null ? entry : entry["message"]
                VStack(alignment: .leading, spacing: 5) {
                    Text(message["role"].string ?? entry["type"].string ?? "输出").summonFont(.caption).foregroundStyle(.secondary)
                    Text(message["content"].array?.map { $0["text"].string ?? $0.prettyPrinted }.joined(separator: "\n")
                         ?? message["content"].string ?? message["text"].string ?? message.prettyPrinted).textSelection(.enabled)
                }
            }
        }.font(.system(.footnote, design: .monospaced))
    }

    private func load(append: Bool = false) async {
        guard !busy else { return }
        busy = true; error = nil
        defer { busy = false }
        do {
            let page = try await store.read(ref, cursor: append ? logPages.last?["next_cursor"].string : nil)
            detail = page
            if !append { logPages = [page] }
            else if page["next_cursor"] != logPages.last?["next_cursor"] || !page["output_page"]["text"].stringValue.isEmpty ||
                page["messages"].array?.isEmpty == false || page["output_events"].array?.isEmpty == false { logPages.append(page) }
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }

    private func command(kind: String, input: SummonJSONValue? = nil, target: SummonJSONValue? = nil, scope: String? = nil) async {
        guard !busy, let execution = SummonReference(detail["execution_ref"]), execution == ref,
              let version = detail["control_version"].int else { return }
        busy = true; error = nil
        var body: [String: SummonJSONValue] = ["target": execution.json, "control_version": .number(Double(version))]
        if kind == "stop", let scope { body["scope"] = .string(scope) }
        else {
            body["kind"] = .string(kind)
            if kind == "resume" { body["resume_ref"] = detail["resume_ref"] }
            else { body["input"] = input; body["input_target"] = target }
        }
        let payload = SummonJSONValue.object(body)
        let request = pendingCommand.flatMap { $0.kind == kind && $0.body == payload ? $0 : nil }
            ?? SummonExecutionRequest(kind: kind, body: payload, id: SummonStore.newID())
        pendingCommand = request
        do {
            let result = try await store.request(path: "/api/executions/" + (kind == "stop" ? "stop" : "input"),
                                                 method: "POST", body: request.body, clientID: request.id)
            if let status = result["status"].string, ["unknown", "prepared", "not_submitted", "failed", "unsupported"].contains(status) {
                error = SummonFormat.status(status) + (result["call_id"].string.map { " · " + $0 } ?? "")
            } else { pendingCommand = nil }
            if kind == "stop" { stopResults = result["targets"].array ?? result["results"].array ?? [] }
            let next = try await store.read(ref)
            detail = next; logPages = [next]
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
        busy = false
    }
}

private struct SummonExecutionRequest {
    let kind: String
    let body: SummonJSONValue
    let id: String
}

private struct SummonNativeInput: View {
    let option: SummonInputOption
    let disabled: Bool
    let submit: (SummonJSONValue) async -> Void
    @State private var text = ""
    @State private var asJSON = false
    @State private var error: String?

    var body: some View {
        Section(option.label) {
            LabeledContent("实际目标", value: targetLabel)
            if let question = option.question { Text(question) }
            if option.choices.isEmpty {
                TextField("输入", text: $text, axis: .vertical).lineLimit(2...8)
                if option.target["kind"].string == "service_call" { Toggle("JSON 输入", isOn: $asJSON) }
            } else {
                Picker("回答", selection: $text) {
                    Text("选择回答").tag("")
                    ForEach(option.choices, id: \.prettyPrinted) { choice in
                        if let id = choice["id"].string { Text(choice["label"].string ?? id).tag(id) }
                    }
                }
            }
            Button(option.label) {
                Task {
                    do {
                        let input: SummonJSONValue = asJSON && option.choices.isEmpty && option.target["kind"].string == "service_call"
                            ? try JSONDecoder().decode(SummonJSONValue.self, from: Data(text.utf8)) : .string(text)
                        error = nil
                        await submit(input)
                    } catch { self.error = "JSON 输入格式无效。" }
                }
            }.disabled(disabled || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            if let error { InlineError(message: error) }
        }
    }

    private var targetLabel: String {
        let keys = ["kind", "turn_id", "run_id", "instance_id", "launch_call_id", "call_id", "operation_id", "request_id", "input_revision"]
        return keys.compactMap { option.target[$0] == .null ? nil : option.target[$0].stringValue }.joined(separator: " · ")
    }
}


private struct SummonEditorForm<Fields: View>: View {
    @Environment(SummonStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let title: String
    var canSave = true
    var load: (() async throws -> Void)? = nil
    let save: () async throws -> Void
    @ViewBuilder let fields: () -> Fields
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                fields()
                if let error { InlineError(message: error) }
            }
            .navigationTitle(title)
            .task {
                guard let load else { return }
                busy = true; defer { busy = false }
                do { try await load() }
                catch { if !Task.isCancelled { self.error = error.localizedDescription } }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        busy = true; error = nil
                        Task {
                            defer { busy = false }
                            do { try await save(); dismiss() }
                            catch { if !Task.isCancelled { self.error = error.localizedDescription } }
                        }
                    }.disabled(busy || !canSave || !store.protocolReady)
                }
            }
        }
    }
}

private struct SummonExecutionEditor: View {
    @Environment(SummonStore.self) private var store
    @State private var connections: [SummonJSONValue] = []
    @State private var directories: [SummonJSONValue] = []
    @State private var engine = ""
    @State private var directory = ""
    @State private var input = ""
    @State private var json = false
    @State private var model = ""
    @State private var effort = ""
    @State private var clientID = SummonStore.newID()
    private var isCodex: Bool { connections.first { $0["id"].string == engine }?["protocol"].string == "codex" }

    var body: some View {
        SummonEditorForm(title: "打开执行会话", canSave: !engine.isEmpty && !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, load: {
            async let engines = store.list("/api/connections")
            async let workspaces = store.list("/api/workspaces")
            connections = try await engines.filter { $0["id"].string != "pi" && $0["available"].bool != false }
            directories = (try? await workspaces) ?? []
            engine = connections.first?["id"].string ?? ""
        }, save: {
            let value: SummonJSONValue
            if isCodex {
                var binding: [String: SummonJSONValue] = ["text": .string(input)]
                let modelID = model.trimmingCharacters(in: .whitespacesAndNewlines)
                let level = effort.trimmingCharacters(in: .whitespacesAndNewlines)
                if !modelID.isEmpty { binding["model"] = .string(modelID) }
                if !level.isEmpty { binding["effort"] = .string(level) }
                value = .object(binding)
            } else {
                value = json ? try JSONDecoder().decode(SummonJSONValue.self, from: Data(input.utf8)) : .string(input)
            }
            var body: [String: SummonJSONValue] = ["engine": .string(engine), "input": value]
            if !directory.isEmpty { body["workspace"] = SummonReference(kind: "workspace", id: directory).json }
            _ = try await store.request(path: "/api/executions", method: "POST", body: .object(body), clientID: clientID)
        }) {
            Picker("连接", selection: $engine) {
                Text("选择连接").tag("")
                ForEach(connections, id: \.prettyPrinted) { item in Text(item["name"].string ?? item["id"].stringValue).tag(item["id"].stringValue) }
            }
            Picker("执行目录", selection: $directory) {
                Text("选择目录").tag("")
                ForEach(directories, id: \.prettyPrinted) { item in Text(item["name"].stringValue).tag(item["id"].stringValue) }
            }
            if isCodex {
                TextField("模型", text: $model, prompt: Text("留空使用连接配置")).textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField("推理强度", text: $effort, prompt: Text("留空使用连接默认值")).textInputAutocapitalization(.never).autocorrectionDisabled()
            } else { Toggle("JSON 输入", isOn: $json) }
            TextField("输入", text: $input, axis: .vertical).lineLimit(5...12)
        }
        .onChange(of: engine) { _, _ in clientID = SummonStore.newID() }
        .onChange(of: directory) { _, _ in clientID = SummonStore.newID() }
        .onChange(of: input) { _, _ in clientID = SummonStore.newID() }
        .onChange(of: json) { _, _ in clientID = SummonStore.newID() }
        .onChange(of: model) { _, _ in clientID = SummonStore.newID() }
        .onChange(of: effort) { _, _ in clientID = SummonStore.newID() }
    }
}

private struct SummonFileEditor: View {
    @Environment(SummonStore.self) private var store
    var space: SummonReference? = nil
    var before = SummonJSONValue.null
    var original = ""
    @State private var selection: SummonReference?
    @State private var path = ""
    @State private var text = ""

    var body: some View {
        SummonEditorForm(title: before == .null ? "新增资料" : "编辑资料",
                          canSave: selection != nil && !path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, save: save) {
            if before == .null && space == nil {
                Picker("资料空间", selection: $selection) {
                    Text("选择空间").tag(nil as SummonReference?)
                    ForEach(store.rooms) { room in Text(room.name).tag(Optional(SummonReference(kind: "room", id: room.id))) }
                    ForEach(store.bots) { bot in Text(bot.name + " 的私有资料").tag(Optional(SummonReference(kind: "bot", id: bot.id))) }
                }
            }
            TextField("文件路径", text: $path).autocorrectionDisabled().disabled(before != .null)
            TextField("正文", text: $text, axis: .vertical).lineLimit(8...24)
        }
        .onAppear {
            selection = space ?? SummonReference(before["space"])
            path = before["path"].string ?? ""
            text = original
        }
    }

    private func save() async throws {
        guard let selection else { return }
        var body: [String: SummonJSONValue] = [
            "space": selection.json, "path": .string(path.trimmingCharacters(in: .whitespacesAndNewlines)), "content_or_source": .string(text)
        ]
        if let revision = before["revision"].int {
            body["revision"] = .number(Double(revision))
            body["sources"] = before["sources"].array.map(SummonJSONValue.array)
        }
        _ = try await store.request(path: "/api/files", method: "POST", body: .object(body), clientID: SummonStore.newID())
    }
}

private struct SummonWakeupEditor: View {
    @Environment(SummonStore.self) private var store
    let item: SummonJSONValue
    let space: SummonReference?
    @State private var botID = ""
    @State private var kind = "event"
    @State private var roomID = ""
    @State private var mode = "all"
    @State private var eventType = "message"
    @State private var authorID = ""
    @State private var referenceKind = ""
    @State private var referenceID = ""
    @State private var at = Date()
    @State private var interval = ""
    @State private var enabled = true

    private var rule: SummonJSONValue { item["rule"] }
    private var bots: [SummonBot] {
        if let room = store.room(id: roomID) {
            return store.bots.filter { room.members.contains($0.id) }
        }
        return store.bots
    }

    var body: some View {
        SummonEditorForm(title: item == .null ? "新增订阅或提醒" : "编辑订阅", canSave: !botID.isEmpty, save: save) {
            if item == .null {
                Picker("接收 Bot", selection: $botID) {
                    Text("选择 Bot").tag("")
                    ForEach(bots) { bot in Text(bot.name).tag(bot.id) }
                }
                Picker("类型", selection: $kind) {
                    Text("事件订阅").tag("event")
                    Text("定时提醒").tag("time")
                }
            }
            if kind == "room_base" {
                Picker("关注范围", selection: $mode) {
                    Text("所有消息").tag("all")
                    Text("仅 @ 或回复").tag("mentions")
                }
            } else {
                Picker("会话范围", selection: $roomID) {
                    Text("全部可访问空间").tag("")
                    ForEach(store.rooms.filter { item == .null || $0.members.contains(botID) || $0.id == roomID }) { room in
                        Text(room.name).tag(room.id)
                    }
                }
                if kind == "time" {
                    DatePicker("提醒时间", selection: $at)
                    TextField("重复间隔（分钟，可选）", text: $interval).keyboardType(.decimalPad)
                } else {
                    TextField("事件类型", text: $eventType).autocorrectionDisabled()
                    Picker("作者", selection: $authorID) {
                        Text("任意").tag("")
                        Text(store.settings.userName).tag("user")
                        ForEach(bots) { bot in Text(bot.name).tag(bot.id) }
                        if let saved = rule["author"]["id"].string, saved != "user", !bots.contains(where: { $0.id == saved }) {
                            Text(saved + " · 当前作者").tag(saved)
                        }
                    }
                    TextField("对象类型（可选）", text: $referenceKind).textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("对象 ID（可选）", text: $referenceID).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
            }
            Toggle("启用", isOn: $enabled)
        }.onAppear {
            kind = rule["kind"].string ?? "event"
            roomID = rule["room"].string ?? rule["room"]["id"].string
                ?? (rule["scope"]["kind"].string == "room" ? rule["scope"]["id"].string : nil)
                ?? (item == .null && space?.kind == "room" ? space?.id : nil) ?? ""
            botID = item["bot_id"].string ?? (space?.kind == "bot" ? space?.id : nil) ?? bots.first?.id ?? ""
            mode = rule["mode"].string ?? "all"
            eventType = rule["type"].string ?? "message"
            authorID = rule["author"]["id"].string ?? ""
            referenceKind = rule["ref"]["kind"].stringValue
            referenceID = rule["ref"]["id"].stringValue
            at = SummonDate.parse(rule["at"].string) ?? Date()
            interval = rule["interval_ms"].int.map { String(Double($0) / 60_000) } ?? ""
            enabled = item["enabled"].bool ?? true
        }
        .onChange(of: roomID) { _, _ in
            if item == .null && !bots.contains(where: { $0.id == botID }) { botID = "" }
        }
    }

    private func save() async throws {
        var settings: [String: SummonJSONValue] = ["kind": .string(kind)]
        switch kind {
        case "room_base":
            settings["room"] = .string(roomID)
            settings["mode"] = .string(mode)
        case "time":
            settings["at"] = .string(ISO8601DateFormatter().string(from: at))
            if !interval.isEmpty {
                let stored = rule["interval_ms"].int
                let initial = stored.map { String(Double($0) / 60_000) }
                let milliseconds = initial == interval ? stored.map(Double.init) : Double(interval).map { ($0 * 60_000).rounded() }
                guard let milliseconds, milliseconds >= 1000, milliseconds <= 9_007_199_254_740_991 else {
                    throw SummonAPIError.http(0, "重复间隔至少为 1 秒。")
                }
                settings["interval_ms"] = .number(milliseconds)
            }
            if !roomID.isEmpty { settings["scope"] = SummonReference(kind: "room", id: roomID).json }
            else if rule["scope"]["kind"].string != "room", rule["scope"].object != nil { settings["scope"] = rule["scope"] }
        default:
            settings["type"] = .string(eventType.trimmingCharacters(in: .whitespacesAndNewlines))
            if !roomID.isEmpty { settings["room"] = .string(roomID) }
            if !authorID.isEmpty {
                settings["author"] = authorID == rule["author"]["id"].string
                    ? rule["author"] : SummonReference(kind: authorID == "user" ? "user" : "bot", id: authorID).json
            }
            let type = referenceKind.trimmingCharacters(in: .whitespacesAndNewlines)
            let id = referenceID.trimmingCharacters(in: .whitespacesAndNewlines)
            guard type.isEmpty == id.isEmpty else { throw SummonAPIError.http(0, "请同时填写对象类型和 ID。") }
            if !type.isEmpty { settings["ref"] = SummonReference(kind: type, id: id).json }
        }
        var body: [String: SummonJSONValue] = ["bot": .string(botID), "event_or_time": .object(settings), "enabled": .bool(enabled)]
        if let id = item["id"].string, let revision = item["revision"].int {
            body["id"] = .string(id); body["revision"] = .number(Double(revision))
        }
        _ = try await store.request(path: "/api/wakeups", method: "POST", body: .object(body), clientID: SummonStore.newID())
    }
}

private struct SummonConnectionEditor: View {
    @Environment(SummonStore.self) private var store
    let item: SummonJSONValue
    @State private var name = ""
    @State private var kind = "codex"
    @State private var description = ""
    @State private var config = "{}"
    @State private var enabled = true
    @State private var allowed: Set<String> = []
    @State private var allBots = false

    var body: some View {
        SummonEditorForm(title: item == .null ? "新增连接" : "执行连接设置",
                          canSave: !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, save: save) {
            TextField("名称", text: $name)
            TextField("说明", text: $description, axis: .vertical)
            if item == .null {
                Picker("协议", selection: $kind) {
                    ForEach(["codex", "cli", "mcp", "http"], id: \.self) { Text($0).tag($0) }
                }
            }
            TextField(item == .null ? "连接配置 JSON" : "要修改的连接配置（JSON）", text: $config,
                      prompt: item == .null ? nil : Text("留空保留连接配置"), axis: .vertical)
                .lineLimit(4...12).autocorrectionDisabled().textInputAutocapitalization(.never)
            Toggle("启用", isOn: $enabled)
            Section("允许使用的 Bot") {
                Toggle("允许所有 Bot 使用", isOn: $allBots)
                if !allBots {
                    ForEach(store.bots) { bot in grant(bot.id, title: bot.name) }
                    ForEach(hiddenGrants, id: \.self) { id in grant(id, title: id + " · 现有授权") }
                }
            }
        }.onAppear {
            name = item["name"].string ?? ""; description = item["description"].string ?? ""
            enabled = item["enabled"].bool ?? true
            let previous = Set((item["allowed_bot_ids"].array ?? []).compactMap(\.string))
            allBots = previous.contains("*")
            allowed = previous.subtracting(["*"])
            config = item == .null ? "{}" : ""
        }
    }

    private var hiddenGrants: [String] {
        let visible = Set(store.bots.map(\.id))
        return (item["allowed_bot_ids"].array ?? []).compactMap(\.string)
            .filter { $0 != "*" && !visible.contains($0) }.sorted()
    }

    private func grant(_ id: String, title: String) -> some View {
        Toggle(title, isOn: Binding(get: { allowed.contains(id) }, set: {
            if $0 { allowed.insert(id) } else { allowed.remove(id) }
        }))
    }

    private func save() async throws {
        var body: [String: SummonJSONValue] = ["name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)),
            "description": .string(description), "enabled": .bool(enabled),
            "allowed_bot_ids": .array((allBots ? ["*"] : allowed.sorted()).map(SummonJSONValue.string))]
        let configText = config.trimmingCharacters(in: .whitespacesAndNewlines)
        if let id = item["id"].string, let revision = item["revision"].int {
            body["revision"] = .number(Double(revision))
            if !configText.isEmpty { body["config_patch"] = try parseConfig(configText) }
            _ = try await store.request(path: "/api/connections/" + SummonAPIClient.component(id), method: "PATCH", body: .object(body))
        } else {
            body["kind"] = .string(kind); body["config"] = try parseConfig(configText)
            _ = try await store.request(path: "/api/connections", method: "POST", body: .object(body))
        }
    }

    private func parseConfig(_ text: String) throws -> SummonJSONValue {
        guard let value = try? JSONDecoder().decode(SummonJSONValue.self, from: Data(text.utf8)),
              value.object != nil else { throw SummonAPIError.http(0, "连接配置需要一个 JSON 对象。") }
        return value
    }
}

private struct SummonDirectoryEditor: View {
    @Environment(SummonStore.self) private var store
    let item: SummonJSONValue
    @State private var name = ""
    @State private var path = ""
    @State private var writable = false

    var body: some View {
        SummonEditorForm(title: item == .null ? "登记执行目录" : "编辑执行目录", canSave: !name.isEmpty && !path.isEmpty, save: {
            var body: [String: SummonJSONValue] = ["name": .string(name.trimmingCharacters(in: .whitespacesAndNewlines)),
                "path": .string(path.trimmingCharacters(in: .whitespacesAndNewlines)), "write": .bool(writable)]
            if let id = item["id"].string, let revision = item["revision"].int {
                body["revision"] = .number(Double(revision))
                _ = try await store.request(path: "/api/workspaces/" + SummonAPIClient.component(id), method: "PATCH", body: .object(body))
            } else { _ = try await store.request(path: "/api/workspaces", method: "POST", body: .object(body)) }
        }) {
            TextField("目录名称", text: $name)
            TextField("绝对路径", text: $path).autocorrectionDisabled().textInputAutocapitalization(.never)
            Toggle("允许写入", isOn: $writable)
        }.onAppear {
            name = item["name"].string ?? ""; path = item["path"].string ?? ""; writable = item["write"].bool ?? false
        }
    }
}

private struct SummonLimitsEditor: View {
    @Environment(SummonStore.self) private var store
    @State private var revision: Int?
    @State private var values: [String: String] = [:]

    var body: some View {
        SummonEditorForm(title: "宿主额度", canSave: revision != nil, load: {
            let response = try await store.request(path: "/api/connections/limits")
            values = response["limits"].object?.mapValues(\.stringValue) ?? [:]
            revision = response["revision"].int
        }, save: {
            guard let revision else { return }
            var limits: [String: SummonJSONValue] = [:]
            for (key, value) in values {
                guard let count = Int(value.trimmingCharacters(in: .whitespacesAndNewlines)), count >= (key == "period_ms" ? 1000 : 0),
                      count <= 9_007_199_254_740_991 else { throw SummonAPIError.http(0, "请输入有效的 \(resourceName(key))。") }
                limits[key] = .number(Double(count))
            }
            _ = try await store.request(path: "/api/connections/limits", method: "PATCH", body: .object([
                "revision": .number(Double(revision)), "limits": .object(limits)
            ]))
        }) {
            ForEach(values.keys.sorted(), id: \.self) { key in
                TextField(resourceName(key), text: Binding(get: { values[key] ?? "" }, set: { values[key] = $0 }))
                    .keyboardType(.numberPad).accessibilityLabel(resourceName(key))
            }
        }
    }
}
