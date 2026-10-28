import SwiftUI

enum WorkspaceSection: String, CaseIterable, Identifiable {
    case bots, works, knowledge, routines, event

    var id: String { rawValue }

    var title: String {
        switch self {
        case .bots: "管理 Bot"
        case .works: "工作"
        case .knowledge: "知识"
        case .routines: "定时职责"
        case .event: "投递事件"
        }
    }

    var symbol: String {
        switch self {
        case .bots: "person.2"
        case .works: "briefcase"
        case .knowledge: "books.vertical"
        case .routines: "clock"
        case .event: "bolt"
        }
    }
}

struct WorkspaceView: View {
    @Environment(RelayStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let section: WorkspaceSection

    @State private var snapshot: RelayJSONValue = .null
    @State private var loading = false
    @State private var error: String?
    @State private var editor: WorkspaceEditKind?
    @State private var workFilter = "all"
    @State private var query = ""
    @State private var results: RelayJSONValue?
    @State private var routineOverrides: [String: Bool] = [:]
    @State private var mutatingIDs: Set<String> = []

    var body: some View {
        NavigationStack {
            Group {
                if section == .event {
                    if snapshot.object != nil {
                        WorkspaceEditor(kind: .event, snapshot: snapshot, embedded: true)
                    } else {
                        List { statusRows }
                    }
                } else {
                    List {
                        statusRows
                        switch section {
                        case .bots: botRows
                        case .works: workRows
                        case .knowledge: knowledgeRows
                        case .routines: routineRows
                        case .event: EmptyView()
                        }
                    }
                    .refreshable { await reload() }
                }
            }
            .navigationTitle(section.title)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("完成") { dismiss() }
                }
                ToolbarItemGroup(placement: .primaryAction) {
                    if section == .knowledge {
                        Menu {
                            Button("新增知识", systemImage: "plus") { editor = .node(nil) }
                            Button("建立关联", systemImage: "link") { editor = .edge(nil) }
                                .disabled(workspaceRecords(snapshot["knowledge"]["nodes"]).count < 2)
                        } label: { Image(systemName: "plus") }
                        .accessibilityLabel("新增知识或关联")
                        .disabled(snapshot.object == nil)
                    } else if section == .works {
                        Button("委托工作", systemImage: "plus") { editor = .work }
                            .labelStyle(.iconOnly)
                            .disabled(snapshot.object == nil)
                    } else if section == .routines {
                        Button("新增职责", systemImage: "plus") { editor = .routine(nil) }
                            .labelStyle(.iconOnly)
                            .disabled(snapshot.object == nil)
                    }
                    Button("刷新", systemImage: "arrow.clockwise") { Task { await reload() } }
                        .labelStyle(.iconOnly)
                        .disabled(loading)
                }
            }
            .sheet(item: $editor, onDismiss: { Task { await reload() } }) { kind in
                WorkspaceEditor(kind: kind, snapshot: snapshot)
            }
            .task { await reload() }
        }
    }

    @ViewBuilder private var statusRows: some View {
        if loading && snapshot.object == nil { ProgressView("正在载入…") }
        if let error { WorkspaceErrorRow(message: error) }
    }

    @ViewBuilder private var botRows: some View {
        let bots = workspaceRecords(snapshot["bots"])
        if bots.isEmpty && !loading {
            ContentUnavailableView("还没有 Bot", systemImage: "person.2")
        }
        ForEach(bots) { bot in
            NavigationLink { BotDetailsView(botID: bot.id) } label: {
                HStack(spacing: 12) {
                    BotAvatar(shape: bot.value["avatar"]["shape"].string ?? "dev",
                              color: bot.value["avatar"]["color"].string ?? "#FFC18E",
                              image: bot.value["avatar"]["image"].string, size: 42, secondary: bot.value["avatar"]["secondary"].string, ink: bot.value["avatar"]["ink"].string, paper: bot.value["avatar"]["paper"].string)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(bot.value["name"].string ?? bot.id).font(.headline)
                        Text(bot.value["role"].stringValue).font(.subheadline).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if bot.value["status"].string == "paused" {
                        Text("已暂停").font(.caption).foregroundStyle(.secondary)
                    }
                }.padding(.vertical, 4)
            }
        }
    }

    @ViewBuilder private var workRows: some View {
        Section {
            Picker("筛选", selection: $workFilter) {
                Text("全部").tag("all")
                Text("进行中").tag("active")
                Text("待答复").tag("waiting")
                Text("已完成").tag("completed")
                Text("待处理").tag("attention")
            }
        }
        let works = workspaceRecords(snapshot["works"]).filter { record in
            let status = record.value["status"].stringValue
            switch workFilter {
            case "active": return ["queued", "running"].contains(status)
            case "attention": return ["failed", "interrupted", "cancelled"].contains(status)
            case "all": return true
            default: return status == workFilter
            }
        }
        if works.isEmpty && !loading {
            ContentUnavailableView("这里暂时没有工作", systemImage: "briefcase",
                                   description: Text("通过右上角加号明确目标并委托给成员。"))
        }
        ForEach(works) { record in
            NavigationLink {
                WorkspaceWorkDetail(initial: record, snapshot: snapshot)
            } label: {
                VStack(alignment: .leading, spacing: 7) {
                    Text(record.value["goal"].stringValue).font(.headline).lineLimit(3)
                    HStack {
                        Text(workspaceStatus(record.value["status"].stringValue))
                        Text("·")
                        Text(workspaceName(record.value["botId"].stringValue, in: snapshot["bots"]))
                        Spacer()
                        Text(workspaceDate(record.value["createdAt"].string))
                    }.font(.caption).foregroundStyle(.secondary)
                }.padding(.vertical, 4)
            }
        }
    }

    @ViewBuilder private var knowledgeRows: some View {
        Section {
            HStack {
                TextField("搜索标题和知识内容", text: $query)
                    .submitLabel(.search)
                    .onSubmit { Task { await searchKnowledge() } }
                if !query.isEmpty {
                    Button("清除", systemImage: "xmark.circle.fill") { query = ""; results = nil }
                        .labelStyle(.iconOnly)
                        .foregroundStyle(.secondary)
                }
                Button("搜索") { Task { await searchKnowledge() } }
                    .disabled(loading)
            }
        }
        let nodes = workspaceRecords(results?["nodes"] ?? snapshot["knowledge"]["nodes"])
        if nodes.isEmpty && !loading {
            ContentUnavailableView(query.isEmpty ? "还没有知识记录" : "没有匹配的知识", systemImage: "books.vertical")
        }
        ForEach(nodes) { node in
            NavigationLink {
                WorkspaceKnowledgeDetail(initial: node, snapshot: snapshot)
            } label: {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(workspaceStatus(node.value["type"].stringValue))
                        Text("·")
                        Text(workspaceStatus(node.value["status"].stringValue))
                    }.font(.caption).foregroundStyle(.secondary)
                    Text(node.value["title"].stringValue).font(.headline)
                    Text(node.value["content"].stringValue).font(.subheadline).foregroundStyle(.secondary).lineLimit(3)
                }.padding(.vertical, 4)
            }
        }
        if let memories = results?["memories"].array, !memories.isEmpty {
            Section("相关成员记忆") {
                ForEach(Array(memories.enumerated()), id: \.offset) { _, memory in
                    VStack(alignment: .leading, spacing: 5) {
                        Text(workspaceName(memory["botId"].stringValue, in: snapshot["bots"]))
                            .font(.caption).foregroundStyle(.secondary)
                        Text(memory["content"].stringValue).textSelection(.enabled)
                    }
                }
            }
        }
    }

    @ViewBuilder private var routineRows: some View {
        let routines = workspaceRecords(snapshot["routines"])
        if routines.isEmpty && !loading {
            ContentUnavailableView("还没有定时职责", systemImage: "clock",
                                   description: Text("创建职责后，服务会按设定周期投递给成员。"))
        }
        ForEach(routines) { record in
            Section {
                Button { editor = .routine(record) } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(record.value["name"].stringValue).font(.headline).foregroundStyle(.primary)
                        Text(record.value["instruction"].stringValue)
                            .font(.subheadline).foregroundStyle(.secondary).lineLimit(4)
                        Text(workspaceName(record.value["botId"].stringValue, in: snapshot["bots"]))
                            .font(.caption).foregroundStyle(.secondary)
                    }.frame(maxWidth: .infinity, alignment: .leading)
                }
                Toggle("启用", isOn: Binding(
                    get: { routineOverrides[record.id] ?? record.value["enabled"].bool ?? false },
                    set: { enabled in Task { await setRoutine(record, enabled: enabled) } }
                )).disabled(mutatingIDs.contains(record.id))
                LabeledContent("间隔", value: "\(record.value["intervalSeconds"].int.map { $0 / 60 } ?? 60) 分钟")
                if record.value["enabled"].bool == true {
                    LabeledContent("下一次", value: workspaceDate(record.value["nextRunAt"].string, full: true))
                }
                if let lastStatus = record.value["lastStatus"].string, !lastStatus.isEmpty {
                    LabeledContent("最近状态", value: workspaceStatus(lastStatus))
                }
                if let failure = record.value["error"].string, !failure.isEmpty {
                    WorkspaceErrorRow(message: failure)
                }
            }
        }
    }

    private func reload() async {
        loading = true
        defer { loading = false }
        do {
            snapshot = try await store.request(path: "/api/state")
            error = nil
            if results != nil { await searchKnowledge() }
        } catch { self.error = error.localizedDescription }
    }

    private func searchKnowledge() async {
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { results = nil; return }
        do {
            results = try await store.request(path: "/api/knowledge/search?q=\(workspaceEscaped(text))")
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    private func setRoutine(_ record: WorkspaceRecord, enabled: Bool) async {
        guard !mutatingIDs.contains(record.id) else { return }
        mutatingIDs.insert(record.id)
        routineOverrides[record.id] = enabled
        defer { mutatingIDs.remove(record.id); routineOverrides.removeValue(forKey: record.id) }
        do {
            _ = try await store.request(path: "/api/routines/\(workspaceEscaped(record.id))", method: "PATCH",
                                        body: .object(["enabled": .bool(enabled)]))
            await reload()
        } catch { self.error = error.localizedDescription }
    }
}

private struct WorkspaceWorkDetail: View {
    @Environment(RelayStore.self) private var store
    let initial: WorkspaceRecord
    let snapshot: RelayJSONValue
    @State private var work: RelayJSONValue = .null
    @State private var error: String?
    @State private var busy = false
    @State private var answer = ""

    private var value: RelayJSONValue { work.object == nil ? initial.value : work }
    private var status: String { value["status"].stringValue }

    var body: some View {
        List {
            if let error { WorkspaceErrorRow(message: error) }
            Section {
                Text(value["goal"].stringValue).font(.title3.bold()).textSelection(.enabled)
                LabeledContent("状态", value: workspaceStatus(status))
                LabeledContent("委托成员", value: workspaceName(value["botId"].stringValue, in: snapshot["bots"]))
                LabeledContent("来源会话", value: workspaceName(value["roomId"].stringValue, in: snapshot["rooms"]))
                WorkspaceTextFact(title: "工作目录", value: value["cwd"].stringValue)
                if let model = value["model"].string { LabeledContent("执行模型", value: model) }
                LabeledContent("创建时间", value: workspaceDate(value["createdAt"].string, full: true))
            }
            if !value["constraints"].stringValue.isEmpty {
                Section("约束与注意事项") { Text(value["constraints"].stringValue).textSelection(.enabled) }
            }
            if !(value["inputRefs"].array ?? []).isEmpty {
                Section("输入资料") { Text(value["inputRefs"].stringValue).textSelection(.enabled) }
            }
            if !value["error"].stringValue.isEmpty { Section { WorkspaceErrorRow(message: value["error"].stringValue) } }
            if status == "interrupted" {
                Section { Text("上次执行已中断。恢复会继续已有工作对话，已进行的操作仍然保留。")
                    .font(.footnote).foregroundStyle(.secondary) }
            }
            if value["question"] != .null && value["question"]["status"].string != "answered"
                && ["waiting", "interrupted"].contains(status) {
                Section("执行中需要补充") {
                    Text(value["question"]["text"].string ?? value["question"]["question"].string ?? value["question"].stringValue)
                        .textSelection(.enabled)
                    TextField("补充所需信息", text: $answer, axis: .vertical).lineLimit(3...12)
                    Button(status == "interrupted" ? "保存答复，供恢复时使用" : "答复并继续") {
                        Task {
                            await perform("answer", body: .object(["answer": .string(answer.trimmingCharacters(in: .whitespacesAndNewlines))]))
                        }
                    }.disabled(busy || answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            if !value["summary"].stringValue.isEmpty {
                Section("执行结果") { Text(value["summary"].stringValue).textSelection(.enabled) }
            }
            if ["queued", "running", "waiting"].contains(status) {
                Section { Button("取消工作", role: .destructive) { Task { await perform("cancel") } }.disabled(busy) }
            } else if ["failed", "interrupted", "cancelled"].contains(status) {
                Section { Button("恢复工作", systemImage: "play") { Task { await perform("resume") } }.disabled(busy) }
            }
            Section("进度记录") {
                let events = workspaceWorkEvents(value["events"].array ?? [])
                if events.isEmpty { Text("暂无详细进度").foregroundStyle(.secondary) }
                ForEach(Array(events.enumerated()), id: \.offset) { _, event in
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(workspaceEventLabel(event["type"].stringValue)).font(.subheadline.bold())
                            Spacer()
                            Text(workspaceDate(event["createdAt"].string ?? event["timestamp"].string))
                                .font(.caption).foregroundStyle(.secondary)
                        }
                        Text(workspaceEventText(event)).font(.subheadline).textSelection(.enabled)
                    }.padding(.vertical, 4)
                }
            }
        }
        .navigationTitle("工作详情")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            Button("刷新", systemImage: "arrow.clockwise") { Task { await load() } }.disabled(busy)
        }
        .refreshable { await load() }
        .task { await load() }
    }

    private func load() async {
        do {
            let response = try await store.request(path: "/api/works/\(workspaceEscaped(initial.id))")
            if var object = response["work"].object {
                object["events"] = response["events"]
                work = .object(object)
            } else if response.object != nil { work = response }
            else { throw WorkspaceFormError(message: "Work not found") }
            error = nil
        } catch { self.error = error.localizedDescription }
    }

    private func perform(_ action: String, body: RelayJSONValue = .object([:])) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            _ = try await store.request(path: "/api/works/\(workspaceEscaped(initial.id))/\(action)", method: "POST", body: body)
            if action == "answer" { answer = "" }
            await load()
        } catch { self.error = error.localizedDescription }
    }
}

