import SwiftUI
import UIKit

struct CreateBotView: View {
    @Environment(SummonStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let onCreated: (SummonBot) -> Void
    @State private var name = ""
    @State private var avatar = SummonAvatar()
    @State private var busy = false
    @State private var errorMessage: String?

    private var canSubmit: Bool {
        let title = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return !busy && store.protocolReady && !title.isEmpty && title.utf16.count <= 100
    }

    private var buttonColor: Color {
        Color(summonHex: PaperLibrary.paperColor(avatar.color, shape: avatar.shape))
    }

    private var buttonForeground: Color {
        guard canSubmit else { return Color(uiColor: .secondaryLabel) }
        let hex = PaperLibrary.paperColor(avatar.color, shape: avatar.shape)
        let rgb = UInt32(hex.dropFirst(), radix: 16) ?? 0
        func linear(_ channel: UInt32) -> Double {
            let value = Double(channel) / 255
            return value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        let luminance = 0.2126 * linear((rgb >> 16) & 255)
            + 0.7152 * linear((rgb >> 8) & 255) + 0.0722 * linear(rgb & 255)
        return luminance > 0.179 ? .black : .white
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 28) {
                    GreetingAvatar(avatar: avatar)
                        .padding(.top, 28).padding(.bottom, 10)
                    TextField("为 Bot 取个名字", text: $name)
                        .summonFont(.title3, weight: .medium).multilineTextAlignment(.center)
                        .padding(18)
                        .background(SummonTheme.surface, in: RoundedRectangle(cornerRadius: 22))
                        .overlay { RoundedRectangle(cornerRadius: 22).stroke(SummonTheme.bubbleStroke, lineWidth: 0.8) }
                    if name.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count > 100 {
                        InlineError(message: "Bot 名称不能超过 100 个字符。")
                    }
                    AvatarPicker(avatar: $avatar)
                    if let errorMessage { InlineError(message: errorMessage) }
                }.padding(24)
            }
            .safeAreaInset(edge: .bottom) {
                Button {
                    Task { await create() }
                } label: {
                    HStack(spacing: 10) {
                        if busy { ProgressView().tint(buttonForeground) }
                        Text("创建").summonFont(.headline)
                    }
                    .frame(maxWidth: .infinity, minHeight: 54)
                    .foregroundStyle(buttonForeground)
                    .background(canSubmit ? buttonColor : Color(uiColor: .systemGray5), in: Capsule())
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .disabled(!canSubmit)
                .padding(.horizontal, 28).padding(.bottom, 12)
            }
            .navigationTitle("创建新 Bot")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("关闭", systemImage: "xmark") { dismiss() }.labelStyle(.iconOnly) }
            }
        }
    }

    private func create() async {
        guard canSubmit else { return }
        busy = true; errorMessage = nil
        defer { busy = false }
        do {
            let bot = try await store.createBot(name: name.trimmingCharacters(in: .whitespacesAndNewlines), avatar: avatar, instructions: "")
            dismiss(); onCreated(bot)
        } catch { errorMessage = error.localizedDescription }
    }
}

