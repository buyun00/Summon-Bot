import SwiftUI

/// A compact chat presence indicator. The caller supplies a status grounded in
/// the current job; this view never infers or invents an activity.
struct BotWorkingIndicator: View {
    let bot: RelayBot?
    var name: String? = nil
    var status: String = "正在仔细分析"

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase
    @State private var isVisible = false

    private var animates: Bool {
        isVisible && scenePhase == .active && !reduceMotion
    }

    private var displayName: String? {
        let value = (name ?? bot?.name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    var body: some View {
        ZStack(alignment: .leading) {
            if animates {
                TimelineView(.animation(minimumInterval: 1.0 / 24)) { context in
                    content(at: context.date.timeIntervalSinceReferenceDate, animated: true)
                }
            } else {
                content(at: 0, animated: false)
            }
        }
        .animation(reduceMotion ? nil : .easeInOut(duration: 0.2), value: status)
        .onAppear { isVisible = true }
        .onDisappear { isVisible = false }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([displayName, status].compactMap { $0 }.joined(separator: "，"))
    }

    private func content(at time: TimeInterval, animated: Bool) -> some View {
        let breath: CGFloat = animated ? CGFloat(sin(time * 2 * .pi / 2.8)) : 0
        let sway = animated ? sin(time * 2 * .pi / 4.1) : 0
        let shimmer: CGFloat = animated ? CGFloat(time.truncatingRemainder(dividingBy: 2.3) / 2.3) : 0

        return HStack(spacing: 9) {
            MemberAvatar(bot: bot, size: 28)
                .scaleEffect(1 + breath * 0.035)
                .rotationEffect(.degrees(sway * 4))
                .offset(y: breath * 0.5)

            VStack(alignment: .leading, spacing: 2) {
                if let displayName {
                    Text(displayName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                statusText
                    .foregroundStyle(.secondary)
                    .overlay {
                        if animated {
                            GeometryReader { geometry in
                                let bandWidth = max(32, geometry.size.width * 0.65)
                                LinearGradient(
                                    colors: [.clear, Color.primary.opacity(0.85), .clear],
                                    startPoint: .leading,
                                    endPoint: .trailing
                                )
                                .frame(width: bandWidth)
                                .offset(x: -bandWidth + (geometry.size.width + bandWidth) * shimmer)
                            }
                            .mask(statusText.frame(maxWidth: .infinity, alignment: .leading))
                            .clipped()
                        }
                    }
                    .id(status)
                    .transition(.opacity)
            }
        }
        .padding(.vertical, 4)
    }

    private var statusText: some View {
        Text(status)
            .font(.callout)
            .lineLimit(2)
            .multilineTextAlignment(.leading)
    }
}
