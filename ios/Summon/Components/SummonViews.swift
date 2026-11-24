import SwiftUI
import UIKit

enum SummonTheme {
    private static func dynamic(
        light: (CGFloat, CGFloat, CGFloat, CGFloat),
        dark: (CGFloat, CGFloat, CGFloat, CGFloat)
    ) -> Color {
        Color(uiColor: UIColor { traits in
            let c = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: c.0, green: c.1, blue: c.2, alpha: c.3)
        })
    }

    static let background = dynamic(
        light: (0.973, 0.965, 0.945, 1), // #F8F6F1
        dark: (0.043, 0.047, 0.063, 1)   // #0B0C10
    )
    static let surface = dynamic(
        light: (0.945, 0.933, 0.906, 1), // #F1EEE7
        dark: (0.094, 0.102, 0.133, 1)   // #181A22
    )
    static let surfaceElevated = dynamic(
        light: (1.0, 0.992, 0.973, 1),   // #FFFDF8
        dark: (0.125, 0.137, 0.176, 1)   // #20232D
    )
    static let botBubble = dynamic(
        light: (0.945, 0.933, 0.906, 0.96),
        dark: (0.106, 0.114, 0.153, 0.90)
    )
    static let userBubble = dynamic(
        light: (0.145, 0.137, 0.125, 1), // #252320
        dark: (0.192, 0.212, 0.275, 0.94)
    )
    static let userBubbleText = dynamic(
        light: (0.985, 0.976, 0.961, 1),
        dark: (0.949, 0.957, 0.976, 1)
    )
    static let bubbleStroke = dynamic(
        light: (0, 0, 0, 0.065),
        dark: (1, 1, 1, 0.115)
    )
    static let hairline = dynamic(
        light: (0, 0, 0, 0.07),
        dark: (1, 1, 1, 0.09)
    )
    static let tint = dynamic(
        light: (0.145, 0.137, 0.125, 1),
        dark: (0.925, 0.941, 0.973, 1)
    )
    static let ok = dynamic(
        light: (0.373, 0.482, 0.416, 1), // #5F7B6A
        dark: (0.498, 0.761, 0.627, 1)   // #7FC2A0
    )
    static let warn = dynamic(
        light: (0.776, 0.490, 0.231, 1), // #C67D3B
        dark: (0.890, 0.655, 0.392, 1)   // #E3A764
    )
    static let codeBackground = dynamic(
        light: (0.914, 0.894, 0.855, 1),
        dark: (0.067, 0.075, 0.106, 0.96)
    )
    static let quoteBackground = dynamic(
        light: (0, 0, 0, 0.045),
        dark: (1, 1, 1, 0.07)
    )
}

struct MemberAvatar: View {
    let bot: SummonBot?
    var size: CGFloat = 48
    var motion: String? = nil
    var groupOutline: Color? = nil

    var body: some View {
        let avatar = bot?.resolvedAvatar ?? SummonAvatar()
        BotAvatar(shape: avatar.shape, color: avatar.color,
                  image: avatar.image, size: size, secondary: avatar.secondary, ink: avatar.ink, paper: avatar.paper, motion: motion ?? bot?.activityMotion ?? "idle", groupOutline: groupOutline)
    }
}

struct RoomAvatar: View {
    @Environment(SummonStore.self) private var store: SummonStore?
    let room: SummonRoom
    var size: CGFloat = 86
    var background: Color = SummonTheme.background
    var showOutline: Bool = true
    var bots: [SummonBot]? = nil

    private var resolvedBots: [SummonBot] {
        bots ?? store?.bots ?? []
    }

    private var members: [String] {
        let botsOnly = room.members.filter { id in resolvedBots.contains { $0.id == id } }
        if !botsOnly.isEmpty { return Array(botsOnly.prefix(4)) }
        return Array(room.members.filter { $0 == "user" }.prefix(1))
    }

