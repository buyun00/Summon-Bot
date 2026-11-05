import SwiftUI

private struct SummonGuideMessage: Identifiable {
    let id = UUID()
    let user: Bool
    let text: String
}

struct OnboardingView: View {
    @Environment(SummonStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    let onRoom: (String) -> Void
    // These messages and the secure input are never written to drafts or conversation storage.
    @State private var messages = [SummonGuideMessage(user: false, text: "你好，我是主 Bot，欢迎来到 Summon Bot。我们先把聊天模型接上，再边聊边熟悉这里。")]
    @State private var reply: SummonJSONValue = .null
    @State private var input = ""
    @State private var busy = false
    @State private var error: String?
    private var phase: String { reply["phase"].stringValue }
    private var secure: Bool { reply["input"].string == "password" }
    private var editable: Bool { reply.object != nil && reply["input"].string != "none" }
    private var pollKey: String { phase == "login" ? reply["draft"]["id"].stringValue : "" }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 18) {
                            ForEach(messages) { message in
                                HStack {
                                    if message.user { Spacer(minLength: 36) }
                                    VStack(alignment: message.user ? .trailing : .leading, spacing: 6) {
                                        Text(message.user ? "你" : "主 Bot").font(.caption).foregroundStyle(.secondary)
                                        Text(message.text).font(.body).padding(16)
                                            .background(message.user ? Color.white.opacity(0.12) : SummonTheme.surface, in: RoundedRectangle(cornerRadius: 16))
                                    }
                                    if !message.user { Spacer(minLength: 24) }
                                }
                            }
                            if busy { ProgressView("正在准备…").font(.caption) }
                            if let error { Text(error).foregroundStyle(.orange).font(.callout) }
                            if let code = reply["login"]["userCode"].string { Text(code).font(.title2.monospaced().bold()) }
                            if let raw = reply["login"]["verificationUri"].string, let url = URL(string: raw), url.scheme == "https" {
                                Button("打开授权页面") { openURL(url) }.buttonStyle(.borderedProminent)
                            }
                            ForEach(Array((reply["options"].array ?? []).enumerated()), id: \.offset) { _, option in
                                Button(option["label"].stringValue) {
                                    input = ""
                                    Task { await send(option["action"].stringValue, value: option["value"].stringValue, label: option["label"].stringValue) }
                                }.buttonStyle(.bordered).disabled(busy)
                            }
                            if reply.object == nil && !busy { Button("重新连接") { Task { await send("hello") } }.buttonStyle(.bordered) }
                            Color.clear.frame(height: 1).id("guide-end")
                        }.padding(20)
                    }
                    .onChange(of: messages.count) { _, _ in withAnimation { proxy.scrollTo("guide-end", anchor: .bottom) } }
                }
                HStack(spacing: 12) {
                    Group {
                        if secure { SecureField("粘贴 API Key…", text: $input) }
                        else { TextField(reply["placeholder"].string ?? "输入消息…", text: $input) }
                    }
                    .textInputAutocapitalization(.never).autocorrectionDisabled()
                    .textFieldStyle(.roundedBorder).submitLabel(.send).onSubmit(submit)
                    .disabled(!editable || busy)
                    Button("发送", action: submit).disabled(!editable || busy || input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }.padding(.horizontal, 16).padding(.top, 10)
                Text(secure ? "密钥只用于模型连接，不进入聊天或草稿" : phase == "ready" ? "下一条对话由你选择的模型回复" : "模型接通前，由本地引导陪你完成连接")
                    .font(.caption2).foregroundStyle(.secondary).padding(10)
            }
            .navigationTitle("主 Bot · 初次见面").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("稍后") { dismiss() } } }
            .task { await send("hello") }
            .task(id: pollKey) {
                guard !pollKey.isEmpty else { return }
                while !Task.isCancelled && phase == "login" {
                    do { try await Task.sleep(for: .seconds(2)) } catch { return }
                    await send("poll")
                }
            }
        }
    }
    private func submit() {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !busy, editable else { return }
        input = ""
        Task { await send(phase == "ready" ? "handoff" : phase, value: text) }
    }
    private func send(_ action: String, value: String = "", label: String? = nil) async {
        guard !busy else { return }
        busy = true; error = nil
        let hidden = secure
        defer { busy = false }
        do {
            let next = try await store.request(path: "/api/model-settings/onboarding/reply", method: "POST", body: .object([
                "action": .string(action), "value": .string(value), "draft": reply["draft"]
            ]))
            guard !Task.isCancelled else { return }
            if !["hello", "poll"].contains(action) {
                messages.append(SummonGuideMessage(user: true, text: hidden && action == "key" ? "已提交 API Key（内容已隐藏）" : label ?? value))
            }
            if let text = next["text"].string, !text.isEmpty { messages.append(SummonGuideMessage(user: false, text: text)) }
            reply = next
            if let id = next["roomId"].string { await store.refresh(); onRoom(id) }
        } catch is CancellationError { }
        catch {
            self.error = error.localizedDescription.replacingOccurrences(of: #"(?:sk-|xai-)[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"#, with: "[密钥已隐藏]", options: .regularExpression)
            if action == "poll", var draftReply = reply.object { draftReply["phase"] = .string("login-error"); draftReply["login"] = .null; reply = .object(draftReply) }
        }
    }
}
