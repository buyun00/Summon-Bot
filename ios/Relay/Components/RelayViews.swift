import SwiftUI

enum RelayTheme {
    static let background = Color(uiColor: .systemBackground)
    static let surface = Color(uiColor: .secondarySystemBackground)
}

struct MemberAvatar: View {
    let bot: RelayBot?
    var size: CGFloat = 48
    var motion: String = "idle"
    var groupOutline: Bool = false

    var body: some View {
        let avatar = bot?.resolvedAvatar ?? RelayAvatar()
        BotAvatar(shape: avatar.shape, color: avatar.color,
                  image: avatar.image, size: size, secondary: avatar.secondary, ink: avatar.ink, paper: avatar.paper, motion: motion, groupOutline: groupOutline)
    }
}

struct RoomAvatar: View {
    @Environment(RelayStore.self) private var store
    let room: RelayRoom
    var size: CGFloat = 86

    private var members: [String] {
        Array(room.members.filter { id in id == "user" || store.bots.contains { $0.id == id } }.prefix(4))
    }

    var body: some View {
        ZStack {
            if members.isEmpty {
                Image(systemName: "bubble.left.and.bubble.right.fill")
                    .font(.system(size: size * 0.55)).foregroundStyle(.secondary)
            } else {
                ForEach(Array(members.enumerated()), id: \.element) { index, id in
                    let child = members.count == 1 ? size : size * (members.count == 2 ? 0.66 : 0.58)
                    Group {
                        if id == "user" {
                            Text(String(store.settings.userName.prefix(1)))
                                .font(.system(size: child * 0.25))
                                .frame(width: child * 0.86, height: child * 0.86)
                                .background(Color(uiColor: .systemGray5), in: Circle())
                                .overlay(Circle().stroke(.white, lineWidth: 8))
                                .frame(width: child, height: child)
                        } else {
                            MemberAvatar(bot: store.bots.first { $0.id == id }, size: child, groupOutline: true)
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
            .font(.footnote)
            .foregroundStyle(.orange)
            .frame(maxWidth: .infinity, alignment: .leading)
            .textSelection(.enabled)
            .padding(.vertical, 6)
            .accessibilityAddTraits(.isStaticText)
    }
}

enum RelayFormat {
    static func time(_ value: String?) -> String {
        guard let date = RelayDate.parse(value) else { return "" }
        if Calendar.current.isDateInToday(date) { return date.formatted(date: .omitted, time: .shortened) }
        if Calendar.current.isDateInYesterday(date) { return "昨天" }
        return date.formatted(.dateTime.month().day())
    }

    static func status(_ value: String) -> String {
        ["queued": "等待执行", "running": "进行中", "waiting": "等待答复",
         "completed": "已完成", "failed": "失败", "cancelled": "已取消",
         "interrupted": "已中断", "active": "活跃", "paused": "已暂停",
         "concluded": "已结束"][value] ?? value
    }
}
