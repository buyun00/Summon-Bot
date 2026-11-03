import SwiftUI
import Foundation

private extension SummonJSONValue {
    var usageNumberValue: Double? { if case .number(let value) = self { return value }; return nil }
}
private func usageInteger(_ value: SummonJSONValue) -> String { value.usageNumberValue?.formatted(.number.precision(.fractionLength(0))) ?? "—" }
private func usagePercent(_ value: SummonJSONValue) -> String { value.usageNumberValue.map { String(format: "%.1f%%", $0 * 100) } ?? "—" }
private func usageCost(_ value: SummonJSONValue) -> String {
    guard (value["pricedCalls"].int ?? 0) > 0 else { return "—" }
    return String(format: "%.4f–%.4f", value["costMin"].usageNumberValue ?? 0, value["costMax"].usageNumberValue ?? 0)
}
private func usageDate(_ value: SummonJSONValue) -> String {
    let parser = ISO8601DateFormatter(); parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    var parsed = parser.date(from: value.stringValue)
    if parsed == nil { parser.formatOptions = [.withInternetDateTime]; parsed = parser.date(from: value.stringValue) }
    guard let date = parsed else { return "—" }
    let formatter = DateFormatter(); formatter.timeZone = TimeZone(identifier: "Asia/Shanghai"); formatter.dateFormat = "MM-dd HH:mm"
    return formatter.string(from: date)
}

