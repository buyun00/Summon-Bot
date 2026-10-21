import SwiftUI

enum RelayTheme {
    static let background = Color(uiColor: .systemBackground)
    static let surface = Color(uiColor: .secondarySystemBackground)
}

struct MemberAvatar: View {
    let bot: RelayBot?
    var size: CGFloat = 48

    var body: some View {
        let avatar = bot?.resolvedAvatar ?? RelayAvatar()
        BotAvatar(shape: avatar.shape, color: avatar.color,
                  image: avatar.image, size: size)
    }
}

struct RoomAvatar: View {
    @Environment(RelayStore.self) private var store
    let room: RelayRoom
    var size: CGFloat = 86

    private var members: [RelayBot] {
        room.members.compactMap { id in store.bots.first { $0.id == id } }.prefix(3).map { $0 }
    }

    var body: some View {
        ZStack {
            if members.isEmpty {
                Image(systemName: "bubble.left.and.bubble.right.fill")
                    .font(.system(size: size * 0.55))
                    .foregroundStyle(.secondary)
            } else {
                ForEach(Array(members.enumerated()), id: \.element.id) { index, bot in
                    MemberAvatar(bot: bot, size: members.count == 1 ? size : size * 0.62)
                        .offset(x: xOffset(index), y: yOffset(index))
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private func xOffset(_ index: Int) -> CGFloat {
        members.count == 1 ? 0 : (index == 0 ? 0 : (index == 1 ? -size * 0.22 : size * 0.22))
    }

    private func yOffset(_ index: Int) -> CGFloat {
        members.count == 1 ? 0 : (index == 0 ? -size * 0.21 : size * 0.23)
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
