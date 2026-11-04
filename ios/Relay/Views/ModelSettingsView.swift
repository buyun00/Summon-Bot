import SwiftUI
import Foundation

private let modelTint = Color(red: 0.58, green: 0.68, blue: 0.60)
private extension SummonJSONValue {
    var modelNumber: Double? { if case .number(let value) = self, value.isFinite { return value }; return nil }
}
private func modelMoney(_ value: SummonJSONValue) -> String {
    guard let amount = value["amount"].modelNumber else { return "—" }
    let formatter = NumberFormatter(); formatter.numberStyle = .currency; formatter.locale = Locale(identifier: "zh_CN")
    formatter.currencyCode = value["currency"].string ?? "USD"; formatter.maximumFractionDigits = 2
    return formatter.string(from: NSNumber(value: amount)) ?? "\(amount) \(value["currency"].stringValue)"
}
private enum ModelBrandLibrary {
    static let catalog: SummonJSONValue = {
        guard let url = Bundle.main.url(forResource: "ai-brands", withExtension: "json"), let data = try? Data(contentsOf: url), let value = try? JSONDecoder().decode(SummonJSONValue.self, from: data) else { return .null }
        return value
    }()
    static func brand(_ item: SummonJSONValue) -> String {
        if item["role"].stringValue == "executor" { return item["kind"].stringValue.contains("claude") ? "claudecode" : "codex" }
        let model = item["model"].stringValue.lowercased()
        for rule in catalog["models"].array ?? [] { let pair = rule.array ?? []; if pair.count == 2, model.range(of: pair[0].stringValue, options: .regularExpression) != nil { return pair[1].stringValue } }
        for key in ["provider", "kind"] { if let id = catalog["aliases"][item[key].stringValue.lowercased()].string { return id } }
        let host = URL(string: item["baseUrl"].stringValue)?.host?.lowercased() ?? ""
        for rule in catalog["hosts"].array ?? [] { let pair = rule.array ?? []; if pair.count == 2, host == pair[0].stringValue || host.hasSuffix(".\(pair[0].stringValue)") { return pair[1].stringValue } }
        return "ai"
    }
}
private struct ModelBrandImage: View {
    let item: SummonJSONValue
    var size: CGFloat = 24
    var body: some View { Image("AI-\(ModelBrandLibrary.brand(item))").resizable().renderingMode(.template).scaledToFit().foregroundStyle(modelTint).frame(width: size, height: size) }
}
private struct ModelGaugeData {
    var ring: Double?
    var dots: Int?
    var value = "—"
    init(_ item: SummonJSONValue) {
        if item["role"].stringValue == "executor" && item["enabled"].bool != true { value = item["label"].stringValue.isEmpty ? "待接入" : item["label"].stringValue; return }
        let usage = item["usage"]
        let windows = (usage["windows"].array ?? []).filter { $0["remainingPercent"].modelNumber != nil }
        let main = windows.first { $0["durationMinutes"].int == 10080 } ?? windows.first
        let short = windows.first { $0["durationMinutes"].int == 300 && $0 != main }
        let money = (usage["balances"].array ?? []) + (usage["balance"].object != nil ? [usage["balance"]] : [])
        if item["kind"].stringValue == "api" { ring = 100; if let balance = money.first(where: { $0["currency"].stringValue == "CNY" }) ?? money.first { value = modelMoney(balance) }; return }
        if let main, let remaining = main["remainingPercent"].modelNumber { ring = min(100, max(0, remaining)) }
        if let short, let remaining = short["remainingPercent"].modelNumber { dots = Int(ceil(min(100, max(0, remaining)) / 25)); value = "" }
        else if let ring { value = "\(Int(ring.rounded()))%" }
    }
}
struct ModelQuotaSignal: View {
    let item: SummonJSONValue
    let label: String
    let action: () -> Void
    var body: some View {
        let gauge = ModelGaugeData(item)
        Button(action: action) {
            VStack(spacing: 1) {
                ZStack(alignment: .top) {
                    Canvas { context, _ in
                        var track = Path(); track.addArc(center: CGPoint(x: 32, y: 29), radius: 23, startAngle: .degrees(135), endAngle: .degrees(405), clockwise: false)
                        context.stroke(track, with: .color(Color.white.opacity(0.13)), style: StrokeStyle(lineWidth: 3.2, lineCap: .round))
                        if let remaining = gauge.ring, remaining > 0 { var progress = Path(); progress.addArc(center: CGPoint(x: 32, y: 29), radius: 23, startAngle: .degrees(135), endAngle: .degrees(135 + 270 * remaining / 100), clockwise: false); context.stroke(progress, with: .color(remaining < 10 ? .orange : modelTint), style: StrokeStyle(lineWidth: 3.2, lineCap: .round)) }
                        if let dots = gauge.dots { for (index, point) in [CGPoint(x: 21, y: 49), CGPoint(x: 28.5, y: 51.5), CGPoint(x: 35.5, y: 51.5), CGPoint(x: 43, y: 49)].enumerated() { context.fill(Path(ellipseIn: CGRect(x: point.x - 1.9, y: point.y - 1.9, width: 3.8, height: 3.8)), with: .color(index < dots ? modelTint : Color.white.opacity(0.13))) } }
                    }
                    ModelBrandImage(item: item).padding(.top, 16)
                    if !gauge.value.isEmpty { Text(gauge.value).font(.system(size: 11)).foregroundStyle(modelTint).padding(.top, 44) }
                }.frame(width: 64, height: 59)
                Text(label).font(.system(size: 10, weight: .semibold)).kerning(1).foregroundStyle(modelTint)
            }.padding(.vertical, 3).frame(maxWidth: .infinity)
        }.buttonStyle(SummonPressStyle()).accessibilityLabel("\(label) \(item["name"].stringValue)，\(gauge.value)，查看额度")
    }
}
private struct ModelUsageDetails: View {
    let item: SummonJSONValue
    var body: some View {
        let usage = item["usage"]
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) { ModelBrandImage(item: item, size: 32); VStack(alignment: .leading, spacing: 5) { Text(item["name"].stringValue).summonFont(.headline); Text(item["model"].stringValue).summonFont(.caption).foregroundStyle(.secondary) } }
            ForEach(Array(((usage["balances"].array ?? []) + (usage["balance"].object != nil ? [usage["balance"]] : [])).enumerated()), id: \.offset) { _, balance in Text(modelMoney(balance)).summonFont(.title2).foregroundStyle(modelTint) }
            ForEach(Array((usage["windows"].array ?? []).enumerated()), id: \.offset) { _, window in
                VStack(alignment: .leading, spacing: 8) {
                    HStack { Text(window["name"].stringValue); Spacer(); Text(window["remainingPercent"].modelNumber.map { "\(Int($0.rounded()))% 剩余" } ?? "—").foregroundStyle(modelTint) }.summonFont(.subheadline)
                    if let remaining = window["remainingPercent"].modelNumber { ProgressView(value: min(100, max(0, remaining)), total: 100).tint(modelTint) }
                    if let reset = SummonDate.parse(window["resetsAt"].string) { Text("重置：\(reset.formatted(date: .abbreviated, time: .shortened))").summonFont(.caption).foregroundStyle(.secondary) }
                }
            }
            if usage["credits"].modelNumber != nil { Text("附加点数 \(usage["credits"].stringValue) credits").summonFont(.caption).foregroundStyle(.secondary) }
            if usage["unlimited"].bool == true { Text("额外额度不设限").foregroundStyle(modelTint) }
            if usage["status"].stringValue == "not_connected" { Text(usage["note"].stringValue).summonFont(.caption).foregroundStyle(.secondary) }
            else if usage["status"].stringValue == "unconfigured" { Text("选择聊天模型后读取额度").summonFont(.caption).foregroundStyle(.secondary) }
            else if usage["status"].stringValue == "error" { Text(usage["stale"].bool == true ? "上次读取 · 当前暂未更新" : usage["error"].stringValue).summonFont(.caption).foregroundStyle(.orange) }
            else if (usage["windows"].array ?? []).isEmpty && (usage["balances"].array ?? []).isEmpty && usage["balance"].object == nil { Text("供应商未返回额度数值").summonFont(.caption).foregroundStyle(.secondary) }
            if let checked = SummonDate.parse(usage["checkedAt"].string) { Text("更新于 \(checked.formatted(date: .abbreviated, time: .shortened))").summonFont(.caption).foregroundStyle(.secondary) }
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}
private struct ModelExecutorControl: View {
    @Environment(SummonStore.self) private var store
    let item: SummonJSONValue
    @State private var busy = false
    @State private var error: String?
    var body: some View {
        if item["role"].stringValue == "executor" {
            if let error { Text(error).summonFont(.caption).foregroundStyle(.orange) }
            if item["enabled"].bool == true || item["detected"].bool == true {
                Button(busy ? "正在处理…" : item["enabled"].bool == true ? "断开 Codex" : "接入 Codex 执行端") {
                    let enabled = item["enabled"].bool != true
                    Task { @MainActor in
                        busy = true; error = nil; defer { busy = false }
                        do {
                            _ = try await store.request(path: "/api/model-settings/executors/codex-desktop", method: "POST", body: .object(["enabled": .bool(enabled)]))
                            try await store.refreshModelUsage()
                        } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
                    }
                }.disabled(busy)
            }
        }
    }
}
struct ModelQuotaDetailsView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(SummonStore.self) private var store
    let item: SummonJSONValue
    var body: some View {
        NavigationStack {
            let current = item["role"].stringValue == "executor" ? store.modelSummary["executors"].array?.first ?? item : item
            VStack(alignment: .leading, spacing: 22) { ModelUsageDetails(item: current); ModelExecutorControl(item: current); Divider(); NavigationLink("管理模型与引擎") { ModelSettingsView() }; Spacer(minLength: 0) }.padding(24)
                .background(SummonTheme.background).navigationTitle("额度").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }.presentationDetents([.medium, .large]).presentationDragIndicator(.visible).presentationCornerRadius(28)
    }
}