private struct WorkspaceKnowledgeDetail: View {
    @Environment(RelayStore.self) private var store
    let initial: WorkspaceRecord
    let snapshot: RelayJSONValue
    @State private var graph: RelayJSONValue = .null
    @State private var error: String?
    @State private var editor: WorkspaceEditKind?

    private var node: WorkspaceRecord {
        workspaceRecords(graph["nodes"]).first { $0.id == initial.id } ?? initial
    }

    var body: some View {
        List {
            if let error { WorkspaceErrorRow(message: error) }
            Section {
                Text(node.value["title"].stringValue).font(.title3.bold()).textSelection(.enabled)
                LabeledContent("性质", value: workspaceStatus(node.value["type"].stringValue))
                LabeledContent("状态", value: workspaceStatus(node.value["status"].stringValue))
                Text(node.value["content"].stringValue).textSelection(.enabled)
                if !node.value["source"].stringValue.isEmpty { WorkspaceTextFact(title: "来源", value: node.value["source"].stringValue) }
                if !node.value["version"].stringValue.isEmpty { LabeledContent("适用版本", value: node.value["version"].stringValue) }
            }
            Section("关联知识") {
                let edges = workspaceRecords(graph["edges"]).filter {
                    $0.value["from"].string == node.id || $0.value["to"].string == node.id
                }
                if edges.isEmpty { Text("尚未建立关联").foregroundStyle(.secondary) }
                ForEach(edges) { edge in
                    VStack(alignment: .leading, spacing: 8) {
                        let otherID = edge.value["from"].string == node.id ? edge.value["to"].stringValue : edge.value["from"].stringValue
                        if let other = workspaceRecords(graph["nodes"]).first(where: { $0.id == otherID }) {
                            NavigationLink {
                                WorkspaceKnowledgeDetail(initial: other, snapshot: snapshot)
                            } label: { Text(other.value["title"].stringValue) }
                        }
                        Button { editor = .edge(edge) } label: {
                            Label("\(workspaceName(edge.value["from"].stringValue, in: graph["nodes"], field: "title")) → \(edge.value["relation"].stringValue) → \(workspaceName(edge.value["to"].stringValue, in: graph["nodes"], field: "title"))", systemImage: "pencil")
                                .font(.caption).multilineTextAlignment(.leading)
                        }
                        if edge.value["status"].string == "expired" { Text("已过期").font(.caption).foregroundStyle(.secondary) }
                    }.padding(.vertical, 3)
                }
                Button("建立关联", systemImage: "link") { editor = .edge(nil) }
                    .disabled(workspaceRecords(snapshot["knowledge"]["nodes"]).count < 2)
            }
            if let history = node.value["history"].array, !history.isEmpty {
                Section("修订历史") {
                    ForEach(Array(history.reversed().enumerated()), id: \.offset) { _, entry in
                        DisclosureGroup(workspaceDate(entry["updatedAt"].string ?? entry["createdAt"].string ?? entry["at"].string, full: true)) {
                            Text(entry["content"].string ?? entry["snapshot"]["content"].string ?? entry.stringValue)
                                .textSelection(.enabled)
                        }
                    }
                }
            }
        }
        .navigationTitle("知识详情")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { Button("修订", systemImage: "pencil") { editor = .node(node) } }
        .refreshable { await load() }
        .task { await load() }
        .sheet(item: $editor, onDismiss: { Task { await load() } }) { kind in
            WorkspaceEditor(kind: kind, snapshot: snapshot)
        }
    }

