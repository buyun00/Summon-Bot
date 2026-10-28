import SwiftUI
import UIKit

struct CreateBotView: View {
    @Environment(RelayStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let onCreated: (RelayRoom) -> Void
    @State private var name = ""
    @State private var avatar = RelayAvatar()
    @State private var busy = false
    @State private var createdBot: RelayBot?
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 28) {
                    BotAvatar(shape: avatar.shape, color: avatar.color, image: avatar.image, size: 148, secondary: avatar.secondary, ink: avatar.ink, paper: avatar.paper)
                        .padding(.top, 28).padding(.bottom, 10)
                    TextField("为 Bot 取个名字", text: $name)
                        .font(.title3.weight(.medium)).multilineTextAlignment(.center)
                        .padding(18).background(RelayTheme.surface, in: RoundedRectangle(cornerRadius: 22))
                        .onChange(of: name) { _, value in name = String(value.prefix(100)) }
                    AvatarPicker(avatar: $avatar)
                    if let errorMessage { InlineError(message: errorMessage) }
                }.padding(24)
            }
            .safeAreaInset(edge: .bottom) {
                Button {
                    Task { await create() }
                } label: {
                    HStack(spacing: 10) {
                        if busy { ProgressView() }
                        Text(createdBot == nil ? "创建" : "打开聊天").font(.headline)
                    }.frame(maxWidth: .infinity).padding(.vertical, 10)
                }
                .buttonStyle(.glassProminent)
                .disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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
        busy = true; errorMessage = nil
        defer { busy = false }
        do {
            let bot: RelayBot
            if let createdBot { bot = createdBot }
            else {
                bot = try await store.createBot(name: name.trimmingCharacters(in: .whitespacesAndNewlines), avatar: avatar)
                createdBot = bot
            }
            let room = try await store.openDirectMessage(bot: bot)
            dismiss(); onCreated(room)
        } catch { errorMessage = error.localizedDescription }
    }
}

struct AvatarPicker: View {
    @Binding var avatar: RelayAvatar
    @State private var custom = false
    var body: some View {
        VStack(spacing: 20) {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 4), spacing: 12) {
                ForEach(AvatarPalette.shapes, id: \.id) { shape in
                    Button { avatar.shape=shape.id; avatar.image=nil } label: {
                        VStack(spacing:4) {
                            BotAvatar(shape:shape.id,color:avatar.color,size:43,secondary:avatar.secondary,ink:avatar.ink,paper:avatar.paper,animated:false)
                            Text(shape.label).font(.caption2)
                        }.padding(5).background(RoundedRectangle(cornerRadius:12).stroke(CrewLibrary.role(avatar.shape) == shape.id && avatar.image == nil ? Color.primary : .clear,lineWidth:2))
                    }.buttonStyle(.plain).accessibilityLabel(shape.label)
                }
            }
            LazyVGrid(columns:Array(repeating:GridItem(.flexible()),count:4),spacing:10) {
                ForEach(CrewLibrary.templates.indices, id: \.self) { index in
                    let template = CrewLibrary.templates[index]
                    Button {
                        avatar.color=template["color"]!;avatar.secondary=template["secondary"];avatar.ink=template["ink"];avatar.paper=template["paper"];avatar.image=nil
                    } label: {
                        VStack(spacing:4) {
                            HStack(spacing:0) { Color(relayHex:template["color"]!);Color(relayHex:template["secondary"]!) }.frame(height:26).clipShape(RoundedRectangle(cornerRadius:7))
                            Text(template["name"]!).font(.system(size:10))
                        }.padding(3).overlay(RoundedRectangle(cornerRadius:9).stroke(avatar.color.uppercased() == template["color"] && avatar.secondary?.uppercased() == template["secondary"] ? Color.primary : .clear,lineWidth:2))
                    }.buttonStyle(.plain)
                }
            }
            DisclosureGroup("自定义颜色",isExpanded:$custom) {
                ColorPicker("主色块",selection:binding("color"),supportsOpacity:false)
                ColorPicker("辅助色",selection:binding("secondary"),supportsOpacity:false)
                ColorPicker("描边与眼睛",selection:binding("ink"),supportsOpacity:false)
                ColorPicker("底色",selection:binding("paper"),supportsOpacity:false)
            }
        }
    }
    private func binding(_ field:String) -> Binding<Color> {
        Binding(get:{
            let model=CrewLibrary.models[CrewLibrary.role(avatar.shape)]
            let hex = field == "color" ? avatar.color : field == "secondary" ? avatar.secondary ?? model?["secondary"] as? String ?? "#FFE1BA" : field == "ink" ? avatar.ink ?? "#142443" : avatar.paper ?? "#FFFAF1"
            return Color(relayHex:hex)
        },set:{ value in
            var r:CGFloat=0,g:CGFloat=0,b:CGFloat=0,a:CGFloat=0
            UIColor(value).getRed(&r,green:&g,blue:&b,alpha:&a)
            let hex=String(format:"#%02X%02X%02X",Int(r*255),Int(g*255),Int(b*255))
            switch field {case "color":avatar.color=hex;case "secondary":avatar.secondary=hex;case "ink":avatar.ink=hex;default:avatar.paper=hex}
            avatar.image=nil
        })
    }
}

struct CreateRoomView: View {
    @Environment(RelayStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let initialKind: String
    let onCreated: (RelayRoom) -> Void
    @State private var name = ""
    @State private var goal = ""
    @State private var kind = "group"
    @State private var members: Set<String> = []
    @State private var busy = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("会话") {
                    TextField("会话名称", text: $name)
                    Picker("交流方式", selection: $kind) {
                        Text("群聊").tag("group")
                        Text("深聊").tag("deep")
                    }
                    TextField("讨论目标", text: $goal, axis: .vertical).lineLimit(3...6)
                }
                Section("选择成员") {
                    ForEach(store.bots) { bot in
                        Button {
                            if !members.insert(bot.id).inserted { members.remove(bot.id) }
                        } label: {
                            HStack(spacing: 12) {
                                MemberAvatar(bot: bot, size: 32)
                                Text(bot.name).foregroundStyle(.primary)
                                Spacer()
                                if members.contains(bot.id) { Image(systemName: "checkmark").foregroundStyle(.tint) }
                            }.contentShape(Rectangle())
                        }.buttonStyle(.plain)
                    }
                }
                if let errorMessage { Section { InlineError(message: errorMessage) } }
            }
            .navigationTitle(kind == "deep" ? "发起深聊" : "创建群聊")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("创建") { Task { await create() } }
                        .disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || members.isEmpty || (kind == "deep" && goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
                }
            }
            .overlay { if busy { ProgressView() } }
            .onAppear { kind = initialKind }
        }
    }

    private func create() async {
        busy = true; errorMessage = nil
        defer { busy = false }
        do {
            let room = try await store.createGroup(name: name, members: ["user"] + members.sorted(), goal: goal, kind: kind)
            dismiss(); onCreated(room)
        } catch { errorMessage = error.localizedDescription }
    }
}