@MainActor struct ModelSettingsView: View {
    @Environment(SummonStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var data: SummonJSONValue = .null
    @State private var draft: SummonJSONValue = .null
    @State private var login: SummonJSONValue = .null
    @State private var error: String?
    @State private var busy = false
    private var entries: [SummonJSONValue] { data["connections"].array ?? [] }
    private var selected: SummonJSONValue { entries.first { $0["id"] == draft["id"] } ?? .null }
    var body: some View {
        NavigationStack {
            Form {
                if let error { Section { Text(error).foregroundStyle(.orange) } }
                Section("当前额度") { ModelUsageDetails(item: store.modelSummary["chat"]) }
                if let work = store.modelSummary["executors"].array?.first { Section("执行引擎接入") { ModelUsageDetails(item: work); ModelExecutorControl(item: work) } }
                Section("聊天模型连接") {
                    ForEach(Array(entries.enumerated()), id: \.offset) { _, entry in Button { draft = entry; login = .null } label: { HStack(spacing: 12) { ModelBrandImage(item: entry); VStack(alignment: .leading) { Text(entry["name"].stringValue); Text(entry["model"].stringValue).summonFont(.caption).foregroundStyle(.secondary) }; Spacer(); if entry["active"].bool == true { Text("当前").foregroundStyle(modelTint) } } } }
                    Menu("添加连接") { ForEach(["codex", "grok", "api"], id: \.self) { kind in Button(kind == "codex" ? "Codex 订阅" : kind == "grok" ? "Grok 订阅" : "通用 API") { draft = .object(["kind": .string(kind), "name": .string(kind == "codex" ? "Codex 订阅" : kind == "grok" ? "Grok 订阅" : "通用 API"), "model": .string(kind == "codex" ? "gpt-6-luna" : kind == "grok" ? "grok-4.7" : "")]); login = .null } } }
                }
                if draft.object != nil {
                    ModelConnectionForm(entry: draft, selected: selected, presets: data["presets"].array ?? [], busy: busy,
                        save: { payload in run { try await save(payload) } },
                        importCodex: { run { data = try await store.request(path: "/api/model-settings/local/import", method: "POST", body: .object(["kind": draft["kind"]])); draft = entries.first { $0["id"].stringValue == data["importedId"].stringValue } ?? .null; try await store.refreshModelUsage(force: true) } },
                        authorize: { run { login = try await store.request(path: "/api/model-settings/connections/\(component(selected["id"]))/login", method: "POST", body: .object([:])) } },
                        activate: { run { data = try await store.request(path: "/api/model-settings/active", method: "POST", body: .object(["id": selected["id"]])); try await store.refreshModelUsage(force: true) } },
                        remove: { run { data = try await store.request(path: "/api/model-settings/connections/\(component(selected["id"]))", method: "DELETE"); draft = entries.first { $0["active"].bool == true } ?? .null; try await store.refreshModelUsage(force: true) } },
                        discover: { try await store.request(path: "/api/model-settings/connections/\(component(selected["id"]))/models?discover=1")["models"].array ?? [] })
                        .id("\(draft["id"].stringValue)-\(draft["kind"].stringValue)-\(selected["configured"].stringValue)")
                }
                if ["starting", "waiting"].contains(login["status"].stringValue) { Section("订阅授权") { Text(login["userCode"].stringValue).summonFont(.title2).textSelection(.enabled); if let url = URL(string: login["verificationUri"].stringValue), ["https", "http"].contains(url.scheme ?? "") { Link("打开授权页面", destination: url) }; Button("取消授权") { run { login = try await store.request(path: "/api/model-settings/connections/\(component(login["id"]))/login", method: "DELETE") } } } }
                if !login["error"].stringValue.isEmpty { Text(login["error"].stringValue).foregroundStyle(.orange) }
                Section { Text("聊天模型由所有 Bot 共用，额度按账号显示。").summonFont(.caption).foregroundStyle(.secondary) }
            }.navigationTitle("模型与引擎").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } }; ToolbarItem(placement: .topBarTrailing) { Button("刷新") { run { try await store.refreshModelUsage(force: true); try await reload() } }.disabled(busy) } }
                .task { do { try await reload() } catch { if !Task.isCancelled { self.error = error.localizedDescription } } }
                .task(id: login["id"].stringValue + login["status"].stringValue) { await pollLogin() }
        }
    }
    private func component(_ value: SummonJSONValue) -> String { SummonAPIClient.component(value.stringValue) }
    private func run(_ action: @escaping @MainActor () async throws -> Void) { guard !busy else { return }; Task { busy = true; error = nil; defer { busy = false }; do { try await action() } catch { if !Task.isCancelled { self.error = error.localizedDescription } } } }
    private func reload() async throws { data = try await store.request(path: "/api/model-settings"); if draft.object == nil { draft = entries.first { $0["active"].bool == true } ?? .null }; try await store.refreshModelUsage() }
    private func save(_ payload: SummonJSONValue) async throws {
        let ids = Set(entries.map { $0["id"].stringValue })
        data = try await store.request(path: "/api/model-settings/connections", method: "POST", body: payload)
        guard let entry = entries.first(where: { payload["id"].string != nil ? $0["id"] == payload["id"] : !ids.contains($0["id"].stringValue) }) else { return }
        draft = entry
        if entry["kind"].stringValue == "api" { data = try await store.request(path: "/api/model-settings/active", method: "POST", body: .object(["id": entry["id"]])) }
        else if entry["configured"].bool != true { login = try await store.request(path: "/api/model-settings/connections/\(component(entry["id"]))/login", method: "POST", body: .object([:])) }
        try await store.refreshModelUsage(force: true)
    }
    private func pollLogin() async {
        guard ["starting", "waiting"].contains(login["status"].stringValue) else { return }
        do { while !Task.isCancelled { try await Task.sleep(for: .seconds(2)); let result = try await store.request(path: "/api/model-settings/connections/\(component(login["id"]))/login"); login = result; if !["starting", "waiting"].contains(result["status"].stringValue) { if result["status"].stringValue == "completed" { try await reload() }; break } } } catch { if !Task.isCancelled { self.error = error.localizedDescription } }
    }
}

