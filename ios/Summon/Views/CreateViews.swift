import SwiftUI
import UIKit

struct CreateBotView: View {
    @Environment(SummonStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let onCreated: (SummonRoom) -> Void
    @State private var name = ""
    @State private var avatar = SummonAvatar()
    @State private var busy = false
    @State private var createdBot: SummonBot?
    @State private var errorMessage: String?

    private var canSubmit: Bool {
        let title = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return !busy && store.protocolReady && (createdBot != nil || (!title.isEmpty && title.utf16.count <= 100))
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
                    if let createdBot {
                        Text("\(createdBot.name) 已创建")
                    } else {
                        TextField("为 Bot 取个名字", text: $name)
                            .summonFont(.title3, weight: .medium).multilineTextAlignment(.center)
                            .padding(18)
                            .background(SummonTheme.surface, in: RoundedRectangle(cornerRadius: 22))
                            .overlay { RoundedRectangle(cornerRadius: 22).stroke(SummonTheme.bubbleStroke, lineWidth: 0.8) }
                        if name.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count > 100 {
                            InlineError(message: "Bot 名称不能超过 100 个字符。")
                        }
                        AvatarPicker(avatar: $avatar)
                    }
                    if let errorMessage { InlineError(message: errorMessage) }
                }.padding(24)
            }
            .safeAreaInset(edge: .bottom) {
                Button {
                    Task { await create() }
                } label: {
                    HStack(spacing: 10) {
                        if busy { ProgressView().tint(buttonForeground) }
                        Text(createdBot == nil ? "创建" : "打开聊天").summonFont(.headline)
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
            let bot: SummonBot
            if let createdBot { bot = createdBot }
            else {
                bot = try await store.createBot(name: name.trimmingCharacters(in: .whitespacesAndNewlines), avatar: avatar, instructions: "")
                createdBot = bot
            }
            let room = try await store.openDirectMessage(bot: bot)
            dismiss(); onCreated(room)
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

struct CreateRoomView: View {
    @Environment(SummonStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let onCreated: (SummonRoom) -> Void
    @State private var name = ""
    @State private var members: Set<String> = []
    @State private var busy = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                TextField("群名称（可选）", text: $name)
                Section("成员") {
                    ForEach(store.bots) { bot in
                        Toggle(isOn: Binding(get: { members.contains(bot.id) }, set: { included in
                            if included { members.insert(bot.id) } else { members.remove(bot.id) }
                        })) {
                            Label { Text(bot.name) } icon: { MemberAvatar(bot: bot, size: 32) }
                        }
                    }
                }
                if let errorMessage { InlineError(message: errorMessage) }
            }
            .navigationTitle("创建群聊")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("创建") { Task { await create() } }.disabled(busy || !store.protocolReady)
                }
            }
        }
    }

    private func create() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let room = try await store.createGroup(name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                                                   members: store.bots.map(\.id).filter(members.contains))
            dismiss()
            onCreated(room)
        } catch { errorMessage = error.localizedDescription }
    }
}
