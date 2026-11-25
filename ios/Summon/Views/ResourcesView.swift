import SwiftUI
import Foundation
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
        case .connections: "预置 Bot 与目录"
        }
    }
    var symbol: String {
        switch self {
        case .bots: "person.2"
        case .executions: "terminal"
        case .files: "folder"
        case .wakeups: "clock"
        case .connections: "puzzlepiece.extension"
        }
    }
    var endpoint: String { self == .connections ? "/api/bundled-bots" : "/api/\(rawValue)" }
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
                wakeupSection("定时提醒与自定义订阅", items: items.filter { $0["rule"]["kind"].string != "room_base" })
                Section {
                    Text("各群聊的基础消息关注规则请在对应群聊详情中调整。")
                        .summonFont(.footnote).foregroundStyle(.secondary)
                }
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
            case .directory(let item): SummonDirectoryEditor(item: item)
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
            Section("预置专职 Bot 库") {
                ForEach(items, id: \.prettyPrinted) { item in
                    let id = item["id"].stringValue
                    let installed = item["installed"].bool == true
                    HStack {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item["name"].string ?? id)
                            if let duty = item["public_duty"].string, !duty.isEmpty {
                                Text(duty).summonFont(.caption).foregroundStyle(.secondary)
                            }
                        }
                        Spacer()
                        if installed, let botId = item["bot_id"].string {
                            NavigationLink("查看") { BotDetailsView(botID: botId) }
                        } else {
                            Button("激活") {
                                Task {
                                    do {
                                        _ = try await store.request(path: "/api/bundled-bots/activate", method: "POST", body: .object(["id": .string(id), "wake": .bool(true)]))
                                        await store.refresh()
                                        await reload()
                                    } catch { self.error = error.localizedDescription }
                                }
                            }.disabled(!store.protocolReady || loading)
                        }
                    }
                }
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
            if section == .connections {
                async let bundled = store.request(path: "/api/bundled-bots")
                async let workspaces = store.list("/api/workspaces")
                let (b, w) = try await (bundled, workspaces)
                items = b["items"].array ?? []
                directories = w
            } else {
                items = try await store.list(path)
            }
        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}