    private func load() async {
        do {
            graph = try await store.request(path: "/api/knowledge/graph?id=\(workspaceEscaped(initial.id))&depth=1")
            error = nil
        } catch { self.error = error.localizedDescription }
    }
}

private struct WorkspaceRecord: Identifiable {
    let id: String
    let value: RelayJSONValue
}

private enum WorkspaceEditKind: Identifiable {
    case work, node(WorkspaceRecord?), edge(WorkspaceRecord?), routine(WorkspaceRecord?), event

    var id: String {
        switch self {
        case .work: "work"
        case .node(let record): "node-\(record?.id ?? "new")"
        case .edge(let record): "edge-\(record?.id ?? "new")"
        case .routine(let record): "routine-\(record?.id ?? "new")"
        case .event: "event"
        }
    }

    var title: String {
        switch self {
        case .work: "委托工作"
        case .node(let record): record == nil ? "新增知识" : "修订知识"
        case .edge(let record): record == nil ? "建立关联" : "修订关系"
        case .routine(let record): record == nil ? "新增定时职责" : "修改定时职责"
        case .event: "投递事件"
        }
    }

    var record: WorkspaceRecord? {
        switch self {
        case .node(let record), .edge(let record), .routine(let record): record
        default: nil
        }
    }
}

private struct WorkspaceEditor: View {
    @Environment(RelayStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let kind: WorkspaceEditKind
    let snapshot: RelayJSONValue
    var embedded = false

    @State private var title = ""
    @State private var content = ""
    @State private var botID = ""
    @State private var roomID = ""
    @State private var cwd = ""
    @State private var constraints = ""
    @State private var inputRefs = ""
    @State private var type = "unverified"
    @State private var status = "active"
    @State private var source = ""
    @State private var version = ""
    @State private var fromID = ""
    @State private var toID = ""
    @State private var intervalMinutes = "60"
    @State private var enabled = true
    @State private var busy = false
    @State private var initialized = false
    @State private var error: String?
    @State private var receipt: String?

    var body: some View {
        Group {
            if embedded { form }
            else {
                NavigationStack {
                    form
                        .navigationTitle(kind.title)
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(busy) } }
                }
            }
        }
        .onAppear { initialize() }
        .interactiveDismissDisabled(busy)
    }

    private var form: some View {
        Form {
            if let error { WorkspaceErrorRow(message: error) }
            if let receipt { Label(receipt, systemImage: "checkmark.circle").foregroundStyle(.green).textSelection(.enabled) }
            switch kind {
            case .work:
                Section("工作目标") { TextField("希望完成什么", text: $content, axis: .vertical).lineLimit(4...12) }
                recipientFields
                Section("执行环境") { TextField("工作目录（服务器上的绝对路径）", text: $cwd).textInputAutocapitalization(.never).autocorrectionDisabled() }
                Section("约束与注意事项") { TextField("操作边界、已有修改和需要保留的行为", text: $constraints, axis: .vertical).lineLimit(3...10) }
                Section("输入资料") { TextField("每行一项：文件路径、资料说明或链接", text: $inputRefs, axis: .vertical).lineLimit(3...10) }
            case .node:
                Section {
                    TextField("标题", text: $title)
                    TextField("知识内容", text: $content, axis: .vertical).lineLimit(5...16)
                    Picker("性质", selection: $type) {
                        Text("事实").tag("fact"); Text("假设").tag("hypothesis")
                        Text("观点").tag("opinion"); Text("待核查").tag("unverified")
                    }
                    Picker("状态", selection: $status) {
                        Text("有效").tag("active"); Text("有争议").tag("disputed"); Text("已过期").tag("expired")
                    }
                    TextField("来源", text: $source, axis: .vertical)
                    TextField("适用版本（选填）", text: $version)
                }
            case .edge(let record):
                Section("关系有方向") {
                    if record == nil {
                        nodePicker("起点", selection: $fromID)
                        nodePicker("终点", selection: $toID)
                    } else {
                        LabeledContent("起点", value: workspaceName(fromID, in: snapshot["knowledge"]["nodes"], field: "title"))
                        LabeledContent("终点", value: workspaceName(toID, in: snapshot["knowledge"]["nodes"], field: "title"))
                    }
                    TextField("关系，例如：依赖、支持、来自、修订", text: $title)
                    TextField("来源（选填）", text: $source, axis: .vertical)
                    Picker("状态", selection: $status) { Text("有效").tag("active"); Text("已过期").tag("expired") }
                }
            case .routine:
                Section {
                    TextField("职责名称", text: $title)
                    TextField("到期时需要关注或完成什么", text: $content, axis: .vertical).lineLimit(4...12)
                }
                recipientFields
                Section {
                    TextField("间隔（分钟，最短 1 分钟）", text: $intervalMinutes).keyboardType(.decimalPad)
                    Toggle("立即启用", isOn: $enabled)
                } footer: { Text("到期后投递给指定成员。服务重启后只补一次到期职责。") }
            case .event:
                Section {
                    TextField("事件类型", text: $title)
                    TextField("事件内容", text: $content, axis: .vertical).lineLimit(4...14)
                }
                recipientFields
            }
            Section {
                Button { Task { await save() } } label: {
                    HStack {
                        Spacer()
                        if busy { ProgressView() }
                        Text(submitTitle)
                        Spacer()
                    }
                }.disabled(busy || !canSave)
            }
        }
        .disabled(busy)
    }

    @ViewBuilder private var recipientFields: some View {
        Section {
            Picker("负责成员", selection: $botID) {
                Text("选择成员").tag("")
                ForEach(workspaceRecords(snapshot["bots"])) { bot in Text(bot.value["name"].string ?? bot.id).tag(bot.id) }
            }
            Picker("投递到会话", selection: $roomID) {
                Text("选择会话").tag("")
                ForEach(workspaceRecords(snapshot["rooms"])) { room in Text(room.value["name"].string ?? room.id).tag(room.id) }
            }
        }
    }

    private func nodePicker(_ label: String, selection: Binding<String>) -> some View {
        Picker(label, selection: selection) {
            Text("选择知识").tag("")
            ForEach(workspaceRecords(snapshot["knowledge"]["nodes"])) { node in
                Text(node.value["title"].string ?? node.id).tag(node.id)
            }
        }
    }

    private var submitTitle: String {
        switch kind {
        case .work: "开始工作"
        case .event: "投递事件"
        default: "保存"
        }
    }

    private var canSave: Bool {
        let hasTitle = !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let hasContent = !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        switch kind {
        case .work: return hasContent && !botID.isEmpty && !roomID.isEmpty && !cwd.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        case .node: return hasTitle && hasContent
        case .edge: return hasTitle && !fromID.isEmpty && !toID.isEmpty && fromID != toID
        case .routine: return hasTitle && hasContent && !botID.isEmpty && !roomID.isEmpty && routineIntervalSeconds != nil
        case .event: return hasTitle && hasContent && !botID.isEmpty && !roomID.isEmpty
        }
    }

    private var routineIntervalSeconds: Double? {
        guard let minutes = Double(intervalMinutes), minutes.isFinite, minutes >= 1 else { return nil }
        let seconds = minutes * 60
        return seconds.isFinite ? seconds : nil
    }

    private func initialize() {
        guard !initialized else { return }
        initialized = true
        let record = kind.record?.value ?? .null
        title = record["title"].string ?? record["name"].string ?? record["relation"].string ?? ""
        content = record["content"].string ?? record["instruction"].string ?? ""
        botID = record["botId"].string ?? workspaceRecords(snapshot["bots"]).first?.id ?? ""
        roomID = record["roomId"].string ?? workspaceRecords(snapshot["rooms"]).first?.id ?? ""
        cwd = snapshot["defaultCwd"].stringValue
        type = record["type"].string ?? "unverified"
        status = record["status"].string ?? "active"
        source = record["source"].stringValue
        version = record["version"].stringValue
        let nodes = workspaceRecords(snapshot["knowledge"]["nodes"])
        fromID = record["from"].string ?? nodes.first?.id ?? ""
        toID = record["to"].string ?? nodes.dropFirst().first?.id ?? ""
        if let seconds = record["intervalSeconds"].int { intervalMinutes = String(Double(seconds) / 60) }
        enabled = record["enabled"].bool ?? true
        if case .event = kind { title = "人工提醒" }
    }

    private func save() async {
        guard canSave && !busy else { return }
        busy = true
        error = nil
        receipt = nil
        defer { busy = false }
        let record = kind.record
        var path: String
        var method = record == nil ? "POST" : "PATCH"
        var payload: [String: RelayJSONValue]
        switch kind {
        case .work:
            path = "/api/works"
            payload = ["goal": .string(content.trimmingCharacters(in: .whitespacesAndNewlines)), "botId": .string(botID),
                       "roomId": .string(roomID), "cwd": .string(cwd.trimmingCharacters(in: .whitespacesAndNewlines)),
                       "constraints": .string(constraints),
                       "inputRefs": .array(inputRefs.split(separator: "\n").map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.map { .string($0) })]
        case .node:
            path = record.map { "/api/knowledge/nodes/\(workspaceEscaped($0.id))" } ?? "/api/knowledge/nodes"
            payload = ["title": .string(title), "content": .string(content), "type": .string(type), "status": .string(status), "source": .string(source), "version": .string(version)]
            if let revision = record?.value["revision"].int { payload["expectedRevision"] = .number(Double(revision)) }
        case .edge:
            // The gateway exposes saveEdge through POST, including edits with an existing id.
            path = "/api/knowledge/edges"
            method = "POST"
            payload = ["from": .string(fromID), "to": .string(toID), "relation": .string(title), "source": .string(source), "status": .string(status)]
            if let record { payload["id"] = .string(record.id) }
        case .routine:
            path = record.map { "/api/routines/\(workspaceEscaped($0.id))" } ?? "/api/routines"
            payload = ["name": .string(title), "instruction": .string(content), "botId": .string(botID), "roomId": .string(roomID),
                       "intervalSeconds": .number(routineIntervalSeconds ?? 3600), "enabled": .bool(enabled)]
        case .event:
            path = "/api/events"
            payload = ["type": .string(title), "content": .string(content), "botId": .string(botID), "roomId": .string(roomID)]
        }
        do {
            let response = try await store.request(path: path, method: method, body: .object(payload))
            if embedded {
                content = ""
                let eventID = response["event"]["id"].string ?? response["id"].string
                receipt = eventID.map { "事件已投递 · \($0)" } ?? "事件已投递"
            } else { dismiss() }
        } catch { self.error = error.localizedDescription }
    }
}