struct AvatarPicker: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var selection
    @Binding var avatar: SummonAvatar
    @State private var custom = false
    var body: some View {
        VStack(spacing: 20) {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 4), spacing: 12) {
                ForEach(AvatarPalette.shapes, id: \.id) { shape in
                    Button { avatar.color=PaperLibrary.paperColor(avatar.color,shape:avatar.shape);avatar.shape=shape.id;avatar.secondary="#E6DDC8";avatar.ink="#414A3C";avatar.paper="#FFFBF0";avatar.image=nil } label: {
                        VStack(spacing:4) {
                            BotAvatar(shape:shape.id,color:avatar.color,size:43,secondary:avatar.secondary,ink:avatar.ink,paper:avatar.paper,animated:false)
                            Text(shape.label).summonFont(.caption2)
                        }.padding(5).background {
                            if PaperLibrary.role(avatar.shape) == shape.id && avatar.image == nil {
                                RoundedRectangle(cornerRadius:12).stroke(Color.primary,lineWidth:2).matchedGeometryEffect(id:"shape",in:selection)
                            }
                        }
                    }.buttonStyle(SummonPressStyle(compact:true)).accessibilityLabel(shape.label)
                        .accessibilityAddTraits(PaperLibrary.role(avatar.shape) == shape.id ? .isSelected : [])
                }
            }
            LazyVGrid(columns:Array(repeating:GridItem(.flexible()),count:4),spacing:10) {
                ForEach(PaperLibrary.templates.indices, id: \.self) { index in
                    let template = PaperLibrary.templates[index]
                    Button {
                        avatar.color=template["color"]!;avatar.secondary=template["secondary"];avatar.ink=template["ink"];avatar.paper=template["paper"];avatar.image=nil
                    } label: {
                        VStack(spacing:4) {
                            HStack(spacing:0) { Color(summonHex:template["color"]!);Color(summonHex:template["secondary"]!) }.frame(height:26).clipShape(RoundedRectangle(cornerRadius:7))
                            Text(template["name"]!).font(.system(size:10))
                        }.padding(3).overlay {
                            if avatar.color.uppercased() == template["color"] && avatar.secondary?.uppercased() == template["secondary"] {
                                RoundedRectangle(cornerRadius:9).stroke(Color.primary,lineWidth:2).matchedGeometryEffect(id:"palette",in:selection)
                            }
                        }
                    }.buttonStyle(SummonPressStyle(compact:true))
                }
            }
            DisclosureGroup("自定义颜色",isExpanded:$custom) {
                ColorPicker("纸片颜色",selection:binding("color"),supportsOpacity:false)
                ColorPicker("衬纸颜色",selection:binding("secondary"),supportsOpacity:false)
                ColorPicker("边线颜色",selection:binding("ink"),supportsOpacity:false)
                ColorPicker("眼睛留白",selection:binding("paper"),supportsOpacity:false)
            }
        }
        .animation(reduceMotion ? nil : .spring(response:0.34,dampingFraction:0.8),value:avatar.shape)
        .animation(reduceMotion ? nil : .spring(response:0.34,dampingFraction:0.8),value:avatar.color)
    }
    private func binding(_ field:String) -> Binding<Color> {
        Binding(get:{
            let hex = field == "color" ? PaperLibrary.paperColor(avatar.color,shape:avatar.shape) : field == "secondary" ? avatar.secondary ?? "#E6DDC8" : field == "ink" ? avatar.ink ?? "#414A3C" : avatar.paper ?? "#FFFBF0"
            return Color(summonHex:hex)
        },set:{ value in
            var r:CGFloat=0,g:CGFloat=0,b:CGFloat=0,a:CGFloat=0
            UIColor(value).getRed(&r,green:&g,blue:&b,alpha:&a)
            let hex=String(format:"#%02X%02X%02X",Int(r*255),Int(g*255),Int(b*255))
            avatar.color=PaperLibrary.paperColor(avatar.color,shape:avatar.shape);avatar.shape=PaperLibrary.role(avatar.shape)
            switch field {case "color":avatar.color=hex;case "secondary":avatar.secondary=hex;case "ink":avatar.ink=hex;default:avatar.paper=hex}
            avatar.image=nil
        })
    }
}

private struct NewGroupSuggestion: Identifiable {
    let id: String
    let title: String
    let desc: String
    let prompt: String
}

private let newGroupSuggestions: [NewGroupSuggestion] = [
    NewGroupSuggestion(
        id: "dev",
        title: "软件与网页开发",
        desc: "写代码、做网页或应用，按需配前端与测试专员",
        prompt: "我想建一个软件与网页开发群，用来推进架构、代码和界面实现，先帮我配好团队并确认要绑定的项目目录。"
    ),
    NewGroupSuggestion(
        id: "schedule",
        title: "个人日程与事务",
        desc: "排差旅、管待办，个人习惯说一遍永久记住",
        prompt: "我想建一个个人日程与日常事务群，帮我整理待办、规划行程并长期记住我的习惯偏好。"
    ),
    NewGroupSuggestion(
        id: "ops",
        title: "服务器运维排障",
        desc: "查日志、盯告警，高风险操作主动拦住",
        prompt: "我想建一个线上服务运维与排障群，负责查日志、处理故障并长期维护运维手册。"
    ),
    NewGroupSuggestion(
        id: "research",
        title: "专题研究与写作",
        desc: "查资料、磨方案，把讨论沉淀成活文档",
        prompt: "我想建一个专题研究与方案写作群，用来收集资料、推演方案并长期维护专业文档。"
    ),
]

struct NewGroupDraftView: View {
    @Environment(SummonStore.self) private var store
    let onCreated: (SummonRoom) -> Void
    @State private var draftText = ""
    @State private var workspaces: [SummonJSONValue] = []
    @State private var selectedWorkspaceID: String?
    @State private var busy = false
    @State private var errorMessage: String?
    @FocusState private var inputFocused: Bool

    private var eggBot: SummonBot? {
        store.bots.first { $0.role_id == "eggbot" && !$0.isPaused }
            ?? store.bots.first { $0.role_id == "eggbot" }
    }

    private var eggAvatar: SummonAvatar {
        eggBot?.resolvedAvatar ?? SummonAvatar.defaultAvatar(for: "bot-default-eggbot-local")
    }

    private var writableWorkspaces: [SummonJSONValue] {
        workspaces.filter { $0["write"].bool != false && !$0["id"].stringValue.isEmpty }
    }

    private var selectedWorkspaceName: String? {
        guard let selectedWorkspaceID else { return nil }
        return writableWorkspaces.first { $0["id"].stringValue == selectedWorkspaceID }?["name"].string
    }