private enum SummonEditorRoute: Identifiable {
    case bot, execution, file, wakeup(SummonJSONValue), directory(SummonJSONValue)
    var id: String {
        switch self {
        case .bot: "bot"
        case .execution: "execution"
        case .file: "file"
        case .wakeup(let item): "wakeup" + item["id"].stringValue
        case .directory(let item): "directory" + item["id"].stringValue
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
                LabeledContent("版本", value: revision == latest ? "v\(revision)" : "v\(revision)（历史版本 · 最新 v\(latest)）")
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
                Section("来源") {
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
                let summaryText = executionReadableSummary(detail)
                if !summaryText.isEmpty {
                    Section("任务摘要") {
                        Text(summaryText).summonFont(.body).textSelection(.enabled)
                    }
                }
                Section("执行状态") {
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
                    ForEach(stopResults, id: \.prettyPrinted) { result in
                        if let target = SummonReference(result["target"]) {
                            Text(store.label(target) + " · " + SummonFormat.status(result["control"]["stop_status"].stringValue))
                        }
                    }
                }
                ForEach(SummonInputOption.options(detail)) { option in
                    SummonNativeInput(option: option, disabled: busy || !store.protocolReady) { input in
                        await command(kind: option.kind, input: input, requestId: option.requestId)
                    }
                    .id(detail["control_version"].stringValue + option.id)
                }
                Section {
                    DisclosureGroup("查看原始执行日志（排障）") {
                        ForEach(Array(logPages.enumerated()), id: \.offset) { _, page in logRows(page) }
                        if logPages.last?["next_cursor"].string != nil {
                            Button("读取后续日志") { Task { await load(append: true) } }.disabled(busy || !store.protocolReady)
                        }
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

    private func command(kind: String, input: SummonJSONValue? = nil, requestId: String? = nil, scope: String? = nil) async {
        guard !busy, let execution = SummonReference(detail["execution_ref"]), execution == ref,
              let version = detail["control_version"].int else { return }
        busy = true; error = nil
        var body: [String: SummonJSONValue] = ["target": execution.json, "control_version": .number(Double(version))]
        if kind == "stop", let scope { body["scope"] = .string(scope) }
        else {
            body["kind"] = .string(kind)
            body["input"] = input
            if let requestId, !requestId.isEmpty { body["request_id"] = .string(requestId) }
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
    @State private var error: String?

    var body: some View {
        Section(option.label) {
            if let rid = option.requestId, !rid.isEmpty { LabeledContent("请求标识", value: rid) }
            if let question = option.question { Text(question) }
            if option.choices.isEmpty {
                TextField("输入", text: $text, axis: .vertical).lineLimit(2...8)
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
                    error = nil
                    await submit(.string(text))
                }
            }.disabled(disabled || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            if let error { InlineError(message: error) }
        }
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
    @State private var directories: [SummonJSONValue] = []
    @State private var directory = ""
    @State private var input = ""
    @State private var clientID = SummonStore.newID()

    var body: some View {
        SummonEditorForm(title: "打开本机执行会话", canSave: !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, load: {
            directories = (try? await store.list("/api/workspaces")) ?? []
        }, save: {
            var body: [String: SummonJSONValue] = [
                "engine": .string("exec"),
                "input": .object(["shell": .string(input)])
            ]
            if !directory.isEmpty { body["workspace"] = SummonReference(kind: "workspace", id: directory).json }
            _ = try await store.request(path: "/api/executions", method: "POST", body: .object(body), clientID: clientID)
        }) {
            Picker("执行目录", selection: $directory) {
                Text("默认目录").tag("")
                ForEach(directories, id: \.prettyPrinted) { item in Text(item["name"].stringValue).tag(item["id"].stringValue) }
            }
            TextField("Shell 命令", text: $input, axis: .vertical).lineLimit(4...12).autocorrectionDisabled().textInputAutocapitalization(.never)
        }
        .onChange(of: directory) { _, _ in clientID = SummonStore.newID() }
        .onChange(of: input) { _, _ in clientID = SummonStore.newID() }
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

// MARK: - Unified Panel (Workspace Overview + Token Usage)

private let overviewLiveStatuses: Set<String> = [
    "opening", "running", "submitted", "waiting", "queued", "needs_input", "awaiting_input"
]

private func cleanSummaryLine(_ raw: String?, fallback: String = "") -> String {
    let trimmed = (raw ?? "")
        .replacingOccurrences(of: "\n", with: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return fallback }
    if (trimmed.hasPrefix("{") && trimmed.hasSuffix("}")) || (trimmed.hasPrefix("[") && trimmed.hasSuffix("]")) {
        if let data = trimmed.data(using: .utf8),
           let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            for key in ["summary", "title", "message", "text", "result"] {
                if let val = obj[key] as? String, !val.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    let clean = val.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
                    return clean.count > 100 ? String(clean.prefix(98)) + "…" : clean
                }
            }
            return fallback.isEmpty ? "结构化执行输出（点开可查看详情）" : fallback
        }
    }
    return trimmed.count > 100 ? String(trimmed.prefix(98)) + "…" : trimmed
}

@MainActor
private func executionReadableSummary(_ item: SummonJSONValue) -> String {
    let status = item["status"].stringValue
    if status == "needs_input" || status == "awaiting_input" {
        return cleanSummaryLine(
            item["waiting_summary"].string ?? item["live_progress"].string ?? item["work_summary"].string,
            fallback: "等待确认或输入"
        )
    }
    if overviewLiveStatuses.contains(status) {
        return cleanSummaryLine(
            item["live_progress"].string ?? item["work_summary"].string ?? item["waiting_summary"].string,
            fallback: "正在执行任务…"
        )
    }
    if status == "failed", let err = item["last_error"]["message"].string, !err.isEmpty {
        return cleanSummaryLine(item["work_summary"].string ?? err)
    }
    let fallback = (item["kind"].string == "conversation" ? "内部对话" : (item["engine"].string ?? "执行会话"))
        + " · " + SummonFormat.status(status)
    return cleanSummaryLine(
        item["work_summary"].string ?? item["last_output_summary"].string ?? item["live_progress"].string,
        fallback: fallback
    )
}

private func memorySummaryText(_ item: SummonJSONValue) -> String {
    if let text = item.string { return cleanSummaryLine(text) }
    for key in ["summary", "content", "text", "title", "note", "fact"] {
        if let text = item[key].string, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return cleanSummaryLine(text)
        }
    }
    return "长期记忆条目"
}

private func memoryScopeLabel(_ item: SummonJSONValue, rooms: [SummonRoom]) -> String {
    let scopes = item["applies_to"].array ?? []
    guard !scopes.isEmpty else { return "默认范围" }
    return scopes.map { scope in
        let kind = scope["kind"].stringValue
        if kind == "bot" { return "全群通用" }
        if kind == "room" {
            let rid = scope["id"].stringValue
            let name = rooms.first { $0.id == rid }?.name ?? String(rid.prefix(8))
            return "仅限 \(name)"
        }
        return kind
    }.joined(separator: " · ")
}

@MainActor
struct WorkspacePanelView: View {
    enum PanelTab: String, CaseIterable, Identifiable {
        case overview, usage
        var id: String { rawValue }
        var title: String { self == .overview ? "工作总览" : "Token 用量" }
    }

    @Environment(SummonStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let onOpenRoom: (String) -> Void
    @State private var selectedTab: PanelTab = .overview
    @State private var showCreateBot = false

    init(onOpenRoom: @escaping (String) -> Void = { _ in }) {
        self.onOpenRoom = onOpenRoom
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("面板视图", selection: $selectedTab) {
                    ForEach(PanelTab.allCases) { tab in
                        Text(tab.title).tag(tab)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)

                if selectedTab == .overview {
                    WorkspaceOverviewList(onOpenRoom: { roomID in
                        dismiss()
                        onOpenRoom(roomID)
                    })
                } else {
                    TokenUsageView(embedded: true)
                }
            }
            .background(SummonTheme.background)
            .navigationTitle("面板")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("完成") { dismiss() }
                }
                if selectedTab == .overview {
                    ToolbarItem(placement: .primaryAction) {
                        Button("创建 Bot", systemImage: "plus") { showCreateBot = true }
                            .disabled(!store.protocolReady)
                    }
                }
            }
            .summonSheet(isPresented: $showCreateBot) {
                CreateBotView { _ in showCreateBot = false }
            }
        }
    }
}

@MainActor
private struct WorkspaceOverviewList: View {
    @Environment(SummonStore.self) private var store
    let onOpenRoom: (String) -> Void
    @State private var executions: [SummonJSONValue] = []
    @State private var files: [SummonJSONValue] = []
    @State private var expandedRooms: Set<String> = []
    @State private var expandedBots: Set<String> = []
    @State private var loading = false
    @State private var error: String?

    private var activeGroups: [SummonRoom] {
        store.rooms.filter { $0.isGroup && !$0.isArchived }.sorted { a, b in
            let aLive = executionsForRoom(a.id).contains { overviewLiveStatuses.contains($0["status"].stringValue) }
            let bLive = executionsForRoom(b.id).contains { overviewLiveStatuses.contains($0["status"].stringValue) }
            if aLive != bLive { return aLive }
            return (a.lastMessage?.createdAt ?? a.updatedAt ?? "") > (b.lastMessage?.createdAt ?? b.updatedAt ?? "")
        }
    }

    private var unassignedBots: [SummonBot] {
        let assigned = Set(activeGroups.flatMap(\.members))
        return store.bots.filter { !assigned.contains($0.id) }
    }

    private func executionsForRoom(_ roomID: String) -> [SummonJSONValue] {
        executions.filter { $0["space"]["kind"].string == "room" && $0["space"]["id"].string == roomID }
    }

    private func executionsFor(roomID: String, botID: String) -> [SummonJSONValue] {
        executionsForRoom(roomID).filter {
            ($0["execution_actor"]["id"].string ?? $0["bot_id"].string) == botID
        }
    }

    private func filesForRoom(_ roomID: String) -> [SummonJSONValue] {
        files.filter { $0["deleted_room"].bool != true && $0["space"]["kind"].string == "room" && $0["space"]["id"].string == roomID }
    }

    private func filesForBot(_ botID: String) -> [SummonJSONValue] {
        files.filter { $0["deleted_room"].bool != true && $0["space"]["kind"].string == "bot" && $0["space"]["id"].string == botID }
    }

    private func memoriesFor(bot: SummonBot, roomID: String) -> [SummonJSONValue] {
        (bot.memory_items ?? []).filter { item in
            let scopes = item["applies_to"].array ?? []
            if scopes.isEmpty { return true }
            return scopes.contains { $0["kind"].string == "bot" || ($0["kind"].string == "room" && $0["id"].string == roomID) }
        }
    }

    private func roleOrder(_ bot: SummonBot, in room: SummonRoom) -> Int {
        if room.lead_bot_id == bot.id || bot.role_id == "group-lead" { return 0 }
        if bot.role_id == "eggbot" { return 2 }
        if bot.role_id == "tool-onboarding" { return 3 }
        return 1
    }

    private func roleBadge(_ bot: SummonBot, in room: SummonRoom) -> String? {
        if room.lead_bot_id == bot.id || bot.role_id == "group-lead" { return "主控" }
        if bot.role_id == "eggbot" { return "孵化" }
        if bot.role_id == "tool-onboarding" { return "接口" }
        return nil
    }

    var body: some View {
        List {
            if let error { Section { InlineError(message: error) } }
            if loading && executions.isEmpty && files.isEmpty {
                Section { ProgressView("正在同步工作总览…") }
            }

            Section("群聊（点击逐层展开）") {
                if activeGroups.isEmpty {
                    Text("暂无活跃群聊").foregroundStyle(.secondary)
                }
                ForEach(activeGroups) { room in
                    roomRow(room)
                }
            }

            if !store.archivedRooms.isEmpty || !unassignedBots.isEmpty {
                Section("归档与未分组") {
                    ForEach(store.archivedRooms) { room in
                        roomRow(room)
                    }
                    ForEach(unassignedBots) { bot in
                        NavigationLink {
                            BotDetailsView(botID: bot.id)
                        } label: {
                            HStack(spacing: 10) {
                                MemberAvatar(bot: bot, size: 32)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(bot.name).summonFont(.body, weight: .medium)
                                    Text("未加入活跃群聊").summonFont(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(SummonTheme.background)
        .refreshable { await reload() }
        .task(id: store.protocolReady) { if store.protocolReady { await reload() } }
    }

    @ViewBuilder
    private func roomRow(_ room: SummonRoom) -> some View {
        let isExpanded = Binding(
            get: { expandedRooms.contains(room.id) },
            set: { open in
                withAnimation(.easeInOut(duration: 0.22)) {
                    if open { expandedRooms.insert(room.id) } else { expandedRooms.remove(room.id) }
                }
            }
        )
        let members = room.members
            .filter { $0 != "user" }
            .compactMap { id in store.bots.first { $0.id == id } }
            .sorted { roleOrder($0, in: room) < roleOrder($1, in: room) }
        let roomExecs = executionsForRoom(room.id)
        let liveCount = roomExecs.filter { overviewLiveStatuses.contains($0["status"].stringValue) }.count
        let roomFiles = filesForRoom(room.id)

        DisclosureGroup(isExpanded: isExpanded) {
            Button {
                onOpenRoom(room.id)
            } label: {
                Label("进入群聊", systemImage: "arrow.up.right.circle")
                    .summonFont(.subheadline, weight: .medium)
            }

            ForEach(members) { bot in
                botSubRow(bot: bot, room: room)
            }

            if !roomFiles.isEmpty {
                DisclosureGroup {
                    ForEach(roomFiles, id: \.prettyPrinted) { file in
                        if let ref = SummonReference(file["ref"]) {
                            NavigationLink {
                                SummonFileView(ref: ref, room: SummonReference(kind: "room", id: room.id))
                            } label: {
                                HStack {
                                    Image(systemName: "doc.text").foregroundStyle(.secondary)
                                    Text(file["name"].string ?? file["path"].string ?? store.label(ref))
                                        .lineLimit(1)
                                    Spacer()
                                    Text("v\(file["revision"].int ?? 1)")
                                        .summonFont(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                } label: {
                    Label("群共享资料（\(roomFiles.count)）", systemImage: "book")
                        .summonFont(.subheadline, weight: .medium)
                }
            }
        } label: {
            HStack(spacing: 12) {
                RoomAvatar(room: room, size: 38)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(room.name).summonFont(.body, weight: .semibold).lineLimit(1)
                        if room.isArchived {
                            Text("归档").summonFont(.caption2).foregroundStyle(.secondary)
                        }
                        if liveCount > 0 {
                            Circle().fill(SummonTheme.ok).frame(width: 7, height: 7)
                        }
                    }
                    let metaParts: [String?] = [
                        "\(members.count) 位伙伴",
                        liveCount > 0 ? "\(liveCount) 进行中" : (roomExecs.isEmpty ? nil : "\(roomExecs.count) 条执行"),
                        roomFiles.isEmpty ? nil : "\(roomFiles.count) 份资料"
                    ]
                    let meta = metaParts.compactMap { $0 }.joined(separator: " · ")
                    Text(meta).summonFont(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 3)
        }
    }

    @ViewBuilder
    private func botSubRow(bot: SummonBot, room: SummonRoom) -> some View {
        let key = "\(room.id):\(bot.id)"
        let isExpanded = Binding(
            get: { expandedBots.contains(key) },
            set: { open in
                withAnimation(.easeInOut(duration: 0.2)) {
                    if open { expandedBots.insert(key) } else { expandedBots.remove(key) }
                }
            }
        )
        let execs = executionsFor(roomID: room.id, botID: bot.id)
        let mems = memoriesFor(bot: bot, roomID: room.id)
        let bFiles = filesForBot(bot.id)
        let liveCount = execs.filter { overviewLiveStatuses.contains($0["status"].stringValue) }.count
        let badge = roleBadge(bot, in: room)

        DisclosureGroup(isExpanded: isExpanded) {
            NavigationLink {
                BotDetailsView(botID: bot.id)
            } label: {
                Label("查看 / 编辑 Bot", systemImage: "person.text.rectangle")
                    .summonFont(.footnote)
            }

            if !execs.isEmpty {
                Text("执行对话（\(execs.count)）")
                    .summonFont(.caption, weight: .semibold).foregroundStyle(.secondary)
                ForEach(Array(execs.prefix(8).enumerated()), id: \.offset) { _, ex in
                    if let ref = SummonReference(ex["execution_ref"]) {
                        let status = ex["status"].stringValue
                        NavigationLink {
                            SummonExecutionView(ref: ref)
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                HStack(spacing: 6) {
                                    Text(SummonFormat.status(status))
                                        .summonFont(.caption2, weight: .semibold)
                                        .foregroundStyle(overviewLiveStatuses.contains(status) ? SummonTheme.ok : status == "failed" ? SummonTheme.warn : .secondary)
                                    Text(ex["kind"].string == "conversation" ? "内部对话" : (ex["engine"].string ?? "执行"))
                                        .summonFont(.caption2).foregroundStyle(.secondary)
                                }
                                Text(executionReadableSummary(ex))
                                    .summonFont(.footnote).foregroundStyle(.primary).lineLimit(2)
                            }
                            .padding(.vertical, 2)
                        }
                    }
                }
            }

            if !mems.isEmpty {
                Text("沉淀记忆（\(mems.count)）")
                    .summonFont(.caption, weight: .semibold).foregroundStyle(.secondary)
                ForEach(Array(mems.prefix(8).enumerated()), id: \.offset) { _, mem in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(memoryScopeLabel(mem, rooms: store.rooms))
                            .summonFont(.caption2).foregroundStyle(.secondary)
                        Text(memorySummaryText(mem))
                            .summonFont(.footnote).foregroundStyle(.primary).lineLimit(3)
                    }
                    .padding(.vertical, 2)
                }
            }

            if !bFiles.isEmpty {
                Text("私有资料（\(bFiles.count)）")
                    .summonFont(.caption, weight: .semibold).foregroundStyle(.secondary)
                ForEach(bFiles, id: \.prettyPrinted) { file in
                    if let ref = SummonReference(file["ref"]) {
                        NavigationLink {
                            SummonFileView(ref: ref)
                        } label: {
                            HStack {
                                Image(systemName: "doc").foregroundStyle(.secondary)
                                Text(file["name"].string ?? file["path"].string ?? store.label(ref)).lineLimit(1)
                                Spacer()
                                Text("v\(file["revision"].int ?? 1)").summonFont(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }

            if execs.isEmpty && mems.isEmpty && bFiles.isEmpty {
                Text("暂无执行对话或沉淀记忆")
                    .summonFont(.caption).foregroundStyle(.secondary)
            }
        } label: {
            HStack(spacing: 10) {
                MemberAvatar(bot: bot, size: 32)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 5) {
                        Text(bot.name).summonFont(.subheadline, weight: .medium).lineLimit(1)
                        if let badge {
                            Text(badge).summonFont(.caption2).foregroundStyle(.secondary)
                        }
                        if liveCount > 0 {
                            Circle().fill(SummonTheme.ok).frame(width: 6, height: 6)
                        }
                    }
                    let summaryParts: [String?] = [
                        execs.isEmpty ? nil : "\(execs.count) 执行",
                        mems.isEmpty ? nil : "\(mems.count) 记忆",
                        bFiles.isEmpty ? nil : "\(bFiles.count) 资料"
                    ]
                    let summaryBits = summaryParts.compactMap { $0 }.joined(separator: " · ")
                    Text(summaryBits.isEmpty ? "空闲" : summaryBits)
                        .summonFont(.caption).foregroundStyle(.secondary)
                }
            }
        }
    }

    private func reload() async {
        guard store.protocolReady, !loading else { return }
        loading = true; error = nil
        defer { loading = false }
        do {
            async let execList = store.list("/api/executions")
            async let fileList = store.list("/api/files")
            let (e, f) = try await (execList, fileList)
            executions = e
            files = f
        } catch {
            if !Task.isCancelled { self.error = error.localizedDescription }
        }
    }
}
