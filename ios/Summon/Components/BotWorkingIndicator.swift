import SwiftUI

/// A compact chat presence indicator. The caller supplies a status grounded in
/// the current job; this view never infers or invents an activity.
struct BotWorkingIndicator: View {
    let bot: SummonBot?
    var name: String? = nil
    var status: String = "正在仔细分析"
    var motion: String? = "work"

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

    private var label: String {
        [displayName, status].compactMap { $0 }.joined(separator: " · ")
    }

    var body: some View {
        HStack(spacing: 8) {
            ZStack {
                if let bot {
                    MemberAvatar(bot: bot, size: 24, motion: motion ?? "work")
                        .id(bot.id)
                        .transition(.scale(scale: 0.75).combined(with: .opacity))
                } else {
                    ProgressView().controlSize(.small)
                        .transition(.opacity)
                }
            }
            .frame(width: 36, height: 36)
            .animation(reduceMotion ? nil : .spring(response: 0.34, dampingFraction: 0.78), value: bot?.id)

            ZStack(alignment: .leading) {
                statusText
                    .foregroundStyle(.secondary)
                    .overlay {
                        if animates {
                            TimelineView(.animation(minimumInterval: 1.0 / 24)) { context in
                                let phase = CGFloat(context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.1) / 2.1)
                                GeometryReader { geometry in
                                    let width = max(36, geometry.size.width * 0.6)
                                    LinearGradient(colors: [.clear, Color.primary.opacity(0.92), .clear],
                                                   startPoint: .leading, endPoint: .trailing)
                                        .frame(width: width)
                                        .offset(x: -width + (geometry.size.width + width) * phase)
                                }
                            }
                            .mask(statusText)
                            .clipped()
                        }
                    }
                    .id(label)
                    .transition(.asymmetric(
                        insertion: .opacity.combined(with: .offset(y: reduceMotion ? 0 : 5)),
                        removal: .opacity.combined(with: .offset(y: reduceMotion ? 0 : -5))
                    ))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .clipped()
            .animation(.easeInOut(duration: reduceMotion ? 0.15 : 0.32), value: label)
        }
        .padding(.vertical, 3)
        .onAppear { isVisible = true }
        .onDisappear { isVisible = false }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([displayName, status].compactMap { $0 }.joined(separator: "，"))
    }

    private var statusText: some View {
        Text(label)
            .summonFont(.subheadline, weight: .medium)
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