@MainActor private struct ModelConnectionForm: View {
    let entry: SummonJSONValue
    let selected: SummonJSONValue
    let presets: [SummonJSONValue]
    let busy: Bool
    let save: (SummonJSONValue) -> Void
    let importCodex: () -> Void
    let authorize: () -> Void
    let activate: () -> Void
    let remove: () -> Void
    let discover: () async throws -> [SummonJSONValue]
    @State private var fields: [String: SummonJSONValue] = [:]
    @State private var choices: [SummonJSONValue] = []
    @State private var error: String?
    private var kind: String { entry["kind"].stringValue }
    private func binding(_ key: String) -> Binding<String> { Binding(get: { fields[key]?.stringValue ?? "" }, set: { fields[key] = .string($0) }) }
    var body: some View {
        Section("连接配置") {
            TextField("连接名称", text: binding("name"))
            if kind == "api" {
                Picker("服务商", selection: Binding(get: { fields["provider"]?.stringValue ?? "openai-compatible" }, set: { value in fields["provider"] = .string(value); if let preset = presets.first(where: { $0["id"].stringValue == value }) { fields["baseUrl"] = preset["baseUrl"]; fields["api"] = preset["api"] } })) { ForEach(Array(presets.enumerated()), id: \.offset) { _, preset in Text(preset["name"].stringValue).tag(preset["id"].stringValue) } }
                Picker("接口协议", selection: binding("api")) { Text("OpenAI Chat Completions").tag("openai-completions"); Text("OpenAI Responses").tag("openai-responses"); Text("Anthropic Messages").tag("anthropic-messages") }
                TextField("API 地址", text: binding("baseUrl")).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                SecureField(selected["configured"].bool == true ? "API Key（留空保留）" : "API Key", text: binding("apiKey")).textInputAutocapitalization(.never).autocorrectionDisabled()
                Toggle("这个服务无需 API Key", isOn: Binding(get: { fields["allowNoKey"]?.bool == true }, set: { fields["allowNoKey"] = .bool($0) }))
            } else {
                Text(selected["configured"].bool == true ? "订阅已连接" : "保存后通过设备码授权").foregroundStyle(modelTint)
                if selected.object == nil { Button("导入服务器上的 \(kind == "codex" ? "Codex" : "Grok") 登录", action: importCodex) }
                if selected.object != nil && !["codex-local", "grok-local"].contains(selected["authMode"].stringValue) { Button("授权订阅", action: authorize) }
            }
            TextField("聊天模型 ID", text: binding("model")).textInputAutocapitalization(.never).autocorrectionDisabled()
            if selected.object != nil { Button("获取模型目录") { Task { do { choices = try await discover() } catch { self.error = error.localizedDescription } } } }
            if !choices.isEmpty { Menu("选择模型") { ForEach(Array(choices.enumerated()), id: \.offset) { _, choice in Button(choice["name"].string ?? choice["id"].stringValue) { fields["model"] = choice["id"] } } } }
            Picker("思考强度", selection: binding("thinkingLevel")) { Text("关闭思考").tag("off"); Text("低").tag("low"); Text("中").tag("medium"); Text("高").tag("high"); Text("很高").tag("xhigh"); Text("最高").tag("max") }
            TextField("上下文上限 · Token", text: binding("contextWindow")).keyboardType(.numberPad)
            TextField("输出上限 · Token", text: binding("maxTokens")).keyboardType(.numberPad)
            if kind == "api" { TextField("余额查询路径（可选）", text: binding("balancePath")).textInputAutocapitalization(.never); TextField("余额 JSON 字段（可选）", text: binding("balanceField")).textInputAutocapitalization(.never); TextField("余额币种（默认 USD）", text: binding("balanceCurrency")) }
            if let error { Text(error).foregroundStyle(.orange) }
            Button(busy ? "正在保存…" : "保存配置") { var payload = fields; for key in ["usage", "identity", "configured", "active"] { payload.removeValue(forKey: key) }; payload["contextWindow"] = .number(Double(binding("contextWindow").wrappedValue) ?? 128000); payload["maxTokens"] = .number(Double(binding("maxTokens").wrappedValue) ?? 8192); save(.object(payload)) }
            if selected["configured"].bool == true && selected["active"].bool != true { Button("用于 Pi 聊天", action: activate) }
            if selected.object != nil && selected["active"].bool != true { Button("移除此连接", role: .destructive, action: remove) }
        }.disabled(busy).onAppear {
            fields = entry.object ?? [:]; fields["apiKey"] = .string("")
            for (key, value) in ["provider": SummonJSONValue.string("openai-compatible"), "api": .string("openai-completions"), "thinkingLevel": .string("high"), "contextWindow": .number(kind == "codex" ? 1050000 : kind == "grok" ? 500000 : 128000), "maxTokens": .number(8192)] { if fields[key] == nil { fields[key] = value } }
        }
    }
}
