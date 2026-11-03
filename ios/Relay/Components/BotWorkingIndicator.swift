import SwiftUI

/// A compact chat presence indicator. The caller supplies a status grounded in
/// the current job; this view never infers or invents an activity.
struct BotWorkingIndicator: View {
    let bot: SummonBot?
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

    private var label: String {
        [displayName, status].compactMap { $0 }.joined(separator: " ")
    }

    var body: some View {
        HStack(spacing: 9) {
            ZStack {
                if let bot {
                    MemberAvatar(bot: bot, size: 24, motion: "work")
                        .id(bot.id)
                        .transition(.opacity)
                } else {
                    ProgressView().controlSize(.small)
                        .transition(.opacity)
                }
            }
            .frame(width: 24, height: 28)
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.3), value: bot?.id)

            ZStack(alignment: .leading) {
                statusText
                    .foregroundStyle(.secondary)
                    .overlay {
                        if animates {
                            TimelineView(.animation(minimumInterval: 1.0 / 24)) { context in
                                let phase = CGFloat(context.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 2.3) / 2.3)
                                GeometryReader { geometry in
                                    let width = max(32, geometry.size.width * 0.65)
                                    LinearGradient(colors: [.clear, Color.primary.opacity(0.85), .clear],
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
            .animation(.easeInOut(duration: reduceMotion ? 0.15 : 0.35), value: label)
        }
        .padding(.vertical, 4)
        .onAppear { isVisible = true }
        .onDisappear { isVisible = false }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel([displayName, status].compactMap { $0 }.joined(separator: "，"))
    }

    private var statusText: some View {
        Text(label)
            .summonFont(.subheadline)
            .lineLimit(1)
            .truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}