    var body: some View {
        ZStack {
            if members.isEmpty {
                Image(systemName: "bubble.left.and.bubble.right.fill")
                    .font(.system(size: size * 0.55)).foregroundStyle(.secondary)
            } else {
                ForEach(Array(members.enumerated()), id: \.element) { index, id in
                    let child = members.count == 1 ? size : size * (members.count == 2 ? 0.66 : 0.58)
                    let outlineWidth = min(4, child * 0.08)
                    Group {
                        if id == "user" {
                            Image("OwnerAvatar")
                                .resizable()
                                .scaledToFill()
                                .frame(width: child * 0.86, height: child * 0.86)
                                .clipShape(Circle())
                                .overlay {
                                    if showOutline { Circle().stroke(background, lineWidth: outlineWidth) }
                                }
                                .frame(width: child, height: child)
                        } else {
                            MemberAvatar(bot: resolvedBots.first { $0.id == id }, size: child, groupOutline: showOutline ? background : nil)
                        }
                    }
                    .offset(x: xOffset(index), y: yOffset(index))
                    .zIndex(Double(index))
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private func xOffset(_ index: Int) -> CGFloat {
        if members.count == 1 { return 0 }
        if members.count == 2 { return size * (index == 0 ? -0.17 : 0.17) }
        if members.count == 3 && index == 0 { return 0 }
        return size * (index % 2 == 0 ? -0.21 : 0.21)
    }

    private func yOffset(_ index: Int) -> CGFloat {
        if members.count == 1 { return 0 }
        if members.count == 2 { return size * (index == 0 ? -0.17 : 0.17) }
        return size * (index < (members.count == 4 ? 2 : 1) ? -0.21 : 0.21)
    }

}

struct InlineError: View {
    let message: String

    var body: some View {
        Label(message, systemImage: "exclamationmark.circle")
            .summonFont(.footnote)
            .foregroundStyle(.orange)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
            .padding(.vertical, 6)
            .accessibilityAddTraits(.isStaticText)
    }
}

@MainActor
enum SummonFormat {
    private static let todayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "zh_CN")
        f.dateFormat = "HH:mm"
        return f
    }()
    private static let weekdayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "zh_CN")
        f.dateFormat = "EEEE"
        return f
    }()
    private static let monthDayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "zh_CN")
        f.dateFormat = "M月d日"
        return f
    }()

    static func time(_ value: String?) -> String {
        guard let date = SummonDate.parse(value) else { return "" }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return todayFormatter.string(from: date) }
        if calendar.isDateInYesterday(date) { return "昨天" }
        if let weekAgo = calendar.date(byAdding: .day, value: -6, to: calendar.startOfDay(for: Date())), date >= weekAgo {
            return weekdayFormatter.string(from: date)
        }
        return monthDayFormatter.string(from: date)
    }

    static func dividerTime(_ value: String?) -> String {
        guard let date = SummonDate.parse(value) else { return "" }
        let hm = todayFormatter.string(from: date)
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return hm }
        if calendar.isDateInYesterday(date) { return "昨天 \(hm)" }
        if let weekAgo = calendar.date(byAdding: .day, value: -6, to: calendar.startOfDay(for: Date())), date >= weekAgo {
            return "\(weekdayFormatter.string(from: date)) \(hm)"
        }
        return "\(monthDayFormatter.string(from: date)) \(hm)"
    }

    static func status(_ value: String) -> String {
        ["queued": "等待投递", "pending": "等待确认", "submitted": "已提交", "accepted": "已受理",
         "received": "Bot 已接收", "processed": "本轮已处理", "access_revoked": "访问已撤销",
         "rejected": "未受理", "running": "运行中", "waiting": "等待结果", "needs_input": "待输入",
         "completed": "执行已结束", "failed": "失败", "cancelled": "已取消", "active": "启用", "suspended": "运行已挂起",
         "paused": "已暂停", "stopping": "停止中", "stopped": "已停止", "idle": "空闲",
         "unknown": "状态未知", "unsupported": "连接不支持"][value] ?? value
    }
}
