import SwiftUI

enum SummonAppearance: String, CaseIterable, Identifiable, Sendable {
    case system, light, dark
    var id: String { rawValue }
    var label: String {
        switch self {
        case .system: "跟随系统"
        case .light: "浅色"
        case .dark: "深色"
        }
    }
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

enum SummonDisplayKey {
    static let zoom = "SummonNative.display.zoom"
    static let font = "SummonNative.display.font"
    static let appearance = "SummonNative.display.appearance"
}

struct SummonDisplayContainer<Content: View>: View {
    @AppStorage(SummonDisplayKey.zoom) private var zoom = 100.0
    @AppStorage(SummonDisplayKey.appearance) private var appearanceRaw = SummonAppearance.system.rawValue
    private let content: Content

    init(@ViewBuilder content: () -> Content) { self.content = content() }

    private var appearance: SummonAppearance {
        SummonAppearance(rawValue: appearanceRaw) ?? .system
    }

    var body: some View {
        let scale = CGFloat(min(160, max(50, zoom)) / 100)
        GeometryReader { geometry in
            content
                .summonFont(.body)
                .frame(width: geometry.size.width / scale, height: geometry.size.height / scale)
                .scaleEffect(scale, anchor: .topLeading)
                .frame(width: geometry.size.width, height: geometry.size.height, alignment: .topLeading)
        }
        .preferredColorScheme(appearance.colorScheme)
        .tint(SummonTheme.tint)
    }
}

private struct SummonFontModifier: ViewModifier {
    @AppStorage(SummonDisplayKey.font) private var percentage = 100.0
    @ScaledMetric private var pointSize: CGFloat
    private let weight: Font.Weight

    init(style: Font.TextStyle, weight: Font.Weight?) {
        let size: CGFloat = switch style {
        case .largeTitle: 32
        case .title: 26
        case .title2, .title3: 20
        case .headline, .body: 17
        case .callout: 16
        case .subheadline, .footnote: 14
        case .caption, .caption2: 13
        default: 17
        }
        _pointSize = ScaledMetric(wrappedValue: size, relativeTo: style)
        self.weight = weight ?? (style == .headline ? .semibold : .regular)
    }

    func body(content: Content) -> some View {
        content.font(.system(size: pointSize * CGFloat(min(160, max(90, percentage)) / 100), weight: weight))
    }
}

extension View {
    func summonFont(_ style: Font.TextStyle, weight: Font.Weight? = nil) -> some View {
        modifier(SummonFontModifier(style: style, weight: weight))
    }

    // Each native presentation needs its own layout bounds and the same saved display settings.
    func summonSheet<Sheet: View>(isPresented: Binding<Bool>, onDismiss: (() -> Void)? = nil,
                                @ViewBuilder content: @escaping () -> Sheet) -> some View {
        sheet(isPresented: isPresented, onDismiss: onDismiss) { SummonDisplayContainer(content: content) }
    }

    func summonSheet<Item: Identifiable, Sheet: View>(item: Binding<Item?>, onDismiss: (() -> Void)? = nil,
                                                    @ViewBuilder content: @escaping (Item) -> Sheet) -> some View {
        sheet(item: item, onDismiss: onDismiss) { item in SummonDisplayContainer { content(item) } }
    }
}

struct SummonDisplaySettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @AppStorage(SummonDisplayKey.zoom) private var zoom = 100.0
    @AppStorage(SummonDisplayKey.font) private var font = 100.0
    @AppStorage(SummonDisplayKey.appearance) private var appearanceRaw = SummonAppearance.system.rawValue

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Picker("外观模式", selection: $appearanceRaw) {
                        ForEach(SummonAppearance.allCases) { item in
                            Text(item.label).tag(item.rawValue)
                        }
                    }
                    .pickerStyle(.segmented)
                } header: {
                    Text("外观")
                } footer: {
                    Text("浅色与深色模式均使用系统原生材质，Bot 头像会自动切换纸片与透亮暗色玻璃质感。")
                }
                Section {
                    LabeledContent("界面缩放", value: "\(Int(zoom))%")
                    Slider(value: $zoom, in: 50...160, step: 1).accessibilityLabel("界面缩放")
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 90))]) {
                        Button("紧凑 85%") { zoom = 85 }
                        Button("默认 100%") { zoom = 100 }
                        Button("宽松 115%") { zoom = 115 }
                    }.buttonStyle(.bordered)
                } footer: {
                    Text("一起调整头像、控件、间距与文字的大小。")
                }
                Section {
                    LabeledContent("文字大小", value: "\(Int(font))%")
                    Slider(value: $font, in: 90...160, step: 5).accessibilityLabel("文字大小")
                } footer: {
                    Text("统一调整聊天、统计、管理页面及操作记录的文字大小，同时保留系统文字大小设置。")
                }
                Section("显示效果预览") {
                    HStack(spacing: 12) {
                        BotAvatar(shape: "nuage", color: "#867399", size: 42, motion: "idle")
                        VStack(alignment: .leading, spacing: 4) {
                            Text("聊天内容、工具调用与操作结果").summonFont(.body)
                            Text("Bot 正在读取文件…").summonFont(.subheadline).foregroundStyle(.secondary)
                        }
                    }.padding(.vertical, 4)
                    Text("即时生效并保存到当前设备，手机和电脑分别设置。")
                        .summonFont(.footnote).foregroundStyle(.secondary)
                }
                Section {
                    Button("恢复默认") {
                        zoom = 100
                        font = 100
                        appearanceRaw = SummonAppearance.system.rawValue
                    }
                }
            }
            .navigationTitle("显示与外观")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
    }
}