    private var canSend: Bool {
        !busy && store.protocolReady && !draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                GreetingAvatar(avatar: eggAvatar)
                    .scaleEffect(0.84)
                    .frame(height: 124)
                    .padding(.top, 20)

                VStack(spacing: 8) {
                    Text("\(eggBot?.name ?? "EggBot") · 团队孵化")
                        .summonFont(.caption, weight: .semibold)
                        .foregroundStyle(Color(summonHex: PaperLibrary.paperColor(eggAvatar.color, shape: eggAvatar.shape)))
                    Text(busy ? "正在为你建群并安排伙伴…" : "你想要建一个什么群呢？")
                        .summonFont(.title3, weight: .bold)
                        .foregroundStyle(.primary)
                        .multilineTextAlignment(.center)
                    Text(busy ? "群主控与 EggBot 正在就位，马上进入对话。" : "直接告诉我你想推进的项目、长期事务或想要的专员，我会立刻建群、命名并为你配齐团队。")
                        .summonFont(.subheadline)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 18)
                .frame(maxWidth: .infinity)
                .background(SummonTheme.surface, in: RoundedRectangle(cornerRadius: 22))
                .overlay { RoundedRectangle(cornerRadius: 22).stroke(SummonTheme.bubbleStroke, lineWidth: 0.8) }

                LazyVGrid(columns: [GridItem(.adaptive(minimum: 156), spacing: 10)], spacing: 10) {
                    ForEach(newGroupSuggestions) { item in
                        Button {
                            Task { await startGroup(text: item.prompt) }
                        } label: {
                            VStack(alignment: .leading, spacing: 4) {
                                Text(item.title)
                                    .summonFont(.subheadline, weight: .semibold)
                                    .foregroundStyle(.primary)
                                Text(item.desc)
                                    .summonFont(.caption)
                                    .foregroundStyle(.secondary)
                                    .multilineTextAlignment(.leading)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                            .background(SummonTheme.surface, in: RoundedRectangle(cornerRadius: 16))
                            .overlay { RoundedRectangle(cornerRadius: 16).stroke(SummonTheme.bubbleStroke, lineWidth: 0.7) }
                        }
                        .buttonStyle(SummonPressStyle(compact: true))
                        .disabled(busy || !store.protocolReady)
                    }
                }

                if let errorMessage {
                    InlineError(message: errorMessage)
                }
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 24)
        }
        .background(SummonTheme.background)
        .scrollDismissesKeyboard(.interactively)
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 8) {
                if !writableWorkspaces.isEmpty {
                    HStack(spacing: 6) {
                        Menu {
                            ForEach(writableWorkspaces, id: \.prettyPrinted) { item in
                                let wsID = item["id"].stringValue
                                let wsName = item["name"].stringValue.isEmpty ? wsID : item["name"].stringValue
                                Button {
                                    selectedWorkspaceID = wsID
                                } label: {
                                    Label(wsName, systemImage: selectedWorkspaceID == wsID ? "checkmark" : "folder")
                                }
                            }
                            if selectedWorkspaceID != nil {
                                Divider()
                                Button("暂不绑定目录", role: .destructive) { selectedWorkspaceID = nil }
                            }
                        } label: {
                            Label(selectedWorkspaceName.map { "目录：\($0)" } ?? "绑定项目目录（可选）", systemImage: "folder")
                                .summonFont(.caption, weight: .medium)
                                .foregroundStyle(selectedWorkspaceID == nil ? .secondary : .primary)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(SummonTheme.surface, in: Capsule())
                                .overlay { Capsule().stroke(SummonTheme.bubbleStroke, lineWidth: 0.7) }
                        }
                        .disabled(busy)
                        Spacer()
                    }
                }

                HStack(alignment: .bottom, spacing: 10) {
                    TextField("说说想建什么群、要做什么事…", text: $draftText, axis: .vertical)
                        .lineLimit(1...5)
                        .focused($inputFocused)
                        .disabled(busy)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(SummonTheme.surface, in: RoundedRectangle(cornerRadius: 22))
                        .overlay { RoundedRectangle(cornerRadius: 22).stroke(SummonTheme.bubbleStroke, lineWidth: 0.8) }
                        .onSubmit {
                            if canSend { Task { await startGroup(text: draftText) } }
                        }

                    Button {
                        Task { await startGroup(text: draftText) }
                    } label: {
                        Group {
                            if busy { ProgressView().tint(.white) }
                            else { Image(systemName: "arrow.up").font(.system(size: 16, weight: .bold)) }
                        }
                        .foregroundStyle(.white)
                        .frame(width: 40, height: 40)
                        .background(canSend ? Color.accentColor : Color(uiColor: .systemGray4), in: Circle())
                    }
                    .buttonStyle(SummonPressStyle(compact: true))
                    .disabled(!canSend)
                    .accessibilityLabel("创建并发送")
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 12)
            .background(SummonTheme.background.opacity(0.96))
        }
        .navigationTitle("新建群聊")
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if let list = try? await store.list("/api/workspaces") {
                workspaces = list
            }
        }
    }

    private func startGroup(text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !busy, store.protocolReady else { return }
        busy = true
        errorMessage = nil
        inputFocused = false
        defer { busy = false }
        do {
            let room = try await store.createConversationalGroup(
                text: trimmed,
                workspaceID: selectedWorkspaceID
            )
            draftText = ""
            selectedWorkspaceID = nil
            onCreated(room)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