@MainActor
struct TokenUsageView: View {
    @Environment(SummonStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var period = "today"
    @State private var dimension = "bots"
    @State private var sort = "totalTokens"
    @State private var selectedKind: String?
    @State private var selectedID = ""
    @State private var selectedName = ""
    @State private var offset = 0
    @State private var revision = 0
    @State private var overview: SummonJSONValue = .null
    @State private var detail: SummonJSONValue = .null
    @State private var loading = false
    @State private var errorMessage: String?
    private let purposes = ["chat": "聊天", "work": "工作执行", "routing": "群聊路由", "compress": "上下文压缩", "compact": "上下文压缩", "organize": "记忆整理", "assemble": "上下文组装", "other": "其他调用"]
    private let statuses = ["succeeded": "完成", "failed": "失败", "cancelled": "取消", "pending": "调用中", "unknown": "结果未知"]
    private var requestKey: String { "\(period):\(selectedKind ?? "all"):\(selectedID):\(offset):\(revision)" }
    private var ranking: [SummonJSONValue] {
        let rows = dimension == "bots" ? overview["bots"].array ?? [] : (overview["rooms"].array ?? []).filter { row in
            dimension == "dm" ? row["kind"].stringValue == "dm" : !["dm", "unassigned"].contains(row["kind"].stringValue)
        }
        return rows.sorted { ($0[sort].usageNumberValue ?? 0) > ($1[sort].usageNumberValue ?? 0) }
    }

    var body: some View {
        NavigationStack {
            List {
                controls
                if loading { ProgressView("正在读取统计…") }
                if let errorMessage { Section { InlineError(message: errorMessage) } }
                billingSections
                if overview["coverage"]["includesUntrackedHistory"].bool == true {
                    Text("采集启用前只回填仍保留的调用，历史已清理部分无法追溯。")
                        .summonFont(.footnote).foregroundStyle(.secondary)
                }
                Section("本机已记录用量") { totalsRows(overview["totals"]) }
                rankingSection
                detailSection
                breakdown("消耗来源", key: "purposes")
                breakdown("模型", key: "models")
                breakdown("每日用量", key: "days")
                requestSection
                Section {
                    Text("命中率只代表留存明细。输入缓存与输出分别统计，推理 Token 包含在输出内。USD 参考费与截图 CNY 消费不直接比较。")
                        .summonFont(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Token 统计")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("完成") { dismiss() } }
                ToolbarItem(placement: .primaryAction) { Button("刷新", systemImage: "arrow.clockwise") { revision += 1 }.disabled(loading) }
            }
            .task(id: requestKey) { await load() }
            .refreshable { await load() }
            .onChange(of: period) { _, _ in selectedKind = nil; selectedID = ""; offset = 0; overview = .null; detail = .null }
            .onChange(of: dimension) { _, _ in selectedKind = nil; selectedID = ""; offset = 0 }
        }
    }

    private var controls: some View {
        Section {
            Picker("统计范围", selection: $period) {
                Text("今天").tag("today"); Text("昨天").tag("yesterday"); Text("近 7 天").tag("7d"); Text("累计").tag("all")
            }.pickerStyle(.segmented)
        } footer: { Text("日期范围采用北京时间。") }
    }

    @ViewBuilder private var billingSections: some View {
        let reports = overview["providerReports"].array ?? []
        ForEach(reports.indices, id: \.self) { index in
            let report = reports[index]
            Section {
                LabeledContent("截图请求 / Token", value: "\(usageInteger(report["calls"])) / \(usageInteger(report["totalTokens"]))")
                LabeledContent("截图消费 · CNY", value: String(format: "¥%.2f", report["amount"].usageNumberValue ?? 0))
                LabeledContent("本机请求 / Token", value: "\(usageInteger(report["localCalls"])) / \(usageInteger(report["localTokens"]))")
                LabeledContent("差额 · 请求 / Token", value: "\(usageInteger(report["differenceCalls"])) / \(usageInteger(report["differenceTokens"]))")
            } header: { Text("\(report["day"].stringValue) · 供应商用量对照") }
            footer: {
                Text("DeepSeek · \(report["billingLabel"].stringValue) · 用户截图人工记录。本机明细覆盖 \(usagePercent(report["tokenCoverage"]))，缺失部分未分摊到 Bot 或会话，不能据此计算全天缓存命中率。")
            }
        }
    }

    @ViewBuilder private func totalsRows(_ totals: SummonJSONValue) -> some View {
        LabeledContent("输入 / 输出", value: "\(usageInteger(totals["inputTokens"])) / \(usageInteger(totals["outputTokens"]))")
        LabeledContent("输入缓存命中 / 未命中", value: "\(usageInteger(totals["cacheHitTokens"])) / \(usageInteger(totals["cacheMissTokens"]))")
        LabeledContent("留存明细缓存命中率", value: usagePercent(totals["cacheHitRate"]))
        LabeledContent("API 调用", value: usageInteger(totals["calls"]))
        LabeledContent("参考费 · USD", value: usageCost(totals))
    }

    private var rankingSection: some View {
        Section {
            Picker("统计维度", selection: $dimension) { Text("Bot").tag("bots"); Text("单聊").tag("dm"); Text("群聊").tag("group") }.pickerStyle(.segmented)
            Picker("排序依据", selection: $sort) {
                Text("Token").tag("totalTokens"); Text("参考费用").tag("costMax"); Text("缓存未命中").tag("cacheMissTokens"); Text("调用次数").tag("calls")
            }
            ForEach(ranking.indices, id: \.self) { index in
                let row = ranking[index]
                Button {
                    selectedKind = dimension == "bots" ? "bot" : "room"; selectedID = row["id"].stringValue
                    selectedName = row["name"].stringValue; offset = 0
                } label: {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack { Text(row["name"].stringValue); Spacer(); Text("\(usageInteger(row["totalTokens"])) Token") }
                        Text("输入 \(usageInteger(row["inputTokens"])) / 输出 \(usageInteger(row["outputTokens"])) · 命中 \(usagePercent(row["cacheHitRate"])) · \(usageInteger(row["calls"])) 次")
                            .summonFont(.caption).foregroundStyle(.secondary)
                    }
                }.buttonStyle(.plain)
            }
        } header: { Text("用量排行") }
    }

    private var detailSection: some View {
        Section {
            if selectedKind != nil {
                Button("查看全部") { selectedKind = nil; selectedID = ""; offset = 0 }
                totalsRows(detail["totals"])
            }
            if (detail["totals"]["unreportedCalls"].int ?? 0) > 0 {
                Text("部分调用没有完整 Token 回执，缺失部分不按零消耗计算。")
                    .summonFont(.footnote).foregroundStyle(.secondary)
            }
        } header: { Text(selectedKind == nil ? "全部调用明细" : selectedName) }
    }

    private func breakdown(_ title: String, key: String) -> some View {
        let rows = detail[key].array ?? []
        return Section(title) {
            ForEach(rows.indices, id: \.self) { index in
                let row = rows[index]
                let name = key == "purposes" ? purposes[row["key"].stringValue] ?? row["key"].stringValue : row["key"].stringValue
                LabeledContent(name, value: "\(usageInteger(row["totalTokens"])) · \(usageInteger(row["calls"])) 次")
            }
        }
    }

    private var requestSection: some View {
        let requests = detail["requests"].array ?? []
        return Section("逐次调用") {
            ForEach(requests.indices, id: \.self) { index in
                let request = requests[index]
                DisclosureGroup {
                    LabeledContent("模型", value: request["model"].stringValue)
                    LabeledContent("输入 / 输出", value: "\(usageInteger(request["inputTokens"])) / \(usageInteger(request["outputTokens"]))")
                    LabeledContent("缓存命中 / 未命中", value: "\(usageInteger(request["cacheHitTokens"])) / \(usageInteger(request["cacheMissTokens"]))")
                    LabeledContent("推理 Token（包含在输出内）", value: usageInteger(request["reasoningTokens"]))
                    if !request["error"].stringValue.isEmpty { Text(request["error"].stringValue).summonFont(.footnote).foregroundStyle(.secondary) }
                } label: {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack { Text(request["botName"].stringValue); Spacer(); Text(usageInteger(request["totalTokens"])) }
                        Text("\(usageDate(request["startedAt"])) · \(purposes[request["purpose"].stringValue] ?? request["purpose"].stringValue) · \(statuses[request["status"].stringValue] ?? request["status"].stringValue)")
                            .summonFont(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            HStack {
                Button("上一页") { offset = max(0, offset - 25) }.disabled(offset == 0 || loading)
                Spacer()
                Button("下一页") { offset += 25 }.disabled(detail["hasMore"].bool != true || loading)
            }
        }
    }

    private func load() async {
        let key = requestKey, scopeKind = selectedKind, scopeID = selectedID, currentOffset = offset, currentPeriod = period
        loading = true; errorMessage = nil; detail = .null
        defer { if requestKey == key { loading = false } }
        do {
            let client = SummonAPIClient(baseURL: try SummonAPIClient.normalizedURL(store.settings.baseURL), token: store.savedToken)
            var components = URLComponents(); components.path = "/api/usage"
            components.queryItems = [URLQueryItem(name: "period", value: currentPeriod), URLQueryItem(name: "limit", value: "25")]
            let all = try await client.request(SummonJSONValue.self, path: components.string!)
            var current = all
            if scopeKind != nil || currentOffset > 0 {
                components.queryItems?.append(URLQueryItem(name: "offset", value: String(currentOffset)))
                if let scopeKind { components.queryItems?.append(URLQueryItem(name: scopeKind == "bot" ? "botId" : "roomId", value: scopeID)) }
                current = try await client.request(SummonJSONValue.self, path: components.string!)
            }
            guard !Task.isCancelled, requestKey == key else { return }
            overview = all; detail = current
        } catch { if !Task.isCancelled && requestKey == key { errorMessage = error.localizedDescription } }
    }
}