private struct WorkspaceErrorRow: View {
    let message: String
    var body: some View {
        Label(message, systemImage: "exclamationmark.circle")
            .font(.footnote).foregroundStyle(.orange).textSelection(.enabled)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

private struct WorkspaceTextFact: View {
    let title: String
    let value: String
    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(title).font(.caption).foregroundStyle(.secondary)
            Text(value).textSelection(.enabled)
        }
    }
}

private struct WorkspaceFormError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

private func workspaceRecords(_ value: RelayJSONValue) -> [WorkspaceRecord] {
    (value.array ?? []).compactMap { item in
        guard let id = item["id"].string, !id.isEmpty else { return nil }
        return WorkspaceRecord(id: id, value: item)
    }
}

private func workspaceEscaped(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~"))) ?? value
}

private func workspaceName(_ id: String, in values: RelayJSONValue, field: String = "name") -> String {
    guard !id.isEmpty else { return "未指定" }
    return workspaceRecords(values).first { $0.id == id }?.value[field].string ?? id
}

private func workspaceDate(_ value: String?, full: Bool = false) -> String {
    guard let date = RelayDate.parse(value) else { return value ?? "—" }
    return full ? date.formatted(date: .abbreviated, time: .shortened) : date.formatted(date: .omitted, time: .shortened)
}

private func workspaceStatus(_ value: String) -> String {
    ["queued": "等待执行", "running": "进行中", "waiting": "待答复", "completed": "已完成", "failed": "失败",
     "cancelled": "已取消", "interrupted": "已中断", "active": "有效", "expired": "已过期", "disputed": "有争议",
     "fact": "事实", "hypothesis": "假设", "opinion": "观点", "unverified": "待核查", "accepted": "已接收"][value] ?? value
}

private func workspaceEventLabel(_ value: String) -> String {
    ["thread_started": "工作会话已建立", "thread_resumed": "工作会话已恢复", "message_delta": "执行端消息",
     "command_output": "命令输出", "item_started": "开始处理", "item_completed": "处理完成", "consult_requested": "中途咨询",
     "consult_answer": "咨询答复", "consult_failed": "咨询未完成", "interrupt_acknowledged": "执行端已停止",
     "interrupt_error": "停止请求异常", "resume_queued": "等待恢复", "steered": "补充要求已传递",
     "turn_completed": "本轮执行结束", "connection_lost": "执行端连接中断", "result_delivery_error": "结果回传异常",
     "queued": "进入队列", "started": "开始执行", "progress": "执行进度", "output": "执行输出", "question": "等待答复",
     "error": "执行异常", "reasoning": "正在思考", "result": "执行结果"][value] ?? workspaceStatus(value)
}

private func workspaceEventText(_ event: RelayJSONValue) -> String {
    let data = event["data"]
    if let text = data.string { return text }
    if data == .null { return event["content"].string ?? event["message"].stringValue }
    if data["item"].object != nil {
        let item = data["item"]
        var parts = ["text", "command", "aggregatedOutput"].compactMap { item[$0].string }.filter { !$0.isEmpty }
        if let code = item["exitCode"].int { parts.append("退出码：\(code)") }
        if !parts.isEmpty { return parts.joined(separator: "\n") }
        return ["reasoning": "执行端正在分析目标与上下文。", "fileChange": "工作目录文件发生变更。",
                "dynamicToolCall": "执行端正在调用协作工具。"][item["type"].stringValue] ?? item["type"].stringValue
    }
    for key in ["text", "delta", "message", "content", "summary", "question", "answer", "error"] {
        if let text = data[key].string { return text }
    }
    if event["type"].string == "queued" { return data["goal"].string ?? "等待执行端接手。" }
    return data.stringValue
}

private func workspaceWorkEvents(_ events: [RelayJSONValue]) -> [RelayJSONValue] {
    var result: [RelayJSONValue] = []
    for event in events {
        if let last = result.last,
           ["message_delta", "command_output"].contains(event["type"].stringValue),
           last["type"] == event["type"], last["data"]["itemId"] == event["data"]["itemId"],
           var object = last.object, var data = last["data"].object {
            data["text"] = .string(last["data"]["text"].stringValue + event["data"]["text"].stringValue)
            object["data"] = .object(data)
            result[result.count - 1] = .object(object)
        } else { result.append(event) }
    }
    return result
}
